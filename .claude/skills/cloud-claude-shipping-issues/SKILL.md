---
name: cloud-claude-shipping-issues
description: >
  Covers shipping GitHub issues in this repository from a Claude Code cloud session
  (CLAUDE_CODE_REMOTE=true), serially and inline over REST gh api calls: ranking with
  issue_digest.py in file mode, implementing on the session's one branch with cargo
  checks (no just or mise on the VM), opening a PR that says Closes #N, up to three
  automatic Codex review rounds read by review_watch.py, CI read per head SHA, a
  squash merge pinned to that head, and the follow-ups. Use when asked to ship the next
  issue, issue N, or the backlog from a cloud session; when the shipping-issues
  preflight prints host: cloud; or when gh pr, gh issue, or a GraphQL call answers 403
  "GitHub GraphQL is not available from Claude Code sessions" while shipping.
---

# Shipping Issues from a Claude Code Cloud Session

**Owns:** shipping issues end to end from a Claude Code cloud session — rank, implement,
PR, review, CI, merge, follow-ups, and the session's branch between issues — over REST.
**Does not own:** the local workflow and its scripts (`shipping-issues`), Codex's
(`codex-shipping-issues`), or what an issue body and a label mean (`triaging-issues`).
**Done:** review settled, PR merged, issue CLOSED, no gate deleted or weakened.

## Authority

