/**
 * ui-literals against a fixture tree: `fixtures/ui-literals/pass` styles everything
 * through var(--…), holds raw values only in ui/src/design/tokens.css and a test file,
 * and carries the near misses the check must not flag (comments, selectors, token names,
 * copy strings, JSX text, a local custom property no font property reads, a const given
 * to a non-style attribute, markup comments, a script that loads a file, a Sass line
 * comment). Each failing case copies it to a temp root and writes the offending files.
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
const UNSUPPORTED = "ERR_CHECK_UI_UNSUPPORTED_FILE";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rootWith(path: string, content: string, others: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ui-literals-"));
  dirs.push(dir);
  cpSync(PASS, dir, { recursive: true });
  for (const [file, text] of Object.entries({ ...others, [path]: content })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
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

    it.each([
      ["an href fragment", '<a href="#add">x</a>'],
      ["another href fragment", '<a href="#face">x</a>'],
      ["an href fragment in braces", '<a href={"#decade"}>x</a>'],
      ["an aria-controls id", '<button aria-controls="#bead">x</button>'],
    ])("does not flag %s as a color", (_label, jsx) => {
      const source = `export const L = () => (\n  ${jsx}\n);\n`;
      expect(check.run(rootWith("ui/src/counter/Link.tsx", source))).toEqual([]);
    });

    it.each([
      ["a style color", '<p style={{ color: "#add" }} />'],
      ["a fill", '<svg fill="#add" />'],
      ["a const read as a color", '<a href="#add">{(() => { const c = "#add"; return c; })()}</a>'],
    ])("still flags a hex-looking %s", (_label, jsx) => {
      const source = `export const L = () => (\n  ${jsx}\n);\n`;
      expect(codes(check.run(rootWith("ui/src/counter/Link.tsx", source)))).toEqual([RAW]);
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

    describe("through an import", () => {
      const palette = {
        "ui/src/counter/palette.ts": [
          'export const WARN = "red";',
          'export const TONES = { calm: "navy" } as const;',
          'export default "tomato";',
          "",
        ].join("\n"),
        "ui/src/counter/index.ts":
          'export { WARN as ALERT } from "./palette";\nexport * from "./palette";\n',
      };
      const use = (lines: string): string =>
        rootWith("ui/src/counter/Use.tsx", `${lines}\nexport const s = { color: X };\n`, palette);

      it.each([
        ["a named import", 'import { WARN as X } from "./palette";', "red"],
        ["an import with a .ts extension", 'import { WARN as X } from "./palette.ts";', "red"],
        ["an import with a .js extension", 'import { WARN as X } from "./palette.js";', "red"],
        ["a default import", 'import X from "./palette";', "tomato"],
        ["a renamed re-export", 'import { ALERT as X } from "./index";', "red"],
        ["an export * re-export", 'import { WARN as X } from ".";', "red"],
        ["a namespace import", 'import * as P from "./palette";\nconst X = P.WARN;', "red"],
        [
          "a member of an imported const object",
          'import { TONES } from "./palette";\nconst X = TONES.calm;',
          "navy",
        ],
      ])("flags a named color reached through %s", (_label, lines, color) => {
        const violations = check.run(use(lines));
        expect(codes(violations)).toEqual([RAW]);
        expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/Use\.tsx:\d+: raw color/);
        expect(violations[0]?.summary).toContain(`\`${color}\``);
      });

      it("reports a raw value the other module flags once, where it is declared", () => {
        const violations = check.run(
          rootWith(
            "ui/src/counter/Use.tsx",
            'import { ACCENT } from "./accent";\nexport const s = { color: ACCENT };\n',
            { "ui/src/counter/accent.ts": 'export const ACCENT = "#0062cc";\n' },
          ),
        );
        expect(codes(violations)).toEqual([RAW]);
        expect(violations[0]?.summary).toMatch(/^ui\/src\/counter\/accent\.ts:1: /);
      });

      it.each([
        [
          "an imported bare word used as copy",
          'import { WARN } from "./palette";\nexport const t = `${WARN} alert`;',
        ],
        [
          "a name from a package",
          'import { color as X } from "some-package";\nexport const s = { color: X };',
        ],
        [
          "a name from a module the check does not scan",
          'import { X } from "./missing";\nexport const s = { color: X };',
        ],
      ])("does not flag %s", (_label, source) => {
        expect(check.run(rootWith("ui/src/counter/Use.ts", `${source}\n`, palette))).toEqual([]);
      });
    });

    it.each([
      [
        "every value a let is given",
        'let D = "blue";\nD = "green";\nexport const s = { background: D };',
        ["blue", "green"],
      ],
      [
        "a value a var is given by a logical assignment",
        'var D;\nD ??= "white";\nexport const s = { color: D };',
        ["white"],
      ],
    ])("flags %s", (_label, source, colors) => {
      const violations = check.run(rootWith("ui/src/counter/extra.ts", `${source}\n`));
      expect(codes(violations)).toEqual(colors.map(() => RAW));
      for (const [i, color] of colors.entries()) {
        expect(violations[i]?.summary).toContain(`\`${color}\``);
        expect(violations[i]?.summary).toMatch(/^ui\/src\/counter\/extra\.ts:3: /);
      }
    });

    it("does not flag a let that only ever holds tokens", () => {
      const source = 'let D = "var(--a)";\nD = "var(--b)";\nexport const s = { color: D };\n';
      expect(check.run(rootWith("ui/src/counter/extra.ts", source))).toEqual([]);
    });

    describe("resolving each binding once", () => {
      const timed = (root: string): { ms: number; found: readonly FailureDetails[] } => {
        const start = performance.now();
        const found = check.run(root);
        return { ms: performance.now() - start, found };
      };

      it("reads a let assigned from itself many times without blowing up", () => {
        const lines = ['let c = "red";', 'let shadow = "0 0 1px navy";', 'let x = "var(--a)";'];
        for (let i = 0; i < 14; i += 1) {
          lines.push(
            `if (p${String(i)}) { c = p ? c : "var(--b)"; shadow = \`\${shadow}, 0 0 ${String(i)}px var(--s)\`; x = x ?? y; }`,
          );
        }
        lines.push("export const s = { color: c, boxShadow: shadow, background: x };");
        const { ms, found } = timed(rootWith("ui/src/counter/loop.ts", `${lines.join("\n")}\n`));
        expect(codes(found)).toEqual([RAW, RAW]);
        expect(found.map((v) => v.summary.split("`")[1])).toEqual(["red", "navy"]);
        expect(ms).toBeLessThan(1000);
      });

      it("reads a diamond of consts across modules without re-walking it", () => {
        const others: Record<string, string> = {
          "ui/src/counter/d0.ts": 'export const A0 = "tomato";\nexport const B0 = "navy";\n',
        };
        for (let level = 1; level <= 14; level += 1) {
          const [a, b, prev] = [`A${String(level)}`, `B${String(level)}`, String(level - 1)];
          others[`ui/src/counter/d${String(level)}.ts`] = [
            `import { A${prev}, B${prev} } from "./d${prev}";`,
            `export const ${a} = p ? A${prev} : B${prev};`,
            `export const ${b} = q ? B${prev} : A${prev};`,
            "",
          ].join("\n");
        }
        const root = rootWith(
          "ui/src/counter/Use.ts",
          'import { A14 } from "./d14";\nexport const s = { color: A14 };\n',
          others,
        );
        const { ms, found } = timed(root);
        expect(codes(found)).toEqual([RAW, RAW]);
        expect(found.map((v) => v.summary.split("`")[1]).sort()).toEqual(["navy", "tomato"]);
        expect(ms).toBeLessThan(1000);
      });

      it("gives every binding in a cycle everything the cycle reaches", () => {
        const source = [
          'let a = "red";',
          'let b = "navy";',
          "a = b;",
          "b = a;",
          "export const s = { color: a };",
          "export const t = { background: b };",
          "",
        ].join("\n");
        const found = check.run(rootWith("ui/src/counter/cycle.ts", source));
        expect(found.map((v) => v.summary.split("`")[1]).sort()).toEqual([
          "navy",
          "navy",
          "red",
          "red",
        ]);
      });
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

    it.each([
      ["a theme-color meta", '<meta name="theme-color" content="#ff0000">', [RAW]],
      ["a theme-color meta, content first", "<meta content=red name='Theme-Color' />", [RAW]],
      [
        "a msapplication-TileColor meta",
        '<meta name="msapplication-TileColor" content="#fff">',
        [RAW],
      ],
    ])("flags %s", (_label, html, expected) => {
      const violations = check.run(rootWith("ui/index.html", `${html}\n`));
      expect(codes(violations)).toEqual(expected);
      expect(violations[0]?.summary).toMatch(/^ui\/index\.html:1: /);
      expect(violations[0]?.next).toContain("var() cannot appear in a meta's content");
    });

    it.each([
      ["a description meta", '<meta name="description" content="A red app">'],
      ["a color-scheme meta", '<meta name="color-scheme" content="light dark">'],
      ["a script that loads a file", '<script type="module" src="/src/main.tsx"></script>'],
      ["an empty inline script", "<script>\n</script>"],
      [
        "a JSON block, which is data",
        '<script type="application/json">{ "a": "#ff0000" }</script>',
      ],
      [
        "a JSON-LD block, which is data",
        '<script type="application/ld+json">{ "color": "red" }</script>',
      ],
      [
        "an import map, which is data",
        '<script type=importmap>{ "imports": { "#fff": "./x.js" } }</script>',
      ],
    ])("does not flag %s", (_label, html) => {
      expect(check.run(rootWith("ui/index.html", `${html}\n`))).toEqual([]);
    });

    it.each([
      ["a classic script", "<script>", 'document.body.style.color = "red";', [RAW]],
      [
        "a module script",
        '<script type="module">',
        'document.documentElement.style.setProperty("font-size", "30px");',
        [PIXEL],
      ],
      ["an SVG script", '<script type="text/ecmascript">', 'el.style.fill = "#123";', [RAW]],
    ])("flags a style set in %s, on its line in the markup", (_label, open, body, expected) => {
      const violations = check.run(
        rootWith("ui/index.html", `<!doctype html>\n${open}\n  ${body}\n</script>\n`),
      );
      expect(codes(violations)).toEqual(expected);
      expect(violations[0]?.summary).toMatch(/^ui\/index\.html:3: /);
    });

    it("reads an inline script with the scripts it imports", () => {
      const violations = check.run(
        rootWith(
          "ui/index.html",
          '<script type="module">\nimport { WARN } from "./src/tone.ts";\ndocument.body.style.color = WARN;\n</script>\n',
          { "ui/src/tone.ts": 'export const WARN = "red";\n' },
        ),
      );
      expect(codes(violations)).toEqual([RAW]);
      expect(violations[0]?.summary).toMatch(/^ui\/index\.html:3: /);
    });

    it("fails on a script whose type it does not read instead of passing it unread", () => {
      const violations = check.run(
        rootWith(
          "ui/index.html",
          '<script type="text/x-template">\n<p style="color: red"></p>\n</script>\n',
        ),
      );
      expect(codes(violations)).toEqual([UNPARSED]);
      expect(violations[0]?.summary).toMatch(/^ui\/index\.html:1: unreadable script/);
      expect(violations[0]?.expected).not.toContain("raw values");
    });

    it("fails on a script that never closes, and does not read what follows as markup", () => {
      const violations = check.run(
        rootWith("ui/index.html", '<p></p>\n<script>\n<p style="color: red"></p>\n'),
      );
      expect(codes(violations)).toEqual([UNPARSED]);
      expect(violations[0]?.summary).toMatch(/^ui\/index\.html:2: unreadable script `<script>`$/);
      expect(violations[0]?.next).toContain("</script>");
    });

    it("fails on an inline script with a syntax error, at its line", () => {
      const violations = check.run(
        rootWith(
          "ui/index.html",
          '<script>\nconst = ;\ndocument.body.style.color = "var(--x)";\n</script>\n',
        ),
      );
      expect(codes(violations)).toEqual([UNPARSED]);
      expect(violations[0]?.summary).toMatch(/^ui\/index\.html:2: unreadable script/);
      expect(violations[0]?.next).toContain("syntax");
    });

    it("leaves a syntax error under ui/src/ to tsc and ESLint", () => {
      const source = 'const = ;\nexport const s = { color: "var(--x)" };\n';
      expect(check.run(rootWith("ui/src/counter/broken.ts", source))).toEqual([]);
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
  describe("across ui/", () => {
    it.each([
      ["another entry page", "ui/other.html", '<p style="color: #ff0000"></p>\n'],
      ["a stylesheet in ui/public/", "ui/public/x.css", ".a { color: #ff0000; }\n"],
      ["a PostCSS file in ui/public/", "ui/public/x.postcss", ".a { color: #ff0000; }\n"],
      ["an .htm entry page", "ui/page.htm", '<p style="color: #ff0000"></p>\n'],
      ["an .xhtml entry page", "ui/page.xhtml", '<p style="color: #ff0000"></p>\n'],
      ["a PostCSS file", "ui/src/counter/x.pcss", ".a { color: #ff0000; }\n"],
    ])("flags a raw color in %s", (_label, path, content) => {
      const violations = check.run(rootWith(path, content));
      expect(codes(violations)).toEqual([RAW]);
      expect(violations[0]?.summary.startsWith(`${path}:1: `)).toBe(true);
    });

    it.each([
      ["a .less file", "ui/src/x.less", ".a { color: #ff0000; }\n"],
      ["a .sass file", "ui/src/y.sass", ".a\n  color: #ff0000\n"],
      ["a Stylus file in ui/public/", "ui/public/z.styl", ".a\n  color #ff0000\n"],
      ["a .stylus file", "ui/src/z.stylus", ".a\n  color #ff0000\n"],
      ["a SugarSS file", "ui/src/z.sss", ".a\n  color: #ff0000\n"],
      ["an .htm file under ui/src/", "ui/src/page.htm", "<p></p>\n"],
      ["an .xhtml file in ui/public/", "ui/public/page.xhtml", "<p></p>\n"],
      ["a Vue component", "ui/src/X.vue", "<template><p /></template>\n"],
      ["a Svelte component", "ui/src/X.svelte", "<p>x</p>\n"],
      ["an MDX page", "ui/src/x.mdx", "# X\n"],
      ["an Astro page", "ui/src/x.astro", "<p>x</p>\n"],
    ])("refuses %s rather than passing it unread", (_label, path, content) => {
      const violations = check.run(rootWith(path, content));
      const ext = /\.[^.]+$/.exec(path)?.[0] ?? "";
      expect(codes(violations)).toEqual([UNSUPPORTED]);
      expect(violations[0]?.summary).toBe(`${path}:1: this check cannot read \`${ext}\``);
      expect(violations[0]?.expected).not.toContain("raw values");
      expect(violations[0]?.next).toContain(`this check cannot read ${ext} files`);
      expect(violations[0]?.next).toContain("write the styles as CSS using the tokens");
    });

    it.each([
      ["an SVG in ui/public/, loaded as an image", "ui/public/icon.svg", '<svg fill="#ff0000"/>\n'],
      ["a vendored script in ui/public/", "ui/public/x.js", 'const c = "#ff0000";\n'],
      ["a page in ui/public/", "ui/public/x.html", '<p style="color: #ff0000"></p>\n'],
      ["a stylesheet outside ui/src/ and ui/public/", "ui/other/x.css", ".a { color: red; }\n"],
    ])("does not judge %s", (_label, path, content) => {
      expect(check.run(rootWith(path, content))).toEqual([]);
    });

    it("skips node_modules and ui/'s test files", () => {
      const root = rootWith("ui/node_modules/pkg/a.css", ".a { color: red; }\n", {
        "ui/public/x.test.js": 'const s = { color: "#fff" };\n',
      });
      expect(check.run(root)).toEqual([]);
    });
  });
});
