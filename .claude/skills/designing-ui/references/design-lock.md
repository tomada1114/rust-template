# The design lock: research, fields, and where each lands

The design lock is one ADR (`SKILL.md` › "The design lock" says when; the
`recording-architecture-decisions` skill owns the ADR's shape, number, and statuses).
Copy `docs/architecture/adr/template.md` to `docs/architecture/adr/NNNN-design-lock.md`
with the next free number. This file says what goes in it and how to get there.

## Research, when there is no `refero-design`

With the user-level `refero-design` skill, follow it: its research output (a reference
lock and a decision ledger) fills the sections below. Without it, do the same work by
hand, and write down every reference so the owner can look at it too.

1. **Read the product.** `AGENTS.md` › "Product" says who the app is for and its core
   interaction; the lock serves that interaction first. The app shape (window or
   menu-bar agent) is decided before the lock, because a panel under a menu-bar icon
   and a resizable window want different densities.
2. **Collect three to five references**: Mac apps in the same category or with the same
   core interaction, plus Apple's own apps as the native baseline. For each, note what
   to keep and what to leave, in a line each. A web page or a phone app is a weaker
   reference for a desktop window; say so when you use one.
3. **Pick one primary reference** and say what makes it right for this app. When a later
   choice is unclear, the lock leans towards it.
4. **Draft the lock block and the fields below**, each field a value or the words
   "system default".
5. **Measure** every new text/background pair before proposing it: add the pairs to
   `ui/src/design/contrast-pairs.ts` and the values to a branch's `tokens.css`, then
   `just test-ui` prints each ratio. A pair that fails is changed, never exempted.
6. **Ask the owner** to choose where references disagree, with the options side by side
   (a screenshot of each reference, or a human's `just dev` run of a draft). The ADR
   stays Proposed until they accept it.

## The lock block

The Decision section opens with a short block that a reviewer can hold a screen against:

```text
Primary reference:  <app>: <what about it this app is built after, in one sentence>.
                    When a choice is unclear, lean towards it.
Preserve:           <the three to five traits every screen keeps>
Borrow only:        <a trait taken from a second reference, and from which>
Role rules:         <what the accent marks, and nothing else; what selection and focus
                    look like; what an error looks like>
Reject:             <what the app never does, however tempting>
Memorable move:     <the one thing a user would describe the app by>
```

Keep it to values and one reason each, not a style guide. The reasoning that beat each
alternative belongs in Considered options; anything the owner has not settled goes under
Open questions, never filled in from habit.

## The ledger

Below the block, one row per decision, so a later reader can tell a researched choice
from a guess:

| Decision | Source | Why |
|---|---|---|
| `--color-accent` light `#…`, dark `#…` | Reference: <app> | <one reason> |
| Window opens at 480 × 360, minimum 360 × 280 | Here | the main value and its three actions fit without scrolling |

Source is `Reference: <app>` (researched), `Owner` (the owner decided, with where), or
`Here` (decided while writing the lock). A `Here` row is the first to revisit.

## Fields

Every field is a value or "system default". "System default" is a real decision, often
the right one for a first version; a field left out is a gap, listed under Open
questions until decided.

| Field | What "decided" looks like | Where it lands |
|---|---|---|
| Accent | "System default" (the base's blue), or one color with light and dark values and what it marks | `--palette-*` and `--color-accent`, `--color-text-on-accent`, `--color-focus-ring` in `ui/src/design/tokens.css` |
| Other colors | Each semantic role's light and dark value, or "base values" | the `--color-*` tokens; every new pair in `contrast-pairs.ts` |
| Type | The text styles used and for what; a custom font and its licence, or "system font only" | `--font-*` tokens; `Text`'s variants in `ui/src/design/Text.tsx` |
| Spacing scale | The steps, and which separates what (control from control, group from group, content from edge) | `--space-*`; `Stack`'s gaps |
| Density | Regular or compact: control height, panel padding | `--control-height`, `.ui-panel` in `primitives.css` |
| Shape | Corner radii for controls and panels, or "system default" | `--radius-control`, `--radius-panel` |
| Iconography | Glyphs only, or which icon set and its licence | the `glyph` of `IconButton`; an icon set is a dependency |
| Motion | "Transitions only on state change", or which animations exist and what each says | `--duration-*`, `--easing-standard`; the reduced-motion block |
| Window sizing | Default and minimum size; for a menu-bar agent, the panel's fixed size | `app.windows` in `src-tauri/tauri.conf.json` |
| Menus | The app-specific menus and the shortcuts they carry | the menu built in `src-tauri/src/lib.rs` |
| Copy style | Title or sentence case per element type; the app's voice in one sentence | `ui/src/copy/` |
| App icon | Who supplies it, or "placeholder until distribution" | `src-tauri/icons/`, `bundle.icon` (`docs/getting-started.md` › "App icon") |

A field that needs a new token or primitive gets it as `SKILL.md` › "The base design
system" describes, with its row in `docs/design/design-system.md`.

## A Decision section, sketched

```markdown
## Decision

Primary reference: <app>: …

- Accent: system default. Nothing in the app depends on its hue.
- Other colors: base values.
- Type: system font only; `title` for the window heading, `body` for content,
  `secondary` for supporting facts, `largeTitle` for the one main value.
- Spacing: the base scale; `s` between related controls, `m` between groups.
- Density: regular.
- Window: opens at 480 × 360, minimum 360 × 280.
- Motion: transitions on state change only, none added.
- Copy style: title case for buttons, menu items, and window titles; sentence case for
  labels and alerts.
- App icon: placeholder until distribution is decided.
```

## How the lock changes

- A corrected value in an Accepted lock is an amendment: an `Amended YYYY-MM-DD` line
  under its status saying what changed.
- A new direction (a new accent, a denser layout, a custom font) is a new ADR that
  supersedes the old one. Screens already built are brought into line in their own
  pull request.

## What does not belong in the lock

- The app shape and its windows or tray: `starting-an-app` and its own ADR.
- One screen's layout: that screen's pull request, built against the lock.
- What the HIG already fixes for every Mac app (standard shortcuts, the menu order): the
  lock records only this app's choices on top of it.
