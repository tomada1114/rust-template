# rust-template: design

<!-- template-only: scripts/bootstrap removes docs/template/ from a generated app. -->

Status: **agreed with the owner on 2026-09-28.** This document is the spec the first
implementation run builds against. The companion [issue-triage.md](issue-triage.md)
sorts macos-app-template's open issues into what this template adopts, drops, or
defers, and [skills-plan.md](skills-plan.md) is the per-skill brief.

Each decision below lists the options, their trade-offs, and the choice. "Owner" marks a
choice the owner made between presented options; "Designer" marks one the design session
made and the owner accepted without change.

**Amended 2026-10-01: the CLI/TUI pivot (owner, tracking issue #161).** The repository
is renamed `rust-template` and stops being a template for Tauri macOS desktop apps. It
becomes a template for the owner's own Rust command-line tools — plain CLIs and
full-screen TUIs — on macOS and Linux. §1 is rewritten; D4, D5, D8, D12, D18, and D23 are
superseded (each marked below, D4 and D23 also listed in §4); D6, D7, D15, D16, D19, and
D22 are restated for the new stack. The other decisions keep their reasoning; where one
still names the removed GUI stack (`src-tauri/`, `ui/`, Node, pnpm, ESLint, Prettier,
Vitest, the `.dmg`, the sidecar), that detail goes with the stack, and the sibling
sub-issues of the tracking issue rewrite the code, gates, and docs to match. Git history
keeps the GUI stack.

## Contents

- [0. Glossary for a reader new to Rust](#0-glossary-for-a-reader-new-to-rust)
- [1. What this template is](#1-what-this-template-is)
- [2. Verified facts this design rests on](#2-verified-facts-this-design-rests-on)
- [3. Decisions](#3-decisions)
- [4. What was not carried over, and why](#4-what-was-not-carried-over-and-why)
- [5. Steps only a human can take](#5-steps-only-a-human-can-take)
- [6. Known risks](#6-known-risks)

## 0. Glossary for a reader new to Rust

| Term | Meaning here |
|---|---|
| crate | Rust's unit of packaging and compilation: one library or one executable, with its own `Cargo.toml`. |
| workspace | Several crates in one repository sharing one `Cargo.lock`, one `target/` build directory, and inherited settings (`[workspace.dependencies]`, `[workspace.lints]`). |
| trait | A named set of methods a type promises to provide; the Rust counterpart of a TypeScript `interface`. A *port* in this design is a trait. |
| feature | A named compile-time switch declared in `Cargo.toml` that turns optional code or dependencies on. |
| cargo | Rust's build tool, test runner, and package manager in one. |
| clippy | Rust's official linter (`cargo clippy`). |
| rustfmt | Rust's official formatter (`cargo fmt`). |
| `#[ignore]` | Marks a test that `cargo test` skips unless asked (`-- --ignored`); used here for tests that need a real logged-in Mac. |
| clap | The command-line argument parser the binary's subcommands are declared with (its derive API). |
| ratatui | The terminal UI library the `tui` subcommand draws with; it renders to a *backend*. |
| `TestBackend` | ratatui's in-memory backend: a test draws a frame into a buffer and asserts on its cells, with no real terminal involved. |
| raw mode / alternate screen | Terminal states a full-screen TUI enters (keys arrive unbuffered; a separate screen buffer is shown) and must leave on exit. |
| `cargo xtask` | A convention: a workspace crate named `xtask`, run through a cargo alias, that holds the repository's automation in Rust. |

## 1. What this template is

A public template for the owner's own Rust command-line tools: plain CLIs and full-screen
terminal UIs, built and run on macOS and Linux. Every tool cut from it is one binary,
`myapp`, whose clap subcommands do the work and whose `tui` subcommand opens a ratatui
interface over the same core. The layering stays: logic and ports in `myapp-core`
(coverage-gated, built and tested on Linux), OS adapters in `myapp-platform`, fakes and
contract suites in `myapp-test-support`, and the binary crate as the composition root
that parses arguments, wires the adapters, and translates. The counter sample stays as
the deletable illustration, reachable from both a subcommand and the TUI.

Settled before this document (owner decisions; the 2026-10-01 pivot replaced the first
set):

- **Targets:** macOS and Linux. The core's tests and lint run on Ubuntu runners; a macOS
  runner builds and tests what touches the OS there.
- **Shape:** one binary, `myapp`, with clap subcommands and a `tui` subcommand built on
  ratatui. No GUI of any kind.
- **Repository automation:** a Rust `cargo xtask` crate, not TypeScript under
  `scripts/`. Node, pnpm, ESLint, Prettier, and Vitest leave the repository.
- **Distribution:** none. No release workflow, signing, notarization, disk image,
  Homebrew tap, or release artifacts; a tool is installed with
  `cargo install --path` from its own checkout. Revisited only when a tool needs to reach
  other people.
- No LLM in the tool (no AI SDK, nothing that calls a model). The development harness —
  `AGENTS.md`, skills authored under `.agents/skills/` and mirrored to `.claude/skills/`,
  rules, sub-agents, gates, and harness checks — is kept and rewritten for the new stack;
  skills that only served the GUI are deleted.
- Public repository `tomada1114/rust-template` (renamed from `tauri-template`), with CI
  and supply-chain controls at the level of macos-app-template.

Non-goals: Windows; any GUI (a desktop window, a WebView, a menu-bar app); a release
pipeline or release artifacts (signed binaries, a disk image, a Homebrew tap, an
updater); crates.io publishing; an in-app LLM; localization (see issue-triage #119).

## 2. Verified facts this design rests on

Checked on 2026-09-28 against the primary source named. The implementation run
re-checks any version it pins (a newer patch is fine; a new major is a stop-and-record).

| Fact | Source |
|---|---|
| `tauri` 2.12.0, `tauri-build` 2.7.0, `@tauri-apps/cli` and `@tauri-apps/api` 2.12.0 (2026-09-26); `rust-version = 1.90`. | crates.io API; `npm view` |
| Tauri **3.0.0-alpha.3** is published (2026-09-26); npm's `next` tag points at it. Pin `tauri = "2"` / `^2`. | github.com/tauri-apps/tauri/releases |
| create-tauri-app 4.7.4 layout: `src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json,src/{main.rs,lib.rs}}`; `lib.rs` holds `run()`, `main.rs` only calls it. `src-tauri` may be a member of a workspace. | github.com/tauri-apps/create-tauri-app templates; v2.tauri.app/start/project-structure/ |
| App commands are allowed for every window by default; plugin commands need a capability permission. | v2.tauri.app/security/capabilities/ |
| `tauri-specta` / `specta` are **2.0.0-rc.25** (2026-05); no stable v2 release. `ts-rs` 12.0.1 is stable. | crates.io |
| `tauri-plugin-log` 2.10.0 rotates by size only (`max_file_size`, `RotationStrategy`); log dir on macOS is `~/Library/Logs/{identifier}`. `tracing-appender` 0.2.5 rotates daily. | v2.tauri.app/plugin/logging/; docs.rs |
| Sidecars: `bundle.externalBin`, each file suffixed with the target triple (`rustc --print host-tuple`); no documented way to build a workspace binary into place — the project supplies that step. | v2.tauri.app/develop/sidecar/ |
| `bundle.macOS`: `minimumSystemVersion` (default 10.13), `hardenedRuntime` (default true), `signingIdentity` (`"-"` = ad-hoc), `entitlements`. Notarization env: `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or `APPLE_API_ISSUER`/`APPLE_API_KEY`/`APPLE_API_KEY_PATH`; signing: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`. Ad-hoc signing is needed on Apple Silicon for a downloaded app and still requires the user to allow it in Privacy & Security. | v2.tauri.app/reference/config/; v2.tauri.app/distribute/sign/macos/ |
| WebDriver E2E: "only Windows and Linux are supported on desktop, as macOS has no WKWebView driver tool available". | v2.tauri.app/develop/tests/webdriver/ |
| `tauri::test` (feature `test`, marked unstable): `mock_builder`, `mock_context`, `noop_assets`, `get_ipc_response`. `@tauri-apps/api/mocks`: `mockIPC` (with `shouldMockEvents` since 2.7.0), `mockWindows`, `clearMocks`; jsdom needs a `crypto.getRandomValues` polyfill. | docs.rs/tauri/2.12.0/tauri/test; v2.tauri.app/develop/tests/mocking/ |
| `withGlobalTauri` defaults to false; CSP applies only when configured; the isolation pattern is recommended but not default. | v2.tauri.app/reference/config/; v2.tauri.app/security/csp/ |
| Rust 1.98.1 stable (2026-09-03); edition 2024 since 1.85; `resolver = "3"` must be explicit in a virtual workspace. | rust-lang/rust releases; Cargo book |
| mise's `rust` tool delegates to rustup; rustup reads `rust-toolchain.toml`. Renovate has both a `mise` and a `rust-toolchain` manager. | mise.jdx.dev/lang/rust.html; renovatebot/renovate `lib/modules/manager/` |
| `cargo-llvm-cov` 0.9.1 supports `--fail-under-lines` and `--fail-under-functions`; `cargo-nextest` 0.9.146 does not run doctests; `cargo-deny` 0.20.2 bans support `wrappers`; `cargo-shear` 1.14.0; `cargo-vet`'s last release is 2024-10. | GitHub releases of each; cargo-deny docs `checks/bans/cfg.md` |
| typescript-eslint 8.71.0 peers `typescript >=4.8.4 <6.1.0`; TypeScript's `latest` is 7.0.2 — so TypeScript is pinned to 6.0.x. `eslint-plugin-jsx-a11y` 6.10.2 peers ESLint ≤ 9. | `npm view` |
| Versions at design time: vite 8.3.1, react 19.3.0, vitest 5.0.2, eslint 10.11.0, pnpm 12.6.0, just 1.58.0, lefthook 2.1.14, zizmor 1.30.1, gitleaks 8.30.1, actionlint 1.7.12, typos 1.50.x. | npm; GitHub releases |
| CodeQL lists Rust (editions 2021/2024), JavaScript/TypeScript, and GitHub Actions; `github/codeql-action` is v4. | codeql.github.com supported-languages page |
| `macos-latest` is macOS 26 arm64; public repositories use standard runners free. macOS 26 is the last macOS release for Intel Macs. | actions/runner-images; GitHub Actions billing docs; Apple WWDC 2025 |

Corrections to the pre-design survey: typescript-template's `scripts/check-staged.mjs`
detects secrets only — its tests assert it *allows* weakening a config file — and
typescript-template has no CodeQL, OSV, Scorecard, zizmor, Renovate, or ruleset; those
come from macos-app-template alone.

## 3. Decisions

### D1. Repository layout and crate names — Designer

Options: (a) create-tauri-app's layout, frontend at the root and a single `src-tauri`
crate; (b) a root virtual workspace with the logic split into crates, frontend in its
own directory; (c) a separate repository per layer.

Choice: **(b)**. A single crate cannot keep OS and Tauri code out of the logic, which is
the point of the split; (c) costs a release process per layer for a personal app.

```
Cargo.toml                 # virtual workspace: members, resolver = "3", [workspace.package],
                           #   [workspace.dependencies], [workspace.lints]
rust-toolchain.toml        # the one Rust pin (channel; clippy, rustfmt, llvm-tools; aarch64-apple-darwin)
crates/
  myapp-core/              # domain logic, state, ports (traits). No tauri, no OS APIs, no
                           #   direct I/O. Built and tested on Linux. Coverage-gated.
  myapp-platform/          # adapters implementing core's ports against the real OS and
                           #   filesystem; macOS-specific code behind cfg(target_os = "macos")
  myapp-test-support/      # fakes for every port + one contract function per port (dev-only)
  myapp-cli/               # the bundled helper executable (D5)
src-tauri/                 # crate `myapp`: the Tauri shell and composition root. Commands and
                           #   events are thin translations to and from core; no decisions.
  tauri.conf.json, capabilities/, icons/, build.rs, Entitlements.plist
ui/                        # React + Vite + TS (index.html, src/, vite.config.ts)
  src/ipc/                 # the only code that imports @tauri-apps/api
  src/ipc/generated/       # ts-rs output, committed, never hand-edited
  src/copy/                # every user-facing string
package.json, pnpm-lock.yaml, pnpm-workspace.yaml   # one package at the root, Vite root = ui/
scripts/                   # repository automation in TypeScript (D12)
```

The crate is never named `core`: that name is taken by Rust's built-in `core` library,
and `use core::…` would become ambiguous. Every crate carries the app-name prefix, which
the bootstrap renames. `myapp` (the Tauri crate) keeps create-tauri-app's `lib.rs` +
`main.rs` split and its `[lib] crate-type`.

### D2. Ports and adapters — Designer

Core declares a port as a `Send + Sync` trait; `myapp-platform` implements it;
`src-tauri` constructs the real adapters and hands them to core; tests hand core a fake
from `myapp-test-support`.

- Ports are **synchronous**. Core is plain functions and state, so a reader new to Rust
  meets no async. The Tauri shell calls a slow port on a blocking thread
  (`tauri::async_runtime::spawn_blocking`). A port that is inherently a stream is modelled
  as a callback or a channel the shell drives, not async trait methods.
- Errors: one `thiserror` enum per port or per core module, typed codes that the UI maps
  to wording (`ui/src/copy/`), never user-facing sentences from Rust; no user data in an
  error or a log line.
- Contract suites (issue #141): `myapp-test-support` exports, per port, a fake and a
  function `pub fn <port>_contract(make: impl FnMut() -> Box<dyn Port>)` holding the
  behavioural assertions. `myapp-core`'s integration tests (`crates/myapp-core/tests/`,
  never its inline `#[cfg(test)]` modules, where test-support's types would come from a
  second copy of core) run it against the fake (Linux, coverage-gated);
  `myapp-platform`'s tests run it against the real adapter — on the macOS CI runner when it
  needs only a filesystem, under `#[ignore = "local machine: <what it needs>"]` when it needs
  a GUI session, a TCC grant, or the Keychain, which `just test-local` runs.
- Test-only code never ships: `myapp-test-support` is a `[dev-dependencies]` entry only,
  and a harness check fails if a non-dev dependency edge points at it.

### D3. Enforcing the boundaries — Designer

Rust, three layers, each able to fail on its own:

1. **Compile time.** `myapp-core`'s `Cargo.toml` lists no tauri, OS, or platform crate, so
   code there cannot name them.
2. **The dependency closure, checked.** A harness check reads `cargo metadata` and fails
   if `myapp-core`'s normal (non-dev) dependency closure contains `tauri*`, `wry`, `tao`,
   `objc2*`, `core-foundation*`, `security-framework*`, or `myapp-platform` — the
   counterpart of macos-app-template's `ArchitectureBoundaryTests`. cargo-deny `[bans]`
   with `wrappers` adds a second, direct-edge rule: `tauri` may be a direct dependency of
   `myapp` only (plus any `tauri-plugin-*` crate an app later adds, listed in the same
   entry), and `myapp-platform` of `myapp` and `myapp-cli` only. macOS binding crates are
   *not* put under `wrappers`: Tauri's own dependencies (`wry`, `tao`) depend on them
   directly, so a wrapper list could never pass; the closure check covers them.
3. **clippy in core.** `crates/myapp-core/clippy.toml` sets `disallowed-macros`
   (`std::print`, `std::println`, `std::eprint`, `std::eprintln`, `std::dbg`),
   `disallowed-types` (`std::process::Command`,
   `std::fs::{File, OpenOptions, DirBuilder}`,
   `std::net::{TcpStream, TcpListener, UdpSocket}`), and `disallowed-methods` (every
   `std::fs` free function, `std::os::unix::fs::symlink`, `std::path::Path`'s
   file-system queries, `std::net::ToSocketAddrs::to_socket_addrs`,
   `std::io::{stdin, stdout, stderr}`, `std::time::SystemTime::{now, elapsed}`,
   `std::time::Instant::{now, elapsed}`, `std::env`'s argument, variable, and directory
   functions, `std::thread::{spawn, sleep}`, `std::thread::Builder::spawn`,
   `std::process::{exit, abort}`) — I/O, time, and environment reach core only through
   ports. `clippy::wildcard_enum_match_arm` is denied in core (issue #134: exhaustive
   matches on core enums). The implementation run proves clippy reads the crate-local
   `clippy.toml` by adding a banned call and watching clippy fail; if it does not, a
   harness check that scans core's sources for the banned paths replaces it, and the
   switch is recorded as a deviation.

A harness check keeps the lists honest the way macos-app-template's
`core-ban-lists-agree.sh` does: the forbidden crates the boundary section of `AGENTS.md`
names match the closure check's list and `deny.toml`'s wrapper entries.

TypeScript: ESLint `no-restricted-imports` (core rules, no plugin — typescript-template's
approach) forbids `@tauri-apps/*` outside `ui/src/ipc/`, and forbids importing
`ui/src/ipc/generated/` from anywhere but `ui/src/ipc/`. `no-console` outside
`ui/src/ipc/log.ts` (which forwards to Rust) and `scripts/`.

### D4. Types across IPC — superseded 2026-10-01

There is no IPC: the subcommands and the TUI call core directly in one process, so
`ts-rs`, the generated bindings, the hand-written wrappers, and the command/event drift
check go with the GUI (§4). What remains of the decision is the rule that every value a
front end shows is a core view type (`CounterView`), so a subcommand's output and a TUI
frame read the same model.

### D5. One binary with subcommands — Owner (2026-10-01; supersedes the bundled sidecar)

Options: (a) a separate helper crate next to the app, as the sidecar was; (b) one binary,
`myapp`, whose clap subcommands are the CLI and whose `tui` subcommand is the full-screen
interface; (c) two binaries, a CLI and a TUI, sharing core and platform.

Choice: **(b)**. One install (`cargo install --path`) yields every entry point; the
scheduler-friendly headless use the sidecar existed for is now simply a subcommand; and
there is one composition root to wire adapters in.

- The binary crate parses arguments with clap's derive API, builds the real adapters,
  and dispatches. A subcommand's handler is a thin translation: call core, print the view
  or map the typed error to wording and an exit code. `tui` hands the same core and
  adapters to the ratatui loop.
- Output: a subcommand prints its result to stdout and its error wording to stderr, with
  a non-zero exit code per error kind; a `--json` form of a view is added when a tool
  needs machine-readable output, not by default.
- The separate `myapp-cli` crate, `scripts/build-sidecar.ts`, `bundle.externalBin`, and
  the `sidecar` recipe go with the GUI.

### D6. The sample app — Owner: counter + persistence + clock, restated 2026-10-01

A counter whose rules live in core (`Counter` with a bounded range and
`increment`/`decrement`/`reset`, returning a typed error at the bound), exercising every
frame the template claims, from both front ends:

| Frame | In the sample |
|---|---|
| Port + adapter + contract | `CounterStore` port; `JsonFileCounterStore` in platform writes `counter.json` under the tool's data directory atomically (write to a temp file, rename); `InMemoryCounterStore` fake. |
| Injected time | `Clock` port; `SystemClock` in platform; `FixedClock` fake. Both front ends show "last changed" from core's `CounterView { value, last_changed_at }`. |
| Subcommands | `myapp counter show`, `increment`, `decrement`, `reset`, each printing the resulting view, with `--help` and an exit code per error kind. |
| TUI | `myapp tui` shows the counter and changes it by key (the keys listed in a help line on screen); the state machine that turns a key into a core call is a plain function the tests drive without a terminal (D15). The TUI redraws after its own changes; it watches nothing, and the doc says where a file watcher would go when another process changing `counter.json` must show live. |
| Logging | Each change logs one `tracing` event (D7). |
| Errors | `CounterError::{AtMaximum, AtMinimum, Storage { kind }}`; the binary maps each variant to wording in one module, never in core. |
| Accessibility | No meaning carried by color alone in the TUI; every action reachable from the keyboard and named in the help line. |

Every part of the sample is a deletable illustration (issue #135): `starting-an-app`
lists what to delete when replacing it.

### D7. Logging — Designer, restated 2026-10-01

Options: (a) `log` + `env_logger` to stderr; (b) `tracing` + `tracing-subscriber` +
`tracing-appender` — daily rotation, one logging API across every crate.

Choice: **(b)**. Platform and the binary log through the `tracing` macros (core logs
nothing); only the binary installs a subscriber (`myapp_platform::init_logging`). Files go
to the platform's log location — `~/Library/Logs/<identifier>/` on macOS, under the XDG
state directory (`$XDG_STATE_HOME`, default `~/.local/state`) on Linux — rotated daily,
keeping the last 14 files. The appender writes synchronously (no `non_blocking` worker):
the volume is low and a background writer can lose the last lines at exit.

- **Never to the terminal while the TUI runs.** A log line written to stdout or stderr
  while ratatui owns the screen corrupts the frame, so the subscriber writes only to the
  file in the `tui` subcommand. A plain subcommand may also log to stderr in debug
  builds; its stdout carries only the command's output, so it stays pipeable.
- `just logs` prints the newest file's last lines and exits; `just logs-follow` follows
  it for a human (it never ends, so an agent never runs it). `println!` is banned in core
  by clippy and limited elsewhere to a subcommand's output by `.claude/rules/rust.md`.

### D8. Terminal UI stack — Owner (2026-10-01; supersedes the React frontend stack)

ratatui for drawing, over its crossterm backend, which works on macOS and Linux. The UI
is immediate-mode: one `draw(frame, &state)` function renders a core view, and one
`update(state, event) -> state` function turns a key or a tick into a core call and the
next state; the loop that reads real terminal events and enters raw mode and the
alternate screen is a thin shell around them, kept small because no check runs it (D22).

- The terminal is always restored — raw mode left, the alternate screen exited, the
  cursor shown — on a normal exit, on an error returned up the loop, and on a panic (a
  panic hook restores it before the message prints).
- Styling uses ratatui's `Style` through one theme module, with the terminal's own
  default colors as the base, so a tool reads in light and dark terminals alike; no color
  carries meaning alone.
- React, Vite, TypeScript, ESLint, Prettier, Vitest, the CSP, capabilities, and the
  pnpm supply-chain settings go with the GUI.

### D9. Tool pinning — Designer

- Rust: `rust-toolchain.toml` is the one pin (Renovate's `rust-toolchain` manager bumps
  it); mise does not pin Rust a second time.
- Node and pnpm: Node in `mise.toml`; pnpm once, in `package.json`'s `packageManager`
  (typescript-template: pnpm's version is written in one place).
- Everything else in `mise.toml`, preferring prebuilt binaries (aqua/github backends)
  over the `cargo:` backend, which compiles from source: `just`, `lefthook`,
  `cargo-llvm-cov`, `cargo-nextest`, `cargo-deny`, `cargo-shear`, `typos`, `actionlint`,
  `zizmor`, `gitleaks`, `shellcheck` (only if a shell script remains).
- Never `latest`; bumps arrive as Renovate PRs with a 7-day minimum release age.

### D10. Task runner — Designer

`just`, as in macos-app-template (`cargo xtask` cannot naturally drive pnpm and mise).
Recipes, each a thin call into cargo, pnpm, or `scripts/`:

`install` (mise install, `pnpm install --frozen-lockfile`, lefthook install,
verify-hooks), `dev` (`tauri dev`), `fmt`, `fix`, `lint`, `test` (`test-core` + `test-ui`),
`test-core` (core with its coverage floors, and doctests), `test-ui` (Vitest with its floors), `test-fast <filter>`, `test-macos` (platform and shell
tests that need macOS but no human), `test-local` (`#[ignore]`d tests), `test-scripts`,
`check-harness`, `bindings`, `build` (debug `.app`), `run` (build, quit any running
instance, launch), `smoke` (release `.app` launch smoke), `sidecar` (build the helper into
`src-tauri/binaries/`; every recipe that compiles the Tauri crate depends on it, because
`tauri-build` fails when an `externalBin` file is missing), `logs`, `logs-follow`,
`reset-permissions`, `check`, `agents-sync`, `agents-check`, `deny`, `clean`, `prune-temp`, `labels`,
`ruleset`, `release-prep <version>`, `bootstrap`, `install-app` (build the release `.app`
and copy it to `~/Applications`, replacing an older copy only after quitting it — a
personal app is used from a local build, which Gatekeeper never quarantines).

`just check` runs everything a developer's Mac can run without a human:
verify-hooks → fmt → lint → test-scripts → check-harness → test → test-macos → build →
smoke. A harness check keeps it equal to CI's steps apart from a reasoned exception list
(macos-app-template's `just-check-matches-ci`).

### D11. Git hooks — Designer

lefthook (pinned in mise), because the repository is polyglot and lefthook gives
staged-file globs per language and parallel jobs from one YAML file. Pre-commit stays
**check-only and fast** (the #140 decision): `cargo fmt --check` on staged Rust,
`prettier --check` and `eslint` on staged TS, `typos` on staged files, the skills-mirror
check when a skill path is staged, and the staged guard (`scripts/check-staged.ts`:
secret-shaped paths and credential-shaped content, ported from both references). No
clippy, compile, or tests in the hook. `scripts/verify-hooks.ts` (`just install`'s last
step and `just check`'s first) fails if lefthook's hook is not installed, with the
`ALLOW_MISSING_GIT_HOOKS` opt-out and a CI skip.

### D12. Repository automation in `cargo xtask` — Owner (2026-10-01; supersedes TypeScript scripts)

Options: (a) bash; (b) TypeScript run by Node, as before; (c) a Rust `xtask` crate.

Choice: **(c)**. With the UI gone, Node would be kept only for the scripts; a Rust
`xtask` needs no second toolchain, shares the workspace's lints and gates, and gives the
owner one language to read. It is a workspace member named `xtask`, run through a cargo
alias (`cargo xtask <task>`), never shipped, and outside core's coverage floor.

- The rules the TypeScript scripts followed carry over: real parsers for structured files
  (TOML, YAML, JSON crates, never a regex over YAML or TOML); `GIT_*` stripped from
  spawned git, except where the staged guard deliberately inherits `GIT_INDEX_FILE`; the
  failure contract — first stderr line `ERR_<STAGE>_<WHAT>: …`, then `Expected:`,
  `Actual:`, `Next:`, exit 1, never printing a secret; refuse or skip outside a git work
  tree as each task's header states; each harness check takes `--root` so its tests run
  against a fixture tree.
- Every task has tests that call it with fakes for its child processes and a temporary
  directory, never the real checkout. Whether xtask carries a coverage floor of its own
  is decided by the sub-issue that ports the scripts.
- `just` recipes stay the entry points (D10); a recipe calls `cargo xtask …` where it
  called `node scripts/….ts`. A skill's bundled scripts may keep their language when
  ported with their tests (`shipping-issues`' Python and shell), as before.

### D13. Gates — Designer

| Gate | Setting |
|---|---|
| rustfmt | stable options only (`edition = "2024"`, `max_width = 100`); `cargo fmt --check`. |
| clippy | `[workspace.lints.clippy]` `all` and `pedantic` at warn (priority -1), `unwrap_used`/`expect_used` at warn outside tests; `[workspace.lints.rust]` `unsafe_code = "forbid"` in every crate (an app whose platform adapter needs FFI changes that crate's setting through an ADR, with `// SAFETY:` comments required by `clippy::undocumented_unsafe_blocks` — `integrating-system-apis` says how); CI runs `cargo clippy --workspace --all-targets --locked -- -D warnings` (macOS) and the Linux-buildable crates on Linux. |
| Rust coverage | `cargo llvm-cov nextest -p myapp-core --fail-under-lines 80 --fail-under-functions 80` (issue #133). Platform, shell, and CLI are outside the floor: they translate, and core decides. |
| Rust tests | `cargo nextest run --locked`, plus `cargo test --doc --locked`. |
| Supply chain (Rust) | `cargo deny check` (advisories, licenses allow-list, bans with `multiple-versions = "warn"`, sources: crates.io only), `cargo shear`; advisory scope per D17. |
| TS | `tsc --noEmit`, ESLint `--max-warnings 0`, Prettier check, Vitest with per-glob floors: `ui/src/**` lines/functions 80 (excluding `main.tsx` and `ipc/generated/`), `scripts/**` and `.agents/skills/*/scripts/**` 85/90, `scripts/lib/guard/**` 90/100. |
| Repo | typos (excluding `.claude/skills/`, issue #139), actionlint, zizmor, the skills-mirror check, the harness checks (D14). |

What weakening a gate means here is listed in `AGENTS.md` › Security and human approval,
translated from macos-app-template: `#[allow(...)]`/`#[expect(...)]` or an
`// eslint-disable` to pass a check, lowering a floor, excluding a file from coverage,
`#[ignore]` on a failing test, `unsafe` to silence the borrow checker, adding to an
ignore list, `continue-on-error`, `--no-verify`.

### D14. Harness self-checks — Designer

`just check-harness` runs `scripts/checks/*.ts` (each runnable against a fixture root with
`--root`, each with fixture tests), porting macos-app-template's checks and the day-one
improvements from the triage:

- every `just <recipe>` named in `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, and skills exists;
- workflow hygiene with a real YAML parser (issue #129): SHA pins with `# vX.Y.Z`, job
  `timeout-minutes`, job-level `permissions` with a top-level default of at most
  `contents: read`, `persist-credentials: false`, `concurrency` on PR workflows that never
  cancels `main` push runs, no `pull_request_target`, fail-closed `run:` blocks,
  `--frozen-lockfile`/`--locked`, bot commit prefixes within the PR-title types;
- cooldowns agree: Dependabot's `cooldown`, Renovate's `minimumReleaseAge`, pnpm's
  `minimumReleaseAge`;
- every required status context in `.github/rulesets/main.json` names a job in a
  `pull_request`-triggered workflow;
- `just check` equals CI's steps apart from a reasoned exception list;
- skills: frontmatter is exactly `name` + `description`, the description is printable
  ASCII ≤ 1,024 characters and parses under Codex CLI's YAML, no nested `SKILL.md`, body
  ≤ 200 lines (issue #166), the Skills table in `AGENTS.md` matches `.agents/skills/`;
- every label an issue form, workflow, Dependabot, or Renovate applies is declared once
  in `.github/labels.yml`; every label `pr-label` applies has a release-notes category;
- the tools' ignore lists agree on excluding `.claude/skills/` (issue #139);
- the boundary lists agree (D3) and `myapp-test-support` is dev-only (D2);
- the IPC command and event lists agree (D4);
- no `#NNN` issue references in `AGENTS.md` or skills (issue #109);
- `AGENTS.md` › Product is a `TODO:` skeleton while the template's placeholders remain,
  and has no `TODO:` once the bootstrap has run;
- `.claude/settings.json` names only recipes the justfile defines. (2026-10-01: the
  committed file was removed, see D20; the check now applies only to one added later.)

### D15. Testing strategy — Designer, restated 2026-10-01

No test drives a real terminal (D22). Each layer is tested where it can be without one:

| Layer | Tool | Runs on |
|---|---|---|
| Core logic | `#[test]` in `myapp-core`, fakes from test-support, contract suites | Linux (coverage floor) |
| Adapters | contract suites against real adapters, a temp directory per test | Linux and macOS CI; `#[ignore]` ones via `just test-local` |
| Subcommands | integration tests that run the built `myapp` with a temp data directory and assert stdout, stderr, and the exit code per error kind; argument parsing checked with clap's `Command::debug_assert` | Linux and macOS CI |
| TUI rendering | `draw` into ratatui's `TestBackend` and assert the buffer's cells (text and style) for each state: the normal view, an error, the bounds | Linux (with core) and macOS CI |
| TUI behaviour | `update` driven with key events built as values, asserting the next state and the core calls a fake recorded | Linux and macOS CI |
| Wiring | a smoke run of the built binary (D22): `myapp --version`, and a subcommand against a temp data directory, proving the store, clock, and logging were wired | `just check`, both CI runners |

The gap this leaves — the real terminal loop (raw mode, the alternate screen, resize,
restoring the terminal on exit) — is named in `AGENTS.md` › Enforcement layers, with a
human running `myapp tui` as the manual check a PR carries evidence of (the
`running-the-app` skill).

Rules for tests (issue #134) live in `.claude/rules/testing.md` and the `tdd` skill: an
oracle independent of the implementation, the contract suite, an injected clock never a
sleep, a temp directory per test, exhaustive matches, where each kind of test goes.

### D16. CI — Designer, restated 2026-10-01

Workflows (job names are the ruleset's required contexts; changing them needs the owner
to re-apply the ruleset):

| Workflow | Job name | Runner | Does |
|---|---|---|---|
| `ci.yml` | `Rust Core` | ubuntu | fmt check; clippy `-D warnings` on the workspace; nextest + llvm-cov floors on core; doctests; the workspace's tests, the TUI's `TestBackend` tests included; `cargo deny check`; `cargo shear` |
| `ci.yml` | `Repo Lint & Harness` | ubuntu | typos; actionlint; skills mirror; xtask's tests; harness checks |
| `ci.yml` | a macOS job | macos-26 | workspace clippy `-D warnings`; the workspace's tests, platform adapters included; build; the smoke run |
| `ci.yml` | `Template Bootstrap Smoke` | ubuntu | template-only: run the bootstrap verification, bootstrap a throwaway copy, then `just check` there |
| `ci.yml` | `Workflow Security Lint` | ubuntu | zizmor |
| `dependency-review.yml` | `Dependency Review` | ubuntu | license allow-list, severity gate |
| `check-pr-title.yml` | `Validate PR title` | ubuntu | Conventional Commits |
| `pr-label.yml` | — | ubuntu | the labeller from the base SHA (issue #126) |
| `codeql.yml` | — | ubuntu | languages `rust` and `actions`; push, weekly |
| `osv-scan.yml` | — | ubuntu | `Cargo.lock`; PR + weekly |
| `scorecard.yml` | — | ubuntu | weekly |
| `security-audit.yml` | — | ubuntu | weekly gitleaks over full history, pinned via mise (issue #138) |

The `Frontend` job and `release.yml` go with the GUI and with distribution (D18). Every
job: SHA-pinned actions with version comments, `persist-credentials: false`, job-level
least-privilege `permissions`, `timeout-minutes`, `concurrency` keyed on the ref that
cancels only pull-request runs. Tools come from `jdx/mise-action`; Rust builds are cached
with `Swatinem/rust-cache`. Every cargo command passes `--locked`.

### D17. Supply chain — Designer

SHA pins + zizmor; CodeQL (Rust, JS/TS, Actions); OSV-Scanner; OpenSSF Scorecard;
Dependency Review with a license allow-list; `cargo deny` (advisories, licenses, bans,
sources); pnpm's release-age and build-script allow-list; Dependabot for `cargo`, `npm`,
and `github-actions` (weekly, 7-day cooldown, minor+patch grouped, majors alone, prefixes
`deps:`/`ci:`); Renovate limited to the `mise` and `rust-toolchain` managers with the same
7-day minimum release age; weekly gitleaks; the ruleset as code
(`.github/rulesets/main.json`, no bypass actors); `SECURITY.md` pointing at private
vulnerability reporting. `Cargo.lock` and `pnpm-lock.yaml` are committed.

Advisory scope (owner, 2026-09-28). `Cargo.lock` lists every platform's dependencies, and
Tauri's Linux stack (GTK bindings) carries advisories for code this macOS-only app never
ships. So: `deny.toml` sets `[graph] targets` to `aarch64-apple-darwin` — defining what is
shipped, not ignoring anything; unmaintained-crate advisories count only for crates the
workspace depends on directly. OSV-Scanner may ignore an advisory only for a crate absent
from `cargo tree --target aarch64-apple-darwin`, each entry with its reason and an
`ignoreUntil` 90 days out. A vulnerability in a shipped crate is fixed by updating; only
when no fixed release exists may it be ignored, with its reason, a 90-day expiry, and a
tracking issue. Every entry is recorded in the implementation notes.

### D18. No distribution — Owner (2026-10-01; supersedes the `.dmg` release)

There is no release pipeline: no `release.yml`, no signing or notarization, no disk image,
no Homebrew tap, no release artifacts, and no crates.io publishing. A tool is built and
installed from its own checkout with `cargo install --path` on the binary crate, which
needs no secret, no tag, and no CI. `CHANGELOG.md` and the version in `Cargo.toml` stay,
so a tool still records what changed; a `v*` tag remains a human act if one is wanted.

The entitlements file, the signing settings, the `APPLE_*` secrets, the `release`
environment, and the release-tags ruleset's purpose of protecting release builds go with
the GUI. Revisited — as an ADR in the app — only when a tool needs to reach other people.

### D19. Bootstrap — Designer, restated 2026-10-01

The bootstrap is an xtask (`cargo xtask bootstrap`, D12), with macos-app-template's
scope: prompts or flags for display name (`MyApp`), slug (`myapp`, used for crate names
and the binary), identifier (`com.example.myapp`, which keys the data and log
directories on macOS), GitHub `owner/repo`, author, and copyright holder. It rewrites an
explicit list of placeholder sites (never a global replace), renames the crate
directories, updates `Cargo.lock` offline, removes `<!-- template-only -->` blocks and
`docs/template/`, resets `CHANGELOG.md` and the version to 0.1.0, removes itself, then
prints next steps — fill `AGENTS.md` › Product, fill `docs/architecture/roadmap.md` with
`steering-the-roadmap` (issue #172), `just install`, `just labels`, `just ruleset`, the
GitHub security settings.

A verification task bootstraps a temporary copy and fails on any leftover placeholder or
template-only marker, a dangling skill reference, or a mismatch between names. CI's
`Template Bootstrap Smoke` runs it, then bootstraps a fresh `git clone` with a hyphenated
multi-word slug (so the hyphen, underscore, and upper-case forms are all exercised),
asserts the harness check fails with the Product-section code — the check must fire on
an unfilled app — then writes a stub Product section in that copy and runs `just check`
there. It no longer needs a macOS runner. The bootstrap removes this job and its ruleset
context from the generated app.

### D20. Agent harness — Designer

- `AGENTS.md` follows macos-app-template's structure (what it owns, Overview, Product
  skeleton, Quick Reference, Validating a change table, Architecture, Before changing
  the architecture, Skills, Rules, Sub-agents, Security and human approval, Repository
  scripts, Enforcement layers with its named gaps, Review Checklist, Important
  Reminders); `CLAUDE.md` imports it.
- `.claude/rules/`: `rust.md` (Rust written for a reader new to it: no `unwrap` in
  non-test code, `?` with typed errors, `pub(crate)` by default, no `unsafe` outside
  platform, constants' home, ownership tips), `typescript.md`, `testing.md`, `project.md`
  (dependency policy: any new crate or npm package needs a reason and human sign-off),
  `docs.md`.
- `.claude/agents/`: `executor`, `architect`, `worker`, as macos-app-template.
- `.claude/settings.json`: allow the read/build/test recipes and read-only `gh`; deny
  `--no-verify`, force pushes, and edits to `src-tauri/Entitlements.plist`; a PostToolUse
  hook that formats the one edited `.rs`/`.ts`/`.tsx` file.
  **2026-10-01: removed.** The committed settings file is gone, as in ios-template and
  nextjs-app-template: which commands an agent runs without a prompt, and the
  format-on-edit hook, are each person's choice in `~/.claude/settings.json` (generic
  rules: git, `gh`, the hook-bypass and force-push denies) or the gitignored
  `.claude/settings.local.json` (this repository's recipes, dependency changes, the
  `Entitlements.plist` edit deny), and Codex CLI's in a gitignored
  `.codex/rules/local.rules`. A committed list imposed one person's trust level on every
  clone of an app, and its deny list was a prompt policy rather than a gate; the gates
  and `AGENTS.md` are what bind every author. The two harness checks that read the file
  stay, for a repository that adds one back.
- Skills: 26, authored under `.agents/skills/` and mirrored by `just agents-sync`,
  carried over substantially from the three source repositories and rebuilt for Rust +
  Tauri. The per-skill brief — sources, what changes, what is dropped and why, the rules
  under `.claude/rules/`, and the review pass — is [skills-plan.md](skills-plan.md).

### D21. Documents — Designer

`README.md` (Quickstart, Design Philosophy with a "Why" per decision above, Using This
Template, Development, Documentation, License), `CONTRIBUTING.md`, `CHANGELOG.md` (Keep a
Changelog, `[Unreleased]`), `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE` (MIT),
`docs/architecture.md` (crates, ports, IPC, what is contract — public core API, bundle
identifier, IPC command/event names, on-disk file formats), `docs/distribution.md`,
`docs/getting-started.md`, `docs/architecture/README.md` (empty ADR index),
`docs/architecture/adr/template.md`, `docs/architecture/roadmap.md` (skeleton),
`.github/` issue forms, PR template, `labels.yml`, `release.yml`.

### D22. Never taking over the developer's machine or terminal — Owner, restated 2026-10-01

The owner develops on the same machine the checks run on, often while an unattended
agent iterates in a terminal next to their own. Owner's words (2026-09-28): running the
tests must never interrupt their work — unit tests, fakes, and headless runs come first.
So nothing a routine check runs — `just check` and every recipe in it, the pre-commit
hook, the agent's PostToolUse hook, and any step an agent runs to verify its own work —
may show a window, take keyboard focus, move the pointer, or raise a permission,
Keychain, or Gatekeeper prompt; and, now that the template's UI is a terminal one, none
may take over a terminal:

- **No real terminal in a check.** No check enables raw mode, enters the alternate
  screen, reads a key from a real terminal, or depends on being attached to a TTY. TUI
  rendering is tested against ratatui's `TestBackend`, and TUI behaviour by feeding key
  events as values to the `update` function (D8, D15). A check never runs `myapp tui`.
- **Headless smoke.** The smoke run executes the built binary non-interactively —
  `--version` and a subcommand against a temporary data directory — with stdin not a
  terminal, asserts the exit code and that the log file gained its line, and leaves
  nothing behind outside its temp directory.
- **Interactive on request only.** `myapp tui` and the recipes that run the tool for a
  human are never part of `just check`; the `running-the-app` skill tells an agent to use
  the tests and the smoke run for evidence, and to ask the human to run the TUI when a
  change only the real terminal shows needs eyes on it. `just test-local` and
  `just logs-follow` are likewise human-started only.
- **Human-only tests.** A test that needs a GUI session, a TCC grant, the Keychain, or a
  real terminal is `#[ignore = "local machine: <what it needs>"]` and runs only in
  `just test-local`. The sample has none.
- **No tool installs prompts.** `just install` needs no `sudo` and opens no installer; a
  missing system tool is reported with the command to run, not triggered.

### D23. The base design system — superseded 2026-10-01

Removed with the GUI (§4): the CSS tokens, primitives, design-system document, literal
check, contrast test, and the design-lock ADR step all served the WebView. A TUI's
styling is D8's one theme module over the terminal's own colors; an app that wants a
distinctive look records it as an ADR like any other decision.

## 4. What was not carried over, and why

| From | Mechanism | Why not |
|---|---|---|
| macos-app-template | XcodeGen, `project.yml`, `.xcode-version`, the `select-xcode` action, SwiftLint, SwiftFormat, Swift Testing, `LaunchUITests` | Swift/Xcode-specific; Cargo, clippy, rustfmt, and the launch smoke take their places. |
| macos-app-template | `docs/adding-ios.md` | No mobile targets. |
| macos-app-template | bash as the scripts' language and `scripts/tests/lib.sh` | D12: Rust in `cargo xtask`, with real parsers and Rust tests. |
| macos-app-template | `.githooks/` + `core.hooksPath` | D11: lefthook for a polyglot repository; the verify-hooks idea is kept. |
| macos-app-template | `just logs` via `log stream` | Logs go to rotated files (D7); `just logs` tails them. |
| macos-app-template | `.requiresLocalMachine` trait | Rust's `#[ignore = "…"]` plays the same role. |
| typescript-template | npm publishing gates (pack, attw, OIDC trusted publishing, package smoke), TypeDoc, the universal-library profile, documented-snippet compilation | This template builds tools, not packages; nothing is published. |
| typescript-template | `vitest related` and a whole-program typecheck in pre-commit; Prettier `--write` with re-stage | The #140 decision: the hook is check-only and fast; formatting is `just fmt` and the agent hook. |
| typescript-template | shipping no `.claude/settings.json` | The design keeps macos-app-template's committed settings (D20): this repository's owner runs agents unattended in it, and the deny list is reviewed in PRs like any file. 2026-10-01: reversed; the committed settings were removed after all (D20). |
| both | Windows runners | Windows is a non-goal (§1); macOS and Linux are the targets. |
| this template (pivot, 2026-10-01) | D4: `ts-rs` bindings, `ui/src/ipc/`, the command/event drift check | No IPC: one process, subcommands and the TUI call core directly. |
| this template (pivot, 2026-10-01) | D5: the `myapp-cli` sidecar and `bundle.externalBin` | One binary with subcommands (new D5). |
| this template (pivot, 2026-10-01) | D8: React, Vite, TypeScript, ESLint, Prettier, Vitest, the CSP and capabilities | No GUI; ratatui (new D8). |
| this template (pivot, 2026-10-01) | D12: TypeScript scripts under `scripts/`, Node, pnpm | `cargo xtask` (new D12). |
| this template (pivot, 2026-10-01) | D18: the `.dmg` release, signing, notarization, `Entitlements.plist`, `release.yml` | No distribution; `cargo install --path` (new D18). |
| this template (pivot, 2026-10-01) | D23: the CSS design system, its checks, and the design-lock step | No WebView to style; a TUI theme module (D8). |

## 5. Steps only a human can take

Done in the design session, before the implementation run:

- create the public repository and push the design documents;
- enable secret scanning, push protection, private vulnerability reporting, Dependabot
  alerts and security updates;
- repository merge settings (squash only, delete branch on merge).

Left to a human after the implementation run: the `#[ignore]`d `just test-local` run;
running `myapp tui` in a real terminal when a change only it shows needs eyes on it;
re-applying the rulesets with `just ruleset` when the required CI jobs change; filling
the Product section in an app cut from the template.

## 6. Known risks

- ratatui and crossterm are pre-1.0: a minor bump can change the API; the
  `merging-dependency-prs` skill treats such a bump as a migration, and the
  `TestBackend` tests make a rendering change visible.
- The real terminal loop is untested by any gate (D15, D22); keeping it thin is the
  mitigation, and the terminal-restore path is the part most worth a human's run.
- macOS runner queues are slower than Ubuntu's; CI keeps macOS to one job per PR.
- CodeQL's Rust support maturity was not confirmed; if the `rust` language fails on the
  runner, the run records it and keeps `actions`.
- The 2026-09-28 risks about Tauri 3, `tauri::test`, and `ts-rs` output went with the GUI.
