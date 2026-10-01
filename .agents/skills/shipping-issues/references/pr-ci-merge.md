# PR, CI, and merge

The detail behind SKILL.md steps 5 to 7. From step 5 to step 7 the run is serial in
both modes: one PR at a time, in the batch's dependency-then-priority order. Finish an
issue's PR -> CI -> merge before opening the next.

## Table of Contents

- [5. Open the PR](#5-open-the-pr)
- [6. CI to green](#6-ci-to-green)
  - [Waiting inside the Bash tool's timeout](#waiting-inside-the-bash-tools-timeout)
  - [Reading the verdict](#reading-the-verdict)
- [7. Merge and confirm the issue closed](#7-merge-and-confirm-the-issue-closed)
  - [Held for a human's evidence](#held-for-a-humans-evidence)
  - [Clearing `blocked: dependency`](#clearing-blocked-dependency)
  - [Moving on](#moving-on)

## 5. Open the PR

Commits but nothing pushed -> push from this session (`git -C <workdir> push -u origin
<branch>`). No commits at all -> no branch: record `--event blocked --field issue=<n>`,
report `SKIPPED(<why>)`, and in `all` mode move on.

Open a PR from `<branch>` against `<default_branch>`, titled `<PR-TITLE>`. The body must
carry **`Closes #N`** after the summary (a bare `#N` closes nothing) and target the
**default branch** (auto-close only fires there). Build it from `PR-SUMMARY`,
`Closes #N`, the Release impact line (decided here from `CHANGED`, in one of the
`create-pr` skill's two forms), and `TEST-PLAN`, in the shape of
`.github/PULL_REQUEST_TEMPLATE.md` --
Summary, Test Plan, and its Checklist ticked only for what actually ran. Record
`--event pr-created --field issue=<n> --field pr=<url>`, then:

```bash
.agents/skills/shipping-issues/scripts/link_check.sh <pr> --issue <n> --fix
```

Run it before step 6's watch starts: every body edit it makes fires the PR's `edited`
event, which re-runs the PR-title and labeling workflows, and a run cancelled by the
next edit must not land inside a watch. `land_pr.sh` re-checks the link at step 7
without `--fix`; this earlier call is not redundant, because it is the only one that
repairs, and it catches `WRONG_BASE` before CI spends its time on the wrong base.
`WRONG_BASE` -> retarget before merging. When GitHub lists no link to the issue,
`--fix` reads the body first and never adds a second keyword:

- **No closing keyword for `#N` in the body** -> it appends `Closes #N`.
- **The keyword is there, or was just appended, and GitHub still lists no link** ->
  it re-saves the body: a minimal body of only `Closes #N`, then the full body put
  back, at most 2 times (4 edits), a few seconds apart, stopping as soon as the link
  appears. The full body is restored after every minimal save, including on an
  interrupt; if it cannot be, the verdict is `ERROR` and the detail names the file
  holding the full body and the `gh pr edit` that puts it back (the PR description's
  edit history on GitHub keeps it too) -- restore it before anything else. A body it
  could not read is never rewritten (`ERROR`).

`NOT_LINKED`'s `detail:` says which case is left. "has no Closes/Fixes/Resolves
keyword", or "closes #M but not the target issue #N", means the body still lacks the
keyword (its `fix:` line says the edit failed): re-run `--fix`, or add `Closes #N` to
the body by hand. "has a closing keyword for #N, but GitHub has not linked it" means
the re-saves left the link missing: go on to step 6 anyway. Step 7's `land_pr.sh`
then refuses the merge with `result: NOT_LINKED`, and the PR is held for the human
(`landing-outcomes.md`): merging it with `--no-link-check` is their decision, never
this run's.

## 6. CI to green

Wait for the PR's new head commit to appear among the branch's CI runs before watching
-- the checks API serves the previous commit's results for a minute or two after a
push, and a stale PASS is worse than a stale FAIL
(`recovery.md`). Then watch the PR once,
output redirected -- raw output carries failing-run log tails that must stay out of this
context -- and read only four lines:

```bash
.agents/skills/shipping-issues/scripts/ci_watch.sh <pr> --timeout 3600 > <runstate>/ci/<pr>.log
grep -E '^(verdict|mergeable|merge_state|review_decision):' <runstate>/ci/<pr>.log
```

One watch per PR; keep the log's `failed_checks:` for repair. Record `--event ci`.

### Waiting inside the Bash tool's timeout

Claude Code's Bash tool gives a foreground call at most ten minutes out of the box
(`BASH_MAX_TIMEOUT_MS` moves that ceiling), and moves a command that reaches its timeout
to the background instead of returning its result
(https://code.claude.com/docs/en/tools-reference, checked 2026-09-29). This
repository's CI (`Rust Core`, `Frontend`, `Repo Lint & Harness`, and
`macOS Build & Smoke`, whose `timeout-minutes` is 60) routinely runs longer, so a
`--timeout 3600` watch started in the foreground returns no verdict in that call. So
pick one of these, in this order:

1. **Background, then wait for the notification (Claude Code).** Start the command
   above with the Bash tool's `run_in_background`. The host re-invokes this session when
   the command exits; read the four lines then. This is the run's only wait primitive --
   never a hand-rolled `sleep`/poll loop, which burns turns and context. The session may
   do non-GitHub work meanwhile (drain step 8b's queue, draft a follow-up body), but it
   does not open, watch, or merge another PR: the serial rule above still holds.
2. **Foreground, under the cap.** Run it with `--timeout 540` or less. `verdict:
   TIMEOUT` then means only that the watch's own bound ran out, not that CI failed: run
   the same watch again, until 3600 seconds of watching have passed in total.
3. **Codex CLI**: the foreground form, with `--timeout` kept below that host's own
   command timeout, re-run on `TIMEOUT` the same way.

After 3600 seconds of `TIMEOUT` in total, treat it like `ERROR`: re-read the PR's
actual CI state before deciding anything.

### Reading the verdict

- `PASS` -> step 7 **in the same turn**. Do not report the green CI and wait: green CI
  is the approval.
- `FAIL` -> `recovery.md` and
  `agent-ci-repair.md`, at most 3 attempts. The second and third
  attempts go to the same repair agent by `SendMessage` while it is reachable, with what
  the previous attempt tried; once the same failure has survived two attempts, a fresh
  `architect` takes the third.
- `NO_CHECKS`, `ERROR`, `TIMEOUT` ->
  `recovery.md`.

## 7. Merge and confirm the issue closed

```bash
.agents/skills/shipping-issues/scripts/land_pr.sh <pr> --issue <n>
```

Merge as soon as step 6 reports `verdict: PASS`, unless the PR is held for a human's
evidence (below). Read `result:` and `issue:` -- twelve
results, and only `MERGED` and `ALREADY_MERGED` mean the PR merged:
`landing-outcomes.md`. Record `--event merged`. Then:

```bash
git switch <default_branch> && git pull --ff-only
```

after every merge, and again as the run's last act -- a run never ends parked on a
feature branch. In parallel mode the main checkout is already there; pull anyway so it
carries the merge that just landed.

### Held for a human's evidence

One kind of evidence the Review Checklist asks for can only come from the human,
because producing it takes over the Mac (`AGENTS.md` › "Never taking over the
developer's Mac"), and CI does not run it: `just test-local` output, for a change to an
adapter under `crates/myapp-platform/` that has an `#[ignore = "local machine: ..."]`
test.

Such a PR is opened and watched to green like any other, and then **not merged**. Leave
one comment on it naming the recipe the human should run and what to paste, record
`--event blocked --field issue=<n> --field reason=human-evidence`, and move on to the
next issue; the step 10 report lists it first among what the human has to do. Green CI
is not the go-ahead here, because CI never ran the part that decides. `just test-macos`
and `just logs`, which an agent may run, go in the Test Plan either way.

### Clearing `blocked: dependency`

`triaging-issues` defines the rule: the label is not removed automatically when a
blocker closes, and whoever lands the blocking issue clears it from every issue that
named it. This run just landed one, so this run clears them, right after the merge:

```bash
python3 .agents/skills/shipping-issues/scripts/plan.py --mode <same> --refresh --allow-existing-worktrees
```

Its `stale-labels:` line names every open issue still labeled `blocked: dependency`
whose `Depends on` blockers are now all closed, with the exact
`apply_priority_labels.py --clear-dependency` command to run. Run it without asking. Two
cases it leaves alone on purpose: an issue with another blocker still open (the label is
still true), and a label with no `Depends on` line to verify it against (the label rule
in `triaging-issues` requires one; report it at step 10 rather than guess). Do not pass a
`--label` filter to this re-plan: a dependent outside the filter would be missed.

### Moving on

**Serial `all`:** the same re-plan's `select:` line is the next issue; start its step 3
from this up-to-date branch, without pausing. **Parallel `all`:** the batch's remaining
branches are now behind; bring each up to date in its own worktree **before its own
step 5**, rather than after a CI failure, by merging the default branch in -- never a
rebase and force push (`recovery.md` says how). A conflict
either way means the grouping call was wrong for that pair
(`recovery.md`). Only when the whole batch has merged
does the run group the next batch. With no argument or an explicit number, step 8c is
the only thing that extends the run past this merge.
