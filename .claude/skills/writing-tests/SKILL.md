---
name: writing-tests
description: >
  Covers how one test is written, in Rust and in TypeScript: naming it after behavior,
  an expected value that is independent of the implementation, asserting an error
  variant or code (assert_eq! on an Err variant, a { code } object) instead of its
  message, the contract suite a port's fake and real adapter share (<port>_contract in
  myapp-test-support), fakes such as FixedClock instead of mocks, an injected clock and
  never a sleep, tempfile::tempdir per test, commands driven through tauri::test
  get_ipc_response, Testing Library queries by role and accessible name, and mockCommands
  / rejectWith / emitEvent over mockIPC. Use when writing or reviewing a #[test], a file
  under crates/*/tests or src-tauri/tests, a .test.ts or .test.tsx, the regression test
  for a bug, a flaky or ignored test, or the missing test a coverage floor asks for.
---

# Writing Tests

**Owns:** how one test case is written — its name, the interface it drives, what it
asserts, how it fakes the world, and what review rejects. **Does not own:** which file
a test goes in, which Vitest project or recipe runs it, and which floor measures it
(`placing-tests`); the order of work (`tdd`); the shape of the error types a test
asserts against (`designing-errors`); how a script's `main` and its fake context are
built (`writing-repo-scripts`).

Worked examples of every pattern below, in both languages, are in
[references/patterns.md](references/patterns.md).

## Naming and scope

- A test's name states behavior, not implementation. Rust: a sentence in snake case
  (`increment_at_the_maximum_fails_and_saves_nothing`). TypeScript:
  `it("keeps the view and holds the error code when Rust rejects a change")`, not
  `it("calls setState")`.
- One behavior per test; no `if` in a test body. Variations of one behavior go in a
  table: `it.each([...])` in Vitest, labelled through `%s` in the title; in Rust, a
  loop over an array of `(input, expected)` pairs whose assertion message names the
  case, since the standard test harness has no parameterized tests. A crate for that
  (`rstest`) is a new dependency (`managing-dependencies`).
- Cover the happy path and the error path of every public function and every command.
- Build a case's data with a helper that takes what varies, never a shared mutable
  fixture another test can change. In the sample, `app_holding(Some(2))` in
  `src-tauri/tests/commands.rs` builds an app whose store holds 2. Files under
  `scripts/**/fixtures/` are data under test, never imported as modules.

## Test through an interface

Drive the code the way its caller does, so a refactor that keeps the behavior keeps the
test green:

- **Core's public API** from `crates/myapp-core/tests/`, over fakes; a private helper
  from the inline `#[cfg(test)] mod tests` beside it.
- **A command** through Tauri's mock runtime: `with_commands(mock_builder())` builds the
  same handler list the app ships, and `get_ipc_response` sends the JSON the UI would.
  Assert the JSON the UI receives, the `{ code }` it is rejected with, and the event
  emitted (`src-tauri/tests/commands.rs`).
- **A hook** with `renderHook` and **a screen** with `render`, the Rust side answered by
  `mockCommands` from `ui/src/ipc/testing.ts`. The mock sits at the IPC boundary, so the
  wrapper in `ui/src/ipc/commands.ts` and its command name run as in production; never
  `vi.mock` a module of this repository.
- **The `myapp` binary** as a built executable with `HOME` pointed at a temporary
  directory (`crates/myapp/tests/cli.rs`): its contract is arguments in, exit code,
  stdout, and stderr out.
- **A script** by calling its `main` with a fake `ScriptContext` (`writing-repo-scripts`).

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

## Asserting errors

- Assert the variant or the code, never the message text: the message is for a
  developer reading a log, and rewording it must not break a test. In the sample, Rust
  asserts `assert_eq!(service.increment(), Err(CounterError::AtMaximum))`, a command
  test `Err(json!({ "code": "atMaximum" }))`, and a UI test
  `error: { code: "atMaximum" }`. When a variant has no `PartialEq`, use
  `assert!(matches!(result, Err(Kind::Variant)))`. The exception is a test whose
  subject is the message, such as proving it carries no user data
  (`error_messages_carry_no_data` in `crates/myapp-core/tests/serialization.rs`).
- After a rejected change, assert that nothing changed as well: the store still holds
  the old value, and no event was emitted.
- A command rejects with Rust's plain `{ code }` object, not an `Error`; `rejectWith`
  reproduces exactly that in a UI test.

## Expected values come from outside the code

The expected value is a literal worked out by hand, a table pairing each input with
its answer, or an invariant that holds whatever the input (a save then a load returns
what went in). Never compute it with the code under test or re-derive it with the
implementation's formula. In the sample, `assert_eq!(counter.value(), 99)` catches a bug
that `assert_eq!(counter.value(), (98 + 1).min(tuning.max))` shares with the code. JSON
that crosses IPC or reaches disk is pinned with a literal `json!({ … })`, independent
of serde's derive (`crates/myapp-core/tests/serialization.rs`).

