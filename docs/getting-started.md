# Getting Started

## Prerequisites

- A Mac with Apple Silicon, or Linux.
- On a Mac, the Xcode Command Line Tools (`xcode-select --install`); the full Xcode app
  is not needed. On Linux, a C toolchain for the linker (`build-essential` on Debian and
  Ubuntu), and `pkg-config` and `libssl-dev` for the OpenSSL headers the `openrouter`
  feature's TLS links against: `just lint`, `just test-core`, and `just test-platform`
  build with every feature on.
- [rustup](https://rustup.rs/), [mise](https://mise.jdx.dev/), and
  [Just](https://just.systems/man/en/) (`brew install mise just`). mise must be at least
  the release `mise.toml`'s `min_version` names, the one CI pins; an older mise refuses
  the file, and `mise self-update` (or `brew upgrade mise`) fixes that.

[CONTRIBUTING.md](../CONTRIBUTING.md) lists what each one provides.

## Setup

```bash
mise trust     # approve this repository's mise.toml (asked once per clone)
just install
```

Without trust, mise prompts, skips the config, or fails when it cannot prompt, so a fresh
clone runs `mise trust` first (<https://mise.jdx.dev/cli/trust.html>, checked
2026-09-28).
`just install` then:

1. on a Mac, checks for the Xcode Command Line Tools and, if they are missing, stops
   with the command to run (it never starts an installer);
2. runs `mise install` for the pinned tools;
3. installs lefthook's pre-commit hook, and fails if it is not in place.

The first `cargo` command installs the Rust toolchain `rust-toolchain.toml` pins.

## Cloud sessions

A Claude Code cloud session (claude.ai/code) runs on an Ubuntu VM that starts without
`just`, `mise`, or lefthook, and its environment carries `CLAUDE_CODE_REMOTE=true`
([cloud environments](https://code.claude.com/docs/en/cloud-environments), checked
2026-10-07). Two files under `.claude/cloud/` provision it instead of `just install`:

- `environment-setup.sh` is the cloud environment's setup script, pasted as-is into the
  environment's settings on claude.ai/code. It installs a checksum-verified mise and
  rustup, puts mise's shims and `~/.cargo/bin` on `PATH`, and runs each cloned
  repository's `.claude/cloud/provision.sh setup` within its time budget. It names no
  repository, so every repository cut from the template shares one environment.
- `provision.sh` provisions this checkout. `setup` installs the Debian packages
  `apt-packages.txt` lists, runs `mise install --locked` against `mise.lock`, installs
  the `rust-toolchain.toml` toolchain, fetches the crates, installs lefthook's hook, and
  pre-builds `target/xtask` and then the workspace. `session`, run at the start of a
  session, does the same install only when a pin file changed since the last run or
  `just` is missing, always reinstalls the hook, and starts the warm build in the
  background while `target/xtask` is cold. Outside a cloud session it only says whether the hook is
  missing, and `just install` stays the local path. Every mode exits 0; a step that
  failed prints a `WARN(provision)` line.

The committed `.claude/settings.json` registers `provision.sh session` as the
`SessionStart` hook, with the permission list a cloud session runs under: it reads no
personal settings file. In a multi-repo session or a project thread, where that hook
does not run, start the session mode by hand first:

```bash
bash .claude/cloud/provision.sh session
```

A foreground command in a cloud session has a time limit
([time limits](https://code.claude.com/docs/en/cloud-environments#time-limits), checked
2026-10-07), and a cold `just check` builds the workspace several ways, so run it recipe
by recipe there (`just lint`, `just test-core`, `just test-xtask`, `just test-platform`,
`just check-harness`) rather than as one command.

No human is at the VM. A step that needs one (`just test-local`, `just logs-follow`,
`just install-cli`, a `myapp tui` run) is never run in a cloud session, even when asked:
the agent leaves it unrun and names it in the pull request as needing a local run.

## Everyday commands

```bash
just check       # the full local gate, in CI's order; takes over no terminal
just test        # core and xtask, with their coverage floors
just test-fast increment   # one core test or a group of them
just lint        # rustfmt, clippy -D warnings
just fmt         # format everything
```

## Seeing the app

`just check` never runs the tool interactively. To read what it logged:

```bash
just logs        # the newest log file's last lines
```

On macOS the tool keeps its data in
`~/Library/Application Support/com.example.myapp/counter.json` and its logs in
`~/Library/Logs/com.example.myapp/`; on Linux, in `$XDG_DATA_HOME/myapp/counter.json`
(default `~/.local/share/myapp/`) and `$XDG_STATE_HOME/myapp/logs/` (default
`~/.local/state/myapp/logs/`). Deleting `counter.json` starts the counter over.

The `myapp` binary reads and writes that file:

```bash
cargo run --locked -p myapp -- counter show
cargo run --locked -p myapp -- counter increment
cargo run --locked -p myapp -- tui   # full screen: +/Up, -/Down, r to reset, q to quit
```

`tui` takes over the terminal you run it from until you quit, and restores it on the
way out. It is yours to run: no check and no agent starts it.

To run `myapp` from any directory, `just install-cli` installs it into `~/.cargo/bin`
(`cargo install --locked --path crates/myapp`). It writes outside the checkout, so it is
a human's recipe that no check and no agent runs unasked. There is no other
distribution: no release artifacts, no installer.

## Permissions (TCC)

The sample asks for no privacy permission. When an app cut from the template does on
macOS — Accessibility, Full Disk Access, and the like — `just test-local` runs the
`#[ignore]`d tests that need a logged-in session, a TCC grant, or the Keychain. You
start it; nothing else does. macOS grants such a permission to the program that asks,
so how a tool installed with `cargo install` keeps its grant across rebuilds is a
decision that app writes into its design description.

## Removing the example code

The counter is an illustration to replace, not something an app must keep. The
`starting-an-app` skill walks through this with the first decisions to record; the
checklist below is every file that holds the sample. Work through it after the
bootstrap has run (the paths then carry your app's name), in the pull request that adds
your first real core module, so the coverage floor always has code to measure.

**Core** (`crates/myapp-core`):

- [ ] `src/counter/` (`Counter`, `CounterService`, `CounterView`, `CounterError`,
      `StoredCounter`, `StorageError`, `Tuning`, the `CounterStore` port, and the
      screen in `screen.rs`: `CounterScreen`, `ScreenAction`, `ScreenKey`) and its
      `pub mod` and re-exports in `src/lib.rs` — replace with your domain model, ports,
      and screen
- [ ] `tests/counter_service.rs`, `tests/counter_screen.rs`, the counter-store test in
      `tests/contracts.rs`, and the counter shapes in `tests/serialization.rs` —
      replace with tests for your core
- [ ] Keep `src/time.rs` (`Clock`) unless your app has no use for it: it is general, not
      counter-specific

**Adapters and fakes**:

- [ ] `crates/myapp-platform/src/counter_store.rs` (`JsonFileCounterStore`), its `mod`
      and re-export in `src/lib.rs`, `COUNTER_FILE_NAME` and `counter_file` in
      `src/paths.rs` (drop only the `counter_file` assertion from
      `macos_selects_the_macos_directories`, which also covers the data and log
      directories), `tests/json_file_counter_store.rs`, and the counter-store test in
      `tests/contracts.rs`
- [ ] `crates/myapp-test-support/src/counter_store.rs` (`InMemoryCounterStore`,
      `FailingCounterStore`, `counter_store_contract`) and its `mod` and re-export in
      `src/lib.rs`

**The binary** (`crates/myapp`):

- [ ] `src/main.rs` — the `counter` subcommand and its handler (keep `--help`,
      `--version`, `compose`, and the exit-code convention), its wording in
      `src/wording.rs`, and its tests in `tests/cli.rs`
- [ ] `src/tui/` — the counter view in `view.rs` and the counter wiring in `mod.rs`;
      keep the terminal's enter, leave, and panic-hook code for your own screen, or
      remove the `tui` subcommand if your tool has none

**Documents and agent guidance**:

- [ ] `README.md` — the introduction's counter sentence and the
      `just test-fast increment` example
- [ ] `AGENTS.md` — the `just test-fast increment` example
- [ ] `CONTRIBUTING.md`, the `justfile`'s `test-fast` comment, and this page — the
      `just test-fast increment` examples, "Seeing the app"'s `counter.json` and `myapp`
      commands, and this checklist
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` — the counter in the example title
- [ ] The skills under `.claude/skills/` that give the counter as an example —
      among them `integrating-system-apis`' `references/file-formats.md`, whose
      `counter.json` section becomes your own file's (the `starting-an-app` skill)

Then run `just check`, and this search, which should print nothing:

```bash
git grep -nIiE 'counter|test-fast increment' -- . \
  ':(exclude,glob).claude/skills/*/scripts/**' ':(exclude)CHANGELOG.md'
```

It uses `git grep`, which needs nothing beyond the prerequisites. The exclusions are
words that are not the sample: a skill's bundled scripts and `CHANGELOG.md`, where the
entry recording the sample's removal names it on purpose. The harness checks under
`xtask/` name no counter, so the search reads them too.
