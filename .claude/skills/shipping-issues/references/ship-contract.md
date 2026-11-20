# The ship contract

An issue can state the facts a run would otherwise infer from its prose, in a comment
block anywhere in the body:

```
<!-- ship: tier=P1 area=test-infra blocked-by=none blocks=#N
     touches=crates/myapp-core/,Cargo.toml design=settled -->
```

Nothing here is required, and an issue with no contract ships as before: the run reads
its labels and its `Depends on` lines. But every field an issue carries is one the run
does not re-derive, which is why every follow-up this skill files ends with a contract.
No script parses it: the backlog projection prints the block, and the agent reads it.

## Fields

| Field | What the run reads it for |
| --- | --- |
| `tier=` | A settled tier, `P0` to `P3`, standing in for a missing `priority:` label. What a tier means is `triaging-issues`' to say. |
| `blocked-by=` / `blocks=` | Stated dependency edges: issue numbers, or `none`. |
| `touches=` | The paths the fix will land in. It tells the run how far the change reaches before it reads the code, and whether two issues can share a parallel batch when the user asked for one. |
| `area=` | The part of the repository the issue is about, which a follow-up inherits. No label is applied from it. |
| `design=` | `design=open` holds the issue out of an automatic pick exactly as a `blocked: design` label does; `design=settled` says the approach is decided. |

How the fields are read:

- An empty `blocked-by=` reads as none; an empty `tier=` or `touches=` counts as
  missing.
- A `blocked-by=` field (even `none`) or any `Depends on` line makes those the only
  source of the issue's dependencies: a dependency phrased in its prose is a mention,
  not an edge.
- A `Depends on` line counts at the start of a line, bare or as a bullet, numbered, or
  task-list item. One inside a code block, a code span, or an HTML comment is a quoted
  example and does not count; the backlog projection prints a line from a code block
  all the same, so read the issue before trusting an edge that looks odd.

Give `touches=` the paths a fix will actually land in, or `*` when you genuinely cannot
say. `*` is honest; a narrow guess is not, because the next run will trust it. Two
issues whose `touches=` overlap, or either of which says `*`, never share a parallel
batch; neither do two that both edit a file every change meets, such as `Cargo.toml`, a
workflow, the subcommand enum in `crates/myapp/src/main.rs`, or core's re-exports in
`crates/myapp-core/src/lib.rs` (a `CHANGELOG.md` entry is not a collision).

## When a held design is settled

`design=open` changes to `design=settled` only after the issue's `## Design decision`
comment has posted (`rest-calls.md` › "Settling a held design"), with the rest of the
body byte for byte. The `blocked: design` label, when the issue carries one, is cleared
in the same step, so the two forms of the block never disagree.

## Issues without a contract

A run does not backfill contracts on issues it is not shipping: adding one is triage's
step, made when the issue is next read.
