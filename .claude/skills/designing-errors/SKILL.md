---
name: designing-errors
description: >
  Covers how an error is shaped in this Rust + Tauri + TypeScript repository: one
  thiserror enum per core module or port, serialized to the UI as a code with
  #[serde(tag = "code")] and worded in ui/src/copy/, the rejection guards in
  ui/src/ipc/errors.ts, what an error payload or a tracing field may carry, how an
  adapter in myapp-platform maps std::io::Error or an OS failure into a core kind,
  Option versus Err, no panic across a command (panic = "abort" in release), anyhow,
  and the ERR_<STAGE>_<WHAT> codes of scripts/. Use when adding or changing an error
  enum or variant, a Result-returning function or port, a From impl, a match on an
  error, the wording for an error code, a ScriptError code, or when renaming a variant
  changes the JSON the UI receives.
---

# Designing Errors

**Owns:** the shape of an error type in Rust and TypeScript, the vocabulary of its code,
what an error and its log line may carry, and the OS-to-core mapping at the adapter
boundary. **Does not own:** writing the failing test first (`tdd`); how an error is
asserted (`writing-tests`); `Result`, `?`, and `match` as language features
(`writing-rust`); wiring a command that returns the error (`designing-ipc`); the C and
TCC mechanics of a failing system API (`integrating-system-apis`); the four-line stderr
report of a script (`writing-repo-scripts`); where the wording is rendered
(`building-react-screens`).

## The one rule: the code is the contract, the message is not

A caller branches on the variant (Rust) or the `code` (TypeScript), because those only
change on purpose. The text in `#[error("…")]` is for a developer reading a log, and may
be reworded in any pull request. So a test, a `match`, or a UI branch never compares
message text: it asserts the variant in Rust and the `code` in TypeScript. In the
sample, that is `Err(CounterError::AtMaximum)` and `{ code: "atMaximum" }`.
`.claude/rules/testing.md` holds the same rule for tests.

## Where an error type lives, and its shape

- Declare every error a caller can observe in `myapp-core`, beside the module or port
  that returns it. The shell, the CLI, the UI (through `just bindings`), and a fake in
  `myapp-test-support` all name it, and core never depends on `myapp-platform`, so an
  error declared in an adapter could not be named by core or by a fake.
- One enum per failure domain, deriving `thiserror::Error`. `thiserror` writes the
  `Display` and `std::error::Error` impls from the `#[error]` attributes, so an error
  type costs a derive rather than two hand-written impls
  (<https://docs.rs/thiserror/latest/thiserror/>).
- Variants name what the caller can do something about, not which call failed. In the
  sample, `CounterError::{AtMaximum, AtMinimum, Storage { kind }}`: the UI says a
  different sentence for each.
- A payload is a small value the caller decides on: an enum of kinds, a number. Never a
  `std::io::Error` or a `Box<dyn Error>`, which are neither `PartialEq` (so a test cannot
  `assert_eq!` on them) nor serializable, and never a `PathBuf` or a `String` from the
  OS, which can carry a path under the home directory or a user's text.
- Derive `Debug, Clone, Copy, PartialEq, Eq` where the payload allows. `Copy` is free
  for a unit-only or small-enum error and saves the reader from ownership questions.
- A port has its own narrow error and the module above it converts with `From`, so `?`
  converts for you. In the sample, `CounterStore` returns `StorageError { kind }`, and
  `impl From<StorageError> for CounterError` makes `self.store.save(&stored)?` yield
  `CounterError::Storage { kind }`.

"There is none" is not an error: return `Ok(None)` (`CounterStore::load` before the
first save). An `Err` means "could not find out" or "refused". Turning an expected
absence into an error makes every caller handle a failure that is not one.

## Crossing IPC: a code, never a sentence

An error the UI receives derives `Serialize` and `ts_rs::TS` and is internally tagged:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, Serialize, TS)]
#[serde(tag = "code", rename_all = "camelCase")]
#[cfg_attr(feature = "export-bindings", ts(export))]
pub enum CounterError { /* in the sample: AtMaximum, AtMinimum, Storage { kind } */ }
```

`tag = "code"` puts the variant name in a `code` field and flattens the payload beside
it (`{ "code": "storage", "kind": "corrupt" }`); serde calls this the internally tagged
representation (<https://serde.rs/enum-representations.html>). Tauri requires a command's
error type to implement `Serialize` (<https://v2.tauri.app/develop/calling-rust/>,
checked 2026-09-29), and this shape is what a command rejects with.

- Rust never sends a user-facing sentence. The UI owns the wording in `ui/src/copy/`,
  one exhaustive `switch` per error type (`describeCounterError` in the sample).
  ESLint's `switch-exhaustiveness-check` fails `just lint` when a code has no case, so
  a new variant cannot ship without its sentence.
- A rejection is narrowed before it is read. `ui/src/ipc/errors.ts` holds one guard per
  error type, listing the codes with `satisfies <Error>["code"][]` (`isCounterError` in
  the sample). `satisfies` rejects a code that does not exist but
  does not notice a missing one, so a new code is added to that list by hand, and
  `errors.test.ts` gets a case for it.
- A rejection that is not a known code (the bridge itself failed) becomes `null` in the
  hook and is logged through `ui/src/ipc/log.ts`; the screen shows a generic sentence
  from `ui/src/copy/`.
- An error that never crosses IPC (`StorageError`, `StartupError` in
  `src-tauri/src/lib.rs`, `LoggingError`) derives neither `Serialize` nor `TS`.

## What an error or a log field may carry

An error travels: into a log file, a test's output, a bug report, and a pull request.

- No user data in a payload, a `#[error]` message, or a `tracing` field: no path under
  the home directory, no file content, nothing a user typed, no other app's name or
  window title. `StartupError` and `LoggingError` say which directory failed without
  naming it, because the caller already knows which one it passed.
