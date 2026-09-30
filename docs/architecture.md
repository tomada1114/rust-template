# Architecture

This page describes the layers every app cut from this template starts with, how they
talk, and what is contract. What an app decides on top of them — its design system,
where it keeps state, its dependencies, the App Sandbox, the permissions it asks for —
is recorded as ADRs under [`docs/architecture/`](architecture/README.md), whose
`README.md` is the index. The template's own reasoning is the README's
[Design Philosophy](../README.md#design-philosophy).

## Layers

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ui/  React + Vite + TypeScript. Only ui/src/ipc/ imports @tauri-apps/api.    │
└──────────────────────────────────────────────────────────────────────────────┘
      │ invoke("command")                          ▲ listen("event")
      ▼                                            │
┌──────────────────────────────────────────────────────────────────────────────┐
│ src-tauri/  crate `myapp` (lib `myapp_lib`): the Tauri shell and the         │
│ composition root. Commands and events translate; they decide nothing.        │
└──────────────────────────────────────────────────────────────────────────────┘
      │ constructs the adapters, hands them to core
      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ crates/myapp-platform  adapters: the real OS and filesystem, behind ports    │
│ crates/myapp-cli       the bundled helper (a sidecar), over platform + core  │
└──────────────────────────────────────────────────────────────────────────────┘
      │ implement core's ports; call core's use cases
      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ crates/myapp-core  rules, state, ports (traits), and the IPC types.          │
│ No tauri, no OS API, no direct I/O. Builds and tests on Linux.               │
│ Coverage floor: 80% of lines, 80% of functions.                              │
└──────────────────────────────────────────────────────────────────────────────┘
  crates/myapp-test-support  fakes and one contract function per port
                             (a [dev-dependencies] entry only; never ships)
```

Dependencies point one way, toward core: `myapp-platform` → core; `myapp-cli` →
platform and core; `myapp` (the shell) → platform and core. Core depends on none of
them, and platform does not know the shell exists.

### How the boundaries are enforced

| Layer | What fails |
|---|---|
| Compile time | `crates/myapp-core/Cargo.toml` names no Tauri, OS, or platform crate, so code in core cannot call one. |
| Dependency closure | A harness check (`just check-harness`) reads `cargo metadata` and fails if core's normal dependency closure contains `tauri*`, `wry`, `tao`, `objc2*`, `core-foundation*`, `security-framework*`, or `myapp-platform`, or if a non-dev edge points at `myapp-test-support`. `deny.toml`'s `[bans]` adds direct-edge rules: `tauri` may be a direct dependency of `myapp` only, and `myapp-platform` of `myapp` and `myapp-cli` only. |
| clippy in core | `crates/myapp-core/clippy.toml` bans `println!`/`eprintln!`/`dbg!`, `std::process::Command`, `std::fs::File` and the `std::fs` read and write functions, `SystemTime::now`, `Instant::now`, `std::env::var`, and `thread::sleep`. `clippy::wildcard_enum_match_arm` is denied, so every `match` on a core enum names each variant. |
| ESLint | `no-restricted-imports` and, for a dynamic `import()`, `no-restricted-syntax` forbid `@tauri-apps/*` outside `ui/src/ipc/`, `ui/src/ipc/generated/` outside `ui/src/ipc/`, and `ui/src/ipc/testing.ts` outside tests; `no-console` and `no-restricted-properties` forbid `console` outside `ui/src/ipc/log.ts` and `scripts/`. |

The forbidden-crate lists in `AGENTS.md`, the closure check, and `deny.toml` are kept
equal by a harness check.

## Ports and adapters

Anything outside the process — the filesystem, the clock, and later the OS APIs an app
needs — reaches core through a port. It is always the same four pieces, and the sample
has two worked examples:

| Piece | Where | `CounterStore` | `Clock` |
|---|---|---|---|
| The port: a `Send + Sync` trait over types core owns | `crates/myapp-core` | `counter::store::CounterStore` | `time::Clock` |
| The adapter: translates OS results into core's types and OS failures into core's error kinds, and decides nothing | `crates/myapp-platform` | `JsonFileCounterStore` | `SystemClock` |
| The fake: a real implementation answering from memory | `crates/myapp-test-support` | `InMemoryCounterStore`, `FailingCounterStore` | `FixedClock` |
| The contract: the behaviour every implementation must have | `crates/myapp-test-support` | `counter_store_contract` | `clock_contract` |

`crates/myapp-core/tests/contracts.rs` runs each contract against the fake, on Linux,
inside the coverage floor. `crates/myapp-platform/tests/contracts.rs` runs the same
function against the real adapter, on the macOS CI runner when it needs only a
filesystem (each test gets its own temporary directory). An adapter test that needs a
logged-in GUI session, a TCC grant, or the Keychain is marked
`#[ignore = "local machine: <what it needs>"]` and runs only in `just test-local`, which
a human starts; the sample has none. Core's integration tests live in
`crates/myapp-core/tests/`, never in its inline `#[cfg(test)]` modules, because there
test-support's types would come from a second copy of core.

Ports are **synchronous**. Core is plain functions and state, so nothing in it is
`async`. The shell runs a slow port call on a blocking thread
(`tauri::async_runtime::spawn_blocking` in `src-tauri/src/commands.rs`). A port that is
inherently a stream is modelled as a callback or a channel the shell drives, never as
async trait methods.

Errors are one `thiserror` enum per port or per core module, carrying typed codes and no
user data: `CounterError` serializes as `{ "code": "atMaximum" }`, `{ "code":
"atMinimum" }`, or `{ "code": "storage", "kind": "unavailable" | "corrupt" }`, and the UI
maps each code to wording in `ui/src/copy/`. Rust never produces a user-facing sentence.

`src-tauri/src/lib.rs` is the composition root: the only place that constructs an
adapter and hands it to core (`CounterService::new(store, clock, Tuning::default())`).
`myapp-cli`'s `main.rs` is the helper's own composition root over the same adapters.

The platform crate, the shell, and the CLI are outside the coverage floor. That is a
constraint, not a licence: they translate, so they have no branch worth a numeric gate.
The moment one needs a decision, the decision moves into core behind the port.

## IPC

| Rust | TypeScript |
|---|---|
| `#[tauri::command]` functions in `src-tauri/src/commands.rs`, registered once in `with_commands` (`src-tauri/src/lib.rs`), which the app and the command tests share | one wrapper per command in `ui/src/ipc/commands.ts` |
| one `pub const` per event name (`COUNTER_CHANGED`), emitted with `app.emit` | one typed `listen` per event in `ui/src/ipc/events.ts` |
| every DTO lives in core and derives `ts_rs::TS` with `#[ts(export)]` | `ui/src/ipc/generated/`, committed, never hand-edited; the rest of the UI imports from `ui/src/ipc/types.ts` |

`just bindings` regenerates `ui/src/ipc/generated/` (`.cargo/config.toml` sets the
export directory and exports 64-bit integers as `number`); CI regenerates and fails on a
diff. A harness check compares the names in `generate_handler!` with those
`commands.ts` invokes, and the event constants with those `events.ts` listens to.

A command decides nothing: it moves the work to a blocking thread, calls core, emits
`counter-changed` after a change, and logs one line. The shell watches nothing in the
sample; a change made by the helper CLI reaches an open window when the window next
loads or changes the counter (every command reads the file before it decides). An app
that needs to reflect outside changes live adds a file watcher in `myapp-platform`,
behind a port whose callback the shell turns into the same event.

### Security settings

- `app.security.csp` in `src-tauri/tauri.conf.json`: `default-src 'self'`, IPC only
  through `ipc:` and `http://ipc.localhost`, no remote origin.
- `withGlobalTauri: false`: the UI reaches Tauri only through the imports in
  `ui/src/ipc/`.
- One capability, `src-tauri/capabilities/default.json`, granting `core:default` to the
  main window. App commands need no capability entry; a plugin's commands do
  (<https://v2.tauri.app/security/capabilities/>, checked 2026-09-28), and adding a
  plugin is an ADR.
- The isolation pattern is not enabled: it guards the IPC against third-party frontend
  code, and the app loads none — every script is bundled from `ui/`. An app that starts
  loading remote or third-party code revisits this in an ADR. Tauri's security model:
  <https://v2.tauri.app/security/> (checked 2026-09-28).

## The helper executable

`crates/myapp-cli` builds `myapp-cli`, which `scripts/build-sidecar.ts` (`just sidecar`)
copies to `src-tauri/binaries/myapp-cli-<target triple>` (gitignored). `tauri.conf.json`
lists it in `bundle.externalBin` and runs the build in `beforeDevCommand` and
`beforeBuildCommand`, so every build ships a fresh helper at
`MyApp.app/Contents/MacOS/myapp-cli`. Every recipe that compiles the Tauri crate depends
on `just sidecar`, because `tauri-build` fails when an `externalBin` file is missing.

The GUI does not run the helper in the sample, so no shell plugin and no shell
permission ship. An app whose GUI must run it adds `tauri-plugin-shell` (a new
dependency: an ADR and a maintainer's sign-off), registers it with
`.plugin(tauri_plugin_shell::init())`, and spawns it from Rust with
`app.shell().sidecar("myapp-cli")` (`tauri_plugin_shell::ShellExt`). Run from Rust
only, it needs no capability entry; run from the UI, it needs a `shell:allow-execute` or
`shell:allow-spawn` permission scoped to that one sidecar. Source:
<https://v2.tauri.app/develop/sidecar/> (checked 2026-09-28).

## Logging

Every crate logs through the `tracing` macros; only the shell and the CLI install a
subscriber (`myapp_platform::init_logging`). Files go to
`~/Library/Logs/com.example.myapp/`, one per day, and the newest 14 are kept. The writer
is synchronous: the volume is low, and Tauri exits through `process::exit`, which would
drop a background writer's last lines. A debug build also writes to stderr. The UI sends
its warnings and errors to the `log_from_ui` command through `ui/src/ipc/log.ts`. No log
line carries user data. `just logs` prints the newest file's last lines and exits.

## Smoke mode

With `MYAPP_SMOKE=1` (exactly `1`: `0` or an empty value starts the app normally), the
shell runs the normal startup path with no window, no Dock icon, and no focus change,
logs `startup complete`, and exits 0. `run()` in `src-tauri/src/lib.rs` works in two
phases:

- **Before the event loop** (`prepare`): find `HOME`, start logging, compose the state
  and commands (`compose`: the JSON store under `HOME`, the system clock, every command),
  build the app, and set the activation policy on the built `App` — `Prohibited` in
  smoke mode — between `build` and `run`. tao applies it when the app finishes
  launching, before it would activate as a regular app, so the process registers as
  background-only (`lsappinfo` reports `type="BackgroundOnly"`), which has no Dock
  tile.
- **In setup** (`finish_startup`, once the configured windows exist): require the
  `main` window, show it unless in smoke mode (it is created with `visible: false`),
  and log `startup complete`.

Any startup error — no `HOME`, logging, the build, a missing or unshowable main window —
is logged, printed to stderr, and exits 1; none reaches Tauri's setup panic, which the
release profile's `panic = "abort"` would turn into a crash. `just smoke` checks both
sides: with `HOME` unset the executable must exit 1 with `HOME is not set`, and with it
set it must exit 0 and log its `startup complete` line. The flag changes visibility and
lifetime only, never behaviour: `startup_plan` and `smoke_requested`
(`src-tauri/src/startup.rs`) are unit-tested, and `src-tauri/tests/startup.rs` runs
`compose` and `finish_startup` under both plans on Tauri's mock runtime and compares
the state and commands they leave. `just smoke` runs the built executable directly,
never through `open`, which would activate the app.

## Where new code goes

| You are adding… | It goes in… | Tested by… |
|---|---|---|
| A rule, a state change, a DTO the UI renders | `crates/myapp-core` | unit tests and `crates/myapp-core/tests/` (coverage-gated, Linux) |
| Access to the OS or the filesystem | an adapter in `crates/myapp-platform`, behind a port in core, with a fake and a contract function in `crates/myapp-test-support` | the contract against the fake (core) and against the adapter (`just test-macos`, or `just test-local` when a human is needed) |
| A command or an event | `src-tauri/src/commands.rs`, `with_commands`, and `ui/src/ipc/` | `src-tauri/tests/commands.rs` through `tauri::test` (`just test-macos`) and `ui/src/ipc/*.test.ts` |
| A screen, a component, wording | `ui/src/`, built from `ui/src/design/`, wording in `ui/src/copy/` | Vitest and Testing Library, querying by role and accessible name |
| A helper subcommand | `crates/myapp-cli` | `crates/myapp-cli/tests/` and the launch smoke |
| Startup, windows, wiring | `src-tauri/src/lib.rs` (`compose`, `finish_startup`) | `src-tauri/tests/startup.rs` (`just test-macos`) and the launch smoke (`just smoke`) |

## What is contract and what is private

Nothing here is published as a library, so the contract is what something outside a
change can observe: another crate, the UI, a user's Mac that ran an earlier build, a
launchd job, or the user. These are contract; everything else is private.

| Contract | What depends on it | What changing it requires |
|---|---|---|
| **Core's public API** — every `pub` item re-exported from `crates/myapp-core/src/lib.rs` (`Counter`, `CounterService`, `CounterView`, `CounterError`, `CounterStore`, `StoredCounter`, `StorageError`, `StorageErrorKind`, `Tuning`, `TuningError`, `Clock`, `UnixMillis`, `UiLogEntry`, `UiLogLevel`) | `myapp-platform`, `myapp-test-support`, `myapp-cli`, the shell, and their tests | Update every caller in the same pull request; the compiler finds them. A new port is an ADR. |
| **The bundle identifier** — `com.example.myapp`: `identifier` in `src-tauri/tauri.conf.json`, `BUNDLE_IDENTIFIER` in `crates/myapp-platform/src/paths.rs`, `bundle_id` in the justfile, and `scripts/smoke.ts` | Everything macOS keys by it on a user's Mac: the data directory `~/Library/Application Support/com.example.myapp/`, the log directory `~/Library/Logs/com.example.myapp/`, and privacy (TCC) grants | Fixed once a build has left your machine: a new identifier is a new app to macOS, and the user's data and grants stay behind under the old one. Changing it is a human's decision, recorded as an ADR; the bootstrap sets it once. |
| **IPC command and event names, and their payloads** — commands `get_counter`, `increment`, `decrement`, `reset`, `log_from_ui`; event `counter-changed`; the JSON shapes of `CounterView` (`{ value, lastChangedAt }`), `CounterError`'s codes, and `UiLogEntry` (`{ level: "warn" \| "error", message }`) | The UI, which is built separately from the Rust side | Change both sides in one pull request; `just bindings`, the harness check, and the command tests catch a mismatch. |
| **On-disk file formats** — see below | Files already on a user's disk; `just logs`, `just smoke`, and anyone reading the logs | A new version still reads the old format: a format version and a migration, with a test that reads a sample of the previous format. |
| **The helper's command line** — `myapp-cli counter show`, `myapp-cli counter increment`, `--help`, `--version`, and the exit codes (0 success, 1 the action failed, 2 a usage error) | A launchd job or script that runs the bundled helper | Keep the old form working, or treat the change as breaking and say so in `CHANGELOG.md`. |

### On-disk file formats

**`counter.json`**, in `~/Library/Application Support/com.example.myapp/`, shared by the
app and the helper:

```json
{
  "version": 1,
  "counter": {
    "value": 3,
    "lastChangedAt": 1759017600000
  }
}
```

`lastChangedAt` is milliseconds since the Unix epoch, or `null` before the first change.
A save writes a temporary file named for its process and that save
(`counter.json.<pid>-<n>-<random>.tmp`) in the same directory, syncs it, renames it over
the old file, and syncs the directory, so a crash or a concurrent save leaves the old
file or the new one, never half of each. Every save holds an advisory lock
(`std::fs::File::lock`) on `counter.json.lock` beside it, which is created once, stays
empty, and is never removed; a change (`CounterStore::update`) holds it from the load
to the save, so when the app and the helper change the counter at once, neither change
is lost. A load takes no lock. A save removes temporary files a crashed save left,
including the fixed `counter.json.tmp` of earlier builds. A missing file is a
fresh counter; an unreadable file or an unknown `version` is a `corrupt` storage error,
never silently replaced. A field is added with `#[serde(default)]`; renaming or removing
one bumps `version`, and the reader keeps accepting the old version.

**Log files**, in `~/Library/Logs/com.example.myapp/`: `myapp.YYYY-MM-DD.log` from the
app and `myapp-cli.YYYY-MM-DD.log` from the helper, dated in UTC, one per day, the
newest 14 of each kept. Each line is `tracing-subscriber`'s plain text format: an
RFC 3339 timestamp, the level, the target, the message, and its fields. The message
wording is private, with one exception: the launch smoke looks for the app's
`startup complete` line carrying `pid=<pid>`, so that line keeps its message and field.

**Private** is everything else: `pub(crate)` and private items, how an adapter talks to
the OS behind its port, component structure, CSS, file and module layout, test helpers,
and log wording. Changing any of it needs only the gates that already run.

No gate notices every broken contract item. The compiler guards core's public API, and
the bindings drift check, the IPC-name harness check, and the command tests guard IPC;
a changed file format or a renamed identifier passes every check and fails on the user's
Mac, so review is what catches it, and a user-visible change to any contract item owes a
`CHANGELOG.md` entry.
