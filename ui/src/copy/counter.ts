/**
 * Every user-facing string for the counter screen. Rust returns codes, never sentences;
 * this module owns the wording (issue-triage #119: the seam a second locale would use).
 */
import type { CounterError } from "../ipc/types";

export const counterCopy = {
  title: "Counter",
  increment: "Increment",
  decrement: "Decrement",
  reset: "Reset",
  retry: "Retry",
  loading: "Loading…",
  neverChanged: "Not changed yet",
  lastChanged: (when: string): string => `Last changed ${when}`,
  loadFailed: "The counter could not be loaded.",
  unexpected: "Something went wrong. Details are in the app's log.",
} as const;

/** The sentence shown for an error code. */
export function describeCounterError(error: CounterError): string {
  switch (error.code) {
    case "atMaximum":
      return "The counter is already at its highest value.";
    case "atMinimum":
      return "The counter is already at its lowest value.";
    case "storage":
      switch (error.kind) {
        case "unavailable":
          return "The counter could not be saved. Check that the disk has space and try again.";
        case "corrupt":
          return "The saved counter could not be read.";
      }
  }
}

/** "Last changed …" in the user's locale and time zone, or the never-changed text. */
export function describeLastChanged(
  lastChangedAt: number | null,
  locale?: string,
  timeZone?: string,
): string {
  if (lastChangedAt === null) return counterCopy.neverChanged;
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  return counterCopy.lastChanged(format.format(new Date(lastChangedAt)));
}
