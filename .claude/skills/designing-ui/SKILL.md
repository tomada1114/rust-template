---
name: designing-ui
description: >
  Covers how this macOS app looks and behaves to the eye and hand: Apple's Human
  Interface Guidelines applied inside a WebView (the system font stack and macOS text
  styles as CSS tokens, light and dark with prefers-color-scheme, accent-color and the
  --color-accent token, contrast, window sizes in src-tauri/tauri.conf.json, the app
  menu and keyboard shortcuts through Tauri's menu API, motion); the base design system
  in ui/src/design/ (tokens.css, base.css, primitives.css, the primitives,
  contrast-pairs.ts, tokens.test.ts) and docs/design/design-system.md; and the per-app
  design-lock ADR with its ledger, researched with the refero-design skill when present.
  Use when choosing a color, font, size, spacing, radius, or motion value, adding or
  renaming a token or a primitive, a contrast test failure, a menu item or shortcut,
  resizing the window, adopting a CSS framework, or writing the design lock.
---

# Designing UI

**Owns:** what a screen looks like and how it behaves to the eye and hand: the craft
rules below, the base design system in `ui/src/design/` with its document
`docs/design/design-system.md`, and the app's design lock. **Does not own:** building a
screen from the primitives and tokens (`building-react-screens`); an ADR's shape,
number, and status (`recording-architecture-decisions`); the app shape, window or
menu-bar agent (`starting-an-app`); a font or CSS package as a dependency
(`managing-dependencies`); the wording itself (`ui/src/copy/`, `building-react-screens`).

Apple's Human Interface Guidelines (HIG) are the baseline, so an app that never runs
design research still looks like a Mac app. This skill keeps what this repository
decides on top of them and links the HIG for the rest.

## System first, custom by exception

- **Type.** The system font stack (`--font-family-system`) and a size scale mirroring
  the macOS text styles (Large Title 26, Title 1 22, Title 2 17, Title 3 15, Headline and
  Body 13, Callout 12, Footnote 10 pt, which the tokens set in px: HIG typography,
  <https://developer.apple.com/design/human-interface-guidelines/typography>, checked
  2026-09-29). macOS has no Dynamic Type, and a custom font must answer the system's
  accessibility settings the way the system font does (same page); a custom font is a
  lock decision and a bundled file with a licence to check, never a font host fetched at
  run time (the CSP in `tauri.conf.json` allows no remote origin).
- **Color.** Components use semantic tokens (`--color-text-primary`,
  `--color-bg-panel`), never a palette value or a literal, and never a token for a role
  it was not named for. A WebView cannot read macOS's dynamic system colors, so the
  tokens are fixed stand-ins for them; HIG asks never to hard-code a system color's
  value, which is why a token names a role rather than copying Apple's numbers.
- **Accent.** Native form controls follow the user's accent through `accent-color: auto`
  (`base.css`); custom components use `--color-accent`, a fixed value, because a user's
  accent cannot be checked for contrast. On macOS the user's accent setting replaces an
  app's accent unless it is set to multicolor (HIG color,
  <https://developer.apple.com/design/human-interface-guidelines/color>, checked
  2026-09-29), so the accent may carry brand, never meaning.
- **Not color alone.** State is also carried by text, a glyph, or shape (same page): an
  error is a sentence in an alert, not a red border.
- **Controls.** The primitives, which are native `button` elements with the system's
  keyboard and focus behavior. A custom control owes all of that by hand, which is why
  it is rare.
- **No CSS framework or component library**: plain CSS over tokens (README's Design
  Philosophy says why). Adding one is an ADR and a dependency sign-off.

## Appearance, contrast, motion

- Every semantic color has a light value and a dark value of its own, switched by
  `prefers-color-scheme`, so the app follows the macOS appearance. Enforced by:
  `ui/src/design/tokens.test.ts` (a semantic color with no dark value fails).
- Measure contrast; never estimate it. Every foreground/background pair a component
  uses is a row in `ui/src/design/contrast-pairs.ts`, and the test checks it in both
  appearances against `MINIMUM_RATIO`: 4.5:1 for body text, 3:1 for large text and UI
  parts. The HIG asks for at least 4.5:1 and 7:1 where it can, especially for small
  text on custom colors (<https://developer.apple.com/design/human-interface-guidelines/dark-mode>,
  checked 2026-09-29). The test name prints each measured ratio in `just test-ui`.
- Motion is optional decoration and never the only signal
  (<https://developer.apple.com/design/human-interface-guidelines/motion>, checked
  2026-09-29). Transitions use `--duration-fast`/`--duration-base` and
  `--easing-standard`, which collapse to `0ms` under `prefers-reduced-motion: reduce`.

## Windows and layout

- The main window's size lives in `src-tauri/tauri.conf.json` (`app.windows`: `width`,
  `height`, `minWidth`, `minHeight`). Nothing overlaps or clips at the minimum, and a
  text column caps its width rather than stretching at full screen. The window is
  created hidden and shown by `run()` (smoke mode keeps it hidden), so keep
  `visible: false`.
