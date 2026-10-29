# Review, CI, merge, and the branch afterwards

The detail behind [SKILL.md steps 4–8](../SKILL.md#4-review-the-branch): from an
implemented branch through its local review to a merged PR, a closed issue, and the
session's branch ready for the next issue — and, first, [step 2](../SKILL.md#2-rank)'s
design decision for a held issue.
The REST spelling of each call is in [rest-calls.md](rest-calls.md).

## Table of Contents

- [A held design](#a-held-design)
- [The review](#the-review)
- [CI](#ci)
- [The merge](#the-merge)
- [Branch upkeep after the merge](#branch-upkeep-after-the-merge)
- [What the report must not omit](#what-the-report-must-not-omit)

## A held design

A design-held issue (`blocked: design`, or `design=open` in its ship contract) is taken
on only by number, and its design is settled inline, before step 3, by this session — the
run stays serial. **BACKGROUND:** `shipping-issues`, whose design-decision brief is the
long form of what the decision must settle.

1. Settle the approach from the repository, its conventions, and the issue thread:
   the approach and the alternatives rejected with why; the files and functions that
   change; the data, config, and API surface with exact names and defaults; the edge
   behavior; what the tests must pin; what is out of scope.
2. Never decide a product or UX call the repository and the thread do not already
   answer — what a user is promised, a policy, wording a user sees. That is `DEFERRED`:
   write nothing, stop, and ask the one question.
3. `DECIDED`: post the decision as a comment starting `## Design decision`, standing
   alone; only after it posted, clear the design block — the label and a ship
   contract's `design=open` (`rest-calls.md` › "Settling a held design") — and
   record it. Then implement the decided approach.

A comment that failed to post leaves the block on; a block that failed to clear after
the comment posted is cleared before step 3, never left for the next run to misread.

## The review

The branch is reviewed once, locally, before its PR exists
([step 4](../SKILL.md#4-review-the-branch)); nothing waits on a review of the PR. This
run never posts `@codex review`, never replies to or resolves a review thread, and never
polls the PR for a review. **BACKGROUND:** `shipping-issues`, whose step 4 and its review
references hold the long form.

```
/code-review medium <branch> --fix
```

Effort is `medium` for every branch and `high` only for a change that can lose or
corrode existing data or when the user asked; effort first, branch second, because an
unrecognized first token makes the whole string the target and silently reuses the last
effort. Never `low`, `xhigh`, `max` or `ultra`. The session is serial on one branch, so
`--fix` is safe here.

If the host cannot launch `/code-review`, run one **read-only** `architect` sub-agent in
the foreground against `git diff <base>...HEAD`, in a context that did not write the
change: it reports defects (file, line, what is wrong, why it matters, with a severity
and confidence), not patches, and edits nothing. Never re-read your own diff and call
that a review.

**Triage.** Number the findings `F1`, `F2`, … and classify every one with a one-line
reason that holds against the code: **accepted** (real, and part of this issue's change,
tests included), **rejected** (wrong on reading the code), or **out of scope** (real,
not this diff's: step 9). A finding that needs an owner's decision, or that this session
cannot settle either way, holds the branch: no PR opens and the run stops with the
question. Then read what `--fix` changed (`git diff <impl-commit>..HEAD`), revert what it
got wrong, read what it would not apply, run the narrowest `cargo` check if anything changed, and
push. One pass: the fixes are not reviewed again. Record it:
`--event review --field issue=<n> --field status=<code-review|code-review+agent-fix|DELEGATED> --field effort=<medium|high> --field findings=<n> --field skipped=<n>`.

## CI

Read CI only for the head the last push produced, with the call in
`rest-calls.md` › "The CI verdict", into `<runstate>/ci/<pr>.log`.

| Last `verdict:` | Next |
| --- | --- |
| `PASS` | The merge, in the same turn. |
| `FAIL` | Repair: reproduce with the matching local command (a failing check: `rest-calls.md` › "A failing check"), fix, the matching `cargo` check, commit, push, read CI again for the new head. At most 3 repairs per issue; a fourth `FAIL` stops the run. |
| `PENDING` | Run the call again. Past 3600 s of reads for one head (`Rust Core` and `macOS` each have a 30-minute timeout, after a runner queue), the PR is held and the run stops. |
| `EMPTY` | Run the call again: check runs appear a little after a push. Still `EMPTY` 600 s after the push, there are no checks at all (`NO_CHECKS`): stop and ask the owner. |
| `ERROR` | Run the call once more; a second `ERROR` is a stop, reported with the message. |

A test deleted, skipped, or weakened to get a `PASS`, or a re-run without a diagnosis,
is a failed repair, not a green one.

## The merge

Merge as soon as CI is `PASS` for the head being merged: no "shall I merge?", no
summary-then-wait. The call pins the merge to that head (`rest-calls.md` › "The merge").

| Reply | Next |
| --- | --- |
| 200, `merged: true` | Read the issue. `closed` → done; record it. Still `open` → read again after 10 s; still open → close it with a back-reference comment (`rest-calls.md` › "Closing an issue GitHub left open") (`CLOSED_MANUALLY`); if that fails, the run stops with the issue named as left open. |
| 409 | The head moved after the CI read. Read CI for the new head; never retry with the old `sha`. |
| 405 | Read the PR. `mergeable: false` is a conflict: `git fetch origin <default> && git merge origin/<default>` (a merge, never a rebase), resolve a mechanical conflict, run the narrowest checks the resolution touched, push, then CI again. A conflict that needs a product decision, or a 405 with `mergeable: true` (a required review or rule), holds the PR: stop and ask. `null` → read again. |
| 403 | A 403 from the proxy (`cloud-host.md` › "A 403 from the proxy"), or no merge permission: stop and report. |
| anything else | Read the PR: only `merged: true` is a merge. Report the reply and stop. |

Then, in the same turn: record the merge, clear the labels of the
issues the merge unblocked (`rest-calls.md` › "Issues the merge unblocked"), and file the
follow-ups this PR surfaced (step 9).

## Branch upkeep after the merge

The session's branch carries the issue's own commits; the default branch now carries
their squash. Bring the branch up to date by merging, never by a reset or a rebase
followed by a force-push:

```bash
git fetch origin <default> --quiet
git merge --no-edit origin/<default>
git diff --stat origin/<default>      # must print nothing
```

It is normally clean, since both sides carry the same change. A conflict means the
default branch has changed those lines again since the squash; the branch's side is
already merged, so resolve each conflicted path to `origin/<default>`'s version
(`git checkout --theirs -- <path>`, then `git add` and `git commit --no-edit`). An
empty diff proves the branch's tree is the default branch's; anything else is work
that is not on the default branch: stop and ask. Then:

- **`delete_branch_on_merge: true`** — GitHub deleted the remote branch; the next
  `git push -u origin <branch>` creates it afresh.
- **`false`** — the remote branch still points at the merged head, which the local
  branch now descends from; the next push is a fast-forward.

Git counts the pre-squash commits as not on the default branch, so they may be listed
among the next PR's commits; its diff, which the review reads and the squash takes, is
the new work alone. `git reflog` on the branch shows no forced update at any point.

## What the report must not omit

No prescribed format, but each of these is a fact whose absence changes what the reader
believes happened. **BACKGROUND:** `shipping-issues`, whose closing-out reference is
the long form.

- Any issue left open behind a merged PR — stated, never implied.
- Per PR: how the branch was reviewed — the `/code-review` pass (effort used and why
  `high`, if it was; findings; what was fixed, rejected, or filed as a follow-up) or the
  fallback agent, any rejected finding this session did not resolve, and that the fixes
  were covered by local verification and current-head CI alone. A run that shipped
  unreviewed must not read like one that passed. A held PR is named as held, open.
- Acceptance criteria that shipped `not-met`, and why; or that all were met; or that the
  issue carried none.
- Every write beyond push, PR, and merge: a design decided (its comment URL, and the
  block cleared), a PR body or base repaired, and an issue closed by hand
  (`CLOSED_MANUALLY`) — each with the PR or issue it touched.
- Follow-ups filed with their URLs and labels, what was fixed inline instead, findings
  checked and deliberately not filed, and a label the reply did not echo back.
- Issues that ranked on a suggested `~P<n>` tier (no label written), and stale
  dependency labels left for a human.
- Everything held, stopped, or skipped, with the reason — and the state of the
  session's branch when the run stopped (`git log --oneline origin/<default>..HEAD`).
- A `DEFERRED` design's open question, phrased as the question.
- Operator actions the run surfaced, such as reconnecting GitHub, clearing Auto-fix, or
  running `just labels`.
