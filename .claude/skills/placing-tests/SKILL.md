---
name: placing-tests
description: >
  Decides where a new test goes and what runs and measures it: a #[cfg(test)] mod
  tests beside core code vs crates/myapp-core/tests/, fakes and <port>_contract
  functions in crates/myapp-test-support, adapter tests in crates/myapp-platform/tests
  and #[ignore = "local machine: ..."] for ones that need a human's Mac, tauri::test
  command tests in src-tauri/tests, the binary's tests in crates/myapp/tests, a cargo
  xtask task's tests, a skill's bundled script suite under its scripts/tests/, and which
  coverage floor governs it (the llvm-cov floors in the justfile's test-core and
  test-xtask recipes). Use when adding a test file, choosing between just test-fast,
  just test-core, just test-platform, just test-xtask, and just test-scripts, when a
  fake from myapp-test-support will not type-check inside core, or when a coverage
  floor fails.
---

# Placing Tests

**Owns:** where a new test goes, which recipe runs it, and which coverage floor
measures it. **Does not own:** how the test is written, asserted, and faked
(`writing-tests`); the red-green loop (`tdd`); changing a floor (`changing-gates`).

## The rule: the cheapest place that can fail for it

Split by what is under test, and put each test where it runs fastest and on the
fewest machines while still able to fail for the behavior:

| Under test | The file | Run by | Measured by |
|---|---|---|---|
| A private detail of core | `#[cfg(test)] mod tests` at the bottom of the same file | `just test-fast <filter>`, `just test-core` | core's floors |
| Core's public API, and anything using a fake | `crates/myapp-core/tests/<subject>.rs` | `just test-fast <filter>`, `just test-core` | core's floors |
| A port's contract against the fake | the `<port>_contract` function in `crates/myapp-test-support/src/<port>.rs`, called from `crates/myapp-core/tests/contracts.rs` | `just test-core` | core's floors (the core code it drives) |
| The same contract against the real adapter | `crates/myapp-platform/tests/contracts.rs` | `just test-core` (Linux-buildable) and `just test-platform` | none |
| What one adapter does beyond the contract | `crates/myapp-platform/tests/<adapter>.rs` | `just test-core`, `just test-platform` | none |
| An adapter behavior that needs a GUI session, a TCC grant, or the Keychain | the same file, `#[ignore = "local machine: <what it needs>"]` | `just test-local`, a human's recipe | none |
| A Tauri command, its error mapping, its event | `src-tauri/tests/commands.rs` | `just test-platform` | none |
| A pure startup decision in the shell | `#[cfg(test)] mod tests` in that file (`src-tauri/src/startup.rs`) | `just test-platform` | none |
| The `myapp` binary's command line | `crates/myapp/tests/cli.rs`, the built binary with a temporary `HOME` | `just test-core` | none |
| The binary's wording for an error code | `#[cfg(test)] mod tests` in `crates/myapp/src/wording.rs`, one test per variant | `just test-core` | none |
| A repository task in `xtask/` | `#[cfg(test)] mod tests` in the task's file, with fakes for its child processes; a run of the built binary in `xtask/tests/` (`CARGO_BIN_EXE_xtask`, with a temporary directory as its root) | `just test-xtask` | `xtask` 85/90, and `xtask/guard/` 90/100 for the staged guard's rules |
| A skill's bundled Python or shell script | the skill's own suite (`.agents/skills/<name>/scripts/tests/test_*.py`; `shellcheck` for `.sh`) | `just test-scripts` | none: no coverage is measured |

A domain decision tested only in a row that no floor measures is in the wrong place:
move it into core and test it there. The platform crate, the shell, and the CLI
translate, so they sit outside the floor on purpose, and a numeric gate there would
only invite tests of glue.

## Core: inline module or `tests/`

- An inline `#[cfg(test)] mod tests` sees private items, so it is for a private detail
  and for a pure value type's own rules. In the sample, `Counter`'s bounds are tested
  there, in `crates/myapp-core/src/counter/mod.rs`.
