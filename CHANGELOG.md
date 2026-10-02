# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The template: a Tauri v2 macOS app with a Rust core, a React UI, CI, and agent tooling.
- Documentation: the README's design rationale, contributing and security policies, a
  code of conduct, architecture, distribution and signing, and getting-started guides, an
  empty architecture-decision index with its template, a roadmap skeleton, issue forms,
  and a pull request template.
- `just verify-bootstrap` runs `cargo xtask verify-bootstrap` locally, so a placeholder
  spelling or template-only text the bootstrap would leave behind fails before the push
  rather than in CI's Template Bootstrap Smoke job. `AGENTS.md` › Validating a change
  names it for a new file or placeholder spelling. The recipe and that row are
  template-only: the bootstrap removes both.
- `myapp tui` opens a full-screen counter view built on ratatui: the value, `+`/Up,
  `-`/Down, and `r` to increment, decrement, and reset, `q`/Esc/Ctrl+C to quit, and an
  error line when an action fails. It needs an interactive terminal (exit 1 otherwise),
  logs only to the file while it runs, and restores the terminal on exit, on an error,
  and on a panic.
- `just install-cli` installs the `myapp` binary into `~/.cargo/bin`
  (`cargo install --locked --path crates/myapp`). It writes outside the checkout, so it
  is a human's recipe, kept out of any committed allow list like `just install`.
- Linux support: on Linux `myapp` keeps its data in `$XDG_DATA_HOME/myapp` (default
  `~/.local/share/myapp`) and its logs in `$XDG_STATE_HOME/myapp/logs` (default
  `~/.local/state/myapp/logs`), following the XDG Base Directory Specification; macOS
  keeps `~/Library/Application Support` and `~/Library/Logs`. `just logs` reads the
  right directory on each system, and CI runs the platform tests on Linux as well.
- Two skills for the command-line stack: `designing-clis` (a subcommand's clap
  declaration and thin handler, stdout for data and stderr for diagnostics, exit codes,
  the wording module, a `--json` form, configuration and environment precedence, and
  testing the built binary against a temporary `HOME`) and `building-tuis` (a screen's
  model and update in core, the loop and view in `crates/myapp/src/tui/`, restoring the
  terminal on every way out, `TestBackend` tests, and never taking over the developer's
  terminal). `AGENTS.md`'s Skills table lists both.

### Changed

- CodeQL also analyzes `python`, covering the skills' bundled scripts (the
  `shipping-issues` and `merging-dependency-prs` scripts call `gh` and parse pull-request
  text); it analyzed them as TypeScript before the Node toolchain was removed.

- `just test-macos` is renamed `just test-platform`: it runs the platform adapters and
  the CLI against the real OS, in CI's `Rust Core` (Linux) and `macOS` jobs.
- The command-line tool is the app: `crates/myapp-cli` becomes `crates/myapp`, building
  the `myapp` binary (`myapp counter show`, `myapp counter increment`). Its contract is
  tested against the built binary: data on stdout, diagnostics on stderr; exit 0 on
  success, 1 on a runtime error, 2 on a usage error; `myapp --version` prints the
  workspace version. Every stderr sentence, including the wording for each core error
  code, lives in `crates/myapp/src/wording.rs`. It logs to
  `~/Library/Logs/com.example.myapp/myapp.YYYY-MM-DD.log`, where `just logs` looks,
  instead of the old `cli/myapp-cli.*.log`; `myapp-platform` no longer exports
  `cli_log_dir` or `CLI_LOG_DIR_NAME`.

