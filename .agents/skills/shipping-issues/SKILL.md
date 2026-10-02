---
name: shipping-issues
description: >
  Covers taking open GitHub issues in this repository to a merged pull request and a
  closed issue: ranking them by their priority: P0-P3 labels (backfilling a missing
  tier from how much an issue unblocks), implementing the top one, reviewing the branch
  with /code-review, opening a PR that says Closes #N, watching CI to green, merging
  with no approval pause, and returning the checkout to main. With no argument it
  ships the top issue and what that run itself produced; with "all" it works through
  every ready issue in dependency order, independent ones in at most two parallel git
  worktrees (each has its own cargo target/), PR, CI, and merge still one at a time.
  Scripts: plan.py, issue_digest.py, worktree_setup.sh, ci_watch.sh, land_pr.sh. Use
  when asked to ship the remaining issues, take on the next issue, ship issue N, or
  clear the ticket backlog.
---

# Shipping Issues

**Owns:** taking open issues to a merged pull request and a closed issue. **Does not
own:** the label vocabulary and what an issue body must hold (`triaging-issues`); which
outcome comes first (`steering-the-roadmap`); test-first work in core (`tdd`); the PR
body's content rules (`create-pr`).

**Done means all three:** the PR is merged, the issue is closed, and nothing was deleted
or weakened to get there. Green CI is the go-ahead: merge in the same turn.

**Invoking this skill is the sign-off for exactly these remote writes** (`AGENTS.md` ›
"Security and human approval", standing exceptions): `priority:` and `blocked:` labels
on open issues; branches and their pushes; the pull request; merging it once CI passes;
the follow-up issues and comments the run files; and removing the branches and worktrees
the run created. Nothing else on that list: a force push, `--no-verify`, a weakened
gate, entitlements or signing, a release tag, a new dependency, `just labels`, and
`just ruleset` stop the run and go to the human.

The only pauses: the [stop conditions](#stop-conditions), a tied top two (step 2),
`NO_CHECKS` with no local gate (step 6), a PR held for a human's evidence (step 7).

## Modes

| Argument | Behavior |
|---|---|
| _(none)_ | Ship the top shippable issue, then only **its own output** (step 8c). |
| `all` | Every shippable issue in dependency-then-priority order; independent ones implemented in parallel worktrees, PR/CI/merge one at a time. |
| a number | That issue, once nothing it depends on is open. |

A count sets `--max-parallel`, default **2**: every worktree of this Cargo workspace
builds into its own `target/` from cold, gigabytes each (5.3 GB: observed on this Mac
with `du -sh target`, 2026-09-29) and a full compile before its first check says anything.
A `blocked: design` issue ships only when named, or with `--include-design` (step 2b).

## Working rules

- **One checkout, one writer**, fixed at step 1: **serial** works in the main checkout;
  **parallel** gives each issue `<runstate>/worktrees/<n>`. Only steps 3 and 4 run
  concurrently; every GitHub call stays in this session, one PR at a time.
- **Nothing waits on the user mid-run.** Never `rm`: `mv` into
  `<runstate>/holding/<n>/`, `git rm`, or `git checkout --`, and defer anything else
  that needs approval to the end ([closing-out.md](references/closing-out.md)).
- **Never take over the Mac.** No step or sub-agent runs a human's recipe
  (`just test-local`, and the rest `AGENTS.md` › "Never taking over the developer's Mac"
  lists); `just test-platform` and `just logs` are the run's evidence.
- Every issue starts from, and every merge returns to, an up-to-date `main`.
- **REQUIRED:** the reference a step links, read when that step starts: each step
  below is only the summary of its procedure.

## Sub-agents and run state

Spawn by `subagent_type` (`executor`, `architect`, or `worker`, as
[cost-discipline.md](references/cost-discipline.md) assigns each step), never a bare
`model`, with the prompts in
[delegation-templates.md](references/delegation-templates.md). A resume goes to the same
agent by `SendMessage` while it is reachable. Codex CLI has neither (that file cites why):
run each such step inline with the same prompt as its brief.

Everything the run generates lives under `<runstate>`, never in a checkout; record
events as they happen with `run_record.py` ([run-record.md](references/run-record.md)).
**Requires:** `git`, `python3`, `gh`. Scripts run from the main checkout's root as
`.agents/skills/shipping-issues/scripts/<name>`.

## 1. Plan

```bash
python3 .agents/skills/shipping-issues/scripts/plan.py --mode <all|single|N> \
    [--max-parallel N] [--label L] [--include-design] --record
```

Read the block; do not re-derive it ([plan-output.md](references/plan-output.md),
[ship-contract.md](references/ship-contract.md)). `preflight: BLOCKED` and
`existing-worktrees: BLOCKED` stop the run; ask about `tree: DIRTY` now. `verify-check:`
is never run as a baseline: CI is the gate every PR merges through, so nobody runs the
full `just check` before the PR. `needs-design:` spawns 8b now; `stale-labels:`
runs unasked; `labels: COMPLETE` skips step 2; `github: write=no` only reports.

## 2. Label the unlabeled

Three or fewer: read them against [priority-rubric.md](references/priority-rubric.md) and
run `apply_priority_labels.py --backfill --set N=P0 --quiet`. More, or a close top two:
one `architect` with [agent-priority-research.md](references/agent-priority-research.md).
Re-plan (`--refresh --record`) and go on without asking.

## 2b. Decide a design that gates the pick

Only for a design-blocked pick taken on deliberately: decide, record, and clear it
before step 3 ([dependency-triage.md](references/dependency-triage.md)).

## 2c. Confirm the proposed batch

The plan proposes; this step decides. Look for what a script cannot see: two issues both
editing `Cargo.toml`, a workflow, `src-tauri/src/lib.rs`'s
`generate_handler!`, or both regenerating `ui/src/ipc/generated/` (a `CHANGELOG.md`
entry is not a collision). Take the narrower grouping on any disagreement; shrinking
never needs asking ([dependency-triage.md](references/dependency-triage.md)).

## 3. Implement

One issue, one branch, one PR; the plan's `next:` line is the command (serial: the
branch; parallel: `worktree_setup.sh` without `--verify`, the first worktree alone;
[worktree-parallelism.md](references/worktree-parallelism.md)). No baseline, no full
`just check` before the PR: CI is the gate; implementers run the narrowest check. Spawn
[agent-implementation.md](references/agent-implementation.md) per issue, a batch in one
message. A `not-met` `ACCEPTANCE` line, an unaccepted `UNRESOLVED` call, or a
user-visible change with no `CHANGELOG.md` entry goes back; a third miss is
`NEEDS-CLARIFICATION` ([implement-and-review.md](references/implement-and-review.md),
[recovery.md](references/recovery.md)).

