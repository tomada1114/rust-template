# The cloud host

What a Claude Code cloud session gives this workflow and what it refuses. Read it once
before the first run in a cloud session, and again when a GitHub call, a push, or a
network request fails in a way the workflow does not name. Each item says what to
expect and what to do instead of working around it.

## Table of Contents

- [Telling the host apart](#telling-the-host-apart)
- [What the session starts with](#what-the-session-starts-with)
- [How GitHub is reached](#how-github-is-reached)
- [A 403 from the proxy](#a-403-from-the-proxy)
- [A push or every GitHub call fails](#a-push-or-every-github-call-fails)
- [Branch deletion and tags are refused](#branch-deletion-and-tags-are-refused)
- [Auto-fix stays off](#auto-fix-stays-off)
- [Hosts the network level blocks](#hosts-the-network-level-blocks)
- [Command time limits](#command-time-limits)
- [Run state lives on the VM](#run-state-lives-on-the-vm)

## Telling the host apart

The session VM's environment carries `CLAUDE_CODE_REMOTE=true`, and it is never `true`
on a local machine
([cloud environments, SessionStart hook](https://code.claude.com/docs/en/cloud-environments#install-dependencies-with-a-sessionstart-hook),
checked 2026-10-07). That one variable is the host test of step 1. Sub-agents work in a
cloud session as they do locally
([manage context](https://code.claude.com/docs/en/claude-code-on-the-web#manage-context),
checked 2026-10-07), so running serially and inline is this skill's choice, not a
limit of the host.

## What the session starts with

A single-repository cloud session reads the repository's committed
`.claude/settings.json`, and reads neither `~/.claude/settings.json` nor
`.claude/settings.local.json`
([settings in cloud sessions](https://code.claude.com/docs/en/settings#settings-in-cloud-sessions),
checked 2026-10-07). This repository commits no `.claude/settings.json` (`CLAUDE.md`),
so no SessionStart hook prepares the VM, and `just install` never runs there.

The default image pre-installs rustc and cargo, Python 3 with uv, git, gh, and jq, but
not `just`, `mise`, `lefthook`, `cargo-nextest`, `cargo-llvm-cov`, `typos`,
`actionlint`, or `shellcheck`
([installed tools](https://code.claude.com/docs/en/cloud-environments#installed-tools),
checked 2026-10-11); an environment's own setup script may add more. So, at step 1:

- `cargo --version` against `rust-toolchain.toml`'s `channel`. A different version is
  named in the report: clippy's lints change between releases, so a local clippy run
  then proves less than CI's.
- Run the `cargo` command under each recipe the change needs (`AGENTS.md` › "Validating
  a change"; the `justfile` spells them): `cargo fmt --all --check`, `cargo clippy
  --workspace --all-targets --all-features --locked -- -D warnings`, and
  `cargo test --locked -p <crate>` where a recipe uses `cargo nextest run`. A recipe
  whose tool is missing (`just test-core`'s coverage floors, `typos`, `actionlint`,
  `shellcheck`) is left to CI and named in the report as not run here. A cold workspace
  build can outlast one 10-minute slice: build one crate at a time
  (`cargo build --locked -p <crate>`), each in its own slice.
- No git hook is installed, so before every commit run what lefthook's pre-commit hook
  would (`lefthook.yml`): `CARGO_TARGET_DIR=target/xtask cargo xtask check-staged`, and
  `CARGO_TARGET_DIR=target/xtask cargo xtask sync-agents --check --staged` when a skill
  path is staged. A refusal is fixed, never committed past.

Never install a tool with a downloaded installer to fill the gap; the environment's
setup script is the owner's to change.

## How GitHub is reached

All GitHub traffic goes through Anthropic's GitHub proxy, which swaps in the owner's
real credentials on the server side
([GitHub proxy](https://code.claude.com/docs/en/cloud-environments#github-proxy),
checked 2026-10-07). `gh` is pre-installed and reads the proxy's placeholder token on
its own; `gh api` calls and `gh` subcommands that use REST work, and the session's
built-in GitHub tools reach the same REST operations
([work with GitHub issues and pull requests](https://code.claude.com/docs/en/cloud-environments#work-with-github-issues-and-pull-requests),
checked 2026-10-07). This skill spells every operation as a `gh api` call
(`rest-calls.md`); a built-in tool doing the same REST operation is an
equal substitute, never a different operation.

`gh api` fills `{owner}` and `{repo}` from the current directory's repository or from
`GH_REPO` (`gh api --help`, gh 2.92.0, observed 2026-10-07). Run every call from the
checkout's root; if `gh` cannot tell the repository from the remote, export
`GH_REPO=<owner>/<repo>` (the owner and name the session was started on) for the rest
of the run, so the `gh` calls the skill's own scripts make see it too.

## A 403 from the proxy

The proxy answers three kinds of request with a 403
([GitHub proxy](https://code.claude.com/docs/en/cloud-environments#github-proxy),
checked 2026-10-07):

- **GraphQL**, whatever the token: the message starts with
  `GitHub GraphQL is not available from Claude Code sessions` and names
  `gh api repos/{owner}/{repo}/...`. `gh pr`, `gh issue`, and every other subcommand
  built on GraphQL get the same 403, and so does a request with a `GH_TOKEN` you set.
- **A repository not attached to the session**: the message starts with
  `GitHub access to` and contains `is not enabled for this session`.
- **`search/issues`**, refused as out of scope for the session (observed in the
  uv-template repository, 2026-10-07).

Each one is a stop: report the call and the message, and stop the run. Never retry the
same operation through another route — a different `gh` subcommand, a hand-built
GraphQL query, another token, or a browser. The workflow never needs one of these
calls; reaching one means a step was spelled wrong, and the fix is in this skill.

## A push or every GitHub call fails

A `git push` answered `remote: Internal Server Error` on every retry was cured by the
owner reconnecting GitHub at <https://claude.ai/connect-github>, after which the same
push went through (observed 2026-10-07). So when a push, or every `gh api` call, fails
the same way after a retry: stop, report which operation failed, and ask the owner to
reconnect there. Never route around it — no REST Git Data API commit, no `--no-verify`
probe commit. Both are the denied action re-spelled (AGENTS.md "Security and human
approval"), and the host's permission check refused them anyway (observed 2026-10-07).

## Branch deletion and tags are refused

The proxy rejects branch deletions and pushes of anything other than a branch, such as
a tag; it does not limit which branch a push updates
([GitHub proxy](https://code.claude.com/docs/en/cloud-environments#github-proxy),
checked 2026-10-07). The one-branch rule therefore comes from the session's own
instructions, and this skill keeps it without a force-push
(branch upkeep: `review-ci-merge.md` › "Branch upkeep after the merge"). This skill
deletes no branch. With the repository's `delete_branch_on_merge` on, GitHub removes
the merged head branch itself; otherwise the branch stays and the next push to it is a
fast-forward.

## Auto-fix stays off

Auto-fix is a per-pull-request toggle. While it is on, Claude reacts to PR comments
and CI failures on the PR and may reply to review threads, under the owner's GitHub
account
([Auto-fix pull requests](https://code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests),
checked 2026-10-07). This skill never replies to or resolves a review thread, so it
never turns Auto-fix on for a PR it opens. If the session shows Auto-fix on for one of
the run's PRs, stop and ask the owner to clear the toggle.

## Hosts the network level blocks

Under the default Trusted level, `api.osv.dev` answered 403 (observed 2026-10-07), so a
local vulnerability lookup for a new dependency cannot run. Say so in the report
and let CI's OSV-Scanner and Dependency Review judge the pull request.
**BACKGROUND:** `managing-dependencies`. A red check caused by a refused host is the
environment's, not the issue's: name the host and the failing check in the report.

## Command time limits

A foreground command gets 2 minutes by default and up to 10 minutes on request; one that
reaches its timeout moves to the background, where it can run up to 30 more minutes
([time limits](https://code.claude.com/docs/en/cloud-environments#time-limits),
checked 2026-10-07). Every wait in this skill is a foreground slice under 10 minutes,
with the call's own timeout raised to cover it, repeated until a verdict or the step's
total cap — never a background command, which the next item can lose.

## Run state lives on the VM

After a few minutes idle the VM pauses with its files saved, and a paused VM can be
reclaimed
([time limits](https://code.claude.com/docs/en/cloud-environments#time-limits),
checked 2026-10-07). Reopening a reclaimed session restores the conversation, not the
background work that was running — sub-agents and shell commands
([environment expired](https://code.claude.com/docs/en/claude-code-on-the-web#environment-expired),
checked 2026-10-07). `<runstate>` is on that VM: a run that resumes on a fresh one
starts with no `run.md` and no CI logs. Rebuild what it knows from GitHub — the open PR
from the session's branch, its check runs, and the issue's state — before writing anything.
