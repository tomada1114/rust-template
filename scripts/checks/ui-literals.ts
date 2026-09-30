/**
 * Components reach design values only through tokens: outside
 * `ui/src/design/tokens.css`, nothing under `ui/src/` — nor `ui/index.html` — holds a
 * raw color, a font family, or a pixel font size. The keywords `currentColor`,
 * `transparent`, `inherit`, `none`, `initial`, `unset` (and `revert`) are not colors,
 * and `var(--…)` is always allowed.
 *
 * What counts as a raw value in a declaration:
 *
 * - A raw color is a hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), a color
 *   function (`rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`,
 *   `oklab()`, `oklch()`, `color()`), a CSS named color, or one of WebKit's own
 *   (`-apple-system-label`, `-apple-system-control-background`, `-webkit-link`, …), in
 *   any property except those whose values are author-chosen names (`animation*`,
 *   `grid*`, `transition*`, `content`, `font*`, …). A CSS system color (`Canvas`,
 *   `CanvasText`, `AccentColor`, `ButtonFace`, …, the deprecated ones included) counts
 *   only where the value is surely CSS — a CSS file, a markup style, a TypeScript style
 *   key, a JSX attribute of an HTML or SVG element — and only in a property that takes a
 *   color (`color`, `background`, `border`, `fill`, …), or as the whole value of a
 *   custom property (`--x: CanvasText`; not `menu`, a system-font keyword). Many system
 *   colors are English words (`Background`, `Menu`, `Highlight`), so copy, a component's
 *   prop, or CSS written inside a string never trips them.
 * - A font family is any `font-family` value, or family in the `font` shorthand, left
 *   once the keywords are removed and each `var()` is replaced by its fallback. A pixel
 *   font size is `Npx` in a `font-size` or `font` value, var() fallbacks included.
 * - A custom property declared outside `tokens.css` (`--local: 11px`, in CSS, SCSS
 *   `$variables`, or a TypeScript style object) is also judged as the font property that
 *   reads it, at its declaration, so a local variable cannot carry a family or a pixel
 *   size past the check. A read sees the declarations in its own file: those in its own
 *   rule or object when there are any, otherwise every one in the file.
 *
 * Where declarations are found, per file kind:
 *
 * - CSS (`.css`, `.scss`): every declaration, with comments removed (and `//` line
 *   comments in `.scss`, whose `$variables` count as custom properties there only).
 * - TypeScript and JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, and their `.m`/`.c` forms),
 *   read with the TypeScript compiler's parser and a checker over the file, so comments
 *   and JSX text are never read and a name resolves to the binding in scope. A value
 *   given to a CSS-like property is judged as that declaration: an object key (a plain,
 *   quoted, or computed one, such as `color`, `"font-family"`, `["color"]`, or a
 *   `--custom` property), a JSX attribute such as `fill`, an assignment to
 *   `….style.color` or `….style["color"]`, and `….setProperty(name, value)`. The value
 *   is a string, a template (a substitution the check cannot read counts as `0`, so
 *   `` `${n}px` `` is a pixel size), a `const` in scope or a member of a `const` object
 *   holding one, and each branch of a `?:`, `||`, `??`, or `&&`; a number given to
 *   `fontSize` is a pixel size (React appends px). A raw value a `const` holds is
 *   reported once, where it is declared when it is flagged there, otherwise where it is
 *   used. Any other string is flagged when it is a hex color as a whole, holds a color
 *   function, or holds a CSS declaration of a color or font property (CSS in a template
 *   literal). A bare word such as `"red"` in an unrelated string is not flagged: copy
 *   and variant names use such words.
 * - Markup (`.html`, `.svg`, and `ui/index.html`): the declarations of every `style`
 *   attribute and `<style>` element, and every attribute named like a CSS-like property
 *   (`fill`, `stroke`, `stop-color`, `font-family`, `font-size`, where a bare number is a
 *   pixel size), with comments and `<script>` bodies removed. A tag whose attributes the
 *   check cannot read fails the check rather than passing unread.
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
 * ERR_CHECK_UI_FONT_FAMILY, ERR_CHECK_UI_PIXEL_FONT_SIZE, ERR_CHECK_UI_UNPARSED (a
 * markup tag it cannot read).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import { blank, constInitializer, parseScript, SCRIPT_FILE, TEST_FILE } from "./shared/sources.ts";

const UI_SRC = "ui/src";
const INDEX_HTML = "ui/index.html";
const TOKENS = "ui/src/design/tokens.css";
const CSS_FILE = /\.s?css$/;
const MARKUP_FILE = /\.(?:html|svg)$/;

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
/**
 * CSS Color 4's system colors, then its deprecated ones: the WebView resolves each to a
 * color the contrast test never sees.
 */
