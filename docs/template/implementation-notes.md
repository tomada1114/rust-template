# Implementation notes

<!-- template-only: scripts/bootstrap removes docs/template/ from a generated app. -->

What the first implementation run did differently from [design.md](design.md), and the
decisions it made that the design left open. Design decisions are never edited to match
what was built; each entry says what the design said, what was done, and why.

## Deviations

- **Tauri 2.11, not 2.12.** § 2 lists `tauri` 2.12.0 and `@tauri-apps/*` 2.12.0
  (published 2026-09-26). The repository's own 7-day release-age policy
  (`pnpm-workspace.yaml` `minimumReleaseAge`, design D8/D17) refuses a version that
  young, and the crate and npm minors must agree (a harness check). So the first run
  pins `tauri` 2.11.6 / `tauri-build` 2.6.3 in `Cargo.lock` (manifest `tauri = "2"`) and
  `@tauri-apps/api` ~2.11.1 / `@tauri-apps/cli` ~2.11.5. Dependabot brings 2.12 once it
  matures, as one grouped PR.
- **Other versions below § 2's list for the same reason:** vite 8.3.0, vitest 5.0.1,
  typescript-eslint 8.70.x, prettier 3.9.8, smol-toml 1.8.0 — each the newest release
  older than seven days on 2026-09-28. In `Cargo.lock` the whole Tauri family is held on
  the 2.11 line the same way (`tauri-runtime-wry` 2.11.4, `tauri-runtime` 2.11.3,
  `tauri-macros`/`tauri-codegen` 2.6.3, `tauri-utils` 2.9.3, `tao` 0.35.3, `wry` 0.55.1),
  because `tauri = "2"` otherwise resolves those to their 2026-09-26 releases.

- **Live labels are a superset of `labels.yml`.** After `just labels`, all 16 declared
  labels exist on the repository, and GitHub's defaults (`accessibility`, `duplicate`,
  `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`) remain beside them:
  the sync never deletes a label the manifest does not mention (as in both reference
  repositories), and deleting labels is outside the run's GitHub authority.