- Space from the scale (`--space-1` to `--space-6`) through `Stack`'s gaps; let
  alignment and indentation carry hierarchy before color or weight.

## Menus and keyboard shortcuts

- Every command the app offers is also in the menu bar, where people look for it and
  learn its shortcut, even when a button does the same; an item that cannot act now is
  disabled, not hidden; a multi-word menu title is in title case
  (<https://developer.apple.com/design/human-interface-guidelines/the-menu-bar>, checked
  2026-09-29).
- Standard shortcuts keep their meaning; a custom shortcut is only for the most frequent
  app-specific commands, with Command as the main modifier and Control avoided
  (<https://developer.apple.com/design/human-interface-guidelines/keyboards>, checked
  2026-09-29).
- **The menu is built in Rust**, in the shell's setup in `src-tauri/src/lib.rs`, with
  Tauri's `MenuBuilder`, `SubmenuBuilder`, and `PredefinedMenuItem` for the standard
  Edit items; on macOS every item must sit in a submenu, and the first submenu becomes
  the app menu (<https://v2.tauri.app/learn/window-menu/>, checked 2026-09-29). A menu
  event calls the same core function the matching command calls, then emits the same
  event, so the screen updates through the path it already has. Tauri also offers a menu
  API in JavaScript; this repository does not use it, because the menu is app-wide
  wiring and belongs with the composition root, not in a screen.

## Copy style

One capitalization per element type (buttons, menu items, window titles, labels,
alerts), fixed in the lock and applied everywhere. A button or menu label starts with a
verb for what happens; an item that needs more input before it acts ends in an
ellipsis (…). The strings live in `ui/src/copy/`.

## The base design system

`ui/src/design/` is what every screen is built from, and
`docs/design/design-system.md` says what each token and primitive means; read it rather
than a copy here.

- **Two layers.** `--palette-*` holds raw values; semantic tokens (`--color-*`, `--font-*`,
  `--space-*`, `--radius-*`, `--duration-*`) name a role and point at a palette value.
  Components use semantic tokens only.
- **An app replaces values, never role names.** Every component already names the
  roles, so a new direction is a new set of values in `tokens.css` (and, where the
  direction needs it, new primitive styles), and no screen changes.
- **Adding a token:** declare it in `tokens.css` with a light value and, for a color, a
  dark one; add its row to `design-system.md`; add every new foreground/background pair
  to `contrast-pairs.ts`. Check: `just test-ui`.
- **Adding a primitive:** `ui/src/design/<Name>.tsx` with styles in `primitives.css`
  from tokens only, exported from `ui/src/design/index.ts`, a test in
  `primitives.test.tsx`, and its recipe row in `design-system.md`. A glyph-only control
  takes its accessible name as a required prop, as `IconButton` does.
- Enforced by: the harness literal check (`just check-harness`: no raw color,
  `font-family`, or pixel font size in `ui/src/` outside `tokens.css`) and the contrast
  test (`just test-ui`). Both hold for an app's replacement values exactly as for the
  base.
- In the template itself there is no lock; a change to the base's own defaults updates
  `design-system.md`, and README's Design Philosophy when a stated reason changes
  (`updating-docs`).

## The design lock

The lock is an app's answer to "what does every screen here look like?": a handful of
decisions made once, before the first screen, so each screen is built against them
instead of reinvented. It is an ADR, written as `recording-architecture-decisions`
says, at `docs/architecture/adr/NNNN-design-lock.md` with the next free number (never
assume one), status Proposed, and a row in `docs/architecture/README.md`. Only the owner
accepts it; until then screens are built against it only as an experiment.

**REQUIRED:** [references/design-lock.md](references/design-lock.md) to write one: the
research steps, the lock block, the decision ledger, the fields and where each lands in
code, and how it changes.

- **Research first.** When the session has the user-level `refero-design` skill, use it:
  its styles, screens, and flows research ends in a reference lock and a decision
  ledger, which map onto this ADR. It is optional; the template never depends on it.
  Without it, follow the reference's own research steps.
- **Apply it by replacing values** in `tokens.css` and, where needed, the primitives,
  never by styling a screen directly.
- **A screen with no precedent** adds its part to the design system first, from
  existing tokens, then checks it against the lock. When a finding and the lock
  genuinely conflict, say so and let the owner decide; quietly softening the lock toward
  a safer middle is the failure this guards against.

## Reviewing a screen's design

No gate sees what a screen looks like. The agent's part: `just test-ui` (contrast, the
primitives), `just check-harness` (literals). The human's part, asked for once
(`running-the-app`): `just run` or `just dev` (human recipes: they open the app),
looking at the screen in light and dark, at the window's minimum size, with Increase
Contrast and Reduce Motion on (HIG dark mode page above), compared against the lock; the
pull request carries what they saw.