## Edge cases to sweep

At each bound, one step inside, and one step outside; the operation repeated at a
bound; the state after an error; `0`, `1`, a negative number, `i64::MAX` and `i64::MIN`
where arithmetic happens — an overflow panics in a debug build and wraps silently in a
release build (https://doc.rust-lang.org/book/ch03-02-data-types.html#integer-overflow,
checked 2026-09-29);
`None` and `Some`, and `null` in JSON; an empty collection and one element; long,
Unicode, and emoji strings; in TypeScript, an absent property against an explicit
`undefined`.

## Fakes, not mocks

A port is replaced in a test by its fake from `crates/myapp-test-support`, never by a
mocking framework. A fake is a working implementation, configured per case, that
records what happened in a plain value the test reads afterwards. In the sample,
`InMemoryCounterStore::holding(…)` and `FailingCounterStore::save_fails(…)` configure
one, and `store.saved()` reads it.
Every test of a port uses that one fake, so its test-time behavior is defined once.
Assert the state the code produced, not the calls it made, unless asking is itself the
behavior (the UI logged a bridge failure: `expect(calls).toContain("log_from_ui")`).
Do not add a trait, or a fake for it, until something actually varies across it.

## Time, waiting, and isolation

- Time is injected, never waited for. Core reads time only through `Clock`, so a test
  hands it `FixedClock::default()` (the instant `FixedClock::DEFAULT`) and moves it with
  `advance` or `set`. No `std::thread::sleep`, and no assertion on the wall clock.
- In Vitest, await the promise, `findBy…`, or `waitFor`; fake timers only for code that
  itself schedules. A Rust test waiting for something that should arrive uses a
  generous timeout that normally returns at once (`recv_timeout` of five seconds); a
  test that something does not arrive keeps its bound short and is rare.
- A test that touches the file system gets its own directory: `tempfile::tempdir()`,
  bound to a variable that lives until the test ends (the directory is deleted when the
  `TempDir` is dropped); `mkdtemp` under `os.tmpdir()`, removed in `afterEach`, in
  TypeScript. Never a fixed path, the checkout, or the real `~/Library`.
- Process-wide state is not changed in-process: `std::env::set_var` is `unsafe` in
  edition 2024 and `unsafe` is forbidden, so a test sets `HOME` on a child process;
  Vitest stubs go through `vi.stubEnv` and `vi.stubGlobal`, which `vitest.config.ts`
  restores after every test, as it restores mocks. An `afterEach` whose only job is
  `vi.restoreAllMocks()` is noise; `ui/src/test/setup.ts` already unmounts and clears
  the IPC mocks.
- Tests are independent: no shared mutable state, no order, and no dependence on the
  machine's time zone, locale, or CPU count. nextest runs each test in its own process
  (https://nexte.st/docs/design/how-it-works/, checked 2026-09-29), and Vitest runs
  files in parallel. A flaky test is fixed, never retried or skipped.
- What the runner does not clean up (a listener, a child process, a thread) the test
  cleans up itself, on the failure path too.

## The UI

- Query by role and accessible name: `getByRole("button", { name: "Increment" })`,
  never by class, test id, or a glyph, so an unlabeled control fails the test
  (Testing Library's priority: https://testing-library.com/docs/queries/about/#priority,
  checked 2026-09-30).
  `findBy…` waits for what appears after a promise.
- Drive it as a user: `userEvent.click`, `userEvent.tab`, `userEvent.keyboard`.
- Simulate a Rust event with `emitEvent`, which needs `mockCommands` first
  (`shouldMockEvents`; Tauri's mocking guide: https://v2.tauri.app/develop/tests/mocking/,
  checked 2026-09-30).

## Rejected in review

- `unwrap` in a helper function under `tests/` that is not itself a `#[test]`: clippy
  does not count it as test code, so it fails `just lint`; panic with context instead
  (`must` in `src-tauri/tests/commands.rs`).
- `is_ok()`, `toBeDefined()`, or `not.toBeNull()` where a specific value is checkable.
- Testing that a dependency works rather than how this code uses it.
- Mocking so much that the code under test never runs.
- `.only` (Vitest's `allowOnly: false` fails the run), and `.skip`, `.todo`, or
  `#[ignore]` on a failing test. An `#[ignore]` always carries its reason
  (`#[ignore = "local machine: <what it needs>"]`) and is for a test that needs a human's
  Mac, never one that merely fails.
- Weakening or deleting an assertion to make a test pass.

Property-based testing (`proptest`) fits a well-defined invariant over a large input
space, such as a round trip. It is not a dependency here, and adding it is a dependency
decision: **REQUIRED:** `managing-dependencies`.