const SYSTEM_COLORS = new Set(
  (
    "accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas " +
    "canvastext field fieldtext graytext highlight highlighttext linktext mark marktext " +
    "selecteditem selecteditemtext visitedtext activeborder activecaption appworkspace " +
    "background buttonhighlight buttonshadow captiontext inactiveborder inactivecaption " +
    "inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow " +
    "threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext"
  ).split(" "),
);
/** The CSS properties whose value takes a color, without a vendor prefix. */
const COLOR_PROPERTIES = new Set(
  (
    "color background background-color background-image border border-color border-top " +
    "border-right border-bottom border-left border-top-color border-right-color " +
    "border-bottom-color border-left-color border-block border-block-color " +
    "border-block-start border-block-end border-block-start-color border-block-end-color " +
    "border-inline border-inline-color border-inline-start border-inline-end " +
    "border-inline-start-color border-inline-end-color border-image border-image-source " +
    "outline outline-color column-rule column-rule-color text-decoration " +
    "text-decoration-color text-emphasis text-emphasis-color text-shadow box-shadow " +
    "caret-color accent-color fill stroke stop-color flood-color lighting-color " +
    "scrollbar-color text-fill-color text-stroke text-stroke-color tap-highlight-color " +
    "filter backdrop-filter mask mask-image"
  ).split(" "),
);
const VENDOR = /^-(?:webkit|moz|ms|o)-/;
/** Properties whose identifiers are author-chosen names, never colors. */
const NAME_VALUED =
  /^(font|animation|transition|grid|content|counter|list-style|will-change|view-transition|container|anchor|position-anchor|quotes)/;
/** The TypeScript keys, markup attributes, and embedded declarations judged as CSS. */
const CSS_LIKE =
  /^(-[a-z]+-)?(font|font-family|font-size|.*(color|background|border|outline|fill|stroke|shadow|decoration|caret|filter|mask).*)$/;
/** A custom property; in `.scss`, also a Sass variable. */
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

type Rule = "raw" | "family" | "pixel" | "unparsed";

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

/** The system colors a declaration holds, where its value is surely CSS. */
function systemColors(property: string, bare: string): Finding[] {
  if (CUSTOM.test(property)) {
    const whole = bare
      .trim()
      .replace(/\s*!important$/i, "")
      .toLowerCase();
    return SYSTEM_COLORS.has(whole) && !FONT_KEYWORDS.has(whole)
      ? [{ code: "raw", what: bare.trim() }]
      : [];
  }
  if (!COLOR_PROPERTIES.has(property.replace(VENDOR, ""))) return [];
  return [...bare.matchAll(WORD)]
    .filter((match) => SYSTEM_COLORS.has(match[0].toLowerCase()))
    .map((match) => ({ code: "raw", what: match[0] }));
}

/**
 * What a declaration `property: value` breaks, if anything. `surelyCss` says the value
 * is CSS rather than possibly copy, which is when a system color counts.
 */
function judgeDeclaration(property: string, value: string, surelyCss: boolean): Finding[] {
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
    if (surelyCss) findings.push(...systemColors(property, bare));
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
  /** The rule block the declaration is in (0 outside every block). */
  readonly block: number;
}

/**
 * The `property: value` declarations in CSS text (comments already blanked). A `$name`
 * property is read only when `sass`.
 */
