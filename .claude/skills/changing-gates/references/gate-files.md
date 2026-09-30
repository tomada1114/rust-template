# The gate files, one by one

The detail behind `changing-gates`' "The gate files". Each section says what the file
enforces, the trap met here, and what a change to it owes. Read the file itself for its
current values.

## `Cargo.toml` `[workspace.lints]`

- `[workspace.lints.rust]`: `unsafe_code = "forbid"` and `missing_docs = "warn"`.
  `[workspace.lints.clippy]`: the `all` and `pedantic` groups at warn with
  `priority = -1`, then `unwrap_used` and `expect_used`. The priority puts the groups
  first, so a single lint listed with them can override its group's level
  (https://doc.rust-lang.org/cargo/reference/manifest.html#the-lints-section).
- `just lint` runs clippy with `-D warnings`, so every warning is an error there. The
  level in this table is only what an editor shows.
- A crate receives these lints only through its own `[lints] workspace = true`. A new
  crate without that line compiles with no lint at all, silently: add it in the same
  change that adds the crate.
- Removing a lint or lowering its level is weakening a gate; adding one (a new clippy
  lint at warn) is routine, and fixes what it finds in the same pull request.

## `clippy.toml` and `crates/myapp-core/clippy.toml`

- The root file lets tests `unwrap` and `expect` (a panic is how a Rust test fails).
- Core's file adds the bans that keep I/O, time, the environment, processes, and sleeping
  behind ports (`disallowed-macros`, `disallowed-methods`, `disallowed-types`, each with a
  `reason` clippy prints).
- clippy uses the first `clippy.toml` it finds walking up from the crate's directory and
  merges nothing (https://doc.rust-lang.org/clippy/configuration.html, checked
  2026-09-29), so a crate-local file replaces the root one entirely. That is why core's
  file repeats the two test settings; a new crate-local file must do the same.
- Core also denies `clippy::wildcard_enum_match_arm` in its source, so a `match` on a
  core enum names every variant and a new variant is a compile error wherever a decision
  is owed.
- Core's ban list and `AGENTS.md`'s description of it change together. Adding a ban is
  the routine direction; removing one is weakening a gate.

## `rustfmt.toml`

Stable options only (`edition`, `max_width`), so `cargo fmt` behaves the same on every
toolchain in the pin; an unstable option would need a nightly toolchain the repository
does not pin. Changing an option reformats the whole tree: land the option and the
`just fmt` output in one commit, so the reformat is reviewable as one mechanical diff.

## `deny.toml` and `osv-scanner.toml`

- `[graph] targets = ["aarch64-apple-darwin"]` defines what ships. `Cargo.lock` lists
  every platform's dependencies, and Tauri's Linux stack carries advisories for code a
  macOS-only app never builds; the target selects the shipped graph and ignores nothing
  inside it.
- `[licenses] allow` and `.github/workflows/dependency-review.yml`'s `allow-licenses`
  hold the same permissive list (the workflow adds `BSD-2-Clause` and `ISC`, which npm
  packages use). A per-crate exception (`exceptions`, `allow-dependencies-licenses`)
  goes into both files with its reason.
- `[bans] deny` with `wrappers` says which crate may depend on `tauri` and on
  `myapp-platform` directly. It changes together with `AGENTS.md`'s boundary list and
  the closure check, and `just check-harness` fails when they differ. A Tauri plugin
  crate joins the `tauri` entry's rule (`managing-dependencies`).
- `[sources]` allows crates.io only. A git dependency is a new source: an ADR and a
  sign-off, never a quiet `allow-git` line.
- An advisory is fixed by updating. Only when no fixed release exists may it be
  ignored, with its reason, an `ignoreUntil` (OSV) or dated comment (`deny.toml`) at
  most 90 days out, and a tracking issue. An OSV ignore for a crate absent from
  `cargo tree --target aarch64-apple-darwin` needs only the reason and the expiry.

## `rust-toolchain.toml`, `mise.toml`, and `package.json`'s `packageManager`

Each tool is pinned exactly once: Rust in `rust-toolchain.toml` (rustup and mise both
read it), Node and every CLI tool in `mise.toml`, pnpm in `packageManager`. Never
`latest`, never a range, and prefer the prebuilt-binary backends over `cargo:`, which
compiles from source. Renovate opens the bumps for the first two after its 7-day minimum
release age; its `enabledManagers` in `.github/renovate.json` are `mise` and
`rust-toolchain` only, so it never touches `packageManager`, and `package.json` is
Dependabot's `npm` ecosystem (`.github/dependabot.yml`).

A bump of Rust, clippy, ESLint, typescript-eslint, or TypeScript can fire a finding
the old version did not. The fix goes into the code on that pull request; skipping the
bump or suppressing the finding is weakening a gate. A tool added to `mise.toml` that a
CI job needs is added to that job's `jdx/mise-action` `install_args` too: CI installs
only what each job names.

## `lefthook.yml`

- `skip: [merge, rebase]`: a merge or rebase replays commits that already passed.
- `parallel: true`: every job is check-only, so none depends on another's output. A
  job that wrote files would break that and would need ordering; that is one more
  reason jobs never write.
- The staged guard has no `glob`: it must see every staged path whatever its extension.
  Adding a glob narrows it without anything reporting the gap.
- `just verify-hooks` (`scripts/verify-hooks.ts`) fails at `just install` and
  `just check` time when the hook is not installed; `ALLOW_MISSING_GIT_HOOKS=1` is the
  one opt-out, and CI is skipped. Its test (`scripts/verify-hooks.test.ts`) pins that
  behaviour.

## `eslint.config.mjs`

- The IPC boundary keeps `@tauri-apps/*` and `ui/src/ipc/generated/` inside
  `ui/src/ipc/`, `ui/src/ipc/testing.ts` inside tests and `ui/src/test/`, and, inside
  `ui/src/ipc/`, `@tauri-apps/api/mocks` inside `testing.ts` and tests. Each
  boundary object feeds two rules through `importBoundaries()`: `no-restricted-imports`
  (import and export declarations) and `no-restricted-syntax` (a dynamic `import()`,
  which that rule never sees; a computed `import()` specifier is refused outright).
  The `ui/react`, `ui/ipc-boundary`, `ui/ipc-testing`, `ui/tests`, and `ui/ipc-tests`
  blocks each pass
  their full set. A later config object that gives a rule options **replaces** the
  earlier options rather than merging them
  (https://eslint.org/docs/latest/use/configure/rules, checked 2026-09-29), so a new
  block that sets either rule for other files silently drops every boundary there
  unless it calls `importBoundaries()` with the full set.
- `no-console` is an error except in `ui/src/ipc/log.ts` and `scripts/`, and
  `no-restricted-properties` refuses `window.console`, `globalThis.console`, and
  `self.console` wherever `no-console` applies.
- `switch-exhaustiveness-check` sets `considerDefaultExhaustiveForUnions` and
  `allowDefaultCaseForExhaustiveSwitch` to `false`: a `switch` over a union names every
  member and has no `default`.
- `scripts/typescript-gates.test.ts` probes each of these, and `erasableSyntaxOnly` in
  `tsconfig.json` and `ui/tsconfig.json`, against the real configs (`just test-scripts`).
- `linterOptions.reportUnusedDisableDirectives: "error"` makes a stale disable comment
  fail.
- `eslintConfigPrettier` stays the last element; anywhere else it stops turning off the
  stylistic rules that would fight Prettier, and the two tools disagree about one file.
- A new block gets a `name`: that is how a reader and ESLint's config inspector find it.

## `tsconfig.json`, `ui/tsconfig.json`, `scripts/tsconfig.json`

Three configs, one per tree: the root config files, the UI Vite bundles, and the
scripts Node runs by type stripping. `pnpm typecheck` (inside `just lint`) checks all
three. `scripts/tsconfig.json`'s `erasableSyntaxOnly` is load-bearing: Node strips types
without transforming code, so `enum`, `namespace`, and parameter properties would fail at
run time, not at type-check time. `ui/tsconfig.json` and the root `tsconfig.json` set it
too, so `ui/src/` and the root config files keep the same language. Removing a strict option (`strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …) weakens checking for every
file in that tree.

## `vitest.config.ts`

- `thresholds` are per glob (`ui/src/**` 80/80, `scripts/**` 85/90,
  `.agents/skills/*/scripts/**` 85/90, `scripts/lib/guard/**` 90/100) so one tree
  cannot subsidise another.
- `coverage.include` counts every source file, tested or not, so a new untested file
  shows as 0% rather than disappearing. Each `exclude` entry that takes source code out
  carries a reason; a new one is weakening unless the file holds nothing to decide
  (generated code, an entry point).
- `allowOnly: false` fails a focused test; the mock-restoring options keep a stub from
  outliving its test.
- A project inherits those shared options from the root config: `extends: true` is the
  default since Vitest 5.0 (https://vitest.dev/guide/projects, checked 2026-09-29), and
  the config writes it anyway so the inheritance is visible. A project with
  `extends: false` drops them silently.

## `.prettierrc.json`, `.prettierignore`, `typos.toml`

A formatting option reformats the tree (land it with `just fmt`). An ignore entry takes
a path out of the gate for good; the lists exclude build output, lockfiles, fixtures,
and the generated `.claude/skills/` mirror, and `just check-harness` keeps them agreeing
on that mirror.

## `tauri.conf.json`, `src-tauri/capabilities/`, `src-tauri/Entitlements.plist`

- `app.security.csp`, `app.withGlobalTauri: false`, and the one capability granting
  `core:default` are the WebView's security posture. App commands need no capability;
  a plugin's commands do.
- `bundle.macOS` holds `minimumSystemVersion`, `hardenedRuntime`, `signingIdentity`
  (`"-"`, ad hoc), and `entitlements`. `Entitlements.plist` ships empty.
- Every one of these is a sign-off change (`AGENTS.md` › "Security and human
  approval") and an ADR trigger. `.claude/settings.json` denies Claude Code an edit to
  `Entitlements.plist`; that binds one tool, and the rule binds every author.
- After a change, `just build` then `just smoke`: the smoke checks the signature, that
  the bundle's entitlements equal the file, and that the app still starts.

## The `justfile` recipes that are gates

`test-core` carries the core floor flags, `lint` runs clippy with `-D warnings`, and
`check` lists the local gate. The building recipes unset every `APPLE_*` variable
(`no_signing`) so a local build never signs as a developer. Recipe names are contract
for `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, the skills, and `.claude/settings.json`,
all of which `just check-harness` reads.

## `.github/workflows/*.yml`

What every workflow follows, checked by `actionlint`, `zizmor`, and `just check-harness`:

- every remote `uses:` pinned to a full commit SHA with a `# vX.Y.Z` comment;
- a top-level `permissions:` of at most `contents: read`, and each job's own
  least-privilege block; widening one, or adding a workflow that writes, needs sign-off;
- `timeout-minutes` on every job, `persist-credentials: false` on every checkout;
- `concurrency` that cancels a superseded pull-request run but never a push to `main`,
  which is the only CI record a merged commit gets;
- no `pull_request_target` (it runs fork code with a writable token);
- a fail-closed shell (`defaults.run.shell` with `-euo pipefail`), so a failure before
  a `|` or an unset variable stops the step instead of passing it, and `--locked` /
  `--frozen-lockfile` on every cargo and pnpm install, so a lockfile drift fails
  instead of resolving silently;
- no Rust build cache on the release path, where a poisoned cache would reach a shipped
  binary.

A new workflow file is warranted only by a different trigger or a separate permission
footprint; otherwise the step joins a job in `ci.yml`. A pull request that deletes or
narrows a security-relevant step says why the protection no longer applies.

## `.github/rulesets/main.json`

Each required context is a job `name:` in a `pull_request` workflow that runs on every
pull request, and `just check-harness` fails when one names no job, or only a job whose
workflow filters `paths` or `branches` or whose `if:` (or a `needs` job's) can be false on
a pull request: such a check never reports, or is skipped and passes unrun. Renaming or
splitting a required job, or adding one, edits this file in the same pull request; `just
ruleset` then applies it to the live repository, which is a human's step. A new job is not
required until the owner decides it is: adding one never adds its context here on its own.
`bypass_actors` stays empty: a bypass lets an admin token merge without the checks the
ruleset exists to require.
