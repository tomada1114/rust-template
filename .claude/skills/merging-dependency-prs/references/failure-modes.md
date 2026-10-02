# CI failure modes on bot PRs

Read when the survey lists a PR as `checks=FAILING` or holds it. Diagnose before
deciding: most failures here are mechanical, not regressions.

Pull the real error first:

```bash
gh run list --branch <branch> --limit 1 --json databaseId -q '.[0].databaseId' \
  | xargs -I{} gh run view {} --log-failed
```

Which job and which step failed tells the cases apart. F1 to F3 fail at install, before
any project code runs; F4 onward fail inside a check.

## F1: Peer range conflict

**Symptom:** the `Frontend` or `Repo Lint & Harness` job fails at
`pnpm install --frozen-lockfile` with an unmet-peer error naming a package other than
the one bumped.

**Cause:** `pnpm-workspace.yaml` sets `strictPeerDependencies: true`, so an unmet peer
range is an error. The standing case is TypeScript: `typescript-eslint` caps the
TypeScript versions it accepts with an upper bound in its `peerDependencies`
(`>=4.8.4 <6.1.0` for 8.70: observed on this Mac with
`node -p "require('typescript-eslint/package.json').peerDependencies.typescript"`,
2026-09-29; its policy is https://typescript-eslint.io/users/dependency-versions/,
checked 2026-09-29), which is why `package.json` keeps `typescript` on a tilde range.
A PR proposing a TypeScript past that cap fails here and is right to fail.

**Fix:** hold it. Raising the cap is a coordinated upgrade of `typescript` and
`typescript-eslint` together, not a bump; never add an override or relax the setting.

## F2: Lockfile out of step with its manifest

**Symptom:** install fails because the lockfile does not match `package.json`, or a
cargo step fails under `--locked` because `Cargo.lock` needs to change.

**Cause:** a rebase or a hand-resolved conflict moved one file without the other. The
bump itself is untested, not broken.

**Fix:** such a PR is eligible for the combined branch only, never landed alone, under
the combined-branch bar in `SKILL.md` › "Step 3". Take it through the combined branch
(Step 4b), where the tool regenerates the lockfile. That branch's CI run is the first
real signal for the new version.

## F3: The cooldown refuses the version

**Symptom:** pnpm refuses a version as too new. `pnpm-workspace.yaml`'s
`minimumReleaseAge` (7 days) normally matches Dependabot's own cooldown, so this happens
on a security update, which Dependabot's cooldown does not delay.

**Fix:** the tension is real: a fix wanted now against a cooldown that exists to catch a
compromised release. Report the advisory, the version, and its publish date, and let the
human choose between waiting out the remaining days and a reviewed exception for that
exact `package@version` (`minimumReleaseAgeExclude`, with the date it can come out).
Never a wildcard or a package-wide exception.

## F4: A new lint or a stricter compiler

**Symptom:** install and build succeed; `cargo clippy`, `pnpm lint`, `pnpm typecheck`, or
`pnpm format:check` fails. Typical after a Rust toolchain bump (a new clippy lint under
`pedantic`), an ESLint or typescript-eslint bump, a TypeScript bump, or a Prettier bump.

**Fix:** fix the code on the branch: `just fix` for formatting and auto-fixable lints,
then hand edits. A new lint that asks for a real design change is held and reported with
what it wants. Never an `#[allow]`, an `#[expect]`, an `eslint-disable`, or a config
change to get past it (`AGENTS.md` › "Security and human approval").

A toolchain bump can also fail clippy through `cargo xtask clippy-guard` with no lint in
the code: `ERR_CLIPPY_BAN_UNRESOLVED` when a ban's path in a `clippy.toml` was renamed
or moved in that Rust release (point it at the new path), or `ERR_CLIPPY_CONFIG_INVALID`
when clippy deprecated or dropped a key (rename it as the message says). Either fix
keeps every ban; never `allow-invalid = true`.

## F5: `cargo deny` or `cargo shear`

**Symptom:** the `Rust Core` job fails at `cargo deny` (a new advisory, a licence outside
the allow-list, a `[bans]` rule such as a wildcard requirement or a crate outside its
`wrappers`, a source other than crates.io; a duplicate version only warns) or at
`cargo shear` (an unused dependency).

**Fix:** a licence or source failure is a new dependency decision: hold it for the human
(`managing-dependencies`). An advisory on the new version holds the PR; an advisory the
bump fixes is a reason to land it sooner. Never add an `ignore` entry to pass.

## F6: A test, a floor, or the smoke fails

**Symptom:** lint passes; `just test-core` or `just test-platform` fails, or a coverage
floor is missed.

**Fix:** a real signal. Read the failure, reproduce with the narrowest recipe
(`AGENTS.md` › "Validating a change"), and hold the PR with the error. Never edit a test
to accommodate a version nobody has decided to accept, and never lower a floor.

## F7: `BEHIND` or `DIRTY`

Not a CI failure. `BEHIND` means `main` moved; `DIRTY` means a real conflict. Comment
`@dependabot rebase` once the approved plan lists it, or when an earlier approved
merge moved `main` (`SKILL.md` › "Step 4a"); a PR that keeps conflicting, which is
normal once two cargo or two npm PRs are open, goes into the combined branch under the
combined-branch bar in `SKILL.md` › "Step 3", never landed alone.

