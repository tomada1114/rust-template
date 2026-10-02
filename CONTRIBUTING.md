# Contributing

Thank you for considering a contribution. This page explains how to set up the
repository, which commands to run, and how a change gets merged.

## Prerequisites

- A Mac with Apple Silicon, or Linux. Everything builds and tests on both; CI runs the
  platform tests on each.
- On a Mac, the Xcode Command Line Tools (`xcode-select --install`); the full Xcode app
  is not needed. On Linux, a C toolchain for the linker (`build-essential` on Debian and
  Ubuntu).
- [rustup](https://rustup.rs/). It installs the toolchain `rust-toolchain.toml` pins
  (with clippy, rustfmt, and `llvm-tools`) the first time `cargo` runs.
- [mise](https://mise.jdx.dev/), which installs every other pinned tool from `mise.toml`:
  Just, lefthook, cargo-llvm-cov, cargo-nextest, cargo-deny, cargo-shear, typos,
  actionlint, zizmor, gitleaks, and shellcheck.
- [Just](https://just.systems/man/en/) to start the first `just install` (mise then
  pins it).
- `python3` 3.9 or later on `PATH` for the skills' bundled Python tests in
  `just test-scripts` (the Command Line Tools' `/usr/bin/python3` will do). It is not
  pinned in `mise.toml`. Below 3.11, `merging-dependency-prs`' survey skips reading
  `Cargo.lock` (no `tomllib`) and says so.

Then:

```bash
mise trust     # approve mise.toml (asked once per clone)
just install   # mise install, lefthook install, verify-hooks
```

## Development workflow

```bash
just fmt            # format every Rust file
just fix            # rustfmt's automatic fixes (clippy's findings are fixed by hand)
just lint           # rustfmt check, workspace clippy -D warnings
just test           # test-core and test-xtask, with their coverage floors
just test-core      # core: nextest under llvm-cov (lines 80, functions 80), doctests,
                    #   and the other Linux-buildable crates' tests
just test-xtask     # xtask's tests under llvm-cov (lines 85, functions 90; the staged
                    #   guard's rules in xtask/guard/ lines 90, functions 100)
just test-fast increment   # one core test or a group of them, no coverage
just test-platform  # platform adapters and the CLI against the real OS (macOS or Linux)
just test-scripts   # the skills' bundled Python tests and shellcheck (no floor)
just check-harness  # the harness's checks about itself (cargo xtask check-harness)
just deny           # cargo deny: advisories, licences, bans, sources
just logs           # print the end of the newest app log and exit
just check          # the local gate, in CI's order; its steps are listed below
```

`just check` runs verify-hooks → fmt → lint → lint-repo → agents-check → test-scripts → check-harness → test →
test-platform. It opens no window, takes no focus, raises no prompt, and takes over no
terminal.

These recipes are for a human and are never part of `just check`; an agent runs them
only when you ask:

```bash
just test-local         # the #[ignore]d tests that need a logged-in Mac, a TCC grant, or the Keychain
just logs-follow        # follow the newest log (never ends)
just install-cli        # install the myapp binary into ~/.cargo/bin
```

`myapp tui` (or `cargo run --locked -p myapp -- tui`) is yours to run too: it takes over
the terminal, so no check and no agent starts it. When you change its terminal loop,
say in the pull request what you saw.

Run `just test-local` whenever you change an adapter in `crates/myapp-platform` that
has an `#[ignore]`d test, and paste its output into the pull request: CI cannot run it.

### Without Just

Each recipe is a thin call; the justfile is the reference. The main ones:

```bash
mise install && lefthook install
cargo xtask verify-hooks                         # just verify-hooks
cargo fmt --all --check                          # part of just lint
cargo xtask clippy-guard cargo clippy --workspace --all-targets --locked -- -D warnings
cargo llvm-cov nextest --locked -p myapp-core --fail-under-lines 80 --fail-under-functions 80
cargo test --doc --locked -p myapp-core
cargo nextest run --locked -p myapp-test-support -p myapp-platform -p myapp
cargo llvm-cov nextest --locked --no-report -p xtask -p xtask-guard  # just test-xtask (its floors: the recipe's report lines)
python3 -m unittest discover -s .agents/skills/<skill>/scripts/tests -t .agents/skills/<skill>/scripts/tests  # just test-scripts, per skill (plus shellcheck)
cargo nextest run --locked -p myapp-platform -p myapp   # just test-platform
cargo deny --locked check                        # just deny
```

## Where a change goes

| You are adding… | It goes in… |
|---|---|
| A rule, a state change, a decision | `crates/myapp-core`, with tests |
| Access to the OS or the filesystem | an adapter in `crates/myapp-platform` behind a port core declares, plus a fake and a contract function in `crates/myapp-test-support` |
| A subcommand or a flag | `crates/myapp/src/main.rs`, its wording in `crates/myapp/src/wording.rs`, and a test of the built binary in `crates/myapp/tests/cli.rs` |
| Something on the full-screen view | the screen's state and keys in core; drawing in `crates/myapp/src/tui/view.rs`, tested against ratatui's `TestBackend` |
| Repository automation | a task in `xtask/src/` (run as `cargo xtask <task>`), with its tests beside it |

[docs/architecture.md](docs/architecture.md) explains the layers and what is contract.
A new crate needs a reason and a maintainer's sign-off.

## Pull request process

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests.
3. Make sure `just check` passes.
4. Open a pull request using the template, with a Conventional Commits title.

Required checks: `Rust Core`, `Repo Lint & Harness`, `macOS`,
`Template Bootstrap Smoke`, `Workflow Security Lint`, `Dependency Review`, and
`Validate PR title`.

### Code standards

- New logic lives in `myapp-core` with tests of the happy and the error path; keep the
  core's 80% line and 80% function coverage floors.
- clippy `-D warnings` and rustfmt pass with no suppression. Silencing a check
  (`#[allow]`, `#[expect]`), lowering a
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
