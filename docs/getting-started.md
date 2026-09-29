# Getting Started

## Prerequisites

- A Mac with Apple Silicon on macOS 14 or later.
- The Xcode Command Line Tools (`xcode-select --install`); the full Xcode app is not
  needed.
- [rustup](https://rustup.rs/), [mise](https://mise.jdx.dev/), and
  [Just](https://just.systems/man/en/) (`brew install mise just`).

[CONTRIBUTING.md](../CONTRIBUTING.md) lists what each one provides.

## Setup

```bash
mise trust     # approve this repository's mise.toml (asked once per clone)
just install
```

Without trust, mise prompts, skips the config, or fails when it cannot prompt, so a fresh
clone runs `mise trust` first (<https://mise.jdx.dev/cli/trust.html>, checked
2026-09-28).
`just install` then:

1. checks for the Xcode Command Line Tools and, if they are missing, stops with the
   command to run (it never starts an installer);
2. runs `mise install` for the pinned tools;
3. enables pnpm through corepack and runs `pnpm install --frozen-lockfile`;
4. installs lefthook's pre-commit hook, and fails if it is not in place.

The first `cargo` command installs the Rust toolchain `rust-toolchain.toml` pins.

## Everyday commands

```bash
just check       # the full local gate, in CI's order; opens no window
just test        # core (coverage floors) and UI (coverage floors)
just test-fast increment   # one core test or a group of them
just lint        # rustfmt, clippy -D warnings, tsc, ESLint, Prettier
just fmt         # format everything
just bindings    # after changing a type that crosses IPC; commit the result
```

## Seeing the app

`just check` never shows the app: the launch smoke runs it windowless. To look at it:

```bash
just dev         # hot reload: Vite serves ui/, Rust rebuilds on change
just run         # build the debug .app, quit any running copy, open it
just logs        # the newest log file's last lines
```

The app keeps its data in `~/Library/Application Support/com.example.myapp/counter.json`
and its logs in `~/Library/Logs/com.example.myapp/`. Deleting `counter.json` starts the
counter over.

The bundled helper reads and writes the same file:

```bash
cargo run --locked -p myapp-cli -- counter show
cargo run --locked -p myapp-cli -- counter increment
```

An open window picks up the helper's change when it next loads or changes the counter.

## Permissions (TCC)

The sample asks for no privacy permission. When an app cut from the template does —
Accessibility, Screen Recording, Full Disk Access, and the like — two recipes help:

- `just test-local` runs the `#[ignore]`d tests that need a logged-in session, a TCC
  grant, or the Keychain. You start it; nothing else does.
- `just reset-permissions` makes macOS forget this app's grants
  (`tccutil reset All com.example.myapp`), so the next launch asks again.

Local builds are ad-hoc signed, and every building recipe unsets the `APPLE_*`
variables, so a local build never signs as a developer. How an app that needs a stable
signing identity for its grants signs its local builds is a decision for that app's ADR.

## Removing the example code

The counter is an illustration to replace, not something an app must keep. The
`starting-an-app` skill walks through this with the design-system decision first; the
checklist below is what it removes. Work through it after the bootstrap has run (the
paths then carry your app's name), then run `just bindings` and `just check`.

**Core** (`crates/myapp-core`):

- [ ] `src/counter/` (`Counter`, `CounterService`, `CounterView`, `CounterError`, the
      `CounterStore` port) and its re-exports in `src/lib.rs` — replace with your
      domain model and ports
- [ ] `tests/counter_service.rs`, the counter-store test in `tests/contracts.rs`, and the
      counter shapes in `tests/serialization.rs` — replace with tests for your core, so
      the coverage floor still has something to measure
- [ ] Keep `src/time.rs` (`Clock`) and `src/log.rs` (`UiLogEntry`) unless your app has
      no use for them: they are general, not counter-specific

**Adapters and fakes**:

- [ ] `crates/myapp-platform/src/counter_store.rs` (`JsonFileCounterStore`),
      `COUNTER_FILE_NAME` and `counter_file` in `src/paths.rs`, and
      `tests/json_file_counter_store.rs` plus the counter-store test in `tests/contracts.rs`
- [ ] `crates/myapp-test-support/src/counter_store.rs` (`InMemoryCounterStore`,
      `FailingCounterStore`, `counter_store_contract`)

**Shell and helper**:

- [ ] `src-tauri/src/commands.rs` — the four counter commands and `COUNTER_CHANGED`
      (keep `log_from_ui`); `build_state` and `with_commands` in `src-tauri/src/lib.rs`;
      `src-tauri/tests/commands.rs`
- [ ] `crates/myapp-cli/src/main.rs` — the `counter` subcommand (keep `--help`,
      `--version`, and the exit-code convention) and `tests/cli.rs`

**UI**:

- [ ] `ui/src/counter/` and `ui/src/copy/counter.ts`; the `CounterScreen` in
      `ui/src/main.tsx`
- [ ] `ui/src/ipc/commands.ts`, `events.ts`, `errors.ts`, and `types.ts` — the counter
      wrappers, the event, and the error codes (keep `logFromUi`)

**Documents**:

- [ ] `docs/architecture.md` — the counter rows under "Ports and adapters", the command
      and event names, and the `counter.json` format under "What is contract"
- [ ] `AGENTS.md`, `CONTRIBUTING.md`, and this page — the `just test-fast increment`
      examples and the counter mentions

`rg -i 'counter'` then lists anything left.

## App icon

`src-tauri/icons/` holds the template's placeholder icons, listed under `bundle.icon` in
`src-tauri/tauri.conf.json`. To replace them, make a square PNG or SVG with
transparency and run `pnpm tauri icon path/to/icon.png`, which writes the desktop sizes
into that directory (<https://v2.tauri.app/develop/icons/>, checked 2026-09-28). It
also writes sizes this macOS-only app does not list; delete what `bundle.icon` does not
name.
