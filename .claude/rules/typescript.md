---
paths:
  - "ui/**/*.ts"
  - "ui/**/*.tsx"
  - "scripts/**/*.ts"
---

The short, always-on version of the `writing-typescript` skill. `tsc`, ESLint
(`strictTypeChecked`), and Prettier (`just lint`) enforce most of the language rules;
these are the ones they cannot, or the ones worth knowing before the gate fails.

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
- No `enum`, `namespace`, or parameter property in the root config files either
  (`erasableSyntaxOnly` in `tsconfig.json`)
- Mark a type-only import inline, `import { value, type X } from "./x"`: ESLint's
  `consistent-type-imports` requires the marking and its fix writes this form
  (`fixStyle: "inline-type-imports"`); `import type { X }` is fine when every name is a
  type. Under `verbatimModuleSyntax` the inline form keeps the module's import, while
  `import type` removes it
- No `any`, no non-null `!`, no `@ts-ignore`; a `@ts-expect-error` needs a description
  and, like an `// eslint-disable`, is weakening a gate when it only silences a check
  (`AGENTS.md` › Security and human approval)
- A TSDoc comment on each exported function of `scripts/lib/` says why it exists and
  what it promises
