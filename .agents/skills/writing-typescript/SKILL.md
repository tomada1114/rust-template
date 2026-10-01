---
name: writing-typescript
description: >
  Covers type-system judgment in the TypeScript under ui/src and scripts: narrowing
  unknown instead of any, a type guard (value is T), satisfies vs as, as const
  satisfies for an exhaustive table, interface vs type, a discriminated union with an
  exhaustive switch and no default (switch-exhaustiveness-check), inline import type
  under verbatimModuleSyntax, noUncheckedIndexedAccess, exactOptionalPropertyTypes and
  noPropertyAccessFromIndexSignature, why enum is not used, the ts-rs types in
  ui/src/ipc/generated used as-is through ui/src/ipc/types.ts and never edited, and
  placing a constant. Use when writing or reviewing a .ts or .tsx file under ui/src or
  scripts, when just lint fails in tsc or ESLint (strictTypeChecked), or when reaching
  for any, a non-null !, an as cast, @ts-expect-error, or a hand-written copy of a Rust
  type.
---

# Writing TypeScript

**Owns:** type-system judgment, naming, and constant placement inside `ui/src/**` and
`scripts/**`. **Does not own:** the error codes and their wording (`designing-errors`);
a script's structure and failure contract (`writing-repo-scripts`); tests
(`writing-tests`); the compiler and lint settings themselves (`changing-gates`).