function declarations(css: string, sass = false): Declaration[] {
  const found: Declaration[] = [];
  const open: number[] = [0];
  let blocks = 0;
  let start = 0;
  let depth = 0;
  const property = sass ? /^(?:-{0,2}|\$)[a-z][\w-]*$/ : /^-{0,2}[a-z][\w-]*$/;
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
      const name = segment.slice(0, colon).trim().toLowerCase();
      const value = segment.slice(colon + 1);
      if (property.test(name)) {
        found.push({
          property: name,
          value,
          offset: start + colon + 1 + (value.length - value.trimStart().length),
          block: open.at(-1) ?? 0,
        });
      }
    }
    if (char === "{") {
      blocks += 1;
      open.push(blocks);
    }
    if (char === "}" && open.length > 1) open.pop();
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
  /** The value is surely CSS, not possibly copy: a system color counts in it. */
  readonly surelyCss: boolean;
  /** The rule, object, or attribute the value belongs to, for resolving `var()`. */
  readonly scope: string;
  readonly shown: string;
  /** Findings already reported where the value was declared (a `const`), as `key`s. */
  readonly reported: ReadonlySet<string>;
}

/** What a file yields: the values to judge, and what it could not read. */
interface Scanned {
  readonly units: Unit[];
  readonly unreadable: readonly { readonly line: number; readonly what: string }[];
}

const NONE: ReadonlySet<string> = new Set();

interface CssPlace {
  readonly sass: boolean;
  readonly scope: string;
  /** Where `css` starts in `whole`, the text lines are counted in. */
  readonly base: number;
  readonly whole: string;
}

function cssUnits(css: string, place: CssPlace): Unit[] {
  return declarations(css, place.sass).map(({ property, value, offset, block }) => ({
    line: lineOf(place.whole, place.base + offset),
    property,
    value,
    numeric: false,
    surelyCss: true,
    scope: `${place.scope}#${String(block)}`,
    shown: `${property}: ${value.trim()}`,
    reported: NONE,
  }));
}

function scanCss(path: string, source: string): Scanned {
  const sass = path.endsWith(".scss");
  const css = blankCssComments(source, sass);
  return { units: cssUnits(css, { sass, scope: "css", base: 0, whole: css }), unreadable: [] };
}

