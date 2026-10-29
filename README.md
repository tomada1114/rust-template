# MyApp

[![CI](https://github.com/tomada1114/rust-template/actions/workflows/ci.yml/badge.svg)](https://github.com/tomada1114/rust-template/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/tomada1114/rust-template/badge)](https://scorecard.dev/viewer/?uri=github.com/tomada1114/rust-template)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A template for personal Rust command-line tools: one binary, `myapp`, whose clap
subcommands do the work and whose `tui` subcommand opens a full-screen ratatui view over
the same core, built and run on macOS and Linux. It ships as a working counter —
persisted state, an injected clock, subcommands and a terminal view over one core — with
coverage floors, architecture boundaries that fail a build, and supply-chain-hardened
CI, all from the first commit.

It runs on macOS (Apple Silicon) and Linux. Windows, a release
pipeline or release artifacts, crates.io publishing, and localization are
non-goals.

<!-- template-only -->
**Starting your own app from this template?** Jump to
[Using This Template](#using-this-template).
<!-- /template-only -->

## Quickstart

Prerequisites: macOS on Apple Silicon with the Xcode Command Line Tools
(`xcode-select --install`), or Linux with a C toolchain for the linker (`build-essential`
on Debian and Ubuntu); [rustup](https://rustup.rs/), [mise](https://mise.jdx.dev/), and
[Just](https://just.systems/) (`brew install mise just` on a Mac).

```bash
git clone https://github.com/tomada1114/rust-template.git
cd rust-template
mise trust     # approve mise.toml once (mise asks before using an untrusted config)
just install   # pinned tools via mise and lefthook's git hook
just check     # everything the machine can run without a human; takes over no terminal
cargo run --locked -p myapp -- counter show   # the tool itself
```

rustup installs the Rust toolchain `rust-toolchain.toml` names the first time `cargo`
runs (`RUSTUP_AUTO_INSTALL`, on by default:
<https://rust-lang.github.io/rustup/environment-variables.html>, checked 2026-09-30).
`just install` needs no `sudo` and opens no installer; a missing Command Line Tools
install is reported with the command to run. `cargo run --locked -p myapp -- tui` opens
the full-screen view in the terminal you run it from; `q` quits.

For apps that need a model, enable the optional `openrouter` Cargo feature. See
[OpenRouter](docs/openrouter.md) for the key setup, `myapp llm ask`, and reuse from a
CLI or TUI action. The default build needs no API key.

## How it is built

- `crates/myapp-core` — the rules, the state, and the ports (traits) everything outside
  the process is reached through; no OS API, no terminal, no direct I/O, and a coverage
  floor.
- `crates/myapp-platform` — the adapters that implement core's ports on macOS and Linux.
- `crates/myapp-test-support` — one fake and one contract function per port, for tests
  only.
- `crates/myapp` — the `myapp` binary: its subcommands, the `tui` screen, and the wiring.
- `xtask/` — repository automation in Rust, run as `cargo xtask <task>`.

The layer rules and what is contract are in [AGENTS.md](AGENTS.md)'s Architecture
section. How each part is built, and why, is written in the skill that owns it under
`.agents/skills/` (AGENTS.md's Skills table lists them); there is no separate
architecture document or roadmap.

<!-- template-only -->
## Using This Template

1. Click **Use this template** on GitHub and clone your new repository.
2. In the clone, run `mise trust` (mise asks before it uses an untrusted `mise.toml`),
   `just install`, then `just bootstrap`. It asks for the display name (`MyApp`), the
   slug used for crate and binary names (`myapp`), the bundle identifier
   (`com.example.myapp`), the GitHub `owner/repo`, the author, and the copyright
   holder, and rewrites exactly those placeholder sites. It then removes this section,
   resets `CHANGELOG.md` and the version to 0.1.0, deletes itself, and prints the steps
   below.
   To also copy your template checkout's `.env.local` automatically, use
   `just bootstrap --env-from /path/to/template-checkout`. It copies the whole file
   without displaying its contents, creates it with owner-only read/write permissions,
   and preserves an existing destination. Relative paths are resolved from the new
   checkout; a missing or unreadable source fails before the rename. Git ignores this
   local file. Omit the option for apps that need no credentials.
3. Review the rewrite (`git status`, `git diff`), and commit it as one commit before
   you edit anything, so the rename stays one reviewable diff.
4. Fill in `AGENTS.md`'s `## Product` section: what the app is and who it is for, the
   core interaction, the non-goals it must not grow, and why it is shaped that way. Delete every `TODO:` marker as
   you go; `just check` fails while one is left.
5. Verify the result with `just check`, commit the Product section, and push both
   commits to `main`. The ruleset is not on yet (step 9), so `main` still takes a
   direct push, and CI's first run checks the result.
6. Create the label set on the new repository: `just labels` (the issue forms rely on
   the labels in `.github/labels.yml`). `.github/dependabot.yml` names its labels
   explicitly, and Dependabot skips one the repository lacks
   (<https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference>,
   `labels`, checked 2026-09-30), so add `dependencies` by hand to any Dependabot pull
   request opened before this step.
7. Turn on the repository's security settings: secret scanning and push protection,
   private vulnerability reporting (`SECURITY.md` points at it), and Dependabot alerts
   and security updates. Install the Renovate GitHub App on the repository
   (<https://github.com/apps/renovate>, checked 2026-09-30): `.github/renovate.json` is
   only its configuration, so without it nothing bumps `mise.toml` or
   `rust-toolchain.toml`.
8. Replace the sample counter with your app, following the `starting-an-app` skill; it
   lists what to delete and the first decisions to record.
9. Repository admin only, once the bootstrap commit is on `main`: run `just ruleset`.
   It applies every ruleset under `.github/rulesets/` — `main.json`, which protects
   `main`, and `release-tags.json`, which lets only an admin create, move, or delete a
   `v*` tag. From then on every change needs a pull request with the required checks
   green.

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
2. In `.github/rulesets/main.json`, remove the `Dependency Review` entry from the
   required status checks. Rulesets on a private repository — the `main` branch
   ruleset and the `release-tags` tag ruleset `just ruleset` applies alike — need a
   paid GitHub plan.
3. Run `just lint` and `just check-harness`, commit, and open a pull request: every
   check it waits for is now one a job in the repository reports.
<!-- /template-only -->

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

```bash
just install      # once per clone
just check        # the full local gate; takes over no terminal
just test-fast increment   # one core test or a group of them, while iterating
just logs         # the newest app log's last lines
just install-cli  # install the myapp binary into ~/.cargo/bin (a human's step)
```

`just --list` shows every recipe. The tool's data lives in
`~/Library/Application Support/com.example.myapp/` and its logs in
`~/Library/Logs/com.example.myapp/` on macOS; on Linux, in `$XDG_DATA_HOME/myapp/`
(default `~/.local/share/myapp/`) and `$XDG_STATE_HOME/myapp/logs/` (default
`~/.local/state/myapp/logs/`).

## Documentation

- [Getting Started](docs/getting-started.md)
- [OpenRouter](docs/openrouter.md)
- [AGENTS.md](AGENTS.md) — the architecture, the gates, and the skills an agent loads
- [Contributing](CONTRIBUTING.md), [Security Policy](SECURITY.md),
  [Code of Conduct](CODE_OF_CONDUCT.md), [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
