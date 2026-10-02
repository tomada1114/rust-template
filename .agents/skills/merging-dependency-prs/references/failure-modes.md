# CI failure modes on bot PRs

Read when the survey lists a PR as `checks=FAILING` or holds it. Diagnose before
deciding: most failures here are mechanical, not regressions.

Pull the real error first:

```bash
gh run list --branch <branch> --limit 1 --json databaseId -q '.[0].databaseId' \
  | xargs -I{} gh run view {} --log-failed
```

Which job and which step failed tells the cases apart. F2 fails before any project code
runs; F4 onward fail inside a check. The numbers stay stable: F1, F3, F11, and F12
covered an ecosystem, pins, and a pairing rule this repository no longer has.

## F2: Lockfile out of step with its manifest

**Symptom:** a cargo step fails under `--locked` because `Cargo.lock` needs to change.

**Cause:** a rebase or a hand-resolved conflict moved one file without the other. The
bump itself is untested, not broken.

**Fix:** such a PR is eligible for the combined branch only, never landed alone, under
the combined-branch bar in `SKILL.md` › "Step 3". Take it through the combined branch
(Step 4b), where the tool regenerates the lockfile. That branch's CI run is the first
real signal for the new version.

## F4: A new lint or a stricter compiler

**Symptom:** the build succeeds; `cargo clippy` or `cargo fmt --check` fails. Typical
after a Rust toolchain bump (a new clippy lint under `pedantic`).

**Fix:** fix the code on the branch: `just fix` for formatting, then hand edits. A new
lint that asks for a real design change is held and reported with what it wants. Never
an `#[allow]`, an `#[expect]`, or a config change to get past it (`AGENTS.md` ›
"Security and human approval").

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

## F6: A test or a floor fails

**Symptom:** lint passes; `just test-core` or `just test-platform` fails, or a coverage
floor is missed.

**Fix:** a real signal (when the PR is a group carrying a ratatui or crossterm minor and
the failures are all in the TUI, read F13 first). Read the failure, reproduce with the
narrowest recipe (`AGENTS.md` › "Validating a change"), and hold the PR with the error.
Never edit a test to accommodate a version nobody has decided to accept, and never lower
a floor.

## F7: `BEHIND` or `DIRTY`

Not a CI failure. `BEHIND` means `main` moved; `DIRTY` means a real conflict. Comment
`@dependabot rebase` once the approved plan lists it, or when an earlier approved
merge moved `main` (`SKILL.md` › "Step 4a"); a PR that keeps conflicting, which is
normal once two cargo PRs are open, goes into the combined branch under the
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

**Cause:** the pinned version has no build for this machine's platform yet, though
CI's runners found one.

**Fix:** hold it until it has; never pin a different version than the bot proposed.

## F13: A group broken only by its ratatui or crossterm minor

**Symptom:** a `cargo-minor-and-patch` PR whose bumps include a ratatui or crossterm
minor (the survey marks it `(major)`) fails in `Rust Core` or `macOS`, and every error is
in the binary crate's TUI module (`src/tui/`): a compile error against a ratatui or
crossterm item that was renamed, moved, or removed, or a `TestBackend` view test whose
expected cells no longer match. Every other job and step passes.

**Cause:** Dependabot reads a 0.x minor as a minor and groups it with compatible bumps,
but below 1.0.0 a minor may break the API. The group's other bumps are untested, not
broken: as in F2, the failure blames one move, not the rest.

**Fix:** split the group, as `SKILL.md` › "Migrations: ratatui, crossterm, clap" says. The
ratatui move takes its own migration branch (Step 4c); the other bumps are eligible for
the combined branch only, under the combined-branch bar in `SKILL.md` › "Step 3", whose
own CI is their first real signal. The group PR closes only after both replacements
merge.

- An error outside the TUI, or in a crate other than ratatui's family, is diagnosed under
  its own entry and is never waved through as the migration.
- A view test that fails is the rendering change made visible: never edit its expected
  cells to pass without the human's decision (`SKILL.md` › "Stop and ask").

Where to read the log: the command at the top of this file.
