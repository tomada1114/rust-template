import { describe, expect, it } from "vitest";

import { isCounterError } from "./errors";

describe("isCounterError", () => {
  it.each([
    { code: "atMaximum" },
    { code: "atMinimum" },
    { code: "storage", kind: "unavailable" },
    { code: "storage", kind: "corrupt" },
  ])("accepts %o", (value) => {
    expect(isCounterError(value)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "atMaximum",
    3,
    {},
    { code: 1 },
    { code: "somethingElse" },
    { code: "toString" },
    { code: "storage" },
    { code: "storage", kind: "x" },
    { code: "storage", kind: 1 },
    new Error("x"),
  ])("rejects %o", (value) => {
    expect(isCounterError(value)).toBe(false);
  });
});
