# ADR-NNNN: <the decision, as a short phrase>

<!--
Copy this file to docs/architecture/adr/NNNN-<kebab-case-title>.md with the next free
number, fill in every section, delete this comment and every hint line, and add the
ADR's row to docs/architecture/README.md in the same change. A section with nothing to
say keeps its heading and says "None." rather than disappearing.
-->

- **Status:** Proposed
- **Date:** YYYY-MM-DD
- **Deciders:** the owner

<!--
Status lines, as the ADR moves (docs/architecture/README.md, "How an ADR changes"):
- **Status:** Accepted YYYY-MM-DD
- **Amended:** YYYY-MM-DD — <what changed and why; one line per correction>
- **Status:** Superseded by [ADR-NNNN](NNNN-<kebab-case-title>.md) YYYY-MM-DD
- **Status:** Rejected YYYY-MM-DD
A partly settled decision says which part is which: "Accepted: <part>. Proposed: <part>."
-->

## Context

What forces the decision now: the requirement, the constraint, or the problem, and what
the code or the platform already fixes. Name the file or symbol it touches (a core
port, a crate in `Cargo.toml`, a subcommand, a file format, a directory in
`crates/myapp-platform/src/paths.rs`) rather than a `path:line`.

## Decision drivers

- The properties the options are judged on, most important first — the app's
  `## Product` section in `AGENTS.md`, the layer rules in `docs/architecture.md`, a
  reviewer or user requirement, cost.

## Considered options

1. **<Option A>** — what it is, in a sentence.
2. **<Option B>** — …
3. **Do nothing** — what staying as is costs, when that is a real option.

## Decision

The chosen option, stated so someone who reads only this section knows what to build,
and the reason it beat each of the others.

## Consequences

### Positive

- What this makes easier or possible.

### Negative

- What this costs or rules out, and what would make the decision worth revisiting.

### Follow-ups

- The work this decision creates — an issue, a gate, a skill — each with where it is
  tracked.

## Open questions

- What is still undecided, and what would settle it.
- Unverified: <a claim not yet checked against a primary source; verify it and move it
  to Sources, or delete the claim that needed it>.

## Sources

- <https://doc.rust-lang.org/...> or a platform's own documentation — what it
  supports — checked YYYY-MM-DD
- <https://docs.rs/...> or <https://crates.io/crates/...> — the crate, its version, and
  its licence — checked YYYY-MM-DD

## Related

- ADR-NNNN, linked as `[ADR-NNNN](NNNN-<kebab-case-title>.md)` — how it relates
  (depends on, constrains, supersedes).
