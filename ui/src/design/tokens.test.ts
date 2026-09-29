import { describe, expect, it } from "vitest";

import { CONTRAST_PAIRS, MINIMUM_RATIO } from "./contrast-pairs";
import { contrastRatio, luminance, parseTokens } from "./tokens";
import tokensCss from "./tokens.css?raw";

const tokens = parseTokens(tokensCss);
const semanticColors = [...tokens.light.keys()].filter((name) => name.startsWith("--color-"));

describe("tokens.css", () => {
  it("declares semantic colors", () => {
    expect(semanticColors.length).toBeGreaterThan(5);
  });

  it.each(semanticColors)("%s has a dark value of its own", (name) => {
    expect(tokens.darkDeclared.has(name)).toBe(true);
  });

  const cases = CONTRAST_PAIRS.flatMap((pair) =>
    (["light", "dark"] as const).map((appearance) => {
      const colors = tokens[appearance];
      const ratio = contrastRatio(
        colors.get(pair.foreground) ?? "",
        colors.get(pair.background) ?? "",
      );
      return {
        ...pair,
        appearance,
        ratio: ratio.toFixed(2),
        passes: ratio >= MINIMUM_RATIO[pair.kind],
      };
    }),
  );

  // The test name carries the measured ratio, so `just test-ui` prints every pair.
  it.each(cases)("$foreground on $background ($appearance, $kind): $ratio:1", ({ passes }) => {
    expect(passes).toBe(true);
  });
});

describe("parseTokens", () => {
  it("resolves var() chains and applies dark overrides", () => {
    const parsed = parseTokens(`
      /* a comment { with braces } */
      :root { --a: #111111; --b: var(--a); --c: var(--b); }
      @media (prefers-color-scheme: dark) { :root { --b: #eeeeee; } }
    `);
    expect(parsed.light.get("--c")).toBe("#111111");
    expect(parsed.dark.get("--c")).toBe("#eeeeee");
    expect([...parsed.darkDeclared]).toEqual(["--b"]);
  });

  it("works without a dark block", () => {
    expect(parseTokens(":root { --a: #fff; }").dark.get("--a")).toBe("#fff");
  });

  it("rejects an undeclared or circular reference", () => {
    expect(() => parseTokens(":root { --a: var(--missing); }")).toThrow(
      /--missing is not declared/,
    );
    expect(() => parseTokens(":root { --a: var(--b); --b: var(--a); }")).toThrow(
      /refers to itself/,
    );
  });

  it("returns nothing for a file without a :root block", () => {
    expect(parseTokens("").light.size).toBe(0);
  });

  it("reads an unterminated block to the end", () => {
    expect(parseTokens(":root { --a: #fff;").light.get("--a")).toBe("#fff");
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#fff", "#fff")).toBe(1);
  });

  it("rejects a value that is not a hex color", () => {
    expect(() => luminance("AccentColor")).toThrow(/not a hex color/);
  });
});