const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`);

/** The CSS property a TypeScript key, attribute, or style member names, if CSS-like. */
function cssProperty(name: string | undefined): string | undefined {
  if (name === undefined || name.startsWith("$")) return undefined;
  if (name.startsWith("--")) return name;
  const property = kebab(name);
  return CSS_LIKE.test(property) ? property : undefined;
}

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

/** One value an expression can take. */
interface Resolved {
  readonly text: string;
  readonly numeric: boolean;
  /** The literals the value is written in at the site itself. */
  readonly direct: readonly ts.Node[];
  /** The literals the value was read from through a `const`, declared elsewhere. */
  readonly via: readonly ts.Node[];
}

/** Template values are combined across substitutions up to this many. */
const MAX_COMBINATIONS = 16;
const UNREADABLE: Resolved = { text: "0", numeric: false, direct: [], via: [] };

/** A site that gives a value to a named property. */
interface Site {
  readonly name: string | undefined;
  readonly value: ts.Expression;
  readonly surelyCss: boolean;
  readonly scope: string;
}

function scanTypeScript(path: string, source: string): Scanned {
  const { file, checker } = parseScript(path, source);

  const propertyName = (node: ts.PropertyName): string | undefined => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    if (!ts.isComputedPropertyName(node)) return undefined;
    const [only, ...more] = resolveAll(node.expression);
    return only !== undefined && more.length === 0 && !only.numeric ? only.text : undefined;
  };

  /** The object literal an expression is, through consts and members of const objects. */
  const objectOf = (
    node: ts.Expression,
    seen: ReadonlySet<ts.Node>,
  ): ts.ObjectLiteralExpression | undefined => {
    const inner = unwrap(node);
    if (ts.isObjectLiteralExpression(inner)) return inner;
    if (ts.isIdentifier(inner)) {
      const initializer = constInitializer(checker, inner);
      return initializer === undefined || seen.has(initializer)
        ? undefined
        : objectOf(initializer, new Set([...seen, initializer]));
    }
    const member = memberOf(inner, seen);
    return member === undefined ? undefined : objectOf(member, new Set([...seen, member]));
  };

  /** The initializer `P.name` or `P["name"]` reads from a const object `P`. */
  const memberOf = (node: ts.Expression, seen: ReadonlySet<ts.Node>): ts.Expression | undefined => {
    let object: ts.Expression;
    let name: string | undefined;
    if (ts.isPropertyAccessExpression(node)) {
      object = node.expression;
      name = node.name.text;
    } else if (ts.isElementAccessExpression(node)) {
      object = node.expression;
      name = ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    } else return undefined;
    const literal = name === undefined ? undefined : objectOf(object, seen);
    const property = literal?.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && propertyName(p.name) === name,
    );
    return property?.initializer;
  };

  /** Every value an expression can take that the check can read. */
  const resolveAll = (
    node: ts.Expression,
    throughConst = false,
    seen: ReadonlySet<ts.Node> = new Set(),
  ): Resolved[] => {
    const inner = unwrap(node);
    const at = (text: string, numeric: boolean): Resolved => ({
      text,
      numeric,
      direct: throughConst ? [] : [inner],
      via: throughConst ? [inner] : [],
    });
    if (ts.isStringLiteralLike(inner)) return [at(inner.text, false)];
    if (ts.isNumericLiteral(inner)) return [at(inner.text, true)];
    if (ts.isTemplateExpression(inner)) {
      let combined: Resolved[] = [at(inner.head.text, false)];
      for (const span of inner.templateSpans) {
        const parts = resolveAll(span.expression, throughConst, seen);
        combined = combined
          .flatMap((before) =>
            (parts.length > 0 ? parts : [UNREADABLE]).map((part) => ({
              text: `${before.text}${part.text}${span.literal.text}`,
              numeric: false,
              direct: [...before.direct, ...part.direct],
              via: [...before.via, ...part.via],
            })),
          )
          .slice(0, MAX_COMBINATIONS);
      }
      return combined;
    }
    if (ts.isConditionalExpression(inner)) {
      return [
        ...resolveAll(inner.whenTrue, throughConst, seen),
        ...resolveAll(inner.whenFalse, throughConst, seen),
      ];
    }
    if (
      ts.isBinaryExpression(inner) &&
      (inner.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      return [
        ...resolveAll(inner.left, throughConst, seen),
        ...resolveAll(inner.right, throughConst, seen),
      ];
    }
    const next = ts.isIdentifier(inner) ? constInitializer(checker, inner) : memberOf(inner, seen);
    return next === undefined || seen.has(next)
      ? []
      : resolveAll(next, true, new Set([...seen, next]));
  };

  const isStyle = (node: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(node) && node.name.text === "style") ||
    (ts.isIdentifier(node) && node.text === "style");

  const single = (node: ts.Expression): string | undefined => {
    const [only, ...more] = resolveAll(node);
    return only !== undefined && more.length === 0 && !only.numeric ? only.text : undefined;
  };

  /** An HTML or SVG element, whose attributes are CSS; a component's are its props. */
  const intrinsic = (attribute: ts.JsxAttribute): boolean => {
    const tag = attribute.parent.parent.tagName;
    return ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);
  };

  const siteOf = (node: ts.Node): Site | undefined => {
    const scope = `ts@${String(node.parent.pos)}`;
    if (ts.isPropertyAssignment(node))
      return { name: propertyName(node.name), value: node.initializer, surelyCss: true, scope };
    if (ts.isShorthandPropertyAssignment(node))
      return { name: node.name.text, value: node.name, surelyCss: true, scope };
    if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
      const value = ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
      return value === undefined ? undefined : { name, value, surelyCss: intrinsic(node), scope };
    }
    const own = `ts@${String(node.pos)}`;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      if (ts.isPropertyAccessExpression(target) && isStyle(target.expression))
        return { name: target.name.text, value: node.right, surelyCss: true, scope: own };
      if (ts.isElementAccessExpression(target) && isStyle(target.expression)) {
        const name = single(target.argumentExpression);
        return { name, value: node.right, surelyCss: true, scope: own };
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setProperty"
    ) {
      const [name, value] = node.arguments;
      if (name !== undefined && value !== undefined)
        return { name: single(name), value, surelyCss: true, scope: own };
    }
    return undefined;
  };

  // First pass: every site and the literals it claims, so a literal is judged once, as
  // its site's value, and never again as a free string.
  const sites: { site: Site; property: string; values: Resolved[] }[] = [];
  const claimed = new Map<ts.Node, { property: string; surelyCss: boolean }>();
  const collect = (node: ts.Node): void => {
    const site = siteOf(node);
    const property = cssProperty(site?.name);
    if (site !== undefined && property !== undefined) {
      const values = resolveAll(site.value);
      sites.push({ site, property, values });
      for (const value of values) {
        for (const literal of value.direct)
          claimed.set(literal, { property, surelyCss: site.surelyCss });
      }
    }
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(file, collect);

  const lineAt = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const freeParts = (node: ts.Node): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node))
      return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    return [];
  };
  /** What a literal read through a const already reports where it is declared. */
  const reportedWhereDeclared = (literal: ts.Node): string[] => {
    const owner = claimed.get(literal);
    if (owner === undefined)
      return freeParts(literal).flatMap((part) => judgeString(part).map(key));
    if (!ts.isStringLiteralLike(literal)) return [];
    return judgeDeclaration(owner.property, literal.text, owner.surelyCss).map(key);
  };

  const units: Unit[] = sites.flatMap(({ site, property, values }) =>
    values.map((value): Unit => {
      const anchor = value.direct[0] ?? site.value;
      return {
        line: lineAt(anchor),
        property,
        value: value.text,
        numeric: value.numeric,
        surelyCss: site.surelyCss,
        scope: site.scope,
        shown:
          value.via.length > 0
            ? `${property}: ${site.value.getText(file)} (${JSON.stringify(value.text)})`
            : `${property}: ${value.text}`,
        reported: new Set(value.via.flatMap(reportedWhereDeclared)),
      };
    }),
  );
  const free = (node: ts.Node): void => {
    const isModuleName = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent);
    if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && !claimed.has(node)) {
      if (!isModuleName) {
        const parts = ts.isTemplateExpression(node)
          ? [node.head, ...node.templateSpans.map((span) => span.literal)]
          : [node];
        for (const part of parts) {
          units.push({
            line: lineAt(part),
            property: undefined,
            value: part.text,
            numeric: false,
            surelyCss: false,
            scope: `ts@${String(node.pos)}`,
            shown: node.getText(file),
            reported: NONE,
          });
        }
      }
    }
    ts.forEachChild(node, free);
  };
  ts.forEachChild(file, free);
  return { units, unreadable: [] };
}

const TAG_NAME = /[A-Za-z][\w:.-]*/y;
const ATTRIBUTE_NAME = /[^\s"'<>/=]+/y;
const UNQUOTED = /[^\s"'<>=`]+/y;
const SPACE = /\s*/y;