- **`just check` runs two more gates than D10 lists:** `lint-repo` (typos over the whole
  tree and actionlint) and `agents-check` (the skills mirror), placed after `lint`. CI
  already ran all three; running them locally too shrinks `just-check-matches-ci`'s
  exception list to what genuinely cannot run offline (cargo deny, zizmor's online audits)
  or has no local meaning.
- CI's `Repo Lint & Harness` job runs `cargo fetch --locked` before the script tests: the
  `core-boundary` check reads `cargo metadata --offline`, which needs the registry.
- `core-boundary` spawns `cargo metadata` with its own runner and a 256 MiB buffer:
  `scripts/lib/script.ts`'s `runCommand` keeps spawnSync's 1 MiB default, and the
  workspace's metadata is about 2.3 MB.

## Decisions made during the run

- **pnpm reaches `PATH` through mise.** Node 25 stopped bundling corepack, so
  `mise.toml` pins pnpm (`aqua:pnpm/pnpm`, a prebuilt binary) and CI installs it through
  `jdx/mise-action`'s `install_args`. `package.json` keeps `packageManager`, which pnpm
  itself reads, so pnpm is pinned twice — the one exception to D9 — and Renovate bumps
  both in one grouped pull request. (A harness check compared the two until the harness
  moved to `cargo xtask check-harness`, which reads no Node-only pin.)
- **`trustPolicyExclude: semver@6.3.1`.** `eslint-plugin-react-hooks` 7 (required by
  D8) depends on `@babel/core`, which depends on `semver@6.3.1`, published before npm
  provenance existed; pnpm's `trustPolicy: no-downgrade` reads that as a downgrade from
  semver 7's attested releases. The exclusion names the exact version, so any other
  semver release is still checked. Dev-only lint path; nothing ships in the app.

- **Prettier leaves Markdown alone** (`*.md` in `.prettierignore`). The design documents
  are hand-wrapped at ~90 columns with compact tables; Prettier would re-pad every table.
  Markdown is still spell-checked (typos) and link-checked. No hand-written logic is
  excluded.
- **`checkJs` is off in the root `tsconfig.json`.** It covers only the root config files;
  `eslint.config.mjs` is still linted with type information, but type-checking it fails
  on `eslint-plugin-react-hooks` 7.1's published types, which do not match ESLint 10's
  `Plugin` type. The TypeScript config files (`vite.config.ts`, `vitest.config.ts`) are
  type-checked.
- **Test-only IPC helpers live in `ui/src/ipc/testing.ts`**, so the rule "only
  `ui/src/ipc/` imports `@tauri-apps/*`" holds for tests too, with no lint exception.
  `rejectWith()` there returns a promise rejected with Rust's plain `{ code }` object,
  the shape Tauri really delivers, without a lint suppression.
- **Native controls follow the system accent (`accent-color: auto`); `--color-accent` is
  fixed.** A user-chosen accent cannot be contrast-checked, so custom components use the
  fixed token (D23's "the user's accent color through `accent-color` and an accent token").

- **MPL-2.0 per crate, not globally.** Tauri's own dependency graph reaches five MPL-2.0
  crates (`cssparser`, `cssparser-macros`, `dtoa-short`, `selectors` through
  tauri-utils' HTML handling; `option-ext` through `dirs`). `deny.toml` allows MPL-2.0
  only for those five (`[licenses] exceptions`), and `dependency-review.yml` lists the
  same five in `allow-dependencies-licenses`. Everything else must be permissive.
- **No cargo-deny advisory is ignored.** With `[graph] targets = ["aarch64-apple-darwin"]`
  and `unmaintained = "workspace"`, `cargo deny check` passes with an empty `ignore` list.
- **OSV-Scanner ignores (`osv-scanner.toml`, all expiring 2026-12-27):**
  - GHSA-wrw7-89jp-8q8g (`glib`, alias RUSTSEC-2024-0429, ignored under its GHSA id
    only, since OSV matches that first and reports the RUSTSEC entry as unused) and
    RUSTSEC-2024-0370 (`proc-macro-error`): Linux-only crates of Tauri's GTK stack,
    absent from `cargo tree --target aarch64-apple-darwin`. `dependency-review.yml`'s
    `allow-ghsas` lists the same GHSA ids, and
    `xtask/src/check_harness/advisory_ignores_agree.rs` fails when the two diverge.
  - RUSTSEC-2025-0075, -0080, -0081, -0098, -0100 (`unic-*`): shipped through
    `tauri-utils` → `urlpattern`, unmaintained, no fixed release; tracked in
    https://github.com/tomada1114/tauri-template/issues/3.
- **`shellcheck` is pinned in `mise.toml`**: actionlint runs it over every workflow
  `run:` block, and an unpinned shim broke actionlint; `just test-scripts` also runs it
  over the `shipping-issues` skill's `.sh` scripts.
- **Actions pinned one release back where the newest was under seven days old**
  (`github/codeql-action` v4.38.1), matching Dependabot's cooldown.
- **`serde` removed from the Tauri crate** — `cargo shear` found it unused.

- Template-only blocks in standing docs are marked `<!-- template-only -->` …
  `<!-- /template-only -->` (D19 names the blocks, not their syntax); the bootstrap
  removes exactly this pair.
- `docs/distribution.md` names the Apple ID trio (`APPLE_ID`, `APPLE_PASSWORD`,
  `APPLE_TEAM_ID`) as the notarization secrets (D18 names none); `release.yml` follows it.
- `.claude/settings.json` denies `Edit(/src-tauri/Entitlements.plist)` only: an `Edit`
  rule covers every built-in file-editing tool, and a `Write(path)` rule is never consulted
  (Claude Code permissions docs, https://code.claude.com/docs/en/permissions, checked
  2026-09-28). 2026-10-01: the committed settings file was removed (design.md D20); the
  same single `Edit` deny is what a personal `.claude/settings.local.json` carries.

- The sample builds no menu: it shows the default macOS menu Tauri installs when an app
  sets none (`designing-ui` has the source). An app that adds one builds it in Rust in
  the shell's setup (`src-tauri/src/lib.rs`), not with the JavaScript menu API: menus
  are app-wide wiring owned by the composition root, only `ui/src/ipc/` may import
  `@tauri-apps/*`, and a menu item calls the same core function as the matching command
  and emits the same event (`designing-ui`, `designing-ipc`).
- `scripts/release-prep.ts` reads each version site with a real parser (smol-toml,
  `JSON.parse`) but edits it with a one-line textual replacement, so the file keeps its
  comments and formatting; the edited text is parsed again and the run stops with
  `ERR_RELEASE_REWRITE`, writing nothing, if it does not hold the new version.

## Facts confirmed during the run

- clippy reads `crates/myapp-core/clippy.toml`: a temporary `println!` and a temporary
  `std::time::SystemTime::now()` in core each failed `cargo clippy -p myapp-core -- -D
  warnings` (`disallowed_macros`, `disallowed_methods`), so D3's clippy layer stands and
  no source-scanning fallback was needed. `disallowed-macros` catches `std::println` in
  edition 2024.
- ts-rs 12.0.1 honours `TS_RS_EXPORT_DIR` from `.cargo/config.toml` (bindings land in
  `ui/src/ipc/generated/`) and `TS_RS_LARGE_INT = "number"` (no `bigint` in the output).
- Tauri 2.11 has `App::set_activation_policy` and `ActivationPolicy::Prohibited` on
  macOS. Its CLI exports `TAURI_ENV_TARGET_TRIPLE` to `beforeBuildCommand`, and
  `TAURI_ENV_DEBUG=true` only for a debug build — a release build leaves it unset
  (observed by a before-command that dumped its environment). `scripts/build-sidecar.ts`
  therefore builds the helper for release when the triple is set and `DEBUG` is not.
- Smoke mode keeps focus on this Mac: during a `just smoke` launch, `lsappinfo front`
  sampled every 100 ms returned a single application (the one already in front), and
  across a full smoke build every frontmost application was one the owner was using —
  MyApp never came to the front and no window appeared. `ActivationPolicy::Prohibited`
  holds, so the `Accessory` fallback was not needed.
- `unsafe_code = "forbid"` holds in the Tauri crate: `generate_handler!`,
  `generate_context!`, and `#[tauri::command]` expand without tripping it, so the
  pre-approved `deny` exception was not needed.
- `tauri::test` exercises the commands as designed (mock runtime, `get_ipc_response`,
  `Listener::listen` for the event), so the plain-function fallback was not needed.
  Commands that take an `AppHandle` are generic over `R: Runtime` so the same handler
  list (`with_commands`) serves the app and the tests.
- YAML reads an unquoted label color such as `5319e7` as a number (5.319 × 10⁹), so
  `.github/labels.yml` quotes every color; `scripts/lib/labels.ts` rejects a non-string
  color, which is how this surfaced.
- The Dependabot alert for `glib` (GHSA-wrw7-89jp-8q8g) is the same Linux-only advisory
  `osv-scanner.toml` ignores: `glib` is absent from `cargo tree --target
  aarch64-apple-darwin`. The alert stays open; dismissing it is a repository write outside
  the run's authority.
- macOS's `/bin/bash` is still 3.2, and on a Mac without Homebrew's bash first on
  `PATH` a `#!/usr/bin/env bash` script runs under it (CI's macOS runners included).
  bash 3.2 fails to parse a here-document inside `"$(...)"` whose body holds a backtick,
  which the Template Bootstrap Smoke job caught in the ported
  `shipping-issues/scripts/preflight.sh`. Its two Python helpers now sit in functions
  called from the substitution, and `tests/test_shell_syntax.py` parses every bundled
  script with `/bin/bash -n`, so the Linux job's bash 5 no longer hides the problem.
