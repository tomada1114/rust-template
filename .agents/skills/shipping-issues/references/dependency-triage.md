# Dependency and Readiness Triage

## Table of Contents

- [Readiness gate](#readiness-gate)
- [Dependency edges the regex misses](#dependency-edges-the-regex-misses)
- [Ordering rules](#ordering-rules)
- [Parallel vs sequential (`all` mode)](#parallel-vs-sequential-all-mode)
- [Single mode: which issue](#single-mode-which-issue)
- [Deciding a held design](#deciding-a-held-design)
  - [The background round](#the-background-round)
  - [Clearing a stale `blocked: dependency`](#clearing-a-stale-blocked-dependency)

**`plan.py` already answers most of this.** Its `grouping:` line is
`MECHANICAL` when every issue in the batch declared its `touches=` -- that
grouping is authoritative and this file has nothing to add to it. Read here when
the plan says `PARTIAL` (some issue declared nothing, so the batch is a
proposal), when an ordering looks wrong, or when a design has to be decided
inline. Reading it on every run is a cost the plan exists to remove.
The script annotates mechanical signals; this file covers the judgment the
script cannot make. Which of the ready issues is *worth* shipping first is a
separate question -- see `priority-rubric.md`.

## Readiness gate

An issue is **shippable** only if all of these hold:

1. It states a concrete change -- a behavior, a file, an acceptance condition.
   "Consider improving X" is a discussion, not a work item.
2. Nothing it depends on is still open (`BLOCKED-BY` flag empty).
3. No open PR already claims it (`HAS-OPEN-PR` flag absent), unless that PR is
   stale/draft and the user asked to take it over.
4. No `NOT-READY-LABEL` (blocked, question, discussion, wontfix...), and no
   `NEEDS-DESIGN` (`blocked: design` or a recognized equivalent) unless it was
   taken on deliberately -- see
   [Deciding a held design](#deciding-a-held-design) below. The two are
   different failure modes: a hard label needs someone else to act first; a
   design block just needs a decision, which this run can make -- and by default
   does, in the background, for every design-blocked issue it files or finds.
   An issue whose block was cleared that way is ordinary: it carries a decision
   recorded on the issue itself, and passes this gate like anything else.
5. Its scope is one coherent change. An issue that is really five issues gets
   reported back for splitting, not implemented as a mega-PR.

An issue that fails 1 or 5 is **not** implemented silently. Report it as
`NEEDS-CLARIFICATION` with the specific missing information, and move on to the
next candidate.

## Dependency edges the regex misses

`issue_digest.py` catches explicit `#N` references and the common English
dependency phrasings (`Depends on #N`, the spelling `triaging-issues` asks for). These
edges only appear on reading:

- **Same-file collision** -- two issues that both rewrite `Cargo.toml` are not
  formally dependent, but they must not run in parallel worktrees, and the
  second one's branch must be cut *after* the first has merged, from the
  updated default branch -- never from a branch point that predates it.
- **Schema-before-consumer** -- an issue adding a column/field must land before
  any issue reading it, even with no cross-reference.
- **Interface-before-implementation** -- a protocol/type issue precedes the
  issues that implement it.
- **Config-before-feature** -- a settings/validation issue precedes features
  that read those settings.
- **Port-before-adapter** -- a port in `myapp-core` (a trait such as `Clock`) lands
  before the `myapp-platform` adapter, the fake in `myapp-test-support`, and the
  shell wiring in `src-tauri/src/` that use it.
- **Append-target collision** -- a changelog, release-notes file, decision log,
  or generated index that every PR appends to conflicts both-added even when
  the code paths are disjoint. Find such files once, before grouping (what did
  the last few merged PRs all touch?); branches that both append to one are a
  same-file collision.
- **Shared-cause duplication** -- two issues that are symptoms of one underlying
  defect (the same rename, the same missing guard) produce the same hunks
  independently. If two shortlisted issues name the same symbol or the same
  failure, ship one first and start the other from the result -- or report
  them as one issue.
- **Umbrella issues** -- an epic listing `- [ ] #A #B #C` is not itself
  implementable. Treat it as a container: ship the children, leave the epic.
  A `tracking` (or `epic`) label makes `issue_digest.py` drop it mechanically.

When two issues could reasonably go either order, prefer the one that is
smaller and touches fewer files first -- it shortens the window in which the
other's branch can drift.

## Ordering rules

1. Topologically sort by dependency edges (explicit + inferred above).
2. Within a level, order by `priority:` label tier, then by the digest's score
   within a tier (see `priority-rubric.md` for what each tier means); break
   remaining ties with "touches fewer files" and then "older".
3. Cycles are a data problem, not something to break arbitrarily. Report the
   cycle and ask which edge to drop.

The digest's `UNBLOCKS:#a,#b` flag is the reverse of `BLOCKED-BY` and is the
main input to step 2: an issue several others wait on belongs at the front of
its level even when it looks small.

## Parallel vs sequential (`all` mode)

Read at [step 2c](../SKILL.md#2c-confirm-the-proposed-batch), after
the ordering above is settled. This decides which issues may be *implemented*
at the same time; the PR, CI watch and merge stay serialized regardless.

**Every parallel batch passes through step 2c** -- the plan proposes, that step
decides. A script can tell you two issues declare no overlapping paths and no
dependency edge; it cannot tell you both will end up editing `Cargo.toml` or
`src-tauri/src/lib.rs`'s `generate_handler!`, that one is a refactor whose blast radius is
wider than its `touches=` admits, or that a generated file makes any two concurrent
branches conflict. Thoroughness scales with the grouping verdict: `MECHANICAL` means
read each issue's real reach against its declared `touches=`; `PARTIAL` means
read the undeclared issues properly before keeping them.

When step 2's research agent ran, it returned its own parallel-safe groups from
paths it actually grepped. That is a second opinion, not a tie-break: where it
and `plan.py` disagree, take the narrower grouping. Shrinking the batch is
always allowed and never needs asking -- two issues in parallel is already most
of the win, and a wrong pairing costs a merge conflict mid-batch. Note any issue
whose `touches=` had to be judged: it is a step 10 line.

Two issues may share a batch only when **all** of these hold:

- Neither depends on the other, directly or transitively.
- Their likely file sets do not overlap. Estimate it before spawning by
  grepping for the symbols and paths each issue body names -- a two-minute
  check that prevents a conflict pileup nobody wants to unpick later.
- Neither changes shared infrastructure -- `Cargo.toml` and `Cargo.lock`,
  `package.json` and `pnpm-lock.yaml`, `mise.toml`, `rust-toolchain.toml`, the
  `justfile`, CI config, `ui/src/ipc/generated/`, a persisted file format.
  Anything touching those is serialized, always, even when the code paths are
  disjoint. An append-only list is not shared infrastructure: every user-facing
  change adds a `CHANGELOG.md` entry, and a new skill adds a row to `AGENTS.md`'s
  Skills table, so serializing on them would serialize nearly every batch. Two
  branches that each append there conflict only mechanically -- keep both entries
  when bringing the later branch up to date (`recovery.md`).
- Neither is a `blocked: design` issue taken on deliberately. Step 2b's
  decision has to be settled and recorded before its implementation starts,
  and settling one while two other runs are in flight is how a design decision
  gets made in a hurry. An issue whose design was *already* decided and
  recorded -- by step 2b earlier, or by a step 8b background agent -- carries no
  block and is ordinary here; what this excludes is deciding a design while the
  batch runs, not implementing one that was decided.

Cap a batch at **2** concurrent worktrees unless the user asked for more. Each one
compiles the whole workspace into its own `target/` from cold, and beyond two the
default branch drifts faster than the batch's branches can be brought up to date, so
the conflict and build cost outgrow the wall-clock saving.

Fewer than 2 issues clear these checks -> the batch is serial, and no worktree
is created. That is the common outcome on a small or tightly coupled backlog,
and it is not a failure -- say so in one line and move on.

Whether the *repository* can support any of this is a separate gate:
`worktree-parallelism.md`.

After each merge inside a batch, the remaining branches are behind. Bring them
up to date in their own worktrees before their own PR is opened rather than
after a CI failure -- a conflict there is evidence this grouping call was wrong
for that pair, and worth recording as such.

## Single mode: which issue

Among the shippable issues, pick by `priority-rubric.md` -- unblocks-others
first, then leverage, then must-be-first ordering, then damage being taken
now. State the pick with its evidence lines before implementing.

## Deciding a held design

Two paths lead here, and they differ only in who decides and when:

- **inline -- [step 2b](../SKILL.md#2b-decide-a-design-that-gates-the-pick)**,
  when the design blocks the very issue this run is about to implement (an
  explicit issue number or `--include-design`, never the default backlog scan).
  This session decides it, on the critical path, before step 3.
- **background -- [step 8b](../SKILL.md#8b-unblock-held-designs-in-the-background)**,
  for every *other* design-blocked issue: the ones this run just filed and the
  ones already sitting in the backlog. An `architect` sub-agent decides each one
  while this session keeps shipping, and does 1-2 and 4 below itself.

Either way, the same four things happen in the same order:

1. Settle the approach -- from the repo, its conventions, and the issue thread.
2. Record the decision as a comment on the issue itself -- the next
   implementer must read this back, not re-derive it. The comment is the
   design of record; a decision that lives only in a run's transcript did not
   happen.
3. Record it in the run record (`--event design --field issue=<n> --field
   mode=<inline|background> --field verdict=<DECIDED|DEFERRED>`).
4. Clear the block: `python3
   .agents/skills/shipping-issues/scripts/apply_priority_labels.py --clear-design <n>` --
   after the comment posted, never before. It clears both forms of the block: the
   `blocked: design` label (or its equivalent) and a `design=open` in the ship contract,
   rewritten to `design=settled` with the rest of the body untouched. Clearing only the
   label leaves the issue held.

**Neither path invents a product or UX call** the repo and the issue thread do
not already answer. Inline, ask the user and do not implement past it; in the
background, the agent returns `DEFERRED` with the question, leaves the block
on, and the question reaches the user in the step 10 report.

Inline, continue at step 3 with the decided approach as part of the brief. In
the background, the cleared issue is simply ready -- for this run at step 8c if
budget allows, otherwise for the next one. The tier label is untouched by any
of this -- see priority-rubric.md's note that tier and design-readiness are
orthogonal.

### The background round

[Step 8b](../SKILL.md#8b-unblock-held-designs-in-the-background)'s mechanics.
Everything filed `--needs-design`, plus the design-blocked issues already in the
backlog (step 1's `needs-design:`), gets one `architect` from
`agent-design-decision.md`.

- **Spawn and move on -- never block on one.** They run while this session keeps
  shipping, and the host notifies this session as each returns.
- One agent per issue, all of a round issued **in one message**. Cap **3 in
  flight**; queue the rest -- this run's own filings first, then backlog issues
  highest tier first.
- **The queue drains on notification, not at a step.** When one returns, record
  it and spawn the next queued agent in the same turn, whatever step the shipping
  path is on. Anything still queued or in flight when the run ends is a step 10
  line.
- Sweep the backlog's held designs **once per run, right after step 1** -- in
  every mode, single included -- and never again per issue shipped. Spawn this
  run's own filings as soon as `file_followup.py` returns their numbers.
- The agent writes no code, no branch, no PR: it decides the approach, posts it
  as a comment (the design of record the next implementer reads), and clears the
  block itself. A design turning on a product or UX call the repository and the
  issue thread do not already answer comes back `DEFERRED` -- the block stays on,
  the `OPEN-QUESTION` goes to the user at step 10, and that is a correct outcome.
- Record each return (`--event design --field issue=<n> --field mode=background
  --field verdict=<DECIDED|DEFERRED>`). `LABEL: left-on` alongside `VERDICT:
  DECIDED` means only the `--clear-design` write failed -- re-run
  `python3 .agents/skills/shipping-issues/scripts/apply_priority_labels.py
  --clear-design <n>` from this session before treating the issue as ready.

An issue returned `DECIDED` is ordinary backlog from that moment: ready for the
next run, or for this one at step 8c. Under Codex CLI there is no background
spawn: decide held designs inline between issues, one at a time, or leave them
for the next run and say so at step 10.

### Clearing a stale `blocked: dependency`

Readiness itself never reads `blocked: dependency` (or an equivalent) -- rule 2
of the [readiness gate](#readiness-gate) comes from the dependency edges
themselves, `BLOCKED-BY`. So a `blocked: dependency` label whose every
dependency has since closed is simply stale: correct at selection time, wrong
by the time a human reads the backlog. `plan.py` names these on a
`stale-labels:` line when any exist; the run clears them with
`apply_priority_labels.py --clear-dependency` without asking, since it is only
correcting a label to match edges the plan already verified, not making a new
judgment call. `triaging-issues` puts that duty on whoever lands the blocker, so
the run re-plans right after each merge to do it
(`pr-ci-merge.md`).
