---
name: merging-dependency-prs
description: >
  Covers landing the Dependabot and Renovate pull requests already open in this
  repository: Dependabot's cargo (Cargo.lock, Cargo.toml) and github-actions bumps,
  grouped as cargo-minor-and-patch and actions-minor-and-patch, and Renovate's mise.toml
  and rust-toolchain.toml bumps. Surveys them with scripts/survey_prs.py, runs the
  security review (release notes, workflow permissions and SHA pins, maintainer changes,
  crates whose build.rs or proc-macro runs at build time), treats a ratatui or crossterm
  minor (pre-1.0, so breaking) and a clap major as migrations landed alone and checked
  against the TestBackend view tests, asks the human for one approval of a listed batch,
  then merges or builds one combined branch. Use when clearing a backlog of bump PRs,
  when a bot PR fails CI after a clippy or Rust toolchain bump, when a grouped cargo PR
  carries a 0.x minor marked (major), or when several dependency PRs contest Cargo.lock
  or mise.toml.
---

# Merging Dependency PRs

**Owns:** landing bot pull requests that already exist: the survey, the security review,
the approval gate, individual merges, migrations, the combined branch, and the cleanup.
**Does not own:** which bot bumps what and the 7-day cooldown (`.claude/rules/project.md`
› "Tool Pinning", stated once there), or the `deps:`/`ci:` title prefixes the bots write
(`commit-message` in `.github/dependabot.yml`, `commitMessagePrefix` in
`.github/renovate.json`); adding a dependency that is not there yet, which needs a
human's sign-off and its review record (`managing-dependencies`); the Release impact
line a runtime bump's PR carries (`create-pr`).

Branch names, commits, comments, and PR text are English and Conventional Commits.

## The approval gate

Merging is a remote write, and this skill is not one of the standing exceptions in
`AGENTS.md` › "Security and human approval", so invoking it is not the sign-off.

1. Do the whole survey and review first, writing nothing remote.
2. Present the plan: the exact PR numbers to merge, which go individually, which into
   a combined branch, and which become a migration branch (and the failure mode
   admitting each one not `CLEAN` and green, Step 3), which are held and why, every
   major bump named, every `@dependabot rebase` comment and `gh run rerun` the plan
   already needs (`references/failure-modes.md` F7-F9), and any ADR or issue the plan
   would propose (a migration, below).
3. Get one explicit approval for the listed batch, then run it without asking per merge.

The approval covers only the listed PRs, only for this invocation. Of the rebase
comments and reruns, it covers the ones it lists, and the rebase a PR in the batch needs
because an earlier approved merge moved `main` (Step 4a); any other rebase or rerun that
becomes necessary after the approval needs a fresh one. A PR opened later, a PR whose
diff changed beyond a bot rebase, or anything in "Stop and ask" needs a fresh approval.

## Step 1: Survey (read-only)

```bash
python3 .agents/skills/merging-dependency-prs/scripts/survey_prs.py
```

