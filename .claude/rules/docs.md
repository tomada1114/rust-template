---
paths:
  - "docs/**/*.md"
  - "README.md"
  - "CONTRIBUTING.md"
  - "CHANGELOG.md"
---

- Written in English
- Document non-obvious behavior, architecture decisions, and trade-offs
- Do NOT document what is obvious from the code or already expressed by the type system
- Code examples must be valid Rust, TypeScript, or shell that works with the current
  project; command examples must match the `justfile` recipes (a harness check fails on
  a `just <recipe>` that does not exist) and CONTRIBUTING.md's equivalents
- Every claim about an external tool — a version, availability, a default, a policy —
  carries its source URL and the date it was checked
- No reference to this repository's issues or pull requests in a standing document: it
  states the rule and its reason itself. A reference is `#` and digits (bare, or after
  this repository's owner/repo), an issue or pull-request URL on this repository or
  relative to it, the word issue, PR, pull request, or merge request before a number
  (`issue N`, `issue number N`, `PR-N`), `GH-` and digits, or a `gh issue`/`gh pr`
  command given a number; `just check-harness` fails
  on one under `docs/`. A link to a tracking issue is fine in a temporary exception's
  entry (a `deny.toml` or `osv-scanner.toml` ignore), in the roadmap
  (`docs/architecture/roadmap.md`), and in an ADR (`docs/architecture/adr/`), which the
  check does not read; an upstream project's issue or pull-request URL, or its
  `owner/repo#N`, is fine anywhere as the source of an external claim
- Keep README's Design Philosophy in sync when a documented decision changes
- User-facing changes get a CHANGELOG entry under `[Unreleased]` in the same PR
  (Keep a Changelog)
- Wrap prose at about 90 columns; Prettier does not format Markdown here
  (`.prettierignore`), and `typos` spell-checks it
