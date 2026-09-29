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
