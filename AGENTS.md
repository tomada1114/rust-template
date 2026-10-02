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
  `typos.toml`, the `test-core` and `test-xtask` recipes in the `justfile`, `mise.toml`,
  `rust-toolchain.toml`); running the gate is how you learn it.

A rule that belongs to one of those lands there, and this file points to it rather than
keeping a second copy that goes stale.

## Overview

This is a macOS desktop app built from a strict template: a Rust core, a Tauri v2 shell,
and a React + Vite + TypeScript screen, distributed as a `.dmg`. The Rust code is a
Cargo workspace — the logic in `crates/myapp-core`, the OS adapters in
`crates/myapp-platform`, fakes and contract suites in `crates/myapp-test-support`, and the
`myapp` binary itself in `crates/myapp` — and repository automation is Rust in the
`xtask/` crate (`cargo xtask <task>`), apart from the Python and shell scripts a skill
bundles.
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
- **Where these decisions are recorded** — TODO: where the reasoning behind the three
  entries above lives — an ADR under `docs/architecture/` (see "Before changing the
  architecture"), a design issue, or another decision log — so a reader can find why
  and not only what.

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
just test-scripts  # The skills' bundled Python suites and shellcheck over their shell scripts (no floor)
just check-harness # Re-assert the harness's claims about itself (cargo xtask check-harness)
just logs          # Print the end of the newest app log and exit
just deny          # cargo deny: advisories, licences, bans, sources
just check         # Everything a Mac runs without a human: verify-hooks → fmt → lint → lint-repo → agents-check → test-scripts → check-harness → test → test-platform
just agents-sync   # Regenerate the .claude/skills/ mirror from .agents/skills/
just agents-check  # Fail if .claude/skills/ differs from .agents/skills/
just clean         # Remove build output (target/, coverage/)
just prune-temp    # Remove stale verify-bootstrap-* temp dirs and idle Claude Code scratchpads (--dry-run to list)
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
| Behavior only the running app shows (a log line) | `just test-platform` and `just logs` — no gate asserts it, so the PR carries the evidence (the `running-the-app` skill) |
| A task under `xtask/` (including the guard's rules in `xtask/guard/`) | `cargo nextest run -p xtask -p xtask-guard` while iterating, then `just test-xtask` (the floors) and `just lint` |
| `lefthook.yml` or `xtask/src/verify_hooks.rs` | `just test-xtask` (`xtask/tests/lefthook.rs` runs the real hook), then `just verify-hooks` |
| A harness check under `xtask/src/check_harness/`, or its fixtures under `xtask/tests/fixtures/` | `cargo nextest run -p xtask check_harness` while iterating, then `just test-xtask` (the floors) and `just check-harness` |
| A `just` recipe name, a workflow's `uses:` or `permissions:`, a skill's frontmatter, the `## Product` section, a committed `.claude/settings.json`'s `permissions` (if one is added), core's forbidden-crate lists (`deny.toml`'s `wrappers`, the closure check), the gates `just check` or `ci.yml` runs, or a label an issue form, workflow, or bot config applies | `just check-harness` |
| A skill under `.agents/skills/` | `just agents-sync`, then `just agents-check` and `just check-harness`; `just test-scripts` too when the skill ships scripts |
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
│                           #   the process is reached through. No tauri, no OS APIs, no
│                           #   direct I/O; built and tested on Linux; coverage-gated
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
  `myapp` (the binary). Core never depends on platform, tauri, or an OS
  binding crate; `myapp-test-support` is reached only through `[dev-dependencies]`.
- A port is a synchronous `Send + Sync` trait core declares; `myapp-platform`
  implements it; the binary constructs the real adapter and hands it to core; a test
  hands core a fake from `myapp-test-support`. Core never meets async.
  The worked example is `CounterStore` / `JsonFileCounterStore` / `InMemoryCounterStore`
  and `Clock` / `SystemClock` / `FixedClock`.
- The core boundary is enforced three times, so removing one layer leaves the others:
  core's `Cargo.toml` lists no tauri, OS, or platform crate; `deny.toml`'s `[bans]`
  `wrappers` let only `myapp` depend on `myapp-platform`; and a harness check fails
  when core's normal and build dependency closure reaches `tauri*`, `wry`, `tao`,
  `objc2*`, `core-foundation*`, `security-framework*`, or `myapp-platform`. Those lists
  change together, and `just check-harness` fails when they differ.
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
  (`#[serde(tag = "code")]`); the binary maps each code to wording in
  `crates/myapp/src/wording.rs`, matched without a wildcard arm. Core never builds a
  user-facing sentence, and no error or log line carries user data.
- The binary and `myapp-platform` log through the `tracing` macros; `myapp-core` has no
  `tracing` dependency and logs nothing. Only the binary installs a subscriber
  (`myapp_platform::init_logging`). Files go to `~/Library/Logs/com.example.myapp/` as
  `myapp.YYYY-MM-DD.log`, rotated daily, the last 14 kept; `just logs` prints the newest.
- Every type that crosses IPC lives in core and derives `ts_rs::TS`, exported to
  `ui/src/ipc/generated/`. Only `ui/src/ipc/` imports those files or `@tauri-apps/*`;
  the rest of the UI imports types from `ui/src/ipc/types.ts` and calls the typed
  wrappers in `commands.ts` and `events.ts`. Command names in `generate_handler!` and
  event names (a `pub const` per event, such as `COUNTER_CHANGED`) match what
  `commands.ts` invokes and `events.ts` listens to.
- The screen uses only the primitives and `var(--…)` tokens in `ui/src/design/`, never
  a raw color, a `font-family`, or a pixel font size; every string comes from
  `ui/src/copy/`; every control has an accessible name.
- Tauri's security posture is deliberate: a restrictive CSP in `tauri.conf.json`,
  `withGlobalTauri: false`, and one capability granting only `core:default`. The app
  commands need no capability entry; a plugin does, and adding one is an ADR decision.
- Four things are contract rather than private — core's public API, the bundle
  identifier, the command line (subcommands, flags, output streams, and exit codes:
  0 success, 1 a runtime error, 2 a usage error), and on-disk file formats
  (`counter.json` carries a format version) — and each changes only as
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
| `writing-repo-scripts` | A `cargo xtask` task or a skill's bundled script, and its test |
| `starting-an-app` | Turning the template into a new app: bootstrap, design system first, app shape |
| `writing-rust` | Rust in `crates/*`: ownership, errors, clap and ratatui idioms, compiler messages, clippy |
| `tdd` | Red-green-refactor with `just test-fast` |
| `writing-tests` | The body of one Rust test: oracles, fakes, contracts, clocks, the built binary, `TestBackend` |
| `placing-tests` | Where a new test goes and which floor measures it |
| `designing-core-logic` | Shaping logic in `myapp-core`: ports, `Tuning`, transitions, views, a TUI screen's state |
| `designing-clis` | A subcommand, its flags and output: stdout and stderr, exit codes, `wording.rs`, `--json`, configuration |
| `building-tuis` | The `myapp tui` screen: model and update in core, the loop and view in `crates/myapp/src/tui/`, `TestBackend` |
| `designing-errors` | Error enums, wording and exit codes in the binary, adapter mapping, `ERR_*` script codes |
| `integrating-system-apis` | Calling macOS and Linux from `myapp-platform`: `cfg`, commands, `objc2`, TCC |
| `running-the-app` | Seeing a change work: `cargo run -p myapp`, `just test-platform`, and `just logs`; `myapp tui` only when the human asks |

### Rules

The files under `.claude/rules/` load by path: each applies while you touch a file
matching its `paths:` globs. They are Claude Code-only and are not mirrored; under
Codex CLI, read the one that matches the file you are changing.

| Rule | Loads when you touch |
|---|---|
| `.claude/rules/rust.md` | `crates/**/*.rs`, `src-tauri/**/*.rs` |
| `.claude/rules/testing.md` | Rust tests (`crates/*/tests/**`, `src-tauri/tests/**`, `crates/myapp-test-support/**`) |
| `.claude/rules/project.md` | manifests, lockfiles, and gate configs: `Cargo.toml` files, `Cargo.lock`, `mise.toml`, `rust-toolchain.toml`, `deny.toml`, `clippy.toml` files, `rustfmt.toml`, `lefthook.yml`, `typos.toml`, `osv-scanner.toml`, `.github/dependabot.yml`, `.github/renovate.json` |
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

- Touching `src-tauri/Entitlements.plist`, the signing settings in `tauri.conf.json`'s
  `bundle.macOS` (`signingIdentity`, `hardenedRuntime`, `entitlements`), or any signing,
  notarization, or release secret (the `APPLE_*` variables).
- Relaxing the app's security posture: the CSP or `withGlobalTauri` in
  `tauri.conf.json`, or a permission added under `src-tauri/capabilities/`.
- Creating or pushing a release tag.
- Editing a personal permission file — `.claude/settings.local.json`,
  `~/.claude/settings.json`, or Codex rules under `.codex/` or `~/.codex/rules/` —
  unless the owner asks for it in that session: it decides what an agent may run, so
  changing it changes the agent's own limits, and no review ever sees it.
- Adding a new crate or npm package — see the dependency policy in
  `.claude/rules/project.md`.
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
pre-commit hook, a PostToolUse hook an agent registers, and any step an agent runs to
verify its own work — may show a window, take keyboard focus, move the pointer, add a
Dock icon, or raise a permission, Keychain, or Gatekeeper prompt.

- For evidence that a change works, use `just test-platform` and `just logs`. Never launch
  the app with `open`.
- `just test-local`, `just logs-follow`, and `just install-cli` are started by a human on
  purpose.
- A test that needs a GUI session, a TCC grant, or the Keychain is
  `#[ignore = "local machine: <what it needs>"]` and runs only in `just test-local`.
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
- The `release-tags` ruleset, applied by the same `just ruleset` from
  `.github/rulesets/release-tags.json`: only a repository admin may create, move, or
  delete a `v*` tag, so it keeps its admin bypass.
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

Repository automation is Rust tasks in the `xtask/` crate, run as `cargo xtask <task>`.
A task is a function of a faked context (`xtask/src/context.rs`'s `Context`: argv, env, root, a
`run` function for child processes, a logger, stdin); spawned git gets `git_env` or, for
the staged guard and the skills mirror's `--staged`, `staged_guard_env`
(`xtask/src/git_env.rs`); a failure is a `ScriptError` (`xtask/src/fail.rs`) printed as
the `ERR_<STAGE>_<WHAT>` report below; a task whose job is a GitHub write
(`sync-labels`, `apply-ruleset`) may also depend on `gh`, which like `git` is assumed on
PATH rather than pinned by mise; its tests sit in a `#[cfg(test)] mod tests`
beside it (end-to-end runs of the binary in `xtask/tests/`), in a temporary directory or
a throwaway repository, never the real checkout. `just test-xtask` (part of `just check`
and CI's `Repo Lint & Harness` job) holds `xtask` and `xtask-guard` together to lines 85
and functions 90, and the guard's rules in `xtask/guard/` alone to lines 90 and
functions 100. The harness checks (`cargo xtask check-harness`, one module per claim
under `xtask/src/check_harness/`) read YAML through `yaml-rust2` and TOML through `toml`,
never a regex, and take `--root` so a test can point one at a fixture tree per failure
mode (`xtask/tests/fixtures/`).

A skill's bundled scripts (Python and shell, under `.agents/skills/<skill>/scripts/`)
keep the same contract, whoever writes them. The reasons behind it, with worked
examples, are in the `writing-repo-scripts` skill:

- Pinned tools are called by bare name; the caller provides PATH (`mise exec -- …`
  locally, `jdx/mise-action` in CI). `python3` and `gh`, like `git`, are assumed on PATH
  rather than pinned by mise; a script's tests stub `gh` out, so `just check` never needs
  the real binary.
- Real parsers for structured files (`tomllib`, `json`), never a regex over YAML or TOML.
- Spawned git gets an environment with every `GIT_*` variable stripped, as
  `xtask/src/git_env.rs`'s `git_env` does: inside a hook, git's exported variables
  would point a child git at the hook's repository.
- Failure contract: the first stderr line is `ERR_<STAGE>_<WHAT>: <what failed>`, then
  `Expected:`, `Actual:`, and `Next:` lines (the next safe command); exit 1 (a Claude
  Code hook exits 2, the code that feeds stderr back to the agent). List the codes in
  the script's header comment. Never print a secret value.
- Never assume the checkout is the only repository on the machine. A script that
  enumerates or rewrites tracked files refuses to run outside a git work tree; a check
  that is meaningless outside one skips with a one-line notice instead. Each script's
  header states which it does.
- Every script has tests under its skill's `scripts/tests/`, run by `just test-scripts`
  (part of `just check` and CI's `Repo Lint & Harness` job) with no coverage floor, with
  shellcheck over its shell scripts. A test works in a temp directory or a throwaway
  repository, never the real checkout, and shares no state with any other test.

## Enforcement layers

The rules in this file are enforced by these layers, from mechanical to procedural:

| Layer | Fires on | Applies to | Holds |
|---|---|---|---|
| lefthook's pre-commit hook (`lefthook.yml`) | `git commit` | anyone who ran `just install` | check-only and fast, on the staged files: `rustfmt --check`, `typos`, and the staged guard. No clippy or test step — `just check` and CI run those (`cargo xtask` compiles the xtask crate on its first run and after `xtask/` changes, into `target/xtask`, so a commit never waits on a workspace build's lock). On the commit that concludes a conflicted merge, or one made at a rebase stop, the two style jobs skip (CI reruns them over the whole tree) and the staged guard and the skills mirror still run |
| `cargo xtask check-staged` (the hook's staged guard, `xtask/src/check_staged.rs`; rules in `xtask/guard/`) | `git commit`, whatever is staged, including the commit that concludes a conflicted merge | anyone who ran `just install` | no secret-shaped path (`.env*`, `.envrc.*`, `secrets/`, signing material, SSH keys, `.claude/settings.local.json`) or credential-shaped content (private-key header, GitHub token, AWS keys, Anthropic or OpenAI API key, Slack token, Google API key, Stripe live key, and the rest `credentials.rs` lists) lands in a commit; judged from the index, so a partly staged file is judged as committed; staged deletions are never inspected |
| `cargo xtask verify-hooks` (`just install`'s last step, `just check`'s first) | `just install`, `just verify-hooks`, and `just check` | anyone who runs one | lefthook's pre-commit hook is installed in this checkout — skips under CI or the `ALLOW_MISSING_GIT_HOOKS` opt-out |
| The core boundary: core's `Cargo.toml`, `deny.toml`'s `[bans]` `wrappers`, and the dependency-closure harness check | compile, `just deny`, `just check-harness`, and CI's `Rust Core` and `Repo Lint & Harness` jobs | every author | core cannot name tauri, an OS binding crate, or `myapp-platform`; only `myapp` depends on `myapp-platform`; `myapp-test-support` is dev-only — three mechanisms, so removing one leaves the others |
| `crates/myapp-core/clippy.toml`, core's `#![deny(clippy::wildcard_enum_match_arm)]`, `cargo xtask clippy-guard` (every clippy run in `just lint` and CI goes through it), and `cargo xtask check-harness`'s `clippy-allow-invalid` check | `just lint`, `just check`, and CI's clippy steps; the check in `just check-harness` and CI's `Repo Lint & Harness` job | every author | in core, none of the calls `clippy.toml` lists: the print macros and standard streams, `std::fs`'s types and free functions, `Path`'s file-system queries, `std::os::unix::fs`'s `symlink`, `chown`, `fchown`, `lchown`, and `chroot`, `std::net`'s and `std::os::unix::net`'s sockets and address lookups, clock reads (`now`, `elapsed`), `std::env`'s argument, variable, and directory functions, `Command`, `exit`, `abort`, the process and parent-process ids, `thread::available_parallelism`, `thread::spawn`, `thread::Builder::spawn`, `thread::sleep`, or `thread::park_timeout` (`thread::scope` is allowed, since it cannot outlive the call); every `match` on a core enum is exhaustive; and every `path` in a `clippy.toml` names an item clippy resolves on that job's target — clippy only warns about one that does not, and `-D warnings` lets that pass, so the guard fails with `ERR_CLIPPY_BAN_UNRESOLVED` instead of letting the ban silently do nothing, and with `ERR_CLIPPY_CONFIG_INVALID` on any other diagnostic in a `clippy.toml` (a deprecated or unknown key); and no `clippy.toml` sets `allow-invalid`, which would hide that warning from the guard, so the check fails with `ERR_CHECK_CLIPPY_ALLOW_INVALID` apart from its human-approved exception list (empty) |
| `[workspace.lints]` in `Cargo.toml` | `just lint` and CI (`-D warnings`) | every author | `unsafe_code = "forbid"` in every crate; clippy `all` and `pedantic`; `unwrap_used`/`expect_used` outside tests; `missing_docs` on public items |
| Coverage floors | `just test-core`, `just test-xtask`, `just check`, and CI | every author | `myapp-core` lines 80 / functions 80; `xtask` with `xtask-guard` 85 / 90; `xtask/guard/` 90 / 100 |
| The skills-mirror check (`just agents-check`; the hook runs `cargo xtask sync-agents --check --staged`) | `git commit` when a skill path is staged, and CI's `Repo Lint & Harness` job | every author | `.agents/skills/` and `.claude/skills/` stay byte-identical — at commit time as staged in the index, so a source staged without its synced mirror is refused |
| `cargo xtask check-harness` (`xtask/src/check_harness/`; `just check-harness`, part of `just check`) | `just check-harness`, `just check`, and CI's `Repo Lint & Harness` job | every author | the harness's claims about itself stay true — this file exists, and every `just <recipe>` it, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, the pull request template, `.claude/rules/`, `.claude/agents/`, `docs/` (apart from the template's own design record, the roadmap, and the ADRs), the skills, and the issue forms name exists; workflow hygiene, in the workflows and the repository's composite actions (SHA pins with a `# vX.Y.Z` comment, `timeout-minutes`, least-privilege `permissions`, `persist-credentials: false`, `concurrency` — top-level or per job — that never cancels a `main` run, no `pull_request_target`, no `continue-on-error`, `set +e`, or `|| true`-style fallback, `--locked` on every lockfile-resolving cargo command and no `npm install` there and in every justfile recipe); no job holding a write scope or `id-token: write`, its own or inherited from the workflow's `permissions`, checks out the repository, runs `jdx/mise-action` or a local action, calls a remote reusable workflow, or runs `cargo` or `just`, apart from a reasoned exception list; the Dependabot and Renovate cooldowns agree; the bundle identifier is one value in `myapp-platform`'s `BUNDLE_IDENTIFIER` and the justfile's `bundle_id`; no `clippy.toml` sets `allow-invalid` (the clippy row above); `osv-scanner.toml`'s GHSA ignores and Dependency Review's `allow-ghsas` list the same advisories; every required context in `.github/rulesets/main.json` names a job that runs on every pull request (no paths filter, no branch filter excluding a branch the ruleset gates — the default branch, read from `ci.yml`'s push branches or `origin/HEAD` only where a required job filters branches, or every branch under `~ALL` — default activity types, no `if:` that can be false); `just check` matches the steps CI runs unconditionally (no `if:`, `continue-on-error`, or `||` fallback) apart from a reasoned exception list; skills' frontmatter, size, and the Skills table; every applied label is declared once, and every label `.github/workflows/pr-label.yml`'s `TYPE_LABELS` map applies has a release-notes category and every PR-title type a key there; typos' ignore list excludes `.claude/skills/` and not `.agents/skills/`; the core boundary lists agree and `myapp-test-support` is dev-only; no reference to this repository's issues or pull requests (`#` and digits, bare or after this repository's owner/repo — an upstream `owner/repo#N`, like its URL, is a source — an issue or pull-request URL on this repository or relative to it, the word issue, PR, pull request, or merge request before a number, `GH-` and digits, a `gh issue`/`gh pr` command given a number) in this file, `CLAUDE.md`, `.claude/rules/`, `.claude/agents/`, `docs/` (apart from the template's own design record, the roadmap, and the ADRs), a skill, or an issue form; a committed `.claude/settings.json`, if one is added, names only recipes the justfile defines, and its `allow` admits none of the recipes that need a human or write beyond the working tree (`test-local`, `logs-follow`, `install-cli`, `install`, `labels`, `ruleset`, `bootstrap`); and the `## Product` section stays a `TODO:` skeleton in the template and holds no `TODO:` once `cargo xtask bootstrap` has run |
| CI (`.github/workflows/ci.yml` and the security workflows) | push to `main` and every pull request | everyone | the full gate: `Rust Core` (fmt, workspace clippy, core tests with floors, doctests, `just test-platform`, `cargo deny`, `cargo shear`), `Repo Lint & Harness` (typos, actionlint, the skills mirror, skill script tests, xtask tests with floors, harness checks), `macOS` (workspace clippy, `just test-platform`), `Template Bootstrap Smoke` (the bootstrap run on a throwaway copy, then `just check` there), `Workflow Security Lint` (zizmor), plus Dependency Review, the PR-title check, CodeQL, OSV-Scanner, Scorecard, and a weekly gitleaks scan |
| This file | read at session start | every agent | everything else — the reasons behind the rules above |

These gaps are deliberate. Closing one means adding a mechanism that enforces it —
a hook, a harness check, or a CI job — and then updating its row in the table above and
removing or narrowing its bullet here:

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
  Nothing in this repository blocks these for every author: a personal permission
  file's `deny` list can refuse the usual spellings on one host, and only as written,
  and `cargo xtask verify-hooks` sees only that the hook file is lefthook's, not that
  its binary resolves or that no variable disables it. "Never bypass the hooks"
  therefore still holds as an instruction, and CI is the backstop — except for the
  staged guard, which no CI job reruns over a pull request's diff: GitHub push
  protection and secret scanning are the server-side layer for secrets, and
  `.github/workflows/security-audit.yml` runs gitleaks over the full history weekly, so
  a secret that slipped past both is found after the fact rather than never.
- **Hooks are absent on a bare clone until `just install` runs**, because
  `lefthook install` is part of that recipe. `cargo xtask verify-hooks` narrows this: it
  fails loudly at `just install` and `just check` time when the hook is missing, so a
  clone whose hook silently failed to install no longer looks identical to one that
  succeeded. It does not close the gap — a contributor who runs neither still commits
  without hooks — so CI stays the backstop. `ALLOW_MISSING_GIT_HOOKS=1` opts out for an
  environment that genuinely cannot have git hooks; every failure names it.
- **Whether `main`'s ruleset is actually in force is invisible from the checkout.**
  The intended ruleset — PR required, checks green, no force-push or deletion — is
  defined as code in `.github/rulesets/main.json`; `just ruleset`
  (`cargo xtask apply-ruleset`) creates or updates it, with `release-tags.json`, via the GitHub API for whoever runs
  it as a repository admin. Nothing in the checkout verifies that it was applied —
  that is visible only via `gh api repos/{owner}/{repo}/rulesets`. "Use this template"
  does not copy rulesets, so every repository created from this template still needs
  its own admin to run `just ruleset` once.
- **This repository ships no Claude Code permission list.** There is no committed
  `.claude/settings.json`: which commands run without a prompt is each person's own
  choice, in their user-level `~/.claude/settings.json` (generic rules: git, `gh`, the
  hook-bypass and force-push denies) or the gitignored `.claude/settings.local.json`
  (this repository's rules: its `just` recipes, dependency changes), and for Codex CLI
  in a gitignored `.codex/rules/local.rules`. That choice shapes where a human is
  consulted rather than what is possible. A personal file should keep at `ask` the
  recipes that need a human or write outside the checkout (`test-local`, `logs-follow`,
  `install-cli`) and those that write to GitHub or rewrite the repository
  (`bootstrap`, `labels`, `ruleset`). The same file is where to register
  `cargo xtask format-edited-file` (`xtask/src/format_edited_file.rs`) as a
  `PostToolUse` hook on `Edit|Write|MultiEdit`
  (`cd "$CLAUDE_PROJECT_DIR" && CARGO_TARGET_DIR=target/xtask mise exec -- cargo xtask format-edited-file`;
  the separate target directory keeps every edit from waiting on the lock of a workspace
  build, such as a `just check` running meanwhile, and `.cargo/config.toml` says why the
  alias cannot carry it), which formats the one `.rs` file an edit touched inside the
  checkout (rustfmt, fed on stdin so it never rewrites a `mod` child) and reports a
  formatter failure back to the agent (exit 2) — a convenience on that host, not a gate.
  No other file type is formatted: JSON, YAML, and Markdown have no formatter here.
  Codex CLI, another agent, and a human at a shell are bound by the instructions in this
  file and by the gates above.
- **Nothing runs the `#[ignore]`d tests for you.** A CI runner has no logged-in GUI
  session and cannot be granted a TCC permission or reach a login Keychain, so a test
  that needs one is `#[ignore = "local machine: …"]` and is reported as ignored by
  `just test-platform` and in CI. That is deliberate — an ignored test is visible where a
  missing one is not — and it leaves the run itself procedural: a change to such an
  adapter is expected to come with `just test-local` output in the PR, which a human
  runs, and review is what notices when it does not.
- **Nothing mechanical keeps a routine check from taking over the Mac.** The rule in
  "Never taking over the developer's Mac" holds because every recipe in `just check`
  was written to it; whether an agent may start a window-opening recipe without a
  prompt is decided in each person's own permission file, which no gate here reads. A
  new recipe or test that shows a window, takes focus, or raises a prompt is caught
  only by review.

## Review Checklist

Before submitting a PR:

1. `just check` passes (every step of the justfile's `check` recipe)
2. New public items have `///` doc comments explaining *why* (`missing_docs` warns on
   any that lack one)
3. Tests cover the new behavior (happy path AND error path); a change to an adapter
   with an `#[ignore]`d test also carries `just test-local` output, since no gate runs
   it
4. No new crate or npm package without justification and a human's sign-off (see
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
  checks, lint, typos, the skills mirror, the staged guard); a judgement call — a
  relaxed config, a deleted workflow, a lowered threshold — is weighed in PR review,
  not blocked by the hook. `changing-gates` records why
