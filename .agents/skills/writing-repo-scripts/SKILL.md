---
name: writing-repo-scripts
description: >
  Covers writing or editing a TypeScript script under scripts/ (scripts/*.ts,
  scripts/lib/) or a skill's bundled script, run directly by Node's
  type stripping, and its Vitest test beside it. Use when adding a script or the just
  recipe that calls it, writing main(context: ScriptContext) and the
  import.meta.main / runScript entry point, a script must refuse or skip outside a git
  work tree, git spawned from a hook acts on the wrong repository (an inherited GIT_DIR
  or GIT_INDEX_FILE; git_env, staged_guard_env), writing a ScriptError with an
  ERR_<STAGE>_<WHAT> code and Expected/Actual/Next lines, erasableSyntaxOnly or a .ts
  import extension fails, stubbing git, gh, or cargo in a test through the context's
  run function, or a scripts/ coverage floor fails; and the same contract in a
  cargo xtask task (xtask/src/, its Context, git_env, ScriptError, just test-xtask).
---

# Writing Repository Scripts

**Owns:** how a repository script is written and tested: why it is TypeScript run by
Node, what it may depend on, how it spawns git, how it behaves outside a git work tree,
how it reports failure, and how its test is built. **Does not own:** how a skill is
authored or mirrored (`authoring-skills`); what a gate checks and which gate runs a
script (`changing-gates`); the coverage floor values and which Vitest project a test
joins (`placing-tests`); a new package the script would import
(`managing-dependencies`).

The rules themselves live once, in `AGENTS.md` › "Repository scripts": read it first.
This skill carries the reasons behind them and worked examples from the tree; it does
not restate the list, so the two cannot drift.

## A task in `cargo xtask`

The developer-loop automation has moved to Rust: `xtask/src/<task>.rs`, dispatched by
name from `xtask/src/main.rs` and run as `cargo xtask <task>` (the alias in
`.cargo/config.toml`). The contract below carries over one for one, and the Rust
spellings are:

- `main(context: &Context<'_>) -> TaskResult`, where `Context` (`xtask/src/context.rs`)
  holds argv, env, root, a `run` function, a logger, and stdin. A unit test builds one
  with `test_support::Fake` (`Fake::at(root).argv(…).env(…).run(&fake).task(main)`), and
  a run of the built binary in `xtask/tests/` sets `CARGO_MANIFEST_DIR` to a temporary
  directory's `xtask/`, which is how the binary finds its root under `cargo run`.
- `git_env` and `staged_guard_env` (`xtask/src/git_env.rs`) for spawned git.
- `ScriptError::new(code, summary, expected, actual, next)` (`xtask/src/fail.rs`),
  `.with_exit_code(2)` for a Claude Code hook, and `ScriptError::unexpected` for an I/O
  error no code names (`ERR_INTERNAL_UNEXPECTED`).
- Its tests live in the task's `#[cfg(test)] mod tests`; `just test-xtask` holds the
  crate to lines 85 and functions 90, and the staged guard's rules (`xtask/guard/`) to
  lines 90 and functions 100.

## Why TypeScript, run by Node directly

- Node is already required for the UI, so it costs the clone nothing. The scripts need
  real parsers for YAML, TOML, and JSON (`yaml`, `smol-toml`, `JSON.parse`), which a
  shell does not have and a regex over YAML or TOML only imitates. Vitest tests them
  with fixtures. And a reader still learning Rust can maintain TypeScript.
- Node runs a `.ts` file by stripping its types, with no build step. Stripping only
  removes types and never rewrites code, so syntax that needs a transform (`enum`, a
  `namespace` with runtime code, parameter properties) is an error, and an import names
  the `.ts` file (https://nodejs.org/api/typescript.html, checked 2026-09-29). Enforced
  by: `scripts/tsconfig.json` "erasableSyntaxOnly" and "module": "NodeNext" (an
  extensionless relative import is TS2835), so tsc reports both before Node does;
  "allowImportingTsExtensions" is what lets the `.ts` spelling pass.
- A script runs after `just install`, so it may import the parsers in `package.json`'s
  `devDependencies`. A package it would newly need is a new dependency, with the review
  and sign-off that implies.

## The shape of a script

Every script has a header comment (what it does, its usage line, what it does outside a
git work tree, and its `Errors:` list), an exported `main` that takes a `ScriptContext`
(`scripts/lib/script.ts`), and a one-line entry point:

```ts
import { ScriptError } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

export function main(context: ScriptContext): void {
  // read context.argv, context.env, context.root; spawn through context.run; print through context.log
}

if (import.meta.main) await runScript(main);
```

- `import.meta.main` is true only for the module Node was started with, so a test that
  imports `main` never triggers a run. It arrived in Node 24.2.0, which `mise.toml`'s Node
  pin passes, and is still marked early development
  (https://nodejs.org/api/esm.html#importmetamain, checked 2026-09-29). Do not wrap it
  in a helper: a helper sees its own module, never its caller's.
- `main` receives everything from the process through the context (argv, env, the
  repository root, a `run` function for child processes, a logger, stdin), so its test
  calls it with fakes instead of spawning real tools.
- Pinned tools are called by bare name; the caller provides PATH: locally the shell that
  runs `just` (mise activated, or `mise exec -- <command>`), since no recipe calls `mise
  exec`, and `jdx/mise-action` in CI. A script never calls `mise exec` itself: a CI job
  installs only the tools its `install_args` name, and asking mise for another would start
  a download mid-run instead of failing on the missing tool. `git` and `gh` are assumed on
  PATH, and tests stub both. A missing tool fails with a named code rather than a spawn
  error (`cargo xtask apply-ruleset`'s `ERR_RULESET_GH_MISSING`).

## Spawning git

Git exports `GIT_DIR` and its siblings to every hook, and says a hook that runs git
elsewhere must clear them (https://git-scm.com/docs/githooks, checked 2026-09-29); `git
commit -- <path>` also exports a temporary `GIT_INDEX_FILE`. An inherited `GIT_DIR`
outranks both the child's working directory and `git -C`, so a git command meant for
another repository (a test's throwaway repository) writes into the outer one instead.
Every spawned git therefore gets `git_env(&env)` from `xtask/src/git_env.rs`, which drops
every `GIT_*` variable:

```rust
let options = RunOptions {
    cwd: Some(context.root.clone()),
    env: Some(git_env(&context.env)),
    input: None,
};
context.run("git", &["status", "--porcelain"], &options);
```

The one exception is the staged guard, `cargo xtask check-staged`: it **is** the
pre-commit check and must judge the index actually being committed, so it uses
`staged_guard_env(env)`, which keeps `GIT_INDEX_FILE` and drops the rest.

## Outside a git work tree: refuse or skip

Every header says which, and the choice follows from whether the script's question
exists outside a checkout:

- **Refuse**, with a named code, when the job is defined over the repository.
  `cargo xtask check-staged` has no index to judge (`ERR_STAGED_NOT_A_REPO`);
  `cargo xtask verify-hooks` checks this checkout's hook (`ERR_HOOKS_NOT_A_REPO`).
- **Skip with a one-line notice** when the question is meaningless there, and exit 0.
- A harness check (`cargo xtask check-harness`, under `xtask/src/check_harness/`) takes
  `--root <dir>` and needs no git to find its tree, which is what lets its test point it
  at a fixture per failure mode.

## The failure contract

A failure is usually read by an agent, which acts on exactly what the message says. So
it names what failed, what was expected against what was found, and the next command
that is safe to run, and it never echoes a secret or the matched content (the staged
guard names a path and a rule, never the text). Throw a `ScriptError`
(`scripts/lib/fail.ts`); `runScript` prints it and sets the exit code, and turns any
other exception into `ERR_INTERNAL_UNEXPECTED`. The exit code is 1, or 2 for a Claude
Code `PostToolUse` hook, the code whose stderr is shown to the agent
(https://code.claude.com/docs/en/hooks, checked 2026-09-29;
`cargo xtask format-edited-file`). List every code in the header.

`cargo xtask verify-hooks` in a clone where `just install` never ran (the checkout's
absolute path shortened to `<repo>`):

```text
ERR_HOOKS_NOT_INSTALLED: lefthook's pre-commit hook is not installed
Expected: a lefthook pre-commit hook at <repo>/.git/hooks/pre-commit
Actual: no pre-commit hook
Next: run `just install` (it runs `lefthook install`), or set ALLOW_MISSING_GIT_HOOKS=1 to commit without hooks on purpose
```

The `Next:` line offers the fix first and the documented opt-out second, so the reader
is never left with only "turn the check off". **BACKGROUND:** `designing-errors`, for
naming a code consistently with the rest of the repository's error codes.

## A task that writes to GitHub

`cargo xtask sync-labels` (`just labels`) and `cargo xtask apply-ruleset` (`just ruleset`)
only create or update what their manifest declares and never delete, so a run can only
converge on the file; a known GitHub refusal gets its own code
(`ERR_RULESET_PLAN_UNSUPPORTED`). Their tests stub `gh`. Running one against the live
repository is a remote write that needs a human's sign-off first.

## Testing a script

The test sits beside it (`scripts/<name>.test.ts`, `scripts/lib/**/<name>.test.ts`) and
runs in Vitest's `scripts` project under `just test-scripts`.

- **Call `main` with a context you build.** Collect `log` lines in an array and pass a
  `run` that records each call and answers from a table, as `xtask/src/sync_labels.rs`'s
  tests do for `gh` and `xtask/src/clippy_guard.rs`'s tests for `cargo`. Assert on the recorded
  calls: that is how a test proves what would have been sent to GitHub without sending
  it.
- **A throwaway repository per test.** `mkdtemp` under `os.tmpdir()`, `git init` with
  every `GIT_*` variable dropped from `process.env`, removed in `afterEach` (`xtask/src/verify_hooks.rs`'s tests do
  the same in Rust). Never read or write the real checkout, and never a fixed shared
  path: Vitest runs files in parallel, and two tests on one path race.
- **Assert the code, not the prose**: `expect(error).toMatch(/^ERR_HOOKS_NOT_INSTALLED/)`.
  The code is the contract; the wording may improve.
- **Secret-shaped fixtures are assembled at runtime** from pieces that do not match on
  their own, so no committed file, the test included, trips the staged guard or GitHub
  push protection. Say so in the test's header comment.

Enforced by: `vitest.config.ts` "thresholds" (`scripts/**` and a skill's
`.agents/skills/*/scripts/**` lines 85, functions 90). An untested new file counts as 0%, so
it pulls the tree's number down from the moment it exists.

## Adding a script

A new script usually lands with more than its own file:

- its test beside it;
- a `justfile` recipe if people run it by hand, the recipe's line in `AGENTS.md`'s Quick
  Reference, and its command in `CONTRIBUTING.md`'s "Without Just";
- a "Validating a change" row when no row covers it, and an "Enforcement layers" row
  when it enforces something. **REQUIRED:** `changing-gates` for a script a gate runs.

A script bundled inside a skill follows the same rules, or keeps its own language when
it was ported with its tests; `just test-scripts` runs those suites too. Keep it a thin
dispatcher: it parses its arguments, calls into `scripts/lib/`, and prints, with no
decision of its own beyond choosing the output format. Branching logic belongs in
`scripts/lib/`, under the `scripts/**` coverage floor, where another script or skill
can reuse it.

Check the work with `just test-scripts`, then `just lint` (tsc over `scripts/`, ESLint).
