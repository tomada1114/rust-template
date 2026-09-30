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
const UNPARSED = "ERR_CHECK_UI_UNPARSED";

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

    it("does not tie a custom property to a same-named read in another file", () => {
      const root = rootWith("ui/src/counter/A.css", ".icon{--size:16px;width:var(--size)}\n");
      writeFileSync(join(root, "ui/src/counter/B.css"), ".t{font-size:var(--size)}\n");
      writeFileSync(
        join(root, "ui/src/counter/local.ts"),
        'export const s = { "--size": "11px" };\n',
      );
      expect(check.run(root)).toEqual([]);
    });

    it("ties a read to the declaration in its own rule before any other in the file", () => {
      const violations = check.run(
        rootWith(
          "ui/src/counter/Extra.css",
          ".icon{--size:16px;width:var(--size)}\n.t{--size:13px;font-size:var(--size)}\n",
        ),
      );
      expect(codes(violations)).toEqual([PIXEL]);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/Extra\.css:2: /);
      expect(violations[0]?.actual).toContain("--size: 13px");
    });

    it.each([
      ["a system-font keyword in a custom property", ".a { --f: menu; font: var(--f); }"],
      [
        "a system-color word in a property that takes no color",
        ".a { appearance: menulist; cursor: default; }",
      ],
      ["a system-color word as an animation name", ".a { animation-name: highlight; }"],
    ])("does not flag %s", (_label, css) => {
      expect(check.run(rootWith("ui/src/counter/Extra.css", `${css}\n`))).toEqual([]);
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
      ["a named color after ||", 'const s = { color: given || "black" };', [RAW]],
      ["a named color after &&", 'const s = { color: dark && "white" };', [RAW]],
      [
        "both named colors a const conditional holds",
        'const C = dark ? "white" : "black"; const s = { color: C };',
        [RAW, RAW],
      ],
      [
        "a named color in a member of a const object",
        'const P = { warn: "red" } as const; const s = { color: P.warn };',
        [RAW],
      ],
      [
        "a named color in an indexed member of a const object",
        'const P = { tone: { warn: "red" } }; const s = { color: P.tone["warn"] };',
        [RAW],
      ],
      [
        "a hex color a const holds, used in a template, reported once",
        'const BG = "#fff"; const s = { border: `1px solid ${BG}` };',
        [RAW],
      ],
      [
        "a named color a const holds, used in a template",
        'const BG = "navy"; const s = { border: `1px solid ${BG}` };',
        [RAW],
      ],
      ["a system color on a style key", 'const s = { color: "CanvasText" };', [RAW]],
      [
        "a system color as a custom property's whole value",
        'const s = { "--accent": "AccentColor" };',
        [RAW],
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

    it.each([
      [
        "copy under keys that merely contain color words",
        'export const copy = { filterHint: "Filter the window list", backgroundLabel: "Keep running in the background" };',
      ],
      [
        "a system-color word in copy that looks like a declaration",
        'export const s = "Background: Menu bar only";',
      ],
      ["a component's color prop", 'export const X = () => <Badge color="highlight" />;'],
      [
        "a parameter that shadows a const",
        'const tone = "red";\nexport const s = (tone: string) => ({ color: tone });',
      ],
      [
        "an inner const that shadows an outer one",
        'const c = "red";\nexport function f() { const c = "var(--x)"; return { color: c }; }',
      ],
      [
        "$-prefixed keys, which are Sass variables only in .scss",
        'export const s = { $type: "menu", "$c": "green" };',
      ],
    ])("does not flag %s", (_label, source) => {
      expect(check.run(rootWith("ui/src/counter/Extra.tsx", `${source}\n`))).toEqual([]);
    });

    it("flags a system color on an SVG element's attribute", () => {
      const violations = check.run(
        rootWith("ui/src/counter/Extra.tsx", 'export const X = () => <svg fill="Highlight" />;\n'),
      );
      expect(codes(violations)).toEqual([RAW]);
    });

    it("reports a raw value a const holds where it is declared, not again at each use", () => {
      const violations = check.run(
        rootWith(
          "ui/src/counter/Extra.tsx",
          'const BG = "#fff";\nexport const a = { border: `1px solid ${BG}` };\nexport const b = { color: BG };\n',
        ),
      );
      expect(codes(violations)).toEqual([RAW]);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/Extra\.tsx:1: /);
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

    it("reads an attribute that follows a quoted value with no space", () => {
      const violations = check.run(
        rootWith("ui/src/design/icon.svg", '<svg><path d="M0"fill="red"/></svg>\n'),
      );
      expect(codes(violations)).toEqual([RAW]);
    });

    it.each([
      [
        "a tag that never closes, whose attributes read so far still count",
        '<svg fill="red"',
        [UNPARSED, RAW],
      ],
      ["a stray quote in a tag", '<svg "fill"="red"></svg>', [UNPARSED]],
      ["a value whose quote never closes", '<svg fill="red></svg>', [UNPARSED]],
    ])("fails on %s instead of passing it unread", (_label, svg, expected) => {
      const violations = check.run(rootWith("ui/src/design/icon.svg", `${svg}\n`));
      expect(codes(violations)).toEqual(expected);
      expect(violations[0]?.summary).toMatch(/^ui\/src\/design\/icon\.svg:1: unreadable tag/);
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
