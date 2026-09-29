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

### Security

- The staged guard catches this template's own signing secrets it used to miss: an
  `APPLE_PASSWORD`, `APPLE_CERTIFICATE_PASSWORD`, or other `*_password` assignment, a
  JSON `"password"` value, a base64 `.p12` such as `APPLE_CERTIFICATE`, a PGP private key
  block, and a Slack webhook URL. An `.npmrc` `_authToken=${NPM_TOKEN}` reference is no
  longer refused.
