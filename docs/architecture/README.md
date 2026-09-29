# Architecture Decisions

This tree records the decisions an app cut from this template makes on top of the
layers it starts with, one Architecture Decision Record (ADR) per decision, and why each
was made. It is written for anyone reviewing the design — including the owner six months
from now — and assumes no context beyond the repository.

Three places hold the reasoning, and each has one job:

- [`../architecture.md`](../architecture.md) describes the layers every app starts with —
  the core, platform, test-support, and helper crates, the Tauri shell, and the UI — how
  they talk, and what is contract. It is the ground the ADRs build on, not a record of
  choices.
- The repository README's [Design Philosophy](../../README.md#design-philosophy) holds
  the template's own reasoning: why a workspace, why ts-rs, why no WebDriver tests. The
  template ships no ADRs of its own.
- The ADRs below record what the app decided after that: its design system, where it
  keeps state, what it depends on, whether it needs the App Sandbox or a new
  entitlement, how it ships, and which permissions it asks for.

`AGENTS.md`'s "Before changing the architecture" names the changes that owe an ADR;
`recording-architecture-decisions` is the skill that writes one. An app's first ADR is
usually its design lock (`adr/NNNN-design-lock.md`), decided before its first screen.

Beside the ADRs, [`roadmap.md`](roadmap.md) records the app's direction — which outcomes
come now, next, and later — and links the issues and ADRs each one needs. It is not an
ADR: it takes no status and no number, has no row in the table below, and authorizes
nothing. The template ships it as a skeleton; `steering-the-roadmap` is the skill that
changes it.

## Status legend

| Status | Meaning |
|---|---|
| Proposed | A recommendation with its reasoning, not yet confirmed by the owner. Work may start on it only as an experiment. |
| Accepted | Confirmed by the owner. Work builds on it. |
| Rejected | Declined by the owner. Kept, with its number, for the reasoning. |
| Superseded | Replaced by a later ADR, which it names. Kept for the reasoning, never edited into agreement. |

## How an ADR changes

- A Proposed ADR is a draft: edit it freely until the owner decides.
- It becomes Accepted, or Rejected, when the owner confirms; the change is a one-line
  edit to its status, with the date.
- An Accepted ADR takes small corrections in place — a re-checked fact, a clarified
  consequence, a follow-up that landed — each recorded as an `Amended YYYY-MM-DD` line
  under its status saying what changed. What it decided stays the same.
- A decision that is replaced gets a new ADR. The old one becomes
  `Superseded by ADR-NNNN`, gains a link forward, and is otherwise left as it was.
- Numbers run from `0001` and are never reused, even for a rejected proposal.

## Adding an ADR

1. Copy [`adr/template.md`](adr/template.md) to `adr/NNNN-<kebab-case-title>.md`, using
   the next free number.
2. Fill it in, with status Proposed.
3. Add its row to the table below in the same change.

## Decisions

The template ships this table empty: its own reasoning is in the repository README's
Design Philosophy. The first row is the app's first ADR.

| ADR | Decision | Status |
|---|---|---|
