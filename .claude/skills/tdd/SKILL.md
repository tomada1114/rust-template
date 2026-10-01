---
name: tdd
description: >
  Red-green-refactor for this repository: decide where the code lives (myapp-core by
  default), write a failing test first, prove it fails with just test-fast <filter>
  (cargo nextest in myapp-core) or Vitest for a ui/src hook, implement the minimum in
  core, refactor, then re-check the coverage floor with just test-core, and just
  lint. Use PROACTIVELY when implementing a feature, changing
  behavior, fixing a bug (regression test first), adding a function, a type, a state
  transition, a command, or a hook; when asked for TDD or test-first; or when a
  coverage floor fails after a change.
---

# TDD Workflow

**Owns:** the order of work — where a change starts, the red run, the minimum green
change, the refactor with the gates on, and what lands in one commit. **Does not own:**
which file and project a test goes in and which floor measures it (`placing-tests`);
how a test body is written (`writing-tests`); how core logic is shaped
(`designing-core-logic`); the commit itself (`smart-commit`).

Test first is how every change to Rust or TypeScript in this repository is made
(`.claude/rules/testing.md`). Never write the implementation before a failing test
exists: a test written after the code tends to assert what the code does, not what it
should do.

## Step 0: decide where the code lives

- **A decision** — anything that branches, clamps, formats, or remembers — goes in
  `crates/myapp-core`. That is the default, because core's coverage floor is what keeps
  it tested and it builds and tests on Linux with no window. **BACKGROUND:**
  `designing-core-logic`.
- **Rendering and wiring in the UI** go in `ui/src/`, as a hook that mirrors a Rust-owned
  model and a component that renders it. If a hook needs an `if` about the domain,
  that condition belongs in core, returned through the view.
- **Talking to the OS or the file system** is a port in core plus an adapter in
  `crates/myapp-platform`. The red test is a core test against the fake, and the
  contract function in `crates/myapp-test-support`; the adapter only translates.
  Whether the OS really behaves as the adapter assumes is checked afterwards by the
  contract against the real adapter (`just test-macos`), or, for a test marked
  `#[ignore = "local machine: …"]`, by `just test-local` — a human's recipe that needs
  a logged-in Mac. It is evidence for the pull request, never the red test this loop
  starts from.
- **A command or an event** decides nothing; its red test is in
  `src-tauri/tests/commands.rs` (`just test-macos`), after the core function it calls
  has its own.
- About to put a decision in `myapp-platform`, `src-tauri`, `myapp-cli`, or a component?
  Stop and move it to core.

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

A UI change starts the same way, in a `.test.tsx` beside the hook or component it
drives: `mockCommands` stands in for Rust, and the assertion is on the state the hook
exposes or on what the user sees, queried by role and name. In the sample,
`ui/src/counter/useCounter.test.tsx`:

```tsx
it("shows the new view after increment", async () => {
  mockCommands({ get_counter: () => ONE, increment: () => TWO });
  const { result } = renderHook(() => useCounter());
  await waitFor(() => { expect(result.current.state.status).toBe("ready"); });
  await act(() => result.current.increment());
  expect(result.current.state).toEqual({ status: "ready", view: TWO, error: null });
});
```

## Step 2: prove it fails

```bash
just test-fast increment_by              # core: cargo nextest, filtered by test name
pnpm exec vitest run --project ui ui/src/counter/useCounter.test.tsx   # one UI file (the sample's)
```

Read the failure. For a Rust function that does not exist yet, the compile error
naming it counts as red. In Vitest a missing export arrives as `undefined`, so the run
fails with a `TypeError` at the call: that counts only when the message names the
missing function (`… is not a function`). For a change to existing behavior,
the run must show the assertion itself failing — `assert_eq!` prints the `left` and
`right` values, and `expect` its diff — because a test that fails for another reason (a
typo, a missing import) proves nothing about the behavior. **Do not skip this run**: a
test that has never failed may never be able to.

## Step 3: GREEN — the minimum that passes

Write the smallest change in core that makes the test pass, following `writing-rust`
(no `unwrap`, a typed error, `self` in and a new value out). Re-run the same filter,
then a broader one that covers every test the change could touch; in the sample,
`just test-fast counter`. All must pass, the new ones and the old. In the UI the
smallest change is in the hook or component the test drives, and never a domain rule a
hook would need an `if` for (Step 0); re-run the same file.

## Step 4: REFACTOR — with the gates on

Rename, extract, and delete dead code while the tests stay green, then run the gates
the change can fail:

| Changed | Run |
|---|---|
| core | `just test-core` (its floors, doctests, and the other Linux-buildable crates), then `just lint` (clippy, including core's banned calls) |
| `src-tauri/` or `crates/myapp-platform/` | `just test-macos` |
| `crates/myapp-cli/` | `just test-core` (it runs the CLI's tests), then `just test-macos` |
| `crates/myapp-test-support/` | `just test-core` (core runs the contracts against the fakes), then `just test-macos` (platform runs them against the real adapters) |
| `scripts/` | `just test-scripts` (**REQUIRED:** `writing-repo-scripts`) |

Before the pull request, `just check` runs everything a Mac runs without a human. None
of these recipes opens a window or takes focus (`AGENTS.md` › "Never taking over the
developer's Mac").

If a coverage floor fails, write the tests for the code you added. Never lower a floor,
exclude a file from coverage, or move logic out of core to escape the floor: each is
weakening a gate (`AGENTS.md` › "Security and human approval").

## Fixing a bug

The regression test comes first and reproduces the bug through the same interface a
user or caller hit: it fails for the reason the report describes, then passes with the
fix. A bug that only the running app shows (a button wired to the wrong command) has
no automated seam here; ask the human to reproduce it in the running app, then write
the tests for each side the fix touches.

## Step 5: commit

The test and its implementation land in the same commit (**REQUIRED:** `smart-commit`).
A red test is never committed alone, and a regenerated `ui/src/ipc/generated/` goes in
the commit with the Rust type that produced it.

## Anti-patterns

- Implementation first, tests "later".
- Weakening an assertion to make a test pass, or deleting it; fix the code.
- `#[ignore]`, `.skip`, or `.todo` to get a red test out of the way.
- Testing an implementation detail (a private helper's call count) instead of the
  behavior and the contract.
- Waiting on real time (`std::thread::sleep`, `setTimeout`) instead of an injected clock
  or an awaited promise.
- Skipping Step 2 because the failure "is obvious".
