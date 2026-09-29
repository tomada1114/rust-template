---
name: writing-rust
description: >
  Covers the Rust a newcomer needs to change this codebase safely, in crates/*/src and
  src-tauri/src: ownership and borrowing (&str in, String out, clone a small value
  rather than add a lifetime, Arc and Mutex for shared ports), Result and the ? operator
  instead of unwrap or expect, Option, enums with an exhaustive match
  (wildcard_enum_match_arm), modules and pub(crate), traits as Send + Sync ports, serde
  and ts-rs derives, reading compiler errors (E0382 use of moved value, E0499, E0502,
  E0505, E0597 borrow conflicts, E0277 trait bound not satisfied, E0004 non-exhaustive
  match, E0308 mismatched types), and fixing a clippy pedantic finding instead of
  adding #[allow]. Use when writing or reviewing a .rs file, when cargo build, just
  lint, or just test-fast fails with a compiler error or a clippy warning, when the
  borrow checker objects, or when reaching for unwrap, a lifetime annotation, unsafe,
  or #[allow(clippy::...)].
---

# Writing Rust

**Owns:** Rust language judgment in `crates/*/src/` and `src-tauri/src/` — ownership,
error propagation, `Option`, enums and `match`, visibility, traits, derives, and what to
do with a compiler error or a clippy finding. **Does not own:** where a piece of logic
goes, ports, and `Tuning` (`designing-core-logic`); the shape of an error enum and its
codes (`designing-errors`); a Tauri command (`designing-ipc`); `unsafe` and macOS
bindings (`integrating-system-apis`); tests (`writing-tests`); a new crate
(`managing-dependencies`); a lint level or a `clippy.toml` (`changing-gates`).

The language is linked, not taught: The Rust Book (https://doc.rust-lang.org/book/) is
the reference for every term below, and the clippy lint list
(https://rust-lang.github.io/rust-clippy/master/index.html) explains each finding. This
skill holds the choices this repository makes where the language offers several.

The loop while writing: `just test-fast <filter>` compiles core and runs the matching
tests, `just lint` runs clippy on every crate with warnings as errors, and `just fmt`
formats. None of them opens a window.

## Ownership and borrowing

- Take `&str` and `&[T]` as parameters; return `String` and `Vec<T>`. A borrowed
  parameter lets the caller keep its value without copying it, and an owned return hands
  the result over with no lifetime for anyone to track.
- When the borrow checker objects, restructure first: end one borrow before starting
  the next, or clone the small value. Cloning an id, a short string, or a view struct
  costs nothing measurable here, and the next reader does not have to follow a lifetime
  through three functions. Do not add lifetime annotations to make an error go away.
- A struct owns its fields (`String`, not `&str`). A reference inside a struct gives the
  struct a lifetime parameter that spreads to every type and function that holds it.
- A closure that runs on another thread must own what it uses (`move`), so clone the
  `Arc` first. In the sample, `on_blocking_thread` in `src-tauri/src/commands.rs` does
  `Arc::clone(&state.counter)` before `spawn_blocking(move || …)`; borrowing
  `state` there fails to compile, because the thread may outlive the borrow.
- Share a port or a service between threads with `Arc<T>`; change data behind `&self`
  with a `Mutex`. `Rc` and `RefCell` are for one thread only, and a port must be
  `Send + Sync` (below), so they fail there with E0277.
- Take a lock with `.lock().unwrap_or_else(PoisonError::into_inner)`, as `FixedClock`
  in `crates/myapp-test-support/src/clock.rs` does. A lock is "poisoned" when a thread
  panicked while holding it; `unwrap` is banned, and when the data behind the lock is
  still valid (a clock reading, a `()` guard) taking it anyway is correct.
- A small `Copy` type (a `derive(Clone, Copy)` struct of numbers) is passed by value;
  `.clone()` on it is noise that clippy flags.

## Errors: `Result` and `?`

- Never `unwrap()` or `expect()` outside tests. Enforced by: `Cargo.toml`
  `[workspace.lints.clippy]` `unwrap_used`/`expect_used`, with `clippy.toml`
  `allow-unwrap-in-tests`. The reason is harder than style: the release profile sets
  `panic = "abort"` (root `Cargo.toml`), so a panic ends the whole app at once, with no
  error the UI can show and nothing unwound
  (https://doc.rust-lang.org/cargo/reference/profiles.html#panic, checked 2026-09-29).
- Return `Result<T, E>` and propagate with `?`. Turn an `Option` into an error with
  `.ok_or(E)?` (`home_dir().ok_or(StartupError::NoHome)?` in `src-tauri/src/lib.rs`),
  or leave early with `let … else` (`let Some(home) = home_dir() else { … }` in
  `crates/myapp-cli/src/main.rs`). Use `unwrap_or`, `unwrap_or_default`, or
  `map_or_else` only where the fallback is a correct answer, and say why in a comment
  (`SystemClock::now` in `crates/myapp-platform/src/clock.rs`).
- `?` converts the error through `From`. Where one error wraps another, an
  `impl From<Inner> for Outer` lets `?` do the conversion; without it the `?` fails with
  E0277. In the sample, `impl From<StorageError> for CounterError` is what lets
  `self.store.load()?` compile inside a method returning `CounterError`.
- Errors derive `thiserror::Error`; `anyhow` is not used in a library. Which variants an
  enum has, and what crosses IPC: **REQUIRED:** `designing-errors`, before adding or
  changing a variant.
- Never swallow an error. `let _ = fallible();` carries a comment saying why the failure
  does not matter. In the sample, `write_atomically` in
  `crates/myapp-platform/src/counter_store.rs` ignores a failed temp-file cleanup and says
  why.

## `Option`

`None` is an ordinary answer, not a failure: a store that holds nothing returns
`Ok(None)`, and a value never set is `None`. Read it with `match`, `if let`, `map`,
`ok_or`, or `let … else`, never `unwrap`. In JSON it is `null`; in the sample,
`CounterView::last_changed_at` serializes as `"lastChangedAt": null`.

## Enums and `match`

- Model mutually exclusive states and failures as an enum, not as flags or strings: the
  compiler then checks every place that must decide about each case.
- A `match` on an enum core declares names every variant, with no `_ =>` arm; group
  variants with `A | B =>`. A new variant then fails to compile (E0004) at every place
  that must decide what it means, instead of falling silently into a default. Enforced
  by: `#![deny(clippy::wildcard_enum_match_arm)]` in `crates/myapp-core/src/lib.rs`
  (core only; follow the same rule in the other crates). An enum a foreign crate owns
  may end with `_ =>`. In the sample, `describe` in `crates/myapp-cli/src/main.rs`
  matches every `CounterError` and every `StorageErrorKind` inside it.

