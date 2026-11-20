# The REST calls

Every GitHub read and write this skill makes, spelled as a `gh api` call, with what each
reply means for the run. The same spelling serves both hosts: a cloud session's proxy
refuses GraphQL (`hosts.md` › "A 403 from the proxy"), so no step uses a `gh` subcommand
other than `gh api` on a REST path, a hand-built GraphQL query, or the issue-search
endpoint. A built-in GitHub tool that performs the same REST operation may stand in for
a call; nothing else may.

How each call is run:

- From the checkout's root, where `gh api` fills `{owner}` and `{repo}` itself
  (`hosts.md` › "How GitHub is reached").
- One `gh api … --jq …` per command: no pipe, no `$(...)`, no redirect, no chain. A
  local permission or sandbox rule that admits `gh api` matches the command's text, so
  only the bare call matches it.
- A request body is a file: write it with the file tool under the scratchpad directory
  (or `$TMPDIR`), never inside the checkout, and send it with `-F body=@<file>`. To edit
  a body GitHub already holds, print it with `--jq '.body // ""'`, write the edited text
  to a file, and send that file.

## Table of Contents

- [The repository](#the-repository)
- [The backlog and the pick](#the-backlog-and-the-pick)
- [A missing priority tier](#a-missing-priority-tier)
- [One issue](#one-issue)
- [Settling a held design](#settling-a-held-design)
- [Opening the PR](#opening-the-pr)
- [Reading the PR](#reading-the-pr)
- [Repairing the PR's closing link](#repairing-the-prs-closing-link)
- [The CI verdict](#the-ci-verdict)
- [A failing check](#a-failing-check)
- [The merge](#the-merge)
- [Closing an issue GitHub left open](#closing-an-issue-github-left-open)
- [Issues the merge unblocked](#issues-the-merge-unblocked)
- [A follow-up issue](#a-follow-up-issue)

## The repository

```bash
gh api repos/{owner}/{repo} \
  --jq '"repo: \(.full_name)\ndefault: \(.default_branch)\ndelete_branch_on_merge: \(.delete_branch_on_merge)\nallow_squash_merge: \(.allow_squash_merge)"'
```

`full_name`, `default_branch`, `delete_branch_on_merge` and `allow_squash_merge` are
fields of the repository object
([get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository),
checked 2026-10-07). `allow_squash_merge: false` is a stop: this skill merges by squash
only. `delete_branch_on_merge: false` is a report line, not a stop: the merged head
branch stays on the remote until the owner turns the setting on (`AGENTS.md` › "GitHub
settings a new repository must enable"), because this skill deletes no remote branch.

## The backlog and the pick

```bash
gh api --paginate "repos/{owner}/{repo}/issues?state=open&per_page=100" \
  --jq '.[] | select(has("pull_request") | not) | "#\(.number) [\([.labels[].name] | join(", "))] \(.created_at[0:10]) \(.title)\n  deps: \([(.body // "") | split("\n")[] | select(test("^[-*0-9. \\[\\]x]*(Depends on|Blocks):? #[0-9]+")) | gsub("\\s+$"; "")] | join("; "))\n  ship: \([(.body // "") | scan("<!-- ship:[^>]*-->") | gsub("\\s+"; " ")] | join(" "))"'
```

Three lines per open issue: its number, labels, creation date and title; its
`Depends on` and `Blocks` lines; and its ship contract (`ship-contract.md`). The issues
endpoint lists pull requests too, each marked by a `pull_request` key
([list repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues),
checked 2026-10-07); the projection drops them. The open pull requests, so an issue
that already has one is not started twice:

```bash
gh api --paginate "repos/{owner}/{repo}/pulls?state=open&per_page=100" \
  --jq '.[] | "\(.number) \(.head.ref) \(.user.login) \(.title)"'
```

Rank by reading the projection, in this order:

1. Drop every issue labelled `tracking` or `on hold`, and every issue an open pull
   request already names in its title or branch.
2. Drop every issue that is not ready: a `blocked: external` label; a `blocked: design`
   label or `design=open` (unless it was named by number: "Settling a held design"); a
   dependency that is still open. A dependency is a number on a `Depends on` line or in
   the contract's `blocked-by=`, and it is open exactly when that number is in this
   list. A `blocked: dependency` label with no open dependency left is stale: the issue
   is ready, and the label is cleared only where "Issues the merge unblocked" allows,
   otherwise reported.
3. Order what is left by tier, `priority: P0` first, then by creation date, oldest
   first. The contract's `tier=` stands in for a missing label.

A named issue skips the ordering, not the readiness: if a dependency is open, the run
stops and says which. List the backlog again after every merge or filing; never rank
from an earlier listing.

## A missing priority tier

An open issue with neither a `priority:` label nor a `tier=` gets a tier before it is
ranked, decided by reading it against `triaging-issues`' "Priority and readiness
labels" table. Check that the label exists, then add it:

```bash
gh api "repos/{owner}/{repo}/labels/priority%3A%20P2" --jq .name
gh api -X POST repos/{owner}/{repo}/issues/<n>/labels -f 'labels[]=priority: P2' \
  --jq '[.[].name] | join(", ")'
```

The second call adds to the issue's labels and leaves the others in place
([add labels to an issue](https://docs.github.com/en/rest/issues/labels#add-labels-to-an-issue),
checked 2026-11-19). Only a missing tier is written: a tier that looks wrong is the
owner's to change, and a label the repository lacks (the first call answers 404) is a
report line asking for `just labels`, never a label definition created here.

## One issue

```bash
gh api repos/{owner}/{repo}/issues/<n> --jq '"#\(.number) \(.state) \(.title)\nlabels: \([.labels[].name] | join(", "))\n\n\(.body)"'
gh api --paginate repos/{owner}/{repo}/issues/<n>/comments --jq '.[] | "--- \(.user.login) \(.created_at)\n\(.body)"'
```

Read the body and every comment before the acceptance map. A dependency named in the
body is read the same way, for its `state`; so is the parent a `Part of` line names.

## Settling a held design

Only for the design-held issue the run takes on by number, before any code is written.

1. Settle the approach from the repository, its conventions, and the issue thread: the
   approach and the alternatives rejected with why; the files and functions that
   change; the data, config, and API surface with exact names and defaults; the edge
   behavior; what the tests must pin; what is out of scope.
2. Never decide a product or UX call the repository and the thread do not already
   answer: what a user is promised, a policy, wording a user sees. That is deferred:
   write nothing, stop, and ask the one question.
3. Decided: write the decision to a file, starting with `## Design decision` and
   standing alone, and post it. Only once it posted, clear both forms of the block.

```bash
gh api -X POST repos/{owner}/{repo}/issues/<n>/comments -F body=@<file> --jq .html_url
gh api -X DELETE "repos/{owner}/{repo}/issues/<n>/labels/blocked%3A%20design" --jq '[.[].name] | join(", ")'
```

A contract's `design=open` becomes `design=settled` with the rest of the body byte for
byte: print the body, write it to a file with that one word changed, and send it.

```bash
gh api repos/{owner}/{repo}/issues/<n> --jq '.body // ""'
gh api -X PATCH repos/{owner}/{repo}/issues/<n> -F body=@<file> --jq '.body | test("design=settled")'
```

A comment that failed to post leaves the block on. A block that failed to clear after
the comment posted is cleared before implementing, never left for the next run to
misread. The tier label and the rest of the issue stay as they are.

## Opening the PR

Write the body to a file from `.github/PULL_REQUEST_TEMPLATE.md`: the summary, then
**`Closes #<n>`** on its own line, then the Release impact line, the test plan, and the
checklist, each box ticked only when true. Then:

```bash
gh api -X POST repos/{owner}/{repo}/pulls -f title='<conventional-commit title>' \
  -f head=<branch> -f base=<default> -F body=@<file> \
  --jq '"pr: \(.number)\nurl: \(.html_url)\nhead_sha: \(.head.sha)\nbase: \(.base.ref)\ndraft: \(.draft)"'
```

Leaving out `draft` creates the PR ready
([create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request),
checked 2026-10-07), and a draft could not be merged. Check the reply: `base:` is the
default branch and `draft: false`. A 422 that says a pull request already exists for
the branch: list it with
`gh api "repos/{owner}/{repo}/pulls?head=<owner>:<branch>&state=open" --jq '.[] | "\(.number) \(.title)"'`.
One this run opened for the same issue is the PR to continue; anything else is a stop.

## Reading the PR

```bash
gh api repos/{owner}/{repo}/pulls/<pr> \
  --jq '"state: \(.state)\nmerged: \(.merged)\ndraft: \(.draft)\nhead_sha: \(.head.sha)\nbase: \(.base.ref)\nmergeable: \(.mergeable)\nmergeable_state: \(.mergeable_state)\ncloses: \((.body // "") | test("(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#<n>\\b"))"'
```

`mergeable` is `true` or `false` once GitHub has computed it and `null` while it is
still computing; read again after a few seconds
([get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request),
checked 2026-10-07). GitHub reads a closing keyword only in a pull request that targets
the default branch
([linking a pull request to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue),
checked 2026-11-19), so `closes: false` or a `base:` other than the default branch
means the merge would leave the issue open:
[repair it](#repairing-the-prs-closing-link).

## Repairing the PR's closing link

The only edits this skill makes to a PR, and only to the open PR it created for `#<n>`.
**`closes: false`** means the body has no closing keyword for `#<n>`: append one, never
a second. Print the body, write it to a file with a blank line and `Closes #<n>` added
at the end, and send it:

```bash
gh api repos/{owner}/{repo}/pulls/<pr> --jq '.body // ""'
gh api -X PATCH repos/{owner}/{repo}/pulls/<pr> -F body=@<file> \
  --jq '"closes: \((.body // "") | test("(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#<n>\\b"))"'
```

**A `base:` other than the default branch** is retargeted:

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/<pr> -f base=<default> --jq '"base: \(.base.ref)"'
```

`body` and `base` are fields of the update call
([update a pull request](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request),
checked 2026-10-07). Each edit fires the PR's `edited` workflows and a retarget re-runs
its checks, so make them before the CI read, and read CI again after one. One attempt
each: a reply that still reads `closes: false` or the wrong `base:` is a stop. Whether
GitHub has linked the keyword is not a REST fact, so the issue's state is checked after
the merge instead ([closing an issue GitHub left open](#closing-an-issue-github-left-open)).

## The CI verdict

```bash
python3 .claude/skills/shipping-issues/scripts/ci_verdict.py <pr> --sha <head_sha>
```

`<head_sha>` is the head the last push produced (the `head_sha:` of the PR read). The
script reads that commit's check runs and combined status every 30 s for up to 480 s,
one foreground slice, and prints `verdict:`, `head_sha:`, and on a failure one
`failed_check:` line per check; its header states the rule. Read CI only for the
current head, and act on the last `verdict:`:

| `verdict:` | Next |
| --- | --- |
| `PASS` | The merge, in the same turn, pinned to the printed `head_sha:`. |
| `FAIL` | Repair: find the failing job ([a failing check](#a-failing-check)), reproduce it with the matching local recipe, fix, re-run that recipe, commit, push, and read CI for the new head. At most 3 repairs per issue; a fourth `FAIL` stops the run. A re-run without a diagnosis is not a repair. |
| `PENDING` | Run the script again. Past 3600 s of reads for one head (`Rust Core` and `macOS` each have a 30-minute timeout, after a runner queue), the PR is held and the run stops. |
| `EMPTY` | Run the script again: check runs appear a little after a push. Still `EMPTY` 600 s after the push, there are no checks at all, and no checks is never a pass: stop and ask the owner. |
| `MOVED` | The PR's head is not the commit being watched. A push of this run's own: run the script again with the new `--sha`. Anyone else's: a change this run did not make, a stop. |
| `ERROR` | Run the script once more; a second `ERROR` is a stop, reported with its `ERR_CI_GH` lines. |

Where a host will not let the script start `gh` itself, read the same two endpoints
with one bare call each and apply the script's rule by hand (the script's own `gh`
calls ran from a sandboxed local session: observed on this Mac with
`ci_verdict.py <pr>` on a merged pull request, 2026-11-19):

```bash
gh api --paginate "repos/{owner}/{repo}/commits/<head_sha>/check-runs?per_page=100" \
  --jq '.check_runs[] | "\(.status) \(.conclusion // "none") \(.name)"'
gh api repos/{owner}/{repo}/commits/<head_sha>/status --jq '"state: \(.state) statuses: \(.total_count)"'
```

`PASS` needs every check run `completed` with `success`, `neutral`, or `skipped`, and a
combined state of `success` or a count of zero statuses; any other completed conclusion,
or a combined `failure`, is `FAIL`; no check run and no status is `EMPTY`; anything else
is `PENDING`. Check-run statuses and conclusions are the enums of
[list check runs for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference),
and the combined state is `pending` when there are no statuses at all, which is why a
zero count is not a failure
([combined status](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference),
both checked 2026-10-07).

## A failing check

```bash
gh api "repos/{owner}/{repo}/commits/<sha>/check-runs?per_page=100" \
  --jq '.check_runs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | "\(.name)\t\(.html_url)"'
```

Reproduce the failure with the matching local recipe first: CI runs the recipes of
`just check` (`AGENTS.md` › "Enforcement layers"). When the log is needed, the job ids
come from
`gh api "repos/{owner}/{repo}/actions/runs?head_sha=<sha>" --jq '.workflow_runs[] | "\(.id) \(.name) \(.conclusion)"'`
and `gh api repos/{owner}/{repo}/actions/runs/<run_id>/jobs --jq '.jobs[] | "\(.id) \(.name) \(.conclusion)"'`,
and a job's log is `gh api repos/{owner}/{repo}/actions/jobs/<job_id>/logs`, a redirect
to a short-lived download
([download job logs](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run),
checked 2026-10-07). A log is long: read its end, around the first error, never the
whole of it.

## The merge

```bash
gh api -X PUT repos/{owner}/{repo}/pulls/<pr>/merge -f merge_method=squash -f sha=<head_sha> \
  --jq '"merged: \(.merged)\nsha: \(.sha)"'
```

`<head_sha>` is the SHA the `PASS` was printed for. Pinning the merge to it is what
keeps a commit pushed after the CI read from merging unchecked: GitHub merges only when
the PR's head still matches. The replies that matter are 200 merged, 405 the merge
cannot be performed, and 409 the head no longer matches the `sha`
([merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request),
checked 2026-10-07); `gh` exits non-zero and prints `HTTP 405` or `HTTP 409` on the
latter two.

| Reply | Next |
| --- | --- |
| 200, `merged: true` | Read the issue (below). |
| 409 | The head moved after the CI read. Read CI for the new head; never retry with the old `sha`. |
| 405 | Read the PR. `mergeable: false` is a conflict: `git fetch origin <default>`, then `git merge origin/<default>` (a merge, never a rebase), resolve a mechanical conflict, run the narrowest checks the resolution touched, push, then CI again. A conflict that needs a product decision, or a 405 with `mergeable: true` (a required review or rule), holds the PR: stop and ask. `null` → read again. |
| 403 | A refusal from the proxy (`hosts.md` › "A 403 from the proxy"), or no merge permission: stop and report. |
| anything else | Read the PR: only `merged: true` is a merge. Report the reply and stop. |

Then the issue:

```bash
gh api repos/{owner}/{repo}/issues/<n> --jq '"issue: \(.state) \(.state_reason // "")"'
```

## Closing an issue GitHub left open

Only for `#<n>`, the issue the run's own merged PR closes (`closes: true` at the merge),
when the read above still says `open` 10 s after the merge reported `merged: true`. The
back-reference comment goes first, then the close:

```bash
gh api -X POST repos/{owner}/{repo}/issues/<n>/comments \
  -f body='Closed by #<pr> (merged). Auto-close did not fire, so closing explicitly.' --jq .html_url
gh api -X PATCH repos/{owner}/{repo}/issues/<n> -f state=closed -f state_reason=completed \
  --jq '"issue: \(.state) \(.state_reason // "")"'
```

([create an issue comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment),
[update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue),
both checked 2026-10-07). `issue: closed completed` goes in the report as closed by
hand; anything else is a stop, with the issue named as left open behind a merged PR.

## Issues the merge unblocked

After the merge, list the backlog again ([above](#the-backlog-and-the-pick)). An issue
is unblocked by this merge when its `deps:` or `blocked-by=` names `#<n>`, it still
carries `blocked: dependency`, and none of its other dependencies is in the list. For
each:

```bash
gh api -X DELETE "repos/{owner}/{repo}/issues/<m>/labels/blocked%3A%20dependency" --jq '[.[].name] | join(", ")'
```

([remove a label from an issue](https://docs.github.com/en/rest/issues/labels#remove-a-label-from-an-issue),
checked 2026-10-07). A stale label on an issue that does not depend on `#<n>` is not
this merge's to clear: list it in the report.

## A follow-up issue

Every label the issue needs is checked first; a missing one stops the filing, since
creating a label definition (`just labels`) is not in this skill's sign-off:

```bash
gh api "repos/{owner}/{repo}/labels/priority%3A%20P2" --jq .name   # one call per label
```

The body file holds what `triaging-issues` asks of a body, then a `## Dependencies`
section with one `Depends on #N` line per blocker (only when there is one), the line
`*Found while shipping #<n>.*` after a `---` rule, and the ship contract as the last
line: `<!-- ship: tier=P2 area=<area> blocked-by=none touches=<paths or *> design=settled -->`.
Then:

```bash
gh api -X POST repos/{owner}/{repo}/issues -f title='<title>' -F body=@<file> \
  -f 'labels[]=<type label>' -f 'labels[]=priority: P2' \
  --jq '"filed: \(.html_url)\nlabels: \([.labels[].name] | join(", "))"'
```

Add `-f 'labels[]=blocked: dependency'` with a `Depends on` line, and
`-f 'labels[]=blocked: design'` with `design=open`. GitHub drops labels without an
error when the caller lacks push access
([create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue),
checked 2026-10-07), so compare the reply's `labels:` with what was sent; a difference
is a report line, never a second write.
