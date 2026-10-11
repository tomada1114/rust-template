# Priority Research and Selection

## Table of Contents

- [The label is the answer, written down](#the-label-is-the-answer-written-down)
- [The research pass](#the-research-pass)
- [Overriding the suggested tier](#overriding-the-suggested-tier)
- [Deciding, and saying why](#deciding-and-saying-why)
- [`all` mode](#all-mode)

Read when the backlog has issues without a `priority:` label, or when a written label
looks wrong. On a fully labeled backlog the pick comes from the plan's `select:` line
and this file is not needed. Dependency mechanics (what must land before what) live in
`dependency-triage.md`.

**Priority here means impact on the rest of the backlog, not "the one I feel like
doing."** Concretely, in this order:

1. **Unblocks other work** — closing it makes other open issues implementable.
2. **Leverage / ripple effect** — it improves the ground every later issue stands on
   (CI, test harness, shared types, schema, config, security).
3. **Must-be-first ordering** — not a formal dependency, but doing it later means
   redoing work (schema before consumers, interface before implementations, lint/format
   rules before touching many files).
4. **Damage being taken right now** — broken build, crash, data loss, vulnerability,
   failing CI on main. These jump the queue regardless of score.

Apply `triaging-issues`' priority definitions to this evidence. Documentation can
carry any tier when its impact warrants it; its format alone does not imply P3.

## The label is the answer, written down

Those four axes get evaluated **once per issue** and the verdict is stored on GitHub as
a label, so the next run reads it instead of re-deriving it:

**REQUIRED:** `triaging-issues` owns the P0–P3 definitions and the independence of
priority and design readiness. Use its priority table; this reference owns only
the research procedure and vocabulary aliases.

Existing vocabularies are read as equivalents, so a repo with its own convention is
never force-relabeled: `p0`/`critical`/`urgent`/`blocker` → P0, `priority: high` → P1,
`priority: medium` → P2, `priority: low`/`nice to have` → P3. `apply_priority_labels.py`
and `file_followup.py` write the spelling the repository already defines — the canonical
name when it exists, else its shortest alias, matched without regard to case — and a
re-tier strips any other tier label the issue carries.

The scripts apply labels and never create a label definition — `.github/labels.yml`
declares them and `just labels` creates them. A label a call would apply that the
repository lacks stops the call before its first write with `verdict: MISSING_LABELS`
and exit 4. Creating the definitions (`just labels`) is a human's remote write that
invoking this skill does not sign off: report it with that command, and rank from the
`~P<n>` suggestions meanwhile.
`apply_priority_labels.py --check-labels` asks the same question for the four tier
labels without writing anything.

Correct a wrong tier using `apply_priority_labels.py --set N=P1`, within the
shipping run's authorized label-write scope (`triaging-issues`).

**Re-tier on new information, not on a hunch.** A merged blocker, a new dependency
edge, or a `P2(~P0)` marker from the digest is new information; "this feels more
urgent today" is not.

## The research pass

Run it on unlabeled issues, and on any issue whose label the digest flags as too low
(`P2(~P0)`). The script's suggested tier comes from labels, cross-references, and
keywords — enough to _rank_, not enough to _choose_. Spend a short, bounded pass
gathering evidence for the top 3–5 rows only:

| Question                                            | How to check                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Does it really unblock the issues the table claims? | read both ends' comments; a bare `#A` mention is not a dependency                                                           |
| Is the "damage" still real?                         | is the failure reproducible now — check whether CI on `<default>` is actually red, or run the project's test command         |
| Does it touch shared ground?                        | grep the paths/symbols the body names; a change under `src/core`, `schema/`, `.github/workflows/` has ripple by construction |
| Is it actually specified?                           | Does the body state a behavior, a file, or an acceptance condition?                                                          |
| Has someone already started?                        | `HAS-OPEN-PR` flag, plus recent comments claiming the work                                                                   |
| Is it stale for a reason?                           | An issue untouched for a year with no reaction may be dead; check comments before reviving it                                |

Stop the research when the top candidate is clearly ahead. Do not read every open issue
in full — that is what the score exists to avoid.

## Overriding the suggested tier

The heuristic is deliberately crude — it suggests a tier for the whole backlog for free
so that judgment only has to correct the few it gets wrong. Write the correction with
`apply_priority_labels.py --set N=<tier>`; the cases that recur:

- **Keyword false positive** — the body says "security" in passing but the change is a
  docs tweak. Demote it, usually to P2/P3.
- **Unblock edge is fake** — `#A` was mentioned as context, not as a prerequisite.
  Demote from P0; the ranking usually changes.
- **Umbrella / epic** — an issue whose body is a checklist of other issues is not
  implementable. Labelled `tracking` (or `epic`), `issue_digest.py` drops it before
  ranking and reports it on a `tracking:` line, so it is never offered a tier;
  unlabelled, it is this judgement call on every run, so propose the label instead of
  tiering it. Never select it; ship its highest-priority child. An issue that is really
  five issues is different — report it as `NEEDS-CLARIFICATION`, do not demote it to
  hide it. Tiers answer "how much does this matter", not "can I ship it"; readiness is
  the other axis, and it lives in the dependency-triage reference.
- **Cheap unblock beats expensive damage** — when the top two are close, prefer the one
  that is smaller and touches fewer files. It lands sooner and shortens the window in
  which other branches drift.

## Deciding, and saying why

State the pick in this shape before implementing anything — the evidence lines are what
make the choice auditable, and they are cheap once the research pass is done:

```
Selected: #A "CI fails intermittently on macOS runners"  (P0, READY)
Why first:
  - unblocks #C, #D — both add tests that cannot be trusted while CI is flaky
  - leverage: touches .github/workflows/ci.yml, every future PR benefits
  - damage now: main has been red 3 of the last 5 runs
Runner-up: #E (P1) — real, but self-contained; nothing waits on it
Deferred: #F umbrella (ship its children), #G NEEDS-CLARIFICATION (no acceptance condition)
Labels written: #A P0, #E P1, #G P2 (+6 backfilled by score)
```

Proceed on that pick without asking. Ask the user directly, in plain conversation, and
wait for their reply, only when the top two are genuinely tied on all four axes and cost
a full implement/PR/CI cycle to get wrong, or when the highest-priority issue needs a
product decision before it can be implemented. A wrong-but-clearly-argued pick is
recoverable; a stalled run is not.

## `all` mode

The same rubric produces the _order_, not just the winner. Sort by dependency level
first (an issue cannot precede what it depends on), then by tier within a level, then by
score within a tier — which is exactly what `issue_digest.py --select N` prints. Re-rank
after each merge with `plan.py --refresh` — the same call: merging a blocker moves its
dependents from BLOCKED to READY, and a freshly READY P0 may outrank whatever was next
in the original plan. Because the tiers are labels, the re-rank costs one script call,
not another research pass.
