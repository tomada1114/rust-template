/**
 * The source helpers the UI checks share: file classes, blanking, and name resolution
 * through a checker over one file.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  blank,
  constInitializer,
  importOf,
  parseScript,
  SCRIPT_FILE,
  TEST_FILE,
} from "./sources.ts";

/** Every identifier named `name` in `source`, in order. */
function identifiers(path: string, source: string, name: string) {
  const parsed = parseScript(path, source);
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed.file);
  return { ...parsed, found };
}

describe("file classes", () => {
  it.each([["a.ts"], ["a.tsx"], ["a.js"], ["a.jsx"], ["a.mjs"], ["a.cts"]])(
    "%s is a script",
    (name) => {
      expect(SCRIPT_FILE.test(name)).toBe(true);
    },
  );

  it("knows a test file from a script and a stylesheet from both", () => {
    expect(TEST_FILE.test("a.test.tsx")).toBe(true);
    expect(TEST_FILE.test("a.test.mjs")).toBe(true);
    expect(TEST_FILE.test("contest.ts")).toBe(false);
    expect(SCRIPT_FILE.test("a.css")).toBe(false);
  });
});

describe("blank", () => {
  it("keeps line breaks and length", () => {
    expect(blank("ab\ncd")).toBe("  \n  ");
  });
});

describe("parseScript", () => {
  it.each([
    ["x.tsx", ts.LanguageVariant.JSX],
    ["x.jsx", ts.LanguageVariant.JSX],
    ["x.mjs", ts.LanguageVariant.JSX],
    ["x.ts", ts.LanguageVariant.Standard],
  ])("parses %s as its own kind", (path, variant) => {
    expect(parseScript(path, "export const x = 1;\n").file.languageVariant).toBe(variant);
  });
});

describe("constInitializer", () => {
  it("follows a const, and not a parameter that shadows it", () => {
    const { checker, found } = identifiers(
      "x.ts",
      'const tone = "red";\nconst a = tone;\nconst f = (tone: string) => tone;\n',
      "tone",
    );
    const [, outerUse, , innerUse] = found;
    const outer = outerUse === undefined ? undefined : constInitializer(checker, outerUse);
    expect(outer !== undefined && ts.isStringLiteral(outer) ? outer.text : undefined).toBe("red");
    expect(
      innerUse === undefined ? "missing" : constInitializer(checker, innerUse),
    ).toBeUndefined();
  });

  it("does not follow a let, or a name bound nowhere", () => {
    const { checker, found } = identifiers("x.ts", 'let c = "red";\nuse(c, d);\n', "c");
    const use = found[1];
    expect(use === undefined ? "missing" : constInitializer(checker, use)).toBeUndefined();
    const unbound = identifiers("x.ts", "use(d);\n", "d");
    const [d] = unbound.found;
    expect(d === undefined ? "missing" : constInitializer(unbound.checker, d)).toBeUndefined();
  });

  it("follows a shorthand property to the const it names", () => {
    const { checker, found } = identifiers(
      "x.ts",
      'const color = "red";\nconst s = { color };\n',
      "color",
    );
    const shorthand = found[1];
    const value = shorthand === undefined ? undefined : constInitializer(checker, shorthand);
    expect(value !== undefined && ts.isStringLiteral(value) ? value.text : undefined).toBe("red");
  });
});

describe("importOf", () => {
  it.each([
    ['import { invoke as call } from "m";\ncall();\n', "call", { module: "m", name: "invoke" }],
    ['import { listen } from "m";\nlisten();\n', "listen", { module: "m", name: "listen" }],
    ['import * as core from "m";\ncore.x();\n', "core", { module: "m", name: "*" }],
    ['import core from "m";\ncore();\n', "core", { module: "m", name: "default" }],
    ["const local = 1;\nlocal;\n", "local", undefined],
    ["unbound();\n", "unbound", undefined],
  ])("reads %j", (source, name, expected) => {
    const { checker, found } = identifiers("x.ts", source, name);
    const use = found.at(-1);
    expect(use === undefined ? "missing" : importOf(checker, use)).toEqual(expected);
  });
});
