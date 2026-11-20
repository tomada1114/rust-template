# Project Guide

This file holds what every agent needs before it knows which task it is on: what the
app is, how to check a change, where code goes, and which decisions need a human. It is
the one project guide, and it leaves three things to others:

- **The conventions of one kind of change** belong to a skill under `.claude/skills/`,
  loaded when the work calls for it — [Skills](#skills) says where they live.
- **The rules for one kind of file** belong to `.claude/rules/`, loaded by path —
  [Rules](#rules) lists them.
- **A value a gate enforces** — a lint level, a banned call, a format option, a coverage
  floor, a tool pin — belongs to its config (`Cargo.toml`'s `[workspace.lints]`,
  `clippy.toml` and `crates/myapp-core/clippy.toml`, `rustfmt.toml`, `deny.toml`,
  `typos.toml`, the `test-core` and `test-xtask` recipes in the `justfile`, `mise.toml`,
  `rust-toolchain.toml`); running the gate is how you learn it.

A rule that belongs to one of those lands there, and this file points to it rather than
keeping a second copy that goes stale.

## Overview

This is a Rust command-line tool built from a strict template: one binary, `myapp`,
whose clap subcommands do the work and whose `myapp tui` subcommand opens a full-screen
ratatui view over the same core. It builds and runs on macOS and Linux, and it is
installed from its checkout with `cargo install --path`; there is no release pipeline.
The code is a Cargo workspace — the logic in `crates/myapp-core`, the OS adapters in
`crates/myapp-platform`, fakes and contract suites in `crates/myapp-test-support`, and the
`myapp` binary itself in `crates/myapp` — and repository automation is Rust in the
`xtask/` crate (`cargo xtask <task>`), apart from the Python and shell scripts a skill
bundles. How the app is built and why lives in the skills that own each subject (the
[Skills](#skills) table) and in [Architecture](#architecture) below; there is no
separate architecture or roadmap document (`updating-docs`).
Quality gates are on from day one: rustfmt, clippy `all` + `pedantic` with warnings as
errors, `unsafe_code = "forbid"` in every crate, an 80% line and 80% function coverage
floor on `myapp-core`, and llvm-cov floors on `xtask` (85/90) and the staged guard's
rules in `xtask/guard/` (90/100); skills' bundled Python and shell suites run with no
floor.

## Product

**TODO: in the template this section is a placeholder.** It is the one part of this
file about the application rather than the harness, so every repository cut from the
template writes its own: without it an agent implementing an issue here has no in-repo
answer to "is this in scope?". Fill in every `TODO:` below right after the rename
(`README.md`'s "Using This Template") — once `cargo xtask bootstrap` has run,
`just check-harness` fails while one is left.

- **What it is, and who it is for** — TODO: one paragraph. The problem it solves, and
  whose problem that is.
- **The core interaction** — TODO: the one thing a user does most. If the app does not
  do this well, nothing else about it matters.
- **Non-goals** — TODO: what this app deliberately does not do, even where it would be
  easy. A first version's cut list is longer than its feature list, and this is the
  line an eager implementer crosses first: moving anything from here to a goal is a
  human's decision, not an implementer's.
- **Why it is shaped this way** — TODO: the reasoning behind the three entries above,
  in the present tense — why this audience, why this interaction comes first, and why
  each non-goal stays out — so a reader finds why and not only what. It is rewritten
  when the reasoning changes, not appended to ("Before changing the architecture").

## Quick Reference

```bash
just install       # Install pinned tools (mise) and lefthook's git hooks (no sudo)
just verify-hooks  # Fail when lefthook's pre-commit hook is not installed
just fmt           # Format every Rust file (cargo fmt)
just fix           # Apply the automatic fixes there are: rustfmt's (clippy's findings are fixed by hand)
just lint          # rustfmt check, clippy -D warnings
just test          # test-core + test-xtask: every test that runs anywhere, with the coverage floors
just test-core     # myapp-core with its 80/80 floors, its doctests, and the Linux-buildable crates' tests
just test-xtask    # The xtask crate's tests with its floors (85/90; the guard's rules 90/100)
just test-fast increment  # One core test or a group of them, no floor (iteration only)
just test-platform # Platform adapter and CLI tests against the real OS, macOS or Linux (no human)
just test-scripts  # The skills' bundled Python suites, and shellcheck over .claude/cloud/ and .claude/hooks/ (no floor)
just check-harness # Re-assert the harness's claims about itself (cargo xtask check-harness)
just logs          # Print the end of the newest app log and exit
just deny          # cargo deny: advisories, licences, bans, sources
just check         # Everything a Mac runs without a human: verify-hooks → fmt → lint → lint-repo → test-scripts → check-harness → test → test-platform
just clean         # Remove build output (target/, coverage/)
just prune-temp    # Remove temp dirs a bootstrap check left behind (verify-bootstrap-*) and idle Claude Code scratchpads (--dry-run to list)
just verify-bootstrap    # Bootstrap a scratch clone in a temp directory; fail on anything it leaves behind (template only)

# A human's recipes — they need a logged-in Mac, never end, or write outside the checkout; an agent runs them only when asked
just test-local        # The #[ignore]d tests that need a logged-in Mac, a TCC grant, or the Keychain
just logs-follow       # Follow the newest app log (never ends)
just install-cli       # Install the myapp binary into ~/.cargo/bin (cargo install --locked --path crates/myapp)

# Writes to GitHub or rewrites the repository — a human's step
just labels     # Create/update labels from .github/labels.yml (never deletes)
just ruleset    # Create/update every .github/rulesets/*.json ruleset by name (admin-only)
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
| An adapter under `crates/myapp-platform/` | `just test-platform` (its contract tests against the real adapter); an `#[ignore]`d test there is human-run — ask for `just test-local` output for the PR |
| A fake or a contract function under `crates/myapp-test-support/` | `just test-core` (core runs the contracts against the fakes), then `just test-platform` (platform runs them against the real adapters) |
| The binary under `crates/myapp/`, or its error wording in `crates/myapp/src/wording.rs` | `just test-core` (it runs the binary's tests), then `just test-platform` |
| Formatting of any Rust file | `just fmt`, or `just lint` to only check |
| The TUI under `crates/myapp/src/tui/`, or a screen's state in core | `just test-core` (the screen's tests in core and the view's `TestBackend` tests), then `just test-platform`; a change to the terminal loop itself carries the human's `myapp tui` run as evidence — an agent never runs it (the `building-tuis` skill) |
| Behavior only the running tool shows (a log line) | `just test-platform` and `just logs` — no gate asserts it, so the PR carries the evidence (the `running-the-app` skill) |
| A task under `xtask/` (including the guard's rules in `xtask/guard/`) | `cargo nextest run -p xtask -p xtask-guard` while iterating, then `just test-xtask` (the floors) and `just lint` |
| `lefthook.yml` or `xtask/src/verify_hooks.rs` | `just test-xtask` (`xtask/tests/lefthook.rs` runs the real hook), then `just verify-hooks` |
| A harness check under `xtask/src/check_harness/`, or its fixtures under `xtask/tests/fixtures/` | `cargo nextest run -p xtask check_harness` while iterating, then `just test-xtask` (the floors) and `just check-harness` |
| A `just` recipe name, a workflow's `uses:` or `permissions:`, a skill's frontmatter, the `## Product` section, a committed `.claude/settings.json`'s `permissions` (if one is added), core's forbidden-crate lists (`deny.toml`'s `wrappers`, the closure check), the gates `just check` or `ci.yml` runs, or a label an issue form, workflow, or bot config applies | `just check-harness` |
| A skill under `.claude/skills/` | `just check-harness`; `just test-scripts` too when the skill ships scripts |
| A workflow under `.github/workflows/` | `mise exec -- actionlint` and `mise exec -- zizmor .`, then `just check-harness` |
| Markdown | `mise exec -- typos <file>` (the pre-commit hook and CI's `Repo Lint & Harness` job run it) |
| `Cargo.toml`, `Cargo.lock`, or `deny.toml` | `just deny`, `mise exec -- cargo shear`, `just lint`, then `just test` — a new dependency is a sign-off change (`.claude/rules/project.md`) |
| `mise.toml` or `rust-toolchain.toml` | `mise install` for `mise.toml` (rustup installs a new `rust-toolchain.toml` channel on the next `cargo` call: `.claude/rules/project.md` › Tool Pinning), then `just check` |
| `.github/labels.yml`, or an issue form under `.github/ISSUE_TEMPLATE/` | `mise exec -- typos <file>`, then `just check-harness` (every applied label declared, once) |
| `.github/rulesets/main.json`, or `xtask/src/apply_ruleset.rs` | `cargo nextest run -p xtask apply_ruleset`; `just check-harness` for `main.json` (every required context names a job that runs on every pull request) |
| A new file, or a new spelling of a placeholder (`MyApp`, `myapp`, `myapp-core`, `myapp_core`, `com.example.myapp`, the template's owner/repo) — template only: the bootstrap removes this row | `just verify-bootstrap` (it bootstraps a scratch clone in a temporary directory and fails on a placeholder the rename misses, template-only text, or a dangling reference) |

## Architecture

```
Cargo.toml                  # Virtual workspace: members, resolver = "3", [workspace.package],
                            #   [workspace.dependencies] (the one place a version is written),
                            #   [workspace.lints]
rust-toolchain.toml         # The one Rust pin
crates/
├── myapp-core/             # Domain logic, state, and the ports (traits) everything outside
│                           #   the process is reached through. No OS APIs, no terminal,
│                           #   no direct I/O; built and tested on Linux; coverage-gated
│                           #   (lines 80, functions 80)
├── myapp-platform/         # Adapters implementing core's ports against the real OS and
│                           #   file system (JsonFileCounterStore, SystemClock, logging,
│                           #   paths) — translation only, outside the coverage floor
├── myapp-test-support/     # One fake per port + one `<port>_contract` function per port.
│                           #   A [dev-dependencies] entry only; never ships
└── myapp/                  # The `myapp` binary: the tool itself and the composition root.
                            #   Builds the real adapters, hands them to core, and translates
                            #   arguments to calls and results to stdout, stderr, and an exit
                            #   code. Decides nothing; src/wording.rs holds every stderr sentence,
                            #   and src/tui/ the ratatui terminal loop and view for `myapp tui`
xtask/                      # Repository automation in Rust, run as `cargo xtask <task>` (the
                            #   alias is in .cargo/config.toml); never shipped
└── guard/                  # Crate `xtask-guard`: the staged guard's path and credential rules
```

- New logic goes in `myapp-core` with tests. The adapters and the binary translate; a
  decision found in either belongs in core, where the coverage floor sees it.
- The dependency direction is one-way: `myapp-platform` → `myapp-core`, and both ←
  `myapp` (the binary). Core never depends on platform or an OS binding crate, and
  never names the binary's front-end crates (clap, ratatui, crossterm), so a screen's
  state machine is tested inside the floor with plain values; `myapp-test-support` is
  reached only through `[dev-dependencies]`.
- A port is a synchronous `Send + Sync` trait core declares; `myapp-platform`
  implements it; the binary constructs the real adapter and hands it to core; a test
  hands core a fake from `myapp-test-support`. Core never meets async.
  The worked example is `CounterStore` / `JsonFileCounterStore` / `InMemoryCounterStore`
  and `Clock` / `SystemClock` / `FixedClock`.
- Optional model calls use `TextGenerator` / `OpenRouterClient` / `StubTextGenerator`
  with the same synchronous boundary. `GenerationService` validates input and returns
  a `GenerationView`; the binary's `src/llm.rs` selects model and effort in source.
  The `openrouter` feature is off by default. Credentials are resolved only on a call,
  from `OPENROUTER_KEY`, then `.env.local` in the working directory. See
  `docs/openrouter.md`; `just lint` checks all features and the test recipes exercise
  both default and feature-enabled builds using local HTTP fixtures.
- The core boundary is enforced three times, so removing one layer leaves the others:
  core's `Cargo.toml` lists no OS or platform crate; `deny.toml`'s `[bans]`
  `wrappers` let only `myapp` depend on `myapp-platform`; and a harness check fails
  when core's normal and build dependency closure reaches `objc2*`,
  `core-foundation*`, `security-framework*`, or `myapp-platform`. Those lists change
  together, and `just check-harness` fails when they differ.
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
- Errors are one `thiserror` enum per port or core module, with a variant per failure
  the caller can act on; the binary maps each variant to wording in
  `crates/myapp/src/wording.rs`, matched without a wildcard arm, and to exit code 1, and
  `myapp tui` shows the same wording on its error line. An error that leaves the process
  as data (a `--json` form) also serializes as a typed code (`#[serde(tag = "code")]`).
  Core never builds a user-facing sentence, and no error or log line carries user data
  (`designing-errors`).
- The binary and `myapp-platform` log through the `tracing` macros; `myapp-core` has no
  `tracing` dependency and logs nothing. Only the binary installs a subscriber
  (`myapp_platform::init_logging`). Files go to `~/Library/Logs/com.example.myapp/` as
  `myapp.YYYY-MM-DD.log`, rotated daily, the last 14 kept (on Linux, under
  `$XDG_STATE_HOME/myapp/logs`); `just logs` prints the newest. While `myapp tui` owns
  the terminal, logging goes to the file only: a line on stdout or stderr would corrupt
  the frame.
- Every value a front end shows is a core view type (`CounterView`), so a subcommand's
  output and a TUI frame read the same model. A subcommand prints data to stdout and
  diagnostics to stderr (`designing-clis`); the TUI's state and key table live in core
  and its loop and view in `crates/myapp/src/tui/` (`building-tuis`). Every string a
  user reads comes from `crates/myapp/src/wording.rs`.
- Four things are contract rather than private — core's public API, the bundle
  identifier and XDG directory name, the command line, and on-disk file formats — and
  each changes only as "What is contract and what is private" below says.
- `target/` and `coverage/` are build output: never edit or commit them.

### What is contract and what is private

Nothing here is published as a library, so the contract is what something outside a
change can observe: another crate, a machine that ran an earlier build, a script or a
scheduled job that runs `myapp`, or the user. These are contract; everything else is
private. This table is the one list of them: a skill or a pull-request rule that needs
it points here.

| Contract | What depends on it | What changing it requires |
|---|---|---|
| **Core's public API** — every `pub` item re-exported from `crates/myapp-core/src/lib.rs` (`Counter`, `CounterService`, `CounterView`, `CounterError`, `CounterScreen`, `ScreenAction`, `ScreenKey`, `CounterStore`, `StoredCounter`, `StorageError`, `StorageErrorKind`, `Tuning`, `TuningError`, `Clock`, `UnixMillis`, and the generation types `TextGenerator`, `GenerationService`, `GenerationSettings`, `GenerationRequest`, `GenerationView`, `GenerationError`, `ReasoningEffort`) | `myapp-platform`, `myapp-test-support`, `myapp`, and their tests | Update every caller in the same pull request; the compiler finds them. A new port is a design change ("Before changing the architecture"). |
| **The data and log locations** — the bundle identifier `com.example.myapp` (`BUNDLE_IDENTIFIER` in `crates/myapp-platform/src/paths.rs` and `bundle_id` in the justfile) and the XDG directory name `myapp` (`XDG_APP_NAME`) | Where the tool's files are on a machine that ran it: on macOS `~/Library/Application Support/com.example.myapp/` and `~/Library/Logs/com.example.myapp/` (and any privacy grant, keyed by the identifier); on Linux `$XDG_DATA_HOME/myapp/` and `$XDG_STATE_HOME/myapp/logs/` | Fixed once the tool has run anywhere but your checkout: a new name leaves the user's data behind under the old one. Changing it is a human's decision, a design change whose pull request rewrites this row. |
| **On-disk file formats** — `counter.json` (it carries a format version) and the log files; `integrating-system-apis`' `references/file-formats.md` describes each | Files already on a user's disk; `just logs` and anyone reading the logs | A new version still reads the old format: a format version and a migration, with a test that reads a sample of the previous format. |
| **The command line** — `myapp counter show`, `myapp counter increment`, `myapp tui`, and, with the `openrouter` feature, `myapp llm ask <prompt>`; `--help`, `--version`, what goes to stdout and what to stderr, and the exit codes (0 success, 1 the action failed, 2 a usage error) (`designing-clis`) | A person, a script, or a scheduled job that runs `myapp` | Keep the old form working, or treat the change as breaking and say so in `CHANGELOG.md`. |

The local credential file the `openrouter` feature reads (`.env.local`) is
configuration, not persisted application state; the running app never writes it.

**Private** is everything else: `pub(crate)` and private items, how an adapter talks to
the OS behind its port, the full-screen view's layout and styling, file and module
layout, test helpers, and log wording. Changing any of it needs only the gates that
already run.

No gate notices every broken contract item. The compiler guards core's public API, and
`crates/myapp/tests/cli.rs` guards the command line; a changed file format or a renamed
identifier passes every check and fails on the user's machine, so review is what
catches it, and a user-visible change to any contract item owes a `CHANGELOG.md` entry.

## Before changing the architecture

The design is recorded in one place per subject, as it stands now, never as a log of
decisions: the skill that owns the subject (the [Skills](#skills) table), with
[Architecture](#architecture) for the layer rules and the contract, and this file's
Product section for scope. Git history holds what it used to be. Keeping those current
is the whole obligation: no other document repeats the design, so no other document
needs rewriting with it. The changes below, which the skills call design changes, are
hard to reverse, so the pull request that makes one also rewrites the owning skill (or
that section): the current design and the reasoning behind it (what it protects and,
where it matters, the alternative it rules out and why), in the present tense, in place
of the sentences it replaces, never as a dated entry beside them:

- a new crate in the workspace, or a new port in core;
- persistence or configuration — where and in what format the tool keeps state, or a
  settings file or environment variable it reads;
- a new crate dependency, runtime or dev;
- a new target platform (Windows, another architecture), or dropping one;
- distribution — a release workflow, prebuilt or signed binaries, a package-manager
  tap, crates.io publishing, an updater;
- `rust-version` in `Cargo.toml`;
- an OS privacy permission — on macOS a TCC grant such as Accessibility, Input
  Monitoring, or Full Disk Access;
- `unsafe` code, which means lifting `unsafe_code = "forbid"` for `myapp-platform`;
- the bundle identifier (`com.example.myapp` until the bootstrap renames it) or the XDG
  directory name (`myapp`), which key the tool's data and log directories;
- a second language for the tool's wording;
- a TUI theme beyond the terminal's own colors;
- replacing clap or ratatui with another framework, a clap major, or ratatui 1.0 and
  its later majors (a pre-1.0 ratatui or crossterm minor is a migration
  `merging-dependency-prs` lands on its own pull request, not one of these).

Writing the reasoning down grants nothing: a release pipeline, a permission grant, or a
new dependency still needs the sign-off "Security and human approval" asks for, and the
owner reviews the rewritten description with the change. A change that replaces one of
the layers every app starts with rewrites the reasoning its skill gives for it (for the
crates and ports, `designing-core-logic`' `references/design-reasons.md`), rather than
leaving the old reason beside the new one.

## Skills

Skills are authored under `.claude/skills/`, the path Claude Code reads, and edited in
place: there is no second copy to keep in step.

| Skill | Load it for |
|---|---|
| `authoring-skills` | Writing or editing a skill: the conventions, the layout, the size cap |
| `smart-commit` | Turning the working tree into Conventional Commits; a refused pre-commit hook |
| `create-pr` | Opening or updating a pull request: title, body, Release impact, evidence |
| `triaging-issues` | Filing or labelling an issue: type, priority, blocked, tracking |
| `shipping-issues` | Taking ranked open issues to merged pull requests, from a local session or a Claude Code cloud session, over REST `gh api` calls only — pick, implement, review the branch with `/code-review`, PR, CI verdict, merge, follow-ups |
| `merging-dependency-prs` | Landing open Dependabot and Renovate pull requests; a pre-1.0 ratatui minor lands alone |
| `managing-dependencies` | Adding or changing a crate: the review record, features, licences |
| `changing-gates` | Editing a file that enforces: lints, floors, hooks, harness checks, workflows, the ruleset |
| `updating-docs` | Deciding which document a change must update |
| `writing-repo-scripts` | A `cargo xtask` task or a skill's bundled script, and its test |
| `starting-an-app` | Turning the template into a new app: bootstrap, Product section, the tool's shape (subcommands only, or plus `myapp tui`), first design decisions |
| `writing-rust` | Rust in `crates/*`: ownership, errors, clap and ratatui idioms, compiler messages, clippy |
| `tdd` | Red-green-refactor with `just test-fast` |
| `writing-tests` | The body of one Rust test: oracles, fakes, contracts, clocks, the built binary, `TestBackend` |
| `placing-tests` | Where a new test goes and which floor measures it |
| `designing-core-logic` | Shaping logic in `myapp-core`: ports, `Tuning`, transitions, views, a TUI screen's state |
| `designing-clis` | A subcommand, its flags and output: stdout and stderr, exit codes, `wording.rs`, `--json`, configuration |
| `building-tuis` | The `myapp tui` screen: model and update in core, the loop and view in `crates/myapp/src/tui/`, `TestBackend` |
| `designing-errors` | Error enums, wording and exit codes in the binary, adapter mapping, `ERR_*` script codes |
| `integrating-system-apis` | Calling macOS and Linux from `myapp-platform`: `cfg`, commands, `objc2`, TCC |
| `running-the-app` | Seeing a change work: `cargo run -p myapp`, `just test-platform`, and `just logs`; `myapp tui` run by the human, never by an agent |

### Rules

The files under `.claude/rules/` load by path: each applies while you touch a file
matching its `paths:` globs.

| Rule | Loads when you touch |
|---|---|
| `.claude/rules/rust.md` | `crates/**/*.rs` |
| `.claude/rules/testing.md` | Rust tests (`crates/*/tests/**`, `crates/myapp-test-support/**`) |
| `.claude/rules/project.md` | manifests, lockfiles, and gate configs: `Cargo.toml` files, `Cargo.lock`, `mise.toml`, `rust-toolchain.toml`, `deny.toml`, `clippy.toml` files, `rustfmt.toml`, `lefthook.yml`, `typos.toml`, `osv-scanner.toml`, `.github/dependabot.yml`, `.github/renovate.json` |
| `.claude/rules/docs.md` | `docs/**/*.md`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` |
| `.claude/rules/scripts.md` | repository automation: `xtask/**`, `.claude/skills/*/scripts/**` |

### Sub-agents

`.claude/agents/` defines the tiers; each file carries its model, effort and
instructions, and is authored and maintained here, in this repository. Delegate by
`subagent_type` (for example `subagent_type: executor`), never a bare `model`; prose
names tiers by role only. `just check-harness` holds each file to a frontmatter whose
`name` is its file stem and whose `model` and `effort` are set.

| Agent | Takes |
|---|---|
| `executor` | a settled spec with a clear pass/fail: implementation, tests, getting a check green, bulk edits |
| `architect` | complex multi-file implementation, design judgment, review and bug finding, synthesis, a spec that still has holes |
| `scout` | read-only, judgment-free research: collecting, enumerating, or summarizing without changing any file |
| `worker` | single-shot, tool-free writing or checking from a complete brief |

## Security and human approval

Only what is mechanically decidable is blocked at commit time; whether a commit
*should* contain what it contains stays in PR review. The pre-commit hook's staged
guard (`cargo xtask check-staged`, rules in `xtask/guard/`) refuses a
secret-shaped staged path or credential-shaped staged content.

Never read a secret-shaped file, even to check it: `.env`, `.env.*`, or `.envrc.*`
(the `.example`/`.sample`/`.template` samples excepted), anything under a `secrets/`
directory, `*.p12`, `*.pfx`, `*.p8`, `*.provisionprofile`, `*.mobileprovision`,
`*.keychain`/`*.keychain-db`, `*key*.pem`, `private-key.*`, an SSH private key
(`id_rsa`, `id_ed25519`, …), `.netrc`, `credentials.json`, and `secrets.json`. This is
the same list `xtask/guard/src/paths.rs` refuses to commit, so the read rule and the
commit guard agree (the guard also refuses `.claude/settings.local.json`, which is
per-user settings rather than a secret, so reading it is fine and only committing it is
not); if a task seems to need one, ask the human for the non-secret fact instead.

Get a human's sign-off before acting on any of these. This section is the rule itself,
not a description of a check that enforces it: a personal permission file may stop a few
of them on one host, but this repository ships none (see "Enforcement layers").

- Adding a release pipeline or anything it would need: a workflow that builds or
  uploads artifacts, signing or notarization, a repository secret, publishing to
  crates.io or a package-manager tap. The tool has no distribution: it is installed
  from its checkout with `cargo install --path`.
- Creating or pushing a release tag.
- Editing a personal permission file — `.claude/settings.local.json` or
  `~/.claude/settings.json` —
  unless the owner asks for it in that session: it decides what an agent may run, so
  changing it changes the agent's own limits, and no review ever sees it.
- Adding a new crate — see the dependency policy in `.claude/rules/project.md`.
- Weakening any gate: lowering a coverage floor (the `test-core` and `test-xtask`
  recipes), relaxing a lint (`[workspace.lints]`, `clippy.toml`), or widening a
  workflow's `permissions:`. If a gate looks wrong, say so and let a human decide. In
  this repository that also means any of these, when used to make a failing check pass:
  - `#[allow(…)]` or `#[expect(…)]` on a clippy or rustc lint
  - `unsafe`, or lifting `unsafe_code = "forbid"`, to get past the borrow checker
  - `#[ignore]` on a failing Rust test, or `skip` on a failing test in a skill's
    bundled suite
  - excluding a file from coverage, or adding a path to an ignore list (`typos.toml`,
    `deny.toml`, `osv-scanner.toml`)
  - deleting an assertion, or loosening one until it passes
  - `continue-on-error` on a CI job or step, or `git commit --no-verify`
- Working around a denied command. When a command is denied — by
  a permission file, a hook, or a human — re-spelling it (`git -C . …`,
  `bash -c '…'`, bundled short flags such as `-anm`, an alias or script wrapper) is
  forbidden. Stop and ask.
- Any write to a remote: `git push`, `gh pr create`, or any other remote write that
  is not performed by a task this repository ships. `cargo xtask sync-labels`
  (`just labels`) is such a task for labels: it only ever creates or updates a label
  `.github/labels.yml` declares, and never deletes one — but running it against the
  live repository still needs sign-off before its first run there, the same as any
  other remote write. `cargo xtask apply-ruleset` (`just ruleset`) is the same kind of
  task for branch and tag protection: it only ever creates or updates the rulesets
  `.github/rulesets/*.json` name (`main` and `release-tags`), each by its own name,
  never deletes one, needs repository admin permissions to
  succeed, and still needs sign-off before its first run against the live repository.

Standing exceptions: invoking one of these skills is the sign-off for the remote
writes that skill exists to make, for that invocation only.

- `smart-commit`, when asked to push: pushing the commits it made to the current
  branch.
- `create-pr`: pushing the current branch and creating or updating its pull request.
- `shipping-issues`: adding a missing `priority:` tier label to an open issue; removing
  `blocked: dependency` from issues its merge unblocked; for a design-held issue it
  takes on, posting its `## Design decision` comment and then clearing `blocked: design`
  and the ship contract's `design=open`; creating and pushing its own branches (in a
  cloud session, only the session's designated branch); creating the pull request; on
  that open PR alone, appending `Closes #<n>` when missing or retargeting its base to
  the default branch; merging it once CI passes for the current head; closing, with a
  back-reference comment naming the PR, the issue that merged PR was meant to close when
  GitHub left it open; filing and labelling follow-up issues; and removing the local
  branches and worktrees it created — never a force-push, a remote branch deletion, a
  reply to or resolution of a review thread, a comment requesting a review, or Auto-fix.

One request is a standing exception too: the human explicitly asking for an issue
("file an issue for this") is the sign-off for the `gh issue create` of each issue that
request asks for, with the labels `triaging-issues` gives it, and for comments on those
issues in the same request. An issue the agent would file from a friction it noticed on
its own, or from one the human raised without asking for an issue, is drafted in the
reply and waits for a yes.

None of them covers anything else in the list above: a force push or other history
rewrite, `--no-verify`, weakening a gate, a release pipeline or signing, a release tag,
a new dependency, `just labels`, or `just ruleset`. A skill that reaches one of those
stops and asks.

### Never taking over the developer's Mac

The owner develops on the same Mac the checks run on, often while an agent iterates
unattended in a terminal next to their own. Nothing a routine check runs — `just check`
and every recipe in it, the pre-commit hook, a PostToolUse hook an agent registers, and
any step an agent runs to verify its own work — may show a window, take keyboard focus,
move the pointer, or raise a permission, Keychain, or Gatekeeper prompt; and none may
take over a terminal.

- Never run `myapp tui` (`cargo run -p myapp -- tui` included). No check enables raw
  mode, enters the alternate screen, reads a key from a real terminal, or needs a TTY:
  the TUI is tested by drawing into ratatui's `TestBackend` and feeding keys as values.
  When a change only the real terminal shows needs eyes on it, ask the human to run it
  (`running-the-app`).
- For evidence that a change works, use the tests, `just test-platform`, a plain
  subcommand run against a scratch `HOME` (on Linux, with `XDG_DATA_HOME` and
  `XDG_STATE_HOME` unset too, as `running-the-app` shows), and `just logs`.
- `just test-local`, `just logs-follow`, and `just install-cli` are started by a human on
  purpose.
- A test that needs a GUI session, a TCC grant, or the Keychain is
  `#[ignore = "local machine: <what it needs>"]` and runs only in `just test-local`. No
  test needs a real terminal: nextest gives a test none, and a human running `myapp tui`
  is the only route to one.
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
- Any tool other than Claude Code: a Claude Code permission list binds nothing else.

### GitHub settings a new repository must enable

"Use this template" copies files, not settings, so a repository's admin sets these up
once: the security switches under Settings › Advanced Security (Code security on older
UIs), the `main` ruleset, the Renovate App, automatic head-branch deletion, and the
label set:

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
- The `release-tags` ruleset, applied by the same `just ruleset` from
  `.github/rulesets/release-tags.json`: only a repository admin may create, move, or
  delete a `v*` tag, so it keeps its admin bypass.
- The **Renovate** GitHub App (<https://github.com/apps/renovate>, checked 2026-09-30),
  installed on the repository: without it `.github/renovate.json` does nothing, so
  `mise.toml` and `rust-toolchain.toml` are never bumped — Dependabot covers only cargo
  and Actions.
- **Automatically delete head branches** (Settings › General; the repository's
  `delete_branch_on_merge`): `shipping-issues` deletes no remote branch on either host,
  so without it every merged pull request leaves its head branch behind.
- The label set, created by `just labels` as soon as the repository exists.
  `.github/dependabot.yml` names its `labels` explicitly, and Dependabot then ignores
  one the repository does not define rather than creating it
  (<https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference>,
  `labels`, checked 2026-09-30), so add `dependencies` by hand to any Dependabot pull
  request opened before that.

## Enforcement layers

The rules in this file are held by layers, from mechanical to procedural:

- lefthook's pre-commit hook, on the staged files: `rustfmt --check`, `typos`, and the
  staged guard (`cargo xtask check-staged`), which refuses a secret-shaped path or
  credential-shaped content;
- `just lint`, `just test`, `just deny`, and `just check-harness`: the lints, core's
  bans and boundary, the coverage floors, and the harness's claims about itself;
- CI, on every pull request and push to `main`: the same recipes, plus the security
  workflows;
- this file, for everything else.

Each layer's row, and the gaps that stay open on purpose (a skipped hook, an unapplied
ruleset, the `#[ignore]`d tests, the real terminal loop), are in `changing-gates`'
`references/enforcement-layers.md`. A gate change updates its row there.

## Review Checklist

Before submitting a PR:

1. `just check` passes (every step of the justfile's `check` recipe)
2. New public items have `///` doc comments explaining *why* (`missing_docs` warns on
   any that lack one)
3. Tests cover the new behavior (happy path AND error path); a change to an adapter
   with an `#[ignore]`d test also carries `just test-local` output, since no gate runs
   it
4. No new crate without justification and a human's sign-off (see
   `.claude/rules/project.md`)
5. User-facing changes have a `CHANGELOG.md` entry under `[Unreleased]`
6. Commits and the PR title follow Conventional Commits (English)

## Important Reminders

- All code, docs, commits, and PRs must be written in English
- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files unless explicitly requested
- NEVER lower a coverage floor or relax a lint to make a check pass
- NEVER run a recipe that needs a human (`just test-local`, `just logs-follow`,
  `just install-cli`) unless the human asked for it; `just test-platform` and `just logs`
  are the evidence an agent gathers on its own
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
  checks, lint, typos, the staged guard); a judgement call — a
  relaxed config, a deleted workflow, a lowered threshold — is weighed in PR review,
  not blocked by the hook. `changing-gates` records why
