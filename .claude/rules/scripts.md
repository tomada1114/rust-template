---
paths:
  - "xtask/**"
  - ".claude/skills/*/scripts/**"
---

The contract every piece of repository automation keeps: a `cargo xtask` task and a
script a skill bundles. The reasons behind it, with worked examples, are in the
`writing-repo-scripts` skill, which restates none of it.

## A `cargo xtask` task

Repository automation is Rust tasks in the `xtask/` crate, run as `cargo xtask <task>`.
A task is a function of a faked context (`xtask/src/context.rs`'s `Context`: argv, env, root, a
`run` function for child processes, a logger, stdin); spawned git gets `git_env` or, for
the staged guard, `staged_guard_env`
(`xtask/src/git_env.rs`); a failure is a `ScriptError` (`xtask/src/fail.rs`) printed as
the `ERR_<STAGE>_<WHAT>` report below; a task whose job is a GitHub write
(`sync-labels`, `apply-ruleset`) may also depend on `gh`, which like `git` is assumed on
PATH rather than pinned by mise; its tests sit in a `#[cfg(test)] mod tests`
beside it (end-to-end runs of the binary in `xtask/tests/`), in a temporary directory or
a throwaway repository, never the real checkout. `just test-xtask` (part of `just check`
and CI's `Repo Lint & Harness` job) holds `xtask` and `xtask-guard` together to lines 85
and functions 90, and the guard's rules in `xtask/guard/` alone to lines 90 and
functions 100. The harness checks (`cargo xtask check-harness`, one module per claim
under `xtask/src/check_harness/`) read YAML through `yaml-rust2` and TOML through `toml`,
never a regex, and take `--root` so a test can point one at a fixture tree per failure
mode (`xtask/tests/fixtures/`).

## A skill's bundled script

A skill's bundled scripts (Python and shell, under `.claude/skills/<skill>/scripts/`)
keep the same contract, whoever writes them:

- Pinned tools are called by bare name; the caller provides PATH (`mise exec -- …`
  locally, `jdx/mise-action` in CI). `python3` and `gh`, like `git`, are assumed on PATH
  rather than pinned by mise; a script's tests stub `gh` out, so `just check` never needs
  the real binary.
- Real parsers for structured files (`tomllib`, `json`), never a regex over YAML or TOML.
- Spawned git gets an environment with every `GIT_*` variable stripped, as
  `xtask/src/git_env.rs`'s `git_env` does: inside a hook, git's exported variables
  would point a child git at the hook's repository.
- Failure contract: the first stderr line is `ERR_<STAGE>_<WHAT>: <what failed>`, then
  `Expected:`, `Actual:`, and `Next:` lines (the next safe command); exit 1 (a Claude
  Code hook exits 2, the code that feeds stderr back to the agent). List the codes in
  the script's header comment. Never print a secret value.
- Never assume the checkout is the only repository on the machine. A script that
  enumerates or rewrites tracked files refuses to run outside a git work tree; a check
  that is meaningless outside one skips with a one-line notice instead. Each script's
  header states which it does.
- Every script has tests under its skill's `scripts/tests/`, run by `just test-scripts`
  (part of `just check` and CI's `Repo Lint & Harness` job) with no coverage floor; a
  skill that ships a shell script adds a shellcheck line for it to that recipe. A test
  works in a temp directory or a throwaway repository, never the real checkout, and
  shares no state with any other test.