/** The end of the match of a sticky pattern at `at`, or -1. */
function stickyEnd(pattern: RegExp, text: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.exec(text) === null ? -1 : pattern.lastIndex;
}

/** HTML or SVG: `style` attributes, `<style>` elements, and CSS-like attributes. */
function scanMarkup(source: string): Scanned {
  let text = source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
      (_whole, open: string, body: string, close: string) => `${open}${blank(body)}${close}`,
    );
  const units: Unit[] = [];
  let styles = 0;
  for (const match of text.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style\s*>/gi)) {
    const base = match.index + (match[1] ?? "").length;
    const css = blankCssComments(match[2] ?? "", false);
    styles += 1;
    units.push(
      ...cssUnits(css, { sass: false, scope: `style${String(styles)}`, base, whole: text }),
    );
  }
  text = text.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (_whole, open: string, body: string, close: string) => `${open}${blank(body)}${close}`,
  );

  const unreadable: { line: number; what: string }[] = [];
  const attribute = (name: string, value: string, at: number): void => {
    if (name === "style") {
      units.push(
        ...cssUnits(value, { sass: false, scope: `attr@${String(at)}`, base: at, whole: text }),
      );
      return;
    }
    const property = cssProperty(name);
    if (property === undefined) return;
    units.push({
      line: lineOf(text, at),
      property,
      value,
      numeric: property === "font-size" && /^\s*\d*\.?\d+\s*$/.test(value),
      surelyCss: true,
      scope: `attr@${String(at)}`,
      shown: `${name}="${value}"`,
      reported: NONE,
    });
  };
  /** Read the tag whose name starts at `at`; the offset after it, or -1 if unreadable. */
  const tag = (at: number): number => {
    let i = stickyEnd(TAG_NAME, text, at);
    for (;;) {
      i = stickyEnd(SPACE, text, i);
      if (text[i] === ">") return i + 1;
      if (text.startsWith("/>", i)) return i + 2;
      const nameEnd = stickyEnd(ATTRIBUTE_NAME, text, i);
      if (nameEnd === -1) return -1;
      const name = text.slice(i, nameEnd).toLowerCase();
      const equals = stickyEnd(SPACE, text, nameEnd);
      if (text[equals] !== "=") {
        i = nameEnd;
        continue;
      }
      const valueAt = stickyEnd(SPACE, text, equals + 1);
      const quote = text[valueAt];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, valueAt + 1);
        if (close === -1) return -1;
        attribute(name, text.slice(valueAt + 1, close), valueAt + 1);
        i = close + 1;
      } else {
        const end = stickyEnd(UNQUOTED, text, valueAt);
        if (end === -1) return -1;
        attribute(name, text.slice(valueAt, end), valueAt);
        i = end;
      }
    }
  };
  for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at + 1)) {
    if (!/[a-z]/i.test(text[at + 1] ?? "")) continue;
    const end = tag(at + 1);
    if (end === -1) {
      const lineEnd = text.indexOf("\n", at);
      const what = text.slice(at, lineEnd < 0 ? undefined : lineEnd).trim();
      unreadable.push({ line: lineOf(text, at), what });
    } else at = end - 1;
  }
  return { units, unreadable };
}

