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
checklist below is every file that holds the sample. Work through it after the
bootstrap has run (the paths then carry your app's name), in the pull request that adds
your first real core module, so the coverage floor always has code to measure.

`log_from_ui` is not part of the sample: it forwards the UI's warnings and errors to the
log, and its registration and tests are the model a new command copies. Every item below
that touches it says what to keep.

**Core** (`crates/myapp-core`):

- [ ] `src/counter/` (`Counter`, `CounterService`, `CounterView`, `CounterError`,
      `StoredCounter`, `StorageError`, `Tuning`, the `CounterStore` port) and its
      `pub mod` and re-exports in `src/lib.rs` — replace with your domain model and ports
- [ ] `tests/counter_service.rs`, the counter-store test in `tests/contracts.rs`, and the
      counter shapes in `tests/serialization.rs` — replace with tests for your core
- [ ] `src/log.rs`: the `get_counter failed` sample message in its tests (keep the
      module: `UiLogEntry` is what `log_from_ui` receives)
- [ ] Keep `src/time.rs` (`Clock`) unless your app has no use for it: it is general, not
      counter-specific

**Adapters and fakes**:

- [ ] `crates/myapp-platform/src/counter_store.rs` (`JsonFileCounterStore`), its `mod`
      and re-export in `src/lib.rs`, `COUNTER_FILE_NAME` and `counter_file` in
      `src/paths.rs` (drop only the `counter_file` assertion from
      `directories_follow_the_macos_conventions`, which also covers the data and log
      directories), `tests/json_file_counter_store.rs`, and the counter-store test in
      `tests/contracts.rs`
- [ ] `crates/myapp-test-support/src/counter_store.rs` (`InMemoryCounterStore`,
      `FailingCounterStore`, `counter_store_contract`) and its `mod` and re-export in
      `src/lib.rs`

**Shell and helper** (keep every `log_from_ui` line):

- [ ] `src-tauri/src/commands.rs` — the four counter commands, their helpers, the
      `counter` field of `AppState`, and `COUNTER_CHANGED`; keep `log_from_ui` and
      `AppState` itself for your state
- [ ] `src-tauri/src/lib.rs` — the four counter entries in `with_commands`' handler list
      (keep `with_commands`, which `run()` and the command tests share, and its
      `commands::log_from_ui` entry), the counter wiring in `build_state`, and
      `COUNTER_CHANGED` in the `pub use`
- [ ] `src-tauri/tests/commands.rs` — the counter tests and the counter state in
      `app_holding` and `app_over`; keep the `log_from_ui_*` tests and
      `an_unregistered_command_is_rejected`, building the app from your state
- [ ] `src-tauri/tests/startup.rs` — the counter-file test, the counter-only helpers
      `saved_value` and `without_time`, the `counter_file` import, the counter commands
      in `setup_then_every_command`, and the `saved` element of its tuple with that
      element's assertion in `setup_leaves_the_same_state_and_commands_under_both_plans`;
      keep the `log_from_ui` call, the unregistered-command check, and the
      startup-plan tests
- [ ] `crates/myapp-cli/src/main.rs` — the `counter` subcommand (keep `--help`,
      `--version`, and the exit-code convention) and its tests in `tests/cli.rs`

**UI**:

- [ ] `ui/src/counter/` and `ui/src/copy/counter.ts` with its test; the `CounterScreen`
      in `ui/src/main.tsx`
- [ ] `ui/src/ipc/commands.ts`, `events.ts`, `errors.ts`, and `types.ts`, and their
      tests — the counter wrappers, the event, and the error codes (keep `logFromUi`)
- [ ] `ui/src/ipc/generated/` — `just bindings` rebuilds it from scratch, so the
      counter's generated types disappear once core no longer exports them

**Documents and agent guidance**:

- [ ] `docs/architecture.md` — the counter column under "Ports and adapters", the
      command and event names, the helper's command line, and the `counter.json` format
      under "What is contract"
- [ ] `README.md` — the introduction's counter sentence, "Why is the sample app a
      counter?", and the `just test-fast increment` example
- [ ] `AGENTS.md` — the `just test-fast increment` example, the counter examples in
      Architecture (`JsonFileCounterStore`, `counter/`, `CounterStore`,
      `COUNTER_CHANGED`, `counter.json`)
- [ ] `CONTRIBUTING.md`, the `justfile`'s `test-fast` comment, and this page — the
      `just test-fast increment` examples, "Seeing the app"'s `counter.json` and helper
      commands, and this checklist
- [ ] `.claude/rules/rust.md`, `.claude/rules/testing.md`, and
      `.claude/rules/typescript.md` — the sentences that give a counter type as the
      example (each sits in its own sentence; replace it with your own type or delete it)
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` — the counter in the example title
- [ ] The skills under `.agents/skills/` that give the counter as an example, then
      `just agents-sync` (the `starting-an-app` skill)

Then run `just bindings` and `just check`, and this search, which should print nothing:

```bash
git grep -nIiE 'counter|test-fast increment' -- . ':(exclude)scripts/' \
  ':(exclude).claude/skills/' ':(exclude,glob).agents/skills/*/scripts/**' \
  ':(exclude)CHANGELOG.md'
```

It uses `git grep`, which needs nothing beyond the prerequisites. The exclusions are
words that are not the sample: the harness's own tests and fixtures under `scripts/`
(and the `yaml` library's `LineCounter` there), a skill's bundled scripts,
`.claude/skills/` (the mirror `just agents-sync` regenerates), and `CHANGELOG.md`, where
the entry recording the sample's removal names it on purpose.

## App icon

`src-tauri/icons/` holds the template's placeholder icons, listed under `bundle.icon` in
`src-tauri/tauri.conf.json`. To replace them, make a square PNG or SVG with
transparency and run `pnpm tauri icon path/to/icon.png`, which writes the desktop sizes
into that directory (<https://v2.tauri.app/develop/icons/>, checked 2026-09-28). It
also writes sizes this macOS-only app does not list; delete what `bundle.icon` does not
name.
