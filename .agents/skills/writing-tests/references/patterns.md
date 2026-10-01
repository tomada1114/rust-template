# Test patterns, with this repository's examples

Each section states the pattern, then shows the sample's version of it. The sample (the
counter) is a deletable illustration: when an app replaces it, the pattern still holds
and its own tests become the examples.

## A core use case over fakes (Rust)

Build the service from fakes, act once, assert the returned value and the state the
fake recorded. Expected values are literals.

In the sample, `crates/myapp-core/tests/counter_service.rs` (shown with
`CounterService::new` inlined; the file builds it through its `service_over` helper):

```rust
const T0: UnixMillis = FixedClock::DEFAULT;
const TUNING: Tuning = match Tuning::new(0, 2) {
    Ok(tuning) => tuning,
    Err(TuningError::MinAboveMax) => panic!("0 to 2 is a valid range"),
};

#[test]
fn increment_at_the_maximum_fails_and_saves_nothing() {
    let stored = StoredCounter { value: 2, last_changed_at: Some(UnixMillis(9)) };
    let store = Arc::new(InMemoryCounterStore::holding(stored.clone()));
    let service = CounterService::new(store.clone(), Arc::new(FixedClock::default()), TUNING);
    assert_eq!(service.increment(), Err(CounterError::AtMaximum));
    assert_eq!(store.saved(), Some(stored)); // nothing changed
}
```

A tiny `Tuning` reaches the bound in one step, and the `const` `match` on
`Tuning::new` turns an invalid range into a compile error rather than a failing test;
`Arc::clone` (here `store.clone()`) keeps a handle so the test can read what the service
saved.

## Moving time without waiting (Rust)

Hold the `FixedClock` in an `Arc`, hand a clone to the code, and move time between
actions. In the sample, `each_change_takes_the_time_the_clock_reads_then`:

```rust
let clock = Arc::new(FixedClock::default());
let service = CounterService::new(Arc::default(), clock.clone(), TUNING);
assert_eq!(service.increment().map(|v| v.last_changed_at), Ok(Some(T0)));
clock.advance(1_000);
assert_eq!(
    service.increment().map(|v| v.last_changed_at),
    Ok(Some(UnixMillis(T0.0 + 1_000)))
);
```

## A table of cases (Rust)

The standard harness has no parameterized tests. Loop over the cases and name each in
the assertion message, so a failure says which case broke. In a unit test beside
`Counter`, where `TUNING` is `Tuning::new(0, 3)`:

```rust
for (value, expected) in [(-5, 0), (2, 2), (40, 3)] {
    assert_eq!(Counter::new(value, TUNING).value(), expected, "Counter::new({value})");
}
```

`src-tauri/tests/commands.rs` does the same with `for level in ["warn", "error"]`.

## A table of cases (TypeScript)

`it.each` with a `%s`, `%j`, or `%p` placeholder in the title, so each case is labelled
in the report. In the repository, `scripts/label-pr.test.ts` gives no label to a list of
titles that are not Conventional Commits:

```ts
it.each(["wip: something", "Add a thing", "feat add", "FEAT: shout", ""])(
  "gives no label to %j",
  (title) => { … },
);
```

## The contract suite (Rust)

One function per port in `crates/myapp-test-support/`, called once per implementation.
The function calls `make` again for each group of clauses, so `make` runs several times
per test: the real adapter's gives each call its own temporary directory, and keeps
every `TempDir` alive until the test ends:

```rust
// crates/myapp-core/tests/contracts.rs — the fake
counter_store_contract(|| Box::new(InMemoryCounterStore::default()));

// crates/myapp-platform/tests/contracts.rs — the real adapter
let mut dirs = Vec::new();
counter_store_contract(|| {
    let dir = tempfile::tempdir().unwrap();
    let store = JsonFileCounterStore::new(dir.path().join("nested").join("counter.json"));
    dirs.push(dir);
    Box::new(store)
});
```

Inside the contract function, compare `Result`s and name the clause:
`assert_eq!(store.load(), Ok(Some(saved.clone())), "load returns what save wrote");`.

## A command through the mock runtime (Rust)

`with_commands(mock_builder())` registers the real handler list;
`.manage(AppState { … })` holds core's service over fakes; `get_ipc_response` sends
what the UI would send.
Assert the JSON, the error code, and the event. In the sample,
`src-tauri/tests/commands.rs`:

```rust
#[test]
fn increment_at_the_maximum_rejects_with_a_code_and_emits_nothing() {
    let (app, window) = app_holding(Some(2));
    let events = record_events(&app);
    assert_eq!(invoke(&window, "increment", json!({})), Err(json!({ "code": "atMaximum" })));
    assert!(events.recv_timeout(Duration::from_millis(200)).is_err(), "no event");
}
```

The helpers there (`app_holding`, `invoke`, `record_events`, `must`) are the model for a
new command's tests. `tauri::test` is marked unstable, so a Tauri minor update may need
edits here ("This module is unstable",
https://docs.rs/tauri/latest/tauri/test/index.html, checked 2026-09-29).

## A hook (TypeScript)

`mockCommands` answers each command by name and returns the list of calls;
`renderHook` mounts the hook; `waitFor` waits for the load; `act` wraps an action. In
the sample, `ui/src/counter/useCounter.test.tsx`:

```ts
it("keeps the view and holds the error code when Rust rejects a change", async () => {
  mockCommands({
    get_counter: () => TWO,
    increment: () => rejectWith({ code: "atMaximum" }),
  });
  const { result } = renderHook(() => useCounter());
  await waitFor(() => {
    expect(result.current.state.status).toBe("ready");
  });
  await act(() => result.current.increment());
  expect(result.current.state).toEqual({ status: "ready", view: TWO, error: { code: "atMaximum" } });
});
```

An event from Rust: `await act(() => emitEvent("counter-changed", TWO));`. That the
hook stops listening on unmount: spy on `eventInternals().unregisterListener`.

## A screen (TypeScript)

Render the component, find controls by role and accessible name, drive them with
`userEvent`, and read the result through roles such as `status` and `alert`. In the
sample, `ui/src/counter/CounterScreen.test.tsx`:

```ts
render(<CounterScreen />);
await userEvent.click(await screen.findByRole("button", { name: "Decrement" }));
expect(await screen.findByRole("alert")).toHaveTextContent("already at its lowest value");
expect(screen.getByRole("status")).toHaveTextContent("0");
```

Keyboard reachability is a test too: `await userEvent.tab()` then `toHaveFocus()`.

## Wording and formatting (TypeScript)

A function that formats for people takes its locale and time zone as arguments, so the
test pins both and compares a literal. In the sample, `ui/src/copy/counter.test.ts`:

```ts
expect(describeLastChanged(1_700_000_000_000, "en-US", "UTC")).toBe(
  "Last changed Nov 14, 2023, 10:13 PM",
);
```

## A binary with a temporary home (Rust)

Run the built executable with `env!("CARGO_BIN_EXE_<name>")`, set `HOME` on the child
process to a `tempfile::tempdir()`, and assert the exit code and output. In the sample,
`crates/myapp/tests/cli.rs`:

```rust
let home = tempfile::tempdir().unwrap();
let output = run(home.path(), &["counter", "show"]);
assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
assert_eq!(stdout(&output), "0\n");
```
