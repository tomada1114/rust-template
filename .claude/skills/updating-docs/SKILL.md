---
name: updating-docs
description: >
  Decides whether a change owes a documentation update and which surface it lands on:
  README.md (Quickstart, Design Philosophy, Using This Template), AGENTS.md,
  CONTRIBUTING.md, CHANGELOG.md, docs/architecture.md, docs/getting-started.md,
  docs/distribution.md, docs/design/design-system.md, a skill under .agents/skills/, a
  /// rustdoc comment on a pub item in myapp-core, or a TSDoc comment in ui/src/ipc/ or
  scripts/lib/. Use when triaging whether a pull request needs a document changed or a
  CHANGELOG [Unreleased] entry, when a justfile recipe, a gate, an IPC name, or an
  architecture boundary moved and it is unclear which file owns it, when the setup
  steps drifted, when a template-only block is involved, or when deciding that an
  internal refactor needs no documentation change.
---

# Updating Documentation

**Owns:** whether a change owes a documentation update, and which surface it lands on.
**Does not own:** the wording rules for `docs/`, `README.md`, `CONTRIBUTING.md`, and
`CHANGELOG.md` (`.claude/rules/docs.md`); how a skill is written and mirrored
(`authoring-skills`); whether a change owes an ADR and how one is written
(`recording-architecture-decisions`); the roadmap (`steering-the-roadmap`); what a `///`
comment says (`writing-rust`) or a TSDoc comment says (`writing-typescript`); rolling
the changelog into a release (`releasing-the-app`).

## Decide on what a reader can observe

Documentation impact follows what a **reader can observe**, not the directory the edit
began in. An internal refactor, a test-only change, and a fix that restores documented
behaviour owe no document; say so in the pull request. Deciding that nothing is needed
is a legitimate outcome of this skill, not a step skipped.

A reader here can observe: what the app does when launched, the `just` recipes and what
they run, the setup steps and pinned tools, what a gate accepts or rejects, how the
template becomes an app (`just bootstrap`), how a release is built and signed, and
everything `docs/architecture.md` › "What is contract and what is private" lists. That
table is the one list of what is contract; read it there rather than from a copy.

- `README.md` changes when the first ten minutes with a checkout change (the Quickstart,
  what "Using This Template" asks), or when a decision its Design Philosophy records
  changes (`.claude/rules/docs.md` keeps the two in sync).
- `CONTRIBUTING.md` changes when setup, the toolchain, the commands behind a recipe
  ("Without Just"), or the pull request process changes.
- Neither changes for a refactor, a test, a rule `AGENTS.md` owns, or an edit to a skill.

A skill is documentation for an agent, so it is held to the same prose rules as the files
below; but editing one is not observable by a user and obliges no README, CONTRIBUTING,
or `AGENTS.md` edit, except when the skill set changes shape (see the last bullet of
"Changes that move two files at once").

The mechanical items that fire most often already have a home: `AGENTS.md`'s Review
Checklist (`///` on new public items, a TSDoc comment on a new IPC wrapper, the
changelog entry) and the Checklist in `.github/PULL_REQUEST_TEMPLATE.md` (documentation
and `CHANGELOG.md`). Work from those; this skill does not restate their items.

## Purpose per file

Each surface has one job. Do not blur them, and do not let one grow a second copy of
another's content: a copy is the half that goes stale.

| Surface | Its one job |
|---|---|
| `README.md` | The tour: what the template is, Quickstart, Design Philosophy (a "Why" per decision), Using This Template, links onward |
| `AGENTS.md` | The agent-facing guide: Quick Reference, "Validating a change", Architecture, Skills and Rules tables, "Security and human approval", "Repository scripts", "Enforcement layers", Review Checklist |
| `CONTRIBUTING.md` | Prerequisites, the workflow and its commands without Just, where a change goes, the pull request process, commit messages, the changelog policy |
| `CHANGELOG.md` | The human-curated record of user-visible changes (Keep a Changelog) |
| `docs/architecture.md` | The layers every app starts with, the ports, IPC, and what is contract |
| `docs/architecture/` | An app's ADRs and their index, and `roadmap.md` (owned by the two skills above) |
| `docs/getting-started.md` | First setup, everyday commands, seeing the app, TCC, removing the example code |
| `docs/distribution.md` | Building, signing, notarizing, opening, and verifying a release |
| `docs/design/design-system.md` | Every token's role and each primitive's recipe |
| a skill under `.agents/skills/` | The conventions of one kind of change, loaded on demand |
| `///` on a `pub` item in core | That item's contract: why it exists and what it promises |
| TSDoc in `ui/src/ipc/` and `scripts/lib/` | The same, for an exported wrapper or helper |

