# The GitHub calls

How this skill reads a pull request's diff, reads its checks, merges it, and closes it,
each a REST `gh api` call. A Claude Code cloud session's GitHub proxy refuses GraphQL,
and with it the `gh` subcommands that show, check, merge, and close a pull request
(`shipping-issues`' `references/hosts.md` › "A 403 from the proxy"), so none of these
steps uses one. Run each call from the checkout's root, where `gh api` fills `{owner}`
and `{repo}` itself, one call per command: no pipe, no `$(...)`, no redirect, no chain.

A call with another home is pointed to, never spelled again: the CI verdict and the
merge are `shipping-issues`', and opening the combined or migration PR is `create-pr`'s.
The writes below are in the batch only where "The approval gate" in `SKILL.md` says so.

## A PR's diff

```bash
gh api repos/{owner}/{repo}/pulls/<number> -H 'Accept: application/vnd.github.diff'
```

The `diff` media type of the call that reads a pull request
([get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request),
checked 2026-11-19; observed on this Mac against a merged pull request of this
repository, 2026-11-19). It prints the whole diff, and no pipe may trim it. The checks
behind a `HELD` line are the head's check runs: `shipping-issues`'
`references/rest-calls.md` › "A failing check".

## The verdict and the merge

```bash
python3 .claude/skills/shipping-issues/scripts/ci_verdict.py <number>
```

The script reads the PR's current head and that commit's checks, waits out a running
one (one foreground slice, 480 s by default, so raise the call's own timeout to
600000 ms), and prints `verdict:` and `head_sha:`; its
header states the rule, which holds a PR on any conclusion other than success, neutral,
or skipped, as the survey does. Only `verdict: PASS` is green. `PENDING` or `EMPTY`: run
it again; a check that never reports is F8 or F9 in `failure-modes.md`. `FAIL`: diagnose
it there before anything else.

On `PASS`, in the same turn, merge with the squash call in `shipping-issues`'
`references/rest-calls.md` › "The merge", its `sha` the printed `head_sha:`. Pinning the
merge to that head is what keeps a bot's later push from merging unchecked. That section
says what each reply means: a 409 is a head that moved (read the verdict again), and a
405 a PR GitHub will not merge (a conflict is F7; a required review or rule is a stop).
The repository's `delete_branch_on_merge` setting removes the merged branch
(`starting-an-app`' `references/github-settings.md`); no call here deletes one.

## Closing a superseded PR

Only after every replacement has merged, the pointer comment first, then the close:

```bash
gh api -X POST repos/{owner}/{repo}/issues/<number>/comments \
  -f body='Superseded by #<replacement-number>.' --jq .html_url
gh api -X PATCH repos/{owner}/{repo}/pulls/<number> -f state=closed --jq '"state: \(.state)"'
```

A pull request takes its comments through the issues endpoint
([create an issue comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment),
checked 2026-11-19), and `state` is a field of the update call
([update a pull request](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request),
checked 2026-11-19). `state: closed` is the close; anything else is a report line.

The closed PR's branch is left where it is. Deleting it is a write of its own
(`git push origin --delete <branch>`, run alone, which a cloud session's proxy
refuses), made only when the approved plan lists it.
