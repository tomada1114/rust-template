# Skills plan

<!-- template-only: cargo xtask bootstrap removes docs/template/ from a generated app. -->

The finalized [design.md](design.md) uses 23 repository skills. Their authored source
is `.agents/skills/`; `just agents-sync` generates the byte-for-byte
`.claude/skills/` mirror. The Skills table in `AGENTS.md` owns when to load each.

## Authoring conventions

`authoring-skills` owns frontmatter, size, cross-reference markers, deletable
illustrations, platform documentation links, and the mirror. A skill records this
repository's decisions and mechanics with their reasons. Commands and paths must
exist; external claims carry their source and checked date. No skill tells an agent
to take over the developer's machine or terminal.

## Skill set

| Skill | Scope |
|---|---|
| `authoring-skills` | Authoring conventions and generated mirror. |
| `smart-commit` | Conventional Commits and normal commit hooks. |
| `create-pr` | PR title, body, release impact, and validation evidence. |
| `triaging-issues` | Issue types, priorities, blocked states, and tracking. |
| `shipping-issues` | Ranked issue implementation and verified landing. |
| `steering-the-roadmap` | Now, Next, and Later in the app's roadmap. |
| `merging-dependency-prs` | Dependency updates and isolated terminal-framework migrations. |
| `updating-docs` | Which maintained document a change owes. |
| `recording-architecture-decisions` | Proposed app ADRs and their index. |
| `changing-gates` | Gate configurations, protected changes, and enforcement evidence. |
| `writing-repo-scripts` | Rust tasks and skill scripts with fakes and temporary fixtures. |
| `managing-dependencies` | Crate review, features, licences, and human sign-off. |
| `starting-an-app` | Bootstrap, Product, the tool's shape, and replacing the sample. |
| `writing-rust` | Rust conventions, ownership, typed errors, clap, and ratatui. |
| `tdd` | Red-green-refactor in the layer that owns the behavior. |
| `writing-tests` | Independent oracles, fakes, contracts, and deterministic inputs. |
| `placing-tests` | Test location and the gate that measures it. |
| `designing-core-logic` | Ports, transitions, tuning, views, and screen state. |
| `designing-clis` | Subcommands, arguments, output streams, wording, and exit codes. |
| `building-tuis` | Screen state in core, rendering, keys, and terminal restoration. |
| `designing-errors` | Typed variants, binary wording, exit codes, and task failures. |
| `integrating-system-apis` | macOS and Linux adapters behind ports and target configuration. |
| `running-the-app` | Tests, scratch command runs, logs, and human terminal evidence. |

## Claude-specific rules

The four rules under `.claude/rules/` cover Rust source, tests, project
configurations, and documentation. Named Claude sub-agent definitions remain under
`.claude/agents/`; Codex follows the repository's applicable workflow in its own
execution surface. Rules and agent definitions are not mirrored.

## Verification

A skill change runs `just agents-sync`, `just agents-check`, and
`just check-harness`; a bundled script also runs `just test-scripts`.
The full project gate remains required before opening a PR. Review checks that the
mechanics exist and that every rule has a reason and a single owner.
