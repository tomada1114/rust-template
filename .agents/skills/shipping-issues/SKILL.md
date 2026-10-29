---
name: shipping-issues
description: >
  Covers taking open GitHub issues in this repository to a merged pull request and a
  closed issue from Claude Code on the developer's machine: ranking them by their
  priority: P0-P3 labels (backfilling a missing tier), implementing the top one,
  reviewing the branch locally with /code-review and fixing its accepted findings,
  opening a PR that says Closes #N, watching CI to green, merging with no approval
  pause, and returning the checkout to main. With "all" it works through every
  ready issue in dependency order, independent ones in at most two parallel git
  worktrees (each has its own cargo target/). Scripts: plan.py,
  ci_watch.sh, land_pr.sh, worktree_setup.sh, file_followup.py, cleanup_run.sh. Use
  when asked to ship the remaining issues, take on the next issue, ship issue N, or
  clear the ticket backlog. Not for Codex (codex-shipping-issues) or a Claude Code cloud
  session (cloud-claude-shipping-issues).
---

# Shipping Issues (Claude Code)

**Owns:** taking open issues to a merged pull request and a closed issue from a local
Claude Code session. **Does not own:** the label vocabulary and what an issue body must
hold, and what is in scope (`triaging-issues`, `AGENTS.md` › "Product"); test-first
work in core (`tdd`); the PR body's content rules (`create-pr`); the same flow from Codex
(`codex-shipping-issues`) or a Claude Code cloud session, `CLAUDE_CODE_REMOTE=true`
(`cloud-claude-shipping-issues`), where this skill never runs. **Done:** branch
reviewed, PR merged, issue CLOSED, nothing deleted or weakened to get there.

