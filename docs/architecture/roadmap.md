# Roadmap

<!--
This page starts as a skeleton, the way AGENTS.md's `## Product` section does: an app
cut from the template replaces every `TODO:` line below once its `## Product` section
is written. Nothing checks this page for leftover markers; the
`steering-the-roadmap` skill says who changes it, when, and from what. Delete this
comment when the page is first filled in.
-->

This page records the app's direction: the outcomes it is working toward now, the ones
that come next, and the ones only intended for later. It sits between two other homes
and repeats neither:

- `AGENTS.md`'s `## Product` says what the app is, its core interaction, and its
  non-goals. Nothing here contradicts a non-goal; moving one is the owner's call, made
  in that section first.
- The issue tracker holds the units of work, their priority labels, and their `blocked:`
  and `on hold` labels (`triaging-issues`). This page links issues and never copies
  their bodies.

It records direction and authorizes nothing. An issue is implemented because it is
filed, prioritized, and picked, never because a line here names it. It is not an ADR
either: it takes no status and no number, and a decision a line depends on is recorded
as an ADR ([the index](README.md)) and linked from here. What has shipped is in
`CHANGELOG.md`, not on this page.

The owner decides what the page says; an agent proposes a change to it in a pull
request, and the change lands only once the owner has approved it.

- **Last reviewed:** TODO: YYYY-MM-DD, the date this page was last checked against the
  open issues

## Now

The outcomes being worked on, one to three of them. Each has its issues filed.

- TODO: **[an outcome, as what a user can do]** — why it comes first, in one sentence.
  Issues: [links]. Done when: [what can be observed — a smoke run, a `just` recipe, a
  behavior in the running app — not a task that was finished].

## Next

The outcomes that follow once Now's are done. An issue may already exist for one, often
parked as `on hold`; none is required.

- TODO: **[an outcome]** — why it follows Now. Before it moves up: [an ADR to write, an
  outcome in Now to land, an open question for the owner]. Issues, if any: [links].

## Later

Direction the app intends to take but has not ordered. No issue is filed for a line
here, apart from a parked one that a line names.

- TODO: **[an outcome]** — what would bring it forward.
