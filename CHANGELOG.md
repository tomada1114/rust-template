# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Optional OpenRouter text generation: build with the `openrouter` feature to use
  `myapp llm ask`, with OpenAI Luna and Max reasoning effort selected in source.
  `TextGenerator`, `GenerationService`, and `GenerationView` can be reused by CLI and
  TUI actions; keys are resolved only on a call, from `OPENROUTER_KEY` or `.env.local`.
- Bootstrap's `--env-from DIR` copies a local `.env.local` from another checkout,
  keeping existing credentials and creating new files with owner-only permissions.

- The template: a Rust CLI/TUI with a shared core, macOS and Linux adapters, CI,
  and agent tooling.

- Documentation: the README's design rationale, contributing and security policies, a
  code of conduct, architecture and getting-started guides, an
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
  text).

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
- The harness checks run in Rust: `just check-harness` and CI call
  `cargo xtask check-harness [--root DIR] [--check NAME]`, one module per check under
  `xtask/src/check_harness/`, with named errors and temporary fixture trees. YAML is
  read through `yaml-rust2`, TOML through `toml`, and JSON through `serde_json`.

- The bootstrap and GitHub automation use `cargo xtask`: `just bootstrap`,
  `just verify-bootstrap`, `just labels`, and `just ruleset` retain their flags and
  named failures. The PR labeller uses an inline `gh`/`jq` step with no checkout;
  the labels-declared harness check reads its `TYPE_LABELS` map.

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
- The pre-commit staged guard reads every staged blob through one `git cat-file --batch`
  instead of one `git cat-file blob` per file, so a 1,000-file merge is judged in under a
  second rather than about 20 s. The 256 MiB read cap now bounds all staged content
  together, and a missing or unreadable blob still fails with `ERR_STAGED_READ_FAILED`.
- The workflow-write-scopes harness check rejects a write-scoped job that checks
  out or runs repository code, including through a local action or a remote reusable
  workflow. Reasoned exceptions remain explicit and fail when stale.

- A harness check (`scripts/checks/clippy-allow-invalid.ts`, run by `just check-harness`)
  fails with `ERR_CHECK_CLIPPY_ALLOW_INVALID` when any `clippy.toml` sets `allow-invalid`,
  the key that hides an unresolvable ban path from `scripts/clippy-guard.ts` and so lets
  the ban silently do nothing.
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
- **Breaking:** `CounterView` has a third public field, `revision`. Code that builds
  a view literal or destructures one exhaustively must name it.

- The code-writing skills use core-owned views and screen state, typed errors and
  binary wording, CLI integration tests, `TestBackend`, keys as values, and macOS and
  Linux adapters behind ports. An agent verifies the app with tests, scratch command
  runs, and logs; a human runs the real terminal loop.

- The documentation and workflow skills describe the command-line contracts,
  platform data and log directories, local installation, app ADRs, and terminal
  evidence. Dependency updates cover crates, Actions, and tool pins; ratatui and
  crossterm minor migrations land on their own PRs.

### Removed

- Unused desktop front-end dependency bans and fixtures, superseded design notes,
  and obsolete GUI entries in the unreleased changelog. The finalized template design
  records the CLI/TUI stack and optional model-call feature.

### Fixed

- A bootstrapped app no longer names the template-only `verify-bootstrap` task: the
  `prune-temp` task, its recipe, and `AGENTS.md`'s Quick Reference describe the
  `verify-bootstrap-*` directories without it, and `cargo xtask verify-bootstrap` fails
  on `cargo xtask verify-bootstrap` or `just verify-bootstrap` left in the generated app.
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
- A counter that cannot be loaded no longer reads as a failed save: a `storage`/`unavailable`
  error now says "The counter could not be read or saved. Try again." wherever it appears.
- `.gitignore` ignores Python bytecode (`__pycache__/`, `*.pyc`), and `just agents-sync` and
  `just agents-check` skip it in both skill trees, so running a skill's bundled Python tests
  directly can no longer stage bytecode into a commit.
- `no-issue-references` no longer reports an upstream project's `owner/repo#N` (such as
  `serde-rs/serde#1234`), which it now treats like the same issue's URL, as a source;
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
  checklist lists every file that holds the example; README's setup steps include
  `mise trust` and committing and pushing the bootstrap result.
- Skills and rules agree with the project gates: PRs record release impact and every
  local check, formatting changes are inspected before commit, core enum matches are
  exhaustive, bootstrap documents its validated inputs, and template-only blocks are
  removed only from the declared marker files.

- The pre-commit skills-mirror check compares the staged `.agents/skills/` and
  `.claude/skills/` through `cargo xtask sync-agents --check --staged`, so a missing
  staged mirror is refused even when working copies match. The editing hook formats
  only its supplied Rust file. Harness checks also read the shared guides, rules,
  sub-agent definitions, nested documents, and issue forms; template design records,
  roadmaps, and ADRs remain outside the standing-document issue-reference check.

- A `Tuning` whose `min` is above its `max` is refused. `clock_contract` permits
  wall-clock reads to move backward, and core's doctests exercise documented usage.

- Counter persistence uses temporary files, atomic replacement, and a lock across
  load and save so concurrent changes preserve complete data.

- `just bootstrap` validates inputs and checkout state before writing: reserved or
  colliding crate names, placeholder-bearing answers, dirty trees, and malformed
  bundle identifiers fail with named errors. Pasted answers are read separately,
  and the usage preserves quoted values.

- The pre-commit staged guard reads a staged file larger than 1 MiB instead of refusing
  it with `ERR_STAGED_READ_FAILED`, so an icon source, a screenshot, or a large lockfile
  can be committed through the hook.

- Workflow harness checks reject `continue-on-error`, fail-open shell fallbacks,
  conditional local gates, incorrect push concurrency, and unlocked Cargo commands.
  They inspect composite actions as well as workflow steps; CI's Cargo commands use
  `--locked`.

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

- The release-note category configuration keeps uncategorized pull requests under
  "Other Changes" instead of dropping them.

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
