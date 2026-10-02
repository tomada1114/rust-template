# Reading `plan.py`'s block

`plan.py` prints preflight, ranking, selection, the repo profile and the parallel
grouping as one block from a single `gh` fetch. Read the block; do not re-derive
any of it. This file is the field-by-field legend -- SKILL.md step 1 keeps only
the two fields that carry a duty for the calling session.

## Table of Contents

- [Fields](#fields)
- [Caching](#caching)

## Fields

- `preflight:` -- `BLOCKED` stops the run. `tree: DIRTY` is a question to ask
  **now**, before any worktree is provisioned. `existing-worktrees:` with a `BLOCKED` verdict
  means worktrees already sit under this run's own root: an earlier run that did
  not clean up, or one happening right now. That is a stop condition, not a
  leftover to reuse -- the branches inside are stale, and provisioning over them
  would implement on top of a branch this run never created. Confirm nothing is
  running in them, remove them with
  `cleanup_run.sh --worktree-root <runstate>/worktrees`, and re-plan.
- `profile:` / `verify-check:` -- the package and hook managers, and the
  repository's detected full gate, a guess from recipe names: the justfile first
  (here it finds `just check`), then `package.json` scripts, a Makefile, or a
  language default. It is **informational**: nothing runs it as a baseline, and
  no implementer runs it before the PR, because CI is the gate every pull request
  merges through. The `next:` command provisions worktrees without `--verify`.
- `github:` -- `write=no` means the label and follow-up writes will exit 2: rank
  from `~P<n>` suggestions and report findings instead of filing them.
- `labels:` -- `COMPLETE` means every tier is settled, so step 2 is skipped.
- `contract:` -- how much of the backlog states its own facts
  (`ship-contract.md`). Informational during the run; it is
  what a `PARTIAL` grouping traces back to.
- `grouping:` -- **always a proposal**, never a decision; SKILL.md step 2c
  confirms it. `MECHANICAL` means every issue in it declared its paths, so the
  proposal rests on stated facts; `PARTIAL` means at least one did not, so part
  of it rests on dependency edges alone; `SERIAL` means one issue at a time, no
  worktrees.
- `select:` / `batch A:` / `branch:` -- the pick, everything that can be worked
  beside it, and the branch name already derived for each. Use those names. With
  `--mode <N>`, `select: none -- #N is not ready: <readiness>` means the named
  issue has an open blocker, a hold label, or an open PR: naming an issue lifts
  only the design hold.
- `needs-design:` -- the input to SKILL.md step 8b's background sweep.
- `next:` -- the exact command step 3 starts with.

`--record` writes `run-start`, `selection` and (in parallel mode)
`parallel-group` to the run record, so those are not separate calls.

## Caching

`plan.py` caches its `gh` fetch for 300 seconds so the startup's own calls do
not re-fetch. `issue_digest.py` does **not** cache unless asked (`--cache-ttl`),
so an ad-hoc call after a merge always reads the real backlog. Pass `--refresh`
on any re-plan inside that 300-second window after this run changed something.

Issue bodies come from the same fetch -- one more call, not three:

```bash
python3 .agents/skills/shipping-issues/scripts/issue_digest.py --select 3 --with-rank \
    --detail-top 3 --body-chars 700
```

`--detail-top K` reads the top K without narrowing the ranking. Listing the
numbers by hand in three separate calls is three `gh` round-trips over data the
plan already fetched.
