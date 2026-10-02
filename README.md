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

## Design Philosophy

Every choice below has a reason. If you disagree with one, you know what to change and
why it was there in the first place.

### Why a Cargo workspace with the logic split into crates?

A single crate cannot keep OS code out of the logic: nothing would stop a rule from
reading a file or the clock, and its tests would link the real adapters. So the
repository root is a virtual workspace: `crates/myapp-core` holds the rules and state,
`crates/myapp-platform` the OS adapters, `crates/myapp-test-support` the fakes, and
`crates/myapp` the `myapp` binary, the only place the adapters are wired to core. No
crate is named `core`, which would collide with Rust's built-in `core` library. A
repository per layer was rejected: it costs a release process per layer for a personal
tool.
### Why ports and adapters, with synchronous ports?

Core declares each thing it needs from outside the process — storage, time — as a
`Send + Sync` trait. `myapp-platform` implements it for real, `myapp-test-support` as a
fake, and the binary picks the real one. Ports are plain synchronous methods, so a
reader new to Rust meets no async in core. Errors are typed variants the binary turns
into words and an exit code, never sentences from core. One contract function per port
runs against both the fake and the real adapter, so the fake cannot drift from the real
thing without a test failing.
### Why are the architecture boundaries enforced three times?

A rule that lives only in prose drifts. Core's `Cargo.toml` names no OS crate, so core
cannot compile a call into one. A harness check reads `cargo metadata` and fails if
core's dependency closure ever gains a macOS binding crate or
`myapp-platform`, and `cargo deny`'s `wrappers` rule allows `myapp-platform` as a direct
dependency of the binary only. clippy, configured in `crates/myapp-core/clippy.toml`,
bans printing and the standard streams, `std::fs`'s files and functions, `Path`'s
file-system queries, `std::net`'s sockets and address lookups, clock reads
(`SystemTime::now`, `Instant::now`, `elapsed`), `std::env`'s argument, variable, and
directory functions, `std::process::Command`, `exit`, and `abort`, and unscoped threads
and `thread::sleep` in core, so I/O, time, and environment arrive only through ports.
### Why is the tool one binary, in its own crate?

One `cargo install --locked --path crates/myapp` (`just install-cli`) yields the whole
tool, and its subcommands are the only entry points, so there is one composition root to
wire adapters in. Keeping the binary out of core and platform leaves those two as
libraries a test links without a `main`. The binary only translates: arguments to calls,
a view to stdout, a typed error to wording on stderr and an exit code, with every
sentence in `crates/myapp/src/wording.rs`.

### Why is the sample app a counter?

Because it is small enough to delete and still exercises every frame the architecture
claims: a port with a real adapter, a fake, and a contract suite (`CounterStore`,
writing `counter.json` atomically under a lock); injected time (`Clock`); subcommands
and a full-screen view over the same service, the screen's state and keys in core;
logging; typed errors with their wording in one module; and a help line naming every
key. Every part of it is an illustration to replace.
### Why tracing to daily files?

`tracing` gives one logging API across every crate; only the binary installs a
subscriber, which writes `myapp.YYYY-MM-DD.log` to `~/Library/Logs/com.example.myapp/`
on macOS and to `$XDG_STATE_HOME/myapp/logs/` on Linux, rotated daily and keeping 14
files. The writer is synchronous: the volume is low, and a background writer can drop
its last lines at exit. While `myapp tui` owns the terminal it logs to the file only, so
no line lands in the frame. `just logs` prints the newest file's tail and exits.
### Why clap and ratatui?

clap's derive API declares a subcommand as a type and gives `--help`, `--version`, and
usage errors (exit 2) for free. ratatui, over its crossterm backend, draws the
full-screen view immediate-mode: one `draw` over a state, so the loop the binary runs
stays a thin shell around core's screen and key table, and the drawing is tested by
rendering into an in-memory backend. Styling starts from the terminal's own colors, so
a tool reads in light and dark terminals alike. Another framework, an async runtime, or
a theme of the tool's own is a decision for an app to make and record, not a default.
### Why is every tool pinned in exactly one place?

A version written twice drifts. Rust is pinned in `rust-toolchain.toml`, every other CLI
in `mise.toml`, preferring prebuilt binaries to the `cargo:` backend, which compiles from
source. Nothing is `latest`; bumps arrive as Renovate or Dependabot pull requests after
a 7-day release age.

### Why Just?

One command, `just check`, runs locally what CI runs. Just is a task runner rather than
a build system, and each recipe is a thin call into cargo (`cargo xtask` included) or a
pinned tool, so every recipe also works without it. `cargo xtask` cannot naturally drive
mise.

### Why lefthook, and why does the pre-commit hook only check?

lefthook gives per-language staged-file globs and parallel jobs from one YAML file. The
hook stays check-only and fast — rustfmt and typos on the staged files, the skills
mirror, plus a guard against secret-shaped paths and credential-shaped content — with no
compile, clippy, or tests: those belong to `just check` and CI. `just install` fails
when the hook is missing. JSON, YAML, and Markdown have no formatter: Prettier's check
over them left with the Node toolchain, to keep the toolchain small.

