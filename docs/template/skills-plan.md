# Skills plan

<!-- template-only: cargo xtask bootstrap removes docs/template/ from a generated app. -->

The owner wants the reference templates' skills carried over substantially, rebuilt
for this stack rather than renamed. This page is the per-skill brief the
implementation run works from. It extends [design.md](design.md) § D20.

Sources, all read-only:

- `M` = `tomada1114/macos-app-template/.agents/skills/` (19 skills)
- `T` = `tomada1114/typescript-template/.agents/skills/` (16)
- `I` = `tomada1114/instant-composition/.agents/skills/` (27)

## How a skill is ported

1. Read every source skill named for it in full, including `references/` and `scripts/`.
2. Keep what is a decision about *how this kind of repository is run* — its reasons
   included — and restate it in this stack's terms. Drop what only describes the source's
   stack, and do not restate tool documentation: link it (issue #135 platform-skill
   convention, from the start).
3. Replace every mechanic with this repository's real one: paths, recipes, crate
   names, config files, error codes. A command a skill tells the reader to run must exist
   (the harness check enforces `just` recipes; the run checks the rest by running them).
4. Every version, availability, or policy claim about an external tool carries a URL
   and a checked date.
5. Frontmatter is exactly `name` + `description`; the description says what the skill
   covers and when to load it, naming the files and phrases that should trigger it. Body
   ≤ 200 lines (target 150); detail goes to `references/` one level deep. The #135
   conventions (cross-reference markers, deletable illustrations, platform-skill scope)
   are defined in `authoring-skills` first and used everywhere after.
6. Every skill honours the "never take over the developer's machine or terminal" rule
   (design § D22) wherever it tells an agent to run something.

Where a reader new to Rust would stall, the skill says why, not only what — the owner
reviews the PRs these skills shape and does not yet read Rust fluently.

## Target skill set after the CLI/TUI pivot (2026-10-01)

The pivot in [design.md](design.md) (§1; D5, D8, D12, D18, D22) changes the stack every
skill describes, so the set below supersedes the 26 skills the first run ported for the
desktop-GUI stack; git history keeps that per-skill brief, with what each was ported
from. The target is 23 skills.

Deleted — five skills that only served the GUI, the Node toolchain, or distribution:
the GUI's screen-building, design-system, and IPC skills (`building-tuis` takes the
screen work; there is no design-lock step, design § D23, and no IPC, design § D4), the
release skill (no distribution; a tool is installed with `cargo install --path`, design
§ D18), and `writing-typescript` (the automation is `cargo xtask`, design § D12).

Added:

| Skill | Covers |
|---|---|
| `designing-clis` | A subcommand end to end: the clap derive declaration, the thin handler that calls core and prints a view, stdout for output and stderr for error wording, an exit code per error kind, `--help` text, and the integration test that runs the built binary against a temp data directory (design § D5, D15). |
| `building-tuis` | A ratatui screen: `draw` over a core view, `update` from a key event to the next state, the terminal restored on every exit path, the theme module, and testing with `TestBackend` and key events as values — never a real terminal (design § D8, D15, D22). |

Rewritten for the new stack — the rest, each keeping its purpose with the GUI shell, the
front end, Node, and release mechanics replaced by the binary crate, the TUI,
`cargo xtask`, and `cargo install --path`:

| Skill | What the rewrite changes |
|---|---|
| `authoring-skills` | Examples and the never-take-over rule extended to the terminal (design § D22). |
| `smart-commit` | Only `Cargo.lock` travels with a manifest; no generated bindings or `pnpm-lock.yaml`. |
| `create-pr` | Evidence is `just check` plus, for a TUI change only a real terminal shows, the human's run; Release impact judged on the command line and on-disk formats, not on a disk image. |
| `triaging-issues` | `path:line` examples use crate paths only. |
| `shipping-issues` | Recipes and gates renamed; worktree and merge flow unchanged. |
| `steering-the-roadmap` | Unchanged in substance. |
| `merging-dependency-prs` | Ecosystems: cargo, github-actions, mise, rust-toolchain; ratatui and crossterm minors treated as migrations; the GUI framework's lockstep rule removed. |
| `updating-docs` | Surfaces without the front end's doc comments or `docs/distribution.md`. |
| `recording-architecture-decisions` | ADR triggers for a CLI/TUI tool: a new crate or port, persistence, a new dependency, a new target platform, distribution, `rust-version`, `unsafe`, a TCC permission. |
| `changing-gates` | Gate files without ESLint, tsconfig, Vitest, Prettier, the GUI's security and signing settings, or entitlements; xtask's harness checks added. |
| `writing-repo-scripts` | Automation as `cargo xtask` tasks: the failure contract, `GIT_*` isolation, fakes for child processes, fixture roots (design § D12). |
| `managing-dependencies` | Crates only; no npm, pnpm, or GUI framework plugins. |
| `starting-an-app` | `cargo xtask bootstrap`; choosing CLI-only or CLI + TUI; deleting the sample; installing with `cargo install --path`; no design-lock or app-shape step. |
| `writing-rust` | Adds clap and ratatui idioms a newcomer meets; drops the GUI framework's. |
| `tdd` | One language: core, then the subcommand or TUI layer, with `TestBackend` for a screen. |
| `writing-tests` | Rust only: CLI integration tests, `TestBackend` buffer assertions, key events as values; no Testing Library or IPC mocks. |
| `placing-tests` | Where a CLI, TUI, or xtask test goes and which floor measures it; no GUI command tests or Vitest projects. |
| `designing-core-logic` | Views shared by a subcommand's output and a TUI frame; no IPC boundary. |
| `designing-errors` | Variant to wording and exit code in the binary crate; `ERR_*` codes in xtask; no serialized codes for a UI. |
| `integrating-system-apis` | macOS and Linux adapters behind `cfg(target_os)`, each with its contract suite. |
| `running-the-app` | The tests, a subcommand run against a scratch `HOME`, and `just logs` as an agent's evidence; `myapp tui` run by the human, never by an agent (design § D22). |

## Rules (`.claude/rules/`, Claude Code only)

| Rule | Loads for | Holds |
|---|---|---|
| `rust.md` | `crates/**/*.rs` | The short always-on version of `writing-rust` and `designing-errors`: no `unwrap` outside tests, `pub(crate)` by default, `tracing` not `println!`, `unsafe` only in platform with `// SAFETY:`. |
| `testing.md` | Rust test files | The issue #134 list, and where each kind of test goes. |
| `project.md` | manifests, lockfiles, gate configs | The dependency policy and the tool-pinning policy. |
| `docs.md` | `docs/**`, README, CONTRIBUTING, CHANGELOG | English; external claims with URL and checked date; no `#NNN` in standing docs. |

## Review

After the skills land, an independent review pass reads each ported skill beside its
sources and this page and reports anything dropped without a reason, any mechanic that
does not exist in this repository, and any unlinked external claim. Findings are fixed
before the skills PR merges.
