/**
 * ui-literals against a fixture tree: `fixtures/ui-literals/pass` styles everything
 * through var(--…), holds raw values only in ui/src/design/tokens.css and a test file,
 * and carries the near misses the check must not flag (comments, selectors, token names,
 * copy strings, JSX text). Each failing case copies it to a temp root and writes one
 * offending file.
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

    it("says where the value belongs", () => {
      const [violation] = check.run(rootWith("ui/src/x.ts", 'const s = { color: "#fff" };\n'));
      expect(violation?.next).toContain("ui/src/design/tokens.css");
    });
  });
});
