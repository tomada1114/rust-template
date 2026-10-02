# Test patterns, with this repository's examples

Each section states the pattern, then shows the sample's version of it. The sample (the
counter) is a deletable illustration: when an app replaces it, the pattern still holds
and its own tests become the examples.

## A core use case over fakes

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

## Moving time without waiting

Hold the `FixedClock` in an `Arc`, hand a clone to the code, and move time between
actions. In the sample, `each_change_takes_the_time_the_clock_reads_then`:

```rust
let clock = Arc::new(FixedClock::default());
let store = Arc::new(InMemoryCounterStore::default());
let service = CounterService::new(store, clock.clone(), TUNING);
assert_eq!(service.increment().map(|v| v.last_changed_at), Ok(Some(T0)));
clock.advance(1_000);
assert_eq!(
    service.increment().map(|v| v.last_changed_at),
    Ok(Some(UnixMillis(T0.0 + 1_000)))
);
```

## A table of cases

The standard harness has no parameterized tests. Loop over the cases and name each in
the assertion message, so a failure says which case broke. In a unit test beside
`Counter`, where `TUNING` is `Tuning::new(0, 3)`:

```rust
for (value, expected) in [(-5, 0), (2, 2), (40, 3)] {
    assert_eq!(Counter::new(value, TUNING).value(), expected, "Counter::new({value})");
}
```

`each_bound_key_maps_to_its_action` in `crates/myapp-core/src/counter/screen.rs` does
the same over `(ScreenKey, ScreenAction)` pairs.

## The contract suite

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

## A screen driven by keys as values

Fold the keys through the same path the binary's loop takes, with no terminal, and
compare what the screen shows as one value. In the sample,
`crates/myapp-core/tests/counter_screen.rs`:

```rust
fn after_keys(service: &CounterService, keys: &[ScreenKey]) -> CounterScreen {
    keys.iter()
        .filter_map(|key| ScreenAction::for_key(*key))
        .fold(CounterScreen::load(service), |screen, action| screen.update(action, service))
}

#[test]
fn a_sequence_of_keys_drives_the_counter_and_ignores_unbound_keys() {
    let service = service_holding(0);
    let screen = after_keys(&service, &[ScreenKey::Char('+'), ScreenKey::Up,
        ScreenKey::Char('x'), ScreenKey::Down, ScreenKey::Char('+')]);
    assert_eq!(shown(&screen), (Some(changed_to(2, 4)), None, false));
}
```

`shown` returns `(view, error, finished)`, so one `assert_eq!` covers all three.

## A terminal key event becoming core's key

Build the crossterm event as a value and assert the translation; cover a press, a
release and a repeat, a modifier chord, and a key the screen has no name for. In the
sample, `crates/myapp/src/tui/mod.rs`:

```rust
fn press(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
    KeyEvent::new_with_kind(code, modifiers, KeyEventKind::Press)
}

assert_eq!(
    screen_key(press(KeyCode::Char('c'), KeyModifiers::CONTROL)),
    Some(ScreenKey::Interrupt)
);
```

## A view drawn into `TestBackend`

Draw one state into an in-memory terminal of a fixed size and compare every cell. Use
`assert_buffer_lines` when no cell carries a style; build the expected `Buffer` and use
`assert_buffer` when one does, since that comparison includes styles. In the sample,
`crates/myapp/src/tui/view.rs`:

```rust
fn drawn(screen: &CounterScreen, width: u16, height: u16) -> Terminal<TestBackend> {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|frame| draw(frame, screen)).unwrap();
    terminal
}

let mut expected = Buffer::with_lines([
    "┌Counter───────────────────────────────────────────────────────┐",
    "│Value: 99                                                     │",
    "│Error: the counter is already at its maximum                  │",
    "│                                                              │",
    "│+/Up increment  -/Down decrement  r reset  q/Esc/Ctrl+C quit  │",
    "└──────────────────────────────────────────────────────────────┘",
]);
bold(&mut expected, 2, "Error: the counter is already at its maximum");
drawn(&screen, 64, 6).backend().assert_buffer(&expected);
```

`bold` sets `ERROR_STYLE` on the run of cells the error occupies. A second test at a
size smaller than the layout proves the view clips instead of panicking.

## A binary with a temporary home

Run the built executable with `env!("CARGO_BIN_EXE_<name>")`, set `HOME` on the child
process to a `tempfile::tempdir()` and remove the `XDG_*` variables, then assert the
exit code, stdout exactly, and the last stderr line. In the sample,
`crates/myapp/tests/cli.rs`:

```rust
let home = tempfile::tempdir().unwrap();
write_counter_file(home.path(), &saved_value(99)).unwrap();
assert_runtime_error(
    &run(home.path(), &["counter", "increment"]),
    "the counter is already at its maximum",
);
assert_eq!(stdout(&run(home.path(), &["counter", "show"])), "99\n");
```

`assert_runtime_error` checks exit 1, an empty stdout, and `error: <wording>` as the last
stderr line. A failure the user cannot cause through arguments is set up on disk (a
corrupt file, a file where a directory should be) or on the child's streams (a pipe
whose read end is already closed, for an unwritable stdout).

## Wording, one test per variant

Each variant's sentence is asserted literally, in the module that owns it, so a reworded
sentence is a visible, reviewed change. In the sample, `crates/myapp/src/wording.rs`:

```rust
#[test]
fn at_maximum_says_the_counter_cannot_go_higher() {
    assert_eq!(
        counter_error(CounterError::AtMaximum),
        "the counter is already at its maximum"
    );
}
```