**Invoking this skill is the sign-off for exactly these remote writes, for this
invocation, up to and including the merge** (`AGENTS.md` › "Security and human
approval", standing exceptions): `priority:` and `blocked:` labels on open issues,
pushing its own branches, creating the PR, merging it, filing and labelling follow-up
issues, step 8b's design comments, and deleting its own branches and worktrees at
cleanup. Anything else stops and asks: a force-push, a hook bypass, a weakened gate, a
new dependency, `just labels`, `just ruleset`, or a release tag. The
step 4 review plus step 6's `PASS` for the current head is the go-ahead: merge in that
same turn, with no "shall I merge?". The only
pauses are the [stop conditions](#stop-conditions), a tied top two (step 2),
`NO_CHECKS` (step 6), and a PR held for a human's evidence (step 7).

## Modes

| Argument | Behavior |
|---|---|
| _(none)_ | Ship the top shippable issue, then only **its own output** ([step 8c](#8c-take-the-runs-own-output-back-into-the-queue)), never the wider backlog. |
| `all` | Every shippable issue in dependency-then-priority order; independent ones implemented in parallel worktrees, review → PR → CI → merge, the PRs one at a time. |
| a number, e.g. `42` | That issue, once nothing it depends on is open. |

A count sets `--max-parallel`, default **2**: each worktree of this Cargo workspace
builds into its own `target/` from cold, gigabytes each (5.3 GB: observed on this Mac
with `du -sh target`, 2026-09-29). Other hints are `plan.py` filters. A `blocked: design`
issue (or `design=open` in its [ship contract](references/ship-contract.md)) ships only
by number or with `--include-design` ([step 2b](#2b-decide-a-design-that-gates-the-pick)).

## Working rules

- **One checkout, one writer**, fixed once per batch at step 1: **serial** works in the
  main checkout; **parallel** gives each issue `<runstate>/worktrees/<n>` and leaves the
  main checkout clean. All GitHub traffic stays in this session, one PR at a time.
- **Nothing waits on the user mid-run.** Never `rm`: `mv` into `<runstate>/holding/<n>/`
  ([closing-out.md](references/closing-out.md#approval-gated-commands)).
- **Never take over the Mac.** No step or sub-agent runs `myapp tui` or a human's recipe
  (`just test-local`, and the rest `AGENTS.md` › "Never taking over the developer's Mac"
  lists); the tests, `just test-platform`, and `just logs` are the run's evidence.
- **No local baseline, no full `just check` before the PR**: CI is the gate every PR
  merges through. Implementers run the narrowest check that can fail (`AGENTS.md` ›
  "Validating a change").
- **Tiers by name.** A brief goes to the tier [cost-discipline.md](references/cost-discipline.md#tier-assignment)
  assigns, by `subagent_type`, never a bare model; a patch round continues that agent.
- **State lives in `<runstate>`** ([run-record.md](references/run-record.md)), never in
  a checkout: record each event with `scripts/run_record.py` as it happens, and
  **re-read `<runstate>/run.md` after a compaction**
  ([recovery.md](references/recovery.md#after-a-context-compaction)). Scripts run from
  the main checkout's root as `.agents/skills/shipping-issues/scripts/<name>` and need
  `git`, `python3`, and `gh`.

## Workflow

### 1. Plan — one call

```bash
python3 .agents/skills/shipping-issues/scripts/plan.py --mode <all|single|N> \
    [--max-parallel N] [--label L] [--assignee A] [--milestone M] [--include-design] --record
```

Read the block; do not re-derive it ([plan-output.md](references/plan-output.md)).
`preflight: BLOCKED` and `existing-worktrees: BLOCKED` stop the run; ask about
`tree: DIRTY` **now**. `verify-check:` is never run as a baseline. `needs-design:` feeds
step 8b; `stale-labels:` runs unasked; `labels: COMPLETE` skips step 2.

### 2. Label the unlabeled — only when the plan says so

Three or fewer: read them against [priority-rubric.md](references/priority-rubric.md)
and run `apply_priority_labels.py --backfill --set N=P0 --quiet`. More, tangled edges, or
a close top two: [agent-priority-research.md](references/agent-priority-research.md).
Re-plan (`--refresh --record`) and **proceed without asking** unless the top two tie on
every axis. A declared label the repository lacks stops labelling: a human runs
`just labels`.

### 2b. Decide a design that gates the pick

Only for a design-blocked pick: settle, record, and clear it before step 3 ([how](references/dependency-triage.md#deciding-a-held-design)).

### 2c. Confirm the proposed batch

The plan proposes; this step decides. Check each issue's real reach against `touches=`,
and look for what a script cannot see: two issues both editing `Cargo.toml`, a workflow,
the subcommand enum in `crates/myapp/src/main.rs`, or core's re-exports in
`crates/myapp-core/src/lib.rs` (a `CHANGELOG.md` entry is not a collision;
[dependency-triage.md](references/dependency-triage.md#parallel-vs-sequential-all-mode)).
Take the narrower grouping on any disagreement; shrinking never needs asking.

### 3. Implement

**Read [implement-and-review.md](references/implement-and-review.md) first.** Cut the
branch from an up-to-date `main` (parallel: `worktree_setup.sh` as the plan's `next:`
prints it, without `--verify`, the first worktree alone;
[worktree-parallelism.md](references/worktree-parallelism.md)). Run
[agent-implementation.md](references/agent-implementation.md) per issue — `executor`, or
`architect` when foundational — a batch in one message, and **judge each result here**,
`ACCEPTANCE` first. A `not-met` line, an unaccepted `UNRESOLVED` call, or a user-visible
change with no `CHANGELOG.md` entry goes back; at most 2 patch rounds on the same tier,
and a third miss is `NEEDS-CLARIFICATION`.

### 4. Review the branch

Before any PR exists, one pass, no re-review. `/code-review medium <branch> --fix` (effort first, branch second): `medium`
always, `high` only for a change that can lose or corrode existing data or when the user
asked, never `low`, `xhigh`, `max` or `ultra` ([why](references/cost-discipline.md#code-review-effort)).
**`--fix` is serial-mode only** ([why](references/recovery.md#--fix-and-why-it-is-serial-mode-only)):
in parallel mode review without it, one `executor` per branch with accepted findings
(`F1`, `F2`, …) from [agent-review-fix.md](references/agent-review-fix.md). No
`/code-review` → [agent-review-fallback.md](references/agent-review-fallback.md). Triage,
fix pass, record: [implement-and-review.md](references/implement-and-review.md#running-the-review).

### 5. Open the PR

Serial from here to step 7. `git status --short` in the worktree must be empty and the
pushed head equal the local head; a dirty tree goes back to the implementer. Open a regular, non-draft PR against `main` from the PR template: summary,
**`Closes #N`**, the Release impact line (`create-pr`), and the test plan, ticking only
what ran. Record it; `link_check.sh <pr> --issue <n> --fix` ([pr-ci-merge.md](references/pr-ci-merge.md#opening-the-pr)).
No PR review is awaited.

### 6. CI to green

Once the new head shows among the PR's runs, run `ci_watch.sh <pr>` (default 3600 s: a
required job may take its full 30 minutes after a runner queue) into
`<runstate>/ci/<pr>.log` with `run_in_background`, never a hand-rolled sleep loop
([pr-ci-merge.md](references/pr-ci-merge.md#waiting-inside-the-command-timeout)). `FAIL`
→ [agent-ci-repair.md](references/agent-ci-repair.md), 3 attempts at most; anything else
→ [recovery.md](references/recovery.md#no_checks-error-and-other-non-verdicts).

### 7. Merge and confirm the issue closed

A PR whose change needs `just test-local` output or a human's `myapp tui` run is
**held**, not merged: comment what the human should run, record `--event blocked`, and
move on ([pr-ci-merge.md](references/pr-ci-merge.md#merging)). Otherwise, on `PASS` for
the current head, run **in that same turn**
`land_pr.sh <pr> --issue <n> --head-sha <sha>`, `<sha>` from the CI log's `head_sha:`, and read `result:` and `issue:` against
[landing-outcomes.md](references/landing-outcomes.md). Then
`git switch main && git pull --ff-only`, re-plan with `--refresh`, and run its
`stale-labels:` command: clearing what the merge unblocked is the lander's job
(`triaging-issues`). Then take the next issue.

### 8. Close out the findings the run turned up

**Fix it in the open diff** · **file it and ship it this run** · **file it and leave
it**, in that order. **Read [filing-followups.md](references/filing-followups.md) before
filing anything**; file right after the PR that surfaced it lands.

### 8b. Unblock held designs in the background

Every issue filed `--needs-design`, plus step 1's `needs-design:`, gets one `architect`
in the background with [agent-design-decision.md](references/agent-design-decision.md)
([queue and recording](references/delegation-templates.md#design-decision-step-8b)), at
most 3 in flight, while shipping goes on. `DEFERRED` keeps the label; its question goes
to step 10.

### 8c. Take the run's own output back into the queue

Re-plan (`--refresh --allow-existing-worktrees`) and ship this run's own follow-ups and
newly `DECIDED` issues through steps 3–8 when all hold: **depth 1**, **ready** on the
[readiness gate](references/dependency-triage.md#readiness-gate), and
**[budget left](references/cost-discipline.md#run-budget)**
([how](references/closing-out.md#re-queueing-the-runs-own-output)). Otherwise name it at
step 10; never wait on a design still in flight.

### 9. Clean up

**Once, after the last merge, script only.** From `main`, run `cleanup_run.sh` with
**every branch this run created as `--branch <name>`** — without it every merged-PR
branch goes, other people's included — plus `--worktree-root <runstate>/worktrees` when
the run made worktrees. **Deferred approvals come last, in one ask**, as the final tool
call ([details](references/closing-out.md#cleanup-scope)).

### 10. Report

Never omit [these facts](references/closing-out.md#what-the-report-must-not-omit): above
all every held PR, an issue open behind a merged PR, a `not-met` criterion, and every
`DEFERRED` question.

## Stop conditions

Stop the whole run and report when: the plan is `BLOCKED`, a dependency cycle needs a
human to break it, a merge conflict needs a product decision, the repository requires
linear history (`--event blocked --field reason=linear-history`), the same CI failure
survives the retry ceiling on two different issues, or a fix
needs a write this skill's sign-off does not cover.

Also stop on **a change this run did not make**: a dirty main checkout no step touched,
a branch moved underneath you, `main` ahead of the last merge, a worktree under this
run's root it did not create. Prove it is not yours (compare the hunks against your own
branches), leave it exactly as found (no stash, no restore, no commit), record
`--event blocked --field reason=<...>`, and ask.

In `all` mode one failed issue does not stop the run: mark it FAILED, skip its
dependents, continue. A `DEFERRED` design never stops a run.
