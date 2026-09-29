import { describe, expect, it } from "vitest";

import { counterCopy, describeCounterError, describeLastChanged } from "./counter";

describe("describeCounterError", () => {
  it("has a sentence for every code and storage kind", () => {
    expect(describeCounterError({ code: "atMaximum" })).toBe(
      "The counter is already at its highest value.",
    );
    expect(describeCounterError({ code: "atMinimum" })).toBe(
      "The counter is already at its lowest value.",
    );
    expect(describeCounterError({ code: "storage", kind: "unavailable" })).toMatch(
      /could not be saved/,
    );
    expect(describeCounterError({ code: "storage", kind: "corrupt" })).toBe(
      "The saved counter could not be read.",
    );
  });
});

describe("describeLastChanged", () => {
  it("says so when the counter never changed", () => {
    expect(describeLastChanged(null)).toBe(counterCopy.neverChanged);
  });

  it("formats the time in the given locale and zone", () => {
    expect(describeLastChanged(1_700_000_000_000, "en-US", "UTC")).toBe(
      "Last changed Nov 14, 2023, 10:13 PM",
    );
  });
});
