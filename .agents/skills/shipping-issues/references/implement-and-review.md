# Implementing and reviewing a branch

The detail behind SKILL.md steps 3 and 4: what runs, in which checkout, and what this
session does with each thing a sub-agent returns. Read it at step 3 the first time in a
run, and whenever a result or a review does not fit the short form in SKILL.md.

## Table of Contents

- [3. Implement](#3-implement)
  - [Serial](#serial)
  - [Parallel](#parallel)
  - [Spawning](#spawning)
  - [Judging what came back](#judging-what-came-back)
  - [Resuming a run](#resuming-a-run)
- [4. Review the branch](#4-review-the-branch)
  - [Effort and syntax](#effort-and-syntax)
  - [Serial: `--fix`](#serial---fix)
  - [Parallel: a fix agent per branch](#parallel-a-fix-agent-per-branch)
  - [Triage](#triage)
  - [Reading the fix and recording it](#reading-the-fix-and-recording-it)

## 3. Implement

One issue = one branch = one PR. Step 1's `next:` line is the command.

### Serial

```bash
git switch <default_branch> && git pull --ff-only && git switch -c <branch>
```

Then run the confirmed verification command (`just check` in this repository) **once,
unmodified, on this branch**, redirected to `<runstate>/verify/<n>-baseline.log`. Read
the exit code and the log's tail, never the full output. `just check` compiles the
workspace and ends in `just smoke`'s release build, so it outlasts a foreground tool
call: start it with `run_in_background` and wait for the completion notice under Claude
Code, or give it a timeout that covers a full build under Codex CLI. The same holds for
`worktree_setup.sh --verify` below. Neither opens a window (`AGENTS.md` › "Never taking
over the developer's Mac").

### Parallel

The script creates each branch, copies untracked local config
(`.claude/settings.local.json`, and the other patterns in
`worktree-parallelism.md`),
installs dependencies when a lockfile asks for them, and runs the baseline, bounded. It
**reports and does not decide**:

```bash
git switch <default_branch> && git pull --ff-only   # once, before the batch
.agents/skills/shipping-issues/scripts/worktree_setup.sh --spec <n>:<branch> \
    --spec <m>:<branch> --base <default_branch> --root <runstate>/worktrees \
    --log-dir <runstate>/verify --verify "just check"
```

**Provision the first worktree on its own, read its block, then ask for the rest.** That
one extra call is what stops a repository that cannot carry a worktree from costing
two cold setups instead of one. Judging the four `baseline:` outcomes is yours, not the
script's (`recovery.md`; `verdict:` semantics in
`worktree-parallelism.md`). Whatever the smoke
run turns up goes to step 8.

### Spawning

Fill `agent-implementation.md` per issue and spawn it as
`executor` -- or `architect` when the issue is foundational: blast radius, not
difficulty (`cost-discipline.md`).
A change small enough that the handoff costs more than the work is implemented here
(the floor (`cost-discipline.md`)). In parallel mode issue
every spawn of the batch **in one message**, each with its own worktree path, never the
main checkout -- spawned one after another, they run one after another.

### Judging what came back

**Judge each result in this context**, against the issue and step 2b's decision:

| Returned field | Consumed |
|---|---|
| `ACCEPTANCE` | **Here, first.** A `not-met` line is work still owed. Sending it back costs one resume; letting it through merges a PR that closed an issue it did not answer. Green CI does not cover this -- it proves the repository still works, not that the issue was answered. |
| `UNRESOLVED` | **Here.** Judgment calls the agent made alone: each is accepted (and stated at step 10) or sent back, never silently inherited. |
| `CHANGED` | **Here.** A user-facing change -- anything a user of an app cut from this template would notice, or a change to the template's own documented surface -- owes a `CHANGELOG.md` entry under `[Unreleased]` (`AGENTS.md` › "Review Checklist"). No entry in `CHANGED` for such a change is work still owed, the same as a `not-met` line. |
| `PR-SUMMARY` / `TEST-PLAN` | Step 5 (`pr-ci-merge.md`), verbatim. |
| `MEASURE` | [Step 4](#4-review-the-branch) -- what review findings are checked against. |
| `SCOPE-NOTES` / `FOLLOW-UPS` | Step 8 (`filing-followups.md`). |

`CHANGELOG.md` is an append-target file: two branches of one parallel batch that both
add an entry conflict on merge, which is why step 2c serializes them
(`dependency-triage.md`).

### Resuming a run

At most **2 resume runs** on top of the first; a third miss is `NEEDS-CLARIFICATION`,
not another spawn. A resume names only what is left.

**Reuse the agent that did the first run.** While it is still reachable, send the resume
to it with `SendMessage` and its agent ID: it already read the issue, the code, and its
own diff, and a new spawn would pay for all of that again from a cold start. Spawn a
fresh agent -- on the same tier as the first run -- only when that agent is gone, or when
its own context is what went wrong (it misread the issue and every later turn builds on
the misreading). A resume never changes tier: a foundational issue the first run got
half-right is exactly where the remaining judgment sits. Under Codex CLI there is no
`SendMessage` and no named tier: finish the resume inline in the main session.

A run that returned without a report, stopped before pushing, or missed or widened the
spec: `recovery.md`. Never re-spawn an agent that returned without its
report -- its work is on disk.

## 4. Review the branch

Run against the branch, before any PR exists. In parallel mode step 4 covers the whole
batch: review each branch, triage all of them, then fix them concurrently -- no PR opens
until the batch's last review is triaged. It is a single pass: fix every accepted
finding here, route out-of-scope and `pre-existing` findings to step 8, and do not
re-review after the fix.

### Effort and syntax

```text
/code-review medium <branch> [--fix]
```

**Effort first, branch second** -- an unrecognized first token makes the *entire* string
the target and silently falls back to the last effort used. **`medium` is the standing
default** for every branch this skill reviews; never `low`, never `ultra`. When `high`
is warranted, and why `low` is not an option:
`cost-discipline.md`. Before believing an empty
findings list, check what the review actually read.

### Serial: `--fix`

`--fix` applies the findings to this session's working tree, which in serial mode is the
branch under review. It is **serial-mode only**
(why (`recovery.md`)). Host will not launch
`/code-review` at all -> `agent-review-fallback.md` on
`architect`, triaged the same way.

### Parallel: a fix agent per branch

Parallel mode reviews without `--fix` and spawns one `executor` per branch from
`agent-review-fix.md`, all in one message; a branch with zero
accepted findings gets no spawn. **Number the findings `F1`, `F2`, ... before handing
them over** -- the fix agent returns `APPLIED`/`REJECTED` against those numbers, and
without caller-assigned IDs the returned lines cannot be matched back to what was sent.
A rejection sent back for another try goes to the same fix agent by `SendMessage` while
it is reachable.

### Triage

The same either way, and in parallel mode it happens *before* anything is written: read
every finding against the issue's scope, send what belongs in this diff, route the rest
to step 8. "Belongs in this diff" is the same behavior change the issue is about, tests
included -- a sibling case of the bug just fixed belongs here; a new Core port, a new
public surface, or a new target does not, however small the patch looks
(`filing-followups.md`).

### Reading the fix and recording it

Either path writes code this session did not write, so **reading what the fix pass
changed is the safeguard**: `git -C <workdir> diff <impl-commit>..HEAD`, not the whole
branch. Revert what it got wrong. Read the findings it would *not* apply (`skipped` from
`--fix`, `REJECTED` from the sub-agent) -- neither is clean; real-but-out-of-scope goes
to step 8. Re-run the verification command **in `<workdir>`** only if something
actually changed, then push.

Record, per branch: `--event review --field issue=<n> --field
status=<code-review|code-review+agent-fix|DELEGATED> --field effort=<medium|high>
--field findings=<n> --field skipped=<n>` -- `skipped` counts refusals from either path.
