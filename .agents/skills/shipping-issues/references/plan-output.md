# Reading `plan.py`'s block

`plan.py` prints preflight, ranking, selection, the repo profile and the parallel
grouping as one block from a single `gh` fetch. Read the block; do not re-derive any of
it. This file is the field-by-field legend — SKILL.md step 1 keeps only the two fields
that carry a duty for the calling session.

## Table of Contents

- [Fields](#fields)
- [Caching](#caching)

## Fields

- `preflight:` — `BLOCKED` stops the run. `host: cloud` with a `next:` line means a
  Claude Code cloud session: stop and use the skill the `next:` line names. `tree: DIRTY` is a question to ask **now**,
  before any branch is cut. `existing-worktrees:` with a `BLOCKED` verdict means worktrees
  already sit under this run's own root: an earlier run that did not clean up, or one
  happening right now. That is a stop condition, not a leftover to reuse — the branches
  inside are stale, and provisioning over them would implement on top of a branch this
  run never created. Confirm nothing is running in them, remove them with
  `cleanup_run.sh --worktree-root <runstate>/worktrees`, and re-plan.
- `profile:` / `verify-check:` — the package and hook managers (`cargo` and `lefthook`
  here), and the repository's gate as a guess: a `verify`, `check` or `test` recipe in
  the justfile, then a Makefile target, then `cargo test` for a `Cargo.lock`. In this
  repository it reads `just check`. **It is never run as a baseline**: CI is the gate
  every PR merges through, and `just check` runs `fmt` first, so it rewrites the tree it
  would judge and costs a cold build plus the coverage runs. Implementers run the
  narrowest check that can fail (`AGENTS.md` › "Validating a change"). A run that has a
  reason to baseline (a `main` suspected red) passes `--verify "<command>"` to
  `worktree_setup.sh` deliberately and says which command it used in the step 10
  report.
- `github:` — `write=no` means the label and follow-up writes will exit 2: rank from
  `~P<n>` suggestions and report findings instead of filing them.
- `labels:` — `COMPLETE` means every tier is settled, so step 2 is skipped.
- `contract:` — how much of the backlog states its own facts
  (`ship-contract.md`). Informational during the run; it is what a
  `PARTIAL` grouping traces back to.
- `grouping:` — **always a proposal**, never a decision; SKILL.md step 2c confirms it.
  `MECHANICAL` means every issue in it declared its paths, so the proposal rests on
  stated facts · `PARTIAL` means at least one did not, so part of it rests on dependency
  edges alone · `SERIAL` means one issue at a time, no worktrees.
- `select:` / `batch A:` / `branch:` — the pick, everything that can be worked beside
  it, and the branch name already derived for each. Use those names. A named issue
  (`--mode <N>`) overrides only the design hold: when it is blocked, held by a label, or
  has an open PR, the line reads `select: none — #N is not ready: <readiness>`
  (`select_hold` in `--json`), and nothing is shipped — report why instead. A named
  tracking issue reads `select: none — #N is a tracking issue`: ship a sub-issue.
- `tracking:` — issues labelled `tracking` (or `epic`): dropped before ranking, never
  tiered, never selected. Their sub-issues are the work.
- `needs-design:` — the input to SKILL.md step 8b's sweep. Start that round at step 1,
  before step 3: in the background it costs the shipping path nothing to wait on, and
  starting now is what gets those issues unblocked while the run is still going.
- `stale-labels:` — issues still labeled `blocked: dependency` although every dependency
  is closed. Readiness already ignores that label, but a human reading the backlog does
  not — run the `--clear-dependency` command the line prints, without asking. The same
  line after a merge (the re-plan at step 8c) is how the issues that merge just
  unblocked get cleared.
- `next:` — the exact command step 3 starts with.

`--record` writes `run-start`, `selection` and (in parallel mode) `parallel-group` to
the run record, so those are not separate calls.

## Caching

`plan.py` caches its `gh` fetch for 300 seconds so the startup's own calls do not
re-fetch. `issue_digest.py` does **not** cache unless asked (`--cache-ttl`), so an
ad-hoc call after a merge always reads the real backlog. Pass `--refresh` on any re-plan
inside that 300-second window after this run changed something.

Issue bodies come from the same fetch — one more call, not three:

```bash
python3 .agents/skills/shipping-issues/scripts/issue_digest.py --select 3 --with-rank \
    --detail-top 3 --body-chars 700
```

`--detail-top K` reads the top K without narrowing the ranking. Listing the numbers by
hand in three separate calls is three `gh` round-trips over data the plan already
fetched.
