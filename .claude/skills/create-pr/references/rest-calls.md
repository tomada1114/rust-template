# The pull-request REST calls

How a pull request is found, opened, read, and updated here, each spelled as a `gh api`
call on a REST path. This is the one home of these spellings: `create-pr` runs them, and
`shipping-issues` points here for its own PR instead of repeating them. A Claude Code
cloud session's GitHub proxy refuses GraphQL, and with it every `gh` subcommand that
opens, lists, shows, or edits a pull request (`shipping-issues`'
`references/hosts.md` › "A 403 from the proxy"), so the same REST call serves a
developer's machine and a cloud session.

How each call is run:

- From the checkout's root, where `gh api` fills `{owner}` and `{repo}` itself, in a
  path and in a query string alike.
- One `gh api … --jq …` per command: no pipe, no `$(...)`, no redirect, no chain. A
  local permission or sandbox rule that admits `gh api` matches the command's text, so
  only the bare call matches it.
- A body is a file: write it with the file tool under the scratchpad directory (or
  `$TMPDIR`), never inside the checkout, and send it with `-F body=@<file>`, which keeps
  its Markdown and backticks away from the shell. To edit a body GitHub already holds,
  print it with `--jq '.body // ""'`, write the edited text to a file, and send that.

## The open PR for a branch

```bash
git branch --show-current
gh api "repos/{owner}/{repo}/pulls?head={owner}:<branch>&state=open" \
  --jq '.[] | "pr: \(.number)\ntitle: \(.title)\nurl: \(.html_url)"'
```

No output means the branch has no open pull request. `head` takes `<owner>:<branch>`
([list pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests),
checked 2026-11-19). A `head` without the owner and colon is ignored, and every open
pull request comes back (observed on this Mac with that call against this repository,
as was `{owner}` being filled inside the query string, 2026-11-19), so a reply naming
another branch's PR means the filter was misspelled, never that the PR is this
branch's. A branch pushed from a fork has the fork's owner in place of `{owner}`.

## Opening the PR

```bash
gh api -X POST repos/{owner}/{repo}/pulls -f title='<conventional-commit title>' \
  -f head=<branch> -f base=<default> -F body=@<file> \
  --jq '"pr: \(.number)\nurl: \(.html_url)\nhead_sha: \(.head.sha)\nbase: \(.base.ref)\ndraft: \(.draft)"'
```

`<default>` is the default branch (`main` here; `shipping-issues` reads it from the
repository). Leaving out `draft` creates the PR ready
([create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request),
checked 2026-10-07), and a draft could not be merged. Check the reply: `base:` is the
default branch and `draft: false`. A 422 that says a pull request already exists for
the branch: find it with [the open PR for the branch](#the-open-pr-for-a-branch) and
update that one; never open a second.

## Reading the PR

```bash
gh api repos/{owner}/{repo}/pulls/<pr> \
  --jq '"state: \(.state)\nmerged: \(.merged)\ndraft: \(.draft)\nhead_sha: \(.head.sha)\nbase: \(.base.ref)\nmergeable: \(.mergeable)\nmergeable_state: \(.mergeable_state)\ncloses: \((.body // "") | test("(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#<n>\\b"))"'
```

`<n>` is the issue the PR closes; with no issue, `closes:` says nothing. `mergeable` is
`true` or `false` once GitHub has computed it and `null` while it is still computing;
read again after a few seconds
([get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request),
checked 2026-10-07). GitHub reads a closing keyword only in a pull request that targets
the default branch
([linking a pull request to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue),
checked 2026-11-19), so `closes: false` or a `base:` other than the default branch
means the merge would leave the issue open: [update the PR](#updating-the-pr).

## Updating the PR

`title`, `body`, and `base` are fields of the update call
([update a pull request](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request),
checked 2026-10-07); a field left out keeps its value. A new title and body:

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/<pr> -f title='<conventional-commit title>' \
  -F body=@<file> --jq '"pr: \(.number)\nurl: \(.html_url)\ntitle: \(.title)"'
```

**A missing closing keyword** (`closes: false`): append one, never a second. Print the
body, write it to a file with a blank line and `Closes #<n>` added at the end, and send
it:

```bash
gh api repos/{owner}/{repo}/pulls/<pr> --jq '.body // ""'
gh api -X PATCH repos/{owner}/{repo}/pulls/<pr> -F body=@<file> \
  --jq '"closes: \((.body // "") | test("(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#<n>\\b"))"'
```

**A `base:` other than the default branch** is retargeted:

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/<pr> -f base=<default> --jq '"base: \(.base.ref)"'
```

Each edit fires the PR's `edited` workflows (the title check and the type label among
them) and a retarget re-runs its checks, so make the edits before CI is read, and read
CI again after one. Whether GitHub has linked a closing keyword is not a REST fact: the
issue's state after the merge is what shows it.
