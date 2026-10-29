# PR, CI and merge (steps 5–7)

The detail behind [SKILL.md steps 5–7](../SKILL.md#5-open-the-pr): from a branch that
[step 4](../SKILL.md#4-review-the-branch) already reviewed and pushed to a merged PR, a
closed issue, and a checkout back on the default branch. This stretch is serial in both
modes: one PR at a time, in the batch's dependency-then-priority order — finish an
issue's PR → CI → merge before opening the next. The PR itself is not reviewed by
anything this skill waits for: the review happened before it opened.

## Table of Contents

- [Opening the PR](#opening-the-pr)
- [Watching CI](#watching-ci)
- [Waiting inside the command timeout](#waiting-inside-the-command-timeout)
- [Merging](#merging)
  - [Held for a human's evidence](#held-for-a-humans-evidence)
- [After the merge](#after-the-merge)

## Opening the PR

Commits but nothing pushed → push from this session
(`git push -u origin <branch>` in `<workdir>`). No commits at all → no branch: record
`--event blocked --field issue=<n>`, report `SKIPPED(<why>)`, and in `all` mode move on.

Open a regular PR — never a draft, which `land_pr.sh` would have to mark ready — from
`<branch>` against `<default_branch>`, titled `<PR-TITLE>`. A merge commit from bringing
the branch up to date (`git merge origin/<default_branch>`) before opening is fine. The
body must
carry **`Closes #N`** after the summary (a bare `#N` closes nothing) and target the
**default branch** (auto-close only fires there) — build it from `PR-SUMMARY`,
`Closes #N`, `TEST-PLAN`. Record
(`--event pr-created --field issue=<n> --field pr=<url>`), then:

```bash
.agents/skills/shipping-issues/scripts/link_check.sh <pr> --issue <n> --fix
```

Run it before step 6's watch starts: every body edit it makes fires the PR's `edited`
event, which re-runs the PR-title and labeling workflows, and a run cancelled by the
next edit must not land inside a watch. `land_pr.sh` re-checks the link at merge time
without `--fix`; this earlier call is not redundant, because it is the only one that
repairs, and it catches `WRONG_BASE` before CI spends thirty minutes on the wrong base.
`WRONG_BASE` → retarget before merging. When GitHub lists no link to the issue, `--fix`
reads the body first and never adds a second keyword:

- **No closing keyword for `#N` in the body** → it appends `Closes #N`.
- **The keyword is there, or was just appended, and GitHub still lists no link** → it
  re-saves the body: a minimal body of only `Closes #N`, then the full body put back, at
  most 2 times (4 edits), a few seconds apart, stopping as soon as the link appears. The
  full body is restored after every minimal save, including on an interrupt; if it
  cannot be, the verdict is `ERROR` and the detail names the file holding the full body
  and the `gh pr edit` that puts it back (the PR description's edit history on GitHub
  keeps it too) — restore it before anything else. A body it could not read is never
  rewritten (`ERROR`).

`NOT_LINKED`'s `detail:` says which case is left. "has no Closes/Fixes/Resolves
keyword", or "closes #M but not the target issue #N", means the body still lacks the
keyword (its `fix:` line says the edit failed): re-run `--fix`, or add `Closes #N` to
the body by hand. "has a closing keyword for #N, but GitHub has not linked it" means the
re-saves left the link missing: go on to step 6 anyway. Step 7's `land_pr.sh` then
refuses the merge with `result: NOT_LINKED`, and the PR is held for the human
(`landing-outcomes.md`): merging it with `--no-link-check` is their
decision, never this run's.

## Watching CI

Wait for the PR's new head commit to appear among the branch's CI runs before watching —
the checks API serves the previous commit's results for a minute or two after a push,
and a stale PASS is worse than a stale FAIL. Then:

```bash
.agents/skills/shipping-issues/scripts/ci_watch.sh <pr> --timeout <seconds> > <runstate>/ci/<pr>.log
grep -E '^(verdict|waited_seconds|head_sha|mergeable|merge_state|review_decision):' <runstate>/ci/<pr>.log
```

Redirected — raw output carries failing-run log tails that must stay out of this
context. Keep `failed_checks:` for repair. `ci_watch.sh` is the run's only wait
primitive: **never a hand-rolled sleep/poll loop**. One PR at a time, even in `all`
mode. Record (`--event ci ...`).

| `verdict:`           | Next                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`               | [Merge](#merging) in the same turn.                                                                          |
| `FAIL`               | `recovery.md` › "CI fails" with `agent-ci-repair.md`, at most 3 attempts; re-watch after each push. |
| `TIMEOUT`            | Not a verdict on the code — [wait again](#waiting-inside-the-command-timeout), up to 3600 s in total; past that, treat it as `ERROR`.     |
| `NO_CHECKS`, `ERROR` | `recovery.md` › "NO_CHECKS, ERROR, and other non-verdicts".                                 |

## Waiting inside the command timeout

CI can take most of an hour to settle — `Rust Core` and `macOS` each have a 30-minute
`timeout-minutes` in `.github/workflows/ci.yml`, and a macOS runner can queue before its
job starts — and a host cuts a foreground command off well before that. Pick the first of these the host supports:

1. **Foreground, in slices.** Run `ci_watch.sh <pr> --timeout <N>` with `N` safely below
   the command timeout this host applies to the call — raise the call's own timeout
   where the host lets it, and keep `N` under it. On `verdict: TIMEOUT`, add its
   `waited_seconds:` to a running total and run the same watch again; stop at 3600 s in
   total and treat the PR as `ERROR`. Each slice re-reads the PR from scratch, so
   nothing is lost between them.
2. **Background, with completion reported.** On a host that can run a command in the
   background and re-invoke the session when it exits, start
   `ci_watch.sh <pr> > <runstate>/ci/<pr>.log` (its default `--timeout 3600`) that way and wait for that
   report. Until that verdict is read, nothing else on the shipping path moves — no next
   step 3, no other PR, no checkout or branch switch; the only work allowed meanwhile is
   draining [step 8b](../SKILL.md#8b-unblock-held-designs-in-the-background)'s
   background queue. A `TIMEOUT` after the full 3600 s is `ERROR`. In Claude Code this is
   `run_in_background`.

Never stand in for `ci_watch.sh` with `sleep` or a poll loop of your own: its own
timeout and verdicts are what make a stalled CI a reported outcome rather than a hung
run.

## Merging

```bash
.agents/skills/shipping-issues/scripts/land_pr.sh <pr> --issue <n> --head-sha <head_sha>
```

`<head_sha>` is the `head_sha:` line of the `PASS` in `<runstate>/ci/<pr>.log` — the
commit CI verified. The merge is pinned to it (`gh pr merge --match-head-commit`), so a
push that landed after the watch makes GitHub refuse the merge instead of merging an
unverified commit (`MERGE_REFUSED`: watch CI again). When the log has no `head_sha:`
line, omit the flag: the script then pins to the head it reads just before it checks the
merge state.

Merge as soon as CI reports `verdict: PASS` for the current head and call `land_pr.sh`
in that same turn. Do not ask whether to merge, and do not report the green CI and wait:
a branch reviewed at step 4 with green CI is the approval. No review of the PR is waited
for, requested (`@codex review` or any other comment) or polled, and no review thread is
read, replied to or resolved. Read `result:` and `issue:`. Every result, and the two
that must never read as success: [landing-outcomes.md](landing-outcomes.md). Record
(`--event merged ...`).

### Held for a human's evidence

Some evidence the Review Checklist asks for can only come from the human, because
producing it takes over the Mac (`AGENTS.md` › "Never taking over the developer's Mac"),
and CI does not run it: `just test-local` output, for a change to an adapter under
`crates/myapp-platform/` that has an `#[ignore = "local machine: ..."]` test, and the
human's own `myapp tui` run, for a change to the terminal loop itself (`building-tuis`).

Such a PR is opened, reviewed, and watched to green like any other, and then **not
merged**. Leave one comment on it naming the recipe the human should run and what to
paste, record `--event blocked --field issue=<n> --field reason=human-evidence`, and
move on to the next issue; the step 10 report lists it first among what the human has
to do. Green CI is not the go-ahead here, because CI never ran the part that decides.
`just test-platform` and `just logs`, which an agent may run, go in the test plan either
way.

## After the merge

```bash
git switch <default_branch> && git pull --ff-only
```

after every merge, and again as the run's last act — the run never ends parked on a
feature branch. In parallel mode the main checkout is already there; pull it anyway so
it carries the merge that just landed.

**Clear what the merge unblocked.** `triaging-issues` defines the rule: the
`blocked: dependency` label is not removed automatically when a blocker closes, and
whoever lands the blocking issue clears it from every issue that named it. Re-plan with
`--refresh` and no `--label` filter (a dependent outside the filter would be missed);
its `stale-labels:` line names every open issue still labelled `blocked: dependency`
whose `Depends on` blockers are now all closed, with the exact
`apply_priority_labels.py --clear-dependency` command. Run it without asking. An issue
with another blocker still open keeps the label; one whose label has no `Depends on`
line to verify it against is a step 10 line, never a guess.

**Serial `all`:** re-plan (`plan.py --mode all --refresh --allow-existing-worktrees`)
and start the next issue's step 3 from this up-to-date branch, without pausing.
**Parallel `all`:** the batch's remaining branches are now behind; bring each up to date
in its own worktree **before its own PR** rather than after a CI failure, and merge
rather than rebase
(`recovery.md` › "Bringing the rest of a parallel batch up to date"). A conflict either
way means the grouping call was wrong for that pair
(`recovery.md` › "A merge conflict"). Only when the whole
batch has merged does the run group the next batch.
