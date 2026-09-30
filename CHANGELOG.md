# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The template: a Tauri v2 macOS app with a Rust core, a React UI, CI, and agent tooling.
- Documentation: the README's design rationale, contributing and security policies, a
  code of conduct, architecture, distribution and signing, and getting-started guides, an
  empty architecture-decision index with its template, a roadmap skeleton, issue forms,
  and a pull request template.

### Fixed

- The app and the helper CLI can save the counter at the same moment: each save writes
  its own temporary file and holds a lock on `counter.json.lock`, and each change holds
  it from the load to the save, so no save fails, no load reads half a file, and
  neither change is lost. A save also syncs the directory after the rename.

- `just bootstrap` refuses, before it writes anything, the inputs that used to fail half
  way or produce a broken app: a slug Cargo reserves (`build`, `deps`, …) or one whose
  packages would share a dependency's name (`tauri`, `serde`, …), a work tree with
  uncommitted or untracked changes (`ERR_BOOTSTRAP_DIRTY`), a malformed or `com.apple.`
  bundle identifier, and any answer containing `myapp` or `tauri-template`. Answers pasted
  in one go are each read, `--help` before `just install` fails with
  `ERR_BOOTSTRAP_NO_DEPS`, and the usage no longer claims `just` drops a value's quotes.

- Smoke mode (`MYAPP_SMOKE=1`) sets the `Prohibited` activation policy before the app
  finishes launching instead of after it has activated, and only the value `1` enables
  it. A startup error — no `HOME`, logging, the build, or a missing `main` window — now
  exits 1 with its reason on stderr instead of aborting, and `just smoke` checks that
  case.

- ESLint and `ui/tsconfig.json` now enforce the TypeScript rules the skills document: a
  `switch` over a union with a `default` fails `switch-exhaustiveness-check`; a dynamic
  `import()` of `@tauri-apps/*` or `ui/src/ipc/generated/` outside `ui/src/ipc/`, any
  non-test import of `ui/src/ipc/testing.ts`, and `window.console` or
  `globalThis.console` outside `ui/src/ipc/log.ts` fail ESLint; and `enum`,
  `namespace`, and parameter properties fail `tsc` in `ui/src/` (`erasableSyntaxOnly`).

- The pre-commit staged guard reads a staged file larger than 1 MiB instead of refusing
  it with `ERR_STAGED_READ_FAILED`, so an icon source, a screenshot, or a large lockfile
  can be committed through the hook.

- An app cut from the template releases its own `.app` and dmg: the bootstrap now
  rewrites the release workflow's `APP_NAME`, which stayed `MyApp` and failed the first
  release with `ERR_SMOKE_APP_MISSING`. CI's Template Bootstrap Smoke runs
  `scripts/verify-bootstrap.ts`, so a placeholder the bootstrap leaves behind fails the
  pull request instead of only printing a warning.

- The workflow harness checks now fail where they passed a weakened gate:
  `workflow-hygiene` rejects `continue-on-error` on a job or step, `set +e`, and an
  `|| true`, `|| :`, `|| exit 0`, `|| echo`, or `|| printf` fallback in a `run:`; checks
  every job-level `concurrency` on a push workflow and evaluates a concurrency group for
  a push run instead of looking for `github.sha` anywhere in it; applies its step rules
  to local composite actions; and reads `pnpm --dir ui install`, `npm install`,
  `cargo install`/`check`/`doc`/`deny`/`shear`, and `tauri build`/`dev` (in workflows
  and in every justfile recipe) for the lockfile flag. `just-check-matches-ci` no longer
  counts a gate CI runs only behind `if:`, with `continue-on-error`, with an `||`
  fallback, or on a `uses:` step. CI, the release workflow, and the justfile now pass
  `--locked` to `cargo deny`, `cargo shear`, and `tauri build`/`dev`.

- The harness checks now read the configurations they judge instead of passing on ones
  they never looked at: `ruleset-contexts` fails a required context reported only by a
  job whose workflow filters `pull_request` by `paths` or `branches` (or narrows its
  activity types), or whose `if:` — or a `needs` job's — is not provably true on a pull
  request, and a job name made only of an expression no longer matches every context
  (names and conditions are evaluated for a pull request). A JSON5 Renovate config
  (`renovate.json5` and its siblings) fails `bots-agree`, `workflow-hygiene`, and
  `labels-declared` as unread instead of being skipped. `bots-agree` compares
  Dependabot's `semver-*-days` too. `labels-declared` reads `scripts/label-pr.ts`'s type
  map from the checked root and fails on a PR-title type it does not map
  (`ERR_CHECK_LABEL_TYPE_UNMAPPED`). `core-boundary` walks build-dependency edges as
  well as normal ones.

- `ipc-names` and `ui-literals` catch the common spellings of what they ban.
  `ipc-names` compares the calls of Tauri's `invoke`, `listen`, and `once` (found by
  their `@tauri-apps/*` import, aliases and namespace imports included) in every file
  under `ui/src/ipc/` that ships, not only `commands.ts` and `events.ts`, reads a
  path-call emit through the `Emitter` trait such as `tauri::Emitter::emit(app, "…", ())`,
  and names the file to edit on each side. `ui-literals` flags a pixel size or family
  carried by a custom property its own file declares
  (`--size: 11px; font-size: var(--size)`) or written as a `var()` fallback, CSS system
  colors (`CanvasText`, `AccentColor`, …) in color properties and WebKit's
  (`-apple-system-label`, …), a value reached through a `const` in scope or a member of
  a `const` object, a computed key, a template, a conditional, `el.style.color = …`, or
  `style.setProperty(…)`, and a `--custom` property key in TypeScript; it now reads
  `ui/index.html`, `.svg`, `.html`, `.scss`, and JavaScript files, and fails on a markup
  tag it cannot read (`ERR_CHECK_UI_UNPARSED`).

### Security

- The staged guard catches this template's own signing secrets it used to miss: an
  `APPLE_PASSWORD`, `APPLE_CERTIFICATE_PASSWORD`, or other `*_password` assignment, a
  JSON `"password"` value, a base64 `.p12` such as `APPLE_CERTIFICATE`, a PGP private key
  block, and a Slack webhook URL. An `.npmrc` `_authToken=${NPM_TOKEN}` reference is no
  longer refused.

- `.claude/settings.json` refuses more ways to skip the pre-commit hook on Claude Code:
  `git commit --no-veri` and the other abbreviations of `--no-verify`, a `LEFTHOOK=`,
  `LEFTHOOK_EXCLUDE=`, `LEFTHOOK_BIN=`, or `LEFTHOOK_CONFIG=` assignment, and
  `core.hooksPath` set through `git -c`, `git --config-env`, or `git config`. It also
  refuses a second `-X`/`--method` after an allowed `gh api -X GET`, which sent the
  request with the second verb, and `--web`/`-w` on the allowed `gh` reads, which opened
  a browser without a prompt. A new harness check fails when `allow` admits a recipe
  that opens the app, needs a human, or writes beyond the working tree, and
  `AGENTS.md` names the hook bypasses and lefthook's fail-open hook among the gaps.
