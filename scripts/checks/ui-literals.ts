/**
 * Components reach design values only through tokens (design D23): outside
 * `ui/src/design/tokens.css`, nothing under `ui/src/` holds a raw color, a font family,
 * or a pixel font size. The keywords `currentColor`, `transparent`, `inherit`, `none`,
 * `initial`, `unset` (and `revert`) are not colors, and `var(--…)` is always allowed.
 *
 * What counts, per file kind:
 *
 * - CSS (`.css`): every declaration value, with comments removed. A raw color is a hex
 *   color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), a color function (`rgb()`,
 *   `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`,
 *   `color()`), or a CSS named color, in any property except those whose values are
 *   author-chosen names (`animation*`, `grid*`, `transition*`, `content`, …). A font
 *   family is any `font-family` value, or family in the `font` shorthand, left once the
 *   `var()` references and keywords are removed. A pixel font size is `Npx` in a
 *   `font-size` or `font` value, var() fallbacks included.
 * - TypeScript (`.ts`, `.tsx`), read with the TypeScript compiler's parser, so comments
 *   and JSX text are never read: a string (or template) given to a CSS-like property —
 *   an object key such as `color`, `backgroundColor`, `"font-family"`, `fontSize`, or a
 *   JSX attribute such as `fill` — is judged as that declaration; a number given to
 *   `fontSize` is a pixel size (React appends px). Any other string is flagged when it
 *   is a hex color as a whole, holds a color function, or holds a CSS declaration of a
 *   color or font property (CSS in a template literal). A bare word such as `"red"` in
 *   an unrelated string is not flagged: copy and variant names use such words.
 *
 * Not scanned: `ui/src/design/tokens.css` (where the values live) and test files
 * (`*.test.ts`, `*.test.tsx`), which never ship and must feed raw values to the
 * token parser's and contrast tests. `ui/src/design/contrast-pairs.ts` is scanned:
 * it holds token names (`--color-…`), which are not colors.
 *
 *   node scripts/checks/ui-literals.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING (no ui/src/), ERR_CHECK_UI_RAW_COLOR,
 * ERR_CHECK_UI_FONT_FAMILY, ERR_CHECK_UI_PIXEL_FONT_SIZE.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, type Check } from "./lib.ts";

const UI_SRC = "ui/src";
const TOKENS = "ui/src/design/tokens.css";
const SCANNED = /\.(css|ts|tsx)$/;
const TEST_FILE = /\.test\.tsx?$/;

const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);
/** Properties whose identifiers are author-chosen names, never colors. */
const NAME_VALUED =
  /^(font|animation|transition|grid|content|counter|list-style|will-change|view-transition|container|anchor|position-anchor|quotes)/;
/** The TypeScript keys and attributes judged as CSS declarations. */
const TS_CSS_PROPERTY =
  /^(-[a-z]+-)?(font|font-family|font-size|.*(color|background|border|outline|fill|stroke|shadow|decoration|caret|filter|mask).*)$/;
const GLOBAL_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const FONT_KEYWORDS = new Set([
  ...GLOBAL_KEYWORDS,
  ..."normal italic oblique bold bolder lighter small-caps ultra-condensed extra-condensed condensed semi-condensed semi-expanded expanded extra-expanded ultra-expanded xx-small x-small small medium large x-large xx-large xxx-large smaller larger caption icon menu message-box small-caption status-bar".split(
    " ",
  ),
]);