## 4. Review the branch

```text
/code-review medium <branch> [--fix]
```

One pass per branch before any PR, effort first: `medium` by default, `high` only on
the triggers in [cost-discipline.md](references/cost-discipline.md), never `low` or
`ultra`. `--fix` is serial-only; in parallel, numbered findings go to one `executor` per
branch ([agent-review-fix.md](references/agent-review-fix.md)). Where `/code-review`
cannot run (Codex CLI), a read-only `architect` reviews instead
([agent-review-fallback.md](references/agent-review-fallback.md)). Read what the fix
changed, re-verify, push, record `--event review`.

## 5. Open the PR

Serial from here to step 7 in both modes. Push; no commits means `SKIPPED(<why>)`. From
the worktree, `git status --short` must be empty and the pushed head equal the local
head; a dirty tree goes back to the implementer, never pushed as is. Open
the PR against `main` from `.github/PULL_REQUEST_TEMPLATE.md`: `PR-TITLE`, then
`PR-SUMMARY`, **`Closes #N`**, the Release impact line (`create-pr`), and `TEST-PLAN`,
ticking only checklist items that actually ran. Record `--event pr-created`, then run
`link_check.sh <pr> --issue <n> --fix` ([pr-ci-merge.md](references/pr-ci-merge.md)).

## 6. CI to green

Once the new head commit shows among the PR's runs, run `ci_watch.sh <pr> --timeout
3600` into `<runstate>/ci/<pr>.log` with `run_in_background` (`macOS Build & Smoke` may
take its full 60 minutes), or in the foreground under 540 s, re-run on `TIMEOUT`
([pr-ci-merge.md](references/pr-ci-merge.md)). `FAIL` goes to
[agent-ci-repair.md](references/agent-ci-repair.md), 3 attempts at most; anything else to
[recovery.md](references/recovery.md). `PASS` goes to step 7 in the same turn.

## 7. Merge and confirm the issue closed

A PR that needs `just test-local` output is **held**, not merged:
comment what the human should run, record `--event blocked`, and move on
([pr-ci-merge.md](references/pr-ci-merge.md), "Held for a human's evidence"). Otherwise
run `land_pr.sh <pr> --issue <n>` and read `result:` and `issue:`
([landing-outcomes.md](references/landing-outcomes.md)). Record `--event merged`, then
`git switch main && git pull --ff-only`. **Clear what the merge unblocked**, as
`triaging-issues` asks of whoever lands a blocker: re-plan with `--refresh` and run its
`stale-labels:` command. Then take the next issue.

## 8. Close out what the run turned up

Each defect outside the issue is fixed in the open diff, filed and shipped now (8c), or
filed and left ([filing-followups.md](references/filing-followups.md)): `file_followup.py`
right after the PR that surfaced it lands, then `--event followup`.

## 8b. Unblock held designs in the background

Each `needs-design` issue gets one `architect` with
[agent-design-decision.md](references/agent-design-decision.md): spawn and move on, at
most 3 in flight. `DEFERRED` is a correct outcome.

## 8c. Take the run's own output back into the queue

Before cleanup, re-plan (`--refresh --allow-existing-worktrees`) and ship step 8's
follow-ups and step 8b's unblocked issues through steps 3 to 8 when all hold: depth 1,
the readiness gate in [dependency-triage.md](references/dependency-triage.md), and budget
left. Otherwise name them at step 10.

## 9. Clean up

Once, after the last merge: one `cleanup_run.sh` call naming every branch this run
created with `--branch` (without it, it deletes every merged-PR branch in the
repository), plus `--worktree-root <runstate>/worktrees` when the run made worktrees.
Then persist a probed worktree verdict and offer the holding area in one final
approval-gated call ([closing-out.md](references/closing-out.md)).

## 10. Report

No fixed format, a fixed list of facts ([closing-out.md](references/closing-out.md)):
above all, every PR held for a human's evidence, any issue open behind a merged PR, any
`not-met` criterion, and every `DEFERRED` question.

## Stop conditions

Stop and report when the plan is `BLOCKED`, a dependency cycle or a merge conflict
needs a human, the same CI failure survives the retry ceiling on two issues, or a fix
needs a write this skill's sign-off does not cover.

Also stop on **a change this run did not make**: a dirty main checkout no step touched,
a branch moved underneath you, `main` ahead of the last merge, a worktree under this
run's root it did not create. Prove it is not yours, leave it exactly as found, record
`--event blocked`, and ask ([recovery.md](references/recovery.md)).

In `all` mode one failed issue does not stop the run: mark it FAILED, skip its
dependents, continue. A background `DEFERRED` design never stops a run.
