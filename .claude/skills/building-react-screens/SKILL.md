---
name: building-react-screens
description: >
  Covers writing a screen under ui/src/ as a thin React component over a hook that
  mirrors a model Rust owns: the hook loading through ui/src/ipc/commands.ts and
  following ui/src/ipc/events.ts, a discriminated-union state for loading, failed, and
  ready, narrowing a rejection with the ui/src/ipc/errors.ts guard, empty states,
  accessible names on every control (IconButton label, aria-label), keyboard
  reachability, prefers-reduced-motion, using only the ui/src/design/ primitives and
  var(--...) tokens, strings from ui/src/copy/, and verifying with Testing Library and
  mockCommands. Use when adding or changing a component, a hook, a screen's CSS, or its
  wording under ui/src/, when a getByRole query cannot find a control, or when the
  harness literal check flags a color, font, or pixel size in ui/src/.
---

# Building React Screens

**Owns:** how a screen under `ui/src/` is written: the hook and the component, their
states, their accessibility, how they use the design system and the copy, and how a
screen is verified. **Does not own:** the tokens, the primitives, and what the app looks
like (`designing-ui`); the command wrappers and events a hook calls (`designing-ipc`);
the error codes a rejection carries (`designing-errors`); TypeScript idiom
(`writing-typescript`); where a test goes and how it is written (`placing-tests`,
`writing-tests`); running the app for a human to look at (`running-the-app`).

## The rule, and why

A component renders; a hook mirrors a model Rust owns; neither decides. Every rule (a
bound, a default, what a change does) is in `myapp-core`, where the Linux tests and the
coverage floor see it and the helper CLI shares it. A decision made in the UI is a
second copy that drifts from the first. The screen's job is to show what Rust returned
and send the user's intent back.

In the sample, `ui/src/counter/CounterScreen.tsx` renders over
`ui/src/counter/useCounter.ts`; copy that shape.

- A screen's files sit together in `ui/src/<area>/`: `<Area>Screen.tsx`,
  `use<Model>.ts`, `<Area>Screen.css` for layout only, and a test beside each. Its
  wording is `ui/src/copy/<area>.ts`. `ui/src/main.tsx` mounts the screen.
- Only `ui/src/ipc/` imports `@tauri-apps/*` or `ui/src/ipc/generated/` (ESLint's
  `no-restricted-imports`). A hook imports the wrappers and the types from
  `ui/src/ipc/types.ts`; a missing wrapper is added there first (`designing-ipc`).
- No state library: React state and one hook per Rust-owned model. Adding one is a new
  dependency and an ADR.
