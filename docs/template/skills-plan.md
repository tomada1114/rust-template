# Skills plan

<!-- template-only: scripts/bootstrap removes docs/template/ from a generated app. -->

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
6. Every skill honours the "never take over the developer's Mac" rule (design § D22)
   wherever it tells an agent to run something.

Where a reader new to Rust would stall, the skill says why, not only what — the owner
reviews the PRs these skills shape and does not yet read Rust fluently.

## Target skill set after the CLI/TUI pivot (2026-10-01)

The pivot in [design.md](design.md) (§1; D5, D8, D12, D18, D22) changes the stack every
skill describes, so the set below supersedes the 26 skills that follow, which stay as the
record of what each was ported from. The target is 23 skills.

Deleted — they only served the GUI or distribution:

| Skill | Why |
|---|---|
| `building-react-screens` | No React screen; `building-tuis` takes the screen work. |
| `designing-ui` | No WebView design system or design-lock step (design § D23). |
| `designing-ipc` | No IPC: subcommands and the TUI call core in-process (design § D4). |
| `releasing-the-app` | No distribution; a tool is installed with `cargo install --path` (design § D18). |
| `writing-typescript` | No TypeScript left: the UI is ratatui and the automation is `cargo xtask` (design § D12). |

Added:

| Skill | Covers |
|---|---|
| `designing-clis` | A subcommand end to end: the clap derive declaration, the thin handler that calls core and prints a view, stdout for output and stderr for error wording, an exit code per error kind, `--help` text, and the integration test that runs the built binary against a temp data directory (design § D5, D15). |
| `building-tuis` | A ratatui screen: `draw` over a core view, `update` from a key event to the next state, the terminal restored on every exit path, the theme module, and testing with `TestBackend` and key events as values — never a real terminal (design § D8, D15, D22). |

Rewritten for the new stack — the rest, each keeping its purpose with Tauri, `ui/`, Node,
and release mechanics replaced by the binary crate, the TUI, `cargo xtask`, and
`cargo install --path`:

| Skill | What the rewrite changes |
|---|---|
| `authoring-skills` | Examples and the never-take-over rule extended to the terminal (design § D22). |
| `smart-commit` | Only `Cargo.lock` travels with a manifest; no generated bindings or `pnpm-lock.yaml`. |
| `create-pr` | Evidence is `just check` plus, for a TUI change only a real terminal shows, the human's run; no Release impact tied to a `.dmg`. |
| `triaging-issues` | `path:line` examples use crate paths only. |
| `shipping-issues` | Recipes and gates renamed; worktree and merge flow unchanged. |
| `steering-the-roadmap` | Unchanged in substance. |
| `merging-dependency-prs` | Ecosystems: cargo, github-actions, mise, rust-toolchain; ratatui and crossterm minors treated as migrations; the Tauri lockstep rule removed. |
| `updating-docs` | Surfaces without `ui/`, TSDoc, or `docs/distribution.md`. |
| `recording-architecture-decisions` | ADR triggers for a CLI/TUI tool: a new crate or port, persistence, a new dependency, a new target platform, distribution, `rust-version`, `unsafe`, a TCC permission. |
| `changing-gates` | Gate files without ESLint, tsconfig, Vitest, Prettier, `tauri.conf.json`, capabilities, or entitlements; xtask's harness checks added. |
| `writing-repo-scripts` | Automation as `cargo xtask` tasks: the failure contract, `GIT_*` isolation, fakes for child processes, fixture roots (design § D12). |
| `managing-dependencies` | Crates only; no npm, pnpm, or Tauri plugins. |
| `starting-an-app` | `cargo xtask bootstrap`; choosing CLI-only or CLI + TUI; deleting the sample; installing with `cargo install --path`; no design-lock or app-shape step. |
| `writing-rust` | Adds clap and ratatui idioms a newcomer meets; drops Tauri. |
| `tdd` | One language: core, then the subcommand or TUI layer, with `TestBackend` for a screen. |
| `writing-tests` | Rust only: CLI integration tests, `TestBackend` buffer assertions, key events as values; no Testing Library or `mockIPC`. |
| `placing-tests` | Where a CLI, TUI, or xtask test goes and which floor measures it; no `tauri::test` or Vitest projects. |
| `designing-core-logic` | Views shared by a subcommand's output and a TUI frame; no IPC boundary. |
| `designing-errors` | Variant to wording and exit code in the binary crate; `ERR_*` codes in xtask; no serialized codes for a UI. |
| `integrating-system-apis` | macOS and Linux adapters behind `cfg(target_os)`, each with its contract suite. |
| `running-the-app` | The smoke run and `just logs` as an agent's evidence; `myapp tui` only when the human asks (design § D22). |

