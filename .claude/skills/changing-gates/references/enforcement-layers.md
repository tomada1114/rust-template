# Enforcement layers

The detail behind `changing-gates`' "What no gate here sees": which layer enforces each
rule in `AGENTS.md`, when it fires, whom it binds, and what it holds, then the gaps that
stay open on purpose. A gate added, changed, or removed updates its row here in the same
pull request; `AGENTS.md` › "Enforcement layers" keeps only the summary.

## The layers

From mechanical to procedural:

| Layer | Fires on | Applies to | Holds |
|---|---|---|---|
| lefthook's pre-commit hook (`lefthook.yml`) | `git commit` | anyone who ran `just install`, and a Claude Code cloud session, whose start installs the hook | check-only and fast, on the staged files: `rustfmt --check`, `typos`, and the staged guard. No clippy or test step — `just check` and CI run those (`cargo xtask` compiles the xtask crate on its first run and after `xtask/` changes, into `target/xtask`, so a commit never waits on a workspace build's lock). On the commit that concludes a conflicted merge, or one made at a rebase stop, the two style jobs skip (CI reruns them over the whole tree) and the staged guard still runs |
| `cargo xtask check-staged` (the hook's staged guard, `xtask/src/check_staged.rs`; rules in `xtask/guard/`) | `git commit`, whatever is staged, including the commit that concludes a conflicted merge | the same | no secret-shaped path (`.env*`, `.envrc.*`, `secrets/`, signing material, SSH keys, `.claude/settings.local.json`) or credential-shaped content (private-key header, GitHub token, AWS keys, Anthropic or OpenAI API key, Slack token, Google API key, Stripe live key, and the rest `credentials.rs` lists) lands in a commit; judged from the index, so a partly staged file is judged as committed; staged deletions are never inspected |
| `cargo xtask verify-hooks` (`just install`'s last step, `just check`'s first) | `just install`, `just verify-hooks`, and `just check` | anyone who runs one | lefthook's pre-commit hook is installed in this checkout — skips under CI or the `ALLOW_MISSING_GIT_HOOKS` opt-out |
| The core boundary: core's `Cargo.toml`, `deny.toml`'s `[bans]` `wrappers`, and the dependency-closure harness check | compile, `just deny`, `just check-harness`, and CI's `Rust Core` and `Repo Lint & Harness` jobs | every author | core cannot name an OS binding crate or `myapp-platform`; only `myapp` depends on `myapp-platform`; `myapp-test-support` is dev-only — three mechanisms, so removing one leaves the others |
| `crates/myapp-core/clippy.toml`, core's `#![deny(clippy::wildcard_enum_match_arm)]`, `cargo xtask clippy-guard` (every clippy run in `just lint` and CI goes through it), and `cargo xtask check-harness`'s `clippy-allow-invalid` check | `just lint`, `just check`, and CI's clippy steps; the check in `just check-harness` and CI's `Repo Lint & Harness` job | every author | in core, none of the calls `clippy.toml` lists: the print macros and standard streams, `std::fs`'s types and free functions, `Path`'s file-system queries, `std::os::unix::fs`'s `symlink`, `chown`, `fchown`, `lchown`, and `chroot`, `std::net`'s and `std::os::unix::net`'s sockets and address lookups, clock reads (`now`, `elapsed`), `std::env`'s argument, variable, and directory functions, `Command`, `exit`, `abort`, the process and parent-process ids, `thread::available_parallelism`, `thread::spawn`, `thread::Builder::spawn`, `thread::sleep`, or `thread::park_timeout` (`thread::scope` is allowed, since it cannot outlive the call); every `match` on a core enum is exhaustive; and every `path` in a `clippy.toml` names an item clippy resolves on that job's target — clippy only warns about one that does not, and `-D warnings` lets that pass, so the guard fails with `ERR_CLIPPY_BAN_UNRESOLVED` instead of letting the ban silently do nothing, and with `ERR_CLIPPY_CONFIG_INVALID` on any other diagnostic in a `clippy.toml` (a deprecated or unknown key); and no `clippy.toml` sets `allow-invalid`, which would hide that warning from the guard, so the check fails with `ERR_CHECK_CLIPPY_ALLOW_INVALID` apart from its human-approved exception list (empty) |
| `[workspace.lints]` in `Cargo.toml` | `just lint` and CI (`-D warnings`) | every author | `unsafe_code = "forbid"` in every crate; clippy `all` and `pedantic`; `unwrap_used`/`expect_used` outside tests; `missing_docs` on public items |
| Coverage floors | `just test-core`, `just test-xtask`, `just check`, and CI | every author | `myapp-core` lines 80 / functions 80; `xtask` with `xtask-guard` 85 / 90; `xtask/guard/` 90 / 100 |
| `cargo xtask check-harness` (`xtask/src/check_harness/`; `just check-harness`, part of `just check`) | `just check-harness`, `just check`, and CI's `Repo Lint & Harness` job | every author | the harness's claims about itself stay true — `AGENTS.md` exists and is at most 20,000 bytes outside its `## Product` section, which is the app's own and is not counted (`guide-size`: what one kind of file or change needs goes to a rule or a skill instead), and every `just <recipe>` it, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, the pull request template, `.claude/rules/`, `.claude/agents/`, `docs/`, the skills, and the issue forms name exists; workflow hygiene, in the workflows and the repository's composite actions (SHA pins with a `# vX.Y.Z` comment, `timeout-minutes`, least-privilege `permissions`, `persist-credentials: false`, `concurrency` — top-level or per job — that never cancels a `main` run, no `pull_request_target`, no `continue-on-error`, `set +e`, or `|| true`-style fallback, `--locked` on every lockfile-resolving cargo command and no `npm install` there and in every justfile recipe, and one mise `version` named by every `jdx/mise-action` step); the skills' documents and `AGENTS.md` name no `gh` subcommand built on GraphQL, no GraphQL query, and no issue-search call, which a cloud session's proxy refuses (`rest-only-github`); no job holding a write scope or `id-token: write`, its own or inherited from the workflow's `permissions`, checks out the repository, runs `jdx/mise-action` or a local action, calls a remote reusable workflow, or runs `cargo` or `just`, apart from a reasoned exception list; the Dependabot and Renovate cooldowns agree; the bundle identifier is one value in `myapp-platform`'s `BUNDLE_IDENTIFIER` and the justfile's `bundle_id`; no `clippy.toml` sets `allow-invalid` (the clippy row above); `osv-scanner.toml`'s GHSA ignores and Dependency Review's `allow-ghsas` list the same advisories; every required context in `.github/rulesets/main.json` names a job that runs on every pull request (no paths filter, no branch filter excluding a branch the ruleset gates — the default branch, read from `ci.yml`'s push branches or `origin/HEAD` only where a required job filters branches, or every branch under `~ALL` — default activity types, no `if:` that can be false); `just check` matches the steps CI runs unconditionally (no `if:`, `continue-on-error`, or `||` fallback) apart from a reasoned exception list; skills' frontmatter (`name`, `description`, and a closed list of optional Claude Code keys), a 500-character description and a 9,000-character total across the tree, body size, and the Skills table; each `.claude/agents/` tier file's frontmatter, with its `name`, `model`, and `effort`; every applied label is declared once, and every label `.github/workflows/pr-label.yml`'s `TYPE_LABELS` map applies has a release-notes category and every PR-title type a key there; the core boundary lists agree and `myapp-test-support` is dev-only; no reference to this repository's issues or pull requests (`#` and digits, bare or after this repository's owner/repo — an upstream `owner/repo#N`, like its URL, is a source — an issue or pull-request URL on this repository or relative to it, the word issue, PR, pull request, or merge request before a number, `GH-` and digits, a `gh issue`/`gh pr` command given a number) in `AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, `.claude/agents/`, `docs/`, a skill, or an issue form; the committed `.claude/settings.json` names only recipes the justfile defines, its `allow` admits none of the recipes that need a human or write beyond the working tree (`test-local`, `logs-follow`, `install-cli`, `install`, `labels`, `ruleset`, `bootstrap`) nor `cargo xtask sync-labels`, `apply-ruleset`, or `bootstrap`, `cargo install`, or `cargo run … tui`, its hook commands name only scripts that exist, run `.claude/cloud/provision.sh` on `SessionStart`, and carry no `--no-verify`, `sudo`, or URL, and it sets no `enabledPlugins`; and the `## Product` section stays a `TODO:` skeleton in the template and holds no `TODO:` once `cargo xtask bootstrap` has run |
| The committed `.claude/settings.json`: its permission list and its hooks | a Claude Code tool call (the permission list), a session's start (`SessionStart`), an edit (`PostToolUse`) | Claude Code alone, local and cloud; no other tool reads it | `deny` refuses the usual spellings of a hook bypass and a force push, `myapp tui` through cargo or the built binary, and reads of the commonest secret-shaped files; `ask` stops for the recipes that need a human or write to GitHub, a dependency or tool-pin change, a release tag, and an edit to a settings file; `allow` runs the gate recipes without a prompt; the hooks provision a cloud session and format the `.rs` file an edit touched. A pattern matches a command only as written, so a re-spelling passes it: this narrows where a human is consulted, and is not a boundary |
| CI (`.github/workflows/ci.yml` and the security workflows) | push to `main` and every pull request | everyone | the full gate: `Rust Core` (fmt, workspace clippy, core tests with floors, doctests, `just test-platform`, `cargo deny`, `cargo shear`), `Repo Lint & Harness` (typos, actionlint, skill script tests, xtask tests with floors, harness checks), `macOS` (`just test-platform`, default and all features), `Template Bootstrap Smoke` (the bootstrap run on a throwaway copy, then `just check` there), `Workflow Security Lint` (zizmor), plus Dependency Review, the PR-title check, CodeQL, OSV-Scanner, Scorecard, and a weekly gitleaks scan |
| `AGENTS.md` | read at session start | every agent | everything else — the reasons behind the rules above |

## The gaps

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
  Nothing in this repository blocks these for every author: the committed
  `.claude/settings.json`'s `deny` list refuses the usual spellings in Claude Code alone,
  and only as written, and `cargo xtask verify-hooks` sees only that the hook file is
  lefthook's, not that its binary resolves or that no variable disables it. "Never
  bypass the hooks" therefore still holds as an instruction, and CI is the backstop —
  except for the
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
  environment that genuinely cannot have git hooks; every failure names it. A Claude Code
  session narrows it further through the committed `SessionStart` hook
  (`.claude/cloud/provision.sh session`): a cloud session installs the hook at every
  start, and a local session prints one line when it is missing and installs nothing.
- **Whether `main`'s ruleset is actually in force is invisible from the checkout.**
  The intended ruleset — PR required, checks green, no force-push or deletion — is
  defined as code in `.github/rulesets/main.json`; `just ruleset`
  (`cargo xtask apply-ruleset`) creates or updates it, with `release-tags.json`, via the GitHub API for whoever runs
  it as a repository admin. Nothing in the checkout verifies that it was applied —
  that is visible only via `gh api repos/{owner}/{repo}/rulesets`. "Use this template"
  does not copy rulesets, so every repository created from this template still needs
  its own admin to run `just ruleset` once.
- **The committed permission list binds only Claude Code, and only as written.**
  `.claude/settings.json` is committed because a cloud session reads no other settings
  file: a VM starts with the checkout and nothing of a person's own. Its row above says
  what it holds: among the rest, `ask` for the recipes that need a human or write
  outside the checkout (`test-local`, `logs-follow`, `install-cli`) and those that write
  to GitHub or rewrite the repository (`bootstrap`, `labels`, `ruleset`). A personal
  file (`~/.claude/settings.json`, or the gitignored `.claude/settings.local.json`) may
  add rules of its own, and the committed `deny` rules still apply beside them. The gap
  is everything else: a human at a shell, and any tool other than Claude Code, read
  none of it and are bound by the instructions in `AGENTS.md` and by the gates above;
  and inside Claude Code a rule matches a command's spelling, so the list shapes where a
  human is consulted rather than what is possible. `just check-harness` holds the file
  to its row in the table, and review holds the rest of it: it is a gate file, and
  loosening a `deny` or an `ask`, or widening `allow`, is weakening a gate.
- **Nothing runs the `#[ignore]`d tests for you.** A CI runner has no logged-in GUI
  session and cannot be granted a TCC permission or reach a login Keychain, so a test
  that needs one is `#[ignore = "local machine: …"]` and is reported as ignored by
  `just test-platform` and in CI. That is deliberate — an ignored test is visible where a
  missing one is not — and it leaves the run itself procedural: a change to such an
  adapter is expected to come with `just test-local` output in the PR, which a human
  runs, and review is what notices when it does not.
- **Nothing mechanical keeps a routine check from taking over the machine.** The rule
  in `AGENTS.md` › "Never taking over the machine" holds because every recipe in
  `just check` was written to it. The committed `.claude/settings.json` denies running
  the TUI through `cargo run` or a `target/` binary (not an installed `myapp` on PATH)
  and asks before a human's recipe, for Claude Code alone and only as spelled; nothing
  stops another tool, or a human's own shell. A new
  recipe or test that shows a window, takes focus, raises a prompt, or takes over a
  terminal is caught only by review.
- **No gate runs the real terminal loop.** `myapp tui`'s loop — raw mode, the alternate
  screen, resize, and restoring the terminal on every way out — runs only when a human
  starts it. Keeping `crates/myapp/src/tui/mod.rs` thin is the mitigation: the screen's
  state and keys are core's, and its drawing is `TestBackend`-tested, so a pull request
  that changes the loop itself carries the human's run as evidence.

## Claude Code permissions and the format hook

Both are committed, in `.claude/settings.json`; the gap above that starts "The committed
permission list binds only Claude Code" says why and what a personal file may add.
`AGENTS.md` › "Security and human approval" says when either file changes: the committed
one only in a reviewed pull request, as the gate file it is, and a personal one only when
the owner asks for it in that session.

The format hook is the committed `PostToolUse` hook on `Edit|Write|MultiEdit`,
`.claude/hooks/format-edited-file.sh`. It runs `cargo xtask format-edited-file`
(`xtask/src/format_edited_file.rs`) with `CARGO_TARGET_DIR=target/xtask`: the separate
target directory keeps every edit from waiting on the lock of a workspace build, such as
a `just check` running meanwhile, and `.cargo/config.toml` says why the alias cannot
carry it. The task formats the one `.rs` file an edit touched inside the checkout
(rustfmt, fed on stdin so it never rewrites a `mod` child) and reports a formatter
failure back to the agent (exit 2); on a machine without `cargo` the script skips
silently. It is a convenience, not a gate: `just lint` and the pre-commit hook check the
formatting. No other file type is formatted: JSON, YAML, and Markdown have no formatter
here. Remove a copy of this hook registered in a personal settings file, or the
formatter runs twice on every edit.
