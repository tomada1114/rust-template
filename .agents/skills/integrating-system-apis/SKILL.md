---
name: integrating-system-apis
description: >
  Covers calling macOS from crates/myapp-platform: the port in myapp-core that comes
  first, choosing the mechanism (the standard library, then a system command such as
  launchctl, plutil, or defaults through std::process::Command, then objc2 framework
  bindings), unsafe and the // SAFETY: comment once an ADR lifts unsafe_code = "forbid"
  for myapp-platform, main-thread-only AppKit calls and MainThreadMarker, C callbacks,
  cfg(target_os = "macos") so the crate still builds on Linux CI, TCC-gated APIs
  (Accessibility, Input Monitoring, Screen Recording, AXIsProcessTrustedWithOptions), a
  grant lost on every ad-hoc rebuild, Info.plist usage keys, and what can be tested
  where. Use when adding or changing an adapter that reaches the OS, adding an objc2-*
  crate, writing unsafe, spawning a system tool, or when a permission prompt never
  answers or a test needs a grant.
---

# Integrating System APIs

**Owns:** reaching macOS from `myapp-platform`: which mechanism, how its failures and
threads stay inside the adapter, the `unsafe` policy, how a TCC grant behaves, and what
can be tested where. **Does not own:** whether the app is sandboxed or what shape it
takes (`starting-an-app`); the decision the port serves and its test loop
(`designing-core-logic`, `tdd`); the error enum's shape (`designing-errors`); adding the
crate (`managing-dependencies`) or the ADR (`recording-architecture-decisions`);
changing the lint that forbids `unsafe` (`changing-gates`); watching the running app
(`running-the-app`).

## The port comes first

Every integration is the same pieces, and the sample ships one of each to copy
(`docs/architecture.md` › "Ports and adapters"):

| Piece | Where | In the sample |
|---|---|---|
| Port: a synchronous `Send + Sync` trait over core's own types | `crates/myapp-core` | `CounterStore`, `Clock` |
| Adapter: the OS call, translation only | `crates/myapp-platform` | `JsonFileCounterStore`, `SystemClock` |
| Fake: a real implementation answering from test data | `crates/myapp-test-support` | `InMemoryCounterStore`, `FixedClock` |
| Contract: the port's promises, run against both | `crates/myapp-test-support` | `counter_store_contract` |
| Local-machine test: the adapter against a real, granted Mac | `crates/myapp-platform/tests/` | none (the sample needs no grant) |

Write the port before the adapter. Its signature is where the OS type collapses into a
value core owns; an adapter written first leaks one. A port is `Send + Sync` because the
shell calls it from a blocking thread, so it can hold no main-thread-only framework
object, no raw pointer, and no `objc2` retained object: translate inside the adapter
and return plain data. Every decision (when to ask for a grant, what a blocked state
shows, what a result means) is core's, tested with the fake; a new port is an ADR.

## Choosing the mechanism

Take the first that answers the question. Each step down costs more: a binding crate,
`unsafe`, a grant the user must give, and code no Linux runner can compile.

1. **The standard library or an existing dependency.** Files, directories, the clock.
   In the sample, `JsonFileCounterStore` needs nothing else.
2. **A system command**, through `std::process::Command`: `launchctl` for launchd jobs,
   `plutil` to read or convert a property list, `defaults` for preferences. No `unsafe`,
   no new crate, and the tool's behaviour is in its man page. Core cannot do this
   (`crates/myapp-core/clippy.toml` bans `std::process::Command` there), so it lives in
   the adapter. The rules are below.
3. **`objc2` framework bindings**, when no command answers (an AppKit or
   ApplicationServices call). `objc2` is the runtime and `objc2-*` crates are the
   per-framework bindings (<https://docs.rs/objc2/latest/objc2/>, objc2 0.6.4, checked
   2026-09-29). Most framework calls are `unsafe fn`: `AXIsProcessTrustedWithOptions` is
   `pub unsafe extern "C-unwind" fn` behind the `AXUIElement` and `HIServices` features
   of `objc2-application-services` 0.3.2
   (<https://docs.rs/objc2-application-services/latest/objc2_application_services/fn.AXIsProcessTrustedWithOptions.html>,
   checked 2026-09-29). So this step means `unsafe`, which every crate forbids today:
   **REQUIRED:** [references/unsafe-and-ffi.md](references/unsafe-and-ffi.md) before
   writing it.

Between two mechanisms that both work, take the one whose TCC grant is cheaper: a grant
is a prompt the user may refuse, and each one is support work (see "TCC" below).