## The skills (26)

### Repository workflow — ported, stack mechanics replaced

| Skill | From | What changes for this stack |
|---|---|---|
| `smart-commit` | M | Lockfiles bundle with their manifest (`Cargo.lock` with any `Cargo.toml`, `pnpm-lock.yaml` with `package.json`); `ui/src/ipc/generated/` commits with the Rust type that produced it; the sensitive-file list is the staged guard's. Brought under 200 lines (M's is 214; issue #166). |
| `create-pr` | M, T `release-impact` | Pre-check is `just check`; the PR body carries a Release impact line (T) and, for a `myapp-platform` change, `just test-local` output; the checklist is AGENTS.md's Review Checklist. |
| `triaging-issues` | M | Labels from this repo's `labels.yml`; `path:line` examples use crate and `ui/` paths. |
| `shipping-issues` | M (+ its Python scripts and tests) | Recipes and gates renamed; worktrees: each has its own `target/` (gigabytes, a cold build), so parallel worktrees default to at most two and the skill says why; the review step and merge flow unchanged. |
| `steering-the-roadmap` | M | Unchanged in substance. |
| `merging-dependency-prs` | M, T/I `merge-dependabot` (+ scripts) | Ecosystems: cargo, npm, github-actions (Dependabot), mise and rust-toolchain (Renovate). Tauri rule: the `tauri` crates and `@tauri-apps/*` npm packages move together at the same minor (a CI check fails on a mismatch); a Tauri major (v3) is a migration issue, never a batch merge. A crate whose `build.rs` or proc-macro changed is reviewed as code that runs at build time. |
| `authoring-skills` | M, I | Defines the #135 conventions and the 200-line cap check before any other skill is written; `just agents-sync` mirror rules; skill checks. |
| `updating-docs` | M, I | Surfaces: README, AGENTS.md, CONTRIBUTING, CHANGELOG, `docs/*.md`, a skill, a `///` rustdoc comment on a `pub` item in core, a TSDoc comment in `ui/src/ipc/`. |
| `recording-architecture-decisions` | M, I | ADR triggers translated: a new crate or port; the app shape (window, or menu-bar agent with `ActivationPolicy::Accessory` + tray); App Sandbox or an entitlement; persistence format and location; a new crate or npm dependency; a new Tauri plugin or capability; relaxing the CSP; distribution (notarization, an updater, a universal build); `minimumSystemVersion` or `rust-version`; a TCC permission; a second UI locale. |
| `changing-gates` | M, T, I | Gate files: `Cargo.toml` `[workspace.lints]`, `clippy.toml`, `rustfmt.toml`, `deny.toml`, `rust-toolchain.toml`, `mise.toml`, `lefthook.yml`, `eslint.config.*`, `tsconfig*.json`, `vitest.config.*`, `.prettierrc*`, `typos.toml`, `tauri.conf.json`'s `security` and `bundle.macOS`, `src-tauri/capabilities/`, `src-tauri/Entitlements.plist`, workflows, the ruleset. What weakening means in Rust and TS (design § D13). The #140 hook decision. Split to `references/` to stay under 200 lines (M's is 251). |
| `writing-repo-scripts` | T, I, M (failure contract) | TypeScript under `scripts/` run by Node type stripping; `GIT_*` isolation and the `GIT_INDEX_FILE` exception; `ERR_<STAGE>_<WHAT>` + Expected/Actual/Next; Vitest tests with fixtures and stubbed commands; refuse-or-skip outside a git work tree. |
| `managing-dependencies` | T, I | One skill for crates and npm packages: the review record a new dependency's PR carries; `default-features = false` and only the features used; `[workspace.dependencies]` as the one place a version is written; `cargo deny` licences and sources; pnpm's release age and build-script allow-list; Tauri plugins count as dependencies *and* capabilities. |
| `releasing-the-app` | new; M `docs/distribution.md`, M `release-prep`, T `release-impact` | `just release-prep`, the three version sites, CHANGELOG, the `workflow_dispatch` dry run, the tag a human pushes, signing and notarization secrets, Gatekeeper for an ad-hoc build, verifying the `.dmg`. |

