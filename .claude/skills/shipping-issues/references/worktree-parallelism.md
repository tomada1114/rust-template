# Worktree parallelism

**Not part of the hot path.** `plan.py` decides serial-vs-parallel and
`worktree_setup.sh` provisions and reports without this file being read. Come here when
a worktree's setup or baseline comes back red and you have to decide what that means, when a
worktree run fails in a way that looks like the issue's fault, or at step 9 before
cleanup. It covers what a worktree run needs that the main checkout already has, what it
costs, and the failure modes that look like something else.

Which _issues_ may run together is a dependency question and lives in
`dependency-triage.md` › "Parallel vs sequential (all mode)".
This file is about whether the _repository_ can support it at all, and how.

## Table of Contents

- [Why worktrees, and what they do not buy](#why-worktrees-and-what-they-do-not-buy)
- [Layout](#layout)
- [Viability gate](#viability-gate)
- [What a fresh worktree is missing](#what-a-fresh-worktree-is-missing)
- [Failure modes that look like the issue's fault](#failure-modes-that-look-like-the-issues-fault)
- [Teardown](#teardown)

## Why worktrees, and what they do not buy

The long pole in shipping an issue is the implementation run, and those runs are
independent when the issues are. Two of them in two worktrees finish in roughly the
time one takes, once each worktree's cold build is paid for. Everything after that — PR, CI, merge — is either serialized by GitHub
or serialized on purpose, and stays that way.

So the honest accounting is: parallel mode compresses the implementation wait and
nothing else. It buys that by paying, per issue, one cold cargo build into the
worktree's own `target/`, plus the risk that two issues collide in ways the grouping check missed. Under two
issues in a group, that trade is a loss — which is why single-issue mode never uses a
worktree.

A second thing it buys, and the reason not to dismiss it on a small batch: the main
checkout is never switched off the default branch, so the user can keep working in it
while a run is in flight.

## Layout

```
<runstate>/worktrees/<issue-number>/     <- one worktree, branch <type>/<n>-<slug>
<runstate>/verify/<n>-*.log              <- its setup log (and a baseline, if one was run)
<runstate>/ci/<pr>.log
```

`<runstate>` is
`${AGENT_SKILL_STATE_DIR:-$HOME/.local/state/agent-skills}/shipping-issues/<owner>__<repo>/`.

**Not** `<repo>/.claude/worktrees/`, which is where Claude Code's own `EnterWorktree`
puts them. A worktree nested inside the repo shows up as `?? .claude/` in the main
checkout's `git status` unless that repo happens to ignore the path — and this skill
reads an unexplained dirty main checkout as someone else's work and stops. Keeping
worktrees under `<runstate>` also means one rule covers every file the run generates:
none of it is ever inside the checkout.

One consequence worth knowing: `ExitWorktree` only removes worktrees the same session
created through `EnterWorktree`. It will not touch these, and neither will
`Agent(isolation: "worktree")`'s auto-cleanup, which only fires when the agent changed
nothing. Teardown here is `cleanup_run.sh` and nothing else.

## Viability gate

`worktree_setup.sh` reconstructs what a fresh worktree lacks without copying local
config, checks the shared hook, and — only with `--verify`, which this skill does not
pass by default — runs the project's own verification command. Whether that is _enough_
for a given repo is not worth predicting; it is worth testing, once, cheaply.

Provision the group's **first** worktree and read its `verdict:` line:

- `verdict: READY` → the repo is worktree-viable. Provision the rest.
- `verdict: BLOCKED` → the worktree could not be created. Not viable in this run.
- `verdict: READY_WITH_WARNINGS` with a red baseline → compare against the main
  checkout. **Red in both** is the repository's own broken state, which step 3 already
  knows how to report; parallel mode is still fine. **Green in the main checkout, red in
  the worktree** usually means something the verification needs is not reconstructible
  from tracked files plus a lockfile — not viable — but read the failure before
  concluding that, because one common cause is the worktree _layout_ rather than a
  missing resource. See
  [the gitlink case](#the-gitlink-case-a-red-baseline-that-is-not-a-verdict) below:
  fully explained, deterministic, and safe to run parallel through.
- `hooks: MISSING <hook…>` → lefthook's shared `pre-commit` hook, which `lefthook.yml`
  expects, is not installed, so a commit in any worktree would skip the staged guard.
  Run `just install` once in the main checkout (it runs `lefthook install`) and re-run;
  never install it from inside a worktree.

Not viable → remove that worktree, fall back to serial for the whole run, and say which
of these it was in the step 10 report. Do not retry per issue: the answer is a property
of the repository, not of the issue.

The usual causes of "green in main, red in the worktree", none of them worth working
around inside a run: a toolchain installed by hand instead of through `mise.toml` and
`rust-toolchain.toml`; a local
database with data in it that fixtures assume; a service the tests reach through a path
relative to the developer's real checkout; a build cache the suite treats as required
rather than as an optimization.

### The gitlink case: a red baseline that is not a verdict

**In a linked worktree, `.git` is a file, not a directory** — a gitlink holding
`gitdir: …/.git/worktrees/<n>`. Any suite that walks the whole tree and skips
version-control internals _by entry type_ therefore reads straight into the one path its
own skip list names. In a repository whose tests inventory placeholder strings, scan for
secrets, or assert what the tree contains, that shows up as a red baseline in every
worktree and green in the main checkout — the shape the gate calls "not viable".

It is not the same thing, and treating it as such costs the run its parallelism for a
cause that is fully understood. Tell them apart by reading the failure:

- **Same single assertion in every worktree, and its message names `.git` or a path that
  only exists in a worktree** → layout, not a missing resource. Parallel mode is fine.
- **Anything else** → the gate's ordinary reading applies. Not viable.

When it is the layout, say so and carry the diagnosis forward rather than letting three
sub-agents each rediscover it:

- Name the exact failing assertion in every step 3 and review fix prompt for that batch,
  with the cause, and say it is **not theirs to fix and not to be silenced** — no
  skip-list entry added to quiet it, which would be weakening a gate. Require each agent
  to say in `VERIFY` whether that failure was the _only_ remaining red, which keeps a
  red baseline from hiding a real one.
- Check whether it collides with the pre-commit hook. A repo running related tests on
  commit will refuse every commit the batch tries to make, and the escapes
  (`--no-verify`, disabling hooks) are exactly what a project's own rules forbid. When
  that happens the failure is not merely cosmetic and the issue whose scope covers it
  should fix it properly — which is the outcome this run had: the walk's skip was
  matched by _name_ whatever the entry type, the baseline went green, and it closed a
  real hole, since in an ordinary checkout that same type gate is what stands between
  the walk and `.git/config`'s possibly credentialed remote URL.

Record the call and its reason under `--event parallel-group --field reason=`, and say
in the step 10 report that the baseline was red for this reason — a run that merged on a
knowingly red baseline has to show its work.

## What a fresh worktree is missing

`git worktree add` checks out **tracked files only**. Everything below is absent:

- **Untracked local config** — `.env`, `.env.local`, `*.local`, `.envrc`,
  `.claude/settings.local.json`. **Never copied.** A worktree gets no secret and no
  personal-permission file; an issue whose verification needs one is not worktree-viable
  and runs serially in the main checkout. The session's own permission settings still
  govern every sub-agent it spawns, wherever that agent works.
- **Dependencies** — crates need no install step: cargo fetches into the shared
  `~/.cargo` registry and builds on demand, and the pinned tools come from `mise.toml`
  and `rust-toolchain.toml`, installed once per machine. `worktree_setup.sh` prints
  `deps: none-needed (cargo builds on demand)` when the worktree's own tree holds
  `Cargo.lock` (with `--dry-run`, the ref it would check out), never judging the main
  checkout, which can sit on another commit than `--base`.
- **`.git` is a file, not a directory** in a linked worktree — it is a gitlink pointing
  into the main `.git/worktrees/<name>`. Any tool that assumes a `.git/` directory can
  misbehave. Hooks are shared repo-wide rather than per-worktree: the lefthook
  `pre-commit` hook `just install` wrote into the main `.git/hooks` already runs for
  every worktree. So `worktree_setup.sh` only checks that it is installed and never runs
  `lefthook install` from a worktree.
- **The cargo `target/` directory** starts empty, and it is the expensive one. Every
  worktree of this Cargo workspace builds into its own `target/`: several gigabytes once
  clippy, the coverage build, and the tests have run (5.3 GB: observed on this Mac with
  `du -sh target`, 2026-09-29), and a first check that compiles every crate from
  scratch. That is why `plan.py` holds at most two worktrees open unless the user asks
  for more (`--max-parallel`). Sharing one `target/` through `CARGO_TARGET_DIR` is not
  the default: concurrent builds would wait on cargo's lock of that directory, giving
  back the time parallel mode exists to save. The main checkout's `target/` is never
  copied either.

## Failure modes that look like the issue's fault

- **Port collisions.** Two worktrees running a dev server or an integration suite bind
  the same default port; the second fails with something that reads like a test failure.
  This is why the setup calls are made one at a time, and why a repo whose verification
  binds fixed ports is not parallel-safe. The symptom to watch for: two or more
  concurrent runs report `VERIFY` failures that do not reproduce when the same command
  is re-run alone. That is the repo telling you it is not parallel-safe — finish the
  batch serially and record it.
- **One shared local database or fixture directory.** Same shape as ports: the failures
  land on whichever run lost the race, and look like flakes.
- **A branch cannot be checked out twice.** git refuses to add a worktree for a branch
  already checked out elsewhere. The `<type>/<n>-<slug>` naming makes this
  collision-free across issues, so hitting it means a stale worktree survived an earlier
  run — a stop condition (SKILL.md), not something to force past.
- **Shared refs and object store.** Worktrees have their own index and working directory
  but one `.git`. Ordinary concurrent edits and commits are safe; what is not safe is
  running `git gc`/`prune` from one while another writes. Nothing in this skill does
  that — do not add it.
- **`gh` shares one token and one rate limit.** Parallel implementation runs do not
  touch the GitHub API at all (the implementation template forbids it), which is what
  keeps this from mattering. It starts mattering the moment someone lets a sub-agent
  call `gh`.

## Teardown

All of it goes through `cleanup_run.sh --worktree-root <runstate>/worktrees`, in one
batch at step 9, after the last merge. Never `git worktree remove` or `rm` ad hoc — raw
`rm` trips a permission prompt and stalls the run, and the single entry point is what
lets deletion be gated on merge status.

Two facts that decide how to call it:

- **Gitignored files inside a worktree do not block removal and are lost with it.** A
  fixture, a benchmark result, a generated artifact an implementation run produced but
  did not commit is gone. The implementation template tells sub-agents to copy anything
  like that into the main checkout before returning; when one reports having produced
  such a file, confirm it landed before cleanup runs.
- **The default removes every worktree under the root**, including one another session
  is mid-run in. That is correct at the end of a run this skill owns end to end. It is
  wrong when other sessions may be working in the same repo, and wrong when cleaning up
  outside a run just to reclaim disk — pass `--merged-only` there, which keeps any
  worktree whose branch has no merged PR. A dirty worktree is skipped and listed either
  way; `--force` overrides that, and only after salvaging what matters.

Leaving worktrees behind is not free: each carries its own `target/`, so even one stale
worktree reaches gigabytes.