`tsc` (`strict` plus the flags below, per `tsconfig.json` and
`scripts/tsconfig.json`), ESLint (`strictTypeChecked` and `stylisticTypeChecked` in
`eslint.config.mjs`), and Prettier enforce most of the language; `just lint` runs all
three and `just fix` applies their autofixes. This skill is the judgment they leave
open. The language itself is the TypeScript handbook
(https://www.typescriptlang.org/docs/handbook/intro.html).

## Naming and constants

- Keep a constant next to the code that reads it. No shared `constants.ts` that makes
  unrelated modules import each other. User-facing strings are not constants of a
  module: they live in `ui/src/copy/`.
- An error `code` string is not named here. **REQUIRED:** `designing-errors` owns the
  code vocabulary, both the Rust-generated codes the UI receives and the `ERR_*` codes
  in `scripts/`.

## Boundary types: `unknown`, `any`, and assertions

- Take `unknown` at an untyped boundary — a command's rejection, a caught error, parsed
  JSON — and narrow it before use. `any` switches checking off for everything
  downstream, not only at the boundary; `strictTypeChecked` rejects it
  (`no-explicit-any` and the `no-unsafe-*` rules).
- Narrow with `typeof`, `in`, and a type guard (`value is T`) that checks the runtime
  shape. In the sample, `isCounterError` in `ui/src/ipc/errors.ts` checks that a
  rejection is an object with a known `code` before the hook treats it as a
  `CounterError`.
- A type assertion (`as T`) changes only what the compiler believes; it checks nothing
  at runtime. Never `as` a value into a type it has not been checked to have, and never
  use a non-null `!`: both are how a wrong assumption reaches the user as a crash.
  Where one survives review, keep it local and unexported.
- Prefer `satisfies` to `as` on a literal: `satisfies` keeps the excess- and
  missing-property checks that `as` silences. `as const satisfies Record<K, V>` also
  keeps the literal keys, so a table keyed by a union fails to compile when a member is
  added. In the sample, the code list in `ui/src/ipc/errors.ts` ends
  `satisfies CounterError["code"][]`, so a code Rust does not send fails `tsc`.

## Imports

- Mark a type-only import inline: `import { value, type X } from "./x"`. That is the
  form `@typescript-eslint/consistent-type-imports` autofixes to (`fixStyle:
  "inline-type-imports"`); a separate `import type { X }` is fine when every name in it
  is a type.
- The marking is load-bearing: `verbatimModuleSyntax` emits every unmarked import as
  written, so `tsc` rejects an unmarked import of a name that is only a type (TS1484,
  "must be imported using a type-only import"): the emitted import would ask the module
  at runtime for a name it does not export. A marked name is dropped from the output;
  `import { type X }` still keeps the module's import (its side effects run), while
  `import type { X }` removes it. Let `just fix` write the form; never hand-fix an
  import differently.
- Only `ui/src/ipc/` imports `@tauri-apps/*` or `ui/src/ipc/generated/`, and only a
  test or `ui/src/test/` imports `ui/src/ipc/testing.ts`. Enforced by:
  `eslint.config.mjs` `no-restricted-imports` for `import` and `export … from`, and
  `no-restricted-syntax` for a dynamic `import()`, which must name a string literal
  (`TAURI_ONLY_IN_IPC`, `GENERATED_ONLY_IN_IPC`, `TESTING_ONLY_IN_TESTS`). Everything
  else takes IPC types from `ui/src/ipc/types.ts`.
- `ui/src/` has no Node types (`ui/tsconfig.json` `types`), so a `node:` import there
  fails `tsc`: the UI runs in a WebView. `scripts/` imports name the `.ts` file, because
  Node runs them by type stripping with no bundler to resolve an extensionless path.

## Types generated from Rust

- `ui/src/ipc/generated/` is `ts-rs` output from core's Rust types: never edit it,
  and never write a TypeScript copy of a type Rust already sends. Change the Rust type
  and commit the regenerated output with it; a hand-written twin drifts silently, where
  the generated one fails `tsc` at every place the change matters.
- Derive what you need from a generated type (an indexed access, `Extract`) instead of
  restating it. In the sample, `CounterError["code"]` is the union of codes, and
  `Extract<CounterError, { code: "storage" }>` is one member.
- A 64-bit Rust integer arrives as `number`; a time is milliseconds since the epoch,
  formatted only in `ui/src/copy/`.

## `interface` vs `type`

- An object shape is an `interface`, and composition is `interface X extends Y`:
  `@typescript-eslint/consistent-type-definitions` (from the stylistic set) prefers it,
  and `&` intersections are slower to check and give worse errors
  (https://github.com/microsoft/TypeScript/wiki/Performance#preferring-interfaces-over-intersections,
  checked 2026-09-29). A union is a `type`, since an interface cannot express one. In
  the sample, `UseCounter` is an interface and `CounterState` is a union `type`
  (`ui/src/counter/useCounter.ts`).
- Mark props, state, and options `readonly` unless the code mutates them.

## Discriminated unions and exhaustiveness

- When a value has mutually exclusive shapes, use a discriminated union on a literal
  field (`status`, `code`, `kind`) rather than a bag of optional flags, and narrow by
  branching on that field. ts-rs generates exactly this from a Rust enum tagged with
  `#[serde(tag = "code")]`.
- A `switch` over a union gives each member its own `case` and has no `default`.
  Enforced by: `@typescript-eslint/switch-exhaustiveness-check` with
  `considerDefaultExhaustiveForUnions: false` (a `default` does not stand in for a
  missing member) and `allowDefaultCaseForExhaustiveSwitch: false` (a `default` beside
  every member is refused), because a `default` would silently answer for a member
  added later. A `switch` over a plain `string` may still have one. In the sample,
  `describeCounterError` in `ui/src/copy/counter.ts` switches on `code`, then on `kind`,
  with no `default`; a new code from Rust fails `tsc` there until it has wording.

## Strictness flags to work with, not around

- `noUncheckedIndexedAccess`: `record[key]` and `array[i]` are `T | undefined`. Treat
  the `undefined` branch as real. In the sample, `mockCommands` in
  `ui/src/ipc/testing.ts` throws on an unknown command instead of asserting it away.
- `noPropertyAccessFromIndexSignature` (in `ui/` and `scripts/`): a `Record<string, T>`
  is read with brackets (`handlers[cmd]`); a literal `as const` object keeps dot access
  because its keys are known.
- `exactOptionalPropertyTypes`: an absent property and one set to `undefined` differ.
  Declare an omissible option `readonly x?: T`. When a caller really forwards
  `undefined` (a prop threaded through a wrapper), widen that one property to
  `x?: T | undefined`; never turn the flag off.
- No `enum`, no `namespace`, and no parameter property. `scripts/tsconfig.json`,
  `ui/tsconfig.json`, and the root `tsconfig.json` reject them at `tsc`
  (`erasableSyntaxOnly`): Node strips `scripts/` types without compiling, and a
  string-literal union is what ts-rs generates from a Rust enum anyway. In the sample,
  `StorageErrorKind` is `"unavailable" | "corrupt"`.

## Function boundaries

- Annotate the parameters and the return type of an exported function; let inference
  handle locals. An annotated return type is what keeps a refactor from widening what a
  caller receives, and it is where a reader looks first.
- A generic accepts the widest reasonable input and returns the narrowest true output;
  do not annotate a generic's return type wider than inference would make it.

## Silencing a check

`@ts-ignore`, `@ts-expect-error`, a non-null `!`, an `as` cast, or an
`// eslint-disable` added to make `just lint` pass is weakening a gate, and needs a
human's sign-off before it lands (`AGENTS.md` › "Security and human approval"). Fix the
type instead. The one case worth asking about is a real defect in a dependency's types:
then `@ts-expect-error` with a description (`@typescript-eslint/ban-ts-comment` refuses
`@ts-ignore`, and a description under 10 characters), named in the pull request for
that sign-off.
