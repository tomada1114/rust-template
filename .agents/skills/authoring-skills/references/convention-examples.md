# Convention examples

Worked examples for the conventions `SKILL.md` defines. Each pair shows the form to write
and the form to avoid; the reason follows. The "avoid" forms are described rather than
written out where writing them would trip a check (a `just` recipe that does not exist,
an issue number).

## Where material belongs

| The material | Its home |
|---|---|
| A prohibition every agent needs whatever its task | `AGENTS.md` (a skill points at the section) |
| A short rule for one kind of file | `.claude/rules/<name>.md`, loaded by path (Claude Code only) |
| A value a gate enforces (lint level, floor, pin) | the gate's config; a skill names it in one `Enforced by:` line |
| A recurring procedure, with the reasons behind it | a skill |
| Tables, long examples, and edge cases of a skill | that skill's `references/` |
| How a tool works in general | the tool's documentation, linked |
| Why the template is shaped as it is | `README.md` › "Design Philosophy", or an ADR in an app |

## Descriptions

Write: "Covers adding a Tauri command end to end: the core function, the thin
`#[tauri::command]`, the ts-rs DTO, and the wrapper in ui/src/ipc/commands.ts. Use when
adding, renaming, or removing a command or an event, editing generate_handler!, or
fixing a bindings drift failure."

Avoid: "This skill first reads the core module, then writes the command, then runs the
bindings recipe, then updates the wrapper." It summarizes steps, names no file or error a
host could match on, and the host loads the skill on the description's meaning alone.

## Cross-reference markers

Write:

- `**REQUIRED:** \`designing-errors\`, before adding a variant to a core error enum.`
- `**BACKGROUND:** [references/why-ports.md](references/why-ports.md).`
- `The failure contract is owned by \`writing-repo-scripts\`.` (bare: it only names an
  owner)
- `` `AGENTS.md` › "Security and human approval" ``

Avoid: a path into `.claude/skills/` or `.agents/skills/` (the reader may be in the other
tree, and the path breaks if the skill is renamed); "`AGENTS.md`, line 300" (stale after
the first edit above it); a third marker such as `**NOTE:**` or `**SEE ALSO:**` (the two
markers exist so a reader can tell "must load" from "may skip" at a glance); a link to
`docs/template/` (gone after the bootstrap).

## Deletable illustrations

Write: "A state transition is a method that returns the new state or a typed error,
never a mutation the caller has to read back. In the sample, `Counter::increment` takes
`self` and returns `Result<Self, CounterError>`."

Avoid: "`Counter::increment` returns `Result<Self, CounterError>` instead of mutating, so
state transitions are values." An app that deletes the counter must now rewrite this
sentence from code it has not written yet; the first form loses one sentence and keeps
the rule.

The same holds for a code block: introduce it as the example ("In the sample:"), and let
the prose above it carry the rule. `rg -i 'counter'` is how an app finds what to delete,
so a sample mention that sits in its own sentence is one it can delete cleanly.

## Platform-skill scope

Write, in a skill about Tauri commands: "A command stays thin: it borrows the state,
calls one core function, and maps the error. It decides nothing, because the coverage
floor sees only core. How a command receives arguments and state is Tauri's
documentation (https://v2.tauri.app/develop/calling-rust/)."

Avoid: three paragraphs restating how `#[tauri::command]` parses arguments, which Tauri
documents and changes on its own schedule. A restatement goes stale without a pull
request touching it; a link does not.

The same split applies to macOS: a skill holds that this repository reaches macOS
through a system command behind a port first, and through `objc2` bindings only when
there is no command, with the reason; the bindings' API is linked
(https://docs.rs/objc2/latest/objc2/), not copied.

## External claims

Write:

- "Codex CLI scans `.agents/skills` from the working directory up to the repository root
  (https://learn.chatgpt.com/docs/build-skills, checked 2026-09-29)."
- "`ActivationPolicy::Prohibited` keeps focus during a smoke run: observed on this Mac
  with `lsappinfo front` during `just smoke`, 2026-09-28."
- "E0382 is a use of a moved value (https://doc.rust-lang.org/error_codes/E0382.html)."
  (a concept link: no date needed)

Avoid: "Tauri supports this on every macOS version" with no source; a URL with no date
on a version or availability claim (the reader cannot tell whether it is still true); a
date on a page the author did not open that day.

When a claim's page has moved or changed, fix the claim and its date together. A
dependency update that crosses a tool's major version is the moment to re-read the
claims that cite it.

## Commands that exist

Write: "Run `just test-fast <filter>` while iterating, then `just test-core`." Both are
recipes, so `just check-harness` keeps them honest.

Avoid: a recipe name the `justfile` lacks (the harness check fails the commit), or the
raw command a recipe wraps when the recipe exists (it drifts when the recipe's flags
change, and nothing checks it). `just --list` shows every recipe, and
`just --show <recipe>` prints the commands inside one.

For a command that is not a recipe, run it once as written before committing, or, for a
destructive or remote one, confirm the subcommand and flags with `--help`. A pinned tool
is written `mise exec -- typos <file>`, never a bare `typos`, which may be a different
version or absent.

## Never taking over the developer's Mac

Write: "For evidence that the change is wired, run `just smoke`, then `just logs`. When
only the window shows it, ask the human to run `just run` (a human's recipe: it opens
the app) and put what they saw in the pull request."

Avoid: "Run `just run` and check the window." An unattended agent following that opens
an app on top of the owner's work and takes focus.

## For a reader new to Rust

Write: "Take `&str` and return `String` from a core function. A `&str` borrows the
caller's text without copying it, so the caller keeps its value; returning a `String`
hands the result over with no lifetime to track. If the borrow checker still objects,
clone the small value rather than adding a lifetime annotation: a clone of a short string
costs nothing measurable here, and the next reader does not have to follow a lifetime."

Avoid: "Use `&str` in, `String` out." It is correct and gives the reviewer no way to
tell whether a diff that breaks it matters.

## Sub-agent steps

Write: "Hand the review to `architect` (`subagent_type: architect`); under Codex CLI,
run the same review inline before merging."

Avoid: a step that only works if a sub-agent exists, such as "the architect sub-agent
will post its findings", with no inline path.