/** Any string that is not a declared property's value. */
function judgeString(text: string): Finding[] {
  if (WHOLE_HEX.test(text.trim())) return [{ code: "raw", what: text.trim() }];
  const inCss = embedded(text).flatMap((d) => judgeDeclaration(d.property, d.value, false));
  const covered = new Set(inCss.map((f) => f.what));
  const functions = [...text.matchAll(COLOR_FUNCTION)]
    .map((m): Finding => ({ code: "raw", what: `${m[0]}…)` }))
    .filter((f) => !covered.has(f.what));
  return [...inCss, ...functions];
}

/** The CSS-like declarations written inside a string (CSS in a template literal). */
const embedded = (text: string): Declaration[] =>
  declarations(text).filter((d) => d.property.startsWith("--") || CSS_LIKE.test(d.property));

function judgeUnit(unit: Unit): Finding[] {
  if (unit.property === undefined) return judgeString(unit.value);
  if (unit.numeric) {
    return unit.property === "font-size" ? [{ code: "pixel", what: `${unit.value} (px)` }] : [];
  }
  return judgeDeclaration(unit.property, unit.value, unit.surelyCss).filter(
    (f) => !unit.reported.has(key(f)),
  );
}

/** A declaration a unit holds: its own, or one written inside its string. */
interface Held {
  readonly path: string;
  readonly unit: Unit;
  readonly property: string;
  readonly value: string;
  readonly scope: string;
}

