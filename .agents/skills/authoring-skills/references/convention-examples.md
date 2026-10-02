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

Write: "Covers adding a subcommand end to end: the clap declaration, the thin handler
that calls core and prints the view, the wording in crates/myapp/src/wording.rs, and the
test in crates/myapp/tests/cli.rs. Use when adding, renaming, or removing a subcommand
or a flag, changing what goes to stdout or stderr, or choosing an exit code."

Avoid: "This skill first reads the core module, then writes the handler, then adds the
wording, then runs the tests." It summarizes steps, names no file or error a
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

Write, in a skill about subcommands: "A handler stays thin: it calls one core function,
prints the view, or maps the error to its wording and an exit code. It decides nothing,
because the coverage floor sees only core. How clap's derive turns a struct into
arguments is clap's documentation (https://docs.rs/clap/latest/clap/_derive/index.html)."

Avoid: three paragraphs restating how `#[derive(Parser)]` parses arguments, which clap
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
- "A debug build echoes each log line to stderr with the binary crate's name as its
  target: observed on this Mac with `cargo run --locked -p myapp -- counter show`,
  2026-10-01."
- "E0382 is a use of a moved value (https://doc.rust-lang.org/error_codes/E0382.html)."
  (a concept link: no date needed)

Avoid: "crossterm supports this in every terminal" with no source; a URL with no date
on a version or availability claim (the reader cannot tell whether it is still true); a
date on a page the author did not open that day.

When a claim's page has moved or changed, fix the claim and its date together. A
dependency update that crosses a tool's major version is the moment to re-read the
claims that cite it.

## Commands that exist

Write: "Run `just test-fast <filter>` while iterating, then `just test-core`." Both are
recipes, so `just check-harness` keeps them honest.

Avoid: a recipe name the `justfile` lacks (`just check-harness` and CI fail on it), or the
raw command a recipe wraps when the recipe exists (it drifts when the recipe's flags
change, and nothing checks it). `just --list` shows every recipe, and
`just --show <recipe>` prints the commands inside one.

For a command that is not a recipe, run it once as written before committing, or, for a
destructive or remote one, confirm the subcommand and flags with `--help`. A pinned tool
is written `mise exec -- typos <file>`, never a bare `typos`, which may be a different
version or absent.

## Never taking over the developer's Mac

Write: "For evidence that the change works, run `just test-platform`, then `just logs`.
When only a logged-in Mac can show it, ask the human to run `just test-local` (a human's
recipe: it may raise a Keychain or privacy prompt) and put its output in the pull
request."

Avoid: "Run `just test-local` to check the Keychain adapter." An unattended agent
following that raises a prompt on top of the owner's work and takes focus. Likewise
"Run `myapp tui` and check the screen": it takes over the terminal the agent runs in,
and the human's beside it; the view's `TestBackend` tests are the agent's evidence, and
a look at the real terminal is the human's to give.

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
