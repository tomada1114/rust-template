# tauri-template: design

<!-- template-only: scripts/bootstrap removes docs/template/ from a generated app. -->

Status: **agreed with the owner on 2026-09-28.** This document is the spec the first
implementation run builds against. The companion [issue-triage.md](issue-triage.md)
sorts macos-app-template's open issues into what this template adopts, drops, or
defers, and [skills-plan.md](skills-plan.md) is the per-skill brief.

Each decision below lists the options, their trade-offs, and the choice. "Owner" marks a
choice the owner made between presented options; "Designer" marks one the design session
made and the owner accepted without change.

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
| command (Tauri) | A Rust function the web UI can call over IPC with `invoke("name", args)`. |
| event (Tauri) | A message Rust pushes to the UI (`emit`), which the UI subscribes to with `listen`. |
| capability (Tauri) | A JSON file under `src-tauri/capabilities/` granting a window permission to use plugin commands. |
| sidecar | An extra executable bundled inside the `.app` (`bundle.externalBin`). |

## 1. What this template is

A public template for personal macOS desktop apps with a modest UI: a Rust core, a
Tauri v2 shell, and a React + Vite + TypeScript screen, distributed as a `.dmg` from
GitHub Releases or the owner's site. It is general-purpose; the first app cut from it is
a launchd job manager (schedule jobs, see their results), so the frames that app needs —
persisted state, an injected clock, pushing results from Rust to the screen, a bundled
command-line helper that launchd can run — are part of the template, while nothing
launchd-specific is.

Settled before this document (owner decisions):

- Tauri v2, React + Vite + TypeScript.
- No LLM in the app (no AI SDK, nothing that calls a model). The development harness —
  `AGENTS.md`, skills authored under `.agents/skills/` and mirrored to `.claude/skills/` —
  is kept, as in the two reference templates.
- macOS only; `.dmg`; GitHub Releases or the owner's site.
- The Rust core's tests and lint run on Ubuntu runners; macOS runners only build, run the
  launch smoke, and release.
- Public repository `tomada1114/tauri-template`, with CI and supply-chain controls at the
  level of macos-app-template.

