---
name: placing-tests
description: >
  Decides where a new test goes and what runs and measures it: a #[cfg(test)] mod
  tests beside core code vs crates/myapp-core/tests/, fakes and <port>_contract
  functions in crates/myapp-test-support, adapter tests in crates/myapp-platform/tests
  and #[ignore = "local machine: ..."] for ones that need a human's machine, the
  binary's command line in crates/myapp/tests/cli.rs, its wording in wording.rs, the
  TUI's key translation and its TestBackend view tests in crates/myapp/src/tui/, a
  cargo xtask task's tests, a skill's bundled script suite under its scripts/tests/,
  and which coverage floor governs it (the llvm-cov floors in the justfile's test-core
  and test-xtask recipes). Use when adding a test file, choosing between just
  test-fast, just test-core, just test-platform, just test-xtask, and just
  test-scripts, when a fake from myapp-test-support will not type-check inside core,
  or when a coverage floor fails.
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
| A TUI screen's state and what each action or key does to it | the same two places: the screen's module for its key table, `crates/myapp-core/tests/` for `update` over the fakes | `just test-fast <filter>`, `just test-core` | core's floors |
| A port's contract against the fake | the `<port>_contract` function in `crates/myapp-test-support/src/<port>.rs`, called from `crates/myapp-core/tests/contracts.rs` | `just test-core` | core's floors (the core code it drives) |
| The same contract against the real adapter | `crates/myapp-platform/tests/contracts.rs` | `just test-core` and `just test-platform` | none |
| What one adapter does beyond the contract | `crates/myapp-platform/tests/<adapter>.rs`, or the adapter's own `#[cfg(test)]` module for a pure helper (`paths.rs`) | `just test-core`, `just test-platform` | none |
| An adapter behavior that needs a GUI session, a TCC grant, the Keychain, or a real terminal | the same file, `#[ignore = "local machine: <what it needs>"]` | `just test-local`, a human's recipe | none |
| The `myapp` command line: arguments, streams, exit codes | `crates/myapp/tests/cli.rs`, the built binary with a temporary `HOME` | `just test-core`, `just test-platform` | none |
| The binary's wording for each error variant | `#[cfg(test)] mod tests` in `crates/myapp/src/wording.rs`, one test per variant | `just test-core`, `just test-platform` | none |
| How a terminal key event becomes core's key | `#[cfg(test)] mod tests` in `crates/myapp/src/tui/mod.rs` | `just test-core`, `just test-platform` | none |
| What a TUI state looks like on screen | `#[cfg(test)] mod tests` in `crates/myapp/src/tui/view.rs`, drawn into ratatui's `TestBackend` | `just test-core`, `just test-platform` | none |
| The real terminal loop (raw mode, the alternate screen, restoring it) | nowhere automated: a human runs `myapp tui` (`building-tuis`) | a human | none |
| A repository task in `xtask/` | `#[cfg(test)] mod tests` in the task's file, with fakes for its child processes; a run of the built binary in `xtask/tests/` (`CARGO_BIN_EXE_xtask`, with a temporary directory as its root) | `just test-xtask` | `xtask` 85/90, and `xtask/guard/` 90/100 for the staged guard's rules |
| A skill's bundled Python or shell script | the skill's own suite (`.agents/skills/<name>/scripts/tests/test_*.py`; `shellcheck` for `.sh`) | `just test-scripts` | none: no coverage is measured |

A domain decision tested only in a row that no floor measures is in the wrong place:
move it into core and test it there. The platform crate and the binary translate, so
they sit outside the floor on purpose, and a numeric gate there would only invite tests
of glue.

## Core: inline module or `tests/`

- An inline `#[cfg(test)] mod tests` sees private items, so it is for a private detail
  and for a pure value type's own rules. In the sample, `Counter`'s bounds are tested
  there, in `crates/myapp-core/src/counter/mod.rs`, and the key table in `screen.rs`.
- Anything that uses `myapp-test-support` goes in `crates/myapp-core/tests/`. The
  support crate depends on core, so inside core's own unit-test build it links a
  second copy of core: a fake then implements the other copy's trait, and the compiler
  reports mismatched types (E0308) or a missing trait (E0277) for code that looks
  right. An integration test sees only core's `pub` API, which is also what keeps it
  from pinning internals.
