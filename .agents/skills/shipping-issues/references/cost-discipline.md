# Cost discipline

What this skill keeps out of the main context, why the run count is what it
is, and why each spawn gets the tier it gets. Read it when deciding whether
to delegate a step, before changing a run count, or before picking a
`/code-review` effort.

## Table of Contents

- [Code review effort](#code-review-effort)
  - [Why never `low`: a diff it cannot see](#why-never-low-a-diff-it-cannot-see)
- [What the startup costs](#what-the-startup-costs)
- [Run budget](#run-budget)
- [Model tiers](#model-tiers)
  - [The foundation exception: `architect` for what the backlog builds on](#the-foundation-exception-architect-for-what-the-backlog-builds-on)
  - [The floor: too small to delegate](#the-floor-too-small-to-delegate)
- [What parallel mode costs](#what-parallel-mode-costs)

The main context holds the selection and the verdicts, nothing else. Issue
bodies go to the triage agent, diffs stay in the sub-agent run that produced
them, CI logs and verify output reach the parent through a file rather than
through the prompt. If you find yourself about to read a full GitHub API JSON
blob, a workflow log, or an unrelated part of a diff in the main context,
that is the signal to delegate or scope the read instead.

Labeling is the cheap half of this by design: the backfill is a pure script
pass with a one-line summary, and re-deriving priority from issue prose
happens once per issue -- ever -- because the answer is written back to GitHub.
On a labeled backlog the whole ranking step is `--select`, three lines, no
spawn at all. Never re-read bodies to reconstruct a priority a label already
carries; if a label looks wrong, fix the label.

## Code review effort

Only for [step 4](../SKILL.md#4-review-the-branch)'s local pass.

`/code-review <effort> <branch> --fix` forks and runs entirely outside this
session's context -- the finders' reads never reach here, only the findings
do. Effort controls how much of that runs:

**`medium` is this repository's default effort.** The owner set it as the
standing choice for every branch this skill reviews; use it unless the `high`
row below genuinely applies, and never drop to `low` to save time on a diff
that looks small.

| effort | what the skill says it does | when |
|---|---|---|
| `low` | fewer, high-confidence findings | **never** in this skill -- see below |
| `medium` | fewer, high-confidence findings, precision over recall | **the default** -- every branch, unless the next row applies |
| `high` | broader coverage, may include uncertain findings | the change can lose or corrode state that already exists -- an on-disk format (in the sample, `counter.json`), a migration of stored user data, the helper's command line a launchd job calls -- or it rewrites a gate (a contract function, a harness check, a lint setting, a workflow), or the user asked for one |

The middle column is the `/code-review` skill's own description of its levels, as
Claude Code listed it on 2026-09-29; how each level works inside is that skill's
business and changes with it.

Diff size or file count alone is not a reason to escalate -- `medium` already
reads the whole diff for scope and correctness, and a big mechanical rename is
exactly the shape it handles well. Never `ultra`: it runs as a cloud review the
user launches, not a step a run takes on its own.

### Why never `low`: a diff it cannot see

`low` was observed to **skip test and fixture hunks** (in the reference template this
skill came from). That is wrong whenever a file under
`crates/*/tests/`, a skill's `scripts/tests/`, or `xtask/src/check_harness/` *is* the gate rather than a
consumer of one -- a contract function in `crates/myapp-test-support`, a harness
check, a script test that pins a failure contract -- and it fails silently: a diff
confined to such a file comes back `(none)` in a few seconds, which reads exactly like a
clean review and is not one. Observed cost: a gate change reviewed at `low` returned no
findings; re-run at `medium` it returned four, all reproduced against the branch, one of
them a security rule that silently accepted three of the four YAML spellings
it existed to reject.

Whatever the effort, ask what the review actually read before accepting a
clean verdict:

- **A clean verdict that names what it skipped is not a clean verdict.** A
  result like "the entire diff is confined to X, which this review level skips"
  is the review telling you it abstained. Read the sentence, not the empty
  findings list.
- A run that escalated to `high` says so in the step 10 report, with the
  reason -- otherwise it looks like drift away from the standing default.

## What the startup costs

Steps 0 through 2c are one `plan.py` call and one `gh` fetch pair -- preflight,
ranking, selection, repo profile and grouping in a single block. Two things keep
it there, and both are easy to undo by accident:

- **The digest cache.** Every `issue_digest.py` call inside the same few minutes
  reads the fetch the plan already paid for; `--issue`, `--detail` and
  `--body-chars` all filter data already in hand rather than re-fetching it.
  What breaks this is asking the same question in three calls -- a `--select`,
  then a `--rank-only`, then a list of `--issue` numbers -- which is what
  `--with-rank` and `--detail-top` exist to collapse. Pass `--refresh` only
  after this run changed the backlog; passing it habitually turns the cache off.
- **The reference files.** `dependency-triage.md` and `worktree-parallelism.md`
  are ~380 lines between them and are *not* hot-path reading any more. The plan
  answers what they used to be read for; open them when it says `PARTIAL`, when
  a gate fails, or before cleanup -- not on every run.

The one thing worth spending on at startup is `issue_digest.py --detail-top K`
when the picked issues' bodies genuinely have to be read. That is still one
call, and it is bounded by K.

## Run budget

Run count scales with issue count, not with thoroughness: one triage spawn
(optional), one implementation sub-agent per issue plus up to 2 resume/patch
runs when this session's judgment finds the first incomplete, one
`/code-review` per branch, in parallel mode one fix sub-agent per branch that
had accepted findings (none when a review came back clean), one repair
sub-agent per failing CI attempt (capped at 3). This session's own
judgment calls -- reading the implementation diff, reading `--fix`'s diff,
deciding what CI failure means -- cost targeted reads in this context, never a
spawn. Filing a follow-up (step 8) never adds a run either: whatever found it
already returned the lead under `FOLLOW-UPS`, and confirming it costs a
couple of targeted reads.

Two things scale that count beyond the issue list itself, both deliberately
bounded:

- **Background design agents (step 8b)** -- one `architect` run per design-blocked
  issue, capped at 3 in flight. They cost nothing in wall-clock on the shipping
  path (nothing ever waits on one) and almost nothing in this context: what
  comes back is a verdict and a two-line approach, while the design itself goes
  to the issue. What they buy is a backlog that stops accumulating undecided
  work -- the single most expensive thing a backlog can hold, because every
  future ranking pass re-reads it and skips it again.
- **Shipping the run's own follow-ups (step 8c)** -- a full steps 3-8 cycle per
  follow-up, the same cost as any issue. This is why depth is capped at 1: a
  run that shipped what it filed, and then what *that* filed, has no
  termination condition and no budget the user agreed to. Depth 1, then stop
  and report.

## Model tiers

Every spawn names one of the committed tiers in `.claude/agents/` as its
`subagent_type` (`AGENTS.md`'s "Sub-agents" documents them). Each definition
pins a model alias and an effort level together, so the tier *is* the effort
setting: spawning with a bare `model` instead drops the effort to the host's
default and loses the tier's instructions.

| Step | Tier | Why |
|---|---|---|
| 2 priority research | `architect` | ranking needs judgment: verifying unblock edges, overriding the heuristic, and a wrong label costs every later run |
| 3 implementation (and its resumes) | `executor` | a settled spec with a clear pass/fail |
| 3 implementation of a foundational or design-bearing issue | `architect` | [below](#the-foundation-exception-architect-for-what-the-backlog-builds-on) |
| 4 review fix (parallel mode) | `executor` | applying already-triaged findings |
| 4 review fallback | `architect` | review and bug-finding is judgment work with an unresolved spec |
| 6 CI repair, attempts 1-2 | `executor` | a failing check with a log is usually a settled fix |
| 6 CI repair, once the same failure survived two attempts | `architect` | persistent failure means the spec (or the fix) needs judgment, not another mechanical retry |
| 8b design decision | `architect` | deciding an approach nobody has decided is the least mechanical work here, and a bad decision recorded on an issue outlives the run |
| single-shot drafting or checking from a complete brief -- several follow-up bodies from findings this session already verified, say | `worker` | no repository tools needed; the brief carries everything |

A resume or patch run keeps the tier its first run used, and goes to the same
agent by `SendMessage` while it is reachable
(`implement-and-review.md`). The design
agent is also the only sub-agent here that writes to GitHub (one comment, one
label) and the only one that writes no code at all.

Under Codex CLI, which reads nothing under `.claude/agents/`, there is no tier
to name: each of these steps runs inline in the main session, with the same
prompt body as its brief.

### The foundation exception: `architect` for what the backlog builds on

Some issues are not "fully specified work with a clear pass/fail" even when
their body is excellent, because what they produce is a **shape other issues
copy** rather than a behavior a test pins down. Spawn the step 3 implementation
on **`architect`** when the issue is any of:

- **Architecture or a skeleton** -- a new crate in the workspace, the
  composition root in `src-tauri/src/`, the core / platform / shell boundary, the
  app shape (windowed or menu-bar agent).
- **An interface, port, or schema** -- a new port in `myapp-core` and its adapter,
  an error enum and its codes, a type that crosses IPC, a persisted file format. The first
  implementer fixes the vocabulary every later one inherits.
- **A skill, instruction file, or gate design** -- a `SKILL.md`, `AGENTS.md`, a
  clippy setting, a harness check, a CI job that defines what "green"
  means. These are prompts and policies: they are read by every future run, and
  a mediocre one degrades work long after this run ends.

The test is not difficulty, it is **blast radius**: would a wrong call here be
cheap to correct in its own follow-up, or would it be copied by every issue
after it? Only the second earns `architect`.

Signals visible before spawning, straight off `issue_digest.py`: an
`unblocks=N` of 2 or more, a `foundation`/`schema`/`interface` signal, or a
Done-means written as a structure to establish rather than a behavior to
observe. Any one of those is a reason to look; the blast-radius test decides.

Everything else stays on `executor`, which is most of a backlog: bug fixes,
removals, mechanical rewrites, config edits, documentation that follows a shape
already settled, and any issue whose Done-means is a command that passes. A
removal-only issue is `executor` even when it is `P0` and unblocks the whole
chain -- deleting what a decision already condemned carries no design in it.

Implementation stays delegated even when the main session could do the work
itself -- a deliberate exception to "do it yourself", bought for context
isolation: the diff and the repository exploration are never needed in the main
context again once this session has judged the result.

### The floor: too small to delegate

That exception buys context isolation, and an issue with almost no context to
isolate does not repay it. Below a certain size the handoff costs more than the
work: writing a self-contained prompt, waiting, reading the report, then
re-deriving enough of the diff to judge it -- for a change this session could
have made and verified in a couple of commands.

Implement it directly when **all** of these hold:

- the whole change is a handful of lines in one or two files, and this session
  already knows which lines from the issue body or a finding it just read;
- there is no exploration to do -- nothing to search for, no unfamiliar module
  to learn;
- the verification is a command whose output this session reads anyway
  (`just test-fast <filter>`, `just lint`, the gate);
- it is not foundational by the test above. A three-line change to an interface
  or a gate is still foundational -- size is not the same question as blast
  radius, and this floor never overrides that section.

A dependency pin closing a named advisory, a one-line config fix a review
turned up, a stale reference in an instruction file: these are the shape. Say
in the step 10 report that the run implemented it directly, so the choice is
visible rather than looking like a skipped step.

Everything above that floor -- anything with a file to find, a module to read,
or a test to design -- stays delegated, whatever the main model is.

## What parallel mode costs

Parallel mode does not reduce the number of runs -- the same issues need the
same implementations. What it changes is when they happen, and what has to be
set up first.

**Added, per issue in a parallel batch:** one dependency install and one
baseline verify (`worktree_setup.sh`), both outside this context -- the parent
reads one `verdict:` line each. Plus, per branch with accepted review
findings, one `executor` fix run that serial mode gets for free from
`/code-review --fix`.

**Saved:** the implementations overlap instead of queueing, which is the
longest stretch of a run, and nothing in this context grows to pay for it --
each sub-agent's exploration and diff still stay inside its own run.

The break-even is group size. One issue in a group means paying the setup for
no overlap at all, which is why the plan refuses to parallelize a group smaller
than 2. The default cap of 2 comes from two costs a group adds. Each worktree of
this Cargo workspace builds into its own `target/` from cold (`worktree-parallelism.md`),
so every extra worktree is gigabytes of disk and a full compile before its baseline
says anything. And every issue past the first is another branch that has to be
brought forward after each merge in the batch, a churn that grows with the square of
the group. `plan.py --max-parallel` raises the cap when the user asks for more, and
nothing else should.

A repo that fails the viability gate costs one worktree's setup to discover,
once per run. The answer is a property of the repository, not of any issue:
never re-test it per issue.
