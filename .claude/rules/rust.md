---
paths:
  - "crates/**/*.rs"
  - "src-tauri/**/*.rs"
---

The short, always-on version of the `writing-rust` and `designing-errors` skills. clippy
(`just lint`) enforces most of it; the rest is review's job.

## Where code goes

- A decision — anything that branches, clamps, formats, or remembers — goes in
  `myapp-core`, where the coverage floor sees it. `myapp-platform`, `src-tauri`, and
  `myapp-cli` translate between core and the outside world and decide nothing
- Core never names tauri, an OS binding crate, or `myapp-platform`, and reaches time,
  storage, the environment, and processes only through a port: a synchronous
  `Send + Sync` trait declared in core, implemented in `myapp-platform`, faked in
  `myapp-test-support`. `crates/myapp-core/clippy.toml` bans the direct calls
- A command in `src-tauri/src/commands.rs` is thin: decode the arguments, call core
  (on `tauri::async_runtime::spawn_blocking` if the port is slow), map the result,
  emit the event. No `if` about the domain
- Every type that crosses IPC lives in core and derives `ts_rs::TS`; after changing
  one, run `just bindings` and commit `ui/src/ipc/generated/` with it

## Errors

- NEVER `unwrap()` or `expect()` outside tests (`clippy::unwrap_used`/`expect_used`,
  allowed in tests by `clippy.toml`). Return a `Result` and propagate with `?`
- One `thiserror` enum per port or core module, with a variant per failure the caller
  can act on (`CounterError::{AtMaximum, AtMinimum, Storage { kind }}` is the worked
  example). An error that crosses IPC serializes as a code (`#[serde(tag = "code")]`);
  the UI owns the wording in `ui/src/copy/`, so Rust never sends a user-facing sentence
- An adapter maps `std::io::Error` and OS failures into core's error kinds at the
  boundary; core never sees a `std::io::Error`
- No user data in an error or a log field: no path under the home directory, no file
  content, nothing a user typed
- Never swallow an error: handle it, or return it. `let _ = fallible();` needs a comment
  saying why the failure does not matter
- No panic across a command: a command returns `Result<T, E>`, never panics on bad
  input. `anyhow` is not used in libraries

## Visibility

- Narrowest first: private, then `pub(crate)`, then `pub`. A crate's `pub` items are
  what other crates may call; core's `pub` API is contract (`docs/architecture.md`)
- `pub` only for what another crate or an integration test under `tests/` needs; a
  helper shared between modules of one crate is `pub(crate)`
- Every `pub` item has a `///` comment saying why it exists and what it promises
  (`missing_docs` warns); a fallible `pub fn` has an `# Errors` section, one that can
  panic a `# Panics` section (clippy pedantic asks for both)

## Logging

- `tracing` only: `tracing::info!`, `warn!`, `error!`, `debug!` with structured fields
  (`value = view.value`, `%error`). Never `println!`, `eprintln!`, or `dbg!` — banned in
  core by `crates/myapp-core/clippy.toml`, and wrong everywhere else too: a `.app`
  launched from Finder discards stdout, so those lines are lost exactly when they matter.
  The CLI's own output to its user (`--help`, a printed value) is the one exception
- Only the shell and the CLI install a subscriber (`myapp_platform::init_logging`);
  libraries only emit events

## Unsafe

- `unsafe_code = "forbid"` holds in every crate (`Cargo.toml`'s `[workspace.lints]`).
  `unsafe` is never the fix for a borrow-checker error
- The one place `unsafe` may ever appear is `myapp-platform`, for FFI that no system
  command or safe binding covers — and only after an ADR lifts `forbid` for that crate
  (the `integrating-system-apis` skill). Each block then carries a `// SAFETY:` comment
  stating the invariant that makes it sound, and the same change turns on
  `clippy::undocumented_unsafe_blocks` so a missing one fails `just lint`

## Matching

- A `match` on an enum core declares names every variant, with no `_ =>` arm (core
  denies `clippy::wildcard_enum_match_arm`), so a new variant is a compile error at every
  place that must decide about it. Group variants with `A | B =>` instead. In core the
  lint fires on an enum a foreign crate owns too (`std::cmp::Ordering`), whenever a `_`
  stands for a variant the match could have named. A `#[non_exhaustive]` foreign enum
  needs a `_` arm (rustc, E0004), which the lint accepts only after every variant is
  named; `std::io::ErrorKind` has unstable variants no match can name (E0658), so test
  it with `==` or `matches!`. Outside core a match on a `#[non_exhaustive]` foreign
  enum ends with `_ =>`

## Constants

- A number someone might tune (a bound, a limit, a delay) lives in core's one `Tuning`
  struct (`crates/myapp-core/src/counter/mod.rs`), passed in by the shell
- A name other code must agree on is a `pub const` beside the one concern that owns it:
  an event name in `src-tauri/src/commands.rs` (`COUNTER_CHANGED`), the smoke flag in
  `src-tauri/src/startup.rs` (`SMOKE_ENV`), the bundle identifier and file names in
  `crates/myapp-platform/src/paths.rs`, the log retention in
  `crates/myapp-platform/src/logging.rs`
- A private `const` at the top of the file that uses it for anything else. No
  `constants.rs` grab bag and no `static mut`

## Ownership, for a reader new to Rust

- Take `&str` and `&[T]` as parameters; return `String` and `Vec<T>`. A caller can
  always lend, and an owned return needs no lifetime
- A small value (an id, a view struct, a `Copy` type) is cheaper to `.clone()` or copy
  than to thread a lifetime through three functions; clone it and move on. Reach for
  `Arc` only to share a port or a service between threads (`AppState` holds
  `Arc<CounterService>`)
- A state transition takes `self` and returns a new value or a typed error
  (`Counter::increment(self) -> Result<Self, CounterError>`), rather than mutating
  through `&mut` and returning nothing
- When the compiler says "borrowed value does not live long enough" or "cannot borrow
  as mutable more than once", restructure (end the borrow before the next one, clone
  the small value) rather than adding lifetimes; `writing-rust` walks through the
  common errors
- Fix a clippy finding; do not `#[allow(...)]` it. An `#[allow]` or `#[expect]` to
  pass a check is weakening a gate (`AGENTS.md` › Security and human approval)