It lists every open bot PR with its ecosystem (`cargo`, `github-actions`, `mise`,
`rust-toolchain`), the versions it moves and their level (below 1.0.0 a minor move
counts as major, as Cargo's caret ranges treat it), the check verdict, the merge state,
and the touched files; then the files two PRs contest. Add `--json` to compute over the
rows. With no bot PR open, say so and stop.

`checks=PASSING` is an allow-list verdict: only `SUCCESS`, `NEUTRAL`, and `SKIPPED` pass,
and any other conclusion, including one the script has never seen, is listed under
`HELD`. An unknown CI state holds a PR; it is never waved through.

Minor and patch bumps arrive grouped (`cargo-minor-and-patch`, `actions-minor-and-patch`)
and majors one per PR (`.github/dependabot.yml`). Dependabot counts a 0.x minor as a minor
(https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference,
`groups` › `update-types`, checked 2026-09-30), so it rides in a group; the survey shows
that row's level as `major` and marks the bump `(major)`: name it in the plan as a major
and read its release notes (review checklist). Read a grouped PR's diff in full:

```bash
gh pr diff <number>
gh pr checks <number>
```

## Step 2: Review every PR before the plan

**REQUIRED:** [references/review-checklist.md](references/review-checklist.md), run
against each PR: release notes for every major and every 0.x minor, Actions permissions
and SHA pins, maintainer and source changes, supply-chain settings left alone, build-time
code, and the migrations below. A failing PR is diagnosed before it is judged:
**REQUIRED:** [references/failure-modes.md](references/failure-modes.md).

## Migrations: ratatui, crossterm, clap

ratatui (`0.30` in the root `Cargo.toml`) and crossterm, reached only as
`ratatui::crossterm`, are pre-1.0: a minor of either may break the API the TUI in
`crates/myapp/src/tui/` uses. A clap major does the same to every subcommand.

- **A ratatui or crossterm minor lands alone** on a migration branch (Step 4c), never in
  its `cargo-minor-and-patch` group or a combined branch; the group's other bumps take
  the combined branch (Step 4b), and the group PR closes as superseded by both.
- **The `TestBackend` tests are the evidence**: they draw each view into ratatui's
  in-memory backend and assert its cells, so an upstream rendering change fails a test.
  What none sees (raw mode, the alternate screen, key events, the terminal restore) goes
  in the report for the human to try with `myapp tui`; an agent never runs it.
- **A clap major, or ratatui 1.0, owes an ADR** (**REQUIRED:**
  `recording-architecture-decisions`): hold the PR and propose the ADR, the upstream
  migration guide linked; once a human accepts it, it lands alone as in Step 4c.
- A migration needing more than mechanical edits (a widget the view relies on removed,
  a changed event model) is held, and the plan proposes an issue (**REQUIRED:**
  `triaging-issues`).

## Step 3: Choose the landing mode

Every PR needs a review that found nothing, then meets one of two bars:

- **The bar to land alone:** every check passes and the merge state is `CLEAN`. Nothing
  else lands by itself; it may still join a combined branch.
- **The combined-branch bar:** it misses that bar only where a failure mode blames its
  merge or lockfile state, or a migration it carries, not its other changes. Every check
  passes, or fails only where F2 (a lockfile out of step with its manifest) or F13 (a
  group broken only by its ratatui or crossterm minor) says, confirmed from the run log;
  and the merge state is `CLEAN`, `BEHIND` or `DIRTY` (F7), or `UNSTABLE` or `BLOCKED`
  only by those checks. A pending, missing, or held check still holds it (F8, F9). The
  combined branch's own PR lands only when `CLEAN` with every check green.

Then land them; mixed outcomes are fine, and the plan says which way each PR goes:

- **Individually** when PRs that meet the bar to land alone share no file and carry no
  migration: in practice the Actions PRs and a lone mise or rust-toolchain PR.
- **One combined branch** for every PR that meets only the combined-branch bar, when two
  eligible PRs touch the same file (two cargo PRs both rewrite `Cargo.lock`), or when
  more than three are eligible and rebase-and-wait cycles would dominate.
- **A migration branch** for each migration above.

## Step 4a: Individual merges

In ascending PR number, one at a time. After each merge the rest go `BEHIND`: comment
`@dependabot rebase` (or tick the rebase box Renovate puts in its PR body), then
re-check after the rebase. The approval covers that rebase, because an approved merge
caused it ("The approval gate"); a rebase or rerun for any other reason that the plan
did not list needs a fresh approval. Never merge on checks older than the PR's last push.

```bash
gh pr checks <number>
gh pr merge <number> --squash --delete-branch
```

## Step 4b: The combined branch

```bash
git switch main && git pull --ff-only
git switch -c deps/combined-<yyyy-mm-dd>
```

Apply each PR's version change with the tool that owns the file, never by hand-editing
a lockfile or by merging bot branches:

- **cargo:** `cargo update -p <crate> --precise <version>` per crate the PRs moved.
  `Cargo.toml` changes only when a PR changed a requirement. Read the `Cargo.lock`
  diff: a crate no PR named that moved too is reverted, since only what the bots
  proposed was reviewed; so is a migration's crate, which takes its own branch.
- **mise:** edit the pin in `mise.toml`, then `mise install` (it must exist here).
- **rust-toolchain:** edit `channel` in `rust-toolchain.toml`; rustup installs it on the
  next `cargo` call (`RUSTUP_AUTO_INSTALL`, on by default:
  https://rust-lang.github.io/rustup/environment-variables.html, checked 2026-09-30).
  `mise.toml` lists no `rust` tool, so `mise install` does not.
- **Actions:** copy the new 40-character SHA and its `# vX.Y.Z` comment exactly.

Commit each lockfile with its manifest (**REQUIRED:** `smart-commit`), then run
`just check`; a new clippy finding is fixed in the code (`just fix`, then hand edits),
never silenced, since an `#[allow]` or a relaxed config weakens a gate. Open the PR with
**REQUIRED:** `create-pr`, titled `deps: combine dependency bumps`, listing each
superseded PR; opening and merging it are in the batch only when the plan named it.

## Step 4c: A migration branch

From an up-to-date `main`, `git switch -c deps/<crate>-<version>`, raise the requirement
in `[workspace.dependencies]`, and `cargo update -p <crate> --precise <version>`. The
`ratatui-*` crates and crossterm follow ratatui; any other crate that moves is reverted,
or stops the run when the new version needs it. Make the changes the changelog asks for
until `just test-core` (the binary's tests, `TestBackend` ones included), then
`just check`, pass. Open it with **REQUIRED:** `create-pr`, titled
`deps: migrate to <crate> <version>`, each code change tied to its changelog entry; land
it before the combined branch, which then rebases onto it.

## Step 5: Land and clean up

Merge the combined or migration PR only on green, then close each superseded PR with a
pointer. Close nothing before every replacement has merged; if one is abandoned, the
originals stay open.

```bash
gh pr checks <replacement-number> --watch
gh pr merge <replacement-number> --squash --delete-branch
gh pr close <number> --comment "Superseded by #<replacement-number>." --delete-branch
```

## Stop and ask, outside any batch approval

- An Actions bump that widens a workflow's `permissions:`, adds a secret, or changes a
  trigger (`changing-gates`).
- A maintainer, owner, or source change on any bumped dependency.
- A new package in `Cargo.lock`, a crate a migration moves that no PR named, or a bump
  that needs a new dependency.
- A bump that goes green only by relaxing a lint, lowering a floor, ignoring an advisory,
  or editing another gate file.
- A migration that goes green only by changing what a `TestBackend` test expects: show
  the old and new expected lines with the changelog entry behind them, and let the
  human decide.
- A clap or ratatui major, before its ADR is accepted.
- Anything the review checklist marks as held for the human.

Never `--admin`, `--no-verify`, a force push, or unpinning a SHA-pinned Action for a bump.

## Report

Merged PRs; the combined and migration PRs and what each superseded; held PRs with the
reason each; any ADR proposed or issue filed; anything only a real terminal shows, for
the human to check with `myapp tui`; any CI failure with its real error line, not a
summary. A partly completed run says so. An unrelated problem noticed on the way goes in
the report, never into a combined or migration branch.
