---
paths:
  - "ui/**/*.ts"
  - "ui/**/*.tsx"
  - "scripts/**/*.ts"
---

The short, always-on version of the `writing-typescript` skill. `tsc`, ESLint
(`strictTypeChecked`), and Prettier (`just lint`) enforce most of the language rules;
these are the ones they cannot, or the ones worth knowing before the gate fails.

## The IPC boundary (`ui/`)

- Only `ui/src/ipc/` imports `@tauri-apps/*` (ESLint `no-restricted-imports`). A screen
  or hook calls the typed wrapper in `ui/src/ipc/commands.ts` or `ui/src/ipc/events.ts`;
  a missing wrapper is added there, never worked around with a direct `invoke`
- `ui/src/ipc/generated/` is ts-rs output from core's Rust types: never edit it by
  hand, and never import it from outside `ui/src/ipc/`. Change the Rust type, run
  `just bindings`, and import the type from `ui/src/ipc/types.ts`
- Command names in `commands.ts` and event names in `events.ts` equal the Rust ones
  (`generate_handler!` in `src-tauri/src/lib.rs`, the `pub const` event names in
  `src-tauri/src/commands.rs`); a harness check compares them
- A command rejects with Rust's `{ code }` object; narrow it with a guard such as
  `isCounterError` (`ui/src/ipc/errors.ts`) before reading it
- Tests mock the Rust side through `ui/src/ipc/testing.ts` (`mockCommands`,
  `rejectWith`), which production code never imports (ESLint, static or dynamic)

## Screens (`ui/`)

- Every user-facing string lives in `ui/src/copy/`, including the wording for each
  error code; Rust sends codes, never sentences
- Styling uses the primitives in `ui/src/design/` and `var(--…)` tokens only: no hex,
  `rgb()`, `hsl()`, or named color, no `font-family`, and no pixel font size outside
  `ui/src/design/tokens.css` (a harness check). `docs/design/design-system.md` lists the
  tokens and primitives
- A component renders; a hook owns the Rust-owned model (loads through `commands.ts`,
  updates from `events.ts`). No state library
- Every control has an accessible name (a glyph-only button gets an `aria-label`), and
  tests query by role and name (the `building-react-screens` skill)
- `console` only in `ui/src/ipc/log.ts`, `window.console` and `globalThis.console`
  included (ESLint); anything else logs through it, and it forwards warnings and errors
  to Rust's log file

## Scripts (`scripts/`)

- Run by Node's type stripping (`node scripts/<name>.ts`): erasable syntax only
  (`erasableSyntaxOnly` in `scripts/tsconfig.json`) and imports name the `.ts` file
- `main(context: ScriptContext)` plus `if (import.meta.main) await runScript(main);`;
  fail with a `ScriptError` (`ERR_<STAGE>_<WHAT>`, Expected, Actual, Next). The full
  contract is `AGENTS.md` › Repository scripts and the `writing-repo-scripts` skill

## Language

- Narrow `unknown` with `typeof`, `in`, and type guards; never `as` a value into a type
  it has not been checked to have. `satisfies` checks a literal without widening it
- A `switch` over a union lists every member and has no `default` (ESLint's
  `switch-exhaustiveness-check`); adding a member then fails at every switch that must
  decide about it
- No `enum`, `namespace`, or parameter property in `ui/` either (`erasableSyntaxOnly` in
  `ui/tsconfig.json`)
- `import type` for type-only imports (`verbatimModuleSyntax`)
- No `any`, no non-null `!`, no `@ts-ignore`; a `@ts-expect-error` needs a description
  and, like an `// eslint-disable`, is weakening a gate when it only silences a check
  (`AGENTS.md` › Security and human approval)
- A TSDoc comment on each exported function of `ui/src/ipc/` and `scripts/lib/` says why
  it exists and what it promises
