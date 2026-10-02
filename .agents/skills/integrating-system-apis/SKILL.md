---
name: integrating-system-apis
description: >
  Covers reaching the OS from crates/myapp-platform on macOS and Linux: the port in
  myapp-core first, an adapter per OS behind cfg(target_os = "macos") or
  cfg(target_os = "linux") with one contract suite, the data and log directories
  (~/Library, XDG_DATA_HOME, XDG_STATE_HOME), choosing the mechanism (the standard
  library, then a system command through std::process::Command such as launchctl,
  plutil, or defaults, then a binding crate such as objc2), unsafe and the // SAFETY:
  comment once an ADR lifts unsafe_code = "forbid" for myapp-platform, MainThreadMarker,
  C callbacks, TCC-gated APIs (Accessibility, Input Monitoring, Screen Recording,
  AXIsProcessTrustedWithOptions) and the terminal as the responsible process, and what
  can be tested where. Use when adding or changing an adapter that reaches the OS, an
  OS-specific crate or code path, writing unsafe, spawning a system tool, porting an
  adapter to Linux, or when a permission prompt never answers or a test needs a grant.
---

# Integrating System APIs

**Owns:** reaching macOS and Linux from `myapp-platform`: which mechanism, how each OS
gets its adapter, how failures and threads stay inside the adapter, the `unsafe` policy,
how a TCC grant behaves, and what can be tested where. **Does not own:** the decision
the port serves and its test loop (`designing-core-logic`, `tdd`); the error enum's
shape (`designing-errors`); adding the crate (`managing-dependencies`) or the ADR
(`recording-architecture-decisions`); changing the lint that forbids `unsafe`
(`changing-gates`); watching the running tool (`running-the-app`).

## The port comes first

Every integration is the same pieces, and the sample ships one of each to copy
(`docs/architecture.md` › "Ports and adapters"):

| Piece | Where | In the sample |
|---|---|---|
| Port: a synchronous `Send + Sync` trait over core's own types | `crates/myapp-core` | `CounterStore`, `Clock` |
| Adapter: the OS call, translation only | `crates/myapp-platform` | `JsonFileCounterStore`, `SystemClock` |
| Fake: a real implementation answering from test data | `crates/myapp-test-support` | `InMemoryCounterStore`, `FixedClock` |
| Contract: the port's promises, run against both | `crates/myapp-test-support` | `counter_store_contract`, `clock_contract` |
| Local-machine test: the adapter against a real, granted machine | `crates/myapp-platform/tests/` | none (the sample needs no grant) |

Write the port before the adapter. Its signature is where the OS type collapses into a
value core owns; an adapter written first leaks one. A port is `Send + Sync` so the
binary may call it from any thread, so it can hold no main-thread-only framework
object, no raw pointer, and no `objc2` retained object: translate inside the adapter
and return plain data. Every decision (when to ask for a grant, what a blocked state
shows, what a result means) is core's, tested with the fake; a new port is an ADR.

## Each OS gets its adapter

`myapp-platform` builds and runs its tests on macOS and Linux: `just test-platform` runs
in CI's `Rust Core` (Linux) and `macOS` jobs.

| Adapter or function | macOS | Linux |
|---|---|---|
| `JsonFileCounterStore`, `SystemClock`, `init_logging` | yes | yes |
| `app_data_dir`, `counter_file` | `~/Library/Application Support/<bundle id>` | `$XDG_DATA_HOME/myapp`, default `~/.local/share/myapp` |
| `log_dir` | `~/Library/Logs/<bundle id>` | `$XDG_STATE_HOME/myapp/logs`, default `~/.local/state/myapp/logs` |

