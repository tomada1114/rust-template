# TCC-gated APIs

What this repository decided about APIs behind a privacy (TCC) permission, and why. What
each API returns is Apple's to document and is linked. Every decision below rests on one
property: **TCC tells the app nothing.** A refused call fails quietly (a `false`, an
empty result, a creation that returns nothing) and a new grant arrives with no callback.
The app finds out by asking again.

## Checking and prompting

`AXIsProcessTrustedWithOptions` answers whether the process is a trusted Accessibility
client, and with the `kAXTrustedCheckOptionPrompt` option also asks the system to tell
the user. Apple: "Prompting occurs asynchronously and does not affect the return value"
(<https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions>,
checked 2026-09-29). So:

- **The answer to a prompting call is from before the user reacted.** Never store it as
  the new state; ask again later.
- **Prompt when the user first reaches for the feature that needs it, never at
  launch.** Before the user knows what the app is for, the prompt reads as a demand.
  This repository treats it as spendable once per app per user: a prompt shown again
  and again trains the user to dismiss it.
- **Checking is cheap and side-effect free** without the prompt option; do it as often
  as the state needs.

The same shape holds for the other grants: find the call that checks without prompting
and the one that prompts, and put both behind one port.

## The gate lives in core

What to show while the grant is missing, whether the prompt was already spent, and when
to check again are decisions, so they live in core behind a port, tested with a fake
whose answer the test sets. The adapter only answers "trusted now?" and "prompt".

An illustration of the core side an app might add (nothing in the template declares it):

```rust
/// Whether this process holds a privacy grant. Implemented by a platform adapter; a
/// test hands core a fake whose answer it sets.
pub trait GrantCheck: Send + Sync {
    /// Whether the grant is held right now. No side effect.
    fn is_granted(&self) -> bool;
    /// Ask macOS to show its prompt. The outcome arrives later, if ever.
    fn prompt(&self);
}

/// What the screen shows. A state transition returns the new state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Unknown,
    Blocked { prompted: bool },
    Ready,
}
```

Refreshing, prompting at most once, and what `Blocked` renders are methods on the core
type that owns the gate, each with a test against the fake (`designing-core-logic`,
`tdd`). The view that crosses IPC is a DTO in core like any other (`designing-ipc`).

## The grant arrives with no callback

The user leaves the app, opens System Settings › Privacy & Security, flips a switch, and
comes back. Nothing in the app was called. Two answers, in this order:

1. **Re-check when the window gains focus.** Returning to the app is the one signal
   that follows a change in System Settings. Tauri reports it as
   `WindowEvent::Focused(true)` (<https://docs.rs/tauri/latest/tauri/enum.WindowEvent.html>,
   checked 2026-09-29); the shell handles the event by calling core's refresh and
   emitting the new view.
2. **Poll only while blocked and visible,** about once a second, and stop the moment
   the answer turns true. It covers a grant given without leaving the app, and costs
   nothing while ready.

Some APIs need re-arming, not only re-checking: a registration attempted while
untrusted never happened. Model that as "the gate turned ready, so start", not as a retry
loop.

## Degraded, not broken

A missing grant is a state the user can leave, so the app stays usable and says what is
missing and how to fix it: name the permission as System Settings names it, and offer
one action that gets the user there rather than a paragraph describing where to click.
The wording lives in `ui/src/copy/` like any other (`building-react-screens`).

## Usage-description keys

Some TCC-gated APIs require an `NS…UsageDescription` key in the app's `Info.plist`, and
the system ends the process at the call when the key is missing, which is worse than a
refusal. Tauri merges a `src-tauri/Info.plist` into the bundle's generated one
(<https://v2.tauri.app/distribute/macos-application-bundle/>, checked 2026-09-29); the
template ships none. Add the key the API's Apple page names, in the pull request that
adds the API. Not every permission has one: check the API's own page rather than
assuming either way.

## The grant your own rebuild destroys

Local builds are ad-hoc signed (`signingIdentity: "-"` in `src-tauri/tauri.conf.json`,
and every building recipe unsets the `APPLE_*` variables). TCC identifies an app by its
code signature, and an ad-hoc signature changes with every build, so each rebuild looks
like a different app and the grant given a minute ago no longer applies. Apple's DTS
recommends a stable signing identity for day-to-day work with TCC
(<https://developer.apple.com/forums/thread/730043>, checked 2026-09-29; the mechanism is
the designated requirement, <https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements>).

This is the reason an agent debugging a TCC feature concludes the code is broken when it
is not. How an app that needs grants signs its local builds is that app's decision, in
an ADR (`docs/getting-started.md` › "Permissions (TCC)"); signing settings are a
sign-off change (`AGENTS.md` › "Security and human approval"). After switching
signing, or when System Settings shows an entry that grants nothing,
`just reset-permissions` (a human's recipe) makes macOS forget this app's decisions, and
only this app's, so the next launch asks again.

## The human hand-off

Every TCC step needs a person: the prompt is a system window, and System Settings is
another app, which an agent never drives (`AGENTS.md` › "Never taking over the
developer's Mac"). Ask once, in one message, before the loop starts:

- which permission, and for which process: the app itself, or, for `just test-local`,
  the terminal that runs the tests, since macOS judges a privacy request by its
  responsible code, and for a tool run from Terminal that is Terminal
  (<https://developer.apple.com/forums/thread/760964>, checked 2026-09-29);
- the order of the steps (build, run, grant, run again) and the recipe for each
  (`just run` and `just test-local` are human recipes);
- what to send back: the `just test-local` output, and what the window showed.

Asking once per iteration turns a five-minute check into an afternoon. Then read
`just logs` yourself for what the app recorded (`running-the-app`).

## Tests that need a grant

A test that needs a grant carries `#[ignore = "local machine: <grant> for <process>"]`,
so `just test-macos` and CI report it as ignored and only `just test-local` (a human's
recipe) runs it.
When the grant is missing the OS answers "no" rather than failing, so make the test's
failure message name the grant and where to give it: a bare `false` reads as a broken
adapter.
