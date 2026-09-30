---
name: changing-gates
description: >
  Covers editing a file that enforces rather than implements: Cargo.toml's
  [workspace.lints], clippy.toml and crates/myapp-core/clippy.toml, rustfmt.toml,
  deny.toml, osv-scanner.toml, rust-toolchain.toml, mise.toml, lefthook.yml,
  scripts/check-staged.ts and scripts/lib/guard/, eslint.config.mjs, tsconfig*.json,
  vitest.config.ts thresholds, .prettierrc.json and .prettierignore, typos.toml,
  tauri.conf.json's security and bundle.macOS, src-tauri/capabilities/,
  src-tauri/Entitlements.plist, the test-core recipe's floors, .github/workflows/*.yml,
  and .github/rulesets/main.json. Use when a lint, a ban, a floor, a pin, an ignore
  list, a pre-commit job, a CI job or step, or a required check is added, raised,
  loosened, or removed; when tempted by #[allow], #[expect], #[ignore], eslint-disable,
  @ts-expect-error, continue-on-error, or --no-verify to get a check green; or when
  asking which gate would have caught a change, including what none of them sees.
---

# Changing Gates

**Owns:** a change to a file that enforces rather than implements (the list above),
what weakening a gate means in Rust and TypeScript here, and which gate can see a given
change at all. **Does not own:** adding a crate or npm package the config then governs
(`managing-dependencies`); how a script under `scripts/` is written
(`writing-repo-scripts`); where a test goes and which coverage floor covers it
(`placing-tests`); landing a bot's version bump (`merging-dependency-prs`); the label
set (`triaging-issues`); a Tauri capability as part of adding a plugin
(`designing-ipc`); lifting `unsafe_code = "forbid"` (`integrating-system-apis`).

Never weaken a gate to make a check pass. That rule, and the list of what counts, live
in `AGENTS.md` › "Security and human approval"; this skill neither restates nor relaxes
it. A change that lowers, disables, narrows, or widens a gate needs a human's sign-off,
and its pull request says which rule or option moved, why the removed protection no
longer applies, and what now passes (or newly fails) that did not before. Raising a
gate (a new ban, a higher floor, a narrower permission) is the routine direction, and
still says the same three things.

**REQUIRED:** [references/weakening.md](references/weakening.md) before reaching for any
suppression: what each form of weakening does in Rust and TypeScript, why it is caught
by nothing but review, and the fix that is not a suppression.

## The one rule every gate change shares

A gate calls the same command every other layer calls; it never defines a rule of its
own. The `justfile` is the one definition of each check: `just check` runs the local
set (verify-hooks, fmt, lint, lint-repo, agents-check, test-scripts, check-harness, test, test-macos, build,
smoke), CI's jobs run the same recipes or the same `cargo` and `pnpm` commands as
separate steps so a reader sees which step failed, and each `lefthook.yml` job runs
the same executable and flags as its recipe, narrowed to the staged files. A check that
lives in only one layer passes there and fails in the others, or the reverse.

So a new check is several edits, not one:

1. the tool's config, or a script under `scripts/` with its test;
2. the recipe that runs it, and its place in `just check`;
3. the matching `ci.yml` step (`just check-harness` fails while `just check` and CI's
   steps differ outside a reasoned exception list);
4. the pre-commit job, only when it is fast, check-only, and judged on staged files;
5. its row in `AGENTS.md` › "Enforcement layers", and a "Validating a change" row when
   it becomes the narrowest check for some kind of change (`updating-docs`).

## The gate files

Each file holds its own current values: read it rather than a copy of a rule written
elsewhere, including this skill. Detail, traps, and the judgment each needs are in
[references/gate-files.md](references/gate-files.md); in short:

- **Rust lints**: `[workspace.lints]` in the root `Cargo.toml` reaches a crate only
  through that crate's `[lints] workspace = true`, so a new crate without it compiles
  with no lints at all. A crate-local `clippy.toml` replaces the root one entirely, so
  core's repeats the root's two settings.
