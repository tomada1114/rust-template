---
name: designing-ipc
description: >
  Covers the IPC surface between the React UI and Rust end to end: the core function
  and its ts-rs DTO, the thin #[tauri::command] in src-tauri/src/commands.rs,
  tauri::State and AppState, spawn_blocking for a slow port, registering in
  generate_handler! inside with_commands in src-tauri/src/lib.rs, just bindings and
  ui/src/ipc/generated/, the typed wrappers in ui/src/ipc/commands.ts and
  ui/src/ipc/events.ts, a pub const event name and app.emit, tauri::test command tests
  in src-tauri/tests/commands.rs, capabilities when a plugin is added, and spawning the
  myapp-cli sidecar. Use when adding, renaming, or removing a command, an argument, an
  event, or a payload field, when invoke rejects with "command not found", when the
  bindings drift check or the IPC-name harness check fails, or when a JSON key arrives
  in the wrong case.
---

# Designing IPC

**Owns:** adding, changing, or removing a command or an event across every layer it
touches, the shape of what crosses, and which of it is contract. **Does not own:** what
the core function decides and how it is structured (`designing-core-logic`); the error
type a command rejects with (`designing-errors`); the hook and screen that consume it
(`building-react-screens`); where each test goes (`placing-tests`) and how its body is
written (`writing-tests`); adding a plugin crate or npm package (`managing-dependencies`)
and the ADR it owes (`recording-architecture-decisions`).

A command is a Rust function the UI calls with `invoke("name", args)`; an event is a
message Rust pushes and the UI subscribes to with `listen`. `docs/architecture.md` ›
"IPC" is the map of the layers; this skill is the order of work and its traps.

## The shape: every decision in core, every layer thin

