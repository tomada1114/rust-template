---
name: shipping-issues
description: >
  Covers taking open GitHub issues in this repository to a merged pull request and a
  closed issue, from a local Claude Code session or a Claude Code cloud session
  (CLAUDE_CODE_REMOTE=true), over REST gh api calls only: ranking the backlog by its
  priority: P0-P3 labels and Depends on lines, implementing the pick, reviewing the
  branch with /code-review before the PR exists, opening a PR that says Closes #N,
  reading CI per head SHA with scripts/ci_verdict.py (PASS, FAIL, PENDING, EMPTY, MOVED),
  a squash merge pinned to that head, clearing blocked: dependency on what the merge
  unblocked, and filing follow-ups. Use when asked to ship the next issue, ship issue N,
  ship the remaining issues, or clear the ticket backlog; when a gh subcommand answers
  403 "GitHub GraphQL is not available from Claude Code sessions" while shipping; or
  when a merged PR left its issue open.
---

# Shipping Issues

**Owns:** taking open issues to a merged pull request and a closed issue, on either
host: pick, implement, branch review, PR, CI, merge, dependents, follow-ups, cleanup.
**Does not own:** the label vocabulary, what a priority tier means, and what an issue
body must hold (`triaging-issues`); what is in scope (`AGENTS.md` › "Product"); the PR
body's content rules and the Release impact line (`create-pr`); the commit itself
(`smart-commit`); test-first work (`tdd`).
**Done:** branch reviewed, PR merged, issue closed, no gate deleted or weakened.

## Authority

Invoking this skill is the sign-off for exactly these writes, for this invocation
(`AGENTS.md` › "Security and human approval", standing exceptions):

`shipping-issues`: adding a missing `priority:` tier label to an open issue; removing `blocked: dependency` from issues its merge unblocked; for a design-held issue it takes on, posting its `## Design decision` comment and then clearing `blocked: design` and the ship contract's `design=open`; creating and pushing its own branches (in a cloud session, only the session's designated branch); creating the pull request; on that open PR alone, appending `Closes #<n>` when missing or retargeting its base to the default branch; merging it once CI passes for the current head; closing, with a back-reference comment naming the PR, the issue that merged PR was meant to close when GitHub left it open; filing and labelling follow-up issues; and removing the local branches and worktrees it created — never a force-push, a remote branch deletion, a reply to or resolution of a review thread, a comment requesting a review, or Auto-fix.