## F8: A check that never reports

**Symptom:** `checks=PENDING` that never settles, or `checks=NONE`.

**Cause:** a run cancelled by a newer one in the same `concurrency` group, or a workflow
whose triggers do not fire for the bot.

**Fix:** `gh run rerun <run-id>`, once the approved plan lists it. A missing check is
not a passing one.

## F9: Held for a conclusion that is not a failure

**Symptom:** `HELD: <name>=CANCELLED`, `=STARTUP_FAILURE`, `=STALE`, or `=UNKNOWN`.

**Cause:** the check did not finish in a state the survey vouches for. `CANCELLED` is
usually a run superseded by a newer event on the same PR (`pr-label.yml` and
`check-pr-title.yml` cancel in progress); `STARTUP_FAILURE` means the job never started;
`UNKNOWN` means the rollup entry carried no conclusion.

**Fix:** none of these is a test result, so do not read the diff for a cause. Open the
run, find why it did not complete, and `gh run rerun <run-id>` once the approved plan
lists it. A state that should pass and does not is a bug to fix in
`scripts/survey_prs.py` (the survey's logic) with a test, never a reason to merge
past the verdict.

## Not a failure mode here: the PR-title check

`check-pr-title.yml` skips a pull request labelled `dependencies`, which both bots apply,
so a bot title never fails `Validate PR title`. Its prefix still becomes the squash
commit on `main`, so the prefixes (`commit-message` in `.github/dependabot.yml`,
`commitMessagePrefix` in `.github/renovate.json`) stay within the accepted types; the
harness check that keeps them agreeing is `just check-harness`'s, and changing either
side is a gate change (`changing-gates`).

## F10: A mise or rust-toolchain PR is green but the new pin will not install here

**Symptom:** `mise install` fails for a `mise.toml` pin, or the next `cargo` call fails
as rustup installs a `rust-toolchain.toml` channel (rustup installs a missing active
toolchain by default, `RUSTUP_AUTO_INSTALL`:
https://rust-lang.github.io/rustup/environment-variables.html, checked 2026-09-30).

**Cause:** the pinned version has no build for this Mac yet, though CI's Linux runner
found one.

**Fix:** hold it until it has; never pin a different version than the bot proposed,
except a side the approved plan names under F11 or F12.

## F11: One side of a Tauri pair

**Symptom:** a PR that moves a Tauri-family package (normally `cargo-tauri` or
`npm-tauri`) fails only in one or more of these ways, and every other job and step
passes:

- `macOS Build & Smoke` fails at "Build the debug app bundle" with the Tauri CLI
  refusing the crate and npm packages on different versions.

**Cause:** Dependabot updates cargo and npm in separate PRs, so each PR carries one side
of a new Tauri minor, or of a plugin's new exact version. The harness refuses a pair on
two versions, and the build may too. This is not a regression: as in F2, the bump is
untested until its other side joins it.

**Fix:** such a PR is eligible for the combined branch only, never landed alone, under
the combined-branch bar in `SKILL.md` › "Step 3"; the combined branch's own PR lands
only when `CLEAN` and all green.

- If the survey prints `split across #<a> #<b>`, both PRs go into one combined branch
  (Step 4b). That branch's CI is the first real signal.
- If it prints `MISMATCH` (the open PRs leave the pair on different versions: one side
  unopened, or both open but on different minors), move the missing or lagging side by
  hand in the combined branch, naming package, from, and to in the approval plan, and
  only to a version published at least 7 days ago. For npm,
  pnpm's `minimumReleaseAge` refuses a younger one (F3). For a crate, read
  `version.created_at` from `https://crates.io/api/v1/crates/<crate>/<version>`
  (observed on this Mac with `curl` for `tauri` 2.11.6, 2026-09-30).
- Otherwise hold the PR until the other side's PR is open, then survey again.
- Any other failing step, or any other code in the log, is diagnosed under its own entry
  and is never waved through as the split.

## F12: One side of a Node major

**Symptom:** a Renovate PR that moves `mise.toml`'s `node` to a new major, or a
Dependabot PR that moves `@types/node` to one, with no open PR moving the other side.
CI usually passes: `tsc` accepts either major, and no check compares the two (the
harness reads no Node-only pin since it moved to `cargo xtask check-harness`), so the
plan's own read of the PR list is what notices one side moving alone.

**Cause:** `@types/node` stays on the Node major `mise.toml` runs, so the scripts
type-check against the APIs of the Node that executes them. Renovate bumps `mise.toml`
and Dependabot bumps `@types/node`, each in its own PR.

**Fix:** such a PR is eligible for the combined branch only, never landed alone, under
the combined-branch bar in `SKILL.md` › "Step 3". The combined branch moves the other
side by hand, named in the approved plan with its package, from, and to versions, and
only to a version published at least 7 days ago:

- For a `node` major, `pnpm add -D @types/node@^<major>` (pnpm's `minimumReleaseAge`
  refuses a younger one, F3).
- For an `@types/node` major, set `node` in `mise.toml` to an exact release of that
  major, then `mise install` (F10 if it will not install here).

With no such release of the other side yet, hold the PR. Read the Node release notes
for the major either way (`review-checklist.md` › "Release notes").

Where to read the log: the command at the top of this file.
