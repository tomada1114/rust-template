---
name: running-the-app
description: >
  Covers seeing a change work in the real app without taking over the developer's Mac:
  just smoke (MYAPP_SMOKE=1, windowless, startup complete in the log) and just logs as
  an agent's own evidence; the helper CLI against a scratch HOME; the human's recipes
  just dev (hot reload), just run, and just install-app, and how to ask for them once;
  confirming the running process is this checkout's fresh build; reading the daily log
  files in ~/Library/Logs; the WebView inspector in debug builds; and the evidence a
  pull request carries for behaviour no gate asserts. Use when asked to run, launch,
  start, or look at the app, when a change must be verified in the running app rather
  than in tests, when a UI-to-Rust wiring change needs proof, when a log line is the
  only observable, or when deciding what to paste into a pull request.
---

# Running the App

**Owns:** getting evidence from the built app: what an agent runs on its own, what it
asks a human to run, how it knows it watched the right build, and what the pull request
carries. **Does not own:** whether a behaviour belongs in a test instead (`placing-tests`,
`tdd`); the smoke script's code (`scripts/smoke.ts`, `writing-repo-scripts`); an OS
integration behind a port (`integrating-system-apis`); the look of a screen
(`designing-ui`); the pull request itself (`create-pr`).

Running the app proves wiring, not logic. Every decision is core's and gated by
`just test`; the command tests and the UI tests each check one side of IPC against a
mock. What no gate sees is the seam between them: a button that invokes the wrong
command, a command registered nowhere, state built wrong at startup
(`AGENTS.md` › "Enforcement layers"). That is what running is for, and its result is
evidence in the pull request, never a substitute for a test.

## What an agent runs on its own

