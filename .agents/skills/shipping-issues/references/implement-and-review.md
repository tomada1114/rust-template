# Implement, then fix the PR review's findings (steps 3 and 5)

The detail behind [SKILL.md step 3](../SKILL.md#3-implement) — from a branch cut off the
default branch to an implemented, judged, pushed branch with no PR yet — and the fix half
of [step 5](../SKILL.md#5-wait-for-the-pr-review), where the PR's own review comes back
and its accepted findings are fixed on that same branch. No local review pass runs in
between: the review is the pull request's. Read it before the first step 3 of a run.

## Table of Contents

- [Setting up the branch](#setting-up-the-branch)
- [Handing off the implementation](#handing-off-the-implementation)
- [Judging the result](#judging-the-result)
- [Triaging the review's findings](#triaging-the-reviews-findings)
- [Fixing the accepted findings](#fixing-the-accepted-findings)

## Setting up the branch

One issue = one branch = one PR. Step 1's `next:` line is the command.

**Serial** —
`git switch <default_branch> && git pull --ff-only && git switch -c <branch>`. No
baseline run follows: CI is the gate every pull request merges through, so a full
`just check` before implementing — or before opening the PR — costs a cold build and
the coverage runs and proves nothing CI will not prove again. The implementer runs the
narrowest check that can fail for what it changed (`AGENTS.md` › "Validating a
change"), and CI judges the whole.

**Parallel** — the script creates each branch and checks the shared lefthook hook; it
installs nothing, since cargo builds on demand into each worktree's own `target/`. It
**reports and does not decide**:

```bash
git switch <default_branch> && git pull --ff-only   # once, before the batch
.agents/skills/shipping-issues/scripts/worktree_setup.sh --spec <n>:<branch> \
    --spec <m>:<branch> --base <default_branch> --root <runstate>/worktrees \
    --log-dir <runstate>/verify
```

**Provision the first worktree on its own, read its block, then ask for the rest** —
that one extra call is what stops a repo that cannot carry a worktree from costing two
cold builds instead of one. `--verify` still exists for a run with a reason to baseline
(a `main` suspected red); only then is there a `baseline:` outcome to judge
(`recovery.md` › "A red baseline"; `verdict:` semantics in `worktree-parallelism.md` ›
"Viability gate"). Read exit codes and log tails, never full output; what the setup
turns up goes to step 8.

## Handing off the implementation

Fill `agent-implementation.md` per issue
(`delegation-templates.md` holds the rules every brief shares).
Where the host has named sub-agents, hand it to **`executor`** by default and to
**`architect`** when the issue is foundational — blast radius, not difficulty
(the foundation exception: `cost-discipline.md` › "The foundation exception: architect for what the backlog builds on").
A change small enough that the handoff costs more than the work is implemented here
rather than handed off
(the floor: `cost-discipline.md` › "The floor: too small to delegate"). With no tiers — a
session where `.claude/agents/` did not load — follow the brief inline, one issue at a
time, and run the batch **serial**: plan with `--max-parallel 1` and create no
worktrees. Each worktree costs a cold cargo build into its own `target/`, and with one
writer working through them in turn it buys no concurrency.

In parallel mode hand off every brief in the batch **before waiting on any** — in one
message where the host batches spawns — each with its own worktree path, never the main
checkout.

## Judging the result

**Judge each result in this context**, against the issue and step 2b's decision. What
each returned field is for:

| Returned field               | Consumed                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCEPTANCE`                 | **Here, first.** A `not-met` line is work still owed. Sending it back costs one patch round; letting it through merges a PR that closed an issue it did not answer. Green CI does not cover this — it proves the repository still works, not that the issue was answered. |
| `UNRESOLVED`                 | **Here.** Judgment calls the agent made alone: each is accepted (and stated at step 10) or sent back, never silently inherited.                                                                                                                                           |
| `PR-SUMMARY` / `TEST-PLAN`   | [Step 4](../SKILL.md#4-open-the-pr), verbatim.                                                                                                                                                                                                                            |
| `MEASURE`                    | [Triage](#triaging-the-reviews-findings) — what the PR review's findings are checked against.                                                                                                                                                                             |
| `SCOPE-NOTES` / `FOLLOW-UPS` | [Step 8](../SKILL.md#8-close-out-the-findings-the-run-turned-up).                                                                                                                                                                                                         |

A user-visible change with no `CHANGELOG.md` entry under `[Unreleased]` goes back the
same way as a `not-met` line (`create-pr`). So does a branch whose `<workdir>` is dirty
(`git status --short` not empty, such as an uncommitted `just fmt` rewrite) or whose
pushed head differs from its local head: the PR must carry exactly what was checked.

At most **2 patch rounds** on top of the first run, on the same tier — continuing the
same agent where the host allows, a fresh one only on a tier change. A third miss is
`NEEDS-CLARIFICATION`, not another round. A run that returned without a report, stopped
before pushing, or missed or widened the spec: `recovery.md` — never
re-spawn an agent that returned without its report.

## Triaging the review's findings

`review_watch.py` ([step 5](../SKILL.md#5-wait-for-the-pr-review)) numbers the PR
review's findings `F1`, `F2`, … in review order — a later round's are appended — one line
each with its priority badge, `path:line` and `round=`, and writes their bodies to the
file its `findings_file:` line names. Read every body there — never in the PR
conversation, which pulls the whole thread into this context — and only then decide
anything. The review read the diff in a context that did not write it; this session
wrote or judged the diff, so it is the one that triages.

Classify **every** finding of the round being handled (`round:`; earlier rounds' are
classified already), each with a one-line reason:

- **accepted** — real, and it belongs in this diff: the same behavior change the issue
  is about, tests included. A sibling case of the bug just fixed belongs here; a schema
  change or a new public surface does not, however small the patch looks
  (`filing-followups.md`).
- **rejected** — wrong on reading the code: the case is already handled, or the fix
  would change behavior the issue did not ask to change. The reason has to hold against
  the code, not against the badge — a `P1` is not accepted for its color, and a `P3` is
  not rejected for it either.
- **out of scope** — real but not this diff's:
  [step 8](../SKILL.md#8-close-out-the-findings-the-run-turned-up).

The round decides what an **accepted** finding costs this PR, never how it is
classified (the rounds: `pr-ci-merge.md` › "Waiting for the PR review"): in round 1 every
accepted finding is fixed here; in rounds 2 and 3 an accepted `P0`–`P2` (or unbadged
`P?`) is fixed here and an accepted `P3` goes to step 8 as a follow-up, like an
out-of-scope one. Past the cap, in round 4 or later, only `P0`, `P1` and `P?` are
triaged, and an accepted one holds the PR (`--field reason=review-cap`) instead of
starting a fourth fix round; the rest are named at step 10, untriaged.

A finding that needs an owner's decision, or a correctness finding this session cannot
settle either way, holds the PR: record `--event blocked --field reason=review-finding`
and put it in the step 10 report. Green CI cannot dismiss it. Never reply to or resolve
a review thread, and never ask the reviewer to look again (`@codex review`): neither is
in the sign-off. A fix push may start another review on its own; step 5 waits for it.

## Fixing the accepted findings

Apply them **in the branch's own `<workdir>`** — never the main checkout in parallel
mode, which sits on the default branch: inline, or by handing
`agent-review-fix.md` to **`executor`** with the accepted findings as its
list. A review with zero accepted findings gets no fix run. **Keep the
`review_watch.py` numbers** — the fix brief returns `APPLIED`/`REJECTED` against those
same `F<n>`, and without them the returned lines cannot be matched back to what was
sent.

When anything other than this session wrote the fixes, **reading what the fix pass
changed is the safeguard**: `git diff <pre-fix-head>..HEAD` in `<workdir>`, not the whole
branch. Revert what it got wrong. Read every `REJECTED` line — a rejection that reads like
a real defect goes back with the reason addressed; real-but-out-of-scope goes to step 8.
Run the narrowest checks the fixed lines need **in `<workdir>`**, then push. The push is a new head: the
earlier CI verdict says nothing about it, so step 6 watches again, and alongside it
`review_watch.py <pr> --after-push <sha>` waits the start grace for a review of it
(`pr-ci-merge.md` › "Waiting for the PR review"): the next round, or `NO_NEW_REVIEW`.
After round 3's fixes nothing more is waited for — local verification and current-head
CI cover them.

Record each round once its triage is done, and a `NO_NEW_REVIEW` when it comes:
`--event review --field issue=<n> --field pr=<pr> --field round=<k> --field verdict=<CLEAN|FINDINGS|NO_NEW_REVIEW|NO_REVIEW|ERROR> --field reviewed=<sha> --field findings=<n> --field accepted=<n> --field rejected=<n> --field out-of-scope=<n> --field followup=<n> --field fixed-in=<sha>`
— `findings` counts that round's (`round_findings:`), `followup` the accepted ones sent to
step 8 by their badge, and `fixed-in` names the commit that addresses the fixed ones, so
the report can say which commit answered which round.
