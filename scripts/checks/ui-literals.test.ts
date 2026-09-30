/**
 * ui-literals against a fixture tree: `fixtures/ui-literals/pass` styles everything
 * through var(--…), holds raw values only in ui/src/design/tokens.css and a test file,
 * and carries the near misses the check must not flag (comments, selectors, token names,
 * copy strings, JSX text, a local custom property no font property reads, a const given
 * to a non-style attribute, markup comments and script bodies, a Sass line comment).
 * Each failing case copies it to a temp root and writes one offending file.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FailureDetails } from "../lib/fail.ts";
import { check } from "./ui-literals.ts";

const PASS = join(import.meta.dirname, "fixtures", "ui-literals", "pass");
const RAW = "ERR_CHECK_UI_RAW_COLOR";
const FAMILY = "ERR_CHECK_UI_FONT_FAMILY";
const PIXEL = "ERR_CHECK_UI_PIXEL_FONT_SIZE";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rootWith(path: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ui-literals-"));
  dirs.push(dir);
  cpSync(PASS, dir, { recursive: true });
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
  return dir;
}

const codes = (violations: readonly FailureDetails[]): string[] => violations.map((v) => v.code);

describe("ui-literals", () => {
  it("passes when ui/src/ styles only through tokens", () => {
    expect(check.run(PASS)).toEqual([]);
  });

  it("fails when ui/src/ is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-literals-"));
    dirs.push(dir);
    expect(codes(check.run(dir))).toEqual(["ERR_CHECK_INPUT_MISSING"]);
  });

  describe("in CSS", () => {
    it.each([
      ["a 3-digit hex color", ".a { color: #fff; }", [RAW]],
      ["an 8-digit hex color", ".a { background: #FFAA0080; }", [RAW]],
      ["rgb()", ".a { border: 1px solid rgb(0 0 0); }", [RAW]],
      ["rgba()", ".a { color: rgba(0, 0, 0, 0.5); }", [RAW]],
      ["hsl()", ".a { color: hsl(210 50% 40%); }", [RAW]],
      ["hsla()", ".a { color: HSLA(210, 50%, 40%, 1); }", [RAW]],
      ["oklch()", ".a { color: oklch(60% 0.1 250); }", [RAW]],
      ["a named color", ".a { color: red; }", [RAW]],
      ["a named color in any case", ".a { box-shadow: 0 0 0 1px Black; }", [RAW]],
      ["a named color in a custom property", ".a { --local: white; }", [RAW]],
      ["a named color as a var() fallback", ".a { color: var(--x, tomato); }", [RAW]],
      [
        "a named color in a gradient",
        ".a { background: linear-gradient(navy, transparent); }",
        [RAW],
      ],
      ["a raw font family", ".a { font-family: Helvetica, sans-serif; }", [FAMILY]],
      ["a family after a token", ".a { font-family: var(--f), serif; }", [FAMILY]],
      ["a quoted family", '.a { font-family: "SF Mono"; }', [FAMILY]],
      ["a pixel size and a family in the shorthand", ".a { font: 13px Menlo; }", [PIXEL, FAMILY]],
      ["a family in the shorthand", '.a { font: bold var(--font-size-body) "SF Mono"; }', [FAMILY]],
      ["a pixel font size", ".a { font-size: 13px; }", [PIXEL]],
      ["a fractional pixel font size", ".a { font-size: 12.5PX; }", [PIXEL]],
      [
        "a pixel fallback, last in a nested block",
        "@media (min-width: 1px) { .a { font-size: var(--x, 11px) } }",
        [PIXEL],
      ],
      [
        "one finding per literal",
        ".a { border: 1px solid #000; outline: 1px solid #111 }",
        [RAW, RAW],
      ],
      [
        "a pixel size carried by a local custom property",
        ".a{--local-size:11px;font-size:var(--local-size)}",
        [PIXEL],
      ],
      [
        "a family carried by a local custom property",
        ".b{--local-family:Helvetica;font-family:var(--local-family)}",
        [FAMILY],
      ],
      [
        "a pixel size carried through two local custom properties into the shorthand",
        ".a { --b: 11px; --c: var(--b); font: var(--c) var(--font-family-system); }",
        [PIXEL],
      ],
      ["a family in a var() fallback", ".a { font-family: var(--x, Comic Sans MS); }", [FAMILY]],
      ["the CanvasText system color", ".a { color: CanvasText; }", [RAW]],
      ["the AccentColor system color", ".a { background: AccentColor; }", [RAW]],
      ["the ButtonFace system color", ".a { border: 1px solid buttonface; }", [RAW]],
      ["a deprecated system color", ".a { color: WindowText; }", [RAW]],
      ["WebKit's -apple-system-label", ".a { color: -apple-system-label; }", [RAW]],
      [
        "WebKit's -apple-system-control-background",
        ".a { background-color: -apple-system-control-background; }",
        [RAW],
      ],
      ["WebKit's -webkit-link", ".a { color: -webkit-link; }", [RAW]],
    ])("flags %s", (_label, css, expected) => {
      const violations = check.run(rootWith("ui/src/counter/Extra.css", css));
      expect(codes(violations)).toEqual(expected);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/Extra\.css:1: /);
    });

    it("names the line of the offending declaration", () => {
      const violations = check.run(
        rootWith("ui/src/counter/Extra.css", "/* a\n   comment */\n.a {\n  color:\n    #fff;\n}\n"),
      );
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/Extra\.css:5: /);
    });

    it("names the local declaration a font property reads, not the reading line", () => {
      const violations = check.run(
        rootWith(
          "ui/src/counter/Extra.css",
          ".a {\n  --size: 11px;\n}\n.b {\n  font-size: var(--size);\n}\n",
        ),
      );
      expect(codes(violations)).toEqual([PIXEL]);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/Extra\.css:2: /);
      expect(violations[0]?.actual).toContain("--size: 11px, read as font-size");
    });

    it("follows a custom property declared in TypeScript into CSS", () => {
      const root = rootWith("ui/src/counter/local.ts", 'export const s = { "--size": "11px" };\n');
      writeFileSync(join(root, "ui/src/counter/Extra.css"), ".a { font-size: var(--size); }\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual([PIXEL]);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/local\.ts:1: /);
    });

    it.each([
      ["a Sass variable holding a named color", "$accent: red;", [RAW]],
      ["a hex color in a nested rule", ".a { &:hover { color: #fff; } }", [RAW]],
      [
        "a pixel size carried by a Sass variable",
        "$size: 11px;\n.a { font-size: $size; }",
        [PIXEL],
      ],
    ])("flags %s in .scss", (_label, scss, expected) => {
      const violations = check.run(rootWith("ui/src/counter/Extra.scss", `${scss}\n`));
      expect(codes(violations)).toEqual(expected);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/Extra\.scss:1: /);
    });

    it("exempts ui/src/design/tokens.css only, not another tokens.css", () => {
      expect(codes(check.run(rootWith("ui/src/other/tokens.css", ":root { --a: #fff; }")))).toEqual(
        [RAW],
      );
    });
  });

  describe("in TypeScript", () => {
    it.each([
      ["a hex color in a style object", 'const s = { color: "#fff" };', [RAW]],
      ["a whole-literal hex color", 'export const accent = "#0062cc";', [RAW]],
      ["rgb() in any string", 'const c = "rgb(1, 2, 3)";', [RAW]],
      ["a named color on a color property", 'const s = { backgroundColor: "white" };', [RAW]],
      ["a named color under a quoted CSS key", 'const s = { "border-color": "Navy" };', [RAW]],
      ["a raw font family", 'const s = { fontFamily: "Menlo" };', [FAMILY]],
      ["a raw font family under a CSS key", 'const s = { "font-family": "Menlo" };', [FAMILY]],
      ["a numeric font size (React adds px)", "const s = { fontSize: 13 };", [PIXEL]],
      ["a pixel font size string", 'const s = { fontSize: "13px" };', [PIXEL]],
      [
        "CSS in a template literal",
        "const css = `.a { color: #abc; font-family: Menlo; }`;",
        [RAW, FAMILY],
      ],
      [
        "a color in a template with substitutions",
        "const css = `color: ${c}; background: #000`;",
        [RAW],
      ],
      ["hsl() in a template head", "const css = `hsl(1 2% 3%) ${x}`;", [RAW]],
      ["a named color on a custom property key", 'const s = { "--accent": "green" };', [RAW]],
      [
        "a family in a var() fallback",
        'const s = { fontFamily: "var(--x, Comic Sans MS)" };',
        [FAMILY],
      ],
      ["a named color held by a const", 'const WARN = "red"; const s = { color: WARN };', [RAW]],
      [
        "a named color held by a const through another const, as const",
        'const A = "red" as const; const B = A; const s = { color: (B) };',
        [RAW],
      ],
      ["a named color in shorthand", 'const color = "navy"; const s = { color };', [RAW]],
      [
        "a numeric font size held by a const",
        "const SIZE = 13; const s = { fontSize: SIZE };",
        [PIXEL],
      ],
      [
        "a hex color held by a const, reported once",
        'const A = "#fff"; const s = { color: A };',
        [RAW],
      ],
      ["a pixel size built by a template", "const s = { fontSize: `${14}px` };", [PIXEL]],
      [
        "a pixel size built from a value it cannot read",
        "const s = { fontSize: `${n}px` };",
        [PIXEL],
      ],
      ["a named color under a computed key", 'const s = { ["color"]: "blue" };', [RAW]],
      [
        "a named color under a computed key held by a const",
        'const K = "backgroundColor"; const s = { [K]: "blue" };',
        [RAW],
      ],
      [
        "a named color in one branch of a conditional",
        'const s = { color: dark ? "white" : "var(--x)" };',
        [RAW],
      ],
      ["a named color after ??", 'const s = { color: given ?? "black" };', [RAW]],
      ["an assignment to style.color", 'el.style.color = "red";', [RAW]],
      ["an assignment through style[…]", 'el.style["font-family"] = "Menlo";', [FAMILY]],
      ["an assignment to a style variable", 'style.fontSize = "30px";', [PIXEL]],
      ["style.setProperty", 'el.style.setProperty("font-size", "30px");', [PIXEL]],
      ["setProperty on a custom property", 'el.style.setProperty("--accent", "green");', [RAW]],
      [
        "a local custom property in a style object",
        'const s = { "--s": "11px", fontSize: "var(--s)" };',
        [PIXEL],
      ],
      [
        "a local custom property in CSS in a template literal",
        "const css = `--f: Menlo; font-family: var(--f);`;",
        [FAMILY],
      ],
    ])("flags %s", (_label, source, expected) => {
      const violations = check.run(rootWith("ui/src/counter/extra.ts", `${source}\n`));
      expect(codes(violations)).toEqual(expected);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/extra\.ts:1: /);
    });

    it.each([
      ["a JSX attribute", '<svg fill="red" />', [RAW]],
      ["a JSX attribute expression", '<svg stroke={"#123456"} />', [RAW]],
      ["an inline style", "<p style={{ fontSize: 11, fontFamily: `Menlo` }} />", [PIXEL, FAMILY]],
    ])("flags %s", (_label, jsx, expected) => {
      const source = `export const X = () => (\n  ${jsx}\n);\n`;
      const violations = check.run(rootWith("ui/src/counter/Extra.tsx", source));
      expect(codes(violations)).toEqual(expected);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/Extra\.tsx:2: /);
    });

    it.each([["extra.js"], ["extra.jsx"], ["extra.mjs"], ["extra.mts"]])("reads %s", (name) => {
      const violations = check.run(
        rootWith(`ui/src/counter/${name}`, 'const s = { color: "#fff" };\n'),
      );
      expect(codes(violations)).toEqual([RAW]);
    });

    it("skips a JavaScript test file", () => {
      expect(
        check.run(rootWith("ui/src/counter/x.test.js", 'const s = { color: "#fff" };\n')),
      ).toEqual([]);
    });

    it("names the line where a const is used", () => {
      const violations = check.run(
        rootWith(
          "ui/src/counter/Extra.tsx",
          'const WARN = "red";\nexport const X = () => <p style={{ color: WARN }} />;\n',
        ),
      );
      expect(codes(violations)).toEqual([RAW]);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/Extra\.tsx:2: /);
      expect(violations[0]?.actual).toContain('color: WARN ("red")');
    });

    it("says where the value belongs", () => {
      const [violation] = check.run(rootWith("ui/src/x.ts", 'const s = { color: "#fff" };\n'));
      expect(violation?.next).toContain("ui/src/design/tokens.css");
    });
  });

  describe("in markup", () => {
    it.each([
      ["an inline style", '<body style="font-family: Helvetica">', [FAMILY]],
      ["a <style> element", "<style>.a { color: #000; }</style>", [RAW]],
      ["a color attribute", '<svg fill="red"></svg>', [RAW]],
    ])("flags %s in ui/index.html", (_label, html, expected) => {
      const violations = check.run(rootWith("ui/index.html", `${html}\n`));
      expect(codes(violations)).toEqual(expected);
      expect(violations[0]?.summary).toMatch(/^ui\/index\.html:1: /);
    });

    it.each([
      ["a fill", '<svg><path fill="red" d="M0 0"/></svg>', [RAW]],
      ["a stop-color", "<svg><stop stop-color='#123456'/></svg>", [RAW]],
      ["a unitless font-size", '<svg><text font-size="12">A</text></svg>', [PIXEL]],
      ["a font-family attribute", '<svg><text font-family="Menlo">A</text></svg>', [FAMILY]],
      ["a style attribute", '<svg><text style="font-size: 12px">A</text></svg>', [PIXEL]],
      ["a <style> element", "<svg><style>.a { fill: navy }</style></svg>", [RAW]],
    ])("flags %s in an .svg", (_label, svg, expected) => {
      const violations = check.run(rootWith("ui/src/design/icon.svg", `${svg}\n`));
      expect(codes(violations)).toEqual(expected);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/design\/icon\.svg:1: /);
    });

    it("names the line of a <style> declaration", () => {
      const violations = check.run(
        rootWith(
          "ui/src/page.html",
          "<html>\n<style>\n.a {\n  color: red;\n}\n</style>\n</html>\n",
        ),
      );
      expect(violations[0]?.summary).toMatch(/^ui\/src\/page\.html:4: /);
    });
  });
});