Non-goals: Windows, Linux, or mobile builds; the Mac App Store; an auto-updater; an
in-app LLM; a component library or CSS framework; localization (see issue-triage #119).

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

### D4. Types across IPC — Owner: ts-rs + a thin hand-written layer

Options: (a) `tauri-specta` pinned with `=` — generates types and typed command
wrappers, best ergonomics, but v2 has been a release candidate for about three years;
(b) `ts-rs` for types plus hand-written wrappers — stable semver, a little more typing;
(c) hand-written types — drifts silently.

Choice: **(b)**.

- Every DTO that crosses IPC lives in core (so the Linux job, which never builds the
  Tauri crate, regenerates all of them) and derives `ts_rs::TS` with `#[ts(export)]`; the
  export directory is `ui/src/ipc/generated/`, committed; 64-bit integers are exported as
  `number`. Only `ui/src/ipc/` imports the generated files; it re-exports the types the
  rest of the UI needs from `ui/src/ipc/types.ts`.
- `ui/src/ipc/commands.ts` holds one typed wrapper per command
  (`export const increment = () => invoke<CounterView>("increment")`), and
  `ui/src/ipc/events.ts` one typed `listen` per event.
- Drift checks: `just bindings` regenerates; CI regenerates and fails on a diff; a
  harness check compares the command names registered in `tauri::generate_handler![…]`
  with those `commands.ts` invokes, and the event names Rust emits (a `pub const` per
  event) with those `events.ts` listens to.

### D5. The bundled helper executable — Owner: separate crate, bundled as a sidecar

Options: (a) `myapp-cli` built separately and bundled with `bundle.externalBin`;
(b) one executable with a headless subcommand; (c) a dev-only CLI, not bundled.

Choice: **(a)**. launchd can then run a small binary inside the `.app` that shares core and
platform with the GUI without starting it.

- `scripts/build-sidecar.ts` builds `myapp-cli` for the target triple and copies it to
  `src-tauri/binaries/myapp-cli-<triple>` (gitignored). `tauri.conf.json`'s
  `beforeDevCommand` and `beforeBuildCommand` run it, so `just dev`, `just build`, and the
  release all get a fresh helper. It has a Vitest test with `cargo` stubbed.
- The sample helper: `myapp-cli counter show|increment`, reading and writing the same
  store as the app, with `--help` and exit codes; the launch smoke runs the bundled copy
  from inside the built `.app` to prove it was bundled and signed.
- The GUI does not spawn the helper in the sample (so no `tauri-plugin-shell` and no
  shell capability ships); `docs/architecture.md` shows how to add that when an app needs it.

### D6. The sample app — Owner: counter + persistence + clock + event

A counter whose rules live in core (`Counter` with a bounded range and
`increment`/`decrement`/`reset`, returning a typed error at the bound), exercising every
frame the template claims:

| Frame | In the sample |
|---|---|
| Port + adapter + contract | `CounterStore` port; `JsonFileCounterStore` in platform writes `counter.json` under the app data directory atomically (write to a temp file, rename); `InMemoryCounterStore` fake. |
| Injected time | `Clock` port; `SystemClock` in platform; `FixedClock` fake. The view shows "last changed" from core's `CounterView { value, last_changed_at }`. |
| Command | `get_counter`, `increment`, `decrement`, `reset`. |
| Event | After any change, the shell emits `counter-changed` with the new `CounterView`; a second window, or the helper CLI changing the file, is reflected in the UI (the shell watches nothing in the sample; the event is emitted by the command path, and the doc says where a file watcher would go). |
| Logging | Each command logs one `tracing` event; the UI forwards its errors through `log_from_ui`. |
| Helper CLI | D5. |
| Errors | `CounterError::{AtMaximum, AtMinimum, Storage { kind }}` (serialized as `{ "code": … }`); the UI maps codes to strings in `ui/src/copy/`. |
| Accessibility | Glyph-only buttons carry `aria-label`s; tests query by role and name (issue #169). |

Every part of the sample is a deletable illustration (issue #135): `starting-an-app`
lists what to delete when replacing it.

### D7. Logging — Designer

Options: (a) `tauri-plugin-log` — official, forwards webview logs, size-based rotation
only; (b) `tracing` + `tracing-subscriber` + `tracing-appender` — daily rotation, one
logging API across every crate, no plugin permission.

Choice: **(b)**. Core, platform, the CLI, and the shell log through the `tracing` macros;
only the shell and the CLI install a subscriber. Files go to
`~/Library/Logs/<identifier>/` (the path the Tauri docs give for the plugin, so the
convention is the same), rotated daily, keeping the last 14 files; the CLI writes to
the same directory under a different file prefix. The appender writes synchronously
(no `non_blocking` worker): the volume is low, and Tauri exits through `process::exit`,
which would drop a background writer's last lines. In debug builds the subscriber also
writes to stderr. The UI's `ui/src/ipc/log.ts` sends `warn`/`error` to a `log_from_ui`
command. `just logs` prints the newest file's last lines and exits; `just logs-follow`
follows it for a human (it never ends, so an agent never runs it). `println!` is banned in core by clippy and
discouraged elsewhere by `.claude/rules/rust.md`.

### D8. Frontend stack — Designer

React 19, Vite 8 (`@vitejs/plugin-react`), TypeScript **6.0.x** (typescript-eslint does not
support 7), ESLint 10 flat config with `typescript-eslint` `strictTypeChecked` +
`stylisticTypeChecked` and `eslint-plugin-react-hooks`, Prettier, Vitest 5 with jsdom and
Testing Library. tsconfig as typescript-template (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, …). Plain CSS with design tokens as
CSS custom properties, the system font stack, and `prefers-color-scheme` light/dark — no
CSS framework or component library (either is an ADR decision for an app). State: React
state + one hook per Rust-owned model that loads through `ipc/commands.ts` and updates
from `ipc/events.ts`; no state library. pnpm's supply-chain policy in
`pnpm-workspace.yaml` follows typescript-template (`minimumReleaseAge`, strict dependency
builds with an allow-list, `verifyDepsBeforeRun`), with the release-age equal to the
Dependabot cooldown (a harness check).

Tauri security settings: a restrictive CSP (`default-src 'self'`; `connect-src ipc:
http://ipc.localhost`; no remote origins), `withGlobalTauri: false`, one capability file
granting only `core:default`. The isolation pattern is not enabled (the app loads no
third-party frontend code); that is recorded in `docs/architecture.md`.

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

### D12. Repository scripts in TypeScript — Designer

Options: (a) bash, as macos-app-template; (b) TypeScript run directly by Node's type
stripping, as typescript-template's `.mjs`; (c) a Rust `xtask`.

Choice: **(b)**. Node is already required for the UI; the scripts need real YAML, TOML, and
JSON parsers (the `yaml` and `smol-toml` packages); Vitest tests them with fixtures; and a
reader new to Rust can maintain them. Scripts are `scripts/*.ts` executed with `node`
(no build step; erasable syntax only), share `scripts/lib/`, strip `GIT_*` from spawned
git except where the staged guard deliberately inherits `GIT_INDEX_FILE`, and follow the
failure contract: first stderr line `ERR_<STAGE>_<WHAT>: …`, then `Expected:`, `Actual:`,
`Next:`, exit 1, never printing a secret. Every script has a test under
`scripts/**/*.test.ts`. The TypeScript and JavaScript under `scripts/` and under
`.agents/skills/*/scripts/` (every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`,
`.cjs` file, tested or not) is coverage-gated by typescript-template's per-glob floors.
A skill's bundled scripts may keep their language when ported with their tests
(`shipping-issues`' Python helpers and shell scripts); `just test-scripts` runs those
suites (`unittest`, `shellcheck`) too, with no coverage floor.

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

### D15. Testing strategy — Owner (E2E), Designer (rest)

Options for end-to-end on macOS: (a) `tauri-plugin-webdriver` behind an `e2e` feature
driving the real WKWebView; (b) mocks on both sides plus a launch smoke; (c) CrabNebula's
paid driver. Owner chose **(b)**: no pre-1.0 in-app WebDriver server and no paid key.

| Layer | Tool | Runs on |
|---|---|---|
| Core logic | `#[test]` in `myapp-core`, fakes from test-support, contract suites | Linux (coverage floor) |
| Adapters | contract suites against real adapters, temp dirs per test | macOS CI; `#[ignore]` ones via `just test-local` |
| Commands | `tauri::test::mock_builder()` + `get_ipc_response` against fakes: argument decoding, error mapping, event emission | macOS CI (`just test-macos`) |
| UI | Vitest + Testing Library + `mockIPC`/`shouldMockEvents`, queries by role and accessible name | Linux |
| Wiring | launch smoke (D22): build the release `.app`, run its executable in smoke mode, assert it exits 0 and the day's log file gains the startup line (proving the store, clock, and logging were wired); run the bundled helper (`Contents/MacOS/myapp-cli --version`); check `codesign` and entitlements | `just check`, macOS CI, release |

The gap this leaves — a UI-to-Rust wiring mistake that only the running app shows — is
named in `AGENTS.md` › Enforcement layers, with `just run` + `just logs` as the manual
check a PR carries evidence of (the `running-the-app` skill).

Rules for tests (issue #134) live in `.claude/rules/testing.md` and the `tdd` skill: an
oracle independent of the implementation, the contract suite, an injected clock never a
sleep, a temp directory per test, exhaustive matches, where each kind of test goes.

### D16. CI — Designer

Workflows (job names are the ruleset's required contexts):

| Workflow | Job name | Runner | Does |
|---|---|---|---|
| `ci.yml` | `Rust Core` | ubuntu | fmt check; clippy on Linux-buildable crates; nextest + llvm-cov floors on core; doctests; regenerate bindings and fail on diff; `cargo deny check`; `cargo shear` |
| `ci.yml` | `Frontend` | ubuntu | typecheck; ESLint; Prettier check; Vitest with floors |
| `ci.yml` | `Repo Lint & Harness` | ubuntu | typos; actionlint; skills mirror; script tests; harness checks |
| `ci.yml` | `macOS Build & Smoke` | macos-26 | workspace clippy `-D warnings`; `just test-macos`; `just build`; `just smoke` (release build, sidecar, codesign, entitlements) |
| `ci.yml` | `Template Bootstrap Smoke` | macos-26 | template-only: copy the tree, run `scripts/verify-bootstrap.ts`, run the bootstrap non-interactively, then `just check` in the result |
| `ci.yml` | `Workflow Security Lint` | ubuntu | zizmor |
| `dependency-review.yml` | `Dependency Review` | ubuntu | license allow-list, severity gate |
| `check-pr-title.yml` | `Validate PR title` | ubuntu | Conventional Commits |
| `pr-label.yml` | — | ubuntu | `scripts/label-pr.ts` from the base SHA (issue #126) |
| `codeql.yml` | — | ubuntu | languages `rust`, `javascript-typescript`, `actions`; push, weekly |
| `osv-scan.yml` | — | ubuntu | Cargo.lock + pnpm-lock.yaml; PR + weekly |
| `scorecard.yml` | — | ubuntu | weekly |
| `security-audit.yml` | — | ubuntu | weekly gitleaks over full history, pinned via mise (issue #138) |
| `release.yml` | — | macos-26 | D18 |

Every job: SHA-pinned actions with version comments, `persist-credentials: false`,
job-level least-privilege `permissions`, `timeout-minutes`, `concurrency` keyed on the ref
that cancels only pull-request runs. Tools come from `jdx/mise-action` (v4 line until v5,
released on the design day, has settled); Rust builds are cached with
`Swatinem/rust-cache` except in the release path (zizmor's cache-poisoning finding);
pnpm's store is cached the same way. Every cargo command passes `--locked`; every pnpm
install `--frozen-lockfile`.

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

### D18. Release — Designer

- Trigger: a `v*` tag push (a human act), or `workflow_dispatch` with `dry_run: true`,
  which builds and uploads the `.dmg` as a workflow artifact without creating a release —
  the path the implementation run uses to prove the pipeline.
- Steps: verify the tag equals the version in `Cargo.toml`/`tauri.conf.json`/`package.json`
  (kept equal by `just release-prep` and a harness check); run the core and UI tests;
  `pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg`.
- Signing: `tauri.conf.json` sets `signingIdentity: "-"` (ad-hoc) and
  `hardenedRuntime: true` with `src-tauri/Entitlements.plist`. When the `APPLE_CERTIFICATE`
  secret exists, the job imports it into a temporary keychain and passes
  `APPLE_SIGNING_IDENTITY`; when the notarization secrets exist too, Tauri notarizes and
  staples. Without secrets, both steps are skipped by an `if:` on a step-level env check,
  never by `continue-on-error`.
- Verification before upload (issue #97): `codesign --verify --deep --strict`, `codesign -d
  --entitlements -` compared with `Entitlements.plist`, the sidecar signed, the launch
  smoke on the built app, and `spctl --assess` when Developer ID signed.
- Publish: `SHA256SUMS`, `actions/attest-build-provenance`, `gh release create` with the
  `.dmg`; release notes from `.github/release.yml` categories.
- Architecture: Apple Silicon only (`aarch64-apple-darwin`); `minimumSystemVersion` 14.0.
  A universal build is an ADR decision for an app that needs Intel.
- App Sandbox: off, as Tauri's default. A launchd manager must write
  `~/Library/LaunchAgents` and run `launchctl`, which the sandbox forbids; turning it on
  is an ADR decision. `docs/distribution.md` explains Gatekeeper for an ad-hoc build
  (Privacy & Security › Open Anyway, or `xattr -dr com.apple.quarantine`), and that a
  locally built app (`just run`) is never quarantined.

### D19. Bootstrap — Designer

`scripts/bootstrap.ts` (typescript-template's shape, macos-app-template's scope): prompts
or flags for display name (`MyApp`), slug (`myapp`, used for crate names and binaries),
bundle identifier (`com.example.myapp`), GitHub `owner/repo`, author, and copyright
holder. It rewrites an explicit list of placeholder sites (never a global replace),
renames the crate directories, updates `Cargo.lock` offline, removes `<!-- template-only -->`
blocks and `docs/template/`, resets `CHANGELOG.md` and the version to 0.1.0, deletes
itself, then prints next steps — fill `AGENTS.md` › Product, fill
`docs/architecture/roadmap.md` with `steering-the-roadmap` (issue #172), `just install`,
`just labels`, `just ruleset`, the GitHub security settings. `scripts/verify-bootstrap.ts`
bootstraps a temp copy and fails on any leftover placeholder or template-only marker, a
dangling skill reference, or a mismatch between names; CI's `Template Bootstrap Smoke`
(a macOS job with `timeout-minutes: 60`) runs it, then bootstraps a fresh `git clone`
with a hyphenated multi-word slug (so the hyphen, underscore, and upper-case forms are
all exercised), asserts `just check-harness` fails with the Product-section code — the
check must fire on an unfilled app — then writes a stub Product section in that copy and
runs `just check` there. The bootstrap removes this job and its ruleset context from the
generated app, as macos-app-template's does.

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

### D22. Never taking over the developer's Mac — Owner

The owner develops on the same Mac the checks run on, often while an unattended agent
iterates. Owner's words (2026-09-28): a visible app is acceptable when a verification
genuinely needs it, but running the tests must never interrupt their work — unit tests,
mocks, and headless runs come first. So nothing a routine check runs — `just check` and every recipe in it, the
pre-commit hook, the agent's PostToolUse hook, and any step an agent runs to verify its
own work — may show a window, take keyboard focus, move the pointer, add a Dock icon, or
raise a permission, Keychain, or Gatekeeper prompt.

- **Smoke mode.** When the app starts with `MYAPP_SMOKE=1` (renamed by the bootstrap), the
  shell sets the activation policy to `Prohibited` before any window exists, creates the
  main window hidden, completes the normal startup path (store, clock, logging, command
  registration), writes a `startup complete` log line, and exits 0; any startup error
  exits non-zero. `just smoke` runs the built executable directly (not `open`, which
  activates the app). The flag changes visibility and lifetime only, never behaviour, and
  a Rust test asserts that. The implementation run confirms on this Mac that a smoke run
  leaves the frontmost application unchanged; if `Prohibited` cannot keep focus, it falls
  back to `Accessory` plus a hidden window and records the deviation.
- **Human-only tests.** A test that needs a GUI session, a TCC grant, or the Keychain is
  `#[ignore]`d and runs only in `just test-local`, which a human starts on purpose. The
  sample has none.
- **Visible on request only.** `just dev`, `just run`, and `just install-app` open the
  app; they are never part of `just check`, and the `running-the-app` skill tells an agent
  to prefer smoke mode and `just logs` for evidence, opening the app only when the human
  asks. `just test-local`, `just reset-permissions`, and `just logs-follow` are likewise
  human-started only.
- **No disk image locally.** Building a `.dmg` drives Finder through AppleScript unless
  the build runs under CI, so every local recipe builds with `--bundles app`; only the
  release workflow on a CI runner builds the `.dmg`.
- **No tool installs prompts.** `just install` needs no `sudo` and opens no installer;
  a missing Xcode Command Line Tools is reported with the command to run, not triggered.

### D23. The base design system, and choosing an app's own — Owner

The template ships a working, deliberately neutral design system, and an app cut from it
decides its own design system first, before its first screen.

- **The base: macOS-native and neutral.** Grounded in Apple's Human Interface Guidelines
  so an app that never runs design research still looks like a Mac app: the system font
  stack and a type scale mirroring macOS text styles, semantic color tokens with light and
  dark values (`prefers-color-scheme`), the user's accent color through `accent-color`
  and an accent token, a spacing and radius scale, motion durations that collapse under
  `prefers-reduced-motion`. It lives in `ui/src/design/`: `tokens.css` (primitive values,
  then the semantic tokens components use), `base.css`, and a handful of primitives the
  sample uses (`Button`, `IconButton`, `Stack`, `Panel`, `Text`). `docs/design/design-system.md`
  lists every token with its role and each primitive's recipe.
- **Enforced, not only documented.** A harness check fails on a raw color literal
  (hex, `rgb()`, `hsl()`, named colors), a `font-family`, or a pixel font size anywhere in
  `ui/src/` outside `tokens.css`; components reach values only through `var(--…)`. A
  Vitest test parses `tokens.css` and asserts every semantic token has a dark value and
  every text/background pair the design system declares meets WCAG contrast (4.5:1 for
  body text, 3:1 for large text and UI components) in both appearances.
- **An app chooses its own first.** `starting-an-app`'s first design step, before any
  screen work: decide the app's design system with the `refero-design` skill when the
  session has it (research-first: Refero styles, then screens, a reference lock, and a
  decision ledger), otherwise with `designing-ui`'s own research steps. The outcome is
  recorded as the app's design-lock ADR (`docs/architecture/adr/NNNN-design-lock.md`:
  direction, references, decision ledger) and applied by replacing `tokens.css` values
  and, where the direction needs it, the primitives — never by styling a screen directly.
  The contrast test and the literal check hold for the app's tokens exactly as for the
  base. `refero-design` is named as optional because it is a user-level skill, not part
  of this repository; the template never depends on it to build or pass its checks.
- **Ownership.** `designing-ui` owns the design-lock mechanics and the craft rules;
  `building-react-screens` owns using the primitives and tokens on a screen.

## 4. What was not carried over, and why

| From | Mechanism | Why not |
|---|---|---|
| macos-app-template | XcodeGen, `project.yml`, `.xcode-version`, the `select-xcode` action, SwiftLint, SwiftFormat, Swift Testing, `LaunchUITests` | Swift/Xcode-specific; Cargo, clippy, rustfmt, and the launch smoke take their places. |
| macos-app-template | `docs/adding-ios.md` | macOS only. |
| macos-app-template | bash as the scripts' language and `scripts/tests/lib.sh` | D12: TypeScript with real parsers and Vitest. |
| macos-app-template | `.githooks/` + `core.hooksPath` | D11: lefthook for a polyglot repository; the verify-hooks idea is kept. |
| macos-app-template | `just logs` via `log stream` | Logs go to rotated files (D7); `just logs` tails them. |
| macos-app-template | `.requiresLocalMachine` trait | Rust's `#[ignore = "…"]` plays the same role. |
| typescript-template | npm publishing gates (pack, attw, OIDC trusted publishing, package smoke), TypeDoc, the universal-library profile, documented-snippet compilation | This template ships an app, not a package. |
| typescript-template | `vitest related` and a whole-program typecheck in pre-commit; Prettier `--write` with re-stage | The #140 decision: the hook is check-only and fast; formatting is `just fmt` and the agent hook. |
| typescript-template | shipping no `.claude/settings.json` | The design keeps macos-app-template's committed settings (D20): this repository's owner runs agents unattended in it, and the deny list is reviewed in PRs like any file. 2026-10-01: reversed; the committed settings were removed after all (D20). |
| both | Windows/Linux runners for the app | Distribution is macOS only; Linux runs only what does not need macOS. |

## 5. Steps only a human can take

Done in the design session, before the implementation run:

- create the public repository and push the design documents;
- enable secret scanning, push protection, private vulnerability reporting, Dependabot
  alerts and security updates;
- repository merge settings (squash only, delete branch on merge).

Left to a human after the implementation run: pushing a `v*` release tag; adding Apple
signing and notarization secrets; the `#[ignore]`d `just test-local` run; filling the
Product section in an app cut from the template.

## 6. Known risks

- Tauri 3 is in alpha: a Dependabot major bump will arrive; the `merging-dependency-prs`
  skill treats it as a migration, not a bump.
- `tauri::test` is marked unstable; command tests may need edits on a Tauri minor.
- ts-rs output formatting can change across versions, producing a bindings diff on a bump;
  the drift check makes it visible.
- macOS runner queues are slower than Ubuntu's; CI keeps macOS to one job per PR plus the
  bootstrap smoke.
- CodeQL's Rust support maturity was not confirmed; if the `rust` language fails on the
  runner, the run records it and keeps `javascript-typescript` and `actions`.
