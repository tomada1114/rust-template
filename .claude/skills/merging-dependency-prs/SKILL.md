---
name: merging-dependency-prs
description: >
  Covers landing the Dependabot and Renovate pull requests already open in this
  repository: Dependabot's cargo (Cargo.lock), npm (package.json, pnpm-lock.yaml), and
  github-actions bumps, and Renovate's mise.toml and rust-toolchain.toml bumps. Surveys
  them with scripts/survey-prs.ts, runs the security review (release notes, workflow
  permissions, maintainer changes, crates whose build.rs or proc-macro runs at build
  time), keeps each tauri crate and its @tauri-apps/* npm package in step, holds a
  Tauri major as a migration issue, asks the human for one approval of a listed batch,
  then merges or builds one combined branch. Use when clearing a backlog of bump PRs,
  when a bot PR fails CI after a clippy, ESLint, TypeScript, or Rust toolchain bump, or
  when several dependency PRs contest Cargo.lock, pnpm-lock.yaml, or mise.toml.
---

# Merging Dependency PRs

**Owns:** landing bot pull requests that already exist: the survey, the security review,
the approval gate, individual merges, the combined branch, and the cleanup. **Does not
own:** which bot bumps what and the 7-day cooldown (`.claude/rules/project.md` › "Tool
Pinning", stated once there), or the `deps:`/`ci:` title prefixes the bots write
(`commit-message` in `.github/dependabot.yml`, `commitMessagePrefix` in
`.github/renovate.json`); adding a dependency
that is not there yet, which needs a human's sign-off and its review record
(`managing-dependencies`); the Release impact line a runtime bump's PR carries
(`create-pr`).

Branch names, commits, comments, and PR text are English and Conventional Commits.

## The approval gate

Merging is a remote write, and this skill is not one of the standing exceptions in
`AGENTS.md` › "Security and human approval", so invoking it is not the sign-off.

1. Do the whole survey and review first, writing nothing remote.
2. Present the plan: the exact PR numbers to merge, which go individually and which into
   a combined branch, which are held and why, every major bump named, every
   `@dependabot rebase` comment and `gh run rerun` the plan already needs
   (`references/failure-modes.md` F7-F9), and any issue the plan would file (a Tauri
   major, below). A Tauri side moved by hand under F11 is named with its package, from,
   and to versions.
3. Get one explicit approval for that listed batch, then run it without asking per
   merge.

The approval covers only the listed PRs, only for this invocation. Of the rebase
comments and reruns, it covers the ones it lists, and the rebase a PR in the batch needs
because an earlier approved merge moved `main` (Step 4a); any other rebase or rerun that
becomes necessary after the approval needs a fresh one. A PR opened later, a PR whose
diff changed beyond a bot rebase, or anything in "Stop and ask" needs a fresh approval.

## Step 1: Survey (read-only)

```bash
node .agents/skills/merging-dependency-prs/scripts/survey-prs.ts
```

It lists every open bot PR with its ecosystem, the versions it moves and their level
(below 1.0.0 a minor move counts as major, as Cargo's and npm's caret ranges treat it),
the check verdict, the merge state, and the touched files; then the files two PRs
contest, whether the batch keeps each Tauri pair on one minor, and any Tauri major. Add
`--json` to compute over the rows. With no bot PR open, say so and stop.

`checks=PASSING` is an allow-list verdict: only `SUCCESS`, `NEUTRAL`, and `SKIPPED` pass,
and any other conclusion, including one the script has never seen, is listed under
`HELD`. An unknown CI state holds a PR; it is never waved through.

Minor and patch bumps arrive grouped and majors one per PR (`.github/dependabot.yml`).
For cargo and npm, the Tauri family arrives in its own group (`cargo-tauri`,
`npm-tauri`) and everything else in `cargo-minor-and-patch` / `npm-minor-and-patch`.
Dependabot counts a 0.x minor as a minor (https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference, `groups` › `update-types`, checked 2026-09-30), so it rides in a group; the survey shows that
row's level as `major` and marks the bump `(major)`: name it in the plan as a major and
read its release notes (review checklist). Read a grouped PR's diff in full:

```bash
gh pr diff <number>
gh pr checks <number>
```

## Step 2: Review every PR before the plan

**REQUIRED:** [references/review-checklist.md](references/review-checklist.md), run
against each PR:
release notes for every major and every 0.x minor, workflow permissions and SHA pins on
an Actions bump, maintainer and source changes, supply-chain settings left alone, crates
whose build-time code changed, and the Tauri rule below. A failing PR is diagnosed
before it is judged: **REQUIRED:** [references/failure-modes.md](references/failure-modes.md).

## The Tauri rule

The `tauri` crate and the `@tauri-apps/api` npm package stay on the same minor, and
each `tauri-plugin-<x>` crate and its `@tauri-apps/plugin-<x>` package on the same
exact version, because the JavaScript side calls into the Rust side and Tauri ships
breaking changes to plugins in patch releases
(https://v2.tauri.app/develop/updating-dependencies/, checked 2026-09-29). This
repository also keeps `@tauri-apps/cli` on `tauri`'s minor, so the CLI that builds the
app matches the crate it builds. A mismatch is one no single test run catches.
Dependabot opens the cargo and npm sides as separate PRs, so:

- **Both sides land in one combined branch**, never one PR at a time, whether or not
  each is green alone. When a Tauri minor ships, `cargo-tauri` and `npm-tauri` each
  carry one side, so each is red alone: the survey prints `split across #<a> #<b>`, and
  Step 3 admits the pair (`failure-modes.md` F11). `MISMATCH` means the open PRs leave
  a pair apart: Step 3 admits them too, and the combined branch moves the missing side
  by hand (Step 4b) only to a version published at least 7 days ago and named in the
  approved plan; otherwise the PR is held (F11).
- **A Tauri major (`3.x`) is never part of a batch.** Hold the PR and propose filing a
  migration issue for it (**REQUIRED:** `triaging-issues`), with the upstream migration
  guide linked;
  `Cargo.toml` pins `tauri = "2"` until a migration ADR moves it.

## Step 3: Choose the landing mode

A PR is eligible only when every check passes, its merge state is `CLEAN`, and the review
found nothing. One exception: a Tauri-family PR in a pair the survey prints as `split` or
`MISMATCH` is eligible for the combined branch only, never landed alone, when every
failing check on it is one F11 attributes to the version divergence, confirmed from the
run log. For such a PR the merge state need only be not `DIRTY` (`UNSTABLE`, or
`BLOCKED` only by those checks, is accepted); the review findings apply unchanged. The
combined branch's own PR must be `CLEAN` with every check green before it lands.

- **Individually** when eligible PRs share no file: in practice the Actions PRs and a
  lone mise or rust-toolchain PR.
- **One combined branch** when two eligible PRs touch the same file (two cargo PRs both
  rewrite `Cargo.lock`; npm PRs both rewrite `pnpm-lock.yaml`), when a Tauri pair needs
  both sides, or when more than three are eligible and rebase-and-wait cycles would
  dominate.

Mixed outcomes are fine; the plan says which PR goes which way.

## Step 4a: Individual merges

In ascending PR number, one at a time. After each merge the rest go `BEHIND`: comment
`@dependabot rebase` (or tick the rebase box Renovate puts in its PR body), then
re-check after the rebase. The approval covers that rebase, because an approved merge
caused it ("The approval gate"); a rebase or rerun for any other reason that the plan
did not list needs a fresh approval. Never merge on a check result older than the PR's
last push.

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
  proposed was reviewed, except the Tauri side the approved plan names under F11.
- **npm:** `pnpm add <package>@<range>` (`pnpm add -D` for a devDependency), keeping the
  range style `package.json` uses (a tilde range for the Tauri packages).
- **mise:** edit the pin in `mise.toml`, then `mise install`, so the version exists for
  this platform.
- **rust-toolchain:** edit `channel` in `rust-toolchain.toml`; rustup installs it on the
  next `cargo` call (`RUSTUP_AUTO_INSTALL`, on by default:
  https://rust-lang.github.io/rustup/environment-variables.html, checked 2026-09-30). `mise.toml` lists
  no `rust` tool, so `mise install` does not.
- **Actions:** copy the new 40-character SHA and its `# vX.Y.Z` comment exactly.

Commit each lockfile with its manifest (**REQUIRED:** `smart-commit`), then run
`just check`. A new
clippy, ESLint, or TypeScript finding is fixed in the code on this branch (`just fix`,
then hand edits), never silenced: an `#[allow]`, an `eslint-disable`, or a relaxed
config is weakening a gate. Open the PR with **REQUIRED:** `create-pr`, titled
`deps: combine dependency bumps`, listing each superseded PR in the Summary. Opening and
merging it are inside the approved batch only when the plan named it.

## Step 5: Land and clean up

Merge the combined PR only on green, then close each superseded PR with a pointer. Close
nothing before the replacement has merged; if it is abandoned, the originals stay open.

```bash
gh pr checks <combined-number> --watch
gh pr merge <combined-number> --squash --delete-branch
gh pr close <number> --comment "Superseded by #<combined-number>." --delete-branch
```

## Stop and ask, outside any batch approval

- An Actions bump that widens a workflow's `permissions:`, adds a secret, or changes a
  trigger (`changing-gates`).
- A maintainer, owner, or source change on any bumped dependency.
- A new package in `Cargo.lock` or `pnpm-lock.yaml`, a new `allowBuilds` entry, or a bump
  that needs a new dependency.
- A bump that goes green only by relaxing a lint, lowering a floor, ignoring an advisory,
  or editing another gate file.
- A Tauri major, or a Tauri pair that cannot be brought back in step.
- Anything the review checklist marks as held for the human.

Never `--admin`, `--no-verify`, or a force push; never unpin a SHA-pinned Action to make
a bump apply.

## Report

Merged PRs; the combined PR and what it superseded; held PRs with the reason each; any
issue filed; any CI failure with its real error line, not a summary. A partly completed
run says so. An unrelated problem noticed on the way goes in the report, never into the
combined branch.
