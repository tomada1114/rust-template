/**
 * Every foreground/background pair the design system uses, with the WCAG minimum it must
 * meet in both appearances. tokens.test.ts checks each one, and also derives the pairs
 * primitives.css combines and fails on one that is missing here; add a pair here
 * whenever a component puts a new token on top of another.
 */
export type ContrastKind = "body" | "large" | "ui";

export interface ContrastPair {
  readonly foreground: `--color-${string}`;
  readonly background: `--color-${string}`;
  readonly kind: ContrastKind;
}

/** WCAG 2.2: 4.5:1 for body text, 3:1 for large text and UI components. */
export const MINIMUM_RATIO: Readonly<Record<ContrastKind, number>> = { body: 4.5, large: 3, ui: 3 };

/** The backgrounds a component can sit on: a color with no background of its own is checked on each. */
export const SURFACES: readonly `--color-${string}`[] = ["--color-bg-window", "--color-bg-panel"];

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { foreground: "--color-text-primary", background: "--color-bg-window", kind: "body" },
  { foreground: "--color-text-secondary", background: "--color-bg-window", kind: "body" },
  { foreground: "--color-text-primary", background: "--color-bg-panel", kind: "body" },
  { foreground: "--color-text-secondary", background: "--color-bg-panel", kind: "body" },
  { foreground: "--color-text-danger", background: "--color-bg-panel", kind: "body" },
  { foreground: "--color-text-on-accent", background: "--color-accent", kind: "body" },
  { foreground: "--color-control-text", background: "--color-control-bg", kind: "body" },
  { foreground: "--color-control-border", background: "--color-bg-panel", kind: "ui" },
  { foreground: "--color-focus-ring", background: "--color-bg-panel", kind: "ui" },
  { foreground: "--color-focus-ring", background: "--color-bg-window", kind: "ui" },
  { foreground: "--color-accent", background: "--color-bg-panel", kind: "ui" },
  { foreground: "--color-accent", background: "--color-bg-window", kind: "ui" },
  { foreground: "--color-control-border", background: "--color-bg-window", kind: "ui" },
  { foreground: "--color-text-danger", background: "--color-bg-window", kind: "body" },
];
