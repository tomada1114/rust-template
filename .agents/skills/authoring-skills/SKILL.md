---
name: authoring-skills
description: >
  Covers how a skill in this repository is written under .agents/skills/, mirrored into
  .claude/skills/ by just agents-sync, and kept from silently failing to load, and the
  conventions every skill follows: the REQUIRED/BACKGROUND cross-reference markers,
  deletable illustrations, platform-skill scope (link tool docs, never restate them),
  external claims with a URL and a checked date, commands that must exist, never taking
  over the developer's Mac, and explaining Rust for a reader new to it. Use when adding,
  editing, reviewing, or splitting a SKILL.md or a references/ file, running just
  agents-sync or just agents-check, fixing a just check-harness failure about a skill,
  deciding whether material belongs in AGENTS.md, a rule, or a skill, or investigating
  why a skill never fires in Claude Code or Codex CLI.
---

# Authoring Skills

**Owns:** where a skill lives, its layout and frontmatter, its size, and the conventions
every skill in this repository follows. **Does not own:** how a script under `scripts/`
is written (`writing-repo-scripts`); which documentation surface a change lands on
(`updating-docs`); changing a gate's configuration (`changing-gates`); what any one
skill says about its own subject.

## One source, one generated mirror

- Author a skill once, under `.agents/skills/<name>/`, where Codex CLI reads project
  skills (https://learn.chatgpt.com/docs/build-skills, checked 2026-09-29).
  `just agents-sync` copies that tree byte for byte into `.claude/skills/`, where Claude
  Code reads them (https://code.claude.com/docs/en/skills, checked 2026-09-29).
- Loop: edit the `.agents/` copy, run `just agents-sync`, commit both trees together.
  Never hand-edit `.claude/skills/`: the next sync overwrites the edit without a word.
  `just agents-check` fails when the trees differ; the pre-commit hook runs it when a
  commit stages a skill path, and CI's `Repo Lint & Harness` job runs it on every PR.
- The mirror is real files, not a symlink: a symlink is only a link where git checks it
  out as one (`core.symlinks`, https://git-scm.com/docs/git-config, checked 2026-09-29),
  and real files let `just agents-check` compare bytes. The sync refuses a symlink.
- Being generated, the mirror is skipped by `typos`, Prettier, and ESLint, and
  `.gitattributes` collapses it in a PR diff. Review and spell-check `.agents/skills/`.

## Layout

- One directory level: `.agents/skills/<name>/SKILL.md`, plus optional `references/`,
  `scripts/`, or `assets/` beneath it. No category folders.
- No file below a skill's top directory is named `SKILL.md`: a scanner walking the tree
  can take it for a second skill. Name a reference file for its content.
- A `references/*.md` file is linked from `SKILL.md` by relative path, never with `@` or
  an absolute path; it links to no further reference file (one level deep) and stays
  under 400 lines.

## Frontmatter

Exactly two keys, `name` and `description`, the description a folded block scalar
(`description: >`). No third key: Claude Code's `paths` would gate auto-loading on a
glob, but Codex CLI has no such key and matches on `description` alone, so the same skill
would fire on different work in each host.

- `name` equals the directory name: lowercase letters, digits, and single hyphens, at
  most 64 characters (https://agentskills.io/specification, checked 2026-09-29).
- `description` is printable ASCII (no em dash, no curly quote), at most 1,024
  characters (same source). Claude Code truncates its listing at 1,536 and Codex CLI
  shortens descriptions when many skills compete for context (the host pages above), so
  specific beats long.
- It is a retrieval string in English: what the skill covers, then when to load it,
  naming the files, commands, error codes, and phrases that should trigger it. It never
  summarizes the skill's own steps.

## What belongs in a skill

- Work that recurs and needs a procedure, local references, or policy loaded on demand.
  A fact stated once goes in `AGENTS.md` or a doc; a variant of an existing skill's
  subject extends that skill rather than starting a near-duplicate.
- One home per rule. A prohibition every agent needs whatever its task (never weaken a
  gate, never bypass a hook) stays in `AGENTS.md`, and a skill points at it. A short
  per-file rule goes in `.claude/rules/`, which only Claude Code loads, so a skill must
  still read correctly for a Codex CLI agent that never saw the rule.
- What a config enforces gets one line, `Enforced by: <file> "<setting>".`, and the skill
  spends its words on the judgment the config cannot express.
- Every skill opens with an ownership block like the one above (`**Owns:**` /
  `**Does not own:**`), naming the sibling that decides each adjacent question.
- Adding, renaming, removing, or widening a skill updates its row in `AGENTS.md`'s Skills
  table in the same commit.

## Conventions every skill follows

Defined here once; worked examples and edge cases are in
[references/convention-examples.md](references/convention-examples.md).

**Cross-reference markers.** A pointer the reader must follow as a step of the task
carries `**REQUIRED:**` (the task cannot be finished correctly without it) or
`**BACKGROUND:**` (it only explains why), and no other marker. Its target is a sibling
skill by name in backticks (never a path: the two trees differ), a `references/` file by
relative link, or `AGENTS.md` › "Section name" (never a line number). A mention that only
names an owner or credits a source stays bare. Never point at `docs/template/`: the
bootstrap deletes it.

**Deletable illustrations.** Every app deletes the template's sample, the counter
(`docs/getting-started.md` › "Removing the example code"). State each rule in a sentence
that does not mention the sample, then give the sample as the example in the next
sentence or code block, so deleting the example leaves a rule that still reads. No build
or test depends on a skill's code block. Write placeholder names exactly (`myapp-core`,
`MyApp`, `com.example.myapp`, `MYAPP_SMOKE`) so the bootstrap's rename finds them.

**Platform-skill scope.** On a surface someone else documents (Rust, cargo, Tauri, a
crate, macOS and Apple APIs, React, Vitest, GitHub Actions), a skill holds only this
repository's decisions, their reasons, the mechanics that are ours (paths, recipes, crate
names, error codes), and the traps met here. Everything else is a link to the tool's
documentation, not a restatement of it.

**External claims.** A version, availability, default, limit, or policy claim about an
external tool carries `(<URL>, checked YYYY-MM-DD)`, and the author opened that page on
that date. A link that only explains a concept needs no date. An observed fact says so:
"observed on this Mac with `<command>`, YYYY-MM-DD". A claim that is neither is dropped.

**Commands that exist.** Every command a skill tells the reader to run works here today.
A `just <recipe>` is written as typed (`just test-fast <filter>`) and `just check-harness`
fails on one the `justfile` lacks, so prefer the recipe to the command inside it. Any
other command, path, crate, type, error code, or environment variable the author runs or
greps before committing; a pinned tool goes through `mise exec --`. A remote write
(`git push`, `gh pr create`, `just labels`) appears only with its condition from
`AGENTS.md` › "Security and human approval"; a skill grants itself nothing.

**Never taking over the developer's Mac.** Every step a skill tells an agent to run
follows `AGENTS.md` › "Never taking over the developer's Mac": on its own an agent runs
only what shows no window, takes no focus, and raises no prompt, with `just smoke` and
`just logs` as its evidence. A human's recipe (`just dev`, `just run`,
`just install-app`, `just test-local`, `just logs-follow`, `just reset-permissions`) is
marked as one wherever a skill names it. A skill never has an agent `open` the app,
script another app, build a `.dmg` locally, or start an installer or `sudo`; it hands
the human the command instead.

**For a reader new to Rust.** The human reviewing the pull requests a skill shapes may
not read Rust fluently yet. Where a Rust rule would stop that reader, the same or the
next sentence says why: what the compiler or clippy does otherwise, or what breaks
later. A compiler error is named by code and plain meaning with its error-index page
(E0382, use of a moved value: https://doc.rust-lang.org/error_codes/E0382.html). Terms
follow `AGENTS.md`; any other is explained in a clause on first use. The language is
linked, not taught (The Rust Book, https://doc.rust-lang.org/book/).

**Sub-agent steps.** A step handed to `executor`, `architect`, or `worker` names the tier
by `subagent_type` and still works when a Codex CLI agent runs it inline.

## Size

Target 150 body lines per `SKILL.md` (after the closing `---`); `just check-harness`
fails past 200. Past the target, move tables, long examples, and edge cases into
`references/` and keep the decisions and the order of work in `SKILL.md`. The cap is far
under the 500 lines the specification and Claude Code's page advise, because every line
of an active skill competes with the task for the agent's context.

## Scripts bundled inside a skill

A script under `.agents/skills/<name>/scripts/` follows `AGENTS.md` › "Repository
scripts", and its tests run under `just test-scripts`; the first skill to ship one wires
its suite in within the same pull request. **REQUIRED:** `writing-repo-scripts`. Keep it
a thin dispatcher: branching logic belongs in `scripts/`, where the coverage floors apply.

## Before committing a skill

A matching mirror proves nothing about the source: a `SKILL.md` whose frontmatter does
not parse, whose `name` differs from its directory, or that carries a third key mirrors
cleanly and never loads in either host. `just check-harness` covers the mechanical part,
including no issue-number reference (`#` and digits): a skill states the rule and its
reason itself.

```bash
just agents-sync
just agents-check
just check-harness
mise exec -- typos .agents/skills/<name>
```

No check reads the description's wording, the 150-line target, the markers, whether an
example is deletable, whether a cited page says what the skill says, or whether a
non-`just` command runs. Read those yourself against the conventions above.
