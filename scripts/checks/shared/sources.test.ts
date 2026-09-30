/**
 * The source helpers the UI checks share: file classes, blanking, and name resolution
 * through a checker over the files given.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  bindingValues,
  blank,
  constInitializer,
  memberName,
  moduleOrigins,
  parseScripts,
  SCRIPT_FILE,
  TEST_FILE,
} from "./sources.ts";

/** Every identifier named `name` in `source`, in order, and a checker over that one file. */
function identifiers(path: string, source: string, name: string) {
  const { files, checker } = parseScripts([{ path, source }]);
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  const file = files.get(path);
  if (file !== undefined) visit(file);
  return { checker, found };
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

/** The origins `moduleOrigins` finds for the callee of the call `use.ts` ends with. */
function calleeOrigins(use: string, other: Record<string, string> = {}) {
  const { files, checker } = parseScripts([
    ...Object.entries(other).map(([path, source]) => ({ path, source })),
    { path: "use.ts", source: use },
  ]);
  const last = files.get("use.ts")?.statements.at(-1);
  return last !== undefined &&
    ts.isExpressionStatement(last) &&
    ts.isCallExpression(last.expression)
    ? moduleOrigins(checker, last.expression.expression)
    : "missing";
}

describe("moduleOrigins", () => {
  it.each([
    ['import { invoke as call } from "m";\ncall();\n', { module: "m", name: "invoke" }],
    ['import { listen } from "m";\nlisten();\n', { module: "m", name: "listen" }],
    ['import * as core from "m";\ncore.x();\n', { module: "m", name: "x" }],
    ['import * as core from "m";\ncore["x"]();\n', { module: "m", name: "x" }],
    ['import * as core from "m";\n(core as never).x!();\n', { module: "m", name: "x" }],
    ['import core from "m";\ncore();\n', { module: "m", name: "default" }],
    ['import { f } from "m";\nconst g = f;\ng();\n', { module: "m", name: "f" }],
  ])("reads %j", (source, expected) => {
    expect(calleeOrigins(source)).toEqual([expected]);
  });

  it.each([
    ["a local const", "const local = () => 1;\nlocal();\n"],
    ["a name bound nowhere", "unbound();\n"],
    ["a let", 'import { f } from "m";\nlet g = f;\ng();\n'],
    ["a call's result", 'import { f } from "m";\nf()();\n'],
    ["a member of a module's named export", 'import { f } from "m";\nf.x();\n'],
    ["a computed member", 'import * as core from "m";\ncore[k]();\n'],
  ])("finds none for %s", (_label, source) => {
    expect(calleeOrigins(source)).toEqual([]);
  });

  const USE = 'import { invoke } from "./re";\ninvoke();\n';
  it.each([
    ["a named re-export", 'export { invoke } from "m";\n', USE],
    [
      "an import exported under another name",
      'import { invoke as i } from "m";\nexport { i as invoke };\n',
      USE,
    ],
    ["a star re-export", 'export * from "m";\n', USE],
    ["a star re-export of a star re-export", 'export * from "./inner";\n', USE],
    [
      "an exported const alias",
      'import { invoke } from "m";\nexport const call = invoke;\n',
      'import { call } from "./re";\ncall();\n',
    ],
    [
      "a default export",
      'import { invoke } from "m";\nexport default invoke;\n',
      'import run from "./re";\nrun();\n',
    ],
  ])("follows %s in another file", (_label, re, use) => {
    const other = { "re.ts": re, "inner.ts": 'export * from "m";\n' };
    expect(calleeOrigins(use, other)).toEqual([{ module: "m", name: "invoke" }]);
  });

  it("follows a namespace import of a file that re-exports", () => {
    const other = { "re.ts": 'export * as core from "m";\n' };
    expect(calleeOrigins('import * as re from "./re";\nre.core.invoke();\n', other)).toEqual([
      { module: "m", name: "invoke" },
    ]);
  });

  it("gives one origin per outside module a star re-export may take the name from", () => {
    const other = { "re.ts": 'export * from "a";\nexport * from "b";\n' };
    expect(calleeOrigins('import { f } from "./re";\nf();\n', other)).toEqual([
      { module: "a", name: "f" },
      { module: "b", name: "f" },
    ]);
  });

  it("finds none for a function a file of the program declares, however it is re-exported", () => {
    const other = {
      "memo.ts": "export function once(f: () => void) { return f; }\n",
      "re.ts": 'export * from "./memo";\nexport { once as twice } from "./memo";\n',
    };
    expect(calleeOrigins('import { once } from "./re";\nonce(() => {});\n', other)).toEqual([]);
    expect(calleeOrigins('import { twice } from "./re";\ntwice(() => {});\n', other)).toEqual([]);
  });

  it("stops at a star re-export cycle", () => {
    const other = { "a.ts": 'export * from "./b";\n', "b.ts": 'export * from "./a";\n' };
    expect(calleeOrigins('import { f } from "./a";\nf();\n', other)).toEqual([]);
  });

  it("stops at a const cycle", () => {
    expect(calleeOrigins("const a = b;\nconst b = a;\na();\n")).toEqual([]);
  });
});

describe("memberName", () => {
  it.each([
    ["x.y", "y"],
    ['x["y"]', "y"],
    ["x[`y`]", "y"],
    ["x[y]", undefined],
    ["x", undefined],
  ])("reads %s", (source, expected) => {
    const { files } = parseScripts([{ path: "m.ts", source: `${source};\n` }]);
    const statement = files.get("m.ts")?.statements[0];
    const expression =
      statement !== undefined && ts.isExpressionStatement(statement)
        ? statement.expression
        : undefined;
    expect(expression === undefined ? "missing" : memberName(expression)).toBe(expected);
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
  it.each([
    ["x.tsx", ts.LanguageVariant.JSX],
    ["x.jsx", ts.LanguageVariant.JSX],
    ["x.mjs", ts.LanguageVariant.JSX],
    ["x.ts", ts.LanguageVariant.Standard],
  ])("parses %s as its own kind", (path, variant) => {
    const { files } = parseScripts([{ path, source: "export const x = 1;\n" }]);
    expect(files.get(path)?.languageVariant).toBe(variant);
  });

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
