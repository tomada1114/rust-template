/**
 * Every foreground/background pair the design system uses, with the WCAG minimum it must
 * meet in both appearances (design D23). tokens.test.ts checks each one; add a pair here
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
];
