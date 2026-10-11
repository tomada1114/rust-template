# The ship contract

An issue can state the facts this run would otherwise infer from its prose, in a comment
block anywhere in the body:

```
<!-- ship: tier=P1 area=test-infra blocked-by=none blocks=#N
     touches=crates/myapp-core/,Cargo.toml design=settled -->
```

Nothing here is required, and a repo with no contracts works exactly as before — the
heuristics stay. But every field an issue carries is one the run does not re-derive,
which is why `file_followup.py` writes a contract on everything this run files.

## Table of Contents

- [Fields](#fields)
- [Backfilling the backlog](#backfilling-the-backlog)

## Fields

| Field                     | Read by                                      | What it changes                                                                                          |
| ------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tier=`                   | `priority-rubric.md`     | A **settled** tier, not a guess. Ranks like a written label and prints without the `~`.                  |
| `blocked-by=` / `blocks=` | `dependency-triage.md` | Stated edges rather than scraped ones.                                                                   |
| `touches=`                | the parallel grouping                        | The one field that changes what this skill can do mechanically — see below.                              |
| `area=`                   | `file_followup.py`, contract                   | The contract area a follow-up inherits; no area label is applied.                                                                     |
| `design=`                 | the readiness gate                           | `design=open` holds the issue out of automatic implementation exactly as a `blocked: design` label does. |

An empty `blocked-by=` reads as none; an empty `tier=` or `touches=` counts as missing.
A `blocked-by=` field (even `none`) or any `Depends on: #N` line makes those the only
source of the issue's dependencies: dependency phrasings in its prose are then read as
mentions, not edges. A `Depends on:` line counts at the start of a line, bare or as a
bullet, numbered, or task-list item; one inside a code block, a code span, or an HTML
comment is a quoted example and does not. `blocks=` is still merged with the prose
`blocks #N` edges.
A value may not itself start like `key=` (`touches=a=b.py` does not parse), and an
empty field never swallows the field after it.

`touches=` is the load-bearing one. Without it, deciding whether two issues can run in
parallel worktrees is a judgement about which files they _might_ collide on. With it,
the decision is a set intersection — which is why `plan.py` reports
`grouping: MECHANICAL` only when every issue in the batch declares it, and `PARTIAL`
when at least one does not.

Give `touches=` the paths a fix will actually land in, or `*` when you genuinely cannot
say. `*` is honest; a narrow guess is not, because step 2c will trust it.

## Backfilling the backlog

`issue_digest.py --audit` names the existing issues missing a contract. Run it when a
plan comes back `PARTIAL`. Report its list at step 10 rather than backfilling issues by
hand mid-run — that list is what stops the next run over this backlog from paying the
same judgement cost twice.