- The UI reads no environment variable. Vite writes every `VITE_`-prefixed value into
  the bundle at build time (<https://vite.dev/guide/env-and-mode>, checked 2026-09-29),
  so it ships inside every copy of the `.app`: that is publication, not configuration.
  A setting reaches a screen from Rust through a command; a first `VITE_` name is a
  decision stated in its pull request, and never a credential.

## The hook

- **State is a discriminated union** of what the screen can show. In the sample:
  `{ status: "loading" } | { status: "failed"; error } | { status: "ready"; view; error }`.
  A `switch` or a `status ===` check then narrows it, and a state the component forgot
  is a type error rather than a blank screen.
- **Load once, in an effect, and follow the event.** The effect calls the load wrapper,
  subscribes with the event wrapper, and on cleanup sets an `active` flag to false and
  calls the unlisten function. `main.tsx` renders in React's `StrictMode`, which runs
  one extra setup and cleanup of every effect in development
  (<https://react.dev/reference/react/StrictMode>, checked 2026-09-29), so a cleanup
  that leaks shows up under `just dev` (a human's recipe) as a duplicate listener rather
  than in a user's app later, and in the hook's unmount test before that.
- **An action shows what Rust returned.** It awaits the command and sets the returned
  view; it never computes the next value itself (no optimistic `value + 1`), because
  only core knows the bound.
- **A rejection is narrowed, never assumed.** A known error (`isCounterError` in
  `ui/src/ipc/errors.ts`) is kept in state for the component to word; anything else
  becomes `"unexpected"`, is logged through `ui/src/ipc/log.ts` in developer terms, and
  the screen shows a generic sentence (`counterCopy.unexpected`), never nothing. A failed
  change keeps the last good view on screen.
- An action returns `Promise<void>` and is wrapped in `useCallback`, so a component
  that passes it down does not re-render its children for nothing.

## The component

| Belongs in the component | Belongs in the hook | Belongs in core |
|---|---|---|
| Layout, order, which primitive | Loading, following events, keeping the last view | Every rule, bound, and default |
| Choosing the branch by `status` | Narrowing a rejection to a code or `null` | What an action does and returns |
| Calling an action from `onClick`: `onClick={() => void increment()}` | Logging a rejection it cannot name | Formatting that needs a decision |
| Picking the sentence for a code (through `ui/src/copy/`) | | The error codes themselves |

`void` marks a promise the handler deliberately does not await, which typescript-eslint's
`no-floating-promises` otherwise rejects; the hook already handled the error.

## Loading, failed, empty

Every screen renders each state, and a test reaches each one:

- **Loading:** a short line from the copy (`counterCopy.loading`), in the layout the
  ready state will use so nothing jumps.
- **Failed to load:** the reason in a `role="alert"` element, worded from the code, or
  the generic sentence when there is none.
- **Empty:** a real state, not a missing one. In the sample, a counter that never
  changed says "Not changed yet" instead of an empty time.
- **A failed action after a successful load:** the view stays, and the reason appears
  in an alert beside it.

## Accessibility

- **Every control has an accessible name.** A text `Button` is named by its label; a
  glyph-only control is an `IconButton`, whose `label` prop is required and becomes the
  `aria-label` while the glyph is `aria-hidden`. A region is named by its heading
  (`Panel as="section" labelledBy=…`).
- **State changes are announced:** the value in `role="status"` (a `Text` with `as="output"`
  in the sample), an error in `role="alert"`.
- **Keyboard:** every action is a native `button` (the primitives are), so Tab reaches it
  and Enter or Space presses it. Never a clickable `div`. The focus ring comes from
  `base.css`; never remove an outline to tidy a control. An action the user repeats
  also gets a menu item with a shortcut (`designing-ui` › "Menus and keyboard
  shortcuts").
- **Motion:** a transition uses `var(--duration-fast)` or `var(--duration-base)` with
  `var(--easing-standard)`; the tokens become `0ms` under `prefers-reduced-motion:
  reduce`, so the rule holds without code in the component. Nothing is communicated by
  motion or color alone.
- Enforced by: `eslint.config.mjs` "react-hooks" (the hooks rules only; no
  accessibility lint runs). The rest is held by the tests below, which find every
  control by role and name, and by review.

## Styling and wording

- Build from the primitives in `ui/src/design/` (`Button`, `IconButton`, `Stack`,
  `Panel`, `Text`); `docs/design/design-system.md` lists each one's recipe. Space with
  `Stack`'s `gap`, never with margins on the children.
- A screen's CSS is layout only and reaches every color, font, size, and spacing value
  through `var(--…)`. Enforced by:
  the harness literal check (`just check-harness`), which fails on a raw color, a
  `font-family`, or a pixel font size anywhere in `ui/src/` outside `tokens.css`.
- A screen that needs a value or a part the design system lacks gets it there first, as
  a token or a primitive with its row in `design-system.md` (`designing-ui`), never as a
  one-off style in the screen.
- **Every user-facing string is in `ui/src/copy/`**, including an `aria-label`, a
  tooltip, and each error sentence: one exhaustive `switch` per error type
  (`describeCounterError`), so a new code fails `just lint` until it has words. Rust
  sends codes, never sentences. A date or number is formatted there with `Intl`,
  taking the locale and time zone as optional arguments so a test can pin them
  (`describeLastChanged`).

## Verifying a screen

1. `just test-ui`: Vitest with Testing Library. Mock the Rust side with `mockCommands`,
   `rejectWith`, and `emitEvent` from `ui/src/ipc/testing.ts`; render the screen; find
   controls with `getByRole("button", { name: "Increment" })`, never by class, test id,
   or glyph; drive them with `userEvent`, including a keyboard pass (`userEvent.tab()`).
   Cover each state above, the event from outside, and the unlisten on unmount.
2. `just lint`: types, the hook rules, the exhaustive switches.
3. `just check-harness`: the literal check, and the IPC names.
4. Only when the human wants to see it: ask them to run `just dev` or `just run`, in
   both appearances and at the window's minimum size (`running-the-app`), with a
   VoiceOver pass when a control or its name changed, since no gate hears what
   VoiceOver reads. The pull request says what was checked. An agent never opens the
   window itself.

## Checklist

- The component branches on the hook's state and decides nothing; the hook sets only
  what Rust returned.
- Each of loading, failed, empty, and failed-action renders and has a test.
- Every control has an accessible name; every test query is by role and name.
- Only primitives and `var(--…)` tokens; no literal color, font, or pixel font size.
- Every string, label, and error sentence comes from `ui/src/copy/`.
