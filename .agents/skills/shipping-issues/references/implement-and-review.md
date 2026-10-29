# Implement, then review the branch (steps 3 and 4)

The detail behind [SKILL.md step 3](../SKILL.md#3-implement) — from a branch cut off the
default branch to an implemented, judged, pushed branch with no PR yet — and the fix half
of [step 4](../SKILL.md#4-review-the-branch), the local `/code-review` pass whose accepted
findings are fixed on that same branch before any PR opens. Read it before the first
step 3 of a run.

## Table of Contents

- [Setting up the branch](#setting-up-the-branch)
- [Handing off the implementation](#handing-off-the-implementation)
- [Judging the result](#judging-the-result)
- [Running the review](#running-the-review)
- [Triaging the findings](#triaging-the-findings)
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
| `PR-SUMMARY` / `TEST-PLAN`   | [Step 5](../SKILL.md#5-open-the-pr), verbatim.                                                                                                                                                                                                                            |
| `MEASURE`                    | [Triage](#triaging-the-findings) — what the review's findings are checked against.                                                                                                                                                                             |
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

## Running the review

[SKILL.md step 4](../SKILL.md#4-review-the-branch) runs `/code-review <effort> <branch>`
once per branch, before its PR exists. The effort is `medium` for every branch and `high`
only for a change that can lose or corrode existing data
([cost-discipline.md](cost-discipline.md#code-review-effort)); the effort comes first and
the branch second. The review forks outside this context, so only its findings arrive.

- **Serial mode:** add `--fix`; it applies the findings to this checkout, which is the
  branch under review.
- **Parallel mode:** never `--fix` — the main checkout sits on the default branch
  ([why](recovery.md#--fix-and-why-it-is-serial-mode-only)). Review every branch of the
  batch read-only, triage them all, then hand each branch's accepted findings to one
  `executor` ([agent-review-fix.md](agent-review-fix.md)), all in one message.
- **Host cannot launch `/code-review`:** one read-only `architect` against the branch
  ([agent-review-fallback.md](agent-review-fallback.md);
  [recovery.md](recovery.md#code-review-cannot-be-launched)).

One pass. After the fixes there is no second review: local verification and CI cover them.

## Triaging the findings

Number the findings `F1`, `F2`, … in the order the review lists them, one line each, and
read every one against the code before deciding anything. The review read the diff in a
context that did not write it; this session wrote or judged the diff, so it is the one
that triages. Triage happens **before** anything is written, including when `--fix` is
about to apply them: with `--fix`, read what it applied instead (below).

Classify **every** finding, each with a one-line reason:

- **accepted** — real, and it belongs in this diff: the same behavior change the issue
  is about, tests included. A sibling case of the bug just fixed belongs here; a schema
  change or a new public surface does not, however small the patch looks
  (`filing-followups.md`).
- **rejected** — wrong on reading the code: the case is already handled, or the fix
  would change behavior the issue did not ask to change. The reason has to hold against
  the code, not against the severity.
- **out of scope** — real but not this diff's:
  [step 8](../SKILL.md#8-close-out-the-findings-the-run-turned-up).

A finding that needs an owner's decision, or a correctness finding this session cannot
settle either way, holds the branch: record `--event blocked --field reason=review-finding`
and put it in the step 10 report; no PR opens for it.

## Fixing the accepted findings

Apply them **in the branch's own `<workdir>`** — never the main checkout in parallel
mode: with `--fix` in serial mode, inline, or by handing
[agent-review-fix.md](agent-review-fix.md) to **`executor`** with the accepted findings
as its list (the parallel path). A review with zero accepted findings gets no fix run.
**Keep the `F<n>` numbers** — the fix brief returns `APPLIED`/`REJECTED` against those
same numbers, and without them the returned lines cannot be matched back to what was
sent.

When anything other than this session wrote the fixes — `--fix` included — **reading
what the fix pass changed is the safeguard**: `git -C <workdir> diff <impl-commit>..HEAD`,
not the whole branch. Revert what it got wrong. Read everything it would not apply
(`skipped` / `REJECTED`): a rejection that reads like a real defect goes back with the
reason addressed; real-but-out-of-scope goes to step 8. Run the verification command
**in `<workdir>`** if anything changed, then push.

Record the pass once per branch:
`--event review --field issue=<n> --field status=<code-review|code-review+agent-fix|DELEGATED> --field effort=<medium|high> --field findings=<n> --field skipped=<n>`
— `findings` counts what the review reported, `skipped` the refusals from either path;
`DELEGATED` is the read-only fallback agent.
