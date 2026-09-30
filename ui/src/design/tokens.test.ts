import { describe, expect, it } from "vitest";

import { CONTRAST_PAIRS, MINIMUM_RATIO, SURFACES } from "./contrast-pairs";
import primitivesCss from "./primitives.css?raw";
import { contrastRatio, luminance, missingPairs, parseTokens, requiredPairs } from "./tokens";
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

describe("primitives.css pairs", () => {
  const required = requiredPairs(primitivesCss, SURFACES);

  it("lists every pair primitives.css combines in CONTRAST_PAIRS", () => {
    expect(missingPairs(required, CONTRAST_PAIRS)).toEqual([]);
  });

  it("finds the primary button's accent boundary on the panel", () => {
    expect(required).toContainEqual({
      selector: ".ui-button--primary",
      foreground: "--color-accent",
      background: "--color-bg-panel",
    });
  });
});

describe("requiredPairs", () => {
  const surfaces = ["--color-s1", "--color-s2"];
  const pairs = (css: string) =>
    requiredPairs(css, surfaces).map(({ selector, foreground, background }) =>
      [selector, foreground, background].join(" "),
    );

  it("pairs a color with the rule's own background only", () => {
    expect(pairs(".x { color: var(--color-a); background: var(--color-b); }")).toEqual([
      ".x --color-a --color-b",
    ]);
  });

  it("pairs a color without a background with each surface", () => {
    expect(pairs(".x { color: var(--color-a); }")).toEqual([
      ".x --color-a --color-s1",
      ".x --color-a --color-s2",
    ]);
  });

  it("reads a border shorthand, replaced by a later border-color", () => {
    expect(pairs(".x { border: var(--border-width) solid var(--color-c); }")).toEqual([
      ".x --color-c --color-s1",
      ".x --color-c --color-s2",
    ]);
    expect(
      pairs(
        ".x { border: var(--border-width) solid var(--color-c); border-color: var(--color-d); }",
      ),
    ).toEqual([".x --color-d --color-s1", ".x --color-d --color-s2"]);
  });

  it("lays a modifier rule over its base", () => {
    const css = `
      .x { color: var(--color-a); background: var(--color-b); border: 1px solid var(--color-c); }
      .x--m { border-color: var(--color-d); }
    `;
    const modifier = pairs(css).filter((pair) => pair.startsWith(".x--m "));
    expect(modifier).toEqual([
      ".x--m --color-a --color-b",
      ".x--m --color-d --color-s1",
      ".x--m --color-d --color-s2",
    ]);
  });

  it("gives a modifier's state rule the modifier's background, not only the base's", () => {
    const css = `
      .x { color: var(--color-a); background: var(--color-b); }
      .x--m { background: var(--color-e); }
      .x--m:hover { color: var(--color-f); }
    `;
    expect(pairs(css).filter((pair) => pair.startsWith(".x--m:hover "))).toEqual([
      ".x--m:hover --color-f --color-e",
    ]);
  });

  it("skips the boundary of a rule whose background is a surface", () => {
    expect(pairs(".p { background: var(--color-s1); border: 1px solid var(--color-c); }")).toEqual(
      [],
    );
  });

  it("gives nothing for a state rule without color declarations", () => {
    expect(
      pairs(".x { color: var(--color-a); background: var(--color-b); } .x:hover { filter: none; }"),
    ).toEqual([".x --color-a --color-b"]);
  });

  it("reads each selector of a list, and rules inside an at-rule", () => {
    expect(
      pairs("@media (x) { .a, .b { color: var(--color-a); background: var(--color-b); } }"),
    ).toEqual([".a --color-a --color-b", ".b --color-a --color-b"]);
  });

  it("ignores comments and values without a color token", () => {
    expect(
      pairs(
        "/* .y { color: var(--color-z); } */ .x { color: currentColor; border: none; background: transparent; }",
      ),
    ).toEqual([]);
  });
});

describe("missingPairs", () => {
  it("returns a pair absent from the list and drops one present in it", () => {
    const listed = { selector: ".x", foreground: "--color-a", background: "--color-b" };
    const absent = { selector: ".y", foreground: "--color-c", background: "--color-b" };
    expect(
      missingPairs([listed, absent], [{ foreground: "--color-a", background: "--color-b" }]),
    ).toEqual([absent]);
  });
});
