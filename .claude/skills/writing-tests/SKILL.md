---
name: writing-tests
description: >
  Covers how one Rust test is written: naming it after behavior, an expected value
  that is independent of the implementation, asserting an error variant (assert_eq! on
  an Err variant) instead of its message, the contract suite a port's fake and real
  adapter share (<port>_contract in myapp-test-support), fakes such as FixedClock,
  InMemoryCounterStore, and FailingCounterStore instead of mocks, an injected clock and
  never a sleep, tempfile::tempdir per test, the built myapp binary run with a
  temporary HOME (exit code, stdout, last stderr line), a TUI view drawn into ratatui's
  TestBackend (assert_buffer_lines, assert_buffer for styles), and keys as values
  (KeyEvent::new_with_kind, ScreenKey). Use when writing or reviewing a #[test], a file
  under crates/*/tests, a test module in crates/myapp/src, the regression test for a
  bug, a flaky or ignored test, or the missing test a coverage floor asks for.
---

# Writing Tests

**Owns:** how one test case is written — its name, the interface it drives, what it
asserts, how it fakes the world, and what review rejects. **Does not own:** which file
a test goes in, which recipe runs it, and which floor measures it (`placing-tests`);
the order of work (`tdd`); the shape of the error types a test asserts against
(`designing-errors`); how a `cargo xtask` task's or a skill script's fakes are built
(`writing-repo-scripts`).

Worked examples of every pattern below are in
[references/patterns.md](references/patterns.md).

## Naming and scope

- A test's name is a sentence in snake case stating behavior, not implementation:
  `increment_at_the_maximum_fails_and_saves_nothing`, not `test_increment_2`.
- One behavior per test; no `if` in a test body. Variations of one behavior go in a
  table: a loop over an array of `(input, expected)` pairs whose assertion message
  names the case, since the standard test harness has no parameterized tests. A crate
  for that (`rstest`) is a new dependency (`managing-dependencies`).
- Cover the happy path and the error path of every public function and every
  subcommand.
- Build a case's data with a helper that takes what varies, never a shared mutable
  fixture another test can change. In the sample, `service_holding(2)` in
  `crates/myapp-core/tests/counter_screen.rs` builds a service whose store holds 2.

## Test through an interface

Drive the code the way its caller does, so a refactor that keeps the behavior keeps the
test green:

- **Core's public API** from `crates/myapp-core/tests/`, over fakes; a private helper
  from the inline `#[cfg(test)] mod tests` beside it.
- **A TUI screen's behavior** through core's `…Screen::update`, with actions and keys
  built as values; the sample's `after_keys` folds a list of `ScreenKey`s through
  `ScreenAction::for_key` and `update` the way the binary's loop does.
- **The terminal's key translation** by building a crossterm `KeyEvent` with
  `KeyEvent::new_with_kind` and asserting the `ScreenKey` it becomes (`tui/mod.rs`).
- **A view** by drawing it into ratatui's `TestBackend` and comparing every cell
  (`tui/view.rs`; `building-tuis` › "Testing without a terminal").
- **The `myapp` binary** as a built executable (`env!("CARGO_BIN_EXE_myapp")`) with
  `HOME` pointed at a temporary directory and the `XDG_*` variables removed
  (`crates/myapp/tests/cli.rs`): its contract is arguments in, exit code, stdout, and
  stderr out.
- **A `cargo xtask` task** by calling its `main` through `test_support::Fake`, and **a
  skill's script** by calling its `main()` with a fake `gh` on PATH
  (`writing-repo-scripts`).

Wanting to reach past an interface to assert something means the code is the wrong
shape, not that the test needs an exception.

## The contract suite

When a port has a fake and a real adapter, the behavior both owe is written once, as
`pub fn <port>_contract(make: impl FnMut() -> Box<dyn Port>)` in
`crates/myapp-test-support/`, and called once per implementation:
`crates/myapp-core/tests/contracts.rs` runs it against the fake and
`crates/myapp-platform/tests/contracts.rs` against the real adapter. That is what stops
the fake drifting from the real thing.

- Every clause the contract asserts is one the port's `///` promises; add the promise
  there first.
- `make` returns a fresh, empty implementation per call, so clauses do not leak into
  each other.
- Contract functions are library code, not tests: they compare with `assert_eq!` on the
  `Result` and a message naming the clause, never `unwrap`.
- A new implementation adds a call; a quirk of one implementation (its file format, how
  it reports a damaged file) gets its own test file beside it. In the sample,
  `counter_store_contract` holds what every store does, and
  `crates/myapp-platform/tests/json_file_counter_store.rs` what only the JSON file does.

## Asserting errors and output

- Assert the variant, never the `#[error]` message text: the message is for a
  developer reading a log, and rewording it must not break a test. In the sample,
  `assert_eq!(service.increment(), Err(CounterError::AtMaximum))`. When a type has no
  `PartialEq`, use `assert!(matches!(result, Err(Kind::Variant)))`.
- The user-facing sentence is asserted where it is the subject: once per variant in
  `wording.rs`'s tests, and as the whole `error: …` line in `cli.rs` and on the TUI's
  error line, because there the wording is the contract a user reads. The other
  exception is a test proving a message carries no user data
  (`error_messages_carry_no_data` in `crates/myapp-core/tests/serialization.rs`).
- From the binary, assert the exit code, stdout exactly (`"0\n"`, not "contains 0"),
  and the last stderr line, since a debug build echoes log lines to stderr first.
- After a rejected change, assert that nothing changed as well: the store still holds
  the old value, and the command printed no data.

## Expected values come from outside the code

The expected value is a literal worked out by hand, a table pairing each input with
its answer, or an invariant that holds whatever the input (a save then a load returns
what went in). Never compute it with the code under test or re-derive it with the
implementation's formula. In the sample, `assert_eq!(counter.value(), 99)` catches a bug
that `assert_eq!(counter.value(), (98 + 1).min(tuning.max))` shares with the code.
JSON that reaches disk or a script is pinned with a literal `json!({ … })`, independent
of serde's derive (`crates/myapp-core/tests/serialization.rs`), and a screen with its
lines written out, border included.

## Edge cases to sweep

At each bound, one step inside, and one step outside; the operation repeated at a
bound; the state after an error; `0`, `1`, a negative number, `i64::MAX` and `i64::MIN`
where arithmetic happens — an overflow panics in a debug build and wraps silently in a
release build (https://doc.rust-lang.org/book/ch03-02-data-types.html#integer-overflow,
checked 2026-09-29); `None` and `Some`, and `null` in JSON; an empty collection and one
element; long, Unicode, and emoji strings; for a binary, a missing or empty `HOME`, a
file where a directory should be, and a closed stdout; for a screen, a terminal too
small for the layout.

## Fakes, not mocks

A port is replaced in a test by its fake from `crates/myapp-test-support`, never by a
mocking framework. A fake is a working implementation, configured per case, that
records what happened in a plain value the test reads afterwards. In the sample,
`InMemoryCounterStore::holding(…)` and `FailingCounterStore::save_fails(…)` configure
one, and `store.saved()` reads it. Every test of a port uses that one fake, so its
test-time behavior is defined once. Assert the state the code produced, not the calls
it made. Do not add a trait, or a fake for it, until something actually varies across
it.

## Time, waiting, and isolation

- Time is injected, never waited for. Core reads time only through `Clock`, so a test
  hands it `FixedClock::default()` (the instant `FixedClock::DEFAULT`) and moves it with
  `advance` or `set`. No `std::thread::sleep`, and no assertion on the wall clock.
- A test that touches the file system gets its own directory: `tempfile::tempdir()`,
  bound to a variable that lives until the test ends (the directory is deleted when the
  `TempDir` is dropped); `tempfile.TemporaryDirectory()` in a skill's Python suite.
  Never a fixed path, the checkout, or the real home, data, or log directory.
- Process-wide state is not changed in-process: `std::env::set_var` is `unsafe` in
  edition 2024 and `unsafe` is forbidden, so a test sets `HOME` on a child process.
- Tests are independent: no shared mutable state, no order, and no dependence on the
  machine's time zone, locale, or CPU count. nextest runs each test in its own process
  (https://nexte.st/docs/design/how-it-works/, checked 2026-09-29); a test that
  installs the process-wide `tracing` subscriber relies on that
  (`crates/myapp-platform/tests/logging.rs`). A flaky test is fixed, never retried or
  skipped.
- No test opens a real terminal, enters raw mode, or reads a key: a check never takes
  over the developer's terminal (`building-tuis`). What the runner does not clean up (a
  child process, a thread) the test cleans up itself, on the failure path too.

## Rejected in review

- `unwrap` in a helper function under `tests/` that is not itself a `#[test]`: clippy
  does not count it as test code, so it fails `just lint`; match and panic with context
  instead (`output` in `crates/myapp/tests/cli.rs`).
- `is_ok()`, `is_some()`, or `contains` where a specific value is checkable.
- Testing that a dependency works (that clap parses, that ratatui draws a border)
  rather than how this code uses it.
- Mocking so much that the code under test never runs.
- `#[ignore]` on a failing test, or a `skip` in a skill's suite. An `#[ignore]` always
  carries its reason (`#[ignore = "local machine: <what it needs>"]`) and is for a test
  that needs a human's machine, never one that merely fails.
- Weakening or deleting an assertion to make a test pass.

Property-based testing (`proptest`) fits a well-defined invariant over a large input
space, such as a round trip. It is not a dependency here, and adding it is a dependency
decision: **REQUIRED:** `managing-dependencies`.
