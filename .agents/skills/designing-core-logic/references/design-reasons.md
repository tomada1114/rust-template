# Why the crates and ports are shaped this way

The reasons behind the layers every app starts with. The rules themselves are in
`AGENTS.md` › "Architecture"; a change that replaces one of these layers rewrites its
paragraph here, in the present tense, rather than leaving the old reason beside the new
one (`AGENTS.md` › "Before changing the architecture").

## A Cargo workspace, with the logic in its own crate

A single crate cannot keep OS code out of the logic: nothing would stop a rule from
reading a file or the clock, and its tests would link the real adapters. So the
repository root is a virtual workspace: `crates/myapp-core` holds the rules and state,
`crates/myapp-platform` the OS adapters, `crates/myapp-test-support` the fakes, and
`crates/myapp` the binary, the only place the adapters are wired to core. The split
makes the dependency direction reviewable and lets core build and test on Linux with no
operating-system code at all.

- No crate is named `core`: that name collides with Rust's built-in `core` library.
  Every app crate carries the slug as its prefix instead.
- A repository per layer is not used: it would cost a release process per layer for a
  personal tool.

## Ports and adapters, with synchronous ports

Core declares each thing it needs from outside the process — storage, time, a model
provider — as a `Send + Sync` trait over types it owns. `myapp-platform` implements it
for real, `myapp-test-support` as a fake, and the binary picks the real one. Ports are
plain synchronous methods, so a reader new to Rust meets no async in core and core never
depends on a runtime. Errors are typed variants the binary turns into words and an exit
code, never sentences from core (`designing-errors`). One contract function per port
runs against both the fake and the real adapter, so the fake cannot drift from the real
thing without a test failing.

## The boundary is enforced three times

A rule that lives only in prose drifts. Core's `Cargo.toml` names no OS crate, so core
cannot compile a call into one; a harness check reads `cargo metadata` and fails if
core's dependency closure ever gains a macOS binding crate or `myapp-platform`; and
`cargo deny`'s `wrappers` rule allows `myapp-platform` as a direct dependency of the
binary only. Three independent mechanisms mean removing one leaves the others. clippy,
configured in `crates/myapp-core/clippy.toml`, adds the call-level layer, so I/O, time,
and the environment arrive only through ports or arguments.

No gate stops core from naming clap, ratatui, or crossterm; review holds that line, so
a screen's state machine stays testable with plain values (`building-tuis`).

## The coverage floor sits on core

The floor (lines and functions, measured by `cargo llvm-cov`; the numbers are in the
justfile's `test-core` recipe) sits where the decisions are. The platform crate and the
binary translate and decide nothing, so a numeric gate there would only invite tests of
glue. That is a constraint, not a licence: the moment an adapter or a handler needs a
decision, the decision moves into core behind the port, where the floor sees it.

## The sample is a counter

It is small enough to delete and still exercises every part the architecture claims: a
port with a real adapter, a fake, and a contract suite (`CounterStore`, writing
`counter.json` atomically under a lock); injected time (`Clock`); subcommands and a
full-screen view over the same service, with the screen's state and keys in core;
logging; typed errors with their wording in one module; and a help line naming every
key. Every part of it is an illustration to replace (`starting-an-app` › "Remove the
sample").
