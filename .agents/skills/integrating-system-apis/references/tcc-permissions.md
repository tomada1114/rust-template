# TCC-gated APIs

What this repository decided about APIs behind a privacy (TCC) permission, and why. What
each API returns is Apple's to document and is linked. Every decision below rests on one
property: **TCC tells the program nothing.** A refused call fails quietly (a `false`, an
empty result, a creation that returns nothing) and a new grant arrives with no callback.
The tool finds out by asking again.

## Checking and prompting

`AXIsProcessTrustedWithOptions` answers whether the process is a trusted Accessibility
client, and with the `kAXTrustedCheckOptionPrompt` option also asks the system to tell
the user. Apple: "Prompting occurs asynchronously and does not affect the return value"
(<https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions>,
checked 2026-09-29). So:

- **The answer to a prompting call is from before the user answered.** Never store it as
  the new state; ask again later.
- **Prompt when the user first reaches for the feature that needs it, never at
  launch.** Before the user knows what the tool is for, the prompt reads as a demand.
  This repository treats it as spendable once per program per user: a prompt shown again
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

Refreshing, prompting at most once, and what `Blocked` shows are methods on the core
type that owns the gate, each with a test against the fake (`designing-core-logic`,
`tdd`). A subcommand prints the resulting view and a TUI screen draws it, like any
other.

## The grant arrives with no callback

The user leaves the tool, opens System Settings › Privacy & Security, flips a switch, and
comes back. Nothing in the tool was called. So the tool asks again:

1. **A subcommand checks on every run.** Each run is a new process that reads the
   answer fresh; a blocked run exits 1 with wording that names the permission, and the
   next run after the grant simply works.
2. **The TUI re-checks on the user's word, and on a tick only while blocked.** Give
   the blocked screen a key that retries (an action in core's key table, named on the
   help line), and, if the screen should notice by itself, a tick the loop turns into a
   refresh action about once a second, stopped the moment the answer turns true. It
   costs nothing while ready (`building-tuis`).

Some APIs need re-arming, not only re-checking: a registration attempted while
untrusted never happened. Model that as "the gate turned ready, so start", not as a retry
loop.

## Degraded, not broken

A missing grant is a state the user can leave, so the tool stays usable and says what is
missing and how to fix it: name the permission as System Settings names it, and say
which program to grant it to (see "Which program holds the grant" below). The wording
lives in `crates/myapp/src/wording.rs` like any other.

## Usage-description keys

Some TCC-gated APIs require an `NS…UsageDescription` key in the program's `Info.plist`,
and the system ends the process at the call when the key is missing, which is worse
than a refusal. `myapp` is a bare binary with no bundle and no `Info.plist`, so an API
that needs a key also needs a decision on how the binary carries one: an ADR, in the
pull request that adds the API. Not every permission has a key: check the API's own
Apple page rather than assuming either way.

## Which program holds the grant

TCC judges a privacy request by its responsible code, and for a tool run from Terminal
that is Terminal (<https://developer.apple.com/forums/thread/760964>, checked
2026-09-29). So the entry the user flips in System Settings may be their terminal app
rather than `myapp`. Say in the hand-off which entry to look for, and treat "it works
from my terminal" as evidence about that terminal, not about `myapp` started some other
way (a scheduled job, another terminal app).

When the grant is held by a program's own signature, TCC identifies the program by its
code signature, and a build whose signature changes with every build looks like a new
program each time, so a grant given a minute ago no longer applies. Apple's DTS
recommends a stable signing identity for day-to-day work with TCC
(<https://developer.apple.com/forums/thread/730043>, checked 2026-09-29; the mechanism
is the designated requirement,
<https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements>).
This is the reason an agent debugging a TCC feature concludes the code is broken when it
is not. How an app that needs grants signs its builds is that app's decision, in an
ADR; signing settings are a sign-off change (`AGENTS.md` › "Security and human
approval"). When System Settings shows an entry that grants nothing, `tccutil reset`
(a human's step; `man tccutil`) makes macOS forget a program's decisions so the next
run asks again.

## The human hand-off

Every TCC step needs a person: the prompt is a system window, and System Settings is
another app, which an agent never drives (`AGENTS.md` › "Never taking over the
developer's Mac"). Ask once, in one message, before the loop starts:

- which permission, and for which program: usually the terminal that runs `myapp` or
  `just test-local` (see "Which program holds the grant");
- the order of the steps (build, run, grant, run again) and the recipe for each
  (`just test-local` is a human recipe);
- what to send back: the `just test-local` output, and what the tool printed or the
  screen showed.

Asking once per iteration turns a five-minute check into an afternoon. Then read
`just logs` yourself for what the tool recorded (`running-the-app`).

## Tests that need a grant

A test that needs a grant carries `#[ignore = "local machine: <grant> for <process>"]`,
so `just test-platform` and CI report it as ignored and only `just test-local` (a human's
recipe) runs it.
When the grant is missing the OS answers "no" rather than failing, so make the test's
failure message name the grant and where to give it: a bare `false` reads as a broken
adapter.
