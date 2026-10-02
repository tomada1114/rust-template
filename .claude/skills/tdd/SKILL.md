---
name: tdd
description: >
  Red-green-refactor for this repository: decide where the code lives (myapp-core by
  default, then the subcommand or the TUI layer in crates/myapp), write a failing test
  first, prove it fails with just test-fast <filter> (cargo nextest in myapp-core),
  implement the minimum in core, refactor, then re-check the coverage floor with just
  test-core, the binary and adapters with just test-platform, and just lint. Use
  PROACTIVELY when implementing a feature, changing behavior, fixing a bug (regression
  test first), adding a function, a type, a state transition, a subcommand, a flag, a
  key binding, or a screen; when asked for TDD or test-first; or when a coverage floor
  fails after a change.
---

# TDD Workflow

**Owns:** the order of work — where a change starts, the red run, the minimum green
change, the refactor with the gates on, and what lands in one commit. **Does not own:**
which file a test goes in and which floor measures it (`placing-tests`);
how a test body is written (`writing-tests`); how core logic is shaped
(`designing-core-logic`); the commit itself (`smart-commit`).

Test first is how every change to Rust in this repository is made
(`.claude/rules/testing.md`). Never write the implementation before a failing test
exists: a test written after the code tends to assert what the code does, not what it
should do.

## Step 0: decide where the code lives

- **A decision** — anything that branches, clamps, formats, or remembers — goes in
  `crates/myapp-core`. That is the default, because core's coverage floor is what keeps
  it tested and it builds and tests on Linux with no terminal. This includes what a
  screen does with a key: a TUI's state and its `update` are core's.
  **BACKGROUND:** `designing-core-logic`.
- **A subcommand or a flag** is a thin arm in `crates/myapp/src/main.rs` over a core
  method; its red test is in `crates/myapp/tests/cli.rs`, after the core method has its
  own (`designing-clis`).
- **What a screen looks like, or how a terminal key is read**, is the binary's
  `crates/myapp/src/tui/`; its red test is a `TestBackend` test in `view.rs` or a key
  translation test in `mod.rs`, after the core screen has its own (`building-tuis`).
- **Talking to the OS or the file system** is a port in core plus an adapter in
  `crates/myapp-platform`. The red test is a core test against the fake, and the
  contract function in `crates/myapp-test-support`; the adapter only translates.
  Whether the OS really behaves as the adapter assumes is checked afterwards by the
  contract against the real adapter (`just test-platform`), or, for a test marked
  `#[ignore = "local machine: …"]`, by `just test-local` — a human's recipe. It is
  evidence for the pull request, never the red test this loop starts from.
- About to put a decision in `myapp-platform`, a subcommand's arm, the TUI loop, or a
  `draw` function? Stop and move it to core.

## Step 1: RED — write the failing test

Write the test for the behavior, not for the implementation you have in mind: its
name says what the user or the caller observes, and its expected value is written out
by hand. **REQUIRED:** `writing-tests` for the body; `placing-tests` for the file.

Cover the edge cases from the start: at each bound, one step inside, one step outside;
the operation repeated at a bound; the state after an error (nothing changed); both
sides of every conditional.

In the sample, a new counter rule starts as a unit test beside `Counter` in
`crates/myapp-core/src/counter/mod.rs`, and a new use case as a test of
`CounterService` over the fakes in `crates/myapp-core/tests/counter_service.rs`:

```rust
#[test]
fn increment_by_stops_with_an_error_past_the_maximum() {
    assert_eq!(Counter::new(2, TUNING).increment_by(5), Err(CounterError::AtMaximum));
}
```

The layers above core start the same way, each with its own red test once core's is
green. In the sample, a `myapp counter decrement` subcommand would start in `cli.rs`:

```rust
#[test]
fn decrement_at_the_minimum_fails_and_changes_nothing() {
    let home = tempfile::tempdir().unwrap();
    assert_runtime_error(
        &run(home.path(), &["counter", "decrement"]),
        "the counter is already at its minimum",
    );
}
```

and a new key or screen state as a `TestBackend` test in `crates/myapp/src/tui/view.rs`
with the expected lines written out.

## Step 2: prove it fails

```bash
just test-fast increment_by              # core: cargo nextest, filtered by test name
```

For a test in `crates/myapp`, the narrowest recipe is `just test-platform`. Read the
failure. For a Rust function that does not exist yet, the compile error naming it
counts as red. For a change to existing behavior, the run must show the assertion
itself failing — `assert_eq!` prints the `left` and `right` values; a clap usage error
(exit 2) where a new subcommand should run is the binary's version of that — because a
test that fails for another reason (a typo, a missing import) proves nothing about the
behavior. **Do not skip this run**: a test that has never failed may never be able to.

## Step 3: GREEN — the minimum that passes

Write the smallest change in core that makes the test pass, following `writing-rust`
(no `unwrap`, a typed error, `self` in and a new value out). Re-run the same filter,
then a broader one that covers every test the change could touch; in the sample,
`just test-fast counter`. All must pass, the new ones and the old. In the binary the
smallest change is the arm, the wording, or the drawing the test drives, and never a
domain rule (Step 0).

## Step 4: REFACTOR — with the gates on

Rename, extract, and delete dead code while the tests stay green, then run the gates
the change can fail:

| Changed | Run |
|---|---|
| core | `just test-core` (its floors, doctests, and the other crates' tests), then `just lint` (clippy, including core's banned calls) |
| `crates/myapp-platform/` | `just test-platform` |
| `crates/myapp/` (a subcommand, the wording, the TUI) | `just test-platform`, then `just lint` |
| `crates/myapp-test-support/` | `just test-core` (core runs the contracts against the fakes), then `just test-platform` (platform runs them against the real adapters) |
| `xtask/` | `just test-xtask` (**REQUIRED:** `writing-repo-scripts`) |
| A skill's `scripts/` | `just test-scripts` (**REQUIRED:** `writing-repo-scripts`) |

Before the pull request, `just check` runs everything a machine runs without a human.
None of these recipes opens a window, takes focus, or takes over a terminal
(`AGENTS.md` › "Never taking over the developer's Mac").

If a coverage floor fails, write the tests for the code you added. Never lower a floor,
exclude a file from coverage, or move logic out of core to escape the floor: each is
weakening a gate (`AGENTS.md` › "Security and human approval").

## Fixing a bug

The regression test comes first and reproduces the bug through the same interface a
user or caller hit — usually the built binary in `cli.rs`, or the screen's `update` —
so it fails for the reason the report describes, then passes with the fix. A bug that
only a real terminal shows (the screen not restored after a crash, a resize drawing
wrong) has no automated seam here; ask the human to reproduce it with `myapp tui`
(`running-the-app`), then write the tests for each side the fix touches.

## Step 5: commit

The test and its implementation land in the same commit (**REQUIRED:** `smart-commit`).
A red test is never committed alone.

## Anti-patterns

- Implementation first, tests "later".
- Weakening an assertion to make a test pass, or deleting it; fix the code.
- `#[ignore]` to get a red test out of the way.
- Testing an implementation detail (a private helper's call count) instead of the
  behavior and the contract.
- Waiting on real time (`std::thread::sleep`) instead of an injected clock.
- Running `myapp tui` to see whether a change works, instead of a `TestBackend` test.
- Skipping Step 2 because the failure "is obvious".