### Writing code — rebuilt for Rust and Tauri

| Skill | From | Content |
|---|---|---|
| `writing-rust` | new; structure from T/I `writing-typescript`, rules from M `.claude/rules/swift.md` | The Rust a newcomer needs to change this codebase safely: ownership and borrowing as they show up here (clone a small value rather than fight a lifetime; `&str` in, `String` out); `Result` + `?` + a `thiserror` enum, never `unwrap`/`expect` outside tests; `Option`; enums with exhaustive `match`; modules and `pub(crate)`; traits as ports and `Send + Sync`; `serde` derives; reading the common compiler errors (E0382 use after move, E0502/E0499 borrow conflicts, E0277 missing trait) with the fix this codebase prefers; fixing a clippy finding rather than allowing it. Links The Rust Book and the clippy lint list; restates neither. |
| `writing-typescript` | T, I | Scoped to `ui/` and `scripts/`: narrowing `unknown`, `satisfies` vs `as`, exhaustive `switch` over a union, `import type` under `verbatimModuleSyntax`, generated types used as-is, never edited. |
| `tdd` | M | Red with `just test-fast <filter>` (`cargo nextest run -p myapp-core <filter>`), green with the minimum in core, refactor, then `just test` for both floors; the same loop for a `ui/` hook with Vitest. |
| `writing-tests` | T, I | Test bodies in both languages: name after behaviour; an oracle independent of the implementation; assert error variants and codes, not messages; the contract suite; an injected `FixedClock`, never `sleep`; `tempfile::TempDir` per test; Testing Library queries by role and accessible name; `mockIPC` with events. |
| `placing-tests` | T, I | Where a test goes: `#[cfg(test)] mod tests` beside core code vs `crates/*/tests/`; `myapp-test-support` for fakes and contracts; platform contract tests, and `#[ignore = "local machine: …"]` for the ones that need a human's Mac; `tauri::test` tests in `src-tauri`; Vitest projects for `ui/` and `scripts/`; which coverage floor covers it. |
| `designing-core-logic` | M, I `designing-application-core` | Time, randomness, environment, and I/O through ports (and the clippy bans that enforce it); one `Tuning` struct for tunables; state transitions as methods returning a new view or a typed error; a `…View` struct as the only thing that crosses IPC; no async in core; patterns deliberately not adopted. |
| `designing-errors` | M, T, I | A `thiserror` enum per core module or port; a serializable code for the UI (`#[serde(tag = "code")]`) and the wording in `ui/src/copy/`; adapters map `std::io::Error` and OS failures into core kinds; no user data in an error or a `tracing` field; no panic across a command; `anyhow` only in `main` of the CLI if at all; `ERR_*` codes in scripts. |
| `designing-ipc` | new; I `serving-the-api`, I `building-web-screens` (generated-client pattern) | Adding a command end to end: the core function, the thin `#[tauri::command]`, `spawn_blocking` for a slow port, `tauri::State` holding the app state, registering in `generate_handler!`, the `ts-rs` DTO and `just bindings`, the wrapper in `ui/src/ipc/commands.ts`, a `tauri::test` test. Events: a `pub const` name, the payload type, `ui/src/ipc/events.ts`. Capabilities when a plugin is added. The sidecar helper and when the GUI may spawn it. What is contract (command and event names, payload shapes). |
| `integrating-system-apis` | M (rewritten) | Calling macOS from `myapp-platform`: prefer a system command (`launchctl`, `plutil`, `defaults`) through `std::process::Command` with a fake behind the port; `objc2` framework bindings when there is no command; `unsafe` only here, each block with a `// SAFETY:` comment; TCC-gated APIs and the human hand-off; what can be tested where. Decisions plus linked, dated Apple and crate documentation (issue #176). |
| `running-the-app` | M | `just dev` (hot reload), `just run`, `just install-app`; smoke mode and `just logs` as an agent's default evidence (design § D22); confirming the running process is the fresh build; the WebView inspector in debug builds; the human hand-off when a check genuinely needs eyes on the window; the evidence a PR carries. |
| `building-react-screens` | M `building-swiftui-screens`, I `building-web-screens` | A component as a thin renderer over a hook that owns a Rust model (load through `ipc/commands.ts`, update from `ipc/events.ts`); loading, error, and empty states; accessible names on every control (issue #169), keyboard reachability, `prefers-reduced-motion`; only the design-system primitives and `var(--…)` tokens, never a literal value; strings from `ui/src/copy/`; verifying a screen with Testing Library, then `just run` only when the human wants to see it. |
| `designing-ui` | M, I | Apple's HIG applied inside a WebView: the system font stack and text styles as CSS tokens, light and dark with `prefers-color-scheme`, the system accent (`accent-color`), contrast checks, window sizing in `tauri.conf.json`, the app menu and keyboard shortcuts through Tauri's menu API, motion. Owns the base design system in `ui/src/design/` and `docs/design/design-system.md` (design § D23): what each token means, how an app replaces values without renaming roles, the literal check and the contrast test. The per-app design lock as an ADR (M) with I's ledger mechanics, researched with the `refero-design` skill when the session has it (optional, user-level) and with this skill's own research steps otherwise; no CSS framework unless an ADR adds one. |
| `starting-an-app` | M, T `bootstrapping-the-template` | `scripts/bootstrap.ts` flags and prompts, the placeholder list, re-running safely, `verify-bootstrap`; what to delete when replacing the sample (every deletable illustration listed); deciding the app's design system first, before any screen (design § D23: `refero-design` when available, else `designing-ui`; the design-lock ADR; replacing `tokens.css`); choosing the app shape (window, or menu-bar agent: `ActivationPolicy::Accessory`, the `tray-icon` feature, no Dock icon); the sandbox posture; the first ADRs; `just labels`, `just ruleset`, the GitHub settings; the roadmap (issue #172); private-repository steps (#113's decision). |

## Not carried over

| Skill | From | Why |
|---|---|---|
| `type-testing` | T, I | `ts-rs` output is checked by `tsc`, and `ui/` has no library surface whose types need compile-time assertions. |
| `public-api-contract` | T | No published package; the contract this template has is the IPC surface, covered by `designing-ipc`. |
| `bootstrapping-the-template` | T | Folded into `starting-an-app`. |
| `localizing-ui` | I | Localization is deferred (issue-triage #119); `building-react-screens` keeps strings in `ui/src/copy/`. |
| `authenticating-learners`, `isolating-learner-data`, `serving-the-api`, `writing-infrastructure`, `generating-cards`, `reviewing-cards`, `backfilling-card-fields` | I | About instant-composition's own product (a hosted web service); only the patterns noted above are borrowed. |

## Rules (`.claude/rules/`, Claude Code only)

| Rule | Loads for | Holds |
|---|---|---|
| `rust.md` | `crates/**/*.rs`, `src-tauri/**/*.rs` | The short always-on version of `writing-rust` and `designing-errors`: no `unwrap` outside tests, `pub(crate)` by default, `tracing` not `println!`, `unsafe` only in platform with `// SAFETY:`. |
| `typescript.md` | `ui/**/*.ts(x)`, `scripts/**/*.ts` | Only `ui/src/ipc/` imports `@tauri-apps/*`; generated files are never edited; strings live in `ui/src/copy/`. |
| `testing.md` | test files in either language | The issue #134 list, and where each kind of test goes. |
| `project.md` | manifests, lockfiles, gate configs | The dependency policy and the tool-pinning policy. |
| `docs.md` | `docs/**`, README, CONTRIBUTING, CHANGELOG | English; external claims with URL and checked date; no `#NNN` in standing docs. |

## Review

After the skills land, an independent review pass reads each ported skill beside its
sources and this page and reports anything dropped without a reason, any mechanic that
does not exist in this repository, and any unlinked external claim. Findings are fixed
before the skills PR merges.