The Linux paths follow the XDG Base Directory Specification
(<https://specifications.freedesktop.org/basedir-spec/latest/>, checked 2026-10-01): an
unset, empty, or relative variable takes the default.

- **Map in a pure function, select by `cfg`.** Each mapping is a pure function of its
  inputs, unit-tested on any host (`macos_log_dir`, `xdg_log_dir`, and their
  data-directory pairs); only the selection is `cfg!(target_os = "macos")`
  (`app_data_dir`, `log_dir`). The same split works for anything that differs per OS:
  the parsing of a tool's output, the choice of a path.
- **One port, one adapter per OS when the mechanism differs.** Both implement the same
  port, each behind `#[cfg(target_os = "macos")]` or `#[cfg(target_os = "linux")]`,
  and the contract runs against whichever one the host builds, with the same `cfg` on
  the test. Core sees one trait and never learns which OS it runs on.
- **An OS with no mechanism still answers.** When Linux has nothing to offer for a
  feature, its adapter returns a core kind meaning "not available here", and core
  decides what the user is told. Say which OS supports what in the table above.

## Choosing the mechanism

Take the first that answers the question. Each step down costs more: a binding crate,
`unsafe`, a grant the user must give, and code one CI runner cannot compile.

1. **The standard library or an existing dependency.** Files, directories, the clock,
   the environment. In the sample, `JsonFileCounterStore` needs nothing else: even its
   advisory lock is the standard library's `File::lock`, so one adapter serves both.
2. **A system command**, through `std::process::Command`: on macOS, `launchctl` for
   launchd jobs, `plutil` to read or convert a property list, `defaults` for
   preferences; on Linux, the distribution's own tool. No `unsafe`, no new crate, and
   the tool's behavior is in its man page. Core cannot do this
   (`crates/myapp-core/clippy.toml` bans `std::process::Command` there), so it lives in
   the adapter. The rules are below.
3. **A binding crate**, when no command answers: on macOS the `objc2` runtime and its
   per-framework `objc2-*` crates for an AppKit or ApplicationServices call
   (<https://docs.rs/objc2/latest/objc2/>, objc2 0.6.4, checked 2026-09-29); on Linux
   a crate for the service in question. Most framework calls are `unsafe fn`:
   `AXIsProcessTrustedWithOptions` is `pub unsafe extern "C-unwind" fn` behind the
   `AXUIElement` and `HIServices` features of `objc2-application-services` 0.3.2
   (<https://docs.rs/objc2-application-services/latest/objc2_application_services/fn.AXIsProcessTrustedWithOptions.html>,
   checked 2026-09-29). So this step usually means `unsafe`, which every crate forbids
   today: **REQUIRED:** [references/unsafe-and-ffi.md](references/unsafe-and-ffi.md)
   before writing it.

Between two mechanisms that both work, take the one whose permission is cheaper: a
grant is a prompt the user may refuse, and each one is support work (see "TCC" below).

## A system command, done right

- **An absolute path in a `const`**, chosen per OS (`/bin/launchctl`,
  `/usr/bin/plutil`, `/usr/bin/defaults` on macOS: observed with `ls -l`, macOS 27.0,
  2026-09-29), so the adapter does not depend on the `PATH` the tool was started with.
  Where the location varies between Linux distributions, a missing tool is an `Err`
  of a core kind, never a panic.
- **Each argument through `.arg()`, never `sh -c`.** `Command` passes arguments to the
  program literally, with no shell parsing
  (<https://doc.rust-lang.org/std/process/struct.Command.html>, checked 2026-09-29), so
  a path with a space or a quote cannot turn into a second command.
- **Ask for machine-readable output and parse it.** `plutil -convert json -o - <file>`
  prints a property list as JSON for `serde_json` (observed on this Mac, 2026-09-29).
  Never match a tool's human-readable text with a regex: its wording changes between
  releases and locales.
- **Map the result to the port's error.** `output()` returns the exit status and both
  streams; a non-zero status becomes a core kind with the exit code as a number, and
  the tool's stderr stays out of the error, since it can quote a path
  (`designing-errors`).
- **The call blocks**, which is why the port is synchronous: a subcommand waits for it,
  and a slow one in the TUI is the binary's to move off the loop
  (`designing-core-logic`).
- **A command that changes the machine** (`launchctl bootstrap`, `defaults write`, a
  service manager's enable) is never run by a routine test: it would change the
  developer's own session. Its adapter test is `#[ignore = "local machine: …"]`, cleans
  up after itself, and runs in `just test-local`, a human's recipe.

## Code that only compiles on one OS

Anything that names a macOS framework or a Linux-only interface, or a crate that only
builds there, sits behind `#[cfg(target_os = "…")]`, with the crate under
`[target.'cfg(target_os = "…")'.dependencies]` in `myapp-platform`'s `Cargo.toml`
(the version still written once in the root's `[workspace.dependencies]`). Its tests
carry the same `cfg`. A system-command adapter compiles everywhere; its tests that call
the real tool are restricted to their OS in the same way.

## Three rules that never bend

1. **Only values cross the port.** A framework object may be tied to the main thread or
   recycled once a callback returns. Build the port's value inside the adapter, then
   return it.
2. **Never `unsafe impl Send` or `unsafe impl Sync`** to make a framework type fit a
   port. The compiler is right that it is not thread-safe, and the `// SAFETY:` proof
   would be a claim about the vendor's threading that the vendor does not document.
   Keep the object where it was made and expose values.
3. **Tear down in the reverse order of setup**, in one place, before anything the OS
   still points at is freed (a callback's context, a registration). The reference has
   the shape.

## TCC: permissions macOS makes the user give

Accessibility, Input Monitoring, Screen Recording, Full Disk Access and the rest are
granted by the user in System Settings, and a TCC permission is an ADR decision
(`AGENTS.md` › "Before changing the architecture"). The property every decision rests
on: TCC tells the program nothing. A refusal returns nothing or `false`, and a grant
arrives with no callback. A tool run from a terminal adds a second trap: macOS may
attribute the request to the terminal rather than to `myapp`. **REQUIRED:**
[references/tcc-permissions.md](references/tcc-permissions.md) when the API is
TCC-gated. Linux has no TCC; a refused permission there surfaces as an ordinary error
(`io::ErrorKind::PermissionDenied`), mapped to a core kind like any other.

## What can be tested where

| Question | Answered by |
|---|---|
| What the tool decides with the OS's answer (blocked, ready, not available here) | core tests against the fake, on Linux, inside the coverage floor (`just test-core`) |
| Whether an adapter keeps the port's promises where no grant is needed | the contract test against the real adapter, on each OS it builds for (`just test-platform`; CI's Linux and macOS jobs) |
| Whether it does so with a grant, a GUI session, or a change to the machine | `#[ignore = "local machine: <what it needs>"]`, run by a human with `just test-local`, output pasted in the pull request |
| Whether the whole grant flow works | a human, by hand (`running-the-app`) |

A CI runner has no logged-in session and cannot be granted a permission, so the third
row is reported as ignored, visibly, rather than missing. That makes the design rule:
**anything a gate cannot reach holds no decision.** Push the decision into core, leave
the adapter with translation only, and the part no machine verifies shrinks to the part
no machine could have verified anyway.

## Before you call it done

- [ ] The port takes and returns core types only; core's `Cargo.toml` names no OS crate
      (`just check-harness` fails when core's closure reaches `objc2*` or similar).
- [ ] The adapter maps every OS failure to a core error kind, and carries no OS text.
- [ ] OS-specific code and its crates are behind `cfg(target_os = …)`. No local run
      proves it for the other OS: on a Mac the macOS `cfg` is true, so `just lint` and
      `just test-core` pass with it misplaced. CI's `Rust Core` (Linux) and `macOS`
      jobs are the check; read both results on the pull request (`gh pr checks`).
- [ ] Every `unsafe` block has a `// SAFETY:` comment, inside the one module the ADR
      allows; no `unsafe impl Send`/`Sync`.
- [ ] The port's fake and contract function exist; the contract runs against the fake
      and against each OS's adapter.
- [ ] A test needing a grant or changing the machine is `#[ignore = "local machine: …"]`,
      and the pull request carries `just test-local` output (run by a human).