### Why repository automation in Rust?

`cargo xtask <task>` needs no runtime beyond the Rust toolchain the app already pins.
Its tasks read YAML, TOML, and JSON with real parsers, each is a function of a faked
context with its own coverage floor, and a failing task prints a stable
`ERR_<STAGE>_<WHAT>` code, then `Expected:`, `Actual:`, and `Next:` lines. A skill may
bundle Python or shell scripts of its own, which `just test-scripts` tests.

### Why a coverage floor on the core only?

The floor (80% of lines and 80% of functions, measured by `cargo llvm-cov`) sits where
the decisions are. The platform crate and the binary translate and decide nothing, so a numeric gate there would only invite tests of glue. The `xtask` crate
carries its own floors, so one tree cannot subsidize another. clippy runs
at `pedantic` with warnings as errors, `unsafe_code` is forbidden in every crate, and
weakening any gate needs a human's sign-off.

### Why does the harness check itself?

Documentation that lists what is enforced goes stale, so the claims are checks instead.
`just check-harness` runs `cargo xtask check-harness`, one module per claim under
`xtask/src/check_harness/`: every `just` recipe a document names exists;
every workflow pins actions by SHA with a version comment, sets timeouts and job-level
permissions, and never uses `pull_request_target`; the dependency cooldowns agree; each
required status check names a real job; the boundary lists agree; every label an issue
form or workflow applies is declared; and more — each check's header says what it
asserts.

### Why does no check run the real terminal?

A test that drives a real terminal would take over the one the developer is working in,
and a CI runner has no terminal to give it. So each layer is tested where it lives —
core with fakes, adapters with contract suites, the command line by running the built
binary against a temporary `HOME`, the full-screen view by drawing into ratatui's
`TestBackend` and feeding keys as values. The gap that leaves, the real terminal loop
(raw mode, the alternate screen, restoring the terminal on every way out), is named and
kept thin, and a pull request that changes it carries a human's run of `myapp tui`.
### Why does most CI run on Ubuntu?

macOS runners queue longer. Core, the Linux-buildable crates, the platform tests on
Linux, the scripts, and the repository lint all run on Ubuntu; one macOS job runs
workspace clippy and the platform tests against macOS. Every job pins its actions by
SHA, sets `persist-credentials: false`, least-privilege permissions, and a timeout, and
every cargo command that resolves the lockfile is `--locked`.
### Why this much supply-chain control, and why scope advisories to the built targets?

A tool that runs on your machine with your permissions deserves the same scrutiny as a
server: CodeQL, OSV-Scanner, OpenSSF Scorecard, zizmor, Dependency Review with a license
allow-list, `cargo deny`, a 7-day cooldown on every automated bump, a weekly
full-history gitleaks scan, and the branch ruleset as code. `Cargo.lock` lists every
platform's dependencies, including Windows-only crates this tool never builds; so
`cargo deny` evaluates the `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`
graphs — defining what is built rather than ignoring anything — and an OSV exception is
allowed only for a crate absent from those graphs, with a reason and an expiry.
### Why no release pipeline?

A tool for its owner is built and installed from its own checkout with
`cargo install --locked --path crates/myapp` (`just install-cli`): no secret, no tag,
and no CI involved. `CHANGELOG.md` and the workspace version still record what changed.
A release workflow, signed or prebuilt binaries, a package-manager tap, or crates.io
publishing is a decision an app records in an ADR when a tool needs to reach other
people.
<!-- template-only -->
### Why a bootstrap script?

Renaming an app by hand misses a site. `just bootstrap` rewrites an explicit list of
placeholder sites — never a global replace — renames the crates, updates `Cargo.lock`
offline, strips the template-only material, and resets the version and changelog. CI
proves it on every pull request by bootstrapping a fresh clone with a hyphenated
multi-word name and running `just check` in the result.
<!-- /template-only -->

### Why an optional OpenRouter adapter?

Some apps need model calls; the counter does not. The `openrouter` feature keeps the
HTTP and credential-file dependencies out of default builds, and an explicit call is
the only place that looks up a key or contacts a provider. Core's synchronous
`TextGenerator` port, `GenerationService`, and `GenerationView` work for either front
end and are tested with a fake; the platform adapter translates blocking HTTPS into
those values. `ureq` supplies HTTPS without an async runtime, and `dotenvy` parses a
local credential file without changing the process environment.

The composition root selects `openai/gpt-6-luna`, Max reasoning effort, and a bounded
token budget in source. `OPENROUTER_KEY` comes from the environment, falling back to
`.env.local` in the working directory. There are no implicit calls, automatic retries,
or conversation history. [OpenRouter](docs/openrouter.md) describes the bounds, error
behavior, and how a TUI can schedule a call without blocking its event loop.

### Why AGENTS.md and skills, but no committed agent permissions?

