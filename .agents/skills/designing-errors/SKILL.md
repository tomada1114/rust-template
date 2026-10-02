---
name: designing-errors
description: >
  Covers how an error is shaped in this Rust CLI/TUI repository: one thiserror enum per
  core module or port, variants the caller can act on, a payload of small kinds and
  never std::io::Error or a path, From impls so ? converts, Option versus Err, the
  binary mapping each variant to wording in crates/myapp/src/wording.rs and to exit code
  1, the same wording on the tui screen's error line, an optional serialized code
  (#[serde(tag = "code")]) for --json output, what an error or a tracing field may
  carry, how an adapter in myapp-platform maps std::io::Error or an OS failure into a
  core kind, no panic in a subcommand or the TUI (panic = "abort" in release), anyhow,
  and the ERR_<STAGE>_<WHAT> codes of cargo xtask tasks and skills' scripts. Use when
  adding or changing an error enum or variant, a Result-returning function or port, a
  From impl, a match on an error, the wording for an error, a ScriptError code, or when
  renaming a variant changes the code a --json consumer or a test pins.
---

# Designing Errors

**Owns:** the shape of an error type, the vocabulary of its variants and codes, what an
error and its log line may carry, and the OS-to-core mapping at the adapter boundary.
**Does not own:** writing the failing test first (`tdd`); how an error is asserted
(`writing-tests`); `Result`, `?`, and `match` as language features (`writing-rust`);
which stream and exit code a failure gets, and the wording module's style
(`designing-clis`); the C and TCC mechanics of a failing system API
(`integrating-system-apis`); the four-line stderr report of a task
(`writing-repo-scripts`).

## The one rule: the variant is the contract, the message is not

A caller branches on the variant, because it only changes on purpose. The text in
`#[error("…")]` is for a developer reading a log, and may be reworded in any pull
request. So a test, a `match`, or the binary's wording never compares message text: it
names the variant. In the sample, that is `Err(CounterError::AtMaximum)`.
`.claude/rules/testing.md` holds the same rule for tests.

## Where an error type lives, and its shape

- Declare every error a caller can observe in `myapp-core`, beside the module or port
  that returns it. The binary, the TUI, and a fake in `myapp-test-support` all name it,
  and core never depends on `myapp-platform`, so an error declared in an adapter could
  not be named by core or by a fake.
- One enum per failure domain, deriving `thiserror::Error`. `thiserror` writes the
  `Display` and `std::error::Error` impls from the `#[error]` attributes, so an error
  type costs a derive rather than two hand-written impls
  (<https://docs.rs/thiserror/latest/thiserror/>, checked 2026-09-30).
- Variants name what the caller can do something about, not which call failed. In the
  sample, `CounterError::{AtMaximum, AtMinimum, Storage { kind }}`: the user is told a
  different sentence for each.
- A payload is a small value the caller decides on: an enum of kinds, a number. Never a
  `std::io::Error` or a `Box<dyn Error>`, which are not `PartialEq` (so a test cannot
  `assert_eq!` on them), and never a `PathBuf` or a `String` from the OS, which can
  carry a path under the home directory or a user's text.
- Derive `Debug, Clone, Copy, PartialEq, Eq` where the payload allows. `Copy` is free
  for a unit-only or small-enum error and saves the reader from ownership questions.
- A port has its own narrow error and the module above it converts with `From`, so `?`
  converts for you. In the sample, `CounterStore` returns `StorageError { kind }`, and
  `impl From<StorageError> for CounterError` makes `self.store.save(&stored)?` yield
  `CounterError::Storage { kind }`.

"There is none" is not an error: return `Ok(None)` (`CounterStore::load` before the
first save). An `Err` means "could not find out" or "refused". Turning an expected
absence into an error makes every caller handle a failure that is not one.

## Leaving core: wording, an exit code, and maybe a code

Core never builds a user-facing sentence. The binary turns a variant into words in one
module, `crates/myapp/src/wording.rs`, with one function per error enum that matches
every variant and no `_ =>` arm (`counter_error` and `storage_error` in the sample).
`main.rs` denies `clippy::wildcard_enum_match_arm`, so a new core variant fails to
compile until someone decides what the user is told.

- A subcommand prints `error: <wording>` on stderr and exits 1 for every runtime error;
  the `tui` screen shows the same sentence on its error line. One sentence per variant,
  wherever the user meets it. The streams and codes are `designing-clis`'.
- An error that may leave the process as data, in a `--json` consumer's output or a
  file, derives `Serialize` and is internally tagged, so its variant becomes a stable
  `code`:

  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, Serialize)]
  #[serde(tag = "code", rename_all = "camelCase")]
  pub enum CounterError { /* in the sample: AtMaximum, AtMinimum, Storage { kind } */ }
  ```

  `tag = "code"` puts the variant name in a `code` field and flattens the payload beside
  it (`{ "code": "storage", "kind": "corrupt" }`); serde calls this the internally
  tagged representation (<https://serde.rs/enum-representations.html>, checked
  2026-09-30). `crates/myapp-core/tests/serialization.rs` pins each code with literal
  JSON. An error that never leaves the process (`StorageError`, `LoggingError`) derives
  no `Serialize`.

## What an error or a log field may carry

An error travels: into a log file, a test's output, a terminal a user screenshots, a
bug report, and a pull request.

- No user data in a payload, a `#[error]` message, a wording sentence, or a `tracing`
  field: no path under the home directory, no file content, nothing a user typed.
  `StorageError` and `LoggingError` say what failed without naming the file, because
  the caller already knows which one it passed.
