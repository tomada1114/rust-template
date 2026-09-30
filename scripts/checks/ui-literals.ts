/**
 * Components reach design values only through tokens (design D23): outside
 * `ui/src/design/tokens.css`, nothing under `ui/src/` — nor `ui/index.html` — holds a
 * raw color, a font family, or a pixel font size. The keywords `currentColor`,
 * `transparent`, `inherit`, `none`, `initial`, `unset` (and `revert`) are not colors,
 * and `var(--…)` is always allowed.
 *
 * What counts, per file kind:
 *
 * - CSS (`.css`, `.scss`): every declaration value, with comments removed (and `//`
 *   line comments in `.scss`, whose `$variables` are judged like custom properties). A
 *   raw color is a hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), a color function
 *   (`rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`,
 *   `oklch()`, `color()`), a CSS named color, a CSS system color (`Canvas`,
 *   `CanvasText`, `AccentColor`, `ButtonFace`, …, the deprecated ones included), or one
 *   of WebKit's own (`-apple-system-label`, `-apple-system-control-background`,
 *   `-webkit-link`, …), in any property except those whose values are author-chosen
 *   names (`animation*`, `grid*`, `transition*`, `content`, …). A font family is any
 *   `font-family` value, or family in the `font` shorthand, left once the keywords are
 *   removed and each `var()` is replaced by its fallback. A pixel font size is `Npx` in
 *   a `font-size` or `font` value, var() fallbacks included.
 * - A custom property declared outside `tokens.css` (`--local: 11px`, in CSS or in a
 *   TypeScript style object) and read by a `font-size`, `font-family`, or `font` value
 *   anywhere in the scanned files is also judged as that property, so a local variable
 *   cannot carry a family or a pixel size past the check; the finding names the
 *   declaration.
 * - TypeScript and JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, and their `.m`/`.c`
 *   forms), read with the TypeScript compiler's parser, so comments and JSX text are
 *   never read. A value given to a CSS-like property is judged as that declaration: an
 *   object key (a plain, quoted, or computed one, such as `color`, `"font-family"`,
 *   `["color"]`, or a `--custom` property), a JSX attribute such as `fill`, an
 *   assignment to `….style.color` or `….style["color"]`, and `….setProperty(name,
 *   value)`. The value is a string, a template (a substitution the check cannot read
 *   counts as `0`, so `` `${n}px` `` is a pixel size), or a `const` in the same file
 *   holding one, each branch of a `?:`, `||`, `??`, or `&&` judged alone; a number
 *   given to `fontSize` is a pixel size (React appends px). Any
 *   other string is flagged when it is a hex color as a whole, holds a color function,
 *   or holds a CSS declaration of a color or font property (CSS in a template literal).
 *   A bare word such as `"red"` in an unrelated string is not flagged: copy and variant
 *   names use such words.
 * - Markup (`.html`, `.svg`, and `ui/index.html`): the declarations of every `style`
 *   attribute and `<style>` element, and every attribute named like a CSS-like
 *   property (`fill`, `stroke`, `stop-color`, `font-family`, `font-size`, where a bare
 *   number is a pixel size), with comments and `<script>` bodies removed.
 *
 * Not scanned: `ui/src/design/tokens.css` (where the values live) and test files
 * (`*.test.ts`, `*.test.tsx`, and the JavaScript forms), which never ship and must feed
 * raw values to the token parser's and contrast tests. `ui/src/design/contrast-pairs.ts`
 * is scanned: it holds token names (`--color-…`), which are not colors.
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
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const UI_SRC = "ui/src";
const INDEX_HTML = "ui/index.html";
const TOKENS = "ui/src/design/tokens.css";
const CSS_FILE = /\.s?css$/;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const MARKUP_FILE = /\.(?:html|svg)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

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
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen " +
    // CSS Color 4's system colors, then its deprecated ones: the WebView resolves each to
    // a color the contrast test never sees.
    "accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas " +
    "canvastext field fieldtext graytext highlight highlighttext linktext mark marktext " +
    "selecteditem selecteditemtext visitedtext activeborder activecaption appworkspace " +
    "background buttonhighlight buttonshadow captiontext inactiveborder inactivecaption " +
    "inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow " +
    "threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext"
  ).split(" "),
);
/** Properties whose identifiers are author-chosen names, never colors. */
const NAME_VALUED =
  /^(font|animation|transition|grid|content|counter|list-style|will-change|view-transition|container|anchor|position-anchor|quotes)/;
