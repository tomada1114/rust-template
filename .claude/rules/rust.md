---
paths:
  - "crates/**/*.rs"
---

Only what no skill states: which skill owns which Rust edit, and the rules below. The
skills hold everything else, and nothing here restates them or a gate's config.

## Which skill owns the edit

| Editing | Load |
|---|---|
| Any Rust: ownership, visibility, `///`, matching, a compiler or clippy message | `writing-rust` |
| Logic, a port, a view, or a screen's state in `myapp-core` | `designing-core-logic` |
| An error enum or variant, its wording, its exit code | `designing-errors` |
| A subcommand, a flag, output, or logging in `crates/myapp/` | `designing-clis` |
| The TUI's loop or view in `crates/myapp/src/tui/` | `building-tuis` |
| An adapter in `myapp-platform`, a `cfg`, FFI | `integrating-system-apis` |
| A test | `tdd`, `writing-tests`, `placing-tests` |

## Rules

- A name other code must agree on is a `pub const` beside the one concern that owns it:
  the bundle identifier, the XDG directory name, and file names in
  `crates/myapp-platform/src/paths.rs`, the log retention in
  `crates/myapp-platform/src/logging.rs`. Anything else is a private `const` at the top
  of the file that uses it
- Fix a clippy finding or a borrow-checker error in the code: an `#[allow]`, an
  `#[expect]`, or `unsafe` to pass a check is weakening a gate (`AGENTS.md` › "Security
  and human approval")