- `tracing::warn!(%error, …)` writes the error's `Display`, so the `#[error]` text is
  held to the same rule as the payload. `?error` writes its `Debug`, which prints the
  payload: one more reason it holds only kinds.
- Log once, where the error is handled. The binary logs the outcome of each action
  (`counter` in `main.rs`, `log_action` in `tui/mod.rs`); core and adapters return the
  error and do not also log it, or one failure prints three lines.

## Mapping OS failures in an adapter

The adapter translates and decides nothing (`AGENTS.md` › "Architecture"). Mapping an
OS failure to a core kind is translation; what the tool then does is core's decision.

- Convert at the call site in `myapp-platform`, into the error the port declares.
  Nothing OS-typed crosses the port. In the sample, `JsonFileCounterStore` maps
  `io::ErrorKind::NotFound` on a read to `Ok(None)` (absence), any other I/O error to
  `StorageErrorKind::Unavailable`, and unreadable JSON or an unknown format version to
  `Corrupt`.
- Match the specific kinds you handle and send everything else to one catch-all kind.
  Keep a numeric OS status (an exit code, an `errno`) only when a log needs it, as an
  integer field, never the OS's message text, which can quote a path.
- The test for the mapping is the adapter's own test against the real thing
  (`crates/myapp-platform/tests/`); the test for the decision is a core test with a
  fake that fails on demand (`FailingCounterStore`).

## No panic in a subcommand or the TUI

`[profile.release]` in the root `Cargo.toml` sets `panic = "abort"`: in a release build a
panic ends the process at once, with no `error:` line, no log line, and, in the TUI,
nothing unwound back to the code that restores the terminal
(<https://doc.rust-lang.org/cargo/reference/profiles.html#panic>, checked 2026-09-30).
So:

- Never `unwrap()` or `expect()` outside tests (`clippy::unwrap_used`/`expect_used` in
  `[workspace.lints]`). Return a `Result` and propagate with `?`; the binary turns the
  last `Err` into wording and an exit code.
- Watch for the panics that hide in the standard library: `println!` on a closed stdout
  (handled with `writeln!` in `main.rs`), `clamp` with a minimum above the maximum
  (`Tuning::new` refuses that range), slicing past a string's end.
- A lock that protects no data is taken with `unwrap_or_else(PoisonError::into_inner)`
  (`CounterService`), because a panic on another thread left nothing inconsistent.
- The TUI's panic hook restores the terminal before the message prints
  (`building-tuis`); it is the last line of defense, not a reason to panic.
- An error is handled or returned, never dropped. `let _ = fallible();` carries a
  comment saying why the failure does not matter (`let _ = leave();` inside the panic
  hook, `remove_stale_temps` in `crates/myapp-platform/src/counter_store.rs`).

`anyhow` is not used: every crate here is a library or a composition root with typed
errors, and the binary maps each one to its own wording and exit code. Adding it is a
new dependency (`managing-dependencies`), and it stays out of core and platform.

## Codes in `xtask/` and skills' scripts

A repository task or a skill's script fails with a `ScriptError` (`xtask/src/fail.rs`
for a `cargo xtask` task; the script's own class for a skill's Python script, as in
`merging-dependency-prs`' `survey_prs.py`) whose `code` is `ERR_<STAGE>_<WHAT>`: the
stage is the task or script (`ERR_HOOKS_*`, `ERR_AGENTS_*`, `ERR_SURVEY_*`), so the code
alone says which one to read, and the rest names the failure, not the function
(`ERR_HOOKS_NOT_INSTALLED`, not `ERR_HOOKS_CHECK_FAILED`). Reuse the existing stage
before inventing one. A test asserts the code (`outcome.code()` or
`error.details.code` in a task, `error.code` in Python), never the summary. An error a
task did not expect (an I/O failure, say) is `ScriptError::unexpected`, reported as
`ERR_INTERNAL_UNEXPECTED`. The report's shape and exit codes are
`writing-repo-scripts`'.

## Adding, renaming, or removing a variant

`rename_all = "camelCase"` derives a serialized code from the variant name, so
**renaming a Rust variant renames the code a `--json` consumer reads**; keep the old
name with `#[serde(rename = "…")]` when only the Rust name should change. In one pull
request:

1. the enum in core, with the core test that reaches the new variant;
2. its arm in `crates/myapp/src/wording.rs`, and that module's test for its sentence;
3. a test in `crates/myapp/tests/cli.rs` for each failure a user can now reach, and a
   `TestBackend` test when the TUI shows it;
4. the literal-JSON test in `crates/myapp-core/tests/serialization.rs`, when the enum
   serializes;
5. a `CHANGELOG.md` entry when a user sees the difference.
