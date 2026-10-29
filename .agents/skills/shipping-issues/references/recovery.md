# Recovery

Read when something in the workflow does not go the way step 3–7 assume. None of this
belongs in the hot path: every case here is a branch the run takes occasionally, and
carrying it in SKILL.md costs the whole prompt on every run to save one file read on a
few of them.

## Table of Contents

- [After a context compaction](#after-a-context-compaction)
- [A sub-agent returned without its report](#a-sub-agent-returned-without-its-report)
- [A sub-agent stopped before pushing](#a-sub-agent-stopped-before-pushing)
- [The implementation missed or widened the spec](#the-implementation-missed-or-widened-the-spec)
- [`--fix` and why it is serial-mode only](#--fix-and-why-it-is-serial-mode-only)
- [`/code-review` cannot be launched](#code-review-cannot-be-launched)
- [CI reports the previous commit](#ci-reports-the-previous-commit)
- [CI fails](#ci-fails)
- [`NO_CHECKS`, `ERROR`, and other non-verdicts](#no_checks-error-and-other-non-verdicts)
- [Bringing the rest of a parallel batch up to date](#bringing-the-rest-of-a-parallel-batch-up-to-date)
- [A merge conflict](#a-merge-conflict)
- [A red baseline](#a-red-baseline)
- [A worktree that will not go away](#a-worktree-that-will-not-go-away)

## After a context compaction

A long run outlives its own context: the host compacts it, and what survives is a
summary that may have dropped which PR is open, which attempt CI repair is on, or what
is held for the final confirmation. **Re-read `<runstate>/run.md` before the next step
that writes** — after any compaction, and whenever unsure what this run already did. It
is append-only and written as each event happens (`run-record.md`), so it
is the run's own account of itself; then confirm against GitHub and `git` before acting,
never re-run a write the record already shows landed.

## A sub-agent returned without its report

**It has still done work.** A run can come back with nothing but "waiting on the
background verification" — it started a long command in the background and returned
while polling it. Its edits, and sometimes its commit, are on disk.

Never re-spawn it. Read, in that issue's own working directory:

```bash
cd <workdir>
git status --short
git log --oneline <base>..HEAD
git rev-list --count origin/<branch>..HEAD   # unpushed commits
```

Then finish the last steps from this session: verify the diff, run the gate, commit and
push. This is the cheapest recovery in the run — re-spawning would redo work already
done or, worse, duplicate it. The delegation templates tell agents to verify in the
foreground for exactly this reason; this is what to do when one does it anyway.

## A sub-agent stopped before pushing

Same reading, same rule: don't retry blindly. Resume with a new run naming only what is
left, or record `--event blocked` if nothing landed at all.

## The implementation missed or widened the spec

Judge the result in this context, against the issue and the design decision: start from
`git diff --stat <base>...HEAD`, run with `<workdir>` as the working directory — `<workdir>` is the main checkout in
serial mode and that issue's worktree in parallel mode, and running it in the wrong
directory reports on the wrong branch — plus the sub-agent's own `CHANGED` /
`SCOPE-NOTES` / `UNRESOLVED`. Open the hunks only in the files the spec actually
touches, not the whole diff by default.

Missing part of the spec, or quietly widened: send a patch round naming only what is
left — continuing the same agent where the host allows, otherwise a new run on the same
tier as the first. Don't re-run the whole task. Up to **2** resume/patch runs on top of
the first; a third miss means the issue itself is underspecified, so record
`--event blocked` and report `NEEDS-CLARIFICATION` instead of spawning again.

## `--fix` and why it is serial-mode only

`/code-review … --fix` applies findings to _this session's_ working tree — the main
checkout. In serial mode that is the branch under review, which is the point. In
parallel mode the branch is checked out in a worktree and the main checkout is sitting
on the default branch, so `--fix` would write another branch's repairs into the main
checkout and leave it dirty — the exact state
[Stop conditions](../SKILL.md#stop-conditions) treats as someone else's work.

The review itself reads `<base>...<branch>` from the shared object store and is safe
from anywhere; only the writing half is not. So in parallel mode: review each branch
without `--fix`, triage the whole batch, then spawn one `executor` fix run per branch
with accepted findings, scoped to that branch's worktree, using
[agent-review-fix.md](agent-review-fix.md).

## `/code-review` cannot be launched

Host won't let this session run the slash command → one independent, **read-only**
`architect` sub-agent against the branch, using
[agent-review-fallback.md](agent-review-fallback.md), triaged the same way. Never
re-read your own diff and call that a review.

## CI reports the previous commit

The checks API still serves the PREVIOUS commit's results for a minute or two after a
push, so a watch started too early returns that run's verdict — and a stale PASS is
worse than a stale FAIL. Wait for the PR's new head commit to actually appear among the
branch's CI runs before starting `ci_watch.sh`.

## CI fails

Fill `agent-ci-repair.md` and run it — inline, or by `executor` for
attempts 1–2 and `architect` once the same failure has survived two attempts in a row
(the second attempt continues the first agent where the host allows) — its work
directory set to whichever checkout holds the branch: the main checkout in serial mode,
that issue's worktree in parallel mode. Up to **3 attempts**. `PUSHED: no` ends the
loop.

A test deleted, skipped, or weakened to pass, or a "flaky" re-run without a diagnosis,
is a **failed outcome**, not a green one.

## `NO_CHECKS`, `ERROR`, and other non-verdicts

- `NO_CHECKS` → run the project's own gate locally (the plan's `verify=` line names it:
  `just check` here) and merge on a local green. No such command at all → ask first; this is
  one of the run's two narrow pauses.
- `verdict: TIMEOUT` → CI has not settled yet. Re-run `ci_watch.sh` until the watches
  add up to 3600 s in total
  (`pr-ci-merge.md` › "Waiting inside the command timeout");
  past that, treat it as `ERROR`.
- `verdict: ERROR` → re-read the actual PR/CI state before treating it as a green. An
  error is not a pass. With `unsettled_checks:`, the watch ended while those checks were
  still running, or a check came back `STALE` (its result is for an outdated state): run
  the same watch once more. "head moved … during the watch" means a push landed
  mid-watch: watch again, for the new head.
- `land_pr.sh` has twelve possible results and two of them must never read as success:
  `landing-outcomes.md`.

## Bringing the rest of a parallel batch up to date

After each merge, the batch's remaining branches are behind the default branch. Bring
each one up to date **in its own worktree, before its own PR** rather than after a CI
failure:

```bash
cd <runstate>/worktrees/<m>
git fetch origin <default_branch> --quiet
git merge origin/<default_branch>
git push
```

**Merge, not rebase** — step 3 already pushed these branches, so a rebase would need a
force-push, and this run does not force-push. A repository that requires linear history
is a stop condition, not an exception: record
`--event blocked --field reason=linear-history` and ask the human.

## A merge conflict

A conflict between two branches of the same batch means the grouping call was wrong for
that pair — either the plan was `PARTIAL` and the proposal was taken at face value, or
two issues touched the same ground without declaring it. Resolve it in that worktree
only if the conflict is mechanical. Otherwise record
`--event blocked --field reason=merge-conflict`, report it, and move on.

Worth doing either way: add the missing `touches=` to both issues' ship contracts (or
note it in the report) so the next run's grouping is mechanical where this one had to
guess.

## A red baseline

Only a run that passed `--verify` to `worktree_setup.sh` has a baseline (this skill does
not by default: CI is the gate). A red one is **the repository's problem, not the
issue's**, and finding it before an implementation run costs one command instead of a
wasted spawn. Read the exit code
and the log's tail, never the full output.

`worktree_setup.sh` reports and does not decide: it tears nothing down and draws no
verdict about the repo. Judging the four `baseline:` outcomes is the calling session's,
and this is the whole list:

| `baseline:`                                 | What it means                                                            | What to do                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`                                      | Nothing to judge.                                                        | Provision the rest of the batch.                                                                                                                                                                                  |
| `FAIL` in the worktree, main checkout green | Usually not worktree-viable in this run — but not always.                | Read the log's tail first: an absolute path in a config, a service the tests expect running, a fixture that exists only in the main checkout all fail this way and are fixable. Not fixable → the fallback below. |
| `FAIL` in the main checkout too             | The repository is broken, and it is not this issue's problem.            | A step 8 finding. The run may still be shippable on top of it — decide, and say which in the report.                                                                                                              |
| `TIMEOUT`                                   | The verify command never finished, so **nothing was proved either way**. | Almost always the wrong command was confirmed at step 1 — a watcher, a dev server. Pick the right one and re-run the baseline. Never treat it as a red baseline.                                                  |

When the default branch's CI is green but the local baseline is red, suspect the
environment first: compare against that CI run, then re-run the failing suite with the
suspect variables unset (for example `env -u GIT_CONFIG_COUNT ...`) to confirm. The uv-template repository met
this (observed): the `GIT_CONFIG_*` url rewrites a Claude Code cloud session exports failed
the baseline while the default branch stayed green.

Before concluding the repository is broken, read the red baseline against what is
actually in the tree: an untracked build or package-manager cache in the repo root can
fail the baseline on its own — for example a cache directory holding a unix socket,
which a test helper that copies untracked files hits with a bare `ENOTSUP`. This is why
the dirty-tree question is asked at plan time, before the baseline, rather than after
it.

Once "not worktree-viable" is concluded, remove that worktree
(`git worktree remove --force <path> && git worktree prune`) and record the verdict so
later runs skip the probe:

```bash
.agents/skills/shipping-issues/scripts/preflight.sh --profile-cache <runstate>/repo-profile.json \
    --set-worktree-viable no
```

Then fall back to serial and say so in the step 10 report. Record `yes` the same way
after a batch provisions cleanly — that is what lets the next run's plan skip the gate
entirely. A recorded `no` holds only while the profile matches: once a lockfile, a
build-config file, or `preflight.sh`'s detection logic changes, it returns to `unknown`
and the next run probes again, while a recorded `yes` carries over.

## A worktree that will not go away

`cleanup_run.sh` runs the worktree pass first because a branch checked out in a worktree
cannot be deleted. **Anything gitignored inside a worktree is lost with it** — a fixture
or benchmark output an implementation run produced and did not commit has to be copied
into the main checkout before cleanup, which is why the implementation template tells
sub-agents to do exactly that.
