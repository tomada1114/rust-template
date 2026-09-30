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
- No issue or pull-request reference in a standing document — `#` followed by digits, an
  issue or pull-request URL, or the word issue before a number: a standing document
  states the rule and its reason itself. `just check-harness` fails on one under `docs/`
  (outside `docs/template/`). A temporary exception that needs a tracking issue records
  the link where the exception is written (a `deny.toml` or `osv-scanner.toml` entry)
- Keep README's Design Philosophy in sync when a documented decision changes
- User-facing changes get a CHANGELOG entry under `[Unreleased]` in the same PR
  (Keep a Changelog)
- Wrap prose at about 90 columns; Prettier does not format Markdown here
  (`.prettierignore`), and `typos` spell-checks it
