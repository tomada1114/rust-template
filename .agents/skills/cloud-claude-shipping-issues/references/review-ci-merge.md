# Review, CI, merge, and the branch afterwards

The detail behind [SKILL.md steps 5–8](../SKILL.md#5-wait-for-the-review): from an open
PR to a merged one, a closed issue, and the session's branch ready for the next issue —
and, first, [step 2](../SKILL.md#2-rank)'s design decision for a held issue.
The REST spelling of each call is in `rest-calls.md`.

## Table of Contents

- [A held design](#a-held-design)
- [The review](#the-review)
- [The review gate before the merge](#the-review-gate-before-the-merge)
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

Each Codex review — on opening, and possibly again after a fix push — is a **round**,
and at most 3 are handled per PR. This run never asks for one: no `@codex review`
comment, no close and reopen, no reply to or resolution of a review thread.
`review_watch.py` reads the reviews over REST alone; its docstring holds the verdicts,
the rounds memory (`<runstate>/review/<pr>-rounds.json`), and `--after-push`. The rounds
policy is `shipping-issues`' own, unchanged here (**BACKGROUND:** `shipping-issues`, its
PR-review and triage references):

| Round | Fixed in this PR |
| --- | --- |
| 1, the opening review | every accepted finding, whatever its badge |
| 2 and 3, after fix pushes | an accepted `P0`, `P1`, `P2` or unbadged `P?`; an accepted `P3` goes to step 9 as a follow-up |
| 4 or later, past the cap | nothing: only `P0`, `P1` and `P?` are triaged, and an accepted one holds the PR; the rest are named in the report, untriaged |

```bash
mkdir -p <runstate>/review
python3 .agents/skills/shipping-issues/scripts/review_watch.py <pr> [--after-push <sha>] --timeout 540 > <runstate>/review/<pr>.log
grep -E '^(verdict|after_push|round|rounds|cap_reached|trigger|review_status|reviewed_sha|head_sha|reviewed_is_head|completed_at|later_review|pr_age_seconds|push_age_seconds|findings|round_findings|findings_file|detail):|^  - F' <runstate>/review/<pr>.log
```

Run it in the foreground with the call's timeout raised to 600000 ms; each slice
re-reads the PR from scratch. Right after the PR opens, run it without `--after-push`.
**After every push** — a fix, a CI repair, a merge of the default branch; a PR body or
base repair pushes nothing and is not one — run it with `--after-push <sha>`, the
commit just pushed, before reading CI: it waits a 300 s start grace (`--start-grace`), counted from its first call
for that SHA, for a review of the push to start, then for that review to settle. If the
session is woken by PR activity meanwhile, that is a cue to run the script again,
never a verdict.

| `verdict:` | Next |
| --- | --- |
| `CLEAN` | Nothing to fix in this round; go to CI. |
| `FINDINGS` | Triage every finding of `round:` (below), fix what the round table calls for, verify, commit, push, then `--after-push` and CI for the new head. Out of scope → step 9. |
| `NO_NEW_REVIEW` | No review of that push started within the grace (or the one that did failed): the latest settled round stands, for that head alone. Triage first any finding of that round not yet triaged; then CI. |
| `PENDING_TIMEOUT` | Run the same call again. Past 1800 s of `pr_age_seconds:` (the opening review) or `push_age_seconds:` (a later one) with the review still running, treat it as `ERROR`. |
| `NO_REVIEW` | The PR is held: open, unmerged, and the run stops (the branch is the next issue's too). Never a local review instead. |
| `ERROR` | Read `detail:`. A GitHub read that failed: run once more. Anything else holds the PR as for `NO_REVIEW`. |

With `cap_reached: yes`, `--after-push` waits for nothing and reports the latest round:
fixes after round 3 are covered by local verification and current-head CI alone, and
the report says so.

**Triage.** Read each finding's body in the file `findings_file:` names, never in the
PR conversation, and classify every finding of the round being handled, each with a
one-line reason that holds against the code, not against the badge: **accepted** (real,
and part of this issue's change), **rejected** (wrong on reading the code), or **out of
scope** (real, not this diff's: step 9). The round decides only what an accepted finding
costs this PR, by the table above. A finding that needs an owner's decision, or that
this session cannot settle either way, holds the PR. Finding numbers follow the
reviews' order, so a new round's are appended and earlier ones never move. Write the
ledger as you go, one line per finding, to `<runstate>/review/<pr>-triage.md`:
`F<n> round=<r> id=<comment id> accepted|rejected|out-of-scope — <reason> — fixed-in <sha> | followup`.
Record each round once triaged, and each `NO_NEW_REVIEW`, as `shipping-issues` does:
`--event review --field pr=<pr> --field round=<k> --field verdict=<verdict> --field reviewed=<sha> --field findings=<round_findings> --field accepted=<n> --field followup=<n> --field fixed-in=<sha>`.

## The review gate before the merge

The cloud merge has no `land_pr.sh --review-log`, so this check stands in for it. Once
CI is `PASS` for `<head_sha>`, read the review for that head one last time:

```bash
python3 .agents/skills/shipping-issues/scripts/review_watch.py <pr> --after-push <head_sha> --timeout 0 > <runstate>/review/<pr>.log
log=<runstate>/review/<pr>.log; sha=<head_sha>
v=$(sed -n 's/^verdict: //p' "$log"); p=$(sed -n 's/^after_push: //p' "$log"); n=$(sed -n 's/^pr: //p' "$log")
gate=shut
case $v in
  CLEAN) gate=open ;;
  FINDINGS) gate=open
    for id in $(sed -n 's/^  - F[0-9]* .* id=\([0-9]*\) .*/\1/p' "$log"); do
      grep -q "id=$id " <runstate>/review/<pr>-triage.md 2>/dev/null || { gate=shut; echo "untriaged: id=$id"; }
    done ;;
  NO_NEW_REVIEW) printf '%s\n' "$p" | grep -Eq '^[0-9a-f]{7,40}$' && case $sha in "$p"*) gate=open ;; esac ;;
esac
[ "$n" = <pr> ] || gate=shut; echo "review_gate: $gate (verdict $v, after_push $p, head $sha)"
```

- `review_gate: open` with `CLEAN`, or `FINDINGS` whose every `F<n>` is in the ledger
  (the snippet shuts the gate and prints `untriaged:` for each one that is not) with
  the fixes its round calls for pushed and covered by this `PASS`, or
  `NO_NEW_REVIEW` whose `after_push:` is the head being merged: merge.
- An `F<n>` not in the ledger — even one from a review that settled after the grace — is
  triaged first by its round's row; when the row calls for a fix, it is pushed and the
  PR goes back through `--after-push` and CI for the new head. Never wait for a review that started late,
  but never merge past a defect it already named.
- `PENDING_TIMEOUT` (a head no settled round has read gets its own start grace here,
  so a CI repair or a merge of the default branch counts as a push): run the same call
  with `--timeout 540`, then the gate check again; never merge on it.
- `review_gate: shut` for any other reason — another verdict, a `NO_NEW_REVIEW` about
  another push, another PR's log: no merge; act on the verdict by the table above.

Leave `<runstate>/review/<pr>-rounds.json` in place until the PR merges. A run resumed
on a fresh VM has lost it, along with the start grace's clock: the watch then counts
the grace again from its first call there, and the 1800 s caps still hold.

## CI

Read CI only for the head the last push produced, with the call in
`rest-calls.md` › "The CI verdict", into `<runstate>/ci/<pr>.log`.

| Last `verdict:` | Next |
| --- | --- |
| `PASS` | The [review gate](#the-review-gate-before-the-merge), then the merge, in the same turn. |
| `FAIL` | Repair: reproduce with the matching local command (a failing check: `rest-calls.md` › "A failing check"), fix, the matching `cargo` check, commit, push, `--after-push` for the new head, read CI again. At most 3 repairs per issue; a fourth `FAIL` stops the run. |
| `PENDING` | Run the call again. Past 3600 s of reads for one head (`Rust Core` and `macOS` each have a 30-minute timeout, after a runner queue), the PR is held and the run stops. |
| `EMPTY` | Run the call again: check runs appear a little after a push. Still `EMPTY` 600 s after the push, there are no checks at all (`NO_CHECKS`): stop and ask the owner. |
| `ERROR` | Run the call once more; a second `ERROR` is a stop, reported with the message. |

A test deleted, skipped, or weakened to get a `PASS`, or a re-run without a diagnosis,
is a failed repair, not a green one.

## The merge

Merge as soon as the review has settled and the pre-merge read is clean, with CI `PASS`
for the head being merged: no "shall I merge?", no summary-then-wait. The call pins the
merge to that head (`rest-calls.md` › "The merge").

| Reply | Next |
| --- | --- |
| 200, `merged: true` | Read the issue. `closed` → done; record it. Still `open` → read again after 10 s; still open → close it with a back-reference comment (`rest-calls.md` › "Closing an issue GitHub left open") (`CLOSED_MANUALLY`); if that fails, the run stops with the issue named as left open. |
| 409 | The head moved after the CI read. Run `--after-push` and CI for the new head; never retry with the old `sha`. |
| 405 | Read the PR. `mergeable: false` is a conflict: `git fetch origin <default> && git merge origin/<default>` (a merge, never a rebase), resolve a mechanical conflict, run the narrowest checks the resolution touched, push, then `--after-push` and CI again. A conflict that needs a product decision, or a 405 with `mergeable: true` (a required review or rule), holds the PR: stop and ask. `null` → read again. |
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
- Per PR: each round's verdict and `reviewed_sha:`, every finding with its round,
  classification and reason, the commit that fixed the accepted ones and the `P3`s sent
  to follow-ups, a `NO_NEW_REVIEW` and the head it was measured for, a review whose
  `completed_at:` is later than the merge, and that fixes no round read (after round 3,
  or after a `NO_NEW_REVIEW`) were covered by local verification and current-head CI. A held PR is named as held, open.
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
