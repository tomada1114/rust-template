# `unsafe` and framework bindings in `myapp-platform`

What this repository decided about `unsafe`, `objc2`, and C callbacks, and why. How
each binding behaves is its crate's and Apple's documentation, linked rather than
restated. The Rust side of FFI is the Nomicon's
(<https://doc.rust-lang.org/nomicon/ffi.html>).

## Why `unsafe` is forbidden, and what lifting it takes

`unsafe_code = "forbid"` in `Cargo.toml`'s `[workspace.lints.rust]` holds in every
crate. `unsafe` tells the compiler "I have checked what you cannot": the borrow checker
and the type system stop checking inside the block, and a mistake there is memory
corruption rather than a compile error. For a reader new to Rust, the review burden of
one `unsafe` block is higher than a hundred lines of safe code, which is why it has to
be earned.

It is earned only when an adapter needs a framework call that no system command and no
safe crate covers. Then, in one pull request:

1. **An ADR** (`recording-architecture-decisions`), Proposed until the owner accepts it:
   which framework, which calls, why step 2 of the mechanism list (a system command)
   does not answer, and the one module the `unsafe` is confined to.
2. **The dependency review** for each `objc2-*` crate (`managing-dependencies`), with
   `default-features = false` and only the framework features the calls need, and the
   crate declared for macOS only.
3. **The gate change** (`changing-gates`): lifting `forbid` for `myapp-platform` only,
   and turning on `clippy::undocumented_unsafe_blocks` there in the same change, so a
   block without a `// SAFETY:` comment fails `just lint`. It is more than one line: an
   `#[allow(unsafe_code)]` cannot lower a `forbid`
   (<https://doc.rust-lang.org/rustc/lints/levels.html>, checked 2026-09-30), and cargo
   refuses a crate that inherits `[workspace.lints]` and also overrides one of them
   ("cannot override `workspace.lints` in `lints`": observed with cargo 1.98.1,
   2026-09-29), so the crate's `[lints]` table stops inheriting and restates the list
   itself.

Lifting `forbid` to get past a borrow-checker error is weakening a gate
(`AGENTS.md` › "Security and human approval"), whatever the ADR says.

## The shape of an `unsafe` call

- **Confine it.** One module per framework (for example `src/accessibility.rs`), whose
  public items are safe functions or a safe adapter type. No `pub unsafe fn` leaves the
  module; the caller never has to reason about the invariant.
- **Keep each block to the one call.** Compute the arguments in safe code before the
  block and convert the result after it, so the block holds only what needs `unsafe`.
- **Write the `// SAFETY:` comment against the binding's own Safety section.** It
  states which requirement the call must meet and why this call meets it, not that the
  author was careful.

An illustration of a port an app might add (nothing in the template declares it):

```rust
#[cfg(target_os = "macos")]
use objc2_application_services::AXIsProcessTrustedWithOptions;

/// Whether this process may use the Accessibility API right now.
#[cfg(target_os = "macos")]
pub fn is_accessibility_trusted() -> bool {
    // SAFETY: the binding's only stated requirement is that the options dictionary's
    // generics have the correct type; `None` passes no dictionary at all.
    unsafe { AXIsProcessTrustedWithOptions(None) }
}
```

The Safety requirement quoted there is the one docs.rs lists for this function
(<https://docs.rs/objc2-application-services/latest/objc2_application_services/fn.AXIsProcessTrustedWithOptions.html>,
checked 2026-09-29). Re-read it when the crate's version changes: a binding's Safety
section is part of its API.

## Main-thread-only framework calls

Much of AppKit may only be touched on the main thread. `objc2` encodes that:
`MainThreadMarker::new()` returns `None` off the main thread, and the marker is
`!Send`, so it cannot be smuggled to another thread
(<https://docs.rs/objc2/latest/objc2/struct.MainThreadMarker.html>, checked 2026-09-29).

`myapp` runs each subcommand and the TUI loop on the process's main thread, so a call
an adapter makes from a handler is on it, and a call from a thread the binary started
(to keep the TUI responsive, say) is not. The decisions:

- **The adapter checks, and fails softly.** It takes a `MainThreadMarker` from
  `MainThreadMarker::new()` and turns `None` into a core error kind rather than a
  panic, because a panic in a release build aborts the tool (`designing-errors`).
- **The binary decides the thread.** `myapp-platform` cannot see which thread the
  binary will call it from, so a port whose adapter needs the main thread says so in
  its `///`, and the binary calls it from the handler or the loop, never from a thread
  it spawned.
- **Never wait on the main thread for the main thread.** The hang to avoid is the main
  thread blocking on a result that another thread can only produce by posting back to
  the main thread. Some framework calls also need a running run loop on the main
  thread, which a plain command-line process does not start; if the API's Apple page
  says so, that is a design question for the ADR, not something to discover in a test.

## C callbacks

A framework that reports through a C function pointer (an observer, an event tap) gives
the callback no captured environment: everything it needs arrives through a context
pointer the registration passed in.

- **The context is a manual lifetime.** Allocate it with `Box::into_raw(Box::new(…))`,
  pass the raw pointer at registration, and reclaim it with `Box::from_raw` exactly once,
  after unregistering. Reclaiming it twice, or while the registration is live, is a
  use-after-free; never reclaiming it is a leak.
- **The callback translates and hands off.** It turns the framework's arguments into a
  core value and sends it (a channel, or a callback the binary supplied), then returns.
  It does no work of its own: a slow callback can make the OS switch the source off.
  When a framework reports that it disabled the source (an event tap receives it as an
  event type through the same callback), re-enable it there; ignored, the adapter
  silently stops receiving anything.
- **No panic reaches the boundary.** With `panic = "abort"` in release a panic in the
  callback ends the tool; in a debug build, unwinding out of an `extern "C"` function is
  governed by the Nomicon's rules above. Handle every `Result` inside.
- **Teardown mirrors setup, in one place.** Disable, unregister, remove any run-loop
  source, then reclaim the context last, because a callback may still be unwinding
  through it. Put that sequence in one `stop()` (called by the adapter's `Drop` if the
  handle owns the registration), and make it safe to call twice.

## What not to reach for

| The compiler says | The fix |
|---|---|
| `` `*mut c_void` cannot be sent between threads safely `` (E0277, a missing trait: <https://doc.rust-lang.org/error_codes/E0277.html>) | Do not send it. Keep the registration on its thread; send the value the callback built. |
| a framework type is not `Send`, and the port needs `Send + Sync` | Translate to a core value inside the adapter; never `unsafe impl Send`. |
| a closure passed to C cannot capture | Use a plain `extern "C" fn` and put the state behind the context pointer. |
| a borrow-checker error inside FFI code | Restructure the safe code around the block; `unsafe` is never the fix for a borrow error (`.claude/rules/rust.md` › "Unsafe"). |