- Each file under `tests/` is its own test binary; group by subject
  (`counter_service.rs`, `counter_screen.rs`, `serialization.rs`, `contracts.rs`), not
  one file per test. The Book on this layout:
  https://doc.rust-lang.org/book/ch11-03-test-organization.html
- A code example in a `///` comment on a core item is compiled and run as a doctest by
  `just test-core`; keep one only if it is meant to run. In the sample, `Tuning`
  carries one.

## Fakes and contracts: `myapp-test-support`

- One fake per port and one `<port>_contract` function per port, in
  `crates/myapp-test-support/src/<port>.rs`, re-exported from its `lib.rs`. A new port
  gets its fake and its contract in the same change, and both test crates call the
  contract.
- The crate is a `[dev-dependencies]` entry only, so test code never ships; a harness
  check fails on a normal dependency edge to it (`just check-harness`).
- Never make one test crate depend on another's `tests/` files: shared test code
  belongs in `myapp-test-support`. The binary's tests use the same fakes (the
  `TestBackend` tests in `view.rs` build a `CounterService` over
  `InMemoryCounterStore` and `FailingCounterStore`).

## Platform and the human's machine

- A test that needs only a file system runs everywhere: `myapp-platform` builds on
  Linux and macOS, so `just test-core`, `just test-platform`, and CI's Linux and macOS
  jobs all run it. Each test gets its own `tempfile::tempdir()`.
- A test of macOS-only or Linux-only behavior carries the same `#[cfg(target_os = …)]`
  as the code it tests, so it runs on the CI job for that OS
  (`macos_selects_the_macos_directories` in `paths.rs`; the XDG test in `cli.rs`).
- A test that needs a logged-in GUI session, a TCC grant, the Keychain, or a real
  terminal carries `#[ignore = "local machine: <what it needs>"]`. It is reported as
  ignored everywhere else, and only `just test-local` runs it — a human's recipe,
  because it may raise a prompt or take over a terminal (`AGENTS.md` › "Never taking
  over the developer's Mac"). A pull request that changes such an adapter carries that
  output. Never an `#[ignore]` without the reason, and never one on a test that merely
  fails.
- A local-machine test is never the only test of a decision: nobody runs it for a pull
  request unasked.

## The binary: `crates/myapp/`

The command line is tested from outside, against the built executable, because its
contract is what a person or a script sees: arguments in, exit code, stdout, and stderr
out (`designing-clis` › "Testing the binary"). What sits inside the binary — the
wording, the key translation, the view — is tested by unit tests beside it, with no
terminal (`building-tuis` › "Testing without a terminal"). `just test-core` runs all of
them after core's floors, and `just test-platform` runs them again with the platform
tests; neither measures their coverage.

## Coverage floors

The numbers live in their configs, not here, because a copied number goes stale the
moment the config changes: the `--fail-under-lines` and `--fail-under-functions` flags
of the justfile's `test-core` recipe (`cargo llvm-cov nextest -p myapp-core`) and
`test-xtask` recipe.

- **Only core's own tests count toward core's floor.** `just test-core` measures the
  test binaries of `myapp-core`; a CLI, TUI, or platform test that happens to exercise
  core adds nothing to it.
- **The floors measure lines and functions, not branches.** Branch coverage in
  `cargo llvm-cov` needs a nightly toolchain
  (https://github.com/taiki-e/cargo-llvm-cov, checked 2026-09-29), and this repository
  pins stable. So a missed `else` passes every gate: write the test for each side of
  every conditional yourself.
- **One floor per tree, no combined number.** Core, `xtask` with `xtask-guard`, and
  `xtask/guard/` alone are each judged on their own, so a well-tested tree cannot
  subsidize an untested one: write a new file's tests in the same pull request.
- **Coverage stops at the process boundary.** A binary a test spawns is not measured,
  so keep `main.rs` to wiring and put anything with a branch where an in-process test
  reaches it, in core first.
- **A floor is never lowered, and nothing is excluded to move a number**
  (`AGENTS.md` › "Security and human approval"). If a floor fails, add tests for the
  uncovered code.

The reasoning behind the split is `README.md` › "Why a coverage floor on the core
only?".