The repository is developed with coding agents, often unattended. `AGENTS.md` gives them
the architecture, the gates, and the hard prohibitions; path-scoped rules under
`.claude/rules/` and skills authored under `.agents/skills/` (mirrored by
`just agents-sync`) carry the procedures. Which commands an agent runs without a prompt
is each person's choice, so no `.claude/settings.json` is committed: permissions and the
format-on-edit hook live in a user-level or gitignored local settings file, and the
gates and `AGENTS.md`, not a permission list, are what bind every author.

### Why an ADR tree that ships empty?

The decisions in this section are the shared foundation's. Each app decides different
things — where it keeps state, which platforms it targets, which permissions it asks
for, whether it ever ships releases — and records each as an Architecture Decision Record
under [docs/architecture/](docs/architecture/README.md), whose index ships empty.
A replaced decision gets a new ADR rather than a rewrite, so the reasoning that held at
the time stays readable. [docs/architecture/roadmap.md](docs/architecture/roadmap.md)
ships as a skeleton for the app's direction.

### Why may nothing a check runs take over your machine or terminal?

The checks run on the machine you are working on, often while an agent iterates in a
terminal beside yours. So nothing routine — `just check` and every recipe in it, the
pre-commit hook, an agent's own verification — may show a window, take focus, or raise
a permission, Keychain, or Gatekeeper prompt, and none may take over a terminal: no
check runs `myapp tui`, enables raw mode, enters the alternate screen, or needs a TTY.
An agent's evidence is the tests, a subcommand run against a scratch `HOME` (on Linux,
with `XDG_DATA_HOME` and `XDG_STATE_HOME` unset too), and `just logs`; the full-screen
view is yours to run.
<!-- template-only -->
## Using This Template

1. Click **Use this template** on GitHub and clone your new repository.
2. In the clone, run `mise trust` (mise asks before it uses an untrusted `mise.toml`),
   `just install`, then `just bootstrap`. It asks for the display name (`MyApp`), the
   slug used for crate and binary names (`myapp`), the bundle identifier
   (`com.example.myapp`), the GitHub `owner/repo`, the author, and the copyright
   holder, and rewrites exactly those placeholder sites. It then removes
   `docs/template/` and this section, resets `CHANGELOG.md` and the version to 0.1.0,
   deletes itself, and prints the steps below.
   To also copy your template checkout's `.env.local` automatically, use
   `just bootstrap --env-from /path/to/template-checkout`. It copies the whole file
   without displaying its contents, creates it with owner-only read/write permissions,
   and preserves an existing destination. Relative paths are resolved from the new
   checkout; a missing or unreadable source fails before the rename. Git ignores this
   local file. Omit the option for apps that need no credentials.
3. Review the rewrite (`git status`, `git diff`), and commit it as one commit before
   you edit anything, so the rename stays one reviewable diff.
4. Fill in `AGENTS.md`'s `## Product` section: what the app is and who it is for, the
   core interaction, and the non-goals it must not grow. Delete every `TODO:` marker as
   you go; `just check` fails while one is left.
5. Fill in the [docs/architecture/roadmap.md](docs/architecture/roadmap.md) skeleton —
   the Now, Next, and Later outcomes that follow from the Product section — with the
   `steering-the-roadmap` skill. Nothing checks that page, so its `TODO:` lines stay
   until you replace them.
6. Verify the result with `just check`, commit the Product section and roadmap, and
   push both commits to `main`. The ruleset is not on yet (step 10), so `main` still
   takes a direct push, and CI's first run checks the result.
7. Create the label set on the new repository: `just labels` (the issue forms rely on
   the labels in `.github/labels.yml`). `.github/dependabot.yml` names its labels
   explicitly, and Dependabot skips one the repository lacks
   (<https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference>,
   `labels`, checked 2026-09-30), so add `dependencies` by hand to any Dependabot pull
   request opened before this step.
8. Turn on the repository's security settings: secret scanning and push protection,
   private vulnerability reporting (`SECURITY.md` points at it), and Dependabot alerts
   and security updates. Install the Renovate GitHub App on the repository
   (<https://github.com/apps/renovate>, checked 2026-09-30): `.github/renovate.json` is
   only its configuration, so without it nothing bumps `mise.toml` or
   `rust-toolchain.toml`.
9. Replace the sample counter with your app, following the `starting-an-app` skill; it
   lists what to delete and the first decisions to record.
10. Repository admin only, once the bootstrap commit is on `main`: run `just ruleset`.
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
- [Architecture](docs/architecture.md)
- [OpenRouter](docs/openrouter.md)
- [Architecture Decisions](docs/architecture/README.md) and the
  [Roadmap](docs/architecture/roadmap.md)
- [Contributing](CONTRIBUTING.md), [Security Policy](SECURITY.md),
  [Code of Conduct](CODE_OF_CONDUCT.md), [Changelog](CHANGELOG.md)
<!-- template-only -->
- The template's own design: [design.md](docs/template/design.md),
  [skills-plan.md](docs/template/skills-plan.md), and
  [implementation-notes.md](docs/template/implementation-notes.md)
<!-- /template-only -->

## License

[MIT](LICENSE)