- `tracing::warn!(%error, …)` writes the error's `Display`, so the `#[error]` text is
  held to the same rule as the payload.
- `UiLogEntry.message` reaches the log through `UiLogEntry::loggable_message`, which
  keeps it on one line and cuts it to a bounded length but cannot remove user data: the
  UI sends developer terms (`"get_counter failed without a counter error code"`), never
  what the user entered.
- Log once, where the error is handled. A command logs the outcome (`log_outcome` in
  `src-tauri/src/commands.rs`); core and adapters return the error and do not also log
  it, or one failure prints three lines.

## Mapping OS failures in an adapter

The adapter translates and decides nothing (`AGENTS.md` › "Architecture"). Mapping an
OS failure to a core kind is translation; what the app then does is core's decision.

- Convert at the call site in `myapp-platform`, into the error the port declares.
  Nothing OS-typed crosses the port. In the sample, `JsonFileCounterStore::load` maps
  `io::ErrorKind::NotFound` to `Ok(None)` (absence), any other read error to
  `StorageErrorKind::Unavailable`, and unreadable JSON or an unknown format version to
  `Corrupt`.
- Match the specific kinds you handle and send everything else to one catch-all kind.
  Keep a numeric OS status (an exit code, an `OSStatus`) only when a log needs it, as an
  integer field, never the OS's message text.
- The test for the mapping is the adapter's contract test against the real thing
  (`crates/myapp-platform/tests/`); the test for the decision is a core test with a
  fake that fails on demand (`FailingCounterStore`).

## No panic across a command

`[profile.release]` in the root `Cargo.toml` sets `panic = "abort"`: in a release build a
panic kills the whole app at once, with no error for the UI and no line in the log file
(<https://doc.rust-lang.org/cargo/reference/profiles.html#panic>). So:

- Never `unwrap()` or `expect()` outside tests (`clippy::unwrap_used`/`expect_used` in
  `[workspace.lints]`). Return a `Result` and propagate with `?`.
- A command returns `Result<T, E>` for anything that can fail, including a worker
  thread that died: the join error of `spawn_blocking` becomes a core kind, never an
  unwrap. In the sample, `on_blocking_thread` maps it to `Storage { kind: Unavailable }`.
- A lock that protects no data is taken with `unwrap_or_else(PoisonError::into_inner)`
  (`CounterService`), because a panic on another thread left nothing inconsistent.
- An error is handled or returned, never dropped. `let _ = fallible();` carries a
  comment saying why the failure does not matter (`record_events` in
  `src-tauri/tests/commands.rs`); a failure worth knowing about is logged instead, as
  `announce` does when an emit fails, without failing the command.

`anyhow` is not used: every crate here is a library or a composition root with a typed
error, and the helper CLI maps core's error to its own stderr line and exit code (in the
sample, `describe` in `crates/myapp-cli/src/main.rs`). Adding it for the CLI's `main` is a new
dependency (`managing-dependencies`), and it stays out of core, platform, and the shell.

## Codes in `scripts/`

A repository script fails with a `ScriptError` (`scripts/lib/fail.ts`) whose `code` is
`ERR_<STAGE>_<WHAT>`: the stage is the script (`ERR_SMOKE_*`, `ERR_AGENTS_*`,
`ERR_RELEASE_*`), so the code alone says which script to read, and the rest names the
failure, not the function (`ERR_SMOKE_CODESIGN`, not `ERR_SMOKE_VERIFY_FAILED`). Reuse the
script's existing stage before inventing one. A test asserts `details.code`, never the
summary. The report's shape and exit codes are `writing-repo-scripts`'.

## Changing a code

The JSON of an error that crosses IPC is contract (`docs/architecture.md` › "What is
contract and what is private"). `rename_all = "camelCase"` derives the wire code from the
variant name, so **renaming a Rust variant renames the code the UI switches on**; keep
the old wire name with `#[serde(rename = "…")]` when only the Rust name should change.
Adding, renaming, or removing a code touches, in one pull request:

1. the enum in core, then `just bindings`, committing `ui/src/ipc/generated/` with it;
2. the guard's code list in `ui/src/ipc/errors.ts` and its test;
3. the sentence in `ui/src/copy/` (`just lint` fails until the `switch` covers it);
4. the literal-JSON test in `crates/myapp-core/tests/serialization.rs`, and the command
   test that rejects with it (`src-tauri/tests/commands.rs`);
5. one line in the pull request naming the old code, the new one, and what the UI now
   does, and a `CHANGELOG.md` entry when a user sees the difference.