Nothing here opens a window, takes focus, or raises a prompt (`AGENTS.md` › "Never taking
over the developer's Mac"). This is the default, and usually enough.

```bash
just smoke   # release .app: build, signature, entitlements, bundled helper, windowless run
just logs    # the newest log file's last 50 lines, then exit
```

- **`just smoke`** builds the release bundle (app only, never a disk image), verifies
  its signature and entitlements, runs the bundled `myapp-cli --version`, then runs the
  app's executable directly with `MYAPP_SMOKE=1`. In smoke mode the shell sets the
  activation policy to `Prohibited`, keeps the main window hidden, runs the normal
  startup path (logging, store, clock, `AppState`, command registration), logs
  `startup complete`, and exits 0 (`src-tauri/src/startup.rs`). The script then requires
  a `startup complete` line carrying that run's `pid`. So a change to `run()`,
  `build_state`, `with_commands`, or an adapter's construction is proven wired by a
  green smoke; its failure codes (`ERR_SMOKE_*`) name the step that broke.
- **`just logs`** prints the tail of the newest `*.log` in
  `~/Library/Logs/com.example.myapp/`. Both the app (`myapp.YYYY-MM-DD.log`) and the
  helper (`myapp-cli.YYYY-MM-DD.log`) write there, dated in UTC, so after a helper run
  `just logs` shows the helper's file. For the app's own file, name it:
  `tail -n 100 ~/Library/Logs/com.example.myapp/myapp.$(date -u +%F).log`.
- A line reads `<UTC timestamp>  INFO myapp_lib: startup complete pid=15240 smoke=true`
  (observed in this Mac's log, 2026-09-29). Each command logs one line naming itself
  (`log_outcome` in `src-tauri/src/commands.rs`), and the UI's forwarded warnings and
  errors appear with the target `ui`. A log line is often the cheapest observable for
  a wiring change: add the `tracing` event in the shell, then read it.
- **The helper** runs without the GUI. Point `HOME` at a scratch directory so it reads
  and writes a throwaway store and log instead of the developer's own. In the sample:

  ```bash
  cargo build --locked -p myapp-cli
  scratch="$(mktemp -d)"
  HOME="$scratch" target/debug/myapp-cli counter show
  rm -rf "$scratch"
  ```

  `home_dir()` in `crates/myapp-platform/src/paths.rs` reads `HOME`, and every data and
  log path hangs off it (observed: the run above writes only under the scratch
  directory, 2026-09-29). Build before changing `HOME`, not inside it: cargo and rustup
  find their own files under `HOME` too.

## When only the window can show it: ask once

Some changes are only visible on screen: layout, a focus ring, what a screen shows after
an event from another window. An agent never opens the app itself; it asks the human,
once, in one message, before iterating:

- the recipe: **`just dev`** for UI work (Vite serves `ui/` with hot reload and Rust
  rebuilds on change), **`just run`** for the debug bundle exactly as built, or
  **`just install-app`** to replace the copy in `~/Applications` the human uses day to
  day. All three are human recipes: they open the app.
- the exact steps to take and what to look at, in both appearances when the change is
  visual (`designing-ui` › "Reviewing a screen's design");
- any TCC grant or System Settings step, all at once (`integrating-system-apis`);
- what to send back: what they saw, and a screenshot when it matters.

Then read `just logs` yourself for what the run recorded. `just logs-follow` never ends
and is the human's; an agent reads the file with `just logs` or `tail` after the fact.

## Confirming it is the fresh build

`just run` quits any running copy before opening the new build, so what the human sees
is the new build only if that quit worked; and another worktree or clone of this
repository builds an app with the same name and bundle identifier. Before trusting what
the human saw after `just run`:

```bash
pgrep -x myapp                              # the pid(s) of the running app
ps -o pid=,lstart=,command= -p <pid>        # its start time and executable path
stat -f '%Sm %N' "target/debug/bundle/macos/MyApp.app/Contents/MacOS/myapp"
```

Two things must hold: the executable path is this checkout's
`target/debug/bundle/macos/MyApp.app`, and the process started after the binary's
modification time. The day's log then has a `startup complete` line with the same `pid`
and `smoke=false`. `just run` quits running copies with `pkill -x myapp`, which matches
by process name, so it also quits a copy started from another worktree; say so when
asking a human who works in several.

## The WebView inspector

In a debug build (`just dev`, `just run`) the inspector opens with a right-click ›
Inspect Element or Command-Option-I; a release build needs Tauri's `devtools` feature,
which uses a private macOS API (<https://v2.tauri.app/develop/debug/>, checked
2026-09-29). This template does not enable it. The inspector is inside the window, so it
is the human's tool: ask for the console output or the failing request rather than
driving it. What the UI logs through `ui/src/ipc/log.ts` already reaches `just logs`,
which is usually the faster path.

## Putting the app in a known state

Do not add a flag or an environment hook to the app only to look at a state. A state you
only need to see is one a test can build directly: a command test hands the service a
fake holding it (`app_holding` in `src-tauri/tests/commands.rs`), and a UI test answers
the command with it (`mockCommands` in `ui/src/ipc/testing.ts`). `MYAPP_SMOKE` is the
template's only environment switch, and it changes visibility and lifetime only, never
behaviour. A start state genuinely needed by hand as well as by tests is read once in the
composition root (`src-tauri/src/lib.rs`) and handed to core as a value, so a core test
still reaches it; core never reads the environment (`designing-core-logic`).

## The evidence a pull request carries

No gate runs any of this, so the pull request is where it lands. State the exact
command, not a paraphrase, and paste:

- the tail of `just smoke` for a change to startup, wiring, or bundling;
- a `just logs` excerpt, with the command that produced it, for behaviour whose only
  observable is a log line;
- what the human saw after `just run` or `just dev`, with a screenshot for anything a
  person looks at;
- `just test-local` output, run by a human, for a change to an adapter with an
  `#[ignore = "local machine: …"]` test (`AGENTS.md` › "Review Checklist").

Redact before pasting: a signing identity, a Team ID, a certificate name, a personal
name, or a home directory path (`ps` and `stat` print `/Users/<name>/…`), and say that
you did. A pull request here, or in an app cut from this template, may be public. Leave nothing behind: remove
any scratch `HOME`, and check `git status --porcelain` shows only the change.
