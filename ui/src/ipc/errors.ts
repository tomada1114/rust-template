import type { CounterError, StorageErrorKind } from "./types";

// Each table is a `Record` over the generated union rather than a list, so `satisfies`
// fails here both for a code or kind Rust does not send and for one it sends that this
// guard does not know yet.

const STORAGE_KINDS: ReadonlySet<string> = new Set(
  Object.keys({ unavailable: true, corrupt: true } satisfies Record<StorageErrorKind, true>),
);

/** Per code, whether the fields that code carries beside it are well formed. */
const FIELDS_BY_CODE: ReadonlyMap<string, (value: object) => boolean> = new Map(
  Object.entries({
    atMaximum: () => true,
    atMinimum: () => true,
    storage: (value: object) =>
      "kind" in value && typeof value.kind === "string" && STORAGE_KINDS.has(value.kind),
  } satisfies Record<CounterError["code"], (value: object) => boolean>),
);

/** Whether a command's rejection is a `CounterError` from Rust, rather than a bridge failure. */
export function isCounterError(value: unknown): value is CounterError {
  if (typeof value !== "object" || value === null || !("code" in value)) return false;
  const { code } = value;
  if (typeof code !== "string") return false;
  return FIELDS_BY_CODE.get(code)?.(value) === true;
}