**Invoking this skill is the sign-off for exactly these remote writes, for this
invocation:** pushing its own branch (the session's designated branch); creating the
pull request; on that open PR alone, appending `Closes #<n>` to its body when the body
lacks it, or retargeting its base to the default branch; merging it once CI passes;
closing by hand, with a back-reference comment naming the PR, the issue that merged PR
was meant to close when GitHub left it open; for the design-held issue the run takes on,
posting its `## Design decision` comment and then clearing its design block (its
design-block label, and `design=open` to `design=settled` in its ship contract); filing
and labelling follow-up issues; and removing `blocked: dependency` from the issues its
merge unblocked. Nothing else: no force-push, no branch deletion, no reply to or
resolution of a review thread, no `@codex review`, no `just labels`, no other label
change on any issue, no other comment, no other PR or issue edit, no other issue closed,
and no Auto-fix. A step that would need one stops and asks. Commits go through
`smart-commit`, under its own exception. A new dependency is proposed, and the run waits
for sign-off.

The go-ahead to merge is a settled [review](#5-wait-for-the-review) and a `PASS` for
the current head: the merge happens in that same turn, with no "shall I merge?". The
only pauses are the [stop conditions](#stop-conditions).

## Modes

| Argument | Behavior |
| --- | --- |
| _(none)_ | Ship the top-ranked shippable issue. |
| a number, e.g. `42` | Ship that issue, once nothing it depends on is open. |
| `all` | Ship every shippable issue, one at a time, re-ranking after each merge. |

## Working rules

- **Serial and inline.** One issue start to finish, on the session's one branch, in
  this session: no worktrees, no parallel sub-agents, no background commands
  ([why](references/cloud-host.md#run-state-lives-on-the-vm)).
- **REST only.** Every GitHub read and write is a `gh api repos/{owner}/{repo}/...`
  call from [rest-calls.md](references/rest-calls.md), or a built-in GitHub tool doing
  the same REST operation. Of `shipping-issues`' scripts, this skill runs only
  `issue_digest.py` (file mode), `review_watch.py`, and `run_record.py` (with
  `--repo`); the rest are local-only and are never run here.
- **A 403 for GraphQL or repository scope stops the run**: report the call and its
  message, and never retry it another way
  ([cloud-host.md](references/cloud-host.md#a-403-from-the-proxy)).
- **State lives in `<runstate>`** ([rest-calls.md](references/rest-calls.md)), never in
  the checkout. Record each event with `run_record.py --repo <owner>/<repo> --event
  <event> --field k=v` as it happens; re-read `<runstate>/run.md` after a compaction.
- **Waits are foreground slices** under 10 minutes, the call's timeout raised to
  match, repeated up to the step's cap — never a background command.

## Workflow

### 1. Check the host

```bash
test "$CLAUDE_CODE_REMOTE" = true && echo "host: cloud" || echo "host: local"
```

`host: local` → stop here: this is not a cloud session; use `shipping-issues`. Then
read [cloud-host.md](references/cloud-host.md) once, and the repository
([its call](references/rest-calls.md#the-repository)): `full_name`,
`default_branch`, `delete_branch_on_merge`. The branch is the one the session's
instructions name (`git branch --show-current`), never the default branch. A dirty
tree holds work this run did not make: stop and ask. Otherwise
`git fetch origin <default> && git merge --no-edit origin/<default>`; a non-empty
`git diff --stat origin/<default>` afterwards is the same stop, unless it is an open PR
from this branch: a run resumed on a fresh VM, which continues that PR
([how](references/cloud-host.md#run-state-lives-on-the-vm)). Record `run-start`.

### 2. Rank

Fetch the open issues and PRs and run the digest on them
([the calls](references/rest-calls.md#the-backlog-and-the-pick)). `select: none` →
report why (the `held:` line) and stop. A `tracking` issue is never shipped; its
sub-issues are. Unlabelled issues rank on their suggested `~P<n>` tier: list them in
the report, never write the label. An issue whose design is not settled
(`blocked: design` or `design=open`) is taken only by number: decide its design inline,
post the decision, and clear the block before step 3; a product call the thread does
not answer stops the run with the question
([how](references/review-ci-merge.md#a-held-design)). Record `selection`.

### 3. Implement

Read the issue and every comment ([how](references/rest-calls.md#one-issue)), and write
an acceptance-to-check map before editing. No baseline runs: CI is the gate, as in
`shipping-issues`. Implement inline with the skills `AGENTS.md` routes the change to
(**REQUIRED:** `tdd` for a behavior change), and run the narrowest checks that can fail
(`AGENTS.md` › "Validating a change") as the `cargo` commands under those recipes, in
foreground slices ([the toolchain](references/cloud-host.md#what-the-session-starts-with)).
Commit with **REQUIRED:** `smart-commit`, running the pre-commit hook's own checks by
hand first, since the VM has no hook installed. A check the VM cannot run is named in
the report, never skipped silently. Keep the change within the issue; what falls
outside it goes to step 9.

### 4. Open the PR

`git push -u origin <branch>`, then create a ready PR against the default branch with
`Closes #<n>` in its body ([the call](references/rest-calls.md#opening-the-pr)). Check
the reply's `base:` and `draft: false`, then read the PR: a missing `Closes #<n>` or a
wrong base is [repaired](references/rest-calls.md#repairing-the-prs-closing-link)
before the review watch starts. Record `pr-created`. Never turn on Auto-fix for
it ([why](references/cloud-host.md#auto-fix-stays-off)).

### 5. Wait for the review

Each Codex review is a round, at most 3 per PR: round 1's accepted findings are all
fixed; rounds 2–3 fix accepted `P0`–`P2` and send a `P3` to step 9. Run
`review_watch.py <pr>` once the PR opens and act on its verdict
([how](references/review-ci-merge.md#the-review)). **After every push**, run
`review_watch.py <pr> --after-push <sha>` before reading CI: it waits a 300 s start
grace for a review of that push, then reports the next round or `NO_NEW_REVIEW`, which
stands for that head alone. `NO_REVIEW`, or `ERROR` after one re-run, holds the PR and
stops the run. Record `review` per round.

### 6. Read CI

Read the check runs and the combined status for the current head
([the call](references/rest-calls.md#the-ci-verdict)). `PASS` → step 7. `FAIL` →
repair, at most 3 times. `PENDING` past 3600 s, or `EMPTY` 600 s after the push
(no checks at all), → stop and ask
([the table](references/review-ci-merge.md#ci)). Record `ci`.

### 7. Merge

Right before the merge, pass the [review gate](references/review-ci-merge.md#the-review-gate-before-the-merge):
`review_watch.py <pr> --after-push <head_sha> --timeout 0` must read `CLEAN` or
`FINDINGS` with every finding triaged, or `NO_NEW_REVIEW` for the head being merged;
never merge past a posted, untriaged finding. Read
the PR ([the call](references/rest-calls.md#reading-the-pr)): `closes: true` and the
default branch as `base:`, else [repair it](references/rest-calls.md#repairing-the-prs-closing-link)
and read CI again. Then squash-merge pinned to the head CI passed
([the call](references/rest-calls.md#the-merge)). 409 → steps 5 and 6 for the new head,
never the old `sha` again; 405 → [the table](references/review-ci-merge.md#the-merge).
Confirm the issue is `closed`, else [close it](references/rest-calls.md#closing-an-issue-github-left-open)
with a back-reference comment; record `merged`.

### 8. Bring the branch up to date and clear what the merge unblocked

`git merge origin/<default>` into the session's branch and check its diff is empty —
never a reset and force-push
([branch upkeep](references/review-ci-merge.md#branch-upkeep-after-the-merge)). Fetch
the backlog again and remove `blocked: dependency` from each issue whose last open
dependency was this one
([the calls](references/rest-calls.md#issues-the-merge-unblocked)).

### 9. File the follow-ups

A sibling of the defect being fixed, found before the merge, is fixed inline in the
open diff; a real, separate defect is filed; a restatement or a speculation is not. **BACKGROUND:** `shipping-issues`, whose reference
on filing follow-ups holds the long form. Verify the defect against the code first. The
body meets `triaging-issues` and ends with the ship contract; the labels are a type
label, a `priority:` tier, and `blocked: dependency` or `blocked: design` when they
apply, each checked to exist first
([the calls](references/rest-calls.md#a-follow-up-issue)). File right after the merge
that surfaced it; record `followup`.

### 10. All mode

Ship one issue at a time: after each merge, fetch the backlog again and rank afresh
(step 2), then start step 3 from the up-to-date branch, without pausing. Once an issue
has a commit on the branch it either merges or stops the run, since the branch cannot
carry two issues' work. An issue that fails before its first commit is skipped, with
the reason, and so is anything depending on it.

### 11. Report

No prescribed format, but never omit
[these facts](references/review-ci-merge.md#what-the-report-must-not-omit) — above all
an issue left open behind a merged PR, a criterion shipped `not-met`, and a PR left
held.

## Stop conditions

Stop the run and report when:

- a REST call answers 403 for GraphQL or repository scope, or a push or every call
  fails the same way after a retry ([cloud-host.md](references/cloud-host.md));
- the digest selects nothing, or the named issue is not ready;
- a PR is held: `NO_REVIEW`, a review `ERROR`, a finding that needs the owner, one
  accepted past round 3, CI pending past 3600 s, `NO_CHECKS`, a fourth CI `FAIL`, or a
  merge refused for a reason other than a moved head;
- the merged issue is still open after the close by hand, or a PR repair left its body
  or base wrong;
- a conflict needs a product decision, or a held design needs one (`DEFERRED`);
- the checkout, the branch, or the default branch changed in a way this run did not
  make: leave it exactly as found and ask.

Record before stopping (`--event blocked --field reason=<...>`).