Anything else stops and asks: a hook bypass, a weakened gate, a new dependency,
`just labels`, `just ruleset`, a release tag. The go-ahead to merge is a settled
[step 4](#4-review-the-branch) review plus `PASS` for the current head: merge in that
same turn, with no "shall I merge?". The only pauses are the
[stop conditions](#stop-conditions).

## Modes

| Argument | Behavior |
| --- | --- |
| _(none)_ | Ship the top-ranked shippable issue. |
| a number | Ship that issue, once nothing it depends on is open. |
| `all` | Ship every shippable issue, one at a time, re-ranking after each merge. |

## Working rules

- **REST only.** Every GitHub read and write is one `gh api repos/{owner}/{repo}/…`
  call from [rest-calls.md](references/rest-calls.md), on both hosts, so the spelling a
  cloud session needs is the one every local run exercises. A `gh` subcommand that is
  not `gh api` on a REST path is never used; a 403 that names GraphQL or repository
  scope stops the run ([hosts.md](references/hosts.md#a-403-from-the-proxy)).
- **One call per command**: no pipe, no `$(...)`, no redirect, no chain. A body goes
  into a file under the scratchpad (or `$TMPDIR`), written with the file tool, and is
  sent with `-F body=@<file>`; nothing is written inside the checkout.
- **Serial.** One issue start to finish, one PR at a time. Parallel worktrees only when
  the user asks, and only locally ([hosts.md](references/hosts.md#branches-and-worktrees)).
- **No run state.** Nothing is recorded outside GitHub and git: after a compaction or
  on a fresh VM, rebuild from the open PR on the run's branch, its checks, and the
  issue's state before writing anything.
- **No local baseline and no full `just check` before the PR**: CI is the gate every PR
  merges through; run the narrowest check that can fail (`AGENTS.md` › "Validating a
  change").
- **Never take over the machine.** No step runs `myapp tui` or a human's recipe
  (`AGENTS.md` › "Never taking over the developer's Mac").

## Workflow

### 1. Preflight

Read [hosts.md](references/hosts.md) once per run and tell the host apart, then read
[the repository](references/rest-calls.md#the-repository) for its default branch and
merge settings. Three git commands: `git status --short` (a dirty tree holds work this
run did not make: stop and ask), `git branch --show-current`, and
`git fetch origin <default>`. The starting branch is the host's
([hosts.md](references/hosts.md#branches-and-worktrees)).

### 2. Pick

List [the backlog](references/rest-calls.md#the-backlog-and-the-pick) and rank it by
reading the projection: never a `tracking` or `on hold` issue, never one carrying a
`blocked:` label or a `Depends on` line whose issue is still open; then tier (`P0`
first), then oldest. `triaging-issues` says what each label and tier means. An issue
with no tier gets one by that rubric, [written as a label](references/rest-calls.md#a-missing-priority-tier),
before it is ranked. A design-held issue (`blocked: design`, or `design=open` in its
[ship contract](references/ship-contract.md)) is taken only by number, and
[its design is settled first](references/rest-calls.md#settling-a-held-design).
Nothing shippable → report what holds each issue and stop.

### 3. Implement

Read [the issue and every comment](references/rest-calls.md#one-issue) and write an
acceptance-to-check map before editing. Take the branch the host gives
([hosts.md](references/hosts.md#branches-and-worktrees)). Implement with the skills
`AGENTS.md` routes the change to (**REQUIRED:** `tdd` for a behavior change), inline or
handed to `executor` (`subagent_type: executor`; `architect` when the change carries a
design judgment) with the issue, the map, and the checks to run. Judge the result
against the map: a criterion that is `not-met` goes back, not into the PR. Run the
narrowest checks that can fail, then commit with **REQUIRED:** `smart-commit`. A
user-visible change carries its `CHANGELOG.md` entry. What falls outside the issue goes
to [step 9](#9-file-the-follow-ups), never into this diff.

### 4. Review the branch

Before any PR exists, once per branch: `/code-review medium <branch>` (effort first,
branch second; never a PR-number target, never `--comment`). `high` only when the change
can lose user data or alters a contract (`AGENTS.md` › "What is contract and what is
private"); never another effort. If the host cannot launch `/code-review`, hand
`git diff <default>...HEAD` and the issue to one read-only `architect`
(`subagent_type: architect`) in a context that did not write the change; never re-read
your own diff and call it a review.

Classify every finding with a one-line reason that holds against the code: **accepted**
(real, and this issue's), **rejected** (wrong on reading the code), or **out of scope**
(real, not this diff's: step 9). Fix the accepted ones, re-run the narrowest check, and
commit; there is no second pass. A finding that needs the owner's decision holds the
branch: no PR opens, and the run stops with the question.

### 5. Open the PR

`git status --short` prints nothing, then `git push -u origin <branch>` as a command of
its own. [Create a ready PR](references/rest-calls.md#opening-the-pr) against the
default branch, its body filled from `.github/PULL_REQUEST_TEMPLATE.md` with
**`Closes #<n>`** on its own line (**REQUIRED:** `create-pr` for the body's content
rules). Check the reply, then [read the PR](references/rest-calls.md#reading-the-pr):
a missing closing keyword or a wrong base is
[repaired](references/rest-calls.md#repairing-the-prs-closing-link) before CI is read.
No review of the PR is requested or awaited.

### 6. CI

```bash
python3 .claude/skills/shipping-issues/scripts/ci_verdict.py <pr> --sha <head_sha>
```

One foreground slice (480 s by default; raise the call's own timeout to 600000 ms),
repeated per [the verdict table](references/rest-calls.md#the-ci-verdict): `PASS` →
step 7; `FAIL` → repair, at most 3 times; `PENDING` past 3600 s or `EMPTY` 600 s after
the push → stop and ask; `MOVED` → watch the new head; `ERROR` → once more, then stop.
A test deleted, skipped, or weakened to get a `PASS` is a failed repair.

### 7. Merge and confirm

A PR whose change needs evidence only a human can produce (`just test-local` output, a
run of `myapp tui`) is held, open, and named in the report; it is not merged.
Otherwise, in the same turn as the `PASS`: read the PR once more (`closes: true`, base
the default branch), [squash-merge pinned to the head CI passed](references/rest-calls.md#the-merge),
and read the issue. Still open after 10 s →
[close it with a back-reference comment](references/rest-calls.md#closing-an-issue-github-left-open).
A 409 means the head moved: back to step 6 for the new head, never the old `sha` again.

### 8. Unblock dependents

List the backlog again and
[remove `blocked: dependency`](references/rest-calls.md#issues-the-merge-unblocked) from
each open issue whose last open dependency was this one. A stale label on an issue that
does not depend on this one is left, and reported.

### 9. File the follow-ups

Prefer, in order: fix it in the open diff (a sibling of the defect being fixed, found
before the merge, covered by the same tests); file it; do not file a restatement or a
speculation. Verify the defect against the code first.
[File](references/rest-calls.md#a-follow-up-issue) right after the merge that surfaced
it, with a body that meets `triaging-issues` and ends with a
[ship contract](references/ship-contract.md).

### 10. Clean up

Return the checkout to the default branch's state the way the host does
([hosts.md](references/hosts.md#after-the-merge)): locally, switch back, fast-forward,
and remove by name only the local branches and worktrees this run created; in a cloud
session, merge the default branch into the session's branch. Never a remote branch
deletion on either host. In `all` mode, return to step 2 without pausing; an issue that
fails before its first commit is skipped with its reason, and so is anything depending
on it.

### 11. Report

No prescribed format, but never omit:

- an issue left open behind a merged PR, a PR left held, and every stop, with its reason;
- per PR: how the branch was reviewed (effort, or the fallback), the findings accepted,
  rejected, and filed, and any acceptance criterion that shipped `not-met`;
- every write beyond push, PR, and merge: a tier label added, a design decided (its
  comment URL), a PR body or base repaired, an issue closed by hand, labels cleared;
- follow-ups filed (URL and labels), what was fixed inline instead, and what was
  checked and deliberately not filed;
- a check the host could not run, and any action left for the owner (reconnecting
  GitHub, clearing Auto-fix, running `just labels`).

## Stop conditions

Stop the run and report when:

- a call answers 403 for GraphQL or repository scope, or a push or every call fails the
  same way after one retry ([hosts.md](references/hosts.md));
- nothing is shippable, or the named issue is not ready;
- a review finding or a held design needs the owner's decision;
- CI is `PENDING` past 3600 s, `EMPTY` 600 s after the push, `FAIL` a fourth time, or
  `ERROR` twice; or the merge is refused for a reason other than a moved head;
- the merged issue is still open after the close by hand, or a PR repair left its body
  or base wrong;
- a conflict needs a product decision;
- the checkout, a branch, or the default branch changed in a way this run did not make:
  leave it exactly as found (no stash, no restore, no commit) and ask;
- a fix needs a write the [Authority](#authority) section does not cover.
