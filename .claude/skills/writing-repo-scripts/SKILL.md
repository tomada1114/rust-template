---
name: writing-repo-scripts
description: >
  Covers writing or editing repository automation and its tests: a cargo xtask task
  under xtask/src/ (its Context, RunOptions, git_env and staged_guard_env, ScriptError,
  test_support::Fake, just test-xtask's floors) and a skill's bundled Python or shell
  script under .agents/skills/*/scripts/ (header comment, stdlib-only Python, a fake gh,
  tests in scripts/tests/ run by just test-scripts). Use when adding a task, a skill
  script, or the just recipe that calls one, a script must refuse or skip outside a git
  work tree, git spawned from a hook acts on the wrong repository (an inherited GIT_DIR
  or GIT_INDEX_FILE), writing an ERR_<STAGE>_<WHAT> failure with Expected/Actual/Next
  lines, stubbing git, gh, or cargo in a test, or an xtask coverage floor fails.
---

# Writing Repository Scripts

**Owns:** how repository automation is written and tested: a `cargo xtask` task, and a
script a skill bundles: what each may depend on, how it spawns git, how it behaves
outside a git work tree, how it reports failure, and how its test is built. **Does not
own:** how a skill is authored or mirrored (`authoring-skills`); what a gate checks and
which gate runs a task (`changing-gates`); where a test goes and which floor measures it
(`placing-tests`); a new crate a task would import (`managing-dependencies`).

The rules themselves live once, in `AGENTS.md` › "Repository scripts": read it first.
This skill carries the reasons behind them and worked examples from the tree; it does
not restate the list, so the two cannot drift.

## Two homes

- **A `cargo xtask` task** (`xtask/src/<task>.rs`) is what a `just` recipe, a lefthook
  job, or a CI step runs: the gates, the harness checks, the bootstrap, the GitHub
  writes. It is Rust, so it costs the clone no second toolchain, gets the workspace's
  lints, and parses YAML and TOML with real parsers (`yaml-rust2`, `toml`).
- **A skill's bundled script** (`.agents/skills/<skill>/scripts/`) is a step of that
  skill's procedure, in Python or shell (`merging-dependency-prs`' `survey_prs.py`,
  `shipping-issues`' `plan.py` and `worktree_setup.sh`). It travels with the skill, so
  it uses nothing the skill cannot assume: the Python standard library, `git`, and `gh`.

## A task in `cargo xtask`

A task is dispatched by name from `xtask/src/main.rs`'s `TASKS` table and run as
`cargo xtask <task>` (the alias in `.cargo/config.toml`).

- `main(context: &Context<'_>) -> TaskResult`, where `Context` (`xtask/src/context.rs`)
  holds argv, env, root, a `run` function, a logger, and stdin. Everything from the
  process reaches the task through it, so a test calls `main` with fakes instead of
  spawning real tools.
- Pinned tools are called by bare name; the caller provides PATH: locally the shell that
  runs `just` (mise activated, or `mise exec -- <command>`), and `jdx/mise-action` in
  CI. A task never calls `mise exec` itself: a CI job installs only the tools its
  `install_args` name, and asking mise for another would start a download mid-run
  instead of failing on the missing tool. `git` and `gh` are assumed on PATH, and tests
  stub both. A missing tool fails with a named code rather than a spawn error
  (`cargo xtask apply-ruleset`'s `ERR_RULESET_GH_MISSING`).

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
`staged_guard_env(env)`, which keeps `GIT_INDEX_FILE` and drops the rest. A bundled
script that spawns git does the same by hand: a copy of `os.environ` without any key
starting with `GIT_`.

## Outside a git work tree: refuse or skip

Every header says which, and the choice follows from whether the question exists
outside a checkout:

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
guard names a path and a rule, never the text).

- In a task, return `ScriptError::new(code, summary, expected, actual, next)`
  (`xtask/src/fail.rs`); `.with_exit_code(2)` is for a Claude Code `PostToolUse` hook,
  the code whose stderr is shown to the agent (https://code.claude.com/docs/en/hooks,
  checked 2026-09-29; `cargo xtask format-edited-file`), and `ScriptError::unexpected`
  covers an I/O error no code names (`ERR_INTERNAL_UNEXPECTED`).
- In a bundled Python script, raise a `ScriptError` whose `report()` prints the same
  four lines to stderr, exit 1, and turn any other exception into
  `ERR_INTERNAL_UNEXPECTED`; `survey_prs.py` is the worked example. `shipping-issues`'
  scripts predate the contract and report through their own exit codes; a new script
  follows the contract.
- List every code in the header's `Errors:` block.

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

## Testing a task

Its tests sit in the task's `#[cfg(test)] mod tests`, and end-to-end runs of the built
binary in `xtask/tests/`.

- **Run `main` through `test_support::Fake`**:
  `Fake::at(root).argv(…).env(…).run(&fake).task(main)` collects the logged lines and
  returns an `Outcome`. Pass a `run` that records each call and answers from a table, as
  `xtask/src/sync_labels.rs`'s tests do for `gh` and `xtask/src/clippy_guard.rs`'s for
  `cargo`, and assert on the recorded calls: that is how a test proves what would have
  been sent to GitHub without sending it.
- **A throwaway directory or repository per test**: `test_support::temp_dir()` or
  `committed_repo()`, never the real checkout and never a fixed shared path, since
  tests run in parallel and two on one path race. A run of the binary in `xtask/tests/`
  sets `CARGO_MANIFEST_DIR` to a temporary directory's `xtask/`, which is how the binary
  finds its root under `cargo run`.
- **Assert the code, not the prose** (`outcome.code()`): the code is the contract; the
  wording may improve.
- **Secret-shaped fixtures are assembled at runtime** from pieces that do not match on
  their own, so no committed file, the test included, trips the staged guard or GitHub
  push protection. Say so in the test's comment.

Enforced by: the `test-xtask` recipe's `--fail-under-*` flags (`xtask` with
`xtask-guard` lines 85, functions 90; `xtask/guard/` alone lines 90, functions 100). An
untested new file counts as 0%, so it pulls the number down from the moment it exists.

## A skill's bundled script

- **Header comment**: what it does, its usage line, what it needs (`gh`, authenticated;
  Python's version), what it does outside a git work tree, and its `Errors:` list, as
  `survey_prs.py`'s header shows.
- **Standard library only.** A skill cannot install a package, so Python reads TOML
  with `tomllib` and JSON with `json`, never a regex over YAML or TOML. `python3` and
  `gh`, like `git`, are assumed on PATH rather than pinned by mise.
- **Tests under the skill's `scripts/tests/`** (`test_*.py`, `unittest`), with a fake
  `gh` put on PATH by the suite's `_fakegh.py` (`FakeGh`: an argv-prefix routing table
  that records every call), so no test reaches GitHub. Run the script's `main()`
  in-process with the fake's environment; a test that needs files works in a
  `tempfile.TemporaryDirectory()`, never the real checkout.
- `just test-scripts` runs each skill's suite with no coverage floor, and shellcheck
  over `shipping-issues`' shell scripts. A skill that gains its first suite adds its line
  to the `test-scripts` recipe in the same pull request.

## Adding a task or a script

A new one usually lands with more than its own file:

- its tests, and for a task its row in `xtask/src/main.rs`'s `TASKS`;
- a `justfile` recipe if people run it by hand, the recipe's line in `AGENTS.md`'s Quick
  Reference, and its command in `CONTRIBUTING.md`'s "Without Just";
- a "Validating a change" row when no row covers it, and an "Enforcement layers" row
  when it enforces something. **REQUIRED:** `changing-gates` for a task a gate runs.

Check a task with `cargo nextest run -p xtask -p xtask-guard` while iterating, then
`just test-xtask` (the floors) and `just lint`; check a bundled script with
`just test-scripts`.
