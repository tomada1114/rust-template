# Contributing

Thank you for considering a contribution. This page explains how to set up the
repository, which commands to run, and how a change gets merged.

## Prerequisites

- A Mac with Apple Silicon on macOS 14 or later. The core also builds and tests on
  Linux, but the app, its tests that need macOS, and the launch smoke do not.
- The Xcode Command Line Tools (`xcode-select --install`). The full Xcode app is not
  needed.
- [rustup](https://rustup.rs/). It installs the toolchain `rust-toolchain.toml` pins
  (with clippy, rustfmt, and `llvm-tools`) the first time `cargo` runs.
- [mise](https://mise.jdx.dev/), which installs every other pinned tool from `mise.toml`:
  Node, Just, lefthook, cargo-llvm-cov, cargo-nextest, cargo-deny, cargo-shear, typos,
  actionlint, zizmor, gitleaks, and shellcheck.
- [Just](https://just.systems/man/en/) to start the first `just install` (mise then
  pins it). pnpm comes through corepack, at the version `package.json`'s
  `packageManager` names.

Then:

```bash
mise trust     # approve mise.toml (asked once per clone)
just install   # mise install, pnpm install --frozen-lockfile, lefthook install, verify-hooks
```

## Development workflow

```bash
just fmt            # format every Rust and TypeScript file
just fix            # formatters plus ESLint's automatic fixes
just lint           # rustfmt check, workspace clippy -D warnings, tsc, ESLint, Prettier check
just test           # test-core + test-ui, each with its coverage floors
just test-core      # core: nextest under llvm-cov (lines 80, functions 80), doctests,
                    #   and the other Linux-buildable crates' tests
just test-ui        # Vitest over ui/src with its floors (lines 80, functions 80)
just test-fast increment   # one core test or a group of them, no coverage
just test-macos     # platform adapters and the Tauri commands (tauri::test), macOS only
just test-scripts   # Vitest over scripts/ and skills' scripts with their floors, plus
                    #   the bundled Python tests and shellcheck
just check-harness  # the harness's checks about itself (scripts/checks/)
just bindings       # regenerate ui/src/ipc/generated/ from core's types; commit the result
just deny           # cargo deny: advisories, licences, bans, sources
just build          # the debug .app (no disk image)
just smoke          # the launch smoke: release .app, signature, entitlements, helper, smoke run
just logs           # print the end of the newest app log and exit
just check          # the local gate, in CI's order; its steps are listed below
just release-prep 0.2.0   # bump the three version sites and roll CHANGELOG.md (docs/distribution.md)
```

`just check` runs verify-hooks → fmt → lint → lint-repo → agents-check → test-scripts → check-harness → test →
test-macos → build → smoke. It opens no window, takes no focus, and raises no prompt.

These recipes are for a human and are never part of `just check`; an agent runs them
only when you ask:

```bash
just dev                # the app with hot reload (opens a window)
just run                # build, quit any running copy, and open the debug app
just install-app        # build the release app and copy it to ~/Applications
just test-local         # the #[ignore]d tests that need a logged-in Mac, a TCC grant, or the Keychain
just logs-follow        # follow the newest log (never ends)
just reset-permissions  # make macOS forget this app's privacy (TCC) grants
```

Run `just test-local` whenever you change an adapter in `crates/myapp-platform` that
has an `#[ignore]`d test, and paste its output into the pull request: CI cannot run it.

### Without Just

Each recipe is a thin call; the justfile is the reference. The main ones:

```bash
mise install && corepack enable pnpm && pnpm install --frozen-lockfile && lefthook install
node scripts/verify-hooks.ts                     # just verify-hooks
node scripts/build-sidecar.ts                    # just sidecar (the Tauri crate needs the helper first)
cargo fmt --all --check                          # part of just lint
node scripts/clippy-guard.ts cargo clippy --workspace --all-targets --locked -- -D warnings
pnpm typecheck && pnpm lint && pnpm format:check
cargo llvm-cov nextest --locked -p myapp-core --fail-under-lines 80 --fail-under-functions 80
cargo test --doc --locked -p myapp-core
cargo nextest run --locked -p myapp-test-support -p myapp-platform -p myapp-cli
pnpm test:ui                                     # just test-ui
pnpm test:scripts                                # just test-scripts (plus Python tests, shellcheck)
cargo nextest run --locked -p myapp-platform -p myapp   # just test-macos
pnpm tauri build --debug --bundles app -- --locked  # just build (unset every APPLE_* variable first)
node scripts/smoke.ts                            # just smoke
node scripts/bindings.ts                         # just bindings
cargo deny --locked check                        # just deny
node scripts/release-prep.ts 0.2.0               # just release-prep 0.2.0
```

## Where a change goes

| You are adding… | It goes in… |
|---|---|
| A rule, a state change, a decision | `crates/myapp-core`, with tests; a new DTO derives `ts_rs::TS` |
| Access to the OS or the filesystem | an adapter in `crates/myapp-platform` behind a port core declares, plus a fake and a contract function in `crates/myapp-test-support` |
| A command or an event | `src-tauri/src/commands.rs` and `lib.rs`'s handler list, and the matching wrapper in `ui/src/ipc/commands.ts` or `events.ts` |
| A screen or a component | `ui/src/`, using the primitives and tokens in `ui/src/design/`; user-facing wording in `ui/src/copy/` |
| Repository automation | `scripts/*.ts`, with a test beside it |

[docs/architecture.md](docs/architecture.md) explains the layers and what is contract.
A new crate or npm package needs a reason and a maintainer's sign-off.

## Pull request process

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests.
3. Make sure `just check` passes.
4. Open a pull request using the template, with a Conventional Commits title.

Required checks: `Rust Core`, `Frontend`, `Repo Lint & Harness`, `macOS Build & Smoke`,
`Template Bootstrap Smoke`, `Workflow Security Lint`, `Dependency Review`, and
`Validate PR title`.

### Code standards

- New logic lives in `myapp-core` with tests of the happy and the error path; keep the
  core's 80% line and 80% function coverage floors.
- clippy `-D warnings`, ESLint `--max-warnings 0`, rustfmt, and Prettier pass with no
  suppression. Silencing a check (`#[allow]`, `#[expect]`, `eslint-disable`), lowering a
  floor, excluding a file from coverage, or `#[ignore]` on a failing test needs a
  maintainer's sign-off.
- No `unwrap` or `expect` outside tests, and no `unsafe`.
- Public Rust items carry a `///` doc comment that says why.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) for commits and pull
request titles:

```text
<type>(<optional scope>): <short summary>
```

Accepted types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`, and `deps` (dependency bumps). The title's type sets the pull
request's label, which sets its release-notes category.

### Changelog

`CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)) is the
human-curated record of user-visible changes. Add an entry under `[Unreleased]` in the
pull request that makes the change. The release notes GitHub generates from
`.github/release.yml` are a supplement, not a replacement.

## Getting help

If something is unclear, open an issue. For a security problem, follow
[SECURITY.md](SECURITY.md) instead.