- Repository automation starts moving to Rust: a `cargo xtask` crate (`xtask/`, with
  the staged guard's rules in `xtask/guard/`) and a `.cargo/config.toml` alias replace
  `scripts/check-staged.ts`, `verify-hooks.ts`, `format-edited-file.ts`,
  `clippy-guard.ts`, `sync-agents.ts`, and `prune-temp.ts`, keeping their behaviour and
  `ERR_*` codes. `lefthook.yml`, the justfile, and CI call `cargo xtask`; the new
  `just test-xtask` (part of `just test` and `just check`) holds xtask to lines 85 /
  functions 90 and the guard's rules to lines 90 / functions 100. A personal
  `PostToolUse` format hook now runs
  `cd "$CLAUDE_PROJECT_DIR" && mise exec -- cargo xtask format-edited-file`. The `regex`
  crate is added for the guard's credential patterns.
- The harness checks move to Rust: `just check-harness` (and so CI's `Repo Lint &
  Harness` job and the Template Bootstrap Smoke) runs `cargo xtask check-harness
  [--root DIR] [--check NAME]`, one module per check under `xtask/src/check_harness/`,
  keeping each check's name and `ERR_CHECK_*` codes; a check's own pattern that fails to
  compile reports `ERR_CHECK_PATTERN_INVALID`. YAML is read through `yaml-rust2` and TOML
  through `toml` (both added for xtask only), and the fixture trees live under
  `xtask/tests/fixtures/`. `scripts/checks/` and `scripts/check-harness.ts` are removed.
  Dropped with the move: `pnpm-pin` (Renovate's `pnpm` group still moves both pnpm
  pins together), `node-types-major` (`merging-dependency-prs` still holds a lone Node
  side), `formatter-glob`, the ESLint side of `ignore-lists-agree` (ESLint leaves with
  the Node toolchain), and `workflow-hygiene`'s Tauri build rule, whose subject is gone.
  `scripts/verify-bootstrap.ts` runs the product-section check through `cargo xtask` and
  fails with `ERR_VERIFY_BOOTSTRAP_HARNESS` when that run cannot report.
- The bootstrap and the GitHub scripts move to Rust: `just bootstrap`,
  `just verify-bootstrap`, `just labels`, and `just ruleset` run `cargo xtask bootstrap`,
  `verify-bootstrap`, `sync-labels`, and `apply-ruleset`, keeping their flags, behaviour,
  and `ERR_*` codes; `scripts/bootstrap.ts`, `verify-bootstrap.ts`, `sync-labels.ts`,
  `apply-ruleset.ts`, `label-pr.ts`, and `scripts/lib/labels.ts`, `git-env.ts`, and
  `cargo.ts` are removed with their tests. The bootstrap recognizes the template as
  `tomada1114/rust-template` (the README, `SECURITY.md`, and the issue chooser now link
  there), removes its own two xtask modules from an app, and runs Prettier only while the
  tree has a `package.json`; verify-bootstrap runs the product-section check in-process,
  so `ERR_VERIFY_BOOTSTRAP_HARNESS` is gone. `.github/workflows/pr-label.yml` labels a
  pull request from an inline `gh`/`jq` step with no checkout, so its write-scoped job no
  longer needs a write-scope exception; the labels-declared harness check reads that
  step's `TYPE_LABELS` map in place of `label-pr.ts`.
- The committed `.claude/settings.json` is removed: Claude Code permissions and the
  format-on-edit hook now live in each person's user-level `~/.claude/settings.json` or
  the gitignored `.claude/settings.local.json`, and Codex CLI's personal rules in a
  gitignored `.codex/rules/local.rules` (see `AGENTS.md`).
- `just ruleset` now creates or updates every ruleset under `.github/rulesets/`, the
  `release-tags` tag ruleset as well as `main`, each by its own name, and never deletes
  one; the setup steps in `AGENTS.md`, `README.md`, and the bootstrap's next steps name
  the tag ruleset and the manual `release` environment.

- `just prune-temp` removes stale `verify-bootstrap-*` temp directories and this
  checkout's idle Claude Code scratchpads (`--dry-run` lists them), and
  `.claude/settings.json` now allows it and `just clean` without a prompt.
- The Node runtime moves from 24 to 26: `mise.toml` pins Node 26.10.0, `package.json`'s
  `engines.node` is `>=26`, and `@types/node` follows it to `^26.6.2`. Building from the
  template now needs Node 26. Node 25 stopped bundling corepack, so pnpm now comes
  from mise (`aqua:pnpm/pnpm`, at the version `packageManager` names) instead of
  `corepack enable pnpm`; a harness check (`scripts/checks/pnpm-pin.ts`) fails with
  `ERR_CHECK_PNPM_PIN_DIVERGED` when the two pins differ, and Renovate moves them in one
  grouped pull request.
- A harness check (`scripts/checks/node-types-major.ts`, run by `just check-harness`)
  fails with `ERR_CHECK_NODE_MAJOR_DIVERGED` when the `@types/node` major resolved in
  `pnpm-lock.yaml` differs from `mise.toml`'s `node` major, so a Renovate or Dependabot
  bump can no longer move one alone; `merging-dependency-prs` moves a Node major's two
  sides together.
- A harness check (`scripts/checks/formatter-glob.ts`, run by `just check-harness`)
  fails with `ERR_CHECK_FORMATTER_GLOB_DIVERGED` when the Claude Code edit hook's
  Prettier extensions differ from `lefthook.yml`'s prettier job glob; the unit test that
  read the real checkout's `lefthook.yml` for this is gone.
- The pre-commit staged guard reads every staged blob through one `git cat-file --batch`
  instead of one `git cat-file blob` per file, so a 1,000-file merge is judged in under a
  second rather than about 20 s. The 256 MiB read cap now bounds all staged content
  together, and a missing or unreadable blob still fails with `ERR_STAGED_READ_FAILED`.
- A harness check (`scripts/checks/workflow-write-scopes.ts`, run by `just check-harness`)
  fails with `ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE` when a workflow job whose token holds a
  write scope or `id-token: write` (its own `permissions`, the workflow's, or the default
  token's) checks out the repository, runs `jdx/mise-action` or a local action, calls a
  remote reusable workflow, or runs `pnpm`, `cargo`, or `just`, so a later edit can no
  longer give release.yml's `build` job a write scope or let `publish` run repository
  code. The jobs that need both (CodeQL, Scorecard, and the PR labeller) are listed with
  their reasons, and an entry that no longer applies fails with
  `ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE`.
- A harness check (`scripts/checks/clippy-allow-invalid.ts`, run by `just check-harness`)
  fails with `ERR_CHECK_CLIPPY_ALLOW_INVALID` when any `clippy.toml` sets `allow-invalid`,
  the key that hides an unresolvable ban path from `scripts/clippy-guard.ts` and so lets
  the ban silently do nothing.
- The Vitest coverage floors count every script and UI source extension (`.mts`, `.cts`,
  `.js`, `.jsx`, `.mjs`, `.cjs` as well as `.ts`/`.tsx`), so an untested file in any of them
  shows as 0%.
- Dependency Review allows GHSA-wrw7-89jp-8q8g (`glib`, Linux-only), the advisory
  `osv-scanner.toml` already ignores, and a harness check
  (`scripts/checks/advisory-ignores-agree.ts`) fails when the two lists diverge.
  `osv-scanner.toml` drops its unused RUSTSEC-2024-0429 entry, the same advisory's alias.
- **Breaking:** `Tuning`'s fields are private. Code that built `Tuning { min, max }` must
  now call `Tuning::new(min, max)?`, which returns `TuningError::MinAboveMax` when
  `min > max`, and read the bounds through `min()` and `max()`.
- **Breaking:** `crates/myapp-core/clippy.toml` bans more of the I/O, time, environment,
  and process calls core must reach through a port or an argument, so core code that
  calls one now fails `just lint`: `std::fs::OpenOptions` and every `std::fs` free
  function, `std::net::{TcpStream, TcpListener, UdpSocket}` and
  `ToSocketAddrs::to_socket_addrs`, `SystemTime::elapsed` and `Instant::elapsed`,
  `std::io::{stdin, stdout, stderr}`, `std::env`'s `args`, `args_os`, `vars`, `vars_os`,
  `current_dir`, `set_current_dir`, `current_exe`, `home_dir`, `temp_dir`, `set_var`, and
  `remove_var`, `std::fs::DirBuilder`, `std::os::unix::fs::symlink`, `std::path::Path`'s
  file-system queries (`exists`, `try_exists`, `metadata`, `symlink_metadata`,
  `read_dir`, `read_link`, `canonicalize`, `is_file`, `is_dir`, `is_symlink`, reached
  through a `PathBuf` too), `std::thread::spawn` and `std::thread::Builder::spawn`, and
  `std::process::exit` and `abort`. `std::thread::scope` stays allowed, since it joins
  its threads before it returns and so cannot outlive the call. Move a banned call
  behind a port, or into the shell or the CLI.
- **Breaking:** `crates/myapp-core/clippy.toml` also bans `std::os::unix::fs::{chown,
  fchown, lchown, chroot}`, `std::os::unix::net::{UnixStream, UnixListener,
  UnixDatagram}`, `std::thread::park_timeout`, `std::process::id`,
  `std::os::unix::process::parent_id`, and `std::thread::available_parallelism`, so core
  code that calls one now fails `just lint`. Pass the fact in as an argument, or move the
  call behind a port.
- `vitest.config.ts` puts a coverage floor on a skill's bundled TypeScript scripts
  (`.agents/skills/*/scripts/**`, lines 85, functions 90, the same as `scripts/**`), so
  `just test-scripts` fails when one drops below it.
- `tauri.conf.json`'s `bundle.targets` is `["app"]`, so a plain `pnpm tauri build` no
  longer makes a disk image; the release workflow still builds one with
  `--bundles app,dmg`, and any other caller that wants a dmg must ask for it the same way.
- A type that crosses IPC is marked `#[cfg_attr(feature = "export-bindings", ts(export))]`:
  a bare `#[ts(export)]` now fails its `export_bindings_*` test in `just test-core`,
  because `.cargo/config.toml` no longer sets an export directory core's tests can write.
- **Breaking:** `CounterView` has a third public field, `revision` (`"revision"` in the
  `get_counter`, `increment`, `decrement`, `reset` replies and the `counter-changed`
  payload). Code that builds a `CounterView` literal or destructures one exhaustively
  must name it.
- The code-writing skills teach the CLI/TUI stack instead of the GUI one:
  `designing-errors` (wording and exit codes in the binary rather than codes for a UI),
  `designing-core-logic` (views a subcommand prints and a TUI draws, a screen's state in
  core), `placing-tests`, `writing-tests`, and `tdd` (the built binary, `TestBackend`,
  and keys as values in place of `tauri::test` and Testing Library), `running-the-app`
  (`cargo run -p myapp`, a scratch `HOME`, and `just logs`; `myapp tui` run by the
  human, never by an agent), `integrating-system-apis` (macOS and Linux adapters behind
  `cfg(target_os)`), and `writing-rust` (clap and ratatui idioms in a new reference).
- The documentation and the workflow skills describe the command-line template instead
  of the Tauri desktop app: `AGENTS.md`, `README.md` (its Design Philosophy now explains
  clap and ratatui, why no check runs the real terminal, and why there is no release
  pipeline), `CONTRIBUTING.md`, `SECURITY.md` (only the latest `main` is supported;
  there are no release artifacts), `docs/architecture.md` (no IPC or smoke-mode
  sections; the Linux data and log directories), `docs/getting-started.md`, the ADR
  index and template, `.claude/rules/`, the issue forms, the pull request template, and
  the `starting-an-app`, `changing-gates`, `managing-dependencies`,
  `merging-dependency-prs`, `recording-architecture-decisions`, `smart-commit`,
  `create-pr`, `triaging-issues`, `updating-docs`, `shipping-issues`, and
  `authoring-skills` skills. The changes that owe an ADR are now the command-line
  tool's (persistence or configuration, a target platform, distribution, replacing clap
  or ratatui, a TUI theme, among others), and an agent never runs `myapp tui`.
  `merging-dependency-prs`' `survey_prs.py` no longer detects npm pull requests or
  pairs the Tauri crates with their npm packages (`--json` prints `rows` and
  `contested` only), and the skill lands a ratatui or crossterm minor alone as a
  migration. The bug report form asks for `myapp --version` and the operating system
  instead of a `.dmg` download and a macOS version, and the `blocked: external` label's
  description no longer names a signing identity or an Apple account (`just labels`
  applies it). The template's design notes under `docs/template/` drop what they said
  about the GUI stack, and the `starting-an-app` skill's app-shapes reference is gone.

### Removed

- `myapp_core::log` (`UiLogEntry`, `UiLogLevel`): a log entry the desktop UI once sent
  to the shell, which nothing in the CLI/TUI template reads. Core's comments that still
  described the UI, IPC, and a helper CLI now describe the `myapp` binary.

- The Node toolchain: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
  `eslint.config.mjs`, every `tsconfig*.json`, `vitest.config.ts`, `.prettierrc.json`,
  `.prettierignore`, the rest of `scripts/`, the `writing-typescript` skill, and
  `.claude/rules/typescript.md`. `mise.toml` no longer pins Node or pnpm, `just install`
  no longer runs `pnpm install`, and `just fmt`, `just fix`, and `just lint` cover Rust
  only. The pre-commit hook loses its Prettier and ESLint jobs; Prettier's check over
  JSON, YAML, and Markdown is dropped rather than replaced, so no gate formats those
  files, and `cargo xtask format-edited-file` formats `.rs` files only. CodeQL analyzes
  `rust` and `actions`; npm leaves Dependabot, Renovate, OSV-Scanner, Dependency
  Review's configuration, and the cooldown agreement check. `merging-dependency-prs`'
  survey is now `survey_prs.py`, a Python script whose tests `just test-scripts` runs
  beside `shipping-issues`', with no coverage floor; the Vitest floors went with the
  TypeScript they measured.
- The GUI stack, as the template pivots to Rust command-line tools: the Tauri shell
  (`src-tauri/`, with its `tauri.conf.json`, capabilities, `Entitlements.plist`, and
  signing settings), the React screen and design system (`ui/`, `docs/design/`), the
  `.dmg` release workflow and `docs/distribution.md`, the ts-rs derives and their
  `.cargo/config.toml` settings, and the React, Vite, and `@tauri-apps/*` packages. The
  recipes `dev`, `run`, `build`, `smoke`, `sidecar`, `bindings`, `test-ui`,
  `install-app`, `reset-permissions`, and `release-prep` go with them, as do the scripts
  only they ran, the `ipc-names`, `ui-literals`, `tauri-versions`, and `version-sites`
  harness checks, and the `building-react-screens`, `designing-ui`, `designing-ipc`, and
  `releasing-the-app` skills. `just check` no longer builds or smoke-tests an app bundle.
- CI's `Frontend` job: its typecheck, ESLint, and Prettier steps now run in
  `Repo Lint & Harness`. `macOS Build & Smoke` becomes `macOS` (the workspace clippy and
  `just test-macos`), and `.github/rulesets/main.json` requires the new contexts.
- The OSV-Scanner and Dependency Review ignores for advisories only Tauri brought in
  (the five `unic-*` crates, `glib`, `proc-macro-error`), and `deny.toml`'s MPL-2.0
  exceptions for Tauri's crates; no dependency needs them any more.

### Fixed

- `just bootstrap`'s suggested slug folds Vietnamese letters and fullwidth ASCII
  ("Hội An" -> `hoi-an`, "Ｔｉｄｅ" -> `tide`), and a name with a letter it cannot
  fold suggests no slug (so `--slug` is asked for) instead of one with a gap.

- `myapp --help` opens with the tool's own one-line summary ("Read and change the
  counter") instead of the binary crate's `Cargo.toml` description.

- The `cargo xtask` hooks no longer wait on the lock of a workspace build running
  meanwhile (a cold clippy, nextest's build, a background `just check`): lefthook's
  staged guard and skills-mirror jobs build xtask into `target/xtask` with
  `CARGO_TARGET_DIR=target/xtask`, and a personal `PostToolUse` format hook should now
  run `cd "$CLAUDE_PROJECT_DIR" && CARGO_TARGET_DIR=target/xtask mise exec -- cargo xtask format-edited-file`.
  The `cargo xtask` alias itself is unchanged, so it still works from any subdirectory
  without creating a `target/` there.
- `just run` and `just install-app` find the app bundle under the target directory `cargo
  metadata` reports, through `scripts/bundle-path.ts`, so they work with `CARGO_TARGET_DIR`
  or `build.target-dir` instead of assuming `./target`; a missing bundle stops the recipe
  with `ERR_BUNDLE_MISSING`.
- A counter that cannot be loaded no longer reads as a failed save: a `storage`/`unavailable`
  error now says "The counter could not be read or saved. Try again." wherever it appears.
- The primary button keeps 3:1 contrast against the window and panel on hover and press in
  dark mode: button states now use `--color-accent-hover`/`--color-accent-active` and
  `--color-control-bg-hover`/`--color-control-bg-active` instead of a `brightness()` filter
  the contrast check could not see.
- Counter views no longer arrive out of order: the screen keeps the newest one, and
  `counter-changed` events leave in the order the changes were saved.
- A counter file this version cannot read can now be replaced with Reset from the error
  screen, and a failed load can be retried.
- A repeated identical failure on the counter's error screen (Reset failing twice the same
  way) is announced again by screen readers.
- `.gitignore` ignores Python bytecode (`__pycache__/`, `*.pyc`), and `just agents-sync` and
  `just agents-check` skip it in both skill trees, so running a skill's bundled Python tests
  directly can no longer stage bytecode into a commit.
- `just check-harness`'s UI literals check reports an unreadable directory or file under `ui/` as `ERR_CHECK_INPUT_UNREADABLE`, naming the path and its errno, instead of claiming `ui/src/` does not exist or failing with `ERR_INTERNAL_UNEXPECTED`; only a missing `ui/src/` is `ERR_CHECK_INPUT_MISSING`.
- `just check-harness`'s UI literals check no longer reports a hex-looking fragment given to `href`, `xlinkHref`, `id`, `htmlFor`, or an `aria-*` JSX attribute (`<a href="#add">`) as a raw color; the same string in a style, a `fill`, or a binding is still flagged.
- `no-issue-references` no longer reports an upstream project's `owner/repo#N` (such as
  `tauri-apps/tauri#1234`), which it now treats like the same issue's URL, as a source;
  a bare `#N` and this repository's own `owner/repo#N` are still references. It and
  `just-recipes-exist` now also read the sub-agent definitions under `.claude/agents/`
  and the issue forms and templates in `.github/ISSUE_TEMPLATE/`, from one shared list
  in `scripts/checks/shared/documents.ts`. `just-recipes-exist` reads the code spans and
  fenced blocks in each string of a YAML issue form, and fails with
  `ERR_CHECK_INPUT_UNREADABLE` on a form that is not YAML.
- An app cut from the template no longer inherits sentences about the template itself.
  `AGENTS.md`, `docs/architecture.md`, `docs/architecture/README.md`, the roadmap, and
  the `designing-core-logic`, `recording-architecture-decisions`, `steering-the-roadmap`,
  and `starting-an-app` skills now say the ADR index and the roadmap start empty and
  where the reasoning behind the starting layers lives, instead of what "the template
  ships" or "the template's own reasoning", and `scripts/checks/workflow-hygiene.ts`'s
  header no longer cites a template issue number. `scripts/verify-bootstrap.ts` now
  fails with `ERR_VERIFY_BOOTSTRAP_TEMPLATE_TEXT` on either phrase left in the generated
  app, and its closing line names every check it ran.
- The dark-mode primary button now meets 3:1 against the panel and the window: the dark
  `--color-accent` moves from `#2f6fd0` to `#3173d8`. `tokens.test.ts` derives the token
  pairs `primitives.css` combines and fails when `contrast-pairs.ts` lacks one. The
  counter's value is named after its title, a repeated identical error is announced
  again, and the panel border, focus-ring offset, and content width are tokens.
- The release workflow fails early and explicitly instead of late or silently. The
  six `APPLE_*` secrets must be all set (Developer ID signed and notarized) or all absent
  (ad hoc): a partial set, including signing without notarizing, which Gatekeeper's
  `spctl` check always rejected, now fails the release job's first step with the missing
  names instead of publishing an ad-hoc dmg. After importing the certificate the job
  checks that `security find-identity` lists `APPLE_SIGNING_IDENTITY`, and deletes the
  temporary keychain in an `if: always()` step. A new `preflight` job checks the tag
  against the version before `pnpm install` and the test job. `just smoke` and the
  release's verification compare the app's entitlements with
  `src-tauri/Entitlements.plist` value for value (parsed by `plutil`), so a value flipped
  from `<false/>` to `<true/>` no longer passes.
- `ruleset-contexts` judges workflows' `pull_request` branch filters against the branches
  the ruleset really gates instead of always against `main`. `~DEFAULT_BRANCH` is the one
  branch `.github/workflows/ci.yml`'s `on: push: branches:` names literally (patterns
  aside), which must agree with a clone's `origin/HEAD` (`ERR_CHECK_RULESET_BRANCH_MISMATCH`),
  or else `origin/HEAD` itself. The name is needed only when a required job's trigger
  filters branches; if it is unknown then, the check fails with
  `ERR_CHECK_RULESET_BRANCH_UNKNOWN` rather than guessing. `~ALL` is judged against every
  branch, and a pattern include fails with the same code. A job whose `name:` is a number
  or a boolean is matched under the text GitHub reports (`123`, `true`) rather than its
  job id, and a null or fractional one matches nothing.
- The bootstrap's printed next steps and README's setup steps now name the Renovate
  GitHub App and adding `dependencies` to Dependabot pull requests opened before
  `just labels`, and the docs, rules, and skills no longer claim what the repository does
  not do (mise installing Rust, every crate logging, CI rerunning the staged guard).
- A path in a `clippy.toml` that clippy cannot resolve (a typo, an item a Rust release
  renamed or moved, or a path missing on the build's target) now fails `just lint` and
  CI's clippy steps with `ERR_CLIPPY_BAN_UNRESOLVED`, instead of leaving a clippy warning
  that `-D warnings` let pass while the ban in core's `clippy.toml` silently did nothing.
  Any other problem clippy reports in a `clippy.toml`, such as a deprecated key it only
  warns about, fails with `ERR_CLIPPY_CONFIG_INVALID`. Clippy now runs through
  `scripts/clippy-guard.ts`; its output keeps its colour in a terminal but is printed
  once clippy finishes rather than as it runs.
- An app cut from the template no longer keeps text about the template or references
  to files the bootstrap deletes. `just test-scripts` passes before the Product section
  is filled (the harness runner's tests use a fixture instead of the checkout), and
  filling in the Product section's four bullets is all `just check-harness` asks: the
  bootstrap rewrites the section's introduction without a `TODO:` of its own, and the
  check's `Next:` line names the `starting-an-app` skill instead of README's removed
  "Using This Template". Comments no longer cite the template's design record by
  decision number, the sandbox rationale no longer describes the template's first app,
  and the bootstrap rewrites the README's first sentence, the `starting-an-app` and
  `updating-docs` skills' template passages, the checks' exclusion of the template's
  design record, and the dead `Template Bootstrap Smoke` exception.
  `scripts/verify-bootstrap.ts` fails on any such text left in the generated app and on
  a Product section that filling its bullets would not satisfy. The sample-removal
  checklist in `docs/getting-started.md` keeps `log_from_ui`'s registration and tests,
  lists every file that holds the sample, and ends with a scoped `git grep`; README's
  setup steps add `mise trust` and committing and pushing the bootstrap result.
- The helper CLI now logs to `~/Library/Logs/<bundle id>/cli/`, so the app's log
  retention no longer deletes the helper's files, each keeps its newest 14 (legacy
  helper files in the log directory age out under the app's retention), and `just logs`
  prints only the app's log.
- A Tauri minor now arrives as two small Dependabot PRs (`cargo-tauri`, `npm-tauri`)
  that `merging-dependency-prs` combines, instead of turning the whole cargo and npm
  groups red; the dependency survey marks a split Tauri pair and each 0.x-minor bump.
- The skills, `.claude/rules/rust.md`, and `docs/distribution.md` no longer give
  instructions the repository's config and code contradict. `create-pr` writes the
  pull request template's `**Release impact:** none | PATCH | MINOR | MAJOR` line,
  lists every `just check` step, and has `git status` checked after `fmt` rewrites
  files; the release pull request is opened with the filled template rather than
  `--fill`. `writing-rust` and the Rust rule say `wildcard_enum_match_arm` fires on a
  foreign enum in core too. `designing-ipc` says why a capturing closure cannot reach
  the `fn(&CounterService)` helper (E0308), and `integrating-system-apis` says
  `run_on_main_thread` runs inline on the main thread instead of deadlocking.
  `starting-an-app` documents the bootstrap's flags, defaults, validation, network
  fetch, deletions, and format passes; `updating-docs` says a template-only block
  outside `README.md` needs its file in the bootstrap's `MARKER_FILES`. Corrected too:
  `writing-typescript` on `verbatimModuleSyntax` (TS1484) and the sign-off a
  `@ts-expect-error` needs, `building-react-screens` on what the literal check reads and
  `no-misused-promises`, the join-error mapping under `panic = "abort"`, the
  design-lock's accent and `macOSPrivateApi`, `tdd`'s UI loop and gate rows, the
  commit and title length, `smart-commit`'s type for `.github/` files, which tools
  Renovate bumps, how pinned tools reach a recipe, and `changing-gates`' check for the
  scripts floors.

- ESLint refuses a static or dynamic import of `@tauri-apps/api/mocks` from production
  code inside `ui/src/ipc/`; only `ui/src/ipc/testing.ts` and tests there may import it,
  so the IPC mocks reach production code neither directly nor through `testing.ts`. The
  root `tsconfig.json` sets `erasableSyntaxOnly`, so an `enum`, `namespace`, or parameter
  property in `vite.config.ts` or `vitest.config.ts` now fails `just lint`, as it already
  did in `ui/` and `scripts/`.

- The pre-commit hook's skills-mirror check compares the staged `.agents/skills/` and
  `.claude/skills/` (`node scripts/sync-agents.ts --check --staged`), so a commit that
  stages an edited skill without its synced mirror is refused instead of passing because
  the working copies match. The agent's formatting hook now formats only the file it was
  given (rustfmt no longer rewrites that file's `mod` children) and formats every file type
  the hook's Prettier job checks, not only TypeScript. `just check-harness` now finds a
  `just <recipe>` that does not exist in `CLAUDE.md`, `.claude/rules/`, the documents in
  `docs/` subdirectories, and the pull request template, and fails when `AGENTS.md` is
  missing. It finds a reference to this repository's issues or pull requests in
  `CLAUDE.md`, `.claude/rules/`, and `docs/` too, including an issue or pull-request URL
  on this repository, the word issue or PR before a number, a `GH-` reference, and a
  `gh issue` or `gh pr` command given a number; an upstream project's issue URL still
  passes as a source. Neither check reads `docs/template/`, the roadmap, or the ADRs,
  which link issues and plan recipes by design.

- `log_from_ui` writes each UI log entry as one line: the message's control characters
  and Unicode line separators are escaped and it is cut to 1,000 characters, so a
  message holding a newline can no longer forge a log line such as the
  `startup complete pid=…` that `just smoke` looks for. The command is now async and
  writes on a blocking thread instead of the main thread.

- A `Tuning` whose `min` is above its `max` is refused, which used to leave the counter
  below its minimum. `clock_contract` no longer asserts that two reads are in order, a property
  the wall-clock `SystemClock` lacks. The command tests now assert the
  `counter-changed` events from `decrement` and `reset`, that `get_counter` emits
  nothing, and the `{ code: "storage", kind }` rejection, and core's docs carry
  doctests, so `just test-core`'s doctest step checks something.

- The app and the helper CLI can save the counter at the same moment: each save writes
  its own temporary file and holds a lock on `counter.json.lock`, and each change holds
  it from the load to the save, so no save fails, no load reads half a file, and
  neither change is lost. A save also syncs the directory after the rename.

- `just bootstrap` refuses, before it writes anything, the inputs that used to fail half
  way or produce a broken app: a slug Cargo reserves (`build`, `deps`, …) or one whose
  packages would share a dependency's name (`tauri`, `serde`, …), a work tree with
  uncommitted or untracked changes (`ERR_BOOTSTRAP_DIRTY`), a malformed or `com.apple.`
  bundle identifier, and any answer containing `myapp` or `tauri-template`. Answers pasted
  in one go are each read, `--help` before `just install` fails with
  `ERR_BOOTSTRAP_NO_DEPS`, and the usage no longer claims `just` drops a value's quotes.

- The counter screen shows "Something went wrong. Details are in the app's log." when an
  action fails without a counter error code, instead of nothing (or the earlier error).
  A rejection whose `kind` is missing or unknown is no longer taken for a `CounterError`,
  and adding a code or kind in Rust now fails `tsc` in `ui/src/ipc/errors.ts` until the
  guard checks it. A render error, an uncaught exception, an unhandled promise rejection,
  and a failure to listen for `counter-changed` now reach the app's log, each line naming
  the error's type.

- Smoke mode (`MYAPP_SMOKE=1`) sets the `Prohibited` activation policy before the app
  finishes launching instead of after it has activated, and only the value `1` enables
  it. A startup error — no `HOME`, logging, the build, or a missing `main` window — now
  exits 1 with its reason on stderr instead of aborting, and `just smoke` checks that
  case.

- ESLint and `ui/tsconfig.json` now enforce the TypeScript rules the skills document: a
  `switch` over a union with a `default` fails `switch-exhaustiveness-check`; a dynamic
  `import()` of `@tauri-apps/*` or `ui/src/ipc/generated/` outside `ui/src/ipc/`, any
  non-test import of `ui/src/ipc/testing.ts`, and `window.console` or
  `globalThis.console` outside `ui/src/ipc/log.ts` fail ESLint; and `enum`,
  `namespace`, and parameter properties fail `tsc` in `ui/src/` (`erasableSyntaxOnly`).

- The pre-commit staged guard reads a staged file larger than 1 MiB instead of refusing
  it with `ERR_STAGED_READ_FAILED`, so an icon source, a screenshot, or a large lockfile
  can be committed through the hook.

- An app cut from the template releases its own `.app` and dmg: the bootstrap now
  rewrites the release workflow's `APP_NAME`, which stayed `MyApp` and failed the first
  release with `ERR_SMOKE_APP_MISSING`. CI's Template Bootstrap Smoke runs
  `scripts/verify-bootstrap.ts`, so a placeholder the bootstrap leaves behind fails the
  pull request instead of only printing a warning.

- The workflow harness checks now fail where they passed a weakened gate:
  `workflow-hygiene` rejects `continue-on-error` on a job or step, `set +e`, and an
  `|| true`, `|| :`, `|| exit 0`, `|| echo`, or `|| printf` fallback in a `run:`; checks
  every job-level `concurrency` on a push workflow and evaluates a concurrency group for
  a push run instead of looking for `github.sha` anywhere in it; applies its step rules
  to local composite actions; and reads `pnpm --dir ui install`, `npm install`,
  `cargo install`/`check`/`doc`/`deny`/`shear`, and `tauri build`/`dev` (in workflows
  and in every justfile recipe) for the lockfile flag. `just-check-matches-ci` no longer
  counts a gate CI runs only behind `if:`, with `continue-on-error`, with an `||`
  fallback, or on a `uses:` step. CI, the release workflow, and the justfile now pass
  `--locked` to `cargo deny`, `cargo shear`, and `tauri build`/`dev`.

- The harness checks now read the configurations they judge instead of passing on ones
  they never looked at: `ruleset-contexts` fails a required context reported only by a
  job whose workflow filters `pull_request` by `paths` or `branches` (or narrows its
  activity types), or whose `if:` — or a `needs` job's — is not provably true on a pull
  request, and a job name made only of an expression no longer matches every context
  (names and conditions are evaluated for a pull request). A JSON5 Renovate config
  (`renovate.json5` and its siblings) fails `bots-agree`, `workflow-hygiene`, and
  `labels-declared` as unread instead of being skipped. `bots-agree` compares
  Dependabot's `semver-*-days` too. `labels-declared` reads `scripts/label-pr.ts`'s type
  map from the checked root and fails on a PR-title type it does not map
  (`ERR_CHECK_LABEL_TYPE_UNMAPPED`). `core-boundary` walks build-dependency edges as
  well as normal ones.

- `ruleset-contexts` matches a required context against the exact names a job reports
  instead of treating an expression in its name as a wildcard: a literal
  `strategy.matrix` is expanded as GitHub does (`include` and `exclude` too, up to its
  limit of 256 jobs), so a context such as `Analyze (python)` fails once the matrix no
  longer lists `python`. A name made only of an expression, such as `${{ matrix.os }}`,
  which used to match nothing, now matches each value of a literal matrix. A name it
  cannot know from the files — an expression that is not fixed on a pull request, a
  matrix computed at run time, a matrix job whose name has expressions but none that
  reads `matrix`, a null or mapping among the appended matrix values — matches nothing,
  and the failure names it with the edit that would make it known. A job that calls a
  reusable workflow as `./.github/workflows/<file>.yml` now reports
  `<caller> / <called job>`, up to GitHub's ten levels of workflows, and counts only when
  both jobs run on every pull request; a workflow in another repository or any other path
  form fails closed.

- `ipc-names` and `ui-literals` catch the common spellings of what they ban.
  `ipc-names` compares the calls of Tauri's `invoke`, `listen`, and `once` (found by
  their `@tauri-apps/*` import, aliases and namespace imports included) in every file
  under `ui/src/ipc/` that ships, not only `commands.ts` and `events.ts`, reads a
  path-call emit through the `Emitter` trait such as `tauri::Emitter::emit(app, "…", ())`,
  and names the file to edit on each side. `ui-literals` flags a pixel size or family
  carried by a custom property its own file declares
  (`--size: 11px; font-size: var(--size)`) or written as a `var()` fallback, CSS system
  colors (`CanvasText`, `AccentColor`, …) in color properties and WebKit's
  (`-apple-system-label`, …), a value reached through a `const` in scope or a member of
  a `const` object, a computed key, a template, a conditional, `el.style.color = …`, or
  `style.setProperty(…)`, and a `--custom` property key in TypeScript; it now reads
  `ui/index.html`, `.svg`, `.html`, `.scss`, and JavaScript files, and fails on a markup
  tag it cannot read (`ERR_CHECK_UI_UNPARSED`).

- `ui-literals` reads the spellings it used to pass unread: a value reached through a
  `const` imported from another module under `ui/` (named, default, namespace, or
  re-exported), every value a `let` or `var` is given, the `content` of
  `<meta name="theme-color">`, the body of an inline JavaScript `<script>`, every entry
  page directly under `ui/`, the stylesheets in `ui/public/`, and PostCSS's
  `.pcss`/`.postcss`. An inline script of an unknown type, with a syntax error, or with
  no `</script>` fails with `ERR_CHECK_UI_UNPARSED`, and a Less, indented Sass, Stylus,
  SugarSS, Vue, Svelte, MDX, or Astro file with the new `ERR_CHECK_UI_UNSUPPORTED_FILE`,
  instead of passing.

- `ipc-names` compares the commands and events `ui/src/ipc/` reaches Tauri with in two
  ways it used to pass unread. A call of `invoke` on `__TAURI_INTERNALS__`
  (`window.__TAURI_INTERNALS__.invoke("…")`, bare or through `globalThis`) is compared
  with `generate_handler!`, and any other use of that global in running code — an alias,
  a destructuring, a key held in a variable, another member — fails with
  `ERR_CHECK_IPC_UNPARSED`. An `invoke`, `listen`, or `once` (or a Tauri value whose
  `.listen`/`.once` is called) imported from another script under `ui/src/ipc/` that
  re-exports it — `export { … } from`, a renamed local export, `export *`,
  `export * as`, `export default`, or an exported `const` alias — is followed to its
  `@tauri-apps/*` module and compared, while a same-named helper of the app's own still
  is not.

- `just sidecar` and `just smoke` find Cargo's target directory from `cargo metadata`, so
  they work with `CARGO_TARGET_DIR` or `build.target-dir` set instead of failing with
  `ERR_SIDECAR_MISSING` or checking a stale bundle under `./target`.

- `just test-core`, `just test-fast`, and a plain `cargo test` no longer rewrite the
  tracked `ui/src/ipc/generated/`: ts-rs's export tests compile only with core's new
  `export-bindings` feature, which `just bindings` enables.

- `just bindings` (now `scripts/bindings.ts`) exports into a fresh directory and swaps it
  in for `ui/src/ipc/generated/` only once the export succeeds and wrote at least one
  file, so a failed build no longer leaves the directory empty and a removed type leaves
  no stale file.

- `@types/node` follows the Node 24 that `mise.toml` runs instead of Node 26, so the
  scripts no longer type-check against APIs their runtime lacks.

- A release's notes now start with `CHANGELOG.md`'s section for its version and, for an
  ad-hoc build, say how to open it; GitHub's list of merged pull requests follows, and a
  pull request with no category label lands under "Other Changes" instead of being
  dropped. `just release-prep 0.1.0` now prepares an app's first release: while no `v*`
  tag exists and `CHANGELOG.md` has no section for the version, the current version is
  accepted.

### Security

- The pre-commit hook no longer skips the commit that concludes a conflicted merge, or
  one made at a rebase stop: the staged guard and the skills-mirror check now judge the
  conflict resolution, so a credential-shaped line or a drifted `.claude/skills/` staged
  while resolving is refused. Only the style checks, which CI reruns, still skip those
  commits. A `reword` or a `git commit --amend` at an `edit` stop in an interactive
  rebase now runs the guard and the mirror too, over what is staged at that stop. During
  a merge the guard's advice is to remove the secret and re-stage the file, since
  `git restore --staged` would also drop the other side's change.
  `git rebase --continue`, `git am`, and a merge git concludes itself commit without the
  hook, and `AGENTS.md` lists them among the gaps.

- The staged guard catches this template's own signing secrets it used to miss: an
  `APPLE_PASSWORD`, `APPLE_CERTIFICATE_PASSWORD`, or other `*_password` assignment, a
  JSON `"password"` value, a base64 `.p12` such as `APPLE_CERTIFICATE`, a PGP private key
  block, and a Slack webhook URL. An `.npmrc` `_authToken=${NPM_TOKEN}` reference is no
  longer refused.

- `.claude/settings.json` refuses more ways to skip the pre-commit hook on Claude Code:
  `git commit --no-veri` and the other abbreviations of `--no-verify`, a `LEFTHOOK=`,
  `LEFTHOOK_EXCLUDE=`, `LEFTHOOK_BIN=`, or `LEFTHOOK_CONFIG=` assignment, and
  `core.hooksPath` set through `git -c`, `git --config-env`, or `git config`. It also
  refuses a second `-X`/`--method` after an allowed `gh api -X GET`, which sent the
  request with the second verb, and `--web`/`-w` on the allowed `gh` reads, which opened
  a browser without a prompt. A new harness check fails when `allow` admits a recipe
  that opens the app, needs a human, or writes beyond the working tree, and
  `AGENTS.md` names the hook bypasses and lefthook's fail-open hook among the gaps.

- The release workflow no longer runs dependency code while holding a write token or an
  OIDC token. A read-only `preflight` job checks that the tag names the version and sits
  on the default branch, and that the version sites agree. The build signs and verifies
  with a read-only token in a `release` environment that holds the Apple secrets. A
  separate `publish` job, which runs no cargo, pnpm, or mise, attests the verified dmg and
  creates the release. `.github/rulesets/release-tags.json` lets only a repository admin
  create, move, or delete a `v*` tag, and `docs/distribution.md` lists the one-time
  settings an admin applies.