The UI asks, the command translates, core decides. A command holds no `if` about the
domain, because the shell is outside the coverage floor: a branch there is a branch no
gate tests (`AGENTS.md` › "Architecture"). How Tauri passes arguments and state is its
documentation (<https://v2.tauri.app/develop/calling-rust/>); what follows is this
repository's shape on top of it.

## Adding a command, in order

Each step names its check. [references/adding-a-command.md](references/adding-a-command.md)
has the code for every step, taken from the sample.

1. **Core function and DTO** in `myapp-core`, test first (`tdd`). Everything the UI
   receives or sends is a type in core deriving `Serialize` (or `Deserialize` for an
   argument), `ts_rs::TS`, `#[serde(rename_all = "camelCase")]`, and `#[ts(export)]`.
   It lives in core so CI's Linux job, which never compiles Tauri, can regenerate every
   binding. Check: `just test-fast <filter>`, then `just test-core`.
2. **Bindings.** `just bindings` regenerates `ui/src/ipc/generated/` (ts-rs writes each
   exported type from a generated test; `.cargo/config.toml` sets the directory and
   exports 64-bit integers as `number`). Commit the output with the Rust change, and
   re-export the new type from `ui/src/ipc/types.ts`, the only way the rest of the UI
   may import it. CI regenerates and fails on any diff; never edit the generated files.
3. **The command** in `src-tauri/src/commands.rs`: borrow the state, call one core
   function (on a blocking thread if it reaches a slow port), emit an event after a
   change, log one line, return `Result<Dto, CoreError>`. See "The command" below.
4. **Register it** in `with_commands` (`src-tauri/src/lib.rs`), the one
   `generate_handler!` list that both `run()` and the command tests use. A command
   missing from it compiles and then rejects at runtime
   (`an_unregistered_command_is_rejected` pins that behaviour).
5. **The wrapper** in `ui/src/ipc/commands.ts`: one exported function per command,
   invoking the Rust function's exact snake_case name, typed with the generated DTO,
   with a TSDoc line saying what it resolves to and which error it rejects with. A
   screen never calls `invoke` itself (ESLint's `no-restricted-imports`). Check:
   `commands.test.ts` asserts the name and the argument object through `mockCommands`.
6. **The command test** in `src-tauri/tests/commands.rs`, through `tauri::test` against
   fakes: the JSON the UI receives (camelCase), each error as `{ code }`, and the event
   it emits. Check: `just test-macos`.
7. **Before the pull request:** `just test-macos`, `just test-ui`, then
   `just check-harness`, which fails when the names in `generate_handler!` and in
   `commands.ts` differ; `just smoke` if startup or `AppState` changed.

## The command

- **Async, with borrowed state, returns `Result`.** A command that needs the app state
  takes `state: State<'_, AppState>`. Tauri runs an `async` command on its async runtime
  and a plain `fn` command on the main thread, and an async command whose argument is
  borrowed, as `State<'_, …>` is, has to return a `Result`: the page's other remedy,
  an owned argument, does not exist for state
  (<https://v2.tauri.app/develop/calling-rust/>, checked 2026-09-29). So anything that touches I/O is `async` and returns `Result`;
  only a command that does no slow work and cannot fail may be a plain `fn`. Writing a
  log line is I/O too: `log_from_ui` takes an owned argument, so it is `async` without
  a `Result` and writes on a blocking thread.
- **A slow port runs on a blocking thread.** Core is synchronous by design (no async to
  learn), so the command moves the call with `tauri::async_runtime::spawn_blocking`.
  The closure must own what it uses (`'static`: it may outlive the borrow of `State`),
  so clone the `Arc` first; cloning an `Arc` copies a pointer, not the service.
  `on_blocking_thread` is the sample's helper, and it maps the join error (a worker
  that panicked, which only a debug or test build reports, or a task cancelled at
  shutdown, in any build) to a core error rather than unwrapping it
  (`designing-errors`).
- **Shared state is `AppState`**, one struct in `commands.rs` holding `Arc`s of core
  services, built once in `build_state` (`lib.rs`) from the real adapters and given to
  Tauri with `app.manage`. A test builds the same struct over fakes. A second service
  is a second field, not a second managed type.
- **Generic over the runtime when it names `AppHandle`.** A command that takes the app
  handle declares `<R: Runtime>` and takes `AppHandle<R>`, so the same handler list
  compiles for the real app and for `tauri::test::MockRuntime`. A bare `AppHandle`
  means the real runtime's handle only, and `with_commands`, which is generic over the
  runtime, stops compiling. In the sample, `increment<R: Runtime>` is the example.
- **Arguments** arrive as a JSON object whose keys are camelCase by default
  (<https://v2.tauri.app/develop/calling-rust/>, checked 2026-09-29): a Rust parameter
  `entry` is `invoke("log_from_ui", { entry })`, and a parameter `max_value` would be
  `{ maxValue }`. An argument's type is a core DTO deriving `Deserialize`, so a bad value
  is rejected by deserialization before the function runs
  (`log_from_ui_rejects_an_unknown_level`). Validate meaning in core, not in the command.
- **Log one line** per call with the command's name and the outcome, and no field that
  could hold user data; for a failure, the error's `Display`, which `designing-errors`
  keeps free of it. In the sample, `log_outcome` logs the new value, a number core
  computed, or the error.

## Events

An event carries a value that changed outside the call that asked for it: another
window's command, or a file watcher an app adds (the sample has none, so a change the
helper CLI makes shows when the window next loads or changes the value).

- **The name is a kebab-case `pub const`** beside the commands that emit it,
  re-exported from `lib.rs` for the tests (in the sample,
  `COUNTER_CHANGED = "counter-changed"`). `ui/src/ipc/events.ts` declares the same
  string and the harness check compares them.
- **The payload is a core DTO**, the same one the command returns where possible, so the
  UI has one type to render. Tauri's `emit` needs it to be `Serialize + Clone`
  (<https://v2.tauri.app/develop/calling-frontend/>, checked 2026-09-29).
- **Emit after the change succeeded, never on a rejection**, and a failed emit logs and
  does not fail the command (`announce`): the caller already has its answer.
- **One typed listener per event** in `events.ts`, returning the `Promise<UnlistenFn>`;
  the hook calls it on unmount, or every remount adds a listener
  (`useCounter.test.tsx` checks it).
- Test both sides: a command test that records the emitted payloads, including one
  asserting a rejection emits nothing, and a UI test that delivers the event with
  `emitEvent` from `ui/src/ipc/testing.ts`. In the sample, `record_events` and
  `increment_at_the_maximum_rejects_with_a_code_and_emits_nothing` in
  `src-tauri/tests/commands.rs`.
- A stream of ordered data (progress, a child process's output) is a Tauri `Channel`
  passed as a command argument, not a burst of events: Tauri documents channels as the
  fast, ordered path (<https://v2.tauri.app/develop/calling-frontend/>, checked
  2026-09-29). The sample has none; the first one is a design note in its pull request.

## Capabilities

App commands registered through `invoke_handler` are allowed for every window without a
capability entry (<https://v2.tauri.app/security/capabilities/>, checked 2026-09-29), so
adding a command never touches `src-tauri/capabilities/`. A Tauri plugin's commands do
need a permission there, and a plugin is a new dependency, an ADR, and a sign-off change
(`AGENTS.md` › "Security and human approval"). `src-tauri/capabilities/default.json`
grants `core:default` only; widen it by the narrowest permission the plugin documents.

## The helper executable

The shell links core and platform itself, so a command calls core directly, never by
running `myapp-cli`. Spawning the bundled helper from the GUI is for work that must be
that separate executable (what a launchd job will run), and it costs `tauri-plugin-shell`
(dependency, ADR, sign-off). Spawned from Rust it needs no capability; exposed to the UI
it needs a shell permission scoped to that one sidecar. `docs/architecture.md` › "The
helper executable" has the mechanics.

## What is contract

Command names, event names, and the JSON of every payload, argument, and error are
contract (`docs/architecture.md` › "What is contract and what is private"): the UI is
built separately from the Rust side, and nothing but the checks below ties them.

- Rename or remove one on both sides in one pull request.
- `rename_all = "camelCase"` derives the wire name from the Rust name, so renaming a
  field or variant in Rust renames it on the wire; keep a stable name with
  `#[serde(rename = "…")]` when only the Rust side should change.
- Adding an optional field to a payload is additive; adding a required argument breaks
  every existing call, so change the wrapper in the same commit.
- What catches a mismatch: `just bindings` (types), the IPC-name harness check (names),
  the command tests (JSON shapes), and `crates/myapp-core/tests/serialization.rs`
  (literal JSON). A user-visible change owes a `CHANGELOG.md` entry.

## Removing a command or an event

Delete it from `commands.rs`, from `with_commands`, from `commands.ts` or `events.ts`,
and its tests, then `just bindings` (a DTO nothing exports any more leaves a stale file:
`just bindings` removes the directory first, so the regenerated tree is exact), then the
checks in step 7. `rg` for the name in `docs/architecture.md`, which lists every command.
