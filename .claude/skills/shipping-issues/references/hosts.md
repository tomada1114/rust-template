# The two hosts

The workflow is one on both hosts: the same REST calls, the same `just` recipes, the same
review and merge gate. This file holds the only differences between a local Claude Code
session and a Claude Code cloud session, and what a cloud session refuses. Read it once
per run, and again when a GitHub call, a push, or a network request fails in a way the
workflow does not name. Each item says what to expect and what to do instead of working
around it.

## Table of Contents

- [Telling the host apart](#telling-the-host-apart)
- [Branches and worktrees](#branches-and-worktrees)
- [After the merge](#after-the-merge)
- [The tools](#the-tools)
- [Waits and time limits](#waits-and-time-limits)
- [How GitHub is reached](#how-github-is-reached)
- [A 403 from the proxy](#a-403-from-the-proxy)
- [A push or every GitHub call fails](#a-push-or-every-github-call-fails)
- [Auto-fix stays off](#auto-fix-stays-off)
- [Hosts the network level blocks](#hosts-the-network-level-blocks)
- [A reclaimed VM](#a-reclaimed-vm)

## Telling the host apart

```bash
test "$CLAUDE_CODE_REMOTE" = true && echo "host: cloud" || echo "host: local"
```

A cloud session's environment carries `CLAUDE_CODE_REMOTE=true`, and it is never `true`
on a local machine
([cloud environments, SessionStart hook](https://code.claude.com/docs/en/cloud-environments#install-dependencies-with-a-sessionstart-hook),
checked 2026-10-07). Sub-agents work in a cloud session as they do locally
([manage context](https://code.claude.com/docs/en/claude-code-on-the-web#manage-context),
checked 2026-10-07).

## Branches and worktrees

| | Local session | Cloud session |
| --- | --- | --- |
| Starting point | The default branch, clean and fast-forwarded (`git switch <default>`, `git pull --ff-only`). | The branch the session's instructions name (`git branch --show-current`), never the default branch, with `git merge --no-edit origin/<default>` applied. |
| The issue's branch | Cut one per issue: `git switch -c <type>/<n>-<slug>`, the type from the issue's Conventional Commits title. | The session's one branch carries one issue at a time; no other branch is created or pushed. |
| Parallel work | Only when the user asks: one `git worktree add <dir> -b <type>/<n>-<slug> origin/<default>` per issue, outside the checkout, each with its own cold `target/`; review, PR, CI, and merge still go one PR at a time. | Never: serial, on the one branch. |

On either host a dirty tree at the start holds work this run did not make: stop and
ask. In a cloud session, a non-empty `git diff --stat origin/<default>` after the merge
is the same stop, unless an open PR from this branch explains it: a run resumed after a
reclaimed VM, which continues that PR ([below](#a-reclaimed-vm)).

## After the merge

No remote branch is deleted on either host: the repository's `delete_branch_on_merge`
setting removes a merged head branch (`starting-an-app`' `references/github-settings.md`),
and a cloud session's proxy refuses a branch deletion and a push of
anything other than a branch, such as a tag
([GitHub proxy](https://code.claude.com/docs/en/cloud-environments#github-proxy),
checked 2026-10-07).

**Locally**, return to the default branch and remove what the run created, by name:

```bash
git switch <default>
git pull --ff-only
git worktree remove <dir>
git branch -d <type>/<n>-<slug>
```

`git worktree remove` only for a worktree this run added. A squash merge puts the
branch's change on the default branch as a new commit, so git may refuse `-d` for a
branch whose own commits it cannot find there; `git branch -D` is then right for a
branch this run created whose PR reads `merged: true`, and for no other branch.

**In a cloud session**, the session's branch carries the issue's own commits and the
default branch now carries their squash. Bring the branch up to date by merging, never
by a reset or a rebase followed by a force-push:

```bash
git fetch origin <default> --quiet
git merge --no-edit origin/<default>
git diff --stat origin/<default>
```

The last command must print nothing. A conflict means the default branch changed those
lines again since the squash; the branch's side is already merged, so resolve each
conflicted path to the default branch's version (`git checkout --theirs -- <path>`,
then `git add` and `git commit --no-edit`). Anything left in the diff is work that is
not on the default branch: stop and ask. The next `git push -u origin <branch>` creates
the remote branch afresh when GitHub deleted it, and is a fast-forward when it did not.
Git counts the pre-squash commits as not on the default branch, so they may be listed
among the next PR's commits; its diff, which the review reads and the squash takes, is
the new work alone.

## The tools

The checks are the same `just` recipes on both hosts (`AGENTS.md` › "Validating a
change"). Locally `just install` provides them. A cloud session is provisioned by the
committed `SessionStart` hook, which runs `.claude/cloud/provision.sh session`
(`docs/getting-started.md` › "Cloud sessions"): `just`, the mise-pinned tools, and
lefthook's pre-commit hook are there once it has run. If `just` is missing, run
`bash .claude/cloud/provision.sh session` once and read its `WARN(provision)` lines; a
tool it could not install is named in the report with the check that was not run, and
is never replaced with a downloaded installer.

`just labels` and `just ruleset` do not work in a cloud session: both are a human's
step on either host (`AGENTS.md` › "Security and human approval"). A missing label is a
report line for the owner.

## Waits and time limits

A foreground command in a cloud session gets 2 minutes by default and up to 10 minutes
on request; one that reaches its timeout moves to the background
([time limits](https://code.claude.com/docs/en/cloud-environments#time-limits),
checked 2026-10-07), where a reclaimed VM loses it. So in a cloud session every wait is
a foreground slice under 10 minutes, with the call's own timeout raised to cover it,
repeated until a verdict or the step's cap; `ci_verdict.py`'s default of 480 s is one
such slice. A cold workspace build can outlast a slice, so there the gates run recipe
by recipe (`just lint`, `just test-core`, `just test-xtask`, `just test-platform`, `just
check-harness`), never as one `just check`. A local session may use the same slices or
run a long command in the background and wait for its completion notice.

## How GitHub is reached

Locally `gh` uses the developer's own login. In a cloud session all GitHub traffic goes
through Anthropic's GitHub proxy, which swaps in the owner's credentials on the server
side; `gh` is pre-installed and reads the proxy's placeholder token on its own, and
`gh api` calls on REST paths work
([GitHub proxy](https://code.claude.com/docs/en/cloud-environments#github-proxy),
[work with GitHub issues and pull requests](https://code.claude.com/docs/en/cloud-environments#work-with-github-issues-and-pull-requests),
both checked 2026-10-07).

`gh api` fills `{owner}` and `{repo}` from the current directory's repository or from
`GH_REPO` (`gh api --help`, gh 2.92.0, observed 2026-10-07). Run every call from the
checkout's root; if `gh` cannot tell the repository from the remote, export
`GH_REPO=<owner>/<repo>` for the rest of the run, so `ci_verdict.py`'s own `gh` calls
see it too.

## A 403 from the proxy

A cloud session's proxy answers three kinds of request with a 403
([GitHub proxy](https://code.claude.com/docs/en/cloud-environments#github-proxy),
checked 2026-10-07):

- **GraphQL**, whatever the token: the message starts with
  `GitHub GraphQL is not available from Claude Code sessions` and names
  `gh api repos/{owner}/{repo}/...`. Every `gh` subcommand built on GraphQL gets it
  (the pull-request, issue, repository-view, and label-listing subcommands among them),
  and so does a request with a `GH_TOKEN` you set.
- **A repository not attached to the session**: the message starts with
  `GitHub access to` and contains `is not enabled for this session`.
- **The issue-search endpoint**, refused as out of scope for the session (observed in
  the uv-template repository, 2026-10-07).

Each one is a stop: report the call and the message, and stop the run. Never retry the
same operation through another route: a different `gh` subcommand, a hand-built query,
another token, or a browser. The workflow never needs one of these calls; reaching one
means a step was spelled wrong, and the fix is in this skill.

## A push or every GitHub call fails

A `git push` answered `remote: Internal Server Error` on every retry was cured by the
owner reconnecting GitHub at <https://claude.ai/connect-github>, after which the same
push went through (observed 2026-10-07). So when a push, or every `gh api` call, fails
the same way after one retry: stop, report which operation failed, and in a cloud
session ask the owner to reconnect there. Never route around it: no commit through the
REST Git Data API, no `--no-verify` probe commit. Both are the denied action re-spelled
(`AGENTS.md` › "Security and human approval").

## Auto-fix stays off

Auto-fix is a per-pull-request toggle of a cloud session. While it is on, Claude reacts
to PR comments and CI failures on the PR and may reply to review threads, under the
owner's GitHub account
([Auto-fix pull requests](https://code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests),
checked 2026-10-07). This skill never replies to or resolves a review thread, so it
never turns Auto-fix on for a PR it opens. If the session shows Auto-fix on for one of
the run's PRs, stop and ask the owner to clear the toggle.

## Hosts the network level blocks

Under a cloud session's default Trusted level, `api.osv.dev` answered 403 (observed
2026-10-07), so a local vulnerability lookup for a new dependency cannot run there. Say
so in the report and let CI's OSV-Scanner and Dependency Review judge the pull request.
**BACKGROUND:** `managing-dependencies`. A red check caused by a refused host is the
environment's, not the issue's: name the host and the failing check in the report.

## A reclaimed VM

After a few minutes idle a cloud VM pauses with its files saved, and a paused VM can be
reclaimed
([time limits](https://code.claude.com/docs/en/cloud-environments#time-limits),
checked 2026-10-07). Reopening a reclaimed session restores the conversation, not the
background work that was running
([environment expired](https://code.claude.com/docs/en/claude-code-on-the-web#environment-expired),
checked 2026-10-07). The run keeps no state of its own for that reason: on a fresh VM,
or after a context compaction on either host, rebuild what the run knows from GitHub
and git (the open PR from the run's branch, its head and checks, the issue's state, and
`git log --oneline origin/<default>..HEAD`) before writing anything.