/** The TypeScript keys, markup attributes, and embedded declarations judged as CSS. */
const CSS_LIKE =
  /^(-[a-z]+-)?(font|font-family|font-size|.*(color|background|border|outline|fill|stroke|shadow|decoration|caret|filter|mask).*)$/;
/** A custom property, or a Sass variable. */
const CUSTOM = /^(?:--|\$)/;
const FONT_PROPERTIES = new Set(["font", "font-family", "font-size"]);
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
/** WebKit's own color keywords: macOS's semantic colors and the link and focus colors. */
const WEBKIT_COLOR =
  /(?<![\w-])-(?:apple-system-[a-z][a-z-]*[a-z]|webkit-(?:link|activelink|text|focus-ring-color))(?![\w(-])/gi;
const PIXELS = /(?<![\w.-])\d*\.?\d+px(?![\w-])/i;
const WHOLE_HEX = /^#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})$/i;
const REFERENCE = /var\(\s*(--[\w-]+)|(\$[\w-]+)/g;

type Rule = "raw" | "family" | "pixel";

interface Finding {
  readonly code: Rule;
  readonly what: string;
}

const key = (finding: Finding): string => `${finding.code} ${finding.what}`;

/** `value` with every `var(--name, fallback)` replaced by its fallback (empty without). */
function fallbacksOnly(value: string): string {
  let out = value;
  for (let at = out.search(/var\(/i); at !== -1; at = out.search(/var\(/i)) {
    let depth = 0;
    let comma = -1;
    let end = at + 3;
    do {
      if (out[end] === "(") depth += 1;
      if (out[end] === ")") depth -= 1;
      if (out[end] === "," && depth === 1 && comma === -1) comma = end;
      end += 1;
    } while (depth > 0 && end < out.length);
    const fallback = comma === -1 ? "" : out.slice(comma + 1, depth === 0 ? end - 1 : end);
    out = `${out.slice(0, at)} ${fallback} ${out.slice(end)}`;
  }
  return out;
}

const withoutStrings = (value: string): string =>
  value.replace(/url\([^)]*\)/gi, " ").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");

/** The custom properties and Sass variables `value` reads. */
const references = (value: string): string[] =>
  [...value.matchAll(REFERENCE)].map((match) => match[1] ?? match[2] ?? "");

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
    for (const match of bare.matchAll(WEBKIT_COLOR)) findings.push({ code: "raw", what: match[0] });
  }
  if ((property === "font-size" || property === "font") && PIXELS.test(bare)) {
    findings.push({ code: "pixel", what: PIXELS.exec(bare)?.[0] ?? "" });
  }
  if (property === "font-family" || property === "font") {
    const rest = fallbacksOnly(value)
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
      if (/^(?:-{0,2}|\$)[a-z][\w-]*$/.test(property)) {
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

/**
 * CSS with its comments blanked (newlines kept, so offsets and lines survive): block
 * comments, and `//` line comments when `lineComments` (Sass). Strings and `url(…)` are
 * kept whole, so a `/*` or `//` inside one is not a comment.
 */
function blankCssComments(source: string, lineComments: boolean): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    let stop = i + 1;
    if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== char && source[j] !== "\n")
        j += source[j] === "\\" ? 2 : 1;
      stop = j + 1;
    } else if (/^url\(/i.test(source.slice(i, i + 4))) {
      const close = source.indexOf(")", i);
      stop = close === -1 ? source.length : close + 1;
    } else if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2);
      stop = close === -1 ? source.length : close + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    } else if (lineComments && source.startsWith("//", i)) {
      const close = source.indexOf("\n", i);
      stop = close === -1 ? source.length : close;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    out += source.slice(i, stop);
    i = stop;
  }
  return out;
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

/** One value the check judges, where it was found. */
interface Unit {
  readonly line: number;
  /** The CSS property the value is given to; undefined for a string that is none. */
  readonly property: string | undefined;
  readonly value: string;
  /** A number React turns into pixels (`fontSize: 13`), or a bare SVG `font-size`. */
  readonly numeric: boolean;
  readonly shown: string;
  /** Findings already reported where the value was declared (a `const`), as `key`s. */
  readonly reported: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

function cssUnits(css: string, base = 0, whole = css): Unit[] {
  return declarations(css).map(({ property, value, offset }) => ({
    line: lineOf(whole, base + offset),
    property,
    value,
    numeric: false,
    shown: `${property}: ${value.trim()}`,
    reported: NONE,
  }));
}

function scanCss(path: string, source: string): Unit[] {
  return cssUnits(blankCssComments(source, path.endsWith(".scss")));
}

const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`);

/** The CSS property a key, attribute, or style member names, if it is CSS-like. */
function cssProperty(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (CUSTOM.test(name)) return name;
  const property = kebab(name);
  return CSS_LIKE.test(property) ? property : undefined;
}

const SCRIPT_KINDS: readonly (readonly [RegExp, ts.ScriptKind])[] = [
  [/\.tsx$/, ts.ScriptKind.TSX],
  [/\.jsx$/, ts.ScriptKind.JSX],
  [/\.[cm]?js$/, ts.ScriptKind.JS],
];

function unwrap(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

interface Resolved {
  readonly text: string;
  readonly numeric: boolean;
  /** Read through a `const`, whose own literal is judged where it is declared. */
  readonly viaConst: boolean;
}

function scanTypeScript(path: string, source: string): Unit[] {
  const kind = SCRIPT_KINDS.find(([pattern]) => pattern.test(path))?.[1] ?? ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const consts = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0
    ) {
      consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);

  const resolve = (node: ts.Expression, seen: ReadonlySet<string> = NONE): Resolved | undefined => {
    const inner = unwrap(node);
    if (ts.isStringLiteralLike(inner)) return { text: inner.text, numeric: false, viaConst: false };
    if (ts.isNumericLiteral(inner)) return { text: inner.text, numeric: true, viaConst: false };
    if (ts.isTemplateExpression(inner)) {
      const text = inner.templateSpans
        .map((span) => `${resolve(span.expression, seen)?.text ?? "0"}${span.literal.text}`)
        .join("");
      return { text: `${inner.head.text}${text}`, numeric: false, viaConst: false };
    }
    if (!ts.isIdentifier(inner) || seen.has(inner.text)) return undefined;
    const initializer = consts.get(inner.text);
    if (initializer === undefined) return undefined;
    const resolved = resolve(initializer, new Set([...seen, inner.text]));
    return resolved === undefined ? undefined : { ...resolved, viaConst: true };
  };

  const nameText = (name: ts.Node): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    if (ts.isComputedPropertyName(name)) {
      const resolved = resolve(name.expression);
      return resolved?.numeric === false ? resolved.text : undefined;
    }
    return undefined;
  };

  const isStyle = (node: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(node) && node.name.text === "style") ||
    (ts.isIdentifier(node) && node.text === "style");

  /** The property and value of a node that gives a value to a named property. */
  const site = (node: ts.Node): { name: string | undefined; value: ts.Expression } | undefined => {
    if (ts.isPropertyAssignment(node))
      return { name: nameText(node.name), value: node.initializer };
    if (ts.isShorthandPropertyAssignment(node)) return { name: node.name.text, value: node.name };
    if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
      const value = ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      return value === undefined ? undefined : { name: nameText(node.name), value };
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      if (ts.isPropertyAccessExpression(target) && isStyle(target.expression))
        return { name: target.name.text, value: node.right };
      if (ts.isElementAccessExpression(target) && isStyle(target.expression)) {
        const resolved = resolve(target.argumentExpression);
        return { name: resolved?.numeric === false ? resolved.text : undefined, value: node.right };
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setProperty"
    ) {
      const [name, value] = node.arguments;
      const resolved = name === undefined ? undefined : resolve(name);
      if (value !== undefined && resolved?.numeric === false) return { name: resolved.text, value };
    }
    return undefined;
  };

  /** The values an expression can take: each branch of a `?:`, `||`, `??`, or `&&`. */
  const branches = (node: ts.Expression): ts.Expression[] => {
    const inner = unwrap(node);
    if (ts.isConditionalExpression(inner))
      return [...branches(inner.whenTrue), ...branches(inner.whenFalse)];
    if (
      ts.isBinaryExpression(inner) &&
      (inner.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      return [...branches(inner.left), ...branches(inner.right)];
    }
    return [inner];
  };

  const units: Unit[] = [];
  const claimed = new Set<ts.Node>();
  const lineAt = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  /** Record `value` as the value of `property`, when the check can read it. */
  const given = (property: string, value: ts.Expression): void => {
    const resolved = resolve(value);
    if (resolved === undefined) return;
    claimed.add(value);
    units.push({
      line: lineAt(value),
      property,
      value: resolved.text,
      numeric: resolved.numeric,
      shown: resolved.viaConst
        ? `${property}: ${value.getText(file)} (${JSON.stringify(resolved.text)})`
        : `${property}: ${resolved.text}`,
      reported: resolved.viaConst ? new Set(judgeString(resolved.text).map(key)) : NONE,
    });
  };
  const visit = (node: ts.Node): void => {
    const found = site(node);
    const property = cssProperty(found?.name);
    if (found !== undefined && property !== undefined) {
      for (const value of branches(found.value)) given(property, value);
    }
    if (
      ts.isStringLiteralLike(node) &&
      !claimed.has(node) &&
      !ts.isImportDeclaration(node.parent)
    ) {
      units.push({
        line: lineAt(node),
        property: undefined,
        value: node.text,
        numeric: false,
        shown: node.getText(file),
        reported: NONE,
      });
    } else if (ts.isTemplateExpression(node) && !claimed.has(node)) {
      for (const part of [node.head, ...node.templateSpans.map((span) => span.literal)]) {
        units.push({
          line: lineAt(part),
          property: undefined,
          value: part.text,
          numeric: false,
          shown: node.getText(file),
          reported: NONE,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return units;
}

const TAG =
  /<([a-z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*\/?>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;

/** HTML or SVG: `style` attributes, `<style>` elements, and CSS-like attributes. */
function scanMarkup(source: string): Unit[] {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  const text = source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
      (_whole, open: string, body: string, close: string) => `${open}${blank(body)}${close}`,
    );
  const units: Unit[] = [];
  for (const match of text.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style\s*>/gi)) {
    const start = match.index + (match[1] ?? "").length;
    units.push(...cssUnits(blankCssComments(match[2] ?? "", false), start, text));
  }
  for (const tag of text.matchAll(TAG)) {
    const attributesAt = tag.index + 1 + (tag[1] ?? "").length;
    for (const attribute of (tag[2] ?? "").matchAll(ATTRIBUTE)) {
      const name = (attribute[1] ?? "").toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      if (value === undefined) continue;
      const at = attributesAt + attribute.index;
      if (name === "style") {
        units.push(...cssUnits(value, at + attribute[0].indexOf(value), text));
        continue;
      }
      const property = cssProperty(name);
      if (property === undefined) continue;
      units.push({
        line: lineOf(text, at),
        property,
        value,
        numeric: property === "font-size" && /^\s*\d*\.?\d+\s*$/.test(value),
        shown: `${name}="${value}"`,
        reported: NONE,
      });
    }
  }
  return units;
}

/** Any string that is not a declared property's value. */
function judgeString(text: string): Finding[] {
  if (WHOLE_HEX.test(text.trim())) return [{ code: "raw", what: text.trim() }];
  const inCss = embedded(text).flatMap((d) => judgeDeclaration(d.property, d.value));
  const covered = new Set(inCss.map((f) => f.what));
  const functions = [...text.matchAll(COLOR_FUNCTION)]
    .map((m): Finding => ({ code: "raw", what: `${m[0]}…)` }))
    .filter((f) => !covered.has(f.what));
  return [...inCss, ...functions];
}

/** The CSS-like declarations written inside a string (CSS in a template literal). */
const embedded = (text: string): Declaration[] =>
  declarations(text).filter((d) => CUSTOM.test(d.property) || CSS_LIKE.test(d.property));

function judgeUnit(unit: Unit): Finding[] {
  if (unit.property === undefined) return judgeString(unit.value);
  if (unit.numeric) {
    return unit.property === "font-size" ? [{ code: "pixel", what: `${unit.value} (px)` }] : [];
  }
  return judgeDeclaration(unit.property, unit.value).filter((f) => !unit.reported.has(key(f)));
}

/** A declaration a unit holds: its own, or one written inside its string. */
interface Held {
  readonly path: string;
  readonly unit: Unit;
  readonly property: string;
  readonly value: string;
}

function held(path: string, unit: Unit): Held[] {
  if (unit.property === undefined) {
    return embedded(unit.value).map((d) => ({ path, unit, property: d.property, value: d.value }));
  }
  return unit.numeric ? [] : [{ path, unit, property: unit.property, value: unit.value }];
}

interface Located extends Finding {
  readonly path: string;
  readonly line: number;
  readonly declaration: string;
}

/**
 * A local custom property (declared outside tokens.css) that a font property reads is
 * judged as that font property, at its declaration: `--size: 11px` is a pixel font size
 * once `font-size: var(--size)` reads it.
 */
function throughLocals(all: readonly Held[]): Located[] {
  const locals = new Map<string, Held[]>();
  for (const entry of all) {
    if (CUSTOM.test(entry.property))
      locals.set(entry.property, [...(locals.get(entry.property) ?? []), entry]);
  }
  const usedAs = new Map<string, Set<string>>();
  const queue: [string, string][] = [];
  const use = (name: string, property: string): void => {
    const uses = usedAs.get(name) ?? new Set<string>();
    if (uses.has(property)) return;
    uses.add(property);
    usedAs.set(name, uses);
    queue.push([name, property]);
  };
  for (const entry of all) {
    if (FONT_PROPERTIES.has(entry.property)) {
      for (const name of references(entry.value)) use(name, entry.property);
    }
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [name, property] = next;
    for (const entry of locals.get(name) ?? []) {
      for (const inner of references(entry.value)) use(inner, property);
    }
  }
  return [...locals].flatMap(([name, entries]) =>
    entries.flatMap((entry) => {
      const seen = new Set<string>();
      return [...(usedAs.get(name) ?? [])].flatMap((property) =>
        judgeDeclaration(property, entry.value)
          .filter((f) => f.code !== "raw" && !seen.has(key(f)))
          .map((finding): Located => {
            seen.add(key(finding));
            return {
              ...finding,
              path: entry.path,
              line: entry.unit.line,
              declaration: `${name}: ${entry.value.trim()}, read as ${property}`,
            };
          }),
      );
    }),
  );
}

function files(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return files(root, path);
      const scanned =
        CSS_FILE.test(entry.name) || SCRIPT_FILE.test(entry.name) || MARKUP_FILE.test(entry.name);
      return scanned && !TEST_FILE.test(entry.name) && path !== TOKENS ? [path] : [];
    });
}

function scan(path: string, source: string): Unit[] {
  if (CSS_FILE.test(path)) return scanCss(path, source);
  if (MARKUP_FILE.test(path)) return scanMarkup(source);
  return scanTypeScript(path, source);
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
  const index = readRepoFile(root, INDEX_HTML);
  const scanned = [
    ...(index === undefined ? [] : [{ path: INDEX_HTML, units: scanMarkup(index) }]),
    ...paths.map((path) => ({ path, units: scan(path, readFileSync(join(root, path), "utf8")) })),
  ];
  const direct = scanned.flatMap(({ path, units }) =>
    units.flatMap((unit) =>
      judgeUnit(unit).map((finding): Located => ({
        ...finding,
        path,
        line: unit.line,
        declaration: unit.shown,
      })),
    ),
  );
  const order = new Map(scanned.map(({ path }, i) => [path, i]));
  const located = [
    ...direct,
    ...throughLocals(scanned.flatMap(({ path, units }) => units.flatMap((u) => held(path, u)))),
  ].sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || a.line - b.line);
  return located.map((finding): FailureDetails => {
    const rule = RULES[finding.code];
    return {
      code: rule.code,
      summary: `${finding.path}:${String(finding.line)}: ${rule.summary} \`${finding.what}\` outside ${TOKENS}`,
      expected: `${rule.expected} (design D23; ${TOKENS} is the one file that holds raw values)`,
      actual: `\`${finding.declaration}\``,
      next: rule.next,
    };
  });
}

export const check: Check = { name: "ui-literals", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