- **Core's bans** (`crates/myapp-core/clippy.toml`) and core's forbidden-crate lists
  (`deny.toml`'s `wrappers`, the closure check, `AGENTS.md`) change together; adding a
  ban strengthens, removing one weakens.
- **rustfmt and Prettier**: an option change reformats the tree; land the option and
  the `just fmt` result in one commit.
- **Supply chain**: `deny.toml`'s licence allow-list and `dependency-review.yml`'s
  `allow-licenses` agree (the workflow adds two licences npm packages use), a per-crate
  exception goes in both, and an advisory ignore in
  `deny.toml` or `osv-scanner.toml` carries a reason, a 90-day expiry, and, for a
  shipped crate, a tracking issue.
- **Pins**: `rust-toolchain.toml` and `mise.toml` are bumped by Renovate; a bump that
  fires a new lint is fixed in code on that pull request.
- **Coverage floors**: the `test-core` recipe's `--fail-under-*` flags and
  `vitest.config.ts`'s per-glob `thresholds` are the only places a floor is written;
  a new way to set one from an environment variable, a flag, or a workflow is lowering
  it by another route.
- **The app's security posture**: `tauri.conf.json`'s `security` and `bundle.macOS`,
  `src-tauri/capabilities/`, and `src-tauri/Entitlements.plist` are sign-off changes
  and ADR triggers; `just build` then `just smoke` prove the bundle still carries what
  the files say.
- **Workflows and the ruleset**: SHA pins, least-privilege `permissions`, timeouts,
  `persist-credentials: false`, and a job `name:` that is a required context in
  `.github/rulesets/main.json`. Renaming a required job leaves every pull request
  waiting for a check that never reports.

## The pre-commit hook stays check-only and fast

Enforced by: `lefthook.yml` (no job writes a file). It runs `rustfmt --check`,
`prettier --check`, `eslint`, and `typos` on the staged files, the skills-mirror check
when a skill path is staged, and the staged guard on every commit. It never compiles,
runs clippy or a test, or formats and re-stages. That is a decision, not an omission:

- A Rust compile takes far longer than a commit should, and it builds the working tree,
  not the staged blobs, so it would judge something other than the commit.
- Formatting and re-staging rewrites a partly staged file behind its author's back;
  formatting is `just fmt`'s job and, for an agent, the `PostToolUse` hook's.
- A slow or noisy hook teaches `git commit --no-verify`, which skips the staged secret
  guard along with everything else, and no CI job reruns that guard.

`just check` and CI run everything the hook leaves out. Do not reopen this without a
new reason those three costs miss. A new job must never fire on an intended, clean
commit: try it against an ordinary commit before trusting it to catch a bad one.

## The staged guard

`scripts/check-staged.ts` judges each staged path with `scripts/lib/guard/paths.ts`,
then, only if the path passes, the staged blob with `scripts/lib/guard/credentials.ts`.
It names the path and the rule, never the matched text, and never inspects a staged
deletion (a deletion cannot add a secret, and blocking one would block the commit that
removes a secret). A new pattern starts from a real false negative and lands with a
test case whose secret-shaped value is assembled at runtime, so no committed file,
including the test, is itself secret-shaped. Removing a pattern is weakening a gate.
What the guard deliberately does not block, and why (a public certificate, a `.key`
that may be a Keynote document, a bare `.envrc`), is listed in `paths.ts`'s header; no
entropy heuristic, since whether a commit *should* contain what it contains stays in
review. `paths.ts`'s list and `AGENTS.md`'s never-read list change together. Enforced by:
`vitest.config.ts` "scripts/lib/guard/**" (lines 90, functions 100).

## What no gate here sees

`AGENTS.md` › "Enforcement layers" names the gaps and the reasons they stay open: a
UI-to-Rust wiring mistake only the running app shows, the `#[ignore]`d tests only a
human runs, `--no-verify` and the hook's other bypasses, a ruleset that may not be
applied, and a new recipe that takes over the Mac. Add to that list the release path:
`release.yml` runs only on a tag or a manual dispatch, so a change to it is proven by
its `dry_run` (`releasing-the-app`), never by a pull request's checks. A gate proposed to close any gap is a real gate
change and belongs in its pull request as one, with its "Enforcement layers" row
updated or removed.

## Checking a gate change

Run the check the gate feeds, then the harness, then everything:

```bash
just lint            # a lint, format, or tsconfig change
just test            # a floor or a vitest.config.ts change
just test-scripts    # lefthook.yml, the guard, or a script a gate runs
just deny            # deny.toml
just check-harness   # workflows, the ruleset, recipes, cooldowns, ignore lists
just check
```

A workflow change also runs `mise exec -- actionlint` and `mise exec -- zizmor .`.
