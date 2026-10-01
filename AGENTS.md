# Project Guide

This file holds what every agent needs before it knows which task it is on: what the
app is, how to check a change, where code goes, and which decisions need a human. It is
the one guide Claude Code and Codex CLI share, and it leaves three things to others:

- **The conventions of one kind of change** belong to a skill under `.agents/skills/`,
  loaded when the work calls for it — [Skills](#skills) says where they live.
- **The rules for one kind of file** belong to `.claude/rules/`, loaded by path —
  [Rules](#rules) lists them.
- **A value a gate enforces** — a lint level, a banned call, a format option, a coverage
  floor, a tool pin — belongs to its config (`Cargo.toml`'s `[workspace.lints]`,
  `clippy.toml` and `crates/myapp-core/clippy.toml`, `rustfmt.toml`, `deny.toml`,
  `eslint.config.mjs`, `tsconfig.json`, `.prettierrc.json`, `vitest.config.ts`, the
  `test-core` recipe in the `justfile`, `mise.toml`, `rust-toolchain.toml`); running the
  gate is how you learn it.

A rule that belongs to one of those lands there, and this file points to it rather than
keeping a second copy that goes stale.

## Overview

This is a macOS desktop app built from a strict template: a Rust core, a Tauri v2 shell,
and a React + Vite + TypeScript screen, distributed as a `.dmg`. The Rust code is a
Cargo workspace — the logic in `crates/myapp-core`, the OS adapters in
`crates/myapp-platform`, fakes and contract suites in `crates/myapp-test-support`, a
bundled helper executable in `crates/myapp-cli`, and the Tauri shell in `src-tauri/` —
the screen lives in `ui/`, and repository automation is TypeScript under `scripts/`.
Quality gates are on from day one: rustfmt, clippy `all` + `pedantic` with warnings as
errors, `unsafe_code = "forbid"` in every crate, an 80% line and 80% function coverage
floor on `myapp-core`, TypeScript `strict` with ESLint's `strictTypeChecked`, and Vitest
coverage floors on `ui/src/` (80/80), `scripts/` and skills' bundled TypeScript scripts
(85/90), and the staged guard (90/100); skills' bundled Python and shell suites run with
no floor.

## Product

**TODO: in the template this section is a placeholder.** It is the one part of this
file about the application rather than the harness, so every repository cut from the
template writes its own: without it an agent implementing an issue here has no in-repo
answer to "is this in scope?". Fill in every `TODO:` below right after the rename
(`README.md`'s "Using This Template") — once `scripts/bootstrap.ts` has run,
`just check-harness` fails while one is left.

- **What it is, and who it is for** — TODO: one paragraph. The problem it solves, and
  whose problem that is.
- **The core interaction** — TODO: the one thing a user does most. If the app does not
  do this well, nothing else about it matters.
- **Non-goals** — TODO: what this app deliberately does not do, even where it would be
  easy. A first version's cut list is longer than its feature list, and this is the
  line an eager implementer crosses first: moving anything from here to a goal is a
  human's decision, not an implementer's.
- **Where these decisions are recorded** — TODO: where the reasoning behind the three
  entries above lives — an ADR under `docs/architecture/` (see "Before changing the
  architecture"), a design issue, or another decision log — so a reader can find why
  and not only what.

## Quick Reference

```bash
just install       # Install pinned tools (mise), pnpm dependencies, and lefthook's git hooks (no sudo)
just verify-hooks  # Fail when lefthook's pre-commit hook is not installed
just fmt           # Format every Rust and TypeScript file (cargo fmt, prettier --write)
just fix           # Format and apply ESLint's autofixes
just lint          # rustfmt check, clippy -D warnings, tsc, ESLint, Prettier check
just test          # test-core + test-ui: every test that runs anywhere, with the coverage floors
just test-core     # myapp-core with its 80/80 floors, its doctests, and the Linux-buildable crates' tests
just test-ui       # Vitest over ui/src with its 80/80 floors
just test-fast increment  # One core test or a group of them, no floor (iteration only)
just test-macos    # Platform adapters and tauri::test command tests (macOS, no human)
just test-scripts  # Vitest over scripts/ and skills' scripts with its floors, plus bundled Python tests and shellcheck
just check-harness # Re-assert the harness's claims about itself (scripts/checks/)
just bindings      # Regenerate ui/src/ipc/generated/ from core's ts-rs types
just sidecar       # Build myapp-cli into src-tauri/binaries/ (the Tauri build needs it)
just build         # Build the debug .app bundle (no disk image)
just smoke         # The launch smoke: release .app, signature, entitlements, helper, windowless run
just logs          # Print the end of the newest app log and exit
just deny          # cargo deny: advisories, licences, bans, sources
just check         # Everything a Mac runs without a human: verify-hooks → fmt → lint → lint-repo → agents-check → test-scripts → check-harness → test → test-macos → build → smoke
just agents-sync   # Regenerate the .claude/skills/ mirror from .agents/skills/
just agents-check  # Fail if .claude/skills/ differs from .agents/skills/
just clean         # Remove build output (target/, dist/, coverage/, src-tauri/binaries/)
just release-prep 0.2.0  # Bump the three version sites, refresh Cargo.lock, roll CHANGELOG.md (no commit/tag/push)
just verify-bootstrap    # Bootstrap a scratch clone in a temp directory; fail on anything it leaves behind (template only)

# A human's recipes — they open the app, never end, or change the Mac; an agent runs them only when asked
just dev               # Run the app with hot reload (opens a window)
just run               # Build, quit any running copy, and open the debug app
just install-app       # Build the release app and copy it to ~/Applications
just test-local        # The #[ignore]d tests that need a logged-in Mac, a TCC grant, or the Keychain
just logs-follow       # Follow the newest app log (never ends)
just reset-permissions # Make macOS forget this app's privacy (TCC) grants

# Writes to GitHub or rewrites the repository — a human's step
just labels     # Create/update labels from .github/labels.yml (never deletes)
just ruleset    # Create/update the "main" ruleset from .github/rulesets/main.json (admin-only)
just bootstrap  # Turn the template into a new app (renames, removes template-only files)
```

Without Just: run the underlying commands listed in each `justfile` recipe
(see `CONTRIBUTING.md`).

## Validating a change

Run the narrowest check that can fail, then `just check` before you open a PR. None of
the checks below opens a window or takes focus (see "Never taking over the
developer's Mac").

| What you changed | The narrowest check that can fail |
|---|---|
| Rust under `crates/myapp-core/src/` | `just test-fast <filter>` while iterating, then `just test-core` (the floors) and `just lint` (clippy, including core's banned calls) |
| A test under `crates/myapp-core/tests/`, or a `#[cfg(test)]` module in core | `just test-core` |
| A type in core that derives `ts_rs::TS` (anything crossing IPC) | `just bindings`, commit `ui/src/ipc/generated/` with it, then `just lint` (tsc) and `just test-ui` |
| An adapter under `crates/myapp-platform/` | `just test-macos` (its contract tests against the real adapter); an `#[ignore]`d test there is human-run — ask for `just test-local` output for the PR |
| A fake or a contract function under `crates/myapp-test-support/` | `just test-core` (core runs the contracts against the fakes), then `just test-macos` (platform runs them against the real adapters) |
| The helper under `crates/myapp-cli/` | `just test-core` (it runs the CLI's tests), then `just smoke` (it runs the bundled copy) |
| A command, the wiring, or startup under `src-tauri/src/` | `just test-macos` (the `tauri::test` command tests in `src-tauri/tests/`), then `just smoke` for the startup path |
| `src-tauri/tauri.conf.json`, `src-tauri/capabilities/`, or `src-tauri/Entitlements.plist` | `just build`, then `just smoke` — and each is a sign-off change ("Security and human approval") |
| A command or an event added, renamed, or removed | `just test-macos`, `just test-ui`, then `just check-harness` (the Rust and `ui/src/ipc/` name lists agree) |
| A component, hook, or IPC wrapper under `ui/src/` | `just test-ui`, then `just lint` |
| `ui/src/design/tokens.css` or a design primitive | `just test-ui` (`tokens.test.ts` checks dark values and contrast), then `just check-harness` (no raw color, `font-family`, or pixel font size outside `tokens.css`) |
| Formatting of any Rust or TypeScript file | `just fmt`, or `just lint` to only check |
| A clippy or ESLint finding that may be auto-fixable | `just fix`, then `just lint` for what still needs a hand edit |
| Behavior only the running app shows (a screen's wiring to Rust, a log line) | `just smoke` and `just logs` first; `just run`, then `just logs`, only when the human asks to see the window — no gate asserts it, so the PR carries the evidence (the `running-the-app` skill) |
| A script under `scripts/` (including `scripts/lib/`) | `just test-scripts`, then `just lint` |
| `lefthook.yml` or `scripts/verify-hooks.ts` | `just test-scripts`, then `just verify-hooks` |
| A harness check under `scripts/checks/` | `just test-scripts`, then `just check-harness` |
| A `just` recipe name, a workflow's `uses:` or `permissions:`, a skill's frontmatter, the `## Product` section, `.claude/settings.json`'s `permissions`, core's forbidden-crate lists (`deny.toml`'s `wrappers`, the closure check), the gates `just check` or `ci.yml` runs, or a label an issue form, workflow, or bot config applies | `just check-harness` |
| A skill under `.agents/skills/` | `just agents-sync`, then `just agents-check` and `just check-harness`; `just test-scripts` too when the skill ships scripts |
| A workflow under `.github/workflows/` | `mise exec -- actionlint` and `mise exec -- zizmor .`, then `just check-harness` |
| Markdown | `mise exec -- typos <file>` (the pre-commit hook and CI's `Repo Lint & Harness` job run it) |
| `Cargo.toml`, `Cargo.lock`, `deny.toml`, `package.json`, or `pnpm-lock.yaml` | `just deny`, `mise exec -- cargo shear`, `just lint`, then `just test` — a new dependency is a sign-off change (`.claude/rules/project.md`) |
| `mise.toml` or `rust-toolchain.toml` | `mise install` for `mise.toml` (rustup installs a new `rust-toolchain.toml` channel on the next `cargo` call: `.claude/rules/project.md` › Tool Pinning), then `just check` |
| `.github/labels.yml`, or an issue form under `.github/ISSUE_TEMPLATE/` | `mise exec -- typos <file>`, then `just check-harness` (every applied label declared, once) |
| `.github/rulesets/main.json`, or `scripts/apply-ruleset.ts` | `just test-scripts`; `just check-harness` for `main.json` (every required context names a job that runs on every pull request) |
| A new file, or a new spelling of a placeholder (`MyApp`, `myapp`, `myapp-core`, `myapp_lib`, `MYAPP_SMOKE`, `com.example.myapp`) — template only: the bootstrap removes this row | `just verify-bootstrap` (it bootstraps a scratch clone in a temporary directory and fails on a placeholder the rename misses, template-only text, or a dangling reference); `just test-scripts` too for a change to `scripts/bootstrap.ts` |

## Architecture

```
Cargo.toml                  # Virtual workspace: members, resolver = "3", [workspace.package],
                            #   [workspace.dependencies] (the one place a version is written),
                            #   [workspace.lints]
rust-toolchain.toml         # The one Rust pin
crates/
├── myapp-core/             # Domain logic, state, and the ports (traits) everything outside
│                           #   the process is reached through. No tauri, no OS APIs, no
│                           #   direct I/O; built and tested on Linux; coverage-gated
│                           #   (lines 80, functions 80)
├── myapp-platform/         # Adapters implementing core's ports against the real OS and
│                           #   file system (JsonFileCounterStore, SystemClock, logging,
│                           #   paths) — translation only, outside the coverage floor
├── myapp-test-support/     # One fake per port + one `<port>_contract` function per port.
│                           #   A [dev-dependencies] entry only; never ships
└── myapp-cli/              # The helper executable bundled inside the .app (a sidecar), so
                            #   launchd can run it without starting the GUI
src-tauri/                  # Crate `myapp`: the Tauri shell and composition root. Builds the
                            #   real adapters, hands them to core, and translates commands
                            #   and events. Decides nothing
├── src/                    # lib.rs (run(), with_commands), commands.rs, startup.rs
├── tests/                  # tauri::test command tests against fakes
├── tauri.conf.json         # Window, CSP, bundle and signing settings
├── capabilities/           # Plugin permissions per window (core:default only)
└── Entitlements.plist      # Hardened-runtime entitlements (sign-off to change)
ui/                         # React + Vite + TypeScript (Vite's root)
└── src/
    ├── ipc/                # The only code that imports @tauri-apps/*: commands.ts,
    │                       #   events.ts, errors.ts, log.ts, types.ts, testing.ts
    │   └── generated/      # ts-rs output from core, committed, never hand-edited
    ├── copy/               # Every user-facing string, and the error-code wording
    ├── design/             # The design system: tokens.css, base.css, primitives
    └── counter/            # The sample screen and its hook (a deletable illustration)
scripts/                    # Repository automation in TypeScript, run by Node directly
```

- New logic goes in `myapp-core` with tests. The shell, the adapters, the CLI, and the
  screen translate; a decision found in any of them belongs in core, where the coverage
  floor sees it.
- The dependency direction is one-way: `myapp-platform` → `myapp-core`, and both ←
  `myapp` (the shell) and `myapp-cli`. Core never depends on platform, tauri, or an OS
  binding crate; `myapp-test-support` is reached only through `[dev-dependencies]`.
  The UI reaches Rust only through `ui/src/ipc/`.
- A port is a synchronous `Send + Sync` trait core declares; `myapp-platform`
  implements it; the shell constructs the real adapter and hands it to core; a test
  hands core a fake from `myapp-test-support`. The shell calls a slow port on a
  blocking thread (`tauri::async_runtime::spawn_blocking`), so core never meets async.
  The worked example is `CounterStore` / `JsonFileCounterStore` / `InMemoryCounterStore`
  and `Clock` / `SystemClock` / `FixedClock`.
- The core boundary is enforced three times, so removing one layer leaves the others:
  core's `Cargo.toml` lists no tauri, OS, or platform crate; `deny.toml`'s `[bans]`
  `wrappers` let only `myapp` depend on `tauri` and only `myapp` and `myapp-cli` on
  `myapp-platform`; and a harness check fails when core's normal and build dependency
  closure reaches `tauri*`, `wry`, `tao`, `objc2*`, `core-foundation*`, `security-framework*`,
  or `myapp-platform`. Those lists change together, and `just check-harness` fails when
  they differ.
- I/O, time, the environment, and processes reach core only through ports or arguments,
  and core never sleeps or starts a thread that outlives the call:
  `crates/myapp-core/clippy.toml` bans `print!`/`println!`/`eprint!`/`eprintln!`/`dbg!`,
  `std::io::{stdin, stdout, stderr}`, `std::fs::{File, OpenOptions, DirBuilder}` and
  every `std::fs` free function, `std::os::unix::fs::{symlink, chown, fchown, lchown,
  chroot}`, `std::path::Path`'s file-system queries (`exists`, `try_exists`,
  `metadata`, `symlink_metadata`, `read_dir`, `read_link`, `canonicalize`, `is_file`,
  `is_dir`, `is_symlink`, which a `PathBuf` reaches too), `std::net::{TcpStream,
  TcpListener, UdpSocket}`, `std::os::unix::net::{UnixStream, UnixListener,
  UnixDatagram}`, and `ToSocketAddrs::to_socket_addrs`, `std::process::{Command, exit,
  abort, id}`, `std::os::unix::process::parent_id`, `SystemTime::now`/`Instant::now`
  and both types' `elapsed`, `std::env`'s `var`/`var_os`/`vars`/`vars_os`,
  `args`/`args_os`, `current_dir`/`set_current_dir`, `current_exe`, `home_dir`,
  `temp_dir`, and `set_var`/`remove_var`, and
  `std::thread::{spawn, sleep, park_timeout, available_parallelism}` and
  `std::thread::Builder::spawn` there.
  `std::thread::scope` is allowed, in production core and tests alike: it joins every
  thread before it returns, so none can outlive the call.
  Core denies `clippy::wildcard_enum_match_arm`, so a `match` on a core enum names
  every variant.
- Errors are one `thiserror` enum per port or core module carrying a typed code
  (`#[serde(tag = "code")]`); the UI maps each code to wording in `ui/src/copy/`. Rust
  never sends a user-facing sentence, and no error or log line carries user data.
- The shell, the CLI, and `myapp-platform` log through the `tracing` macros; `myapp-core`
  has no `tracing` dependency and logs nothing. Only the shell and the CLI install a
  subscriber (`myapp_platform::init_logging`). Files go to
  `~/Library/Logs/com.example.myapp/`, rotated daily, the last 14 kept; `just logs`
  prints the newest. The UI forwards its warnings and errors through
  `ui/src/ipc/log.ts` to the `log_from_ui` command.
- Every type that crosses IPC lives in core and derives `ts_rs::TS`, exported to
  `ui/src/ipc/generated/` by `just bindings` (CI regenerates and fails on a diff). Only
  `ui/src/ipc/` imports those files or `@tauri-apps/*` (ESLint `no-restricted-imports`);
  the rest of the UI imports types from `ui/src/ipc/types.ts` and calls the typed
  wrappers in `commands.ts` and `events.ts`. Command names in `generate_handler!` and
  event names (a `pub const` per event, such as `COUNTER_CHANGED`) match what
  `commands.ts` invokes and `events.ts` listens to.
- The screen uses only the primitives and `var(--…)` tokens in `ui/src/design/`, never
  a raw color, a `font-family`, or a pixel font size (`docs/design/design-system.md`); every string
  comes from `ui/src/copy/`; every control has an accessible name.
- Tauri's security posture is deliberate: a restrictive CSP in `tauri.conf.json`,
  `withGlobalTauri: false`, and one capability granting only `core:default`. The app
  commands need no capability entry; a plugin does, and adding one is an ADR decision.
- Four things are contract rather than private — core's public API, the bundle
  identifier, the IPC command and event names with their payload shapes, and on-disk
  file formats (`counter.json` carries a format version) — and each changes only as
  `docs/architecture.md` says.
- `src-tauri/binaries/`, `src-tauri/gen/`, `target/`, `dist/`, and `coverage/` are
  build output: never edit or commit them.

## Before changing the architecture

An app cut from this template records its architecture decisions as ADRs under
`docs/architecture/` — start at its `README.md`, the index, whose statuses say what is
decided and what is only proposed. `docs/architecture.md` describes the layers every app
starts with; the ADRs record what the app decided on top of them. A change to any of
these owes an ADR, as `recording-architecture-decisions` sets out:

- a new crate, or a new port in core;
- the app shape — a windowed app, or a menu-bar agent (`ActivationPolicy::Accessory`
  and a tray icon);
- the sandbox posture — the App Sandbox on or off, or a new entitlement;
- persistence — where and in what format the app keeps state;
- a new crate or npm dependency;
- a new Tauri plugin or capability, or relaxing the CSP;
- distribution — Developer ID signing and notarization, an in-app updater, a universal
  (Intel) build;
- `minimumSystemVersion` in `tauri.conf.json`, or `rust-version` in `Cargo.toml`;
- a TCC permission — Accessibility, Input Monitoring, Screen Recording, Full Disk
  Access, or any other privacy grant;
- a second UI locale;
- `unsafe` code, which means lifting `unsafe_code = "forbid"` for `myapp-platform`;
- the bundle identifier (`com.example.myapp` until the bootstrap renames it), which keys
  the app's data, logs, and privacy grants;
- the design lock — the app's own design system replacing the template's base values;
- a CSS framework, a component library, or a state-management library;
- a Tauri major version.

An agent writes an ADR as Proposed; only a human accepts it. An ADR records reasoning and
grants nothing: an entitlement, a signing change, or a new dependency still needs the
sign-off "Security and human approval" asks for. The index starts empty: the reasoning
behind the layers every app starts with lives in `README.md`'s Design Philosophy, and an
ADR records only what an app decides on top of them.

## Skills

Skills are authored under `.agents/skills/` (the path Codex CLI reads) and mirrored
byte-for-byte into `.claude/skills/` (the only path Claude Code reads) by
`just agents-sync` — edit only the authored copy, commit both trees together, and let
`just agents-check` report any drift.

| Skill | Load it for |
|---|---|
| `authoring-skills` | Writing or editing a skill: the conventions, the mirror, the size cap |
| `smart-commit` | Turning the working tree into Conventional Commits; a refused pre-commit hook |
| `create-pr` | Opening or updating a pull request: title, body, Release impact, evidence |
| `triaging-issues` | Filing or labelling an issue: type, priority, blocked, tracking |
| `shipping-issues` | Taking ranked open issues to merged pull requests, with worktrees |
| `steering-the-roadmap` | Changing `docs/architecture/roadmap.md` (Now / Next / Later) |
| `merging-dependency-prs` | Landing open Dependabot and Renovate pull requests; Tauri minors move together |
| `managing-dependencies` | Adding or changing a crate or npm package: the review record, features, licences |
| `changing-gates` | Editing a file that enforces: lints, floors, hooks, workflows, capabilities, entitlements |
| `updating-docs` | Deciding which document a change must update |
| `recording-architecture-decisions` | Writing an ADR under `docs/architecture/` |
| `writing-repo-scripts` | A TypeScript script under `scripts/` or bundled with a skill, and its test |
| `releasing-the-app` | Cutting a release: version, CHANGELOG, `just release-prep`, the tag, signing |
| `starting-an-app` | Turning the template into a new app: bootstrap, design system first, app shape |
| `writing-rust` | Rust in `crates/*` and `src-tauri`: ownership, errors, compiler messages, clippy |
| `writing-typescript` | Type-system judgment in `ui/src/` and `scripts/` |
| `tdd` | Red-green-refactor with `just test-fast` and Vitest |
| `writing-tests` | The body of one test in either language: oracles, fakes, contracts, clocks |
| `placing-tests` | Where a new test goes and which floor measures it |
| `designing-core-logic` | Shaping logic in `myapp-core`: ports, `Tuning`, transitions, views |
| `designing-errors` | Error enums, codes for the UI, adapter mapping, `ERR_*` script codes |
| `designing-ipc` | Adding a command or event end to end, bindings, capabilities, the sidecar |
| `integrating-system-apis` | Calling macOS from `myapp-platform`: commands, `objc2`, TCC |
| `running-the-app` | Seeing a change work: `just smoke` and `just logs`; the human's run recipes |
| `building-react-screens` | A screen under `ui/src/`: a thin component over a hook, states, accessibility |
| `designing-ui` | Look and feel: HIG in a WebView, the design system, the design-lock ADR |

### Rules

The files under `.claude/rules/` load by path: each applies while you touch a file
matching its `paths:` globs. They are Claude Code-only and are not mirrored; under
Codex CLI, read the one that matches the file you are changing.

| Rule | Loads when you touch |
|---|---|
| `.claude/rules/rust.md` | `crates/**/*.rs`, `src-tauri/**/*.rs` |
| `.claude/rules/typescript.md` | `ui/**/*.ts`, `ui/**/*.tsx`, `scripts/**/*.ts` |
| `.claude/rules/testing.md` | Rust tests (`crates/*/tests/**`, `src-tauri/tests/**`, `crates/myapp-test-support/**`) and TypeScript tests (`**/*.test.ts`, `**/*.test.tsx`, `ui/src/test/**`) |
| `.claude/rules/project.md` | manifests, lockfiles, and gate configs: `Cargo.toml` files, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `mise.toml`, `rust-toolchain.toml`, `deny.toml`, `clippy.toml` files, `rustfmt.toml`, `eslint.config.mjs`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `.prettierrc.json`, `.prettierignore`, `lefthook.yml`, `typos.toml`, `osv-scanner.toml`, `.github/dependabot.yml`, `.github/renovate.json` |
| `.claude/rules/docs.md` | `docs/**/*.md`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` |

### Sub-agents

`.claude/agents/` defines three named sub-agent tiers a skill or session can hand a
step to by name (for example `subagent_type: executor`), each pinned to a model alias
(`opus`/`sonnet`, never a dated model ID, so the definitions do not go stale) and an
effort level:

| Agent | Model / effort | Takes |
|---|---|---|
| `executor` | `opus` / low | a settled spec with a clear pass/fail: implementation, tests, getting a check green, bulk edits, research that only collects |
| `architect` | `opus` / high | complex multi-file implementation, design judgment, review and bug finding, synthesis, a spec that still has holes |
| `worker` | `sonnet` / medium | single-shot, tool-free writing or checking from a complete brief |

These are Claude Code-only: like `.claude/rules/`, they are not mirrored, and Codex CLI
reads nothing under `.claude/agents/`. Under Codex CLI, a step a skill hands to one of
these agents runs inline in the main session instead.

## Security and human approval

Only what is mechanically decidable is blocked at commit time; whether a commit
*should* contain what it contains stays in PR review. The pre-commit hook's staged
guard (`scripts/check-staged.ts`, rules in `scripts/lib/guard/`) refuses a
secret-shaped staged path or credential-shaped staged content.

Never read a secret-shaped file, even to check it: `.env`, `.env.*`, or `.envrc.*`
(the `.example`/`.sample`/`.template` samples excepted), anything under a `secrets/`
directory, `*.p12`, `*.pfx`, `*.p8`, `*.provisionprofile`, `*.mobileprovision`,
`*.keychain`/`*.keychain-db`, `*key*.pem`, `private-key.*`, an SSH private key
(`id_rsa`, `id_ed25519`, …), `.netrc`, `credentials.json`, and `secrets.json`. This is
the same list `scripts/lib/guard/paths.ts` refuses to commit, so the read rule and the
commit guard agree (the guard also refuses `.claude/settings.local.json`, which is
per-user settings rather than a secret, so reading it is fine and only committing it is
not); if a task seems to need one, ask the human for the non-secret fact instead.

Get a human's sign-off before acting on any of these. `.claude/settings.json` blocks a
few of them for Claude Code (see "Enforcement layers"); for everything else this
section is the rule itself, not a description of a check that enforces it.

- Touching `src-tauri/Entitlements.plist`, the signing settings in `tauri.conf.json`'s
  `bundle.macOS` (`signingIdentity`, `hardenedRuntime`, `entitlements`), or any signing,
  notarization, or release secret (the `APPLE_*` variables).
- Relaxing the app's security posture: the CSP or `withGlobalTauri` in
  `tauri.conf.json`, or a permission added under `src-tauri/capabilities/`.
- Creating or pushing a release tag.
- Editing `.claude/settings.local.json`, or a user-level settings file such as
  `~/.claude/settings.json`: an agent adding an `allow` rule there widens its own
  permissions, and neither file is committed, so no review ever sees it. The committed
  `.claude/settings.json` is reviewed in its pull request like any other file.
- Adding a new crate or npm package — see the dependency policy in
  `.claude/rules/project.md`.
- Weakening any gate: lowering a coverage floor (the `test-core` recipe,
  `vitest.config.ts`'s `thresholds`), relaxing a lint (`[workspace.lints]`,
  `clippy.toml`, `eslint.config.mjs`, `tsconfig.json`), or widening a workflow's
  `permissions:`. If a gate looks wrong, say so and let a human decide. In this
  repository that also means any of these, when used to make a failing check pass:
  - `#[allow(…)]` or `#[expect(…)]` on a clippy or rustc lint, or
    `// eslint-disable` in any form
  - `@ts-ignore`, `@ts-expect-error`, a non-null `!`, or an `as` cast to silence tsc
  - `unsafe`, or lifting `unsafe_code = "forbid"`, to get past the borrow checker
  - `#[ignore]` on a failing Rust test, or `.skip`/`.todo` on a failing Vitest test
  - excluding a file from coverage, or adding a path to an ignore list (`typos.toml`,
    `.prettierignore`, ESLint's `globalIgnores`, `deny.toml`, `osv-scanner.toml`)
  - deleting an assertion, or loosening one until it passes
  - `continue-on-error` on a CI job or step, or `git commit --no-verify`
- Working around a denied command. When a command is denied — by
  `.claude/settings.json`, a hook, or a human — re-spelling it (`git -C . …`,
  `bash -c '…'`, bundled short flags such as `-anm`, an alias or script wrapper) is
  forbidden. Stop and ask.
- Any write to a remote: `git push`, `gh pr create`, or any other remote write that
  is not performed by a script this repository ships. `scripts/sync-labels.ts`
  (`just labels`) is such a script for labels: it only ever creates or updates a label
  `.github/labels.yml` declares, and never deletes one — but running it against the
  live repository still needs sign-off before its first run there, the same as any
  other remote write. `scripts/apply-ruleset.ts` (`just ruleset`) is the same kind of
  script for branch protection: it only ever creates or updates the ruleset named
  "main" from `.github/rulesets/main.json`, needs repository admin permissions to
  succeed, and still needs sign-off before its first run against the live repository.

Standing exceptions: invoking one of these skills is the sign-off for the remote
writes that skill exists to make, for that invocation only.

- `smart-commit`, when asked to push: pushing the commits it made to the current
  branch.
- `create-pr`: pushing the current branch and creating or updating its pull request.
- `shipping-issues`: the writes its `SKILL.md` lists — priority and `blocked:` labels
  on open issues, branches and pushes, the pull request, merging it once CI passes,
  the follow-up issues and comments it files, and removing the branches and worktrees
  it created.

One request is a standing exception too: the human explicitly asking for an issue
("file an issue for this") is the sign-off for the `gh issue create` of each issue that
request asks for, with the labels `triaging-issues` gives it, and for comments on those
issues in the same request. An issue the agent would file from a friction it noticed on
its own, or from one the human raised without asking for an issue, is drafted in the
reply and waits for a yes.

None of them covers anything else in the list above: a force push or other history
rewrite, `--no-verify`, weakening a gate, entitlements or signing, a release tag, a
new dependency, `just labels`, or `just ruleset`. A skill that reaches one of those
stops and asks.

### Never taking over the developer's Mac

The owner develops on the same Mac the checks run on, often while an agent iterates
unattended. Nothing a routine check runs — `just check` and every recipe in it, the
pre-commit hook, the agent's PostToolUse hook, and any step an agent runs to verify its
own work — may show a window, take keyboard focus, move the pointer, add a Dock icon,
or raise a permission, Keychain, or Gatekeeper prompt.

- For evidence that the app starts and is wired, use `just smoke` (it runs the built
  executable directly with `MYAPP_SMOKE=1`: no window, no Dock icon, no focus change)
  and `just logs`. Never launch the app with `open`.
- `just dev`, `just run`, and `just install-app` open the app; run one only when the
  human asks to see it. `just test-local`, `just reset-permissions`, and
  `just logs-follow` are likewise started by a human on purpose.
- A test that needs a GUI session, a TCC grant, or the Keychain is
  `#[ignore = "local machine: <what it needs>"]` and runs only in `just test-local`.
- Local builds make the app bundle only (`--bundles app`): building a `.dmg` drives
  Finder through AppleScript, so only the release workflow on a CI runner builds one.
- Never trigger an installer or a `sudo` prompt; report the command for the human to
  run instead (`just install` does this for the Xcode Command Line Tools).

### What no local gate sees

Every local layer can be skipped, so these reach `main` only if CI or GitHub stops them
(see "Enforcement layers" for the gaps each one leaves):

- `git commit --no-verify` or another hook bypass (`LEFTHOOK=0`,
  `git -c core.hooksPath=…`), a clone where `just install` never ran or lefthook's
  binary no longer resolves, or a commit made outside this checkout's hooks — the
  pre-commit hook and staged guard never run.
- An edit made through GitHub's web UI or API, which touches no local hook.
- A secret inside a file whose path and content pattern the guard does not know.
- Any tool other than Claude Code: `.claude/settings.json` binds nothing else.

### GitHub settings a new repository must enable

"Use this template" copies files, not settings, so a repository's admin sets these up
once: the security switches under Settings › Advanced Security (Code security on older
UIs), the `main` ruleset, the Renovate App, and the label set:

- **Secret scanning** and **Push protection** — the server-side layer for secrets that
  the staged guard misses or a bypass skips; push protection blocks a detected secret
  at `git push`.
- **Private vulnerability reporting** — `SECURITY.md` sends reporters to a private
  security advisory, which this setting enables.
- **Dependabot alerts** and **security updates** — `.github/dependabot.yml` configures
  version updates; alerts for known-vulnerable dependencies are a separate switch.
- The `main` ruleset, applied by `just ruleset`. `.github/rulesets/main.json`
  deliberately lists no `bypass_actors`: a bypass lets an admin, or an agent acting
  with an admin's token, merge without the PR and green checks the ruleset exists to
  require, and an emergency change can still go through a PR.
- The **Renovate** GitHub App (<https://github.com/apps/renovate>, checked 2026-09-30),
  installed on the repository: without it `.github/renovate.json` does nothing, so
  `mise.toml` and `rust-toolchain.toml` are never bumped — Dependabot covers only cargo,
  npm, and Actions.
- The label set, created by `just labels` as soon as the repository exists.
  `.github/dependabot.yml` names its `labels` explicitly, and Dependabot then ignores
  one the repository does not define rather than creating it
  (<https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference>,
  `labels`, checked 2026-09-30), so add `dependencies` by hand to any Dependabot pull
  request opened before that.

## Repository scripts

Every script under `scripts/` follows these rules, whoever writes it. The reasons
behind them, with worked examples, are in the `writing-repo-scripts` skill:

- TypeScript run directly by Node's type stripping (`node scripts/<name>.ts`): no build
  step, so erasable syntax only — no `enum`, no `namespace`, no parameter properties.
  Real parsers for structured files (`yaml`, `smol-toml`, `JSON.parse`), never a regex
  over YAML or TOML.
- A script's entry point is `if (import.meta.main) await runScript(main);`, and `main`
  takes a `ScriptContext` (`scripts/lib/script.ts`: argv, env, root, a `run` function
  for child processes, a logger, stdin), so its test calls `main` with fakes instead of
  spawning real tools.
- Pinned tools are called by bare name; the caller provides PATH (`mise exec -- …`
  locally, `jdx/mise-action` in CI). A script whose job is a GitHub write
  (`scripts/sync-labels.ts`, `scripts/apply-ruleset.ts`) may also depend on `gh`: like
  `git`, it is assumed on PATH, since it is not a mise tool — its tests stub it out,
  so `just check` never needs the real binary.
- Spawned git gets an environment with every `GIT_*` variable stripped
  (`scripts/lib/git-env.ts`'s `gitEnv`): inside a hook, git's exported variables would
  point a child git at the hook's repository. The staged guard is the one exception —
  it keeps `GIT_INDEX_FILE` (`stagedGuardEnv`), because it must judge the index being
  committed.
- Failure contract (`scripts/lib/fail.ts`): the first stderr line is
  `ERR_<STAGE>_<WHAT>: <what failed>`, then `Expected:`, `Actual:`, and `Next:` lines
  (the next safe command); exit 1 (a Claude Code hook exits 2, the code that feeds
  stderr back to the agent). List the codes in the script's header comment. Never
  print a secret value.
- Never assume the checkout is the only repository on the machine. A script that
  enumerates or rewrites tracked files refuses to run outside a git work tree; a check
  that is meaningless outside one skips with a one-line notice instead. Each script's
  header states which it does.
- Every script has a test beside it, `scripts/<name>.test.ts` (and
  `scripts/lib/**/<name>.test.ts`), run by Vitest's `scripts` project
  (`just test-scripts`, part of `just check` and CI's `Repo Lint & Harness` job) with
  the coverage floors in `vitest.config.ts`: lines 85 and functions 90 across
  `scripts/` and across a skill's bundled TypeScript under `.agents/skills/*/scripts/`,
  lines 90 and functions 100 on `scripts/lib/guard/`. A test works in a temp directory
  or a throwaway repository, never the real checkout, and shares no state with any
  other test. A harness check under `scripts/checks/` takes `--root` so
  its test can point it at a fixture tree per failure mode. A skill's bundled scripts
  may keep their own language when ported with their tests; `just test-scripts` runs
  those suites too, with no coverage floor.

## Enforcement layers

The rules in this file are enforced by these layers, from mechanical to procedural:

| Layer | Fires on | Applies to | Holds |
|---|---|---|---|
| lefthook's pre-commit hook (`lefthook.yml`) | `git commit` | anyone who ran `just install` | check-only and fast, on the staged files: `rustfmt --check`, `prettier --check`, `eslint --max-warnings 0`, `typos`, and the staged guard. No clippy, compile, or test step — `just check` and CI run those. On the commit that concludes a conflicted merge, or one made at a rebase stop, the four style jobs skip (CI reruns them over the whole tree) and the staged guard and the skills mirror still run |
| `scripts/check-staged.ts` (the hook's staged guard; rules in `scripts/lib/guard/`) | `git commit`, whatever is staged, including the commit that concludes a conflicted merge | anyone who ran `just install` | no secret-shaped path (`.env*`, `.envrc.*`, `secrets/`, signing material, SSH keys, `.claude/settings.local.json`) or credential-shaped content (private-key header, GitHub token, AWS keys, Anthropic or OpenAI API key, Slack token, Google API key, Stripe live key, and the rest `credentials.ts` lists) lands in a commit; judged from the index, so a partly staged file is judged as committed; staged deletions are never inspected |
| `scripts/verify-hooks.ts` (`just install`'s last step, `just check`'s first) | `just install`, `just verify-hooks`, and `just check` | anyone who runs one | lefthook's pre-commit hook is installed in this checkout — skips under CI or the `ALLOW_MISSING_GIT_HOOKS` opt-out |
| The core boundary: core's `Cargo.toml`, `deny.toml`'s `[bans]` `wrappers`, and the dependency-closure harness check | compile, `just deny`, `just check-harness`, and CI's `Rust Core` and `Repo Lint & Harness` jobs | every author | core cannot name tauri, an OS binding crate, or `myapp-platform`; only `myapp` depends on `tauri` and only `myapp` and `myapp-cli` on `myapp-platform`; `myapp-test-support` is dev-only — three mechanisms, so removing one leaves the others |
| `crates/myapp-core/clippy.toml`, core's `#![deny(clippy::wildcard_enum_match_arm)]`, `scripts/clippy-guard.ts` (every clippy run in `just lint` and CI goes through it), and `scripts/checks/clippy-allow-invalid.ts` | `just lint`, `just check`, and CI's clippy steps; the check in `just check-harness` and CI's `Repo Lint & Harness` job | every author | in core, none of the calls `clippy.toml` lists: the print macros and standard streams, `std::fs`'s types and free functions, `Path`'s file-system queries, `std::os::unix::fs`'s `symlink`, `chown`, `fchown`, `lchown`, and `chroot`, `std::net`'s and `std::os::unix::net`'s sockets and address lookups, clock reads (`now`, `elapsed`), `std::env`'s argument, variable, and directory functions, `Command`, `exit`, `abort`, the process and parent-process ids, `thread::available_parallelism`, `thread::spawn`, `thread::Builder::spawn`, `thread::sleep`, or `thread::park_timeout` (`thread::scope` is allowed, since it cannot outlive the call); every `match` on a core enum is exhaustive; and every `path` in a `clippy.toml` names an item clippy resolves on that job's target — clippy only warns about one that does not, and `-D warnings` lets that pass, so the guard fails with `ERR_CLIPPY_BAN_UNRESOLVED` instead of letting the ban silently do nothing, and with `ERR_CLIPPY_CONFIG_INVALID` on any other diagnostic in a `clippy.toml` (a deprecated or unknown key); and no `clippy.toml` sets `allow-invalid`, which would hide that warning from the guard, so the check fails with `ERR_CHECK_CLIPPY_ALLOW_INVALID` apart from its human-approved exception list (empty) |
| `[workspace.lints]` in `Cargo.toml` | `just lint` and CI (`-D warnings`) | every author | `unsafe_code = "forbid"` in every crate; clippy `all` and `pedantic`; `unwrap_used`/`expect_used` outside tests; `missing_docs` on public items |
| ESLint's `no-restricted-imports`, `no-restricted-syntax`, `no-console`, `no-restricted-properties`, and `switch-exhaustiveness-check` (`eslint.config.mjs`) | the hook, `just lint`, and CI's `Frontend` job | every author | only `ui/src/ipc/` imports `@tauri-apps/*` or `ui/src/ipc/generated/`, only tests import `ui/src/ipc/testing.ts`, and inside `ui/src/ipc/` only `testing.ts` and tests import `@tauri-apps/api/mocks`, statically or by `import()`; no `console` (nor `window.console` or `globalThis.console`) outside `ui/src/ipc/log.ts` and `scripts/`; a `switch` over a union names every member and has no `default`; an unused disable directive is an error |
| Coverage floors | `just test-core`, `just test-ui`, `just test-scripts`, `just check`, and CI | every author | `myapp-core` lines 80 / functions 80; `ui/src/` 80 / 80; `scripts/` 85 / 90; `.agents/skills/*/scripts/` 85 / 90; `scripts/lib/guard/` 90 / 100 |
| The launch smoke (`scripts/smoke.ts`, `just smoke`) | `just check` and CI's `macOS Build & Smoke` job | every author | the release `.app` builds, is signed, carries `Entitlements.plist`'s entitlements, bundles a runnable `myapp-cli`, and starts windowless in smoke mode — store, clock, logging, and command registration wired — exiting 0 after logging `startup complete` |
| The skills-mirror check (`just agents-check`; the hook runs `node scripts/sync-agents.ts --check --staged`) | `git commit` when a skill path is staged, and CI's `Repo Lint & Harness` job | every author | `.agents/skills/` and `.claude/skills/` stay byte-identical — at commit time as staged in the index, so a source staged without its synced mirror is refused |
| `scripts/checks/` (`just check-harness`, part of `just check`) | `just check-harness`, `just check`, and CI's `Repo Lint & Harness` job | every author | the harness's claims about itself stay true — this file exists, and every `just <recipe>` it, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, the pull request template, `.claude/rules/`, `.claude/agents/`, `docs/` (apart from the template's own design record, the roadmap, and the ADRs), the skills, and the issue forms name exists; workflow hygiene, in the workflows and the repository's composite actions (SHA pins with a `# vX.Y.Z` comment, `timeout-minutes`, least-privilege `permissions`, `persist-credentials: false`, `concurrency` — top-level or per job — that never cancels a `main` run, no `pull_request_target`, no `continue-on-error`, `set +e`, or `|| true`-style fallback, `--locked`/`--frozen-lockfile` there and in every justfile recipe); no job holding a write scope or `id-token: write`, its own or inherited from the workflow's `permissions`, checks out the repository, runs `jdx/mise-action` or a local action, calls a remote reusable workflow, or runs `pnpm`, `cargo`, or `just`, apart from a reasoned exception list; the Dependabot, Renovate, and pnpm cooldowns agree; the `@types/node` major `pnpm-lock.yaml` resolves equals `mise.toml`'s `node` major; `mise.toml`'s pnpm pin names the version `package.json`'s `packageManager` does; every `tauri` crate in `Cargo.lock` and the `@tauri-apps/api` and `@tauri-apps/cli` `pnpm-lock.yaml` resolves share one MAJOR.MINOR, and each `@tauri-apps/plugin-<x>` matches its `tauri-plugin-<x>` crate's version; the bundle identifier is one value in `tauri.conf.json`, `myapp-platform`'s `BUNDLE_IDENTIFIER`, and the justfile's `bundle_id`; the app version is one value in `Cargo.toml`'s `[workspace.package]`, `tauri.conf.json`, and `package.json`; no `clippy.toml` sets `allow-invalid` (the clippy row above); the edit hook's Prettier extensions (`scripts/format-edited-file.ts`'s `PRETTIER_EXTENSIONS`) equal the pre-commit prettier job's glob in `lefthook.yml`; `osv-scanner.toml`'s GHSA ignores and Dependency Review's `allow-ghsas` list the same advisories; every required context in `.github/rulesets/main.json` names a job that runs on every pull request (no paths filter, no branch filter excluding a branch the ruleset gates — the default branch, read from `ci.yml`'s push branches or `origin/HEAD` only where a required job filters branches, or every branch under `~ALL` — default activity types, no `if:` that can be false); `just check` matches the steps CI runs unconditionally (no `if:`, `continue-on-error`, or `||` fallback) apart from a reasoned exception list; skills' frontmatter, size, and the Skills table; every applied label is declared once, and every label `scripts/label-pr.ts` applies has a release-notes category; the ignore lists agree on excluding `.claude/skills/`; the core boundary lists agree and `myapp-test-support` is dev-only; the IPC command and event lists agree; no raw color, `font-family`, or pixel font size outside `tokens.css`; no reference to this repository's issues or pull requests (`#` and digits, bare or after this repository's owner/repo — an upstream `owner/repo#N`, like its URL, is a source — an issue or pull-request URL on this repository or relative to it, the word issue, PR, pull request, or merge request before a number, `GH-` and digits, a `gh issue`/`gh pr` command given a number) in this file, `CLAUDE.md`, `.claude/rules/`, `.claude/agents/`, `docs/` (apart from the template's own design record, the roadmap, and the ADRs), a skill, or an issue form; `.claude/settings.json` names only recipes the justfile defines, and its `allow` admits none of the recipes the next row keeps out of it; and the `## Product` section stays a `TODO:` skeleton in the template and holds no `TODO:` once `scripts/bootstrap.ts` has run |
| `.claude/settings.json` — its only two top-level keys, `permissions` and `hooks` | every tool call Claude Code makes in this checkout | Claude Code only — Codex CLI and a human read nothing here | the routine local loop runs without a prompt: the `just` recipes that read, format, lint, build, or test without opening a window or writing to GitHub, and read-only `gh` (`gh pr view`/`list`/`checks`/`diff`, `gh issue view`/`list`, `gh run view`/`list`/`watch`, `gh api -X GET`/`--method GET`). Deliberately absent from `allow`, so they still stop for a human: the recipes that open the app or need a human (`dev`, `run`, `install-app`, `test-local`, `logs-follow`, `reset-permissions`), the ones that write beyond the working tree (`install`, `clean`, `labels`, `ruleset`, `release-prep`, `bootstrap`), `git push`, `gh pr create`, `gh pr merge`, and `gh issue create`; `scripts/checks/settings-allow-list.ts` fails when an `allow` rule, wildcards included, admits one of those recipes. `deny` refuses skipping the pre-commit hook, a force push, a `gh` read turned into a write or a browser window, and an edit to `src-tauri/Entitlements.plist` (an `Edit` rule covers every file-editing tool); JSON carries no comments, so read the deny list as groups — `git commit --no-verify`, `-n`, and the abbreviations git accepts (`--no-v*`); a `LEFTHOOK=`, `LEFTHOOK_EXCLUDE=`, `LEFTHOOK_BIN=`, or `LEFTHOOK_CONFIG=` assignment; `core.hooksPath` set through `git -c`, `git --config-env`, or `git config`; `--force`/`-f`, `--force-with-lease` with and without `=<ref>`, and a `+refspec` push; a second `-X`/`--method`, whatever its verb, after an allowed `gh api -X GET`/`--method GET`; and `--web`/`-w` on each allowed `gh` command that has it (`gh run list`'s `-w` is `--workflow`, and stays allowed) — each written in the leading, trailing, and mid-command position, where a pattern ending in `*` covers the last two at once. It is a prompt policy, not a boundary: a deny rule matches the command text Claude Code writes, so another spelling — `git -C . push --force`, `bash -c '…'`, a bundled short flag such as `git commit -anm "…"`, or `core.hookspath` in another case — is not stopped by it, and none of this constrains a human at a shell. `hooks` holds one `PostToolUse` hook, `scripts/format-edited-file.ts`, that formats the one `.rs` (rustfmt, fed on stdin so it never rewrites a `mod` child) or TypeScript, JavaScript, JSON, CSS, HTML, or YAML (Prettier, the extensions the pre-commit hook checks) file an `Edit`/`Write`/`MultiEdit` touched inside the checkout and reports a formatter failure back to the agent (exit 2) instead of hiding it — a convenience on this host only; the git hook and CI are the gate |
| CI (`.github/workflows/ci.yml` and the security workflows) | push to `main` and every pull request | everyone | the full gate: `Rust Core` (fmt, clippy on the Linux-buildable crates, core tests with floors, doctests, the bindings drift check, `cargo deny`, `cargo shear`), `Frontend` (tsc, ESLint, Prettier, UI tests with floors), `Repo Lint & Harness` (typos, actionlint, script tests, harness checks), `macOS Build & Smoke` (workspace clippy, `just test-macos`, `just build`, `just smoke`), `Template Bootstrap Smoke` (the bootstrap run on a throwaway copy, then `just check` there), `Workflow Security Lint` (zizmor), plus Dependency Review, the PR-title check, CodeQL, OSV-Scanner, Scorecard, and a weekly gitleaks scan |
| This file | read at session start | every agent | everything else — the reasons behind the rules above |

These gaps are deliberate. Closing one means adding a mechanism that enforces it —
a hook, a harness check, or a CI job — and then updating its row in the table above and
removing or narrowing its bullet here:

- **A UI-to-Rust wiring mistake that only the running app shows passes every gate.**
  There is no end-to-end driver on macOS (Tauri's WebDriver support has no WKWebView
  driver), so the UI is tested against `mockIPC` and the commands against
  `tauri::test`, each side alone; the launch smoke proves the app starts with its
  store, clock, and logging wired, not that a button reaches the command it should.
  The check is manual: `just run`, exercise the change, then `just logs`, and the PR
  carries that evidence (the `running-the-app` skill). Because `just run` opens a
  window, an agent asks the human to run it or waits to be asked (see "Never taking
  over the developer's Mac"), and review is what notices when the evidence is missing.
- **The hook can be skipped, and it fails open.** `git commit --no-verify` (or `-n`,
  or an abbreviation such as `--no-veri`), `LEFTHOOK=0`, `LEFTHOOK_EXCLUDE=<job>`,
  `LEFTHOOK_BIN` or `LEFTHOOK_CONFIG` pointed elsewhere, and
  `git -c core.hooksPath=<dir>` each commit without the staged guard; and lefthook's
  generated hook exits 0 after printing that it cannot find lefthook when no binary
  resolves, so a checkout whose tools went missing commits unchecked without an error.
  Git itself skips pre-commit for some commits: `git rebase --continue` commits a resolved
  conflict without it, `git am` and `git am --continue` run pre-applypatch instead, and a
  merge git concludes itself (a clean one, or `-X ours`/`-X theirs`) runs
  pre-merge-commit, which `lefthook.yml` does not configure.
  Nothing in this repository blocks these for every author. `.claude/settings.json`'s
  `deny` list refuses the usual spellings on Claude Code alone, and only as written,
  and `scripts/verify-hooks.ts` sees only that the hook file is lefthook's, not that
  its binary resolves or that no variable disables it. "Never bypass the hooks"
  therefore still holds as an instruction, and CI is the backstop — except for the
  staged guard, which no CI job reruns over a pull request's diff: GitHub push
  protection and secret scanning are the server-side layer for secrets, and
  `.github/workflows/security-audit.yml` runs gitleaks over the full history weekly, so
  a secret that slipped past both is found after the fact rather than never.
- **Hooks are absent on a bare clone until `just install` runs**, because
  `lefthook install` is part of that recipe. `scripts/verify-hooks.ts` narrows this: it
  fails loudly at `just install` and `just check` time when the hook is missing, so a
  clone whose hook silently failed to install no longer looks identical to one that
  succeeded. It does not close the gap — a contributor who runs neither still commits
  without hooks — so CI stays the backstop. `ALLOW_MISSING_GIT_HOOKS=1` opts out for an
  environment that genuinely cannot have git hooks; every failure names it.
- **Whether `main`'s ruleset is actually in force is invisible from the checkout.**
  The intended ruleset — PR required, checks green, no force-push or deletion — is
  defined as code in `.github/rulesets/main.json`; `just ruleset`
  (`scripts/apply-ruleset.ts`) creates or updates it via the GitHub API for whoever runs
  it as a repository admin. Nothing in the checkout verifies that it was applied —
  that is visible only via `gh api repos/{owner}/{repo}/rulesets`. "Use this template"
  does not copy rulesets, so every repository created from this template still needs
  its own admin to run `just ruleset` once.
- **Everything in `.claude/settings.json` applies to Claude Code only.** The
  `PostToolUse` hook formats the file an agent edited on that one host; the git hook,
  not this hook, is the real gate. The `permissions` block decides which commands that
  host runs without stopping to ask, so it shapes where a human is consulted rather
  than what is possible: Codex CLI, another agent, and a human at a shell are bound by
  the instructions in this file and by the gates above, not by that file.
- **Nothing runs the `#[ignore]`d tests for you.** A CI runner has no logged-in GUI
  session and cannot be granted a TCC permission or reach a login Keychain, so a test
  that needs one is `#[ignore = "local machine: …"]` and is reported as ignored by
  `just test-macos` and in CI. That is deliberate — an ignored test is visible where a
  missing one is not — and it leaves the run itself procedural: a change to such an
  adapter is expected to come with `just test-local` output in the PR, which a human
  runs, and review is what notices when it does not.
- **Nothing mechanical keeps a routine check from taking over the Mac.** The rule in
  "Never taking over the developer's Mac" holds because every recipe in `just check`
  was written to it and `.claude/settings.json` leaves the window-opening recipes out
  of `allow` (a harness check keeps them out, and `deny` refuses `gh … --web`); a new
  recipe or test that shows a window, takes focus, or raises a prompt is caught only
  by review.

## Review Checklist

Before submitting a PR:

1. `just check` passes (every step of the justfile's `check` recipe)
2. New public items have `///` doc comments explaining *why* (`missing_docs` warns on
   any that lack one), and a new IPC wrapper in `ui/src/ipc/` has a TSDoc comment
3. Tests cover the new behavior (happy path AND error path); a change to an adapter
   with an `#[ignore]`d test also carries `just test-local` output, and a change only
   the running app shows carries `just run` + `just logs` evidence, since no gate runs
   either
4. `ui/src/ipc/generated/` is regenerated (`just bindings`) and committed with the
   Rust type that changed it
5. No new crate or npm package without justification and a human's sign-off (see
   `.claude/rules/project.md`)
6. User-facing changes have a `CHANGELOG.md` entry under `[Unreleased]`
7. Commits and the PR title follow Conventional Commits (English)

## Important Reminders

- All code, docs, commits, and PRs must be written in English
- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files unless explicitly requested
- NEVER lower a coverage floor or relax a lint to make a check pass
- NEVER run a recipe that opens the app or needs a human (`just dev`, `just run`,
  `just install-app`, `just test-local`, `just logs-follow`, `just reset-permissions`)
  unless the human asked for it; `just smoke` and `just logs` are the evidence an agent
  gathers on its own
- A comment carries only what the code cannot: a non-obvious why, a trap the next edit
  would spring, an external constraint. Default to none, and keep the rest to a line or
  two — restating the code, or narrating how it came to be, is what the code and git
  already do. A `///` on a public item is its contract and stays (`.claude/rules/rust.md`)
- A problem you find outside the task is recorded, not fixed: file it as an issue with
  what `triaging-issues` asks of a body — a type label, a `path:line`, and an observable
  close condition — or, where filing is not yours to do (it is a remote write; see
  "Security and human approval"), list it in the pull request description. Never widen
  the pull request to fix it
- Keep lefthook's pre-commit hook to what is mechanically decidable and fast (format
  checks, lint, typos, the skills mirror, the staged guard); a judgement call — a
  relaxed config, a deleted workflow, a lowered threshold — is weighed in PR review,
  not blocked by the hook. `changing-gates` records why
