# The REST calls

Every GitHub read and write this skill makes, spelled as a `gh api` call. Run them from
the checkout's root (how `{owner}/{repo}` resolves (`cloud-host.md` › "How GitHub is reached")).
A built-in GitHub tool that performs the same REST operation may stand in for a call;
nothing else may. Never `gh pr`, `gh issue`, `gh repo view`, `gh label list`,
`gh api graphql`, or `search/issues`: the proxy refuses each
(a 403 from the proxy: `cloud-host.md` › "A 403 from the proxy").

`<runstate>` is `${AGENT_SKILL_STATE_DIR:-$HOME/.local/state/agent-skills}/shipping-issues/<owner>__<repo>`,
the directory `review_watch.py` keeps its memory in. Request and response files go there,
never inside the checkout.

## Table of Contents

- [The repository](#the-repository)
- [The backlog and the pick](#the-backlog-and-the-pick)
- [One issue](#one-issue)
- [Opening the PR](#opening-the-pr)
- [Reading the PR](#reading-the-pr)
- [Repairing the PR's closing link](#repairing-the-prs-closing-link)
- [The CI verdict](#the-ci-verdict)
- [A failing check](#a-failing-check)
- [The merge](#the-merge)
- [Closing an issue GitHub left open](#closing-an-issue-github-left-open)
- [Issues the merge unblocked](#issues-the-merge-unblocked)
- [Settling a held design](#settling-a-held-design)
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
only.

## The backlog and the pick

```bash
mkdir -p <runstate>/rest
gh api --paginate --slurp "repos/{owner}/{repo}/issues?state=open&per_page=100" > <runstate>/rest/issues.json
gh api --paginate --slurp "repos/{owner}/{repo}/pulls?state=open&per_page=100" > <runstate>/rest/pulls.json
python3 .agents/skills/shipping-issues/scripts/issue_digest.py --issues-file <runstate>/rest/issues.json \
    --prs-file <runstate>/rest/pulls.json --limit 100000 --select 3 --with-rank --detail-top 1 --body-chars 700
```

The issues endpoint lists pull requests too, each marked by a `pull_request` key
([list repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues),
checked 2026-10-07); the digest drops them. Both files are required together, and file
mode takes no `--label`, `--assignee`, or `--milestone` (exit 2). It keeps only the
first `--limit` issues in file order (default 200) and the REST list is newest first,
so the limit is always passed above any backlog's size: a default would silently drop
the oldest issues, a named one included. A named
issue: add `--issue <n> --detail <n>` — naming it lifts only the design hold. Read
`select:`, `next:`, `held:`, `needs-design:`, `tracking:` and the `labels:` line as the
digest's own docstring describes them; `~P<n>` is a suggested tier.

Fetch both files again, never reuse them, after any merge or filing: the digest's
picture is only as fresh as the files.

## One issue

```bash
gh api repos/{owner}/{repo}/issues/<n> --jq '"#\(.number) \(.state) \(.title)\nlabels: \([.labels[].name] | join(", "))\n\n\(.body)"'
gh api --paginate repos/{owner}/{repo}/issues/<n>/comments --jq '.[] | "--- \(.user.login) \(.created_at)\n\(.body)"'
```

Read the body and every comment before the acceptance map. A dependency named in the
body is read the same way, for its `state`.

## Opening the PR

Write the body to `<runstate>/pr/<n>-body.md` from `.github/PULL_REQUEST_TEMPLATE.md`:
the summary, then **`Closes #<n>`** on its own line, then the test plan and the
checklist, each ticked only when true. Then:

```bash
gh api -X POST repos/{owner}/{repo}/pulls -f title='<conventional-commit title>' \
  -f head=<branch> -f base=<default> -F body=@<runstate>/pr/<n>-body.md \
  --jq '"pr: \(.number)\nurl: \(.html_url)\nhead_sha: \(.head.sha)\nbase: \(.base.ref)\ndraft: \(.draft)"'
```

Leaving out `draft` creates the PR ready
([create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request),
checked 2026-10-07), and only a ready PR gets the opening Codex review
(`review_watch.py`'s docstring). Check the reply: `base:` is the default branch and `draft: false`.
A 422 that says a pull request already exists for the branch: list it with
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
checked 2026-10-07). `closes: false` or a `base:` other than the default branch means
the merge would leave the issue open: [repair it](#repairing-the-prs-closing-link).

## Repairing the PR's closing link

The only edits this skill makes to a PR, and only to the open PR it created for `#<n>`,
mirroring `link_check.sh --fix`. **`closes: false`** — the body has no closing keyword
for `#<n>`: append one, never a second.

```bash
mkdir -p <runstate>/pr
gh api repos/{owner}/{repo}/pulls/<pr> --jq '.body // ""' > <runstate>/pr/<pr>-body-now.md
printf '\n\nCloses #%s\n' <n> >> <runstate>/pr/<pr>-body-now.md
gh api -X PATCH repos/{owner}/{repo}/pulls/<pr> -F body=@<runstate>/pr/<pr>-body-now.md \
  --jq '"closes: \((.body // "") | test("(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#<n>\\b"))"'
```

**A `base:` other than the default branch** — retarget it:

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/<pr> -f base=<default> --jq '"base: \(.base.ref)"'
```

`body` and `base` are fields of the update call
([update a pull request](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request),
checked 2026-10-07). Each edit fires the PR's `edited` workflows and a retarget re-runs
its checks, so make them before the CI read, and read CI again after one. One attempt
each: a reply that still reads `closes: false` or the wrong `base:` is a stop. Whether
GitHub has *linked* the keyword is a GraphQL-only fact (`closingIssuesReferences`), so
`link_check.sh`'s re-save of an unlinked keyword has no REST counterpart here; the issue
state is checked after the merge instead
([closing an issue GitHub left open](#closing-an-issue-github-left-open)).

## The CI verdict

One foreground call reads the head commit's check runs and its combined status every 30
s, for at most 16 reads (about 8 minutes), and stops at the first `PASS`, `FAIL`, or
`ERROR`. Raise the call's own timeout to 600000 ms. Repeat the call on `PENDING` or
`EMPTY`; the step's caps are in `review-ci-merge.md` › "CI".

```bash
sha=<head_sha>; log=<runstate>/ci/<pr>.log; mkdir -p "${log%/*}"
for read in $(seq 1 16); do
  runs=$(gh api --paginate "repos/{owner}/{repo}/commits/$sha/check-runs?per_page=100" \
    --jq '.check_runs[] | [.status, (.conclusion // "none"), .name] | @tsv') \
    || { echo "verdict: ERROR check runs unreadable"; break; }
  combined=$(gh api "repos/{owner}/{repo}/commits/$sha/status" \
    --jq '[.state, .total_count] | @tsv') \
    || { echo "verdict: ERROR combined status unreadable"; break; }
  verdict=$(printf '%s\n%s\n' "$combined" "$runs" | awk -F'\t' '
    NR == 1 { state = $1; statuses = $2 + 0; next }
    NF < 3 { next }
    { runs++ }
    $1 != "completed" { pending++; next }
    $2 ~ /^(success|neutral|skipped)$/ { next }
    { failed++; print "failed_check: " $3 " (" $2 ")" > "/dev/stderr" }
    END {
      if (failed || state == "failure") print "FAIL"
      else if (runs + statuses == 0) print "EMPTY"
      else if (pending || (statuses > 0 && state != "success")) print "PENDING"
      else print "PASS"
    }')
  echo "verdict: $verdict head_sha: $sha read: $read at: $(date -u +%FT%TZ)"
  case $verdict in PASS|FAIL) break ;; esac
  [ "$read" -lt 16 ] && sleep 30
done >> "$log" 2>&1; tail -n 3 "$log"
```

The rule it applies: **PASS** when every check run is `completed` with `success`,
`neutral`, or `skipped`, and the combined status is `success` or counts no status at
all; **FAIL** on a completed check run concluding anything else — `failure`,
`cancelled`, `timed_out`, `action_required`, `startup_failure`, `stale`, or a value
added later, so an unknown conclusion surfaces instead of waiting out the cap — or a
combined status of `failure`; **EMPTY**
when there is neither a check run nor a status; anything else is **PENDING**. Check-run
statuses and conclusions are the enums of
[list check runs for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference),
and the combined state is `pending` when there are no statuses at all, which is why a
zero count is not a failure
([combined status](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference),
both checked 2026-10-07). Reading by the head SHA, never by branch, keeps a previous
commit's results out of the verdict.

## A failing check

```bash
gh api "repos/{owner}/{repo}/commits/<sha>/check-runs?per_page=100" \
  --jq '.check_runs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | "\(.name)\t\(.html_url)"'
```

Reproduce the failure with the matching local command first — CI runs the recipes of
`just check` (AGENTS.md "Enforcement layers"), and `cloud-host.md` › "What the session
starts with" says which of their `cargo` commands run on the VM. A job's log is
`GET repos/{owner}/{repo}/actions/jobs/<job_id>/logs`, a redirect to a short-lived
download URL ([download job logs](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run),
checked 2026-10-07); the job ids come from
`gh api "repos/{owner}/{repo}/actions/runs?head_sha=<sha>" --jq '.workflow_runs[] | "\(.id) \(.name) \(.conclusion)"'`
and `gh api repos/{owner}/{repo}/actions/runs/<run_id>/jobs --jq '.jobs[] | "\(.id) \(.name) \(.conclusion)"'`.
Redirect a log to `<runstate>/ci/` and read its tail, never the whole log.

## The merge

```bash
gh api -X PUT repos/{owner}/{repo}/pulls/<pr>/merge -f merge_method=squash -f sha=<head_sha> \
  --jq '"merged: \(.merged)\nsha: \(.sha)"'
```

`<head_sha>` is the SHA the `PASS` was read for. GitHub merges only when the PR's head
still matches it; the replies that matter are 200 merged, 405 the merge cannot be
performed, and 409 the head no longer matches the `sha`
([merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request),
checked 2026-10-07). `gh` exits non-zero and prints `HTTP 405` or `HTTP 409` on the
latter two. What each one means for the run:
`review-ci-merge.md` › "The merge".

Then the issue:

```bash
gh api repos/{owner}/{repo}/issues/<n> --jq '"issue: \(.state) \(.state_reason // "")"'
```

## Closing an issue GitHub left open

Only for `#<n>`, the issue the run's own merged PR closes (`closes: true` at the merge),
when the read above still says `open` 10 s after the merge reported `merged: true`.
Mirroring `land_pr.sh`, the back-reference comment goes first, then the close:

```bash
gh api -X POST repos/{owner}/{repo}/issues/<n>/comments \
  -f body='Closed by #<pr> (merged). Auto-close did not fire, so closing explicitly.' --jq .html_url
gh api -X PATCH repos/{owner}/{repo}/issues/<n> -f state=closed -f state_reason=completed \
  --jq '"issue: \(.state) \(.state_reason // "")"'
```

([create an issue comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment),
[update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue),
both checked 2026-10-07). `issue: closed completed` is `CLOSED_MANUALLY` for the
report; anything else is a stop, with the issue named as left open behind a merged PR.

## Issues the merge unblocked

After the merge, fetch the backlog again ([above](#the-backlog-and-the-pick)), then:

```bash
python3 .agents/skills/shipping-issues/scripts/issue_digest.py --issues-file <runstate>/rest/issues.json \
    --prs-file <runstate>/rest/pulls.json --limit 100000 --json --body-chars 0 \
  | python3 -c 'import json, sys; n = int(sys.argv[1]); print(" ".join(str(i["number"]) for i in json.load(sys.stdin)["issues"] if n in i["depends_on"] and "blocked: dependency" in i["stale_dependency_labels"]))' <n>
```

It prints the open issues that record a dependency on `#<n>`, still carry
`blocked: dependency`, and have no open dependency left. For each:

```bash
gh api -X DELETE "repos/{owner}/{repo}/issues/<m>/labels/blocked%3A%20dependency" --jq '[.[].name] | join(", ")'
```

([remove a label from an issue](https://docs.github.com/en/rest/issues/labels#remove-a-label-from-an-issue),
checked 2026-10-07). A stale label on an issue that does not depend on `#<n>`, or a
recognized equivalent spelled differently, is not this merge's to clear: list it in the
report.

## Settling a held design

Only for the design-held issue the run takes on (`blocked: design` or a recognized
equivalent, or `design=open` in its ship contract), once the approach is decided
(`review-ci-merge.md` › "A held design"). The writes mirror
`shipping-issues`' design decision: one comment, then the block cleared, never in the
other order. The comment, written to `<runstate>/design/<n>-decision.md`, starts with
`## Design decision` and stands alone:

```bash
gh api -X POST repos/{owner}/{repo}/issues/<n>/comments \
  -F body=@<runstate>/design/<n>-decision.md --jq .html_url
```

Only once that comment posted, clear both forms of the block. Each design-block label
the issue carries (the `labels:` line of [one issue](#one-issue)) is removed, URL-encoded:

```bash
gh api -X DELETE "repos/{owner}/{repo}/issues/<n>/labels/blocked%3A%20design" --jq '[.[].name] | join(", ")'
```

A ship contract's `design=open` becomes `design=settled`, the rest of the body byte for
byte, with `apply_priority_labels.py`'s own rewrite (imported, so no `gh` runs):

```bash
gh api repos/{owner}/{repo}/issues/<n> > <runstate>/design/<n>-issue.json
python3 -B -c 'import json, sys; sys.path.insert(0, ".agents/skills/shipping-issues/scripts"); from apply_priority_labels import settle_contract_design; body = json.load(open(sys.argv[1], encoding="utf-8")).get("body") or ""; new = settle_contract_design(body); print("contract: nothing to settle" if new is None else "contract: settled"); new is None or open(sys.argv[2], "w", encoding="utf-8", newline="").write(new)' \
  <runstate>/design/<n>-issue.json <runstate>/design/<n>-body.md
gh api -X PATCH repos/{owner}/{repo}/issues/<n> -F body=@<runstate>/design/<n>-body.md --jq .number   # only after "contract: settled"
```

The tier label and the rest of the issue are left as they are. Record it with
`run_record.py --event design --field issue=<n> --field step=2b --field mode=inline --field verdict=DECIDED`.

## A follow-up issue

Every label the issue needs is checked first; a missing one stops the filing, since
creating a label definition (`just labels`) is not in this skill's sign-off:

```bash
gh api "repos/{owner}/{repo}/labels/priority%3A%20P2" --jq .name   # one call per label
```

The body file `<runstate>/followups/<slug>.md` holds what `triaging-issues` asks of a
body, then — exactly as `shipping-issues`' `file_followup.py` would have written them —
a `## Dependencies` section with one `Depends on: #N` line per blocker (only when there
is one), the line `*Found while shipping #<n>.*` after a `---` rule, and the ship
contract as the last line:
`<!-- ship: tier=P2 area=<area> blocked-by=none touches=<paths or *> design=settled -->`.
Then:

```bash
gh api -X POST repos/{owner}/{repo}/issues -f title='<title>' \
  -F body=@<runstate>/followups/<slug>.md \
  -f 'labels[]=<type label>' -f 'labels[]=priority: P2' \
  --jq '"filed: \(.html_url)\nlabels: \([.labels[].name] | join(", "))"'
```

Add `-f 'labels[]=blocked: dependency'` with a `Depends on:` line, and
`-f 'labels[]=blocked: design'` with `design=open`. GitHub drops labels without an
error when the caller lacks push access
([create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue),
checked 2026-10-07), so compare the reply's `labels:` with what was sent; a difference is
a report line, never a second write.