The choice also fixes the sandbox posture. Apple lists what a sandboxed app may not do,
among it using accessibility APIs in assistive apps, sending Apple Events to arbitrary
apps, and reading or changing another app's preferences
(<https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox>,
checked 2026-09-29; the same page makes the sandbox an App Store requirement), so an
adapter that needs one keeps the app out of both for as long as it ships. Turning the
sandbox on is a human's ADR decision (`starting-an-app`); name the adapter's effect on it
in the pull request.

## A system command, done right

- **An absolute path in a `const`** (`/bin/launchctl`, `/usr/bin/plutil`,
  `/usr/bin/defaults`: observed on this Mac with `ls -l`, macOS 27.0, 2026-09-29), so
  the adapter does not depend on the `PATH` the app was launched with.
- **Each argument through `.arg()`, never `sh -c`.** `Command` passes arguments to the
  program literally, with no shell parsing
  (<https://doc.rust-lang.org/std/process/struct.Command.html>, checked 2026-09-29), so
  a path with a space or a quote cannot turn into a second command.
- **Ask for machine-readable output and parse it.** `plutil -convert json -o - <file>`
  prints a property list as JSON for `serde_json` (observed on this Mac, 2026-09-29).
  Never match a tool's human-readable text with a regex: its wording changes between
  macOS releases.
- **Map the result to the port's error.** `output()` returns the exit status and both
  streams; a non-zero status becomes a core kind with the exit code as a number, and
  the tool's stderr stays out of the error, since it can quote a path
  (`designing-errors`).
- **The call blocks**, which is why the port is synchronous and the shell runs it with
  `spawn_blocking` (`designing-ipc`).
- **A command that changes the Mac** (`launchctl bootstrap`, `defaults write`) is never
  run by a routine test: it would change the developer's own session. Its adapter test
  is `#[ignore = "local machine: …"]`, cleans up after itself, and runs in
  `just test-local`, a human's recipe.

## Code that only compiles on macOS

`just test-core` builds and tests `myapp-platform` on Linux CI. Anything that names a
macOS framework, or a crate that only builds there, sits behind
`#[cfg(target_os = "macos")]`, with the crate under
`[target.'cfg(target_os = "macos")'.dependencies]` in `myapp-platform`'s `Cargo.toml`
(the version still written once in the root's `[workspace.dependencies]`). Its tests
carry the same `cfg`. A system-command adapter compiles everywhere; its tests that call
the real tool are macOS-only in the same way.

## Three rules that never bend

1. **Only values cross the port.** A framework object may be tied to the main thread or
   recycled once a callback returns. Build the port's value inside the adapter, then
   return it.
2. **Never `unsafe impl Send` or `unsafe impl Sync`** to make a framework type fit a
   port. The compiler is right that it is not thread-safe, and the `// SAFETY:` proof
   would be a claim about Apple's threading that Apple does not document. Keep the
   object where it was made and expose values.
3. **Tear down in the reverse order of setup**, in one place, before anything the OS
   still points at is freed (a callback's context, a registration). The reference has
   the shape.

## TCC: permissions the app must ask for

Accessibility, Input Monitoring, Screen Recording, Full Disk Access and the rest are
granted by the user in System Settings, and a TCC permission is an ADR decision
(`AGENTS.md` › "Before changing the architecture"). The property every decision rests
on: TCC tells the app nothing. A refusal returns nothing or `false`, and a grant arrives
with no callback. **REQUIRED:**
[references/tcc-permissions.md](references/tcc-permissions.md) when the API is TCC-gated:
checking and prompting, the gate state that lives in core, re-checking on focus, the
grant an ad-hoc rebuild loses, `Info.plist` usage keys, and the human hand-off.

## What can be tested where

| Question | Answered by |
|---|---|
| What the app decides with the OS's answer (blocked, ready, when to prompt) | core tests against the fake, on Linux, inside the coverage floor (`just test-core`) |
| Whether the adapter keeps the port's promises where no grant is needed | the contract test against the real adapter (`just test-macos`) |
| Whether it does so with a grant, a GUI session, or a change to the Mac | `#[ignore = "local machine: <what it needs>"]`, run by a human with `just test-local`, output pasted in the pull request |
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
- [ ] macOS-only code and its crates are behind `cfg(target_os = "macos")`. No local
      run proves it: on a Mac the `cfg` is true, so `just lint` and `just test-core`
      pass with it misplaced. CI's `Rust Core` job, on Linux, is the check; read its
      result on the pull request (`gh pr checks`).
- [ ] Every `unsafe` block has a `// SAFETY:` comment, inside the one module the ADR
      allows; no `unsafe impl Send`/`Sync`.
- [ ] The port's fake and contract function exist; the contract runs against both.
- [ ] A test needing a grant or changing the Mac is `#[ignore = "local machine: …"]`,
      and the pull request carries `just test-local` output (run by a human).