function held(path: string, unit: Unit): Held[] {
  if (unit.property === undefined) {
    return embedded(unit.value).map((d) => ({
      path,
      unit,
      property: d.property,
      value: d.value,
      scope: `${unit.scope}#${String(d.block)}`,
    }));
  }
  return unit.numeric
    ? []
    : [{ path, unit, property: unit.property, value: unit.value, scope: unit.scope }];
}

interface Located extends Finding {
  readonly path: string;
  readonly line: number;
  readonly declaration: string;
}

/**
 * A local custom property (declared outside tokens.css) that a font property reads is
 * judged as that font property, at its declaration: `--size: 11px` is a pixel font size
 * once `font-size: var(--size)` reads it. A read sees only its own file's declarations:
 * those in its own rule or object when there are any, otherwise all of them.
 */
function throughLocals(all: readonly Held[]): Located[] {
  const locals = new Map<string, Held[]>();
  const where = (path: string, name: string): string => `${path}\u0000${name}`;
  for (const entry of all) {
    if (CUSTOM.test(entry.property)) {
      const at = where(entry.path, entry.property);
      locals.set(at, [...(locals.get(at) ?? []), entry]);
    }
  }
  const visible = (reader: Held, name: string): Held[] => {
    const declared = locals.get(where(reader.path, name)) ?? [];
    const own = declared.filter((entry) => entry.scope === reader.scope);
    return own.length > 0 ? own : declared;
  };
  const usedAs = new Map<Held, Set<string>>();
  const queue: [Held, string][] = [];
  const use = (entry: Held, property: string): void => {
    const uses = usedAs.get(entry) ?? new Set<string>();
    if (uses.has(property)) return;
    uses.add(property);
    usedAs.set(entry, uses);
    queue.push([entry, property]);
  };
  for (const reader of all) {
    if (!FONT_PROPERTIES.has(reader.property)) continue;
    for (const name of references(reader.value)) {
      for (const entry of visible(reader, name)) use(entry, reader.property);
    }
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [reader, property] = next;
    for (const name of references(reader.value)) {
      for (const entry of visible(reader, name)) use(entry, property);
    }
  }
  return [...usedAs].flatMap(([entry, properties]) => {
    const seen = new Set<string>();
    return [...properties].flatMap((property) =>
      judgeDeclaration(property, entry.value, false)
        .filter((f) => f.code !== "raw" && !seen.has(key(f)))
        .map((finding): Located => {
          seen.add(key(finding));
          return {
            ...finding,
            path: entry.path,
            line: entry.unit.line,
            declaration: `${entry.property}: ${entry.value.trim()}, read as ${property}`,
          };
        }),
    );
  });
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

function scan(path: string, source: string): Scanned {
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
  unparsed: {
    code: "ERR_CHECK_UI_UNPARSED",
    summary: "unreadable tag",
    expected: "markup whose every tag the check can read, so no attribute passes unjudged",
    next: "quote the tag's attribute values and close the tag (`>` or `/>`); a tag the check cannot read fails it rather than passing unread",
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
        expected: `the UI sources under ${UI_SRC}/`,
        actual: "no such directory",
        next: `restore ${UI_SRC}/ from version control, or run the check with --root at a checkout`,
      },
    ];
  }
  const index = readRepoFile(root, INDEX_HTML);
  const scanned = [
    ...(index === undefined ? [] : [{ path: INDEX_HTML, ...scanMarkup(index) }]),
    ...paths.map((path) => ({ path, ...scan(path, readFileSync(join(root, path), "utf8")) })),
  ];
  const direct = scanned.flatMap(({ path, units, unreadable }) => [
    ...unreadable.map(({ line, what }): Located => ({
      code: "unparsed",
      what,
      path,
      line,
      declaration: what,
    })),
    ...units.flatMap((unit) =>
      judgeUnit(unit).map((finding): Located => ({
        ...finding,
        path,
        line: unit.line,
        declaration: unit.shown,
      })),
    ),
  ]);
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
      expected: `${rule.expected} (${TOKENS} is the one file that holds raw values)`,
      actual: `\`${finding.declaration}\``,
      next: rule.next,
    };
  });
}

export const check: Check = { name: "ui-literals", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