## Changes that move two files at once

Some facts have two readers, and the pull request that moves the fact updates both:

- a boundary or a crate's role: `AGENTS.md` › Architecture and `docs/architecture.md`;
- a `just` recipe added, renamed, or removed: the `justfile`, `AGENTS.md`'s Quick
  Reference, and `CONTRIBUTING.md`'s "Without Just" when it lists that recipe;
- a gate added or changed: its config and `AGENTS.md` › "Enforcement layers" (and the
  "Validating a change" row when the narrowest check moved), as `changing-gates` says;
- a command or event name, a payload shape, or an on-disk format:
  `docs/architecture.md`'s contract table, with the code;
- a token or primitive: `ui/src/design/` and `docs/design/design-system.md`;
- a signing, notarization, or release step: `docs/distribution.md`, with the workflow;
- a skill added, renamed, removed, or widened: its row in `AGENTS.md`'s Skills table
  (`just check-harness` fails when the names differ, not when a row's wording is stale).

## CHANGELOG.md

A user-visible change gets an entry under `[Unreleased]` in the same pull request that
makes it (Review Checklist item 6). User-visible means observable by someone running the
app, or by someone building an app from the template: a behaviour, a screen, a file
format, a recipe, a gate. Write the entry as the behaviour a reader sees, never as the
files that changed, under a Keep a Changelog heading (`Added`, `Changed`, `Fixed`,
`Removed`, `Security`, `Deprecated`). `just release-prep` later moves the whole section
under the version heading; the notes GitHub generates from `.github/release.yml` are a
supplement, not a substitute. Prettier skips `CHANGELOG.md`, so keep its wrapping by hand.
`CHANGELOG.md` and `docs/` are maintained surfaces, not leftovers: keep them current
rather than folding their content into a pull request description.

## Doc comments

- Every `pub` item carries a `///` comment saying why it exists and what it promises,
  and a fallible `pub fn` an `# Errors` section. Enforced by: `Cargo.toml`
  `[workspace.lints.rust]` "missing_docs" and clippy `pedantic` under `just lint`.
- Core's `pub` API is contract, so its `///` is the document a caller reads instead of
  the body. When a change alters what an item promises, the comment changes in the same
  commit.
- An exported wrapper in `ui/src/ipc/` and an exported helper in `scripts/lib/` carry a
  TSDoc comment. No lint enforces this: the Review Checklist asks for it on an IPC
  wrapper, and review alone holds it for a `scripts/lib/` helper.

## Template-only material

The bootstrap removes every `<!-- template-only -->` … `<!-- /template-only -->` block
and the template's own design notes, so an app never inherits text about the template.
Text only a template reader needs (why the bootstrap exists, how to use the template)
goes inside a block; text an app keeps (the Design Philosophy of a kept decision, the
distribution flow) goes outside. A standing document outside a block never links into
the template's design notes: that link dangles in every app.

## What checks a document, and what does not

- `just check-harness` fails when `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, or a skill
  names a `just <recipe>` the `justfile` lacks, and when `AGENTS.md` or a skill carries
  an issue-number reference.
- `mise exec -- typos <file>` spell-checks Markdown (the hook and CI run it too).
- Nothing formats Markdown (`.prettierignore` lists `*.md`); wrap prose at about 90
  columns by hand.
- No gate compiles or runs a fenced example in a Markdown file. The one exception is in
  Rust: `cargo test --doc` (inside `just test-core`) compiles and runs the examples in
  core's `///` comments. So an example that must stay correct goes where a test runs
  it (a doc-comment example on a core item, or a test beside a script), and the
  document points at it instead of copying it. A fenced block in Markdown stays small
  enough to check by eye: a command, a path, a short snippet.
- Do not write a document that promises a gate this repository does not have; one that
  claims a check nobody runs is worse than one that stays silent.

An external claim in any of these files (a version, an availability, a default, a
policy) carries its URL and the date it was checked (`.claude/rules/docs.md`).

## What belongs in prose

Non-obvious behaviour, decisions, and trade-offs. Not what the code, a type, or a
signature already says: if a reader can get the fact by reading the signature or by
running the code, it needs no sentence.

## Generated trees are off-limits

Never hand-edit or document as source: `.claude/skills/` (the mirror `just agents-sync`
writes from `.agents/skills/`), `ui/src/ipc/generated/` (`just bindings` writes it from
core's types), `src-tauri/gen/`, and build output. Edit the source and regenerate.
