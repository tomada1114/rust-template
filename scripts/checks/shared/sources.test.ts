/**
 * The source helpers the UI checks share: file classes, blanking, and name resolution
 * through a checker over one file.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  bindingValues,
  blank,
  constInitializer,
  importOf,
  parseScript,
  parseScripts,
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

/** The texts `bindingValues` finds for the last use of `name` in `use.ts`, beside `other`. */
function valuesAt(use: string, name: string, other: Record<string, string> = {}): string[] {
  const { files, checker } = parseScripts([
    ...Object.entries(other).map(([path, source]) => ({ path, source })),
    { path: "use.ts", source: use },
  ]);
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  const file = files.get("use.ts");
  if (file !== undefined) visit(file);
  const last = found.at(-1);
  return last === undefined ? ["missing"] : bindingValues(checker, last).map((v) => v.getText());
}

describe("parseScripts", () => {
  it("keys each file by its path and parses it as its own kind", () => {
    const { files } = parseScripts([
      { path: "a.tsx", source: "export const a = <p />;\n" },
      { path: "b.ts", source: "export const b = 1;\n" },
    ]);
    expect([...files.keys()]).toEqual(["a.tsx", "b.ts"]);
    expect(files.get("a.tsx")?.languageVariant).toBe(ts.LanguageVariant.JSX);
  });

  it("reports a file's syntax errors, and none for a file it was not given", () => {
    const { syntaxErrors } = parseScripts([
      { path: "bad.js", source: "const = ;\n" },
      { path: "good.js", source: "const a = 1;\n" },
    ]);
    expect(syntaxErrors("bad.js").length).toBeGreaterThan(0);
    expect(syntaxErrors("good.js")).toEqual([]);
    expect(syntaxErrors("missing.js")).toEqual([]);
  });

  it("keeps two files' top-level names apart, as modules", () => {
    const values = valuesAt('const c = "a";\nuse(c);\n', "c", { "other.ts": 'const c = "b";\n' });
    expect(values).toEqual(['"a"']);
  });
});

describe("bindingValues", () => {
  it.each([
    ["a const's initializer", 'const c = "red";\nuse(c);\n', "c", ['"red"']],
    [
      "a let's initializer and each assignment",
      'let c = "red";\nc = "blue";\nc += "x";\nc ||= "y";\nuse(c);\n',
      "c",
      ['"red"', '"blue"', '"x"', '"y"'],
    ],
    ["a var assigned only later", 'var c;\nc = "red";\nuse(c);\n', "c", ['"red"']],
    ["a shorthand property", 'const c = "red";\nconst s = { c };\n', "c", ['"red"']],
    ["nothing for a parameter", "const f = (c: string) => c;\n", "c", []],
    ["nothing for a destructured name", "const { c } = o;\nuse(c);\n", "c", []],
    ["nothing for a name bound nowhere", "use(c);\n", "c", []],
    ["nothing for a function", "function c() {}\nuse(c);\n", "c", []],
  ])("finds %s", (_label, source, name, expected) => {
    expect(valuesAt(source, name)).toEqual(expected);
  });

  it.each([
    ["a named import", 'import { C } from "./c";\nuse(C);\n', "C", ['"red"']],
    ["a default import of an expression", 'import D from "./c";\nuse(D);\n', "D", ['"navy"']],
    ["a re-export", 'import { R } from "./r";\nuse(R);\n', "R", ['"red"']],
    ["a namespace member", 'import * as N from "./c";\nuse(N.C);\n', "C", ['"red"']],
    ["nothing from a package", 'import { C } from "pkg";\nuse(C);\n', "C", []],
  ])("follows %s", (_label, source, name, expected) => {
    const other = {
      "c.ts": 'export const C = "red";\nexport default "navy";\n',
      "r.ts": 'export { C as R } from "./c";\n',
    };
    expect(valuesAt(source, name, other)).toEqual(expected);
  });
});
