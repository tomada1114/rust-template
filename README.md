# MyApp

[![CI](https://github.com/tomada1114/tauri-template/actions/workflows/ci.yml/badge.svg)](https://github.com/tomada1114/tauri-template/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/tomada1114/tauri-template/badge)](https://scorecard.dev/viewer/?uri=github.com/tomada1114/tauri-template)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A template for personal macOS desktop apps with a modest UI: a Rust core, a Tauri v2
shell, and a React + Vite + TypeScript screen, distributed as a `.dmg` from GitHub
Releases. It ships as a working counter app — persisted state, an injected clock, an
event pushed from Rust to the screen, and a bundled command-line helper — with coverage
floors, architecture boundaries that fail a build, a windowless launch smoke, and
supply-chain-hardened CI, all from the first commit.

It is macOS only (Apple Silicon, macOS 14 or later). Windows, Linux, mobile, the Mac App
Store, an auto-updater, localization, and an in-app LLM are non-goals.

<!-- template-only -->
**Starting your own app from this template?** Jump to
[Using This Template](#using-this-template).
<!-- /template-only -->

## Quickstart

Prerequisites: a Mac with Apple Silicon on macOS 14 or later, the Xcode Command Line
Tools (`xcode-select --install`), [rustup](https://rustup.rs/),
[mise](https://mise.jdx.dev/), and [Just](https://just.systems/) (`brew install mise just`).

```bash
git clone https://github.com/tomada1114/tauri-template.git
cd tauri-template
mise trust     # approve mise.toml once (mise asks before using an untrusted config)
just install   # pinned tools via mise, pnpm dependencies, lefthook's git hook
just check     # everything a Mac can run without a human; opens no window
just dev       # opens the app with hot reload (a window: run it when you want to see it)
```

rustup installs the Rust toolchain `rust-toolchain.toml` names the first time `cargo`
runs (<https://rust-lang.github.io/rustup/overrides.html>, checked 2026-09-28).
`just install` needs no `sudo` and opens no installer; a missing Command Line Tools
install is reported with the command to run.

## Design Philosophy

Every choice in this template has a reason. If you disagree with one, you know what to
change and why it was there in the first place.

### Why a Cargo workspace with the logic split into crates?

A single `src-tauri` crate, the layout `create-tauri-app` generates
(<https://v2.tauri.app/start/project-structure/>, checked 2026-09-28), cannot keep OS
and Tauri code out of the logic. So the repository root is a virtual workspace:
`crates/myapp-core` holds the rules and state, `crates/myapp-platform` the OS adapters,
`crates/myapp-test-support` the fakes, `crates/myapp-cli` the helper executable, and
`src-tauri` (crate `myapp`) only the shell. The UI lives in `ui/`. No crate is named
`core`, which would collide with Rust's built-in `core` library. A repository per layer
was rejected: it costs a release process per layer for a personal app.

### Why ports and adapters, with synchronous ports?

Core declares each thing it needs from outside the process — storage, time — as a
`Send + Sync` trait. `myapp-platform` implements it for real, `myapp-test-support` as a
fake, and `src-tauri` picks the real one. Ports are plain synchronous methods, so a
reader new to Rust meets no async in core; the shell moves a slow call onto a blocking
thread. Errors are typed codes the UI turns into words, never sentences from Rust. One
contract function per port runs against both the fake and the real adapter, so the fake
cannot drift from the real thing without a test failing.

### Why are the architecture boundaries enforced three times?

A rule that lives only in prose drifts. Core's `Cargo.toml` names no Tauri or OS crate,
so core cannot compile a call into one. A harness check reads `cargo metadata` and fails
if core's dependency closure ever gains `tauri*`, `wry`, `tao`, a macOS binding crate,
or `myapp-platform`, and `cargo deny`'s `wrappers` rule allows `tauri` as a direct
dependency of the shell only. clippy, configured in `crates/myapp-core/clippy.toml`,
bans printing and the standard streams, `std::fs`'s files and functions, `std::net`'s
sockets, `SystemTime::now`, `std::env`'s argument, variable, and directory functions,
`std::process::Command` and `exit`, and `thread::spawn` and `thread::sleep` in core, so
I/O, time, and environment arrive only through ports. On the TypeScript side, ESLint's `no-restricted-imports` keeps `@tauri-apps/*` inside `ui/src/ipc/`.

### Why ts-rs plus a thin hand-written IPC layer?

`tauri-specta` would generate typed command wrappers too, but its v2 has been a release
candidate for years (2.0.0-rc.25 is the newest, <https://crates.io/crates/tauri-specta>,
checked 2026-09-28). `ts-rs` is stable: every type that crosses IPC lives in core,
derives `TS`, and is exported to `ui/src/ipc/generated/`, which is committed. The
wrappers in `ui/src/ipc/commands.ts` and `events.ts` are one line each. CI regenerates
the bindings and fails on a diff, and a harness check compares the command and event
names on both sides, so neither half can drift silently.

### Why is the helper a separate crate, bundled as a sidecar?

A launchd job needs a small executable it can run without starting the GUI. `myapp-cli`
shares core and platform with the app, is built into `src-tauri/binaries/` by
`just sidecar`, and ships inside the `.app` through Tauri's `bundle.externalBin`. The
launch smoke runs the bundled copy, which proves it was bundled and signed. The GUI does
not spawn it, so no shell plugin or shell permission ships.

### Why is the sample app a counter?

Because it is small enough to delete and still exercises every frame the template
claims: a port with a real adapter, a fake, and a contract suite (`CounterStore`,
writing `counter.json` atomically); injected time (`Clock`); four commands; an event
(`counter-changed`); logging, including errors forwarded from the UI; the helper CLI;
typed error codes; and accessible glyph-only buttons. Every part of it is an
illustration to replace.

### Why tracing to daily files instead of tauri-plugin-log?

`tauri-plugin-log` rotates by size only and needs a plugin permission
(<https://v2.tauri.app/plugin/logging/>, checked 2026-09-28). `tracing` gives
one logging API across every crate; only the shell and the CLI install a subscriber,
which writes to `~/Library/Logs/com.example.myapp/`, rotated daily and keeping 14 files.
The writer is synchronous, because Tauri exits through `process::exit`, which would drop
a background writer's last lines. `just logs` prints the newest file's tail and exits.

### Why React and Vite with no CSS framework and no state library?

The screen is modest, so the stack is the plain, well-known one: React 19, Vite 8,
TypeScript 6.0 (typescript-eslint 8 declares `typescript <6.1.0` as its peer range,
<https://www.npmjs.com/package/typescript-eslint>, checked 2026-09-28), strict ESLint,
Prettier, and Vitest with Testing Library. Styling is plain CSS over design tokens;
state is React state plus one hook per Rust-owned model. A component library, a CSS
framework, or a state library is a decision for an app to make and record, not a
default. Tauri's security settings start closed: a restrictive CSP,
`withGlobalTauri: false`, and one capability granting only `core:default`.

### Why is every tool pinned in exactly one place?

A version written twice drifts. Rust is pinned in `rust-toolchain.toml`, Node in
`mise.toml`, pnpm in `package.json`'s `packageManager`, and every other CLI in
`mise.toml`, preferring prebuilt binaries to the `cargo:` backend, which compiles from
source. Nothing is `latest`; bumps arrive as Renovate or Dependabot pull requests after
a 7-day release age.

### Why Just?

One command, `just check`, runs locally what CI runs. Just is a task runner rather than
a build system, and each recipe is a thin call into cargo, pnpm, or `scripts/`, so every
recipe also works without it. `cargo xtask` cannot naturally drive pnpm and mise.

### Why lefthook, and why does the pre-commit hook only check?

The repository is polyglot, and lefthook gives per-language staged-file globs and
parallel jobs from one YAML file. The hook stays check-only and fast — rustfmt,
Prettier, ESLint, and typos on the staged files, plus a guard against secret-shaped
paths and credential-shaped content — with no compile, clippy, or tests: those belong to
`just check` and CI. `just install` fails when the hook is missing.

### Why repository scripts in TypeScript?

Node is already required for the UI; the scripts need real YAML, TOML, and JSON parsers;
and a reader new to Rust can maintain TypeScript. Scripts run directly under Node's type
stripping with no build step, each has a Vitest test with its own coverage floor, and a
failing script prints a stable `ERR_<STAGE>_<WHAT>` code, then `Expected:`, `Actual:`,
and `Next:` lines.

### Why a coverage floor on the core only?

The floor (80% of lines and 80% of functions, measured by `cargo llvm-cov`) sits where
the decisions are. The platform crate, the shell, and the CLI translate and decide
nothing, so a numeric gate there would only invite tests of glue. The UI and the scripts
carry their own per-directory floors, so one tree cannot subsidize another. clippy runs
at `pedantic` with warnings as errors, `unsafe_code` is forbidden in every crate, and
weakening any gate needs a human's sign-off.

### Why does the harness check itself?

Documentation that lists what is enforced goes stale, so the claims are checks instead.
`just check-harness` runs `scripts/checks/`: every `just` recipe a document names exists;
every workflow pins actions by SHA with a version comment, sets timeouts and job-level
permissions, and never uses `pull_request_target`; the dependency cooldowns agree; each
required status check names a real job; the boundary lists agree; the IPC names agree;
every label an issue form or workflow applies is declared; and more — each check's
header says what it asserts.

### Why no end-to-end WebDriver tests?

Tauri's WebDriver support covers Windows and Linux only, because macOS has no WKWebView
driver (<https://v2.tauri.app/develop/tests/webdriver/>, checked 2026-09-28), and the
alternatives are a pre-1.0 in-app WebDriver server or a paid driver. So each layer is
tested where it lives — core with fakes, adapters with contract suites,
commands through `tauri::test`'s mock runtime, the UI with Vitest and mocked IPC — and a
launch smoke builds the release app and proves the real wiring starts. The gap that
leaves, a UI-to-Rust wiring mistake only the running app shows, is named, and a pull
request that could hit it carries `just run` and `just logs` evidence.

### Why does most CI run on Ubuntu?

macOS runners queue longer. Core, the Linux-buildable crates, the UI, the scripts, and
the repository lint all run on Ubuntu; one macOS job runs workspace clippy, the tests
that need macOS, the debug build, and the launch smoke. Every job pins its actions by
SHA, sets `persist-credentials: false`, least-privilege permissions, and a timeout, and
every install is `--locked` or `--frozen-lockfile`.

### Why this much supply-chain control, and why scope advisories to Apple Silicon?

An app that runs on your Mac with your permissions deserves the same scrutiny as a
server: CodeQL, OSV-Scanner, OpenSSF Scorecard, zizmor, Dependency Review with a license
allow-list, `cargo deny`, pnpm's release-age and build-script allow-list, a 7-day
cooldown on every automated bump, a weekly full-history gitleaks scan, and the branch
ruleset as code. `Cargo.lock` lists every platform's dependencies, including Tauri's
Linux GTK stack, which this app never ships; so `cargo deny` evaluates the
`aarch64-apple-darwin` graph — defining what is shipped rather than ignoring anything —
and an OSV exception is allowed only for a crate absent from that graph, with a reason
and an expiry.

### Why ad-hoc signing by default, with Developer ID when secrets exist?

The template works on day one without an Apple Developer Program membership. Tauri signs
the bundle itself, ad hoc (`signingIdentity: "-"`) with the hardened runtime and the
entitlements file; when the repository has the Apple certificate secrets, the release
signs with Developer ID, and with the notarization secrets it notarizes and staples too
— no workflow edit, and skipped steps are skipped by a condition, never by
`continue-on-error`. Every release is verified before upload. See
[docs/distribution.md](docs/distribution.md).

<!-- template-only -->
### Why a bootstrap script?

Renaming an app by hand misses a site. `just bootstrap` rewrites an explicit list of
placeholder sites — never a global replace — renames the crates, updates `Cargo.lock`
offline, strips the template-only material, and resets the version and changelog. CI
proves it on every pull request by bootstrapping a fresh clone with a hyphenated
multi-word name and running `just check` in the result.
<!-- /template-only -->

### Why AGENTS.md, skills, and committed agent settings?

The repository is developed with coding agents, often unattended. `AGENTS.md` gives them
the architecture, the gates, and the hard prohibitions; path-scoped rules under
`.claude/rules/` and skills authored under `.agents/skills/` (mirrored by
`just agents-sync`) carry the procedures. `.claude/settings.json` is committed so its
deny list — no hook bypass, no force push, no `gh` read turned into a write or a
browser window, no edit to the entitlements file — is reviewed in pull requests like
any other file. The app itself calls no LLM.

### Why an ADR tree that ships empty?

The template's own decisions are the ones in this section. An app cut from it decides
different things — its design system, where it keeps state, whether it needs the App
Sandbox, which permissions it asks for — and records each as an Architecture Decision
Record under [docs/architecture/](docs/architecture/README.md), whose index ships empty.
A replaced decision gets a new ADR rather than a rewrite, so the reasoning that held at
the time stays readable. [docs/architecture/roadmap.md](docs/architecture/roadmap.md)
ships as a skeleton for the app's direction.

### Why may nothing a check runs take over your Mac?

The checks run on the Mac you are working on, often while an agent iterates. So nothing
routine — `just check` and every recipe in it, the pre-commit hook, an agent's own
verification — may show a window, take focus, add a Dock icon, or raise a permission,
Keychain, or Gatekeeper prompt. The launch smoke runs the app with `MYAPP_SMOKE=1`: no
window, activation policy `Prohibited`, the normal startup path, a `startup complete`
log line, exit 0. Local builds make the `.app` only, because building a `.dmg` drives
Finder through AppleScript unless `CI=true`
(<https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs>,
checked 2026-09-28); only the release workflow builds one. `just dev`, `just run`, and
`just install-app` open the app, and a human runs them on purpose.

### Why a neutral, macOS-native design system that an app replaces first?

An app that never runs design research should still look like a Mac app, so the base
follows Apple's Human Interface Guidelines: the system font stack, semantic color tokens
with light and dark values, the user's accent color for native controls, and motion
that respects reduced-motion settings. Components reach values only through tokens in
`ui/src/design/tokens.css`, and a test asserts every text and background pair meets WCAG
contrast in both appearances. An app decides its own design system before its first
screen and applies it by replacing token values, never by styling a screen directly.
See [docs/design/design-system.md](docs/design/design-system.md).

<!-- template-only -->
## Using This Template

1. Click **Use this template** on GitHub and clone your new repository.
2. Run `just install`, then `just bootstrap`. It asks for the display name (`MyApp`),
   the slug used for crate and binary names (`myapp`), the bundle identifier
   (`com.example.myapp`), the GitHub `owner/repo`, the author, and the copyright
   holder, and rewrites exactly those placeholder sites. It then removes
   `docs/template/` and this section, resets `CHANGELOG.md` and the version to 0.1.0,
   deletes itself, and prints the steps below.
3. Fill in `AGENTS.md`'s `## Product` section: what the app is and who it is for, the
   core interaction, and the non-goals it must not grow. Delete every `TODO:` marker as
   you go; `just check` fails while one is left.
4. Fill in the [docs/architecture/roadmap.md](docs/architecture/roadmap.md) skeleton —
   the Now, Next, and Later outcomes that follow from the Product section — with the
   `steering-the-roadmap` skill. Nothing checks that page, so its `TODO:` lines stay
   until you replace them.
5. Verify the result: `just install && just check`.
6. Create the label set on the new repository: `just labels` (the issue forms rely on
   the labels in `.github/labels.yml`).
7. Turn on the repository's security settings: secret scanning and push protection,
   private vulnerability reporting (`SECURITY.md` points at it), and Dependabot alerts
   and security updates.
8. Replace the sample counter with your app, following the `starting-an-app` skill; it
   lists what to delete and has you decide the design system first.
9. For Developer ID signed and notarized releases, add the secrets listed in
   [docs/distribution.md](docs/distribution.md). Without them, releases are ad-hoc
   signed.
10. Repository admin only, once the bootstrap commit is on `main`: protect it with
    `just ruleset` (`.github/rulesets/main.json`). From then on every change needs a
    pull request with the required checks green.

### A private repository

The workflows assume a public repository. On a private one, three of them need GitHub
Code Security or GitHub Advanced Security, and a required check that can never report
blocks every pull request. Do this after the bootstrap commit and before `just ruleset`
— by deleting files, not by adding `if:` guards, because a skipped job never reports its
check:

1. Delete `.github/workflows/codeql.yml` (code scanning on a private repository needs a
   GitHub Code Security license:
   <https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning>,
   checked 2026-09-28), `.github/workflows/dependency-review.yml` (the action runs on a
   private repository only with Code Security or Advanced Security:
   <https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review>,
   checked 2026-09-28), and `.github/workflows/scorecard.yml` (its results upload to
   code scanning). Keep any of them if your plan includes those features.
   `osv-scan.yml` needs neither and stays as the dependency-vulnerability check.
2. In `.github/workflows/release.yml`, remove the build-provenance attestation step and
   its `attestations: write` permission unless the repository is on GitHub Enterprise
   Cloud, the plan artifact attestations need on a private repository
   (<https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>,
   checked 2026-09-29). The release itself still works, visible only to people with
   access to the repository.
3. In `.github/rulesets/main.json`, remove the `Dependency Review` entry from the
   required status checks. Branch rulesets on a private repository need a paid GitHub
   plan.
4. Run `just lint` and `just check-harness`, commit, and open a pull request: every
   check it waits for is now one a job in the repository reports.
<!-- /template-only -->

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

```bash
just install      # once per clone
just check        # the full local gate; opens no window
just test-fast increment   # one core test or a group of them, while iterating
just logs         # the newest app log's last lines
```

`just --list` shows every recipe. The app's data lives in
`~/Library/Application Support/com.example.myapp/` and its logs in
`~/Library/Logs/com.example.myapp/`.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Architecture Decisions](docs/architecture/README.md) and the
  [Roadmap](docs/architecture/roadmap.md)
- [Design System](docs/design/design-system.md)
- [Distribution & Signing](docs/distribution.md)
- [Contributing](CONTRIBUTING.md), [Security Policy](SECURITY.md),
  [Code of Conduct](CODE_OF_CONDUCT.md), [Changelog](CHANGELOG.md)
<!-- template-only -->
- The template's own design: [design.md](docs/template/design.md),
  [issue-triage.md](docs/template/issue-triage.md), and
  [implementation-notes.md](docs/template/implementation-notes.md)
<!-- /template-only -->

## License

[MIT](LICENSE)
