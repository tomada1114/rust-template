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
- No issue or pull-request number (`#` followed by digits) in a standing document: a
  standing document states the rule and its reason itself. A link to a tracking issue
  is fine where a temporary exception needs one
- Keep README's Design Philosophy in sync when a documented decision changes
- User-facing changes get a CHANGELOG entry under `[Unreleased]` in the same PR
  (Keep a Changelog)
- Wrap prose at about 90 columns; Prettier does not format Markdown here
  (`.prettierignore`), and `typos` spell-checks it