const HEX = /(?<![\w&#-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
const WORD = /(?<![\w-])[a-z]+(?![\w(-])/gi;
const PIXELS = /(?<![\w.-])\d*\.?\d+px(?![\w-])/i;
const WHOLE_HEX = /^#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})$/i;

type Rule = "raw" | "family" | "pixel";

interface Finding {
  readonly code: Rule;
  readonly what: string;
}

/** `value` with every `var(…)` call, nested parentheses included, removed. */
function withoutVars(value: string): string {
  let out = value;
  for (let at = out.search(/var\(/i); at !== -1; at = out.search(/var\(/i)) {
    let depth = 0;
    let end = at + 3;
    do {
      if (out[end] === "(") depth += 1;
      if (out[end] === ")") depth -= 1;
      end += 1;
    } while (depth > 0 && end < out.length);
    out = `${out.slice(0, at)} ${out.slice(end)}`;
  }
  return out;
}

const withoutStrings = (value: string): string =>
  value.replace(/url\([^)]*\)/gi, " ").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");

/** What a declaration `property: value` breaks, if anything. */
function judgeDeclaration(property: string, value: string): Finding[] {
  const findings: Finding[] = [];
  const bare = withoutStrings(value);
  for (const match of bare.matchAll(HEX)) findings.push({ code: "raw", what: match[0] });
  for (const match of bare.matchAll(COLOR_FUNCTION))
    findings.push({ code: "raw", what: `${match[0]}…)` });
  if (!NAME_VALUED.test(property)) {
    for (const match of bare.matchAll(WORD)) {
      if (NAMED_COLORS.has(match[0].toLowerCase())) findings.push({ code: "raw", what: match[0] });
    }
  }
  if ((property === "font-size" || property === "font") && PIXELS.test(bare)) {
    findings.push({ code: "pixel", what: PIXELS.exec(bare)?.[0] ?? "" });
  }
  if (property === "font-family" || property === "font") {
    const rest = withoutVars(value)
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " \u0000 ")
      .replace(/[\d.]+[a-z%]*/gi, " ")
      .replace(/[,/]/g, " ")
      .split(/\s+/)
      .filter(
        (word) =>
          word !== "" &&
          !(property === "font" ? FONT_KEYWORDS : GLOBAL_KEYWORDS).has(word.toLowerCase()),
      );
    if (rest.length > 0) findings.push({ code: "family", what: value.trim() });
  }
  return findings;
}

interface Declaration {
  readonly property: string;
  readonly value: string;
  /** Offset of the value's first non-blank character in the scanned text. */
  readonly offset: number;
}

/** The `property: value` declarations in CSS text (comments already blanked). */
function declarations(css: string): Declaration[] {
  const found: Declaration[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i <= css.length; i += 1) {
    const char = css[i];
    if (char === '"' || char === "'") {
      const close = css.indexOf(char, i + 1);
      i = close === -1 ? css.length : close;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth > 0 && char !== undefined) continue;
    if (char !== undefined && char !== ";" && char !== "{" && char !== "}") continue;
    const segment = css.slice(start, i);
    const colon = segment.indexOf(":");
    if (char !== "{" && colon !== -1) {
      const property = segment.slice(0, colon).trim().toLowerCase();
      const value = segment.slice(colon + 1);
      if (/^-{0,2}[a-z][\w-]*$/.test(property)) {
        found.push({
          property,
          value,
          offset: start + colon + 1 + (value.length - value.trimStart().length),
        });
      }
    }
    start = i + 1;
  }
  return found;
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

interface Located extends Finding {
  readonly line: number;
  readonly declaration: string;
}

function scanCss(source: string): Located[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return declarations(css).flatMap(({ property, value, offset }) =>
    judgeDeclaration(property, value).map((finding) => ({
      ...finding,
      line: lineOf(css, offset),
      declaration: `${property}: ${value.trim()}`,
    })),
  );
}

const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`);

/** The CSS property a literal is the value of: an object key or a JSX attribute. */
function propertyOf(node: ts.Node): string | undefined {
  const parent = node.parent;
  let name: ts.Node | undefined;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) name = parent.name;
  else if (ts.isJsxAttribute(parent)) name = parent.name;
  else if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent))
    name = parent.parent.name;
  if (name === undefined) return undefined;
  const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
  const property = text === undefined ? undefined : kebab(text);
  return property !== undefined && TS_CSS_PROPERTY.test(property) ? property : undefined;
}

/** Any string that is not a declared property's value. */
function judgeString(text: string): Finding[] {
  if (WHOLE_HEX.test(text.trim())) return [{ code: "raw", what: text.trim() }];
  const inCss = declarations(text)
    .filter((d) => TS_CSS_PROPERTY.test(d.property))
    .flatMap((d) => judgeDeclaration(d.property, d.value));
  const covered = new Set(inCss.map((f) => f.what));
  const functions = [...text.matchAll(COLOR_FUNCTION)]
    .map((m): Finding => ({ code: "raw", what: `${m[0]}…)` }))
    .filter((f) => !covered.has(f.what));
  return [...inCss, ...functions];
}

function scanTypeScript(path: string, source: string): Located[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const found: Located[] = [];
  const add = (node: ts.Node, findings: readonly Finding[], shown: string): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    for (const finding of findings) found.push({ ...finding, line, declaration: shown });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && !ts.isImportDeclaration(node.parent)) {
      const property = propertyOf(node);
      add(
        node,
        property === undefined ? judgeString(node.text) : judgeDeclaration(property, node.text),
        property === undefined ? node.getText(file) : `${property}: ${node.text}`,
      );
    } else if (ts.isNumericLiteral(node) && propertyOf(node) === "font-size") {
      add(node, [{ code: "pixel", what: `${node.text} (px)` }], `fontSize: ${node.text}`);
    } else if (ts.isTemplateExpression(node)) {
      for (const part of [node.head, ...node.templateSpans.map((span) => span.literal)]) {
        add(part, judgeString(part.text), node.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function files(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return files(root, path);
      return SCANNED.test(entry.name) && !TEST_FILE.test(entry.name) && path !== TOKENS
        ? [path]
        : [];
    });
}

const RULES: Readonly<
  Record<Rule, { code: string; summary: string; expected: string; next: string }>
> = {
  raw: {
    code: "ERR_CHECK_UI_RAW_COLOR",
    summary: "raw color",
    expected: "colors only through semantic tokens, var(--color-…)",
    next: `use the semantic token for the role through var(--…) (${TOKENS}); if none fits, add one there with light and dark values and a contrast pair (the designing-ui skill)`,
  },
  family: {
    code: "ERR_CHECK_UI_FONT_FAMILY",
    summary: "font family",
    expected: "font families only through var(--font-family-…)",
    next: `use var(--font-family-system) or another --font-family-* token from ${TOKENS}; a new family is a design-system change made there`,
  },
  pixel: {
    code: "ERR_CHECK_UI_PIXEL_FONT_SIZE",
    summary: "pixel font size",
    expected: "font sizes only through var(--font-size-…)",
    next: `use a --font-size-* token from ${TOKENS} (the macOS text-style scale); a new size is a design-system change made there`,
  },
};

function run(root: string): FailureDetails[] {
  let paths: string[];
  try {
    paths = files(root, UI_SRC);
  } catch {
    return [
      {
        code: "ERR_CHECK_INPUT_MISSING",
        summary: `${UI_SRC}/ does not exist`,
        expected: `the UI sources under ${UI_SRC}/ (design D8)`,
        actual: "no such directory",
        next: `restore ${UI_SRC}/ from version control, or run the check with --root at a checkout`,
      },
    ];
  }
  return paths.flatMap((path) => {
    const source = readFileSync(join(root, path), "utf8");
    const found = path.endsWith(".css") ? scanCss(source) : scanTypeScript(path, source);
    return found.map((finding): FailureDetails => {
      const rule = RULES[finding.code];
      return {
        code: rule.code,
        summary: `${path}:${String(finding.line)}: ${rule.summary} \`${finding.what}\` outside ${TOKENS}`,
        expected: `${rule.expected} (design D23; ${TOKENS} is the one file that holds raw values)`,
        actual: `\`${finding.declaration}\``,
        next: rule.next,
      };
    });
  });
}

export const check: Check = { name: "ui-literals", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
