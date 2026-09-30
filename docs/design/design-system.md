# Design system

The base design system every screen is built from (design D23). It is deliberately
neutral and macOS-native, after Apple's
[Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
(checked 2026-09-28), so an app that never runs design research still looks like a Mac
app. An app cut from this template replaces the *values* first, before its first screen
(see "Choosing an app's own" below).

Everything lives in `ui/src/design/`:

| File | Holds |
|---|---|
| `tokens.css` | Primitive values (`--palette-*`), then the semantic tokens components use. The only file in `ui/src/` allowed a raw color, a `font-family`, or a pixel font size. |
| `base.css` | Element defaults (body text, focus ring, box sizing), from tokens only. |
| `primitives.css` | The primitives' styles, from tokens only. |
| `Button.tsx`, `IconButton.tsx`, `Stack.tsx`, `Panel.tsx`, `Text.tsx` | The primitives the sample uses. |
| `contrast-pairs.ts` | Every foreground/background pair components use, with its WCAG minimum. |
| `tokens.ts`, `tokens.test.ts` | The token parser and the contrast test. |

## Tokens

### Color (semantic; each has a light and a dark value)

| Token | Role |
|---|---|
| `--color-bg-window` | The window background. |
| `--color-bg-panel` | A raised surface (`Panel`). |
| `--color-text-primary` | Body text and headings. |
| `--color-text-secondary` | Supporting text ("Last changed …"). |
| `--color-text-danger` | Error messages. |
| `--color-accent` | The primary action's fill. A fixed stand-in for the system accent (see below). |
| `--color-text-on-accent` | Text on `--color-accent`. |
| `--color-control-bg` | A secondary button's fill. |
| `--color-control-text` | A secondary button's label. |
| `--color-control-border` | A control's boundary (3:1 against the panel, WCAG 1.4.11). |
| `--color-focus-ring` | The keyboard focus outline. |

Light and dark values switch with `prefers-color-scheme`, so the app follows the macOS
appearance setting. Native form controls follow the user's system accent color through
`accent-color: auto` in `base.css`; custom components use `--color-accent`, a fixed
value, because a user-chosen accent (yellow, say) cannot be checked for contrast.

### Typography

`--font-family-system` is the system font stack (San Francisco on macOS);
`--font-family-mono` the system monospace. Sizes mirror the macOS text styles:
`--font-size-large-title` 26, `--font-size-title1` 22, `--font-size-title2` 17,
`--font-size-title3` 15, `--font-size-headline` and `--font-size-body` 13,
`--font-size-callout` 12, `--font-size-footnote` 10 (px). Weights: `--font-weight-regular`,
`--font-weight-semibold`, `--font-weight-bold`; line heights `--line-height-tight`,
`--line-height-body`.

### Spacing, shape, motion

`--space-1` … `--space-6` (4, 8, 12, 16, 24, 32 px); `--radius-control`,
`--radius-panel`; `--border-width`, `--focus-ring-width`, `--control-height`.
`--duration-fast`, `--duration-base`, and `--easing-standard` for transitions; both
durations become `0ms` under `prefers-reduced-motion: reduce`.

## Primitives

| Primitive | Recipe |
|---|---|
| `Button` | A text push button. `variant="primary"` (accent fill) for the one main action in a view, `secondary` otherwise. Always `type="button"` unless it submits a form. |
| `IconButton` | A glyph-only button. `label` is required and becomes the accessible name (`aria-label`, and the tooltip); the glyph is `aria-hidden`. Tests find it by that name. |
| `Stack` | A flex row or column: `direction`, `gap` (`s`/`m`/`l`), `align`. The only way screens space things. |
| `Panel` | A raised surface. `as="section"` with `labelledBy` makes it a named landmark region. |
| `Text` | Text in a style: `largeTitle`, `title`, `body`, `secondary`, `danger`; `as` picks the element, `role` makes it a live `status` or `alert`. |

A screen uses these and the tokens, never a literal value (`building-react-screens`).

## How it is enforced

- **The literal check** (a harness check, `just check-harness`) fails on a raw color
  (hex, `rgb()`, `hsl()`, a named color, a CSS system color such as `CanvasText`, or a
  WebKit one such as `-apple-system-label`), a `font-family`, or a pixel font size
  anywhere under `ui/` (`ui/src/`, every entry page such as `ui/index.html` with its
  `theme-color` and inline scripts, `ui/public/`) outside `tokens.css`, including one
  carried by a local custom property, a `const` (imported ones too), or a `let`. A style
  file in a syntax it does not parse (`.less`, `.sass`, Stylus) fails it.
  `currentColor`, `transparent`, `inherit`, `none`, `initial`, and `unset` are allowed.
- **The contrast test** (`ui/src/design/tokens.test.ts`, part of `just test-ui`) parses
  `tokens.css`, fails if a semantic color has no dark value of its own, and checks every
  pair in `contrast-pairs.ts` in both appearances: 4.5:1 for body text, 3:1 for large
  text and UI components. The test names print each measured ratio.

## Choosing an app's own

An app decides its design system before its first screen (`starting-an-app`,
`designing-ui`): research a direction — with the `refero-design` skill when the session
has it, otherwise with `designing-ui`'s own research steps — record it as a design-lock
ADR (`docs/architecture/adr/NNNN-design-lock.md`: direction, references, decision
ledger), then **replace values in `tokens.css`** and, where the direction needs it, the
primitives. Keep the role names: every component already uses them. The literal check
and the contrast test hold for the app's tokens exactly as for the base.
