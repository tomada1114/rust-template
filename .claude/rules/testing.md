---
paths:
  - "crates/*/tests/**"
  - "crates/myapp-test-support/**"
  - "src-tauri/tests/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "ui/src/test/**"
---

The short version of the `tdd`, `writing-tests`, and `placing-tests` skills.

## Where a Test Goes

Split by what is under test, and put each test in the cheapest place that can fail for
it:

- **A decision → core, with a fake.** Anything that branches, clamps, formats, or
  remembers lives in `myapp-core` and is tested there: a `#[cfg(test)] mod tests` beside
  the code for a private detail, or `crates/myapp-core/tests/` for the public API and
  for anything that uses `myapp-test-support` (an inline module would see a second copy
  of core's types). These run on Linux in CI and are what the 80% line and 80% function
  floors measure (`just test-core`; `just test-fast <filter>` while iterating). This is
  the default: if an adapter or a command looks like it needs a test for a decision,
  move the decision into core instead.
- **Translation to or from the OS → the adapter's contract test.** Whether the file
  system or a macOS API really behaves as an adapter assumes is checked against the
  real thing in `crates/myapp-platform/tests/` (`just test-platform`, CI's `Rust Core` and macOS jobs). A
  test that needs a logged-in GUI session, a TCC grant, or the Keychain carries
  `#[ignore = "local machine: <what it needs>"]` and runs only in `just test-local`,
  which a human starts; a pull request that changes such an adapter carries that
  output. Never an `#[ignore]` without the reason string, and never one on a test that
  merely fails.
- **The `myapp` binary → `crates/myapp/tests/`**, running the built binary against a
  temporary `HOME` (`just test-platform`); the wording for each error code is tested per
  variant in `crates/myapp/src/wording.rs`.
- **A repository script → `scripts/<name>.test.ts` beside it**, calling `main` with a
  fake context and stubbed commands (`just test-scripts`).
- A new automated test never opens a window, takes focus, or raises a prompt
  (`AGENTS.md` › Never taking over the developer's Mac).

## An Independent Oracle

The expected value comes from somewhere other than the code under test: a literal
worked out by hand, a table pairing each input with its answer, or an invariant that
must hold whatever the input (the value stays inside the range; a save then a load
returns what went in). Never compute it by calling the implementation, and never
re-derive it with the implementation's own formula: after `increment()` from 98 with a
maximum of 99, `assert_eq!(counter.value(), 99)` catches a bug that
`assert_eq!(counter.value(), (98 + 1).min(tuning.max))` shares with the code.

## Fakes and the Contract Suite

- A port is substituted in tests by a **fake** from `myapp-test-support`
  (`InMemoryCounterStore`, `FailingCounterStore`, `FixedClock`), never a mocking
  framework. A fake is a real, working implementation that answers from data the test
  hands it and records what it was asked in a plain value the test reads afterwards.
  Every test of a port uses that one fake, so its test-time behavior is defined once.
- Each port has one contract function in `myapp-test-support`,
  `pub fn <port>_contract(make: impl FnMut() -> Box<dyn Port>)`, holding the behavior
  every implementation must have — every clause one the port's `///` states.
  `crates/myapp-core/tests/contracts.rs` runs it against the fake and
  `crates/myapp-platform/tests/contracts.rs` against the real adapter, so the fake
  cannot drift from the real thing. A new port gets its fake and its contract function
  in the same change.
- `myapp-test-support` is a `[dev-dependencies]` entry only; a harness check fails if a
  normal dependency edge points at it.

## What to Test

- Behavior and contracts, not implementation details: a test names the behavior it
  proves (`increment_saves_the_new_value_with_the_clock_time`, `it("shows the next value
  after Increment")`)
- The happy path AND the error path of every public function and every command
- Assert the error variant or code (`Err(CounterError::AtMaximum)`, `{ code:
  "atMaximum" }`), never the message text
- Boundary values: at every bound, one step inside it, and one step outside it; repeated operations
  at a bound; the state after an error (nothing changed)
- Both branches of every conditional in core: the floors measure lines and functions,
  not branches, so they will not notice a missed one

## Exhaustive Matches

- A `match` on a core enum in a test names every variant too (core denies
  `clippy::wildcard_enum_match_arm`); a table of cases lists every variant, so adding one
  fails the test that must decide about it
- A TypeScript `switch` over a union in a test is exhaustive the same way

## Hygiene

- Tests are independent: no shared mutable state, no ordering assumptions — nextest runs
  each test in its own process and Vitest runs files in parallel
- Time is injected, never waited for: core reads time only through the `Clock` port, so
  a test hands it a `FixedClock` at a chosen instant. No `std::thread::sleep`, no
  `setTimeout` to wait for something to happen, no assertion on wall-clock time; in
  Vitest, await the promise or use `findBy…`, and use fake timers only for code that
  itself schedules
- A test that touches the file system gets its own directory:
  `tempfile::tempdir()` in Rust (kept alive until the test ends), `mkdtemp` under
  `os.tmpdir()` in TypeScript. Never a fixed shared path, the checkout, or the real
  `~/Library` — parallel tests would collide, and a leftover file changes the next run
- Tests may `unwrap()`/`expect()` (a panic is how a Rust test fails) — inside a
  `#[test]` function or `#[cfg(test)]` code only: clippy's `allow-unwrap-in-tests` does
  not cover a plain helper function in a `tests/` file, so a helper matches and panics
  with a message instead; library code in `myapp-test-support` compares `Result`s with
  `assert_eq!` instead
- No `.only` (Vitest's `allowOnly: false` fails the run) and no `.skip` or `#[ignore]`
  to get a red test out of the way
- TDD: write the failing test first, then the minimum that makes it pass, then refactor
  with the test green (the `tdd` skill)
- NEVER weaken an assertion to make a test pass — fix the code
