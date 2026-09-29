# Triage of macos-app-template's open issues

<!-- template-only: scripts/bootstrap removes docs/template/ from a generated app. -->

Source: every open issue in `tomada1114/macos-app-template`, read on 2026-09-28 with
`gh issue list --state open` and `gh issue view` (16 issues). #96 points at
`tomada1114/instant-composition`; the parts of that repository the issues cite
(`tests/workflows.test.ts`, `.github/workflows/security-audit.yml`,
`scripts/label-pr.mjs`, the `localizing-ui` and `writing-tests` skills) were read too.
Nothing was written to either repository.

Buckets:

- **(a) In from day one, in the improved form** — tauri-template starts where the issue
  would leave macos-app-template, translated to Rust + Tauri.
- **(b) Out: Swift / Xcode specific** — the problem does not exist in this stack.
- **(c) Deferred** — a real question here too, deliberately not in the first version.

| # | Title (short) | Bucket | What tauri-template does, and why |
|---|---|---|---|
| 96 | Back-port instant-composition's harness improvements (tracking) | (a) | The tracking issue itself does not port; its content does. The "already ahead" list (CodeQL, Scorecard, zizmor, OSV, release workflow, bootstrap smoke, ruleset as code, Renovate for `mise.toml`, dependency review with a license allow-list, CHANGELOG + release-prep, harness checks runnable against a fixture, concurrent script tests, the refusal of a symlinked skills mirror, the skip model for real-OS adapter tests) is the starting baseline. The owner decisions recorded on its closed children are inherited as settled: the pre-commit hook stays lint-only (#140), skills live in-repo with no committed plugin marketplace (#142), a private repository is handled by documentation rather than `if:` guards (#113), the executor/architect/worker agent tiers ship in `.claude/agents/` (#104). |
| 97 | Ad-hoc re-sign strips entitlements (P1) | (a) | Tauri signs the bundle itself (`bundle.macOS.signingIdentity`, `"-"` for ad-hoc) with `bundle.macOS.entitlements`; the release workflow never re-signs by hand. The lesson carries over as a check: the release job runs `codesign -d --entitlements - <app>` and `codesign --verify --deep --strict` on the built `.app` and fails unless the entitlements it expects are present. `docs/distribution.md` describes the ad-hoc and the Developer ID paths separately. |
| 109 | Stale claims about what the harness checks | (a) | Prevented by construction: prose never enumerates the checks. AGENTS.md's enforcement table points at the check directory, and each check's own header states what it asserts. A harness check refuses a reference in AGENTS.md or a skill to a `#NNN` issue number (issue numbers belong in the tracker and in commit messages, not in standing documentation). |
| 119 | String Catalog localization | (b) + (c) | String Catalogs are Xcode-only (b). Localizing a web UI is deferred (c): the first app is personal and single-language, and an i18n library is a dependency with no user yet. What ships instead is the seam that makes adding it cheap: Rust returns data and typed error codes, never user-facing sentences, and every user-facing string in the UI lives under `ui/src/copy/`. Adding a second locale is an ADR decision. |
| 126 | Label PRs from a tested script | (a) | `scripts/label-pr.ts` maps every Conventional Commits type the title check accepts (including `!`), removes a stale type label, never creates a label, and has a Vitest test. The workflow runs it from the base SHA. |
| 129 | Workflow hygiene checks | (a) | Implemented as harness checks that parse YAML with a real parser (the `yaml` package), not a line-based reader — instant-composition's hand-written reader needed ~60 edge-case tests for aliases, flow sequences, and key columns. Checked from day one: SHA pins with a `# vX.Y.Z` comment, job-level `timeout-minutes`, job-level `permissions` and a top-level default of at most `contents: read`, `persist-credentials: false` on checkout, `concurrency` on pull-request workflows that never cancels a `push` run on `main` (#108), no `pull_request_target`, fail-closed `run:` shells, `--frozen-lockfile`/`--locked` installs, bot commit prefixes inside the PR-title types, and Dependabot's cooldown agreeing with Renovate's and pnpm's. |
| 133 | Function-coverage floor | (a) | `cargo llvm-cov` gates the Rust core with `--fail-under-lines` and `--fail-under-functions` from the start; Vitest gates the UI's non-view modules with per-glob `lines` and `functions` thresholds (the typescript-template pattern, so one tree cannot subsidize another). |
| 134 | Testing and language rule extensions | (a) | The Rust and TS equivalents go into `.claude/rules/testing.md`, `.claude/rules/rust.md`, and the `writing-tests` skill: an oracle independent of the implementation, one contract suite shared by fake and real adapter (#141), an injected clock instead of sleeps, a temporary directory per test, exhaustive `match` on core enums (enforced by `clippy::wildcard_enum_match_arm` in core), `pub(crate)` for cross-module internals, and where a test belongs (unit, contract, local-machine, E2E). The Swift-only parts (`@testable import`, `package` access, `LaunchUITests`) have no counterpart. |
| 135 | Skill markers, deletable illustrations, platform-skill scope | (a) | `authoring-skills` defines them before the first skill is written, so no skill needs retrofitting. |
| 138 | Weekly full-history gitleaks scan | (a) | A scheduled job runs gitleaks, pinned in `mise.toml` (so Renovate bumps it and no third-party action or organization licence is involved), over full history with `permissions: contents: read`. |
| 139 | Lint the authored skills only, not the mirror | (a) | `typos`, `shellcheck`, ESLint, and Prettier exclude `.claude/skills/`; `just agents-check` alone covers the mirror. A harness test asserts every tool's ignore list agrees (typescript-template's `tooling-ignores.test.ts`). |
| 141 | One port contract suite against fake and real adapter | (a) | A `*-test-support` crate holds each port's fake and a contract function generic over the port's trait. Core's tests run the contract against the fake on Linux; the platform crate's tests run it against the real adapter on macOS, and those needing a logged-in session or a TCC grant are `#[ignore]`d and run by `just test-local`. |
| 166 | Keep SKILL.md under 200 body lines | (a) | Enforced from day one by a harness check, since there is no existing skill to grandfather. |
| 169 | Glyph-only buttons lack accessibility labels | (a) | The sample UI gives every icon-only control an `aria-label`. Component tests query by role and accessible name (`getByRole('button', { name: 'Increment' })`), so an unlabeled control fails a test. An a11y lint plugin is added only if one supports the pinned ESLint major (`eslint-plugin-jsx-a11y` 6.10.2 declares ESLint ≤ 9 as of 2026-09-28). |
| 172 | Bootstrap points at the roadmap skeleton | (a) | The bootstrap's "next steps" and README's "Using this template" both name `docs/architecture/roadmap.md` and `steering-the-roadmap`. |
| 176 | integrating-system-apis under the platform-skill convention | (a) | The Swift skill does not port (b), but the convention does: the Rust counterpart (calling macOS APIs from the platform crate) is written from the start as decisions plus linked, dated Apple and crate documentation. |

## Proposed back-ports to macos-app-template (proposal only, not filed)

Found while designing this template. Nothing was filed or commented; the owner decides.

- A harness check that refuses `#NNN` issue references in standing documentation (the
  #109 class of drift).
- Parsing workflows with a real YAML parser instead of `grep`, if #129 grows.
