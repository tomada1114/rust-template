# Delegation Prompt Templates

## Table of Contents

- [Inline or by tier](#inline-or-by-tier)
- [Standing prohibitions for every brief](#standing-prohibitions-for-every-brief)
- [Priority research and labeling](#priority-research-and-labeling-executor)
- [Implementation](#implementation-step-3)
- [Review fix, parallel mode](#review-fix-parallel-mode-step-4)
- [Review fallback](#review-fallback-step-4)
- [CI repair](#ci-repair-step-6-only-on-fail)
- [Design decision](#design-decision-step-8b)

Every brief this skill hands off is a fully self-contained prompt: whoever runs it
cannot ask a question back, so a hole in it returns as a decision made alone rather than
as a question. Leave nothing merge-gating unguessed. The parent — this session — owns
every GitHub **write** (opening the PR, `link_check.sh`, `land_pr.sh`, labels, comments),
every wait (`ci_watch.sh`), and every merge-gating judgment — triaging the review's
findings included; a brief only touches code inside the checkout.

## Inline or by tier

Every brief below runs **inline by default**: this session fills it and follows it
itself, in the same `{workdir}`, under the same prohibitions and the same return
contract. On a host with named sub-agents — the tiers AGENTS.md's "Sub-agents" defines —
a brief may instead be handed to the tier its section names (`executor`, `architect`,
`scout`, or `worker` — the last only for tool-free drafting, never code). Spawn by the tier's
**name**, never by a bare model name or a per-spawn `model` parameter: the tier carries
its effort with it, and a bare model runs at whatever effort the session has. Which tier
takes which brief, and why:
`cost-discipline.md` › "Tier assignment".

A patch round or a repeat CI repair on the same tier **continues the same agent** where
the host allows it; spawn a fresh one only on a tier change — a fresh spawn re-reads the
whole repository the first run already learned.

**Reading its own issue — and the parent issue its `Part of: #<N>` line names, when it
has one — is the only GitHub call a brief makes.** Pasting a full issue body into the
prompt means the parent must first pull it into _this_ context — the exact
cost `cost-discipline.md` exists to avoid, paid once per issue and again on every resume
run. So every template below that reads an issue hands over its _number_ and lets the
agent run `gh issue view <n> --repo <o/r> --json title,body,labels,comments` itself,
under the standing prohibitions below. The JSON form is not a style choice: without a
TTY — which is how every sub-agent runs `gh` — `gh issue view <n> --comments` prints the
comments and **not the body**, so an agent handed that command implements an issue it
never read (observed: the agent reported the body's checklist as unreadable). Give it a
two-or-three-sentence paraphrase alongside, marked as subordinate to the body, so a
misread is visible rather than silent. What never moves to a sub-agent is a write, or a
merge-gating judgment.

`{workdir}` below is the one thing every template must get right: the repo's main
checkout in serial mode, that issue's worktree (`<runstate>/worktrees/<n>`) in parallel
mode. **Two writers never share a working directory** — that invariant is what makes
parallel mode safe, and filling `{workdir}` with the main checkout for two concurrent
runs breaks it silently rather than loudly. `{holding_dir}` is `<runstate>/holding/<n>/`
for that issue — create it (`mkdir -p`) before handing a brief off. The design brief is
the exception, and only because it writes nothing in the tree: it reads a checkout others
are working in without disturbing it. Everything
downstream of implementation still runs one PR at a time in the parent.

## Standing prohibitions for every brief

Two things stay off-limits in every template below unless it says otherwise. This is the
full statement; each brief restates it compactly in its own prompt text, so the prompt
stays self-contained when pasted on its own — a spawned sub-agent cannot follow a
cross-reference back to this file.

- **No GitHub write.** No `gh pr`, no `gh issue edit/comment/close`, no label change, no
  `gh api` call with a non-GET method. The parent opens the PR, watches CI, and writes
  every label and comment — a sub-agent only reads, and only its own issue.
- **No deletion.** No `rm`, no branch deletion, no worktree removal — including a
  scratch fixture or throwaway repository created under a temp directory: leave it
  exactly where it is and name it in the report. `rm` raises an approval prompt that
  stalls the run, and a disposable temp directory costs nothing to keep. Revert a probe
  inside the checkout with `git checkout --`, or move it out of the way with `mv` into
  `{holding_dir}` (`<runstate>/holding/<n>/`, keeping its relative path). When the issue
  itself requires removing a file or directory, the same move does it, followed by
  `git add -A -- <path>` for tracked content — never `git rm`, never `rm -rf`. A
  dependency is removed by deleting its entry from the `Cargo.toml` that declares it and
  letting the next `cargo` command update `Cargo.lock`; a crate is never added without a
  human's sign-off (`managing-dependencies`). Any other command that raises an approval prompt is not run: name
  it under `UNRESOLVED` and the parent defers it
  (`closing-out.md` › "Approval-gated commands").

The design brief is the one named exception to the first rule: it writes two specific
things to GitHub (a design comment, a label clear) as its whole purpose, spelled out in
its own template.

## Priority research and labeling (`executor`)

Used only when more than ~3 open issues still lack a `priority:` label, or when the top
rows of a labeled backlog are close enough that the pick needs evidence. On a fully
labeled backlog, the plan's `select:` line is the answer and no research is warranted.

The agent writes the labels itself — that is the point of the handoff. What comes back
is the pick with its evidence, the order behind it, and the blocked/unclear lists; the
issue prose and the raw digest table never cross back. In `all` mode it also returns
proposed parallel-safe groups — a proposal, not a decision:
[step 2c](../SKILL.md#2c-confirm-the-proposed-batch) still has to clear the repository's
own viability gate before any of it runs.

Prompt body: `agent-priority-research.md`. Fill its
`{brace}` placeholders from the current repo and run count.

## Implementation (step 3)

One brief per issue. **`executor` is the default; **`architect` when the issue is
foundational** — architecture or a skeleton, an interface/port/schema, or a skill,
instruction file, or gate whose shape the rest of the backlog copies. The test is blast
radius, not difficulty:
`cost-discipline.md` › "The foundation exception: architect for what the backlog builds on".
A resume/patch run stays on the tier its first run used. In parallel mode hand off every
brief in the batch **before waiting on any** — in one message where the host batches
spawns; started one after another they run one after another, which is the whole thing
this mode exists to avoid.

Prompt body: `agent-implementation.md`.

## Review fix, parallel mode (step 4)

Only for findings this session has already read and accepted, in parallel mode.
`/code-review --fix` writes to the session's own working tree, which in parallel mode is
the main checkout sitting on the default branch — the wrong tree — so the review runs
read-only and the writing is delegated here instead
([SKILL.md step 4](../SKILL.md#4-review-the-branch)). Zero accepted findings → nothing to
run. One **`executor`** per branch that has any, always inside that branch's own
`{workdir}`.

Prompt body: `agent-review-fix.md`.

## Review fallback (step 4)

Only when this session's host will not let it launch `/code-review` directly — see
[SKILL.md step 4](../SKILL.md#4-review-the-branch). One independent, **read-only**
`architect` against the branch; never this session re-reading its own diff.

Prompt body: [agent-review-fallback.md](agent-review-fallback.md).

## CI repair (step 6, only on `FAIL`)

Only after `ci_watch.sh` returns `FAIL`. Write the failing log to a file **outside** the
working directory first (`<runstate>/ci/<pr>.log`) — a stray untracked file inside it
makes cleanup skip the directory as dirty, and a commit convention that stages
everything would land the log in the change. **`executor`** for attempts 1–2 (the second
continues the first agent where the host allows); **`architect`** from attempt 3, once
the same failure has survived two attempts in a row. One PR at a time.

Prompt body: `agent-ci-repair.md`.

## Design decision (step 8b)

Used at [SKILL.md step 8b](../SKILL.md#8b-unblock-held-designs-in-the-background), one
brief per design-blocked issue: **`architect` in the background** on a host that reports
background completion — this session hands a round off and goes straight back to
shipping — otherwise inline, at the point described there.

This is the only brief in this skill that writes to GitHub, and only two writes: one
comment on the issue and one label clear. It writes nothing in the checkout, so
`{workdir}` is the repo's main checkout even while a parallel batch is running — it
reads there, it never touches the tree.

Prompt body: `agent-design-decision.md`.

**The queue.** One decision per issue, never batched into one brief. In the background,
cap **3 in flight** and queue the rest — this run's own filings first, then backlog
issues highest tier first; a round is handed off in one message where the host batches
spawns. **The queue drains on each completion report, not at a step**: when one returns,
record it and start the next queued one in the same turn, whatever step the shipping
path is on. Hand off this run's own filings as soon as `file_followup.py` returns their
numbers.

**Inline** (no background completion), the same queue is bounded and timed differently.
It takes this run's own filings plus **at most 3** backlog designs, highest tier first —
the same 3 as the background cap; every other held design is a step 10 line, "not
decided this run". Decisions run one at a time, between issues: the first after the
first merge, then after each later merge and before the next step 3 — never in the
middle of one issue's steps 3–7. Only when there is nothing to ship at all (the plan
selected no issue) do they run straight after step 1.

Sweep the backlog's held designs **once per run, at step 1** — in every mode, single
included — and never again per issue shipped. Anything still queued or in flight when
the run ends is a step 10 line; nothing ever waits on it.

Record each return
(`--event design --field issue=<n> --field step=8b --field mode=<background|inline> --field verdict=<DECIDED|DEFERRED>`).
`LABEL: left-on` alongside `VERDICT: DECIDED` means only the label write failed — clear
it from this session before treating the issue as ready. An issue returned `DECIDED` is
ordinary backlog from that moment: ready for the next run, or for this one at step 8c.

`VERDICT: DEFERRED` is a result, not a failure — it is the run declining to invent a
product decision, and its `OPEN-QUESTION` is what the step 10 report puts in front of
the user.