## Modules and visibility

- Narrowest first: private, then `pub(crate)`, then `pub`. `pub` is for what another
  crate or a test under `tests/` needs; a helper shared between modules of one crate is
  `pub(crate)`. Everything `crates/myapp-core/src/lib.rs` re-exports is contract
  (`docs/architecture.md` › "What is contract and what is private").
- Every `pub` item has a `///` comment saying why it exists and what it promises
  (`missing_docs`); a fallible `pub fn` has an `# Errors` section and one that can
  panic a `# Panics` section (clippy pedantic). Whether a change owes other
  documentation, and where, is `updating-docs`.
- One module per concern: a directory with `mod.rs` when it has submodules. In the
  sample, `crates/myapp-core/src/counter/mod.rs` has `store.rs` beside it. A constant
  sits beside the code that uses it; there is no `constants.rs` and no `static mut`. The
  Book on modules:
  https://doc.rust-lang.org/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html

## Traits as ports

- A port is a synchronous trait with `Send + Sync` as supertraits and `&self` methods:
  `pub trait Clock: Send + Sync { fn now(&self) -> UnixMillis; }` in
  `crates/myapp-core/src/time.rs`. `Send + Sync` is what lets Tauri's shared state and
  a blocking thread hold it; a type with an `Rc` or a `RefCell` inside is neither, and
  fails with E0277 where it is handed over
  (https://doc.rust-lang.org/book/ch16-04-extensible-concurrency-sync-and-send.html).
- A service stores a port as `Arc<dyn Port>`: one compiled copy and a readable type.
  A function that only calls something once takes `impl Trait`, as the contract
  functions in `crates/myapp-test-support/` take `impl FnMut() -> Box<dyn …>`.
- Derive what callers and tests need: `Debug`, `Clone`, `PartialEq` and `Eq` (so a test
  can `assert_eq!` a value or a `Result`), `Copy` for small value types.
- When a port is needed at all, and why ports never become `async`:
  **BACKGROUND:** `designing-core-logic`.

## Derives for IPC and disk

- A type whose JSON the UI or a file reads uses `#[serde(rename_all = "camelCase")]`,
  so Rust's `last_changed_at` is `lastChangedAt` on the other side. That JSON is
  contract: a field added to a stored type gets `#[serde(default)]` so older files still
  read, and serde's attributes are documented at https://serde.rs/attributes.html.
- A type that crosses IPC also derives `ts_rs::TS` with `#[ts(export)]`; after changing
  one, run `just bindings` and commit `ui/src/ipc/generated/` with it. The rest of that
  path is `designing-ipc`.

## Logging and `unsafe`

- Log with the `tracing` macros and structured fields (`tracing::warn!(command,
  %error, "…")`), never `println!`, `eprintln!`, or `dbg!`: a `.app` started from
  Finder has no terminal, so nobody reads its stdout, while the log file stays. The
  helper CLI's own output to its user is the exception.
- `unsafe` is forbidden in every crate (`unsafe_code = "forbid"`) and is never the fix
  for a borrow-checker error. Edition 2024 makes `std::env::set_var` unsafe
  (https://doc.rust-lang.org/edition-guide/rust-2024/newly-unsafe-functions.html,
  checked 2026-09-29), so configuration arrives as an argument, and a test that needs
  another `HOME` sets it on a child process.

## When the compiler or clippy objects

1. Read the error code and open its page in the error index, then the fix this codebase
   prefers: [references/compiler-errors.md](references/compiler-errors.md) covers
   E0382, E0499, E0502, E0505, E0597, E0277, E0004, and E0308.
2. A clippy finding prints the lint's name and a link to its entry. Fix the code; the
   same reference file lists the findings this repository meets most, with their fixes.
3. Never `#[allow(…)]` or `#[expect(…)]` to get past a check, and never `unsafe`, a
   lifetime annotation, or `.clone()` on a large collection only to silence an error
   you do not understand: `AGENTS.md` › "Security and human approval" counts the first
   two as weakening a gate. If a lint looks wrong for this code, say so in the pull
   request and let a human decide.
4. `just fix` applies rustfmt and ESLint's autofixes; it does not fix clippy findings.
