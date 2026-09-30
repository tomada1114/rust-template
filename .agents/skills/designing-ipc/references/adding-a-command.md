# Adding a command: the code at each step

Each step of `SKILL.md` › "Adding a command, in order", shown with the sample's own code
(the counter and `log_from_ui`), trimmed to what the step is about. The sample is a
deletable illustration: the rule is in the sentence above each block, and the block is
only the example. Read the full files for the parts elided with `…`.

## 1. Core: the use case and the DTO

The use case is a method on a core service that returns the DTO or a core error. It
decides everything: bounds, defaults, what to save.

In the sample, `crates/myapp-core/src/counter/mod.rs`:

```rust
/// What the UI renders. The only counter type that crosses IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "export-bindings", ts(export))]
pub struct CounterView {
    pub value: i64,
    pub last_changed_at: Option<UnixMillis>,
}

impl CounterService {
    pub fn increment(&self) -> Result<CounterView, CounterError> {
        self.change(Counter::increment)
    }
}
```

An argument the UI sends is a DTO deriving `Deserialize` instead. In the sample,
`crates/myapp-core/src/log.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "export-bindings", ts(export))]
pub struct UiLogEntry {
    pub level: UiLogLevel,
    pub message: String,
}
```

Re-export the type from `crates/myapp-core/src/lib.rs`; the shell imports it from
`myapp_core`. Pin its JSON with literal values in
`crates/myapp-core/tests/serialization.rs`: serde's derive is what is under test there,
so the expected JSON is written out by hand, not produced by serializing a value.

## 2. Bindings

```bash
just bindings
```

The recipe runs core's `export_bindings` tests with the `export-bindings` feature, which
compiles the test ts-rs generates for each type marked `ts(export)`
(<https://docs.rs/ts-rs/latest/ts_rs/>, checked 2026-09-29), into a fresh directory, and
replaces `ui/src/ipc/generated/` with it only when the export succeeds. Then add the new type to
`ui/src/ipc/types.ts`:

```ts
export type { CounterView } from "./generated/CounterView";
```

Commit the generated file in the same commit as the Rust type that produced it
(`AGENTS.md` › "Review Checklist").

## 3. The command

A command borrows `AppState`, runs the core call on a blocking thread, emits after a
successful change, and logs one line. In the sample, `src-tauri/src/commands.rs`:

```rust
async fn on_blocking_thread(
    state: &State<'_, AppState>,
    action: fn(&CounterService) -> Result<CounterView, CounterError>,
) -> Result<CounterView, CounterError> {
    let service = Arc::clone(&state.counter);
    tauri::async_runtime::spawn_blocking(move || action(&service))
        .await
        .map_err(|_| CounterError::Storage { kind: StorageErrorKind::Unavailable })?
}

#[tauri::command]
pub async fn increment<R: Runtime>(
    state: State<'_, AppState>,
    app: AppHandle<R>,
) -> Result<CounterView, CounterError> {
    change("increment", &state, &app, CounterService::increment).await
}
```

`change` calls `on_blocking_thread`, logs the outcome, and on success calls
`announce`, which emits `COUNTER_CHANGED`. A read-only command skips the emit
(`get_counter`). A command whose use case takes an argument passes it into the closure
by value, since the closure must own everything it touches.

A command that takes an argument names it as the UI will (camelCase on the wire):

```rust
#[tauri::command]
pub async fn log_from_ui(entry: UiLogEntry) { … }
```

A new service goes into `AppState` as another `Arc` field, constructed in `build_state`
(`src-tauri/src/lib.rs`) from the real adapters. That function is the composition root:
the only place an adapter is built and handed to core.

## 4. Registration

```rust
pub fn with_commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        commands::get_counter,
        commands::increment,
        // … one line per command
        commands::log_from_ui,
    ])
}
```

`run()` and the command tests both start from `with_commands`, so a test exercises the
list the app ships. `generate_handler!` takes the whole list at once: only the last
`invoke_handler` call is used (<https://v2.tauri.app/develop/calling-rust/>, checked
2026-09-29), so a second call would silently unregister every command in the first.

## 5. The wrapper

One exported function per command in `ui/src/ipc/commands.ts`, typed with the generated
DTO, named in camelCase for TypeScript but invoking the Rust name exactly:

```ts
/** Add one. Rejects with a `CounterError` (`atMaximum` at the bound). */
export const increment = (): Promise<CounterView> => invoke<CounterView>("increment");

/** Write a UI warning or error to the app's log file. */
export const logFromUi = (entry: UiLogEntry): Promise<void> =>
  invoke<undefined>("log_from_ui", { entry });
```

Its test in `ui/src/ipc/commands.test.ts` checks the name and the argument object the
wrapper sends:

```ts
const received: unknown[] = [];
mockCommands({ log_from_ui: (args) => { received.push(args); return null; } });
await logFromUi({ level: "warn", message: "careful" });
expect(received).toEqual([{ entry: { level: "warn", message: "careful" } }]);
```

An event gets the same treatment in `ui/src/ipc/events.ts`: a `const` equal to the Rust
`pub const`, and one function wrapping `listen` that hands the handler the typed payload
and returns the unlisten promise.

## 6. The command test

`src-tauri/tests/commands.rs` builds the app on Tauri's mock runtime with the real
handler list and fakes for the ports, then invokes by name and compares JSON. `tauri::test`
is behind the crate's `test` feature and marked unstable
(<https://docs.rs/tauri/latest/tauri/test/index.html>, checked 2026-09-29), so a Tauri
minor bump may need edits here; `src-tauri/Cargo.toml` enables the feature for
dev-dependencies only.

In the sample, the helpers `app_holding`, `invoke`, and `record_events` do the setup,
and each test states one behaviour:

```rust
#[test]
fn increment_at_the_maximum_rejects_with_a_code_and_emits_nothing() {
    let (app, window) = app_holding(Some(2));
    let events = record_events(&app);
    assert_eq!(
        invoke(&window, "increment", json!({})),
        Err(json!({ "code": "atMaximum" }))
    );
    assert!(events.recv_timeout(Duration::from_millis(200)).is_err());
}
```

What belongs here: argument decoding, the JSON shape and its case, each error code, and
the event. What does not: the rule behind the answer, which core's tests already hold
with a `FixedClock` and an `InMemoryCounterStore`.

## 7. The checks

```bash
just test-macos      # the command tests (tauri::test) and the platform adapters
just test-ui         # the wrapper, the hook, and the screen against mockIPC
just check-harness   # the command and event names agree across Rust and ui/src/ipc/
just smoke           # when startup, AppState, or build_state changed
```

`just check` runs all of them before the pull request. None opens a window.
