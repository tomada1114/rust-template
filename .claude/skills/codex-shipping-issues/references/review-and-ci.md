# Review rounds, current-head CI and landing

## Record reviewed and current revisions separately

Record repository, issue, PR URL/number, each review round's ID and reviewed commit,
current head SHA, base SHA/ref, correction commits and check/run evidence. Refresh
head/base when checking CI or landing. Never present a review as cloud review of a
commit it did not read. A changed diff invalidates old CI and local acceptance
evidence, but each completed review remains recorded for this PR.

The Codex integration reviews the PR when it opens and, depending on the change, may
review again after a correction push. The owner's policy handles at most **three
review rounds** per PR:

| Round | Fix in this PR | Accepted but not fixed here |
| --- | --- | --- |
| 1 (opening review) | every accepted finding, whatever its badge | — |
| 2 and 3 (reviews of correction heads) | accepted `P0`, `P1` and `P2` findings | accepted `P3`: a reported follow-up candidate |

After pushing round 3's corrections, do not wait for a fourth review; land on local
verification and current-head CI. Never request a review to fill a round. This does
not remove repository-required approvals, checks or unresolved correctness decisions.

## Wait for the opening review

Discover GitHub MCP actions and inspect review submissions, inline threads, the PR
conversation and review-task metadata. Follow pagination or another MCP action when
normalized responses omit data. Report required inaccessible evidence; never use
`gh` or direct HTTP as a fallback.

Open a regular PR. Record the opening event and the automatic review's trusted
integration identity, state and reviewed commit. Wait through its queue/start delay
and running state. Do not post `@codex review`, `@codex fix`, change review settings,
or close/reopen the PR to start another run. If the opening run fails or cannot be
observed, report that blocker without claiming completion or replacing it with a
local review.

| Review state | Action |
| --- | --- |
| Not started / queued | Wait for the opening-triggered review. |
| Running | Observe review and CI in bounded waits. |
| Completed, findings | Read all findings and address accepted in-scope ones. |
| Completed, no findings | Record terminal state and the reviewed commit. |
| Failed / unavailable | Report missing evidence and preserve the PR. |

Completion must be terminal and come from the trusted Codex integration, associated
with this PR and its reviewed commit. A display name, acknowledgement, reaction,
green CI or silence alone is insufficient. A trusted terminal summary with matching
commit metadata, a no-findings signal and empty findings/threads can establish a
clean review. Completion alone does not mean there were no findings.

Classify each finding as accepted, rejected or out of scope with a reason judged
against the code, not the badge. Fix what the round's row above allows, inspect the
complete correction diff, run affected checks and `just check`, commit with normal
hooks and push. Record which commits address which findings in which round. An
unresolved owner decision or correctness finding blocks landing; CI success cannot
dismiss it. Resolve threads only within comment/thread-write scope. Report accepted
`P3` findings from rounds 2–3 and out-of-scope findings as follow-up candidates; file
them only within explicit issue-write scope.

## Wait briefly for the next round

After each correction push in rounds 1 and 2, observe the PR for up to **300 seconds**
for a trusted review that starts on the new head (observed: 12 seconds to about 2.5
minutes after the push, and some pushes start none). If one starts, wait for it to
complete and handle it as the next round. If none starts within that grace, the latest
completed review stands: land on local verification and current-head CI. Observe this
alongside CI: CI here compiles the workspace from scratch and its slowest required jobs
(`Rust Core`, `macOS`) have 30-minute timeouts, so CI usually outlasts the grace.

If a review appears after round 3's corrections, do not wait for its completion and
do not start a fourth correction round. Triage any `P0` or `P1` finding it has
already posted: an accepted one blocks landing and is reported for the owner.

## Verify CI on the current head

Inspect workflows, jobs/steps and required checks for the latest head through MCP,
including pagination. Compare with the committed ruleset and workflows; inspect
live requirements/approvals where MCP exposes them. Report unavailable policy fields
without inventing approvals or bypassing server-enforced requirements.

A green check for one job, an earlier SHA or a partial response is insufficient.
Distinguish success, failure, pending, skipped, cancelled and inaccessible checks.
A skipped required check is not success unless active policy explicitly permits it.
Diagnose failures while a review is pending. Any correction or changed
base integration requires fresh local acceptance and CI for the resulting head.
Retries must be authorized and associated with their actual head/run. Never change
settings or dispatch workflows merely to obtain missing evidence.

Use bounded observations (at most 60 seconds per blocking wait) and back off when
state is unchanged. Continue in-scope repairs without an arbitrary attempt cap.
Pending gates or elapsed time alone do not complete or fail a run. Honor user
deadlines and host limits. Once the latest review round is complete, the findings it
requires are addressed, the next-round grace has passed without a new review (or the
round cap is reached), and current-head gates pass, no further review wait is required.

## Land within recorded authorization

At a PR-only boundary, preserve the open PR. For an authorized merge:

1. Refresh head/base, mergeability, known findings, required approvals and all
   expected checks. Confirm every handled review round completed, the findings each
   requires have correction evidence, no started review is still running within the
   round cap, and local acceptance/CI cover the current diff. Integrate
   the current default branch normally if needed, repeat local checks and CI, and
   inspect the resulting diff. Do not request another review or force-push.
2. Merge through MCP with the expected-head-SHA guard and an allowed merge method.
   Never use an admin bypass. If the head changes or merge is rejected, inspect
   the actual state before retrying; do not route around a policy rejection.
3. Fetch the PR again and verify merged state, target branch and merge commit.
   Confirm the linked issue closed. If closure failed, close it only within
   explicit issue-closure scope; otherwise report the remaining open issue.
   A successful write response alone is not postcondition verification.
4. Preserve the primary checkout and evidence. Perform only authorized cleanup
   through the matching local or managed-worktree lifecycle and verify outcomes.

Report each review round's reviewed commit and addressed findings, follow-up
candidates, final head and CI separately, including whether the final head's
corrections were locally verified without a further cloud review.