- Anything that uses `myapp-test-support` goes in `crates/myapp-core/tests/`. The
  support crate depends on core, so inside core's own unit-test build it links a
  second copy of core: a fake then implements the other copy's trait, and the compiler
  reports mismatched types (E0308) or a missing trait (E0277) for code that looks
  right. An integration test sees only core's `pub` API, which is also what keeps it
  from pinning internals.
- Each file under `tests/` is its own test binary; group by subject
  (`counter_service.rs`, `serialization.rs`, `contracts.rs`), not one file per test.
  The Book on this layout:
  https://doc.rust-lang.org/book/ch11-03-test-organization.html
- A code example in a `///` comment on a core item is compiled and run as a doctest by
  `just test-core`; keep one only if it is meant to run. In the sample, `Tuning` and
  `UiLogEntry::loggable_message` carry one each.

## Fakes and contracts: `myapp-test-support`

- One fake per port and one `<port>_contract` function per port, in
  `crates/myapp-test-support/src/<port>.rs`, re-exported from its `lib.rs`. A new port
  gets its fake and its contract in the same change, and both test crates call the
  contract.
- The crate is a `[dev-dependencies]` entry only, so test code never ships; a harness
  check fails on a normal dependency edge to it (`just check-harness`).
- Never make one test crate depend on another's `tests/` files: shared test code
  belongs in `myapp-test-support`.

## Platform and the human's Mac

- A test that needs only a file system runs on the macOS CI runner and, since
  `myapp-platform` builds on Linux, in `just test-core` as well; each test gets its own
  `tempfile::tempdir()`.
- A test that needs a logged-in GUI session, a TCC grant, or the Keychain carries
  `#[ignore = "local machine: <what it needs>"]`. It is reported as ignored everywhere
  else, and only `just test-local` runs it — a human's recipe, because it may raise a
  prompt or need a grant (`AGENTS.md` › "Never taking over the developer's Mac"). A pull
  request that changes such an adapter carries that output. Never an `#[ignore]`
  without the reason, and never one on a test that merely fails.
- A local-machine test is never the only test of a decision: nobody runs it for a pull
  request unasked.

## Commands: `src-tauri/tests/`

Command tests build the app with `with_commands(mock_builder())` and core's service
over fakes, so they touch no disk and open no window. This repository builds the Tauri
crate only on macOS (CI's Linux jobs never compile it), so they run in
`just test-platform` and CI's macOS job, not in `just test-core`.

## Coverage floors

The numbers live in their configs, not here, because a copied number goes stale the
moment the config changes: the `--fail-under-lines` and `--fail-under-functions` flags
of the justfile's `test-core` recipe (`cargo llvm-cov nextest -p myapp-core`) and
`test-xtask` recipe.

- **Only core's own tests count toward core's floor.** `just test-core` measures the
  test binaries of `myapp-core`; a command test, a CLI test, or a platform test that
  happens to exercise core adds nothing to it.
- **The floors measure lines and functions, not branches.** Branch coverage in
  `cargo llvm-cov` needs a nightly toolchain
  (https://github.com/taiki-e/cargo-llvm-cov, checked 2026-09-29), and this repository
  pins stable. So a missed `else` passes every gate: write the test for each side of
  every conditional yourself.
- **One floor per tree, no combined number.** Core, `xtask` with `xtask-guard`, and
  `xtask/guard/` alone are each judged on their own, so a well-tested tree cannot
  subsidize an untested one: write a new file's tests in the same pull request.
- **Coverage stops at the process boundary.** A binary a test spawns is not measured,
  so keep a `main` to wiring and put anything with a branch where an in-process test
  reaches it.
- **A floor is never lowered, and nothing is excluded to move a number**
  (`AGENTS.md` › "Security and human approval"). If a floor fails, add tests for the
  uncovered code.

The reasoning behind the split is `README.md` › "Why a coverage floor on the core
only?".
