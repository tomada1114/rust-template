import type { CounterError } from "./types";

const CODES: ReadonlySet<string> = new Set([
  "atMaximum",
  "atMinimum",
  "storage",
] satisfies CounterError["code"][]);

/** Whether a command's rejection is a `CounterError` from Rust, rather than a bridge failure. */
export function isCounterError(value: unknown): value is CounterError {
  if (typeof value !== "object" || value === null || !("code" in value)) return false;
  const { code } = value;
  return typeof code === "string" && CODES.has(code);
}
