/**
 * Components reach design values only through tokens: outside
 * `ui/src/design/tokens.css`, nothing the WebView styles with — everything under
 * `ui/src/`, each entry page directly under `ui/` (`ui/index.html`, `ui/*.html`, `.htm`,
 * `.xhtml`), and the stylesheets in `ui/public/` (`.css`, `.pcss`, `.postcss`) — holds a
 * raw color, a font family, or a pixel font size. The rest of `ui/public/` is not
 * judged: an SVG there is loaded as an image, where `var()` cannot work, and a script
 * there is vendored. The keywords `currentColor`, `transparent`, `inherit`, `none`,
 * `initial`, `unset` (and `revert`) are not colors, and `var(--…)` is always allowed.
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
 * - CSS (`.css`, `.scss`, and PostCSS's `.pcss`/`.postcss`): every declaration, with
 *   comments removed (and `//` line comments in `.scss`, whose `$variables` count as
 *   custom properties there only).
 * - A kind the check does not parse fails it (ERR_CHECK_UI_UNSUPPORTED_FILE) rather than
 *   passing unread, anywhere under `ui/`: another style syntax (Less's `.less`, indented
 *   Sass's `.sass`, Stylus's two extensions, SugarSS's `.sss`), `.htm` or `.xhtml` other
 *   than an entry page, and a single-file component (`.vue`, `.svelte`, `.mdx`, `.astro`).
 * - TypeScript and JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, and their `.m`/`.c` forms),
 *   read with the TypeScript compiler's parser and one checker over every scanned script,
 *   so comments and JSX text are never read, a name resolves to the binding in scope,
 *   and a name imported from another scanned module (named, default, namespace, or
 *   re-exported) resolves to what that module holds. Only a relative specifier is
 *   followed, with or without its extension (`./c`, `./c.ts`, `./c.js`, a directory's
 *   `index`); a root-absolute `/src/…` path, a `resolve.alias` name, a JSON module, and a
 *   package resolve to nothing, as does a module the check does not scan. A value
 *   given to a CSS-like property is judged as that declaration: an object key (a plain,
 *   quoted, or computed one, such as `color`, `"font-family"`, `["color"]`, or a
 *   `--custom` property), a JSX attribute such as `fill`, an assignment to
 *   `….style.color` or `….style["color"]`, and `….setProperty(name, value)`. The value
 *   is a string, a template (a substitution the check cannot read counts as `0`, so
 *   `` `${n}px` `` is a pixel size), a `const` in scope or imported, every value a `let`
 *   or `var` is given (its initializer and each `=`, `+=`, `||=`, `??=`, or `&&=` to it),
 *   a member of an object literal such a binding holds, and each branch of a `?:`, `||`,
 *   `??`, or `&&`; a number given to `fontSize` is a pixel size (React appends px). A
 *   binding is resolved once per run, and one met again while it is being resolved (a
 *   `let` assigned from itself) adds nothing there, so no spelling makes the check
 *   recurse without end. A raw value a binding holds is reported once, where it is
 *   declared when it is flagged there (in whichever file), otherwise where it is used.
 *   Any other string is flagged when it is a hex color as a whole (except one given
 *   directly to `href`, `xlinkHref`, `id`, `htmlFor`, or an `aria-*` JSX attribute, where
 *   `#add` is a fragment, not a color), holds a color
 *   function, or holds a CSS declaration of a color or font property (CSS in a template
 *   literal). A bare word such as `"red"` in an unrelated string is not flagged, nor is
 *   one an imported or `let` binding holds until a style reads it: copy and variant
 *   names use such words.
 * - Markup (`.html`, `.svg`): the declarations of every `style` attribute and `<style>`
 *   element, every attribute named like a CSS-like property (`fill`, `stroke`,
 *   `stop-color`, `font-family`, `font-size`, where a bare number is a pixel size), and
 *   the `content` of a `<meta>` whose `name` ends in `color` (`theme-color`), as a color,
 *   with comments removed; that value's Next line says to remove the meta or set it at
 *   runtime, since `var()` cannot appear in `content`. An inline `<script>` body of a
 *   JavaScript type is read as a script (above), with its findings on its lines in the
 *   markup file; one of a JSON type (`importmap`, `application/json`,
 *   `application/ld+json`) is data and is not judged. A tag whose attributes the check
 *   cannot read, an inline script of any other type, one the parser reports a syntax
 *   error in (no other gate parses it; `ui/src/` is left to tsc and ESLint), and a
 *   `<script>` with no `</script>` (whose rest is then not read as markup) fail the check
 *   rather than passing unread.
 *
 * Not scanned: `ui/src/design/tokens.css` (where the values live), test files
 * (`*.test.ts`, `*.test.tsx`, and the JavaScript forms), which never ship and must feed
 * raw values to the token parser's and contrast tests, and any `node_modules/`.
 * `ui/src/design/contrast-pairs.ts` is scanned: it holds token names (`--color-…`),
 * which are not colors.
 *
 *   node scripts/checks/ui-literals.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING (no ui/src/), ERR_CHECK_INPUT_UNREADABLE (ui/src/, or a
 * directory or file the check walks, cannot be read: the path and its errno),
 * ERR_CHECK_UI_RAW_COLOR,
 * ERR_CHECK_UI_FONT_FAMILY, ERR_CHECK_UI_PIXEL_FONT_SIZE, ERR_CHECK_UI_UNPARSED (a
 * markup tag, or an inline script's type, syntax, or missing `</script>`, it cannot
 * read), ERR_CHECK_UI_UNSUPPORTED_FILE (a file kind it does not parse).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, type Check } from "./lib.ts";
import {
  bindingOf,
  blank,
  parseScripts,
  SCRIPT_FILE,
  TEST_FILE,
  type ScriptSource,
} from "./shared/sources.ts";

const UI = "ui";
const UI_SRC = "ui/src";
const TOKENS = "ui/src/design/tokens.css";
/** CSS, SCSS, and PostCSS files, which are written in CSS syntax. */
const CSS_FILE = /\.(?:s?css|p(?:ost)?css)$/;
/** What `ui/public/` holds that the WebView applies as a stylesheet. */
const PUBLIC_CSS_FILE = /\.(?:css|p(?:ost)?css)$/;
const MARKUP_FILE = /\.(?:html|svg)$/;
/** An entry page, directly under `ui/`. */
const ENTRY_PAGE = /^ui\/[^/]+\.(?:html|htm|xhtml)$/;
/**
 * Files the check does not parse, and so refuses rather than passes: other style
 * syntaxes (Less, indented Sass, Stylus, SugarSS), markup under another extension, and
 * single-file component formats.
 */
const REFUSED_FILE = /\.(?:less|sass|sty(?:l|lus)|sss|htm|xhtml|vue|svelte|mdx|astro)$/;

const errnoOf = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : String(error);

/** Whether the path is a directory; a stat failure other than a missing path rethrows. */
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === "ENOENT" || errno === "ENOTDIR") return false;
    throw error;
  }
};

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

type Rule = "raw" | "family" | "pixel" | "unparsed" | "script" | "file";

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
  /** The Next line for this value's findings, where the rule's own would mislead. */
  readonly next?: string;
}

/** Something the check could not read, which fails it rather than passing unread. */
interface Unreadable {
  readonly rule: "unparsed" | "script" | "file";
  readonly line: number;
  readonly what: string;
  /** The Next line, where the rule's own does not fit this case. */
  readonly next?: string;
}

/** What a file yields: the values to judge, and what it could not read. */
interface Scanned {
  readonly units: Unit[];
  readonly unreadable: readonly Unreadable[];
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

/** A binding or member the resolution reaches, and the expressions it holds. */
interface Target {
  readonly key: ts.Node;
  readonly values: readonly ts.Expression[];
}

/**
 * A resolution memoized per key (a binding's declaration, a member's initializer), so
 * each is resolved once per run however many paths reach it. A key met again while it is
 * still being resolved yields nothing there: a `let` assigned from itself
 * (`c = p ? c : "…"`) contributes its other values and never recurses. When the first key
 * of such a cycle is done it holds everything the cycle reaches, and every other key in
 * the cycle is given that result (Tarjan's strongly connected components).
 */
function memoized<T>(): (key: ts.Node, compute: () => T[]) => T[] {
  const done = new Map<ts.Node, T[]>();
  const stack: { key: ts.Node; low: number }[] = [];
  const cycle: { key: ts.Node; depth: number }[] = [];
  return (key, compute) => {
    const known = done.get(key);
    if (known !== undefined) return known;
    const at = stack.findIndex((frame) => frame.key === key);
    const top = stack.at(-1);
    if (at !== -1) {
      if (top !== undefined) top.low = Math.min(top.low, at);
      return [];
    }
    const depth = stack.length;
    const frame = { key, low: depth };
    stack.push(frame);
    const result = compute();
    stack.pop();
    done.set(key, result);
    if (frame.low < depth) {
      if (top !== undefined) top.low = Math.min(top.low, frame.low);
      cycle.push({ key, depth });
    } else {
      for (let member = cycle.at(-1); member !== undefined && member.depth > depth;) {
        done.set(member.key, result);
        cycle.pop();
        member = cycle.at(-1);
      }
    }
    return result;
  };
}

/** Where a literal is written: its file and span. */
const placeOf = (node: ts.Node): string => `${node.getSourceFile().fileName}:${String(node.pos)}`;

/** `values` without repeats: the same text, from the same literals. */
function distinctValues(values: readonly Resolved[]): Resolved[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = [
      value.text,
      String(value.numeric),
      ...value.direct.map(placeOf),
      "|",
      ...value.via.map(placeOf),
    ].join(" ");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const distinctNodes = <T extends ts.Node>(nodes: readonly T[]): T[] => [...new Set(nodes)];

/** A script to scan: the file it is reported under, and its own name in the program. */
interface ScriptEntry extends ScriptSource {
  readonly reportAs: string;
  /**
   * An inline `<script>` body, which no other gate parses: a syntax error in it fails the
   * check rather than leaving part of it unread. (tsc and ESLint parse `ui/src/`.)
   */
  readonly inline: boolean;
}

/**
 * Every script at once, so a name imported from another scanned module resolves to what
 * that module holds. The units of each script, keyed by the file it is reported under.
 */
function scanScripts(entries: readonly ScriptEntry[]): Map<string, Scanned> {
  const { files, checker, syntaxErrors } = parseScripts(entries);
  const parsed = entries.flatMap((entry) => {
    const file = files.get(entry.path);
    return file === undefined ? [] : [{ file, reportAs: entry.reportAs }];
  });

  const propertyName = (node: ts.PropertyName): string | undefined => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    if (!ts.isComputedPropertyName(node)) return undefined;
    const [only, ...more] = resolveAll(node.expression);
    return only !== undefined && more.length === 0 && !only.numeric ? only.text : undefined;
  };

  const values = memoized<Resolved>();
  const objects = memoized<ts.ObjectLiteralExpression>();

  /**
   * What a name or a member leads to, each under the key its resolution is memoized by: a
   * binding's values under its declaration, a member's initializer under itself.
   */
  const targetsOf = (node: ts.Expression): Target[] => {
    if (ts.isIdentifier(node)) {
      const binding = bindingOf(checker, node);
      return binding === undefined ? [] : [{ key: binding.declaration, values: binding.values }];
    }
    return membersOf(node).map((initializer) => ({ key: initializer, values: [initializer] }));
  };

  /** The object literals an expression can be, through bindings and members. */
  const objectsOf = (node: ts.Expression): ts.ObjectLiteralExpression[] => {
    const inner = unwrap(node);
    if (ts.isObjectLiteralExpression(inner)) return [inner];
    return targetsOf(inner).flatMap((target) =>
      objects(target.key, () => distinctNodes(target.values.flatMap(objectsOf))),
    );
  };

  /**
   * The initializers `P.name` or `P["name"]` reads from the object literals `P` can be;
   * failing that, `ns.name`'s own name, which resolves to the export when `ns` is a
   * namespace import.
   */
  const membersOf = (node: ts.Expression): ts.Expression[] => {
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
    } else return [];
    if (name === undefined) return [];
    const found = objectsOf(object).flatMap((literal) => {
      const property = literal.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && propertyName(p.name) === name,
      );
      return property === undefined ? [] : [property.initializer];
    });
    return found.length > 0 || !ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.name)
      ? found
      : [node.name];
  };

  /** Every value an expression can take that the check can read. */
  const resolveAll = (node: ts.Expression, throughConst = false): Resolved[] => {
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
        const parts = resolveAll(span.expression, throughConst);
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
        ...resolveAll(inner.whenTrue, throughConst),
        ...resolveAll(inner.whenFalse, throughConst),
      ];
    }
    if (
      ts.isBinaryExpression(inner) &&
      (inner.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      return [...resolveAll(inner.left, throughConst), ...resolveAll(inner.right, throughConst)];
    }
    return targetsOf(inner).flatMap((target) =>
      values(target.key, () =>
        distinctValues(target.values.flatMap((value) => resolveAll(value, true))),
      ),
    );
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

  // First pass, over every script: each site and the literals it claims, so a literal is
  // judged once, as its site's value, and never again as a free string — and a literal
  // another script reads through an import is known to be reported where it is written.
  const sites: { reportAs: string; site: Site; property: string; values: Resolved[] }[] = [];
  const claimed = new Map<ts.Node, { property: string; surelyCss: boolean }>();
  for (const { file, reportAs } of parsed) {
    const collect = (node: ts.Node): void => {
      const site = siteOf(node);
      const property = cssProperty(site?.name);
      if (site !== undefined && property !== undefined) {
        const values = resolveAll(site.value);
        sites.push({ reportAs, site, property, values });
        for (const value of values) {
          for (const literal of value.direct)
            claimed.set(literal, { property, surelyCss: site.surelyCss });
        }
      }
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(file, collect);
  }

  const lineAt = (node: ts.Node): number => {
    const file = node.getSourceFile();
    return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  };
  const freeParts = (node: ts.Node): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node))
      return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    return [];
  };
  /** What a literal read through a binding already reports where it is declared. */
  const reportedWhereDeclared = (literal: ts.Node): string[] => {
    const owner = claimed.get(literal);
    if (owner === undefined)
      return freeParts(literal).flatMap((part) => judgeString(part).map(key));
    if (!ts.isStringLiteralLike(literal)) return [];
    return judgeDeclaration(owner.property, literal.text, owner.surelyCss).map(key);
  };

  const scanned = new Map<string, { units: Unit[]; unreadable: Unreadable[] }>();
  const of = (reportAs: string): { units: Unit[]; unreadable: Unreadable[] } => {
    const known = scanned.get(reportAs);
    if (known !== undefined) return known;
    const fresh = { units: [], unreadable: [] };
    scanned.set(reportAs, fresh);
    return fresh;
  };
  const add = (reportAs: string, unit: Unit): void => {
    of(reportAs).units.push(unit);
  };
  for (const entry of entries) {
    const [error] = entry.inline ? syntaxErrors(entry.path) : [];
    if (error === undefined) continue;
    of(entry.reportAs).unreadable.push({
      rule: "script",
      line: error.file.getLineAndCharacterOfPosition(error.start).line + 1,
      what: ts.flattenDiagnosticMessageText(error.messageText, " "),
      next: "fix the script's syntax (the WebView refuses it too), or move it into a file under ui/src/",
    });
  }
  for (const { reportAs, site, property, values } of sites) {
    for (const value of values) {
      const anchor = value.direct[0] ?? site.value;
      add(reportAs, {
        line: lineAt(anchor),
        property,
        value: value.text,
        numeric: value.numeric,
        surelyCss: site.surelyCss,
        scope: site.scope,
        shown:
          value.via.length > 0
            ? `${property}: ${site.value.getText()} (${JSON.stringify(value.text)})`
            : `${property}: ${value.text}`,
        reported: new Set(value.via.flatMap(reportedWhereDeclared)),
      });
    }
  }
  for (const { file, reportAs } of parsed) {
    const free = (node: ts.Node): void => {
      const isModuleName =
        ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent);
      if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && !claimed.has(node)) {
        if (!isModuleName && !isAnchor(node)) {
          const parts = ts.isTemplateExpression(node)
            ? [node.head, ...node.templateSpans.map((span) => span.literal)]
            : [node];
          for (const part of parts) {
            add(reportAs, {
              line: lineAt(part),
              property: undefined,
              value: part.text,
              numeric: false,
              surelyCss: false,
              scope: `ts@${String(node.pos)}`,
              shown: node.getText(),
              reported: NONE,
            });
          }
        }
      }
      ts.forEachChild(node, free);
    };
    ts.forEachChild(file, free);
  }
  return scanned;
}

/** A JSX attribute whose value is a reference, never CSS: `href="#add"` is a fragment. */
const REFERENCE_ATTRIBUTE = /^(?:href|xlinkHref|id|htmlFor|aria-[a-z]+)$/;

/** A whole-hex string given directly to a reference attribute, where it names an anchor. */
function isAnchor(node: ts.Node): boolean {
  if (!ts.isStringLiteralLike(node) || !WHOLE_HEX.test(node.text.trim())) return false;
  const holder = ts.isJsxExpression(node.parent) ? node.parent.parent : node.parent;
  return (
    ts.isJsxAttribute(holder) &&
    ts.isIdentifier(holder.name) &&
    REFERENCE_ATTRIBUTE.test(holder.name.text)
  );
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

/** A `<script>` type whose body is JavaScript (the HTML standard's JavaScript MIME types). */
const JS_TYPE =
  /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript)|text\/javascript1\.[0-5])$/i;
/** A `<script>` type whose body is JSON: an import map, speculation rules, a JSON block. */
const JSON_TYPE = /^(?:importmap|speculationrules|(?:application|text)\/(?:[\w.-]+\+)?json)$/i;
const TYPE_ATTRIBUTE = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const SCRIPT_ELEMENT = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;

/** What a markup file yields, and the bodies of its inline scripts, read as scripts. */
interface ScannedMarkup extends Scanned {
  readonly scripts: readonly ScriptEntry[];
}

/**
 * HTML or SVG: `style` attributes, `<style>` elements, CSS-like attributes, the `content`
 * of a `<meta>` whose `name` is a color (`theme-color`), and the body of each inline
 * `<script>`, returned to be read with the other scripts at its own lines.
 */
function scanMarkup(path: string, source: string): ScannedMarkup {
  let text = source.replace(/<!--[\s\S]*?-->/g, blank);
  const unreadable: Unreadable[] = [];
  const scripts: ScriptEntry[] = [];
  const inside: (readonly [number, number])[] = [];
  for (const match of text.matchAll(SCRIPT_ELEMENT)) {
    inside.push([match.index, match.index + match[0].length]);
    const open = match[1] ?? "";
    const body = match[2] ?? "";
    const typed = TYPE_ATTRIBUTE.exec(open);
    const type = (typed?.[1] ?? typed?.[2] ?? typed?.[3] ?? "").trim();
    // A JSON type is data (an import map, a JSON block), never a style: it is not judged.
    if (body.trim() === "" || JSON_TYPE.test(type)) continue;
    if (JS_TYPE.test(type)) {
      // Blanking what precedes the body keeps each finding on its line in the markup file.
      const before = blank(text.slice(0, match.index + open.length));
      const name = `${path}#script${String(scripts.length + 1)}.js`;
      scripts.push({ reportAs: path, path: name, source: `${before}${body}`, inline: true });
    } else {
      unreadable.push({ rule: "script", line: lineOf(text, match.index), what: open });
    }
  }
  // A <script> with no </script>: the rest of the file is its body, not markup to read.
  const unclosed = [...text.matchAll(/<script\b/gi)].find(
    (open) => !inside.some(([start, end]) => open.index >= start && open.index < end),
  );
  if (unclosed !== undefined) {
    const lineEnd = text.indexOf("\n", unclosed.index);
    unreadable.push({
      rule: "script",
      line: lineOf(text, unclosed.index),
      what: text.slice(unclosed.index, lineEnd < 0 ? undefined : lineEnd).trim(),
      next: "close the <script> with </script>; until it is closed, nothing after it is read",
    });
    text = `${text.slice(0, unclosed.index)}${blank(text.slice(unclosed.index))}`;
  }
  text = text.replace(
    SCRIPT_ELEMENT,
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

  const valueUnit = (property: string, shown: string, value: string, at: number): Unit => ({
    line: lineOf(text, at),
    property,
    value,
    numeric: property === "font-size" && /^\s*\d*\.?\d+\s*$/.test(value),
    surelyCss: true,
    scope: `attr@${String(at)}`,
    shown,
    reported: NONE,
  });
  const attribute = (name: string, value: string, at: number): void => {
    if (name === "style") {
      units.push(
        ...cssUnits(value, { sass: false, scope: `attr@${String(at)}`, base: at, whole: text }),
      );
      return;
    }
    const property = cssProperty(name);
    if (property !== undefined) units.push(valueUnit(property, `${name}="${value}"`, value, at));
  };
  interface Attribute {
    readonly name: string;
    readonly value: string;
    readonly at: number;
  }
  /** A `<meta name="theme-color">` (or another `…color` name): its `content` is a color. */
  const meta = (attributes: readonly Attribute[]): void => {
    const named = attributes.find((a) => a.name === "name");
    const content = attributes.find((a) => a.name === "content");
    if (named === undefined || content === undefined || !/color$/i.test(named.value.trim())) return;
    const shown = `<meta name="${named.value}" content="${content.value}">`;
    units.push({
      ...valueUnit("color", shown, content.value, content.at),
      next: `remove the <meta name="${named.value}">, or set its content at runtime from the token (getComputedStyle(document.documentElement).getPropertyValue("--color-…")): var() cannot appear in a meta's content`,
    });
  };
  /**
   * Read the tag whose name starts at `at`, judging each attribute read (even when a later
   * one is unreadable); the offset after the tag, or -1 if it is unreadable.
   */
  const tag = (at: number): number => {
    let i = stickyEnd(TAG_NAME, text, at);
    const tagName = text.slice(at, i).toLowerCase();
    const attributes: Attribute[] = [];
    const done = (end: number): number => {
      for (const { name, value, at: valueAt } of attributes) attribute(name, value, valueAt);
      if (tagName === "meta") meta(attributes);
      return end;
    };
    for (;;) {
      i = stickyEnd(SPACE, text, i);
      if (text[i] === ">") return done(i + 1);
      if (text.startsWith("/>", i)) return done(i + 2);
      const nameEnd = stickyEnd(ATTRIBUTE_NAME, text, i);
      if (nameEnd === -1) return done(-1);
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
        if (close === -1) return done(-1);
        attributes.push({ name, value: text.slice(valueAt + 1, close), at: valueAt + 1 });
        i = close + 1;
      } else {
        const end = stickyEnd(UNQUOTED, text, valueAt);
        if (end === -1) return done(-1);
        attributes.push({ name, value: text.slice(valueAt, end), at: valueAt });
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
      unreadable.push({ rule: "unparsed", line: lineOf(text, at), what });
    } else at = end - 1;
  }
  return { units, unreadable, scripts };
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
  readonly next?: string | undefined;
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

type Kind = "css" | "markup" | "script" | "refused";

/**
 * How a file under `ui/` is read, or undefined when it is not: everything under
 * `ui/src/`, each entry page directly under `ui/`, only the stylesheets in `ui/public/`
 * (an SVG there is loaded as an image, where var() cannot work, and a script there is
 * vendored), and a refused kind anywhere.
 */
function kindOf(path: string): Kind | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (TEST_FILE.test(name) || path === TOKENS) return undefined;
  if (ENTRY_PAGE.test(path)) return "markup";
  if (REFUSED_FILE.test(name)) return "refused";
  if (path.startsWith(`${UI_SRC}/`)) {
    if (CSS_FILE.test(name)) return "css";
    if (MARKUP_FILE.test(name)) return "markup";
    return SCRIPT_FILE.test(name) ? "script" : undefined;
  }
  return path.startsWith(`${UI}/public/`) && PUBLIC_CSS_FILE.test(name) ? "css" : undefined;
}

function unreadableInput(path: string, what: "directory" | "file", error: unknown): FailureDetails {
  return {
    code: "ERR_CHECK_INPUT_UNREADABLE",
    summary: `${path} cannot be read`,
    expected: `a readable ${what}, so nothing under ${UI}/ passes unjudged`,
    actual: errnoOf(error),
    next: `restore read permission on ${path} (ls -ld ${path}), then rerun just check-harness`,
  };
}

function files(root: string, dir: string, failures: FailureDetails[]): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch (error) {
    failures.push(unreadableInput(`${dir}/`, "directory", error));
    return [];
  }
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return entry.name === "node_modules" ? [] : files(root, path, failures);
      }
      return kindOf(path) === undefined ? [] : [path];
    });
}

/** Every file's findings to judge; the scripts, markup's inline ones included, read together. */
function scanAll(
  root: string,
  paths: readonly string[],
  failures: FailureDetails[],
): (Scanned & { path: string })[] {
  const scripts: ScriptEntry[] = [];
  const scanned = paths.map((path): Scanned & { path: string } => {
    const kind = kindOf(path);
    if (kind === "refused") {
      const what = /\.[^./]+$/.exec(path)?.[0] ?? path;
      const next = `this check cannot read ${what} files: write the styles as CSS using the tokens (var(--…) from ${TOKENS}), and markup as .html or .tsx`;
      return { path, units: [], unreadable: [{ rule: "file", line: 1, what, next }] };
    }
    let source: string;
    try {
      source = readFileSync(join(root, path), "utf8");
    } catch (error) {
      failures.push(unreadableInput(path, "file", error));
      return { path, units: [], unreadable: [] };
    }
    if (kind === "css") return { path, ...scanCss(path, source) };
    if (kind === "markup") {
      const markup = scanMarkup(path, source);
      scripts.push(...markup.scripts);
      return { path, units: markup.units, unreadable: markup.unreadable };
    }
    scripts.push({ reportAs: path, path, source, inline: false });
    return { path, units: [], unreadable: [] };
  });
  const fromScripts = scanScripts(scripts);
  return scanned.map((file) => ({
    ...file,
    units: [...file.units, ...(fromScripts.get(file.path)?.units ?? [])],
    unreadable: [...file.unreadable, ...(fromScripts.get(file.path)?.unreadable ?? [])],
  }));
}

/**
 * Each rule's code and wording. A raw-value rule (`raw`, `family`, `pixel`) and an
 * unreadable tag read "… outside tokens.css" and name it as the one home of raw values;
 * a script or a file the check cannot read is not a raw value, so its wording stands
 * alone (`standalone`).
 */
const RULES: Readonly<
  Record<Rule, { code: string; summary: string; expected: string; next: string; standalone?: true }>
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
  script: {
    code: "ERR_CHECK_UI_UNPARSED",
    summary: "unreadable script",
    expected:
      "inline scripts the check can read — a JavaScript type, closed, with valid syntax — so no style they set passes unjudged (a JSON type is data and is not read)",
    next: "give the <script> a JavaScript type (none, `module`, `text/javascript`), or move its content into a file under ui/src/",
    standalone: true,
  },
  file: {
    code: "ERR_CHECK_UI_UNSUPPORTED_FILE",
    summary: "this check cannot read",
    expected:
      "UI files in kinds the check reads — CSS (.css, .scss, .pcss, .postcss), markup (.html, .svg), scripts (.ts, .tsx, .js, .jsx) — so no value passes unjudged",
    next: `write the styles as CSS using the tokens (var(--…) from ${TOKENS})`,
    standalone: true,
  },
};

function run(root: string): FailureDetails[] {
  let present: boolean;
  try {
    present = isDirectory(join(root, UI_SRC));
  } catch (error) {
    return [unreadableInput(`${UI_SRC}/`, "directory", error)];
  }
  if (!present) {
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
  const failures: FailureDetails[] = [];
  const scanned = scanAll(root, files(root, UI, failures), failures);
  const direct = scanned.flatMap(({ path, units, unreadable }) => [
    ...unreadable.map(({ rule, line, what, next }): Located => ({
      code: rule,
      what,
      path,
      line,
      declaration: rule === "file" ? `${path}, a ${what} file` : what,
      next,
    })),
    ...units.flatMap((unit) =>
      judgeUnit(unit).map((finding): Located => ({
        ...finding,
        path,
        line: unit.line,
        declaration: unit.shown,
        next: unit.next,
      })),
    ),
  ]);
  const order = new Map(scanned.map(({ path }, i) => [path, i]));
  const located = [
    ...direct,
    ...throughLocals(scanned.flatMap(({ path, units }) => units.flatMap((u) => held(path, u)))),
  ].sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || a.line - b.line);
  const findings = located.map((finding): FailureDetails => {
    const rule = RULES[finding.code];
    const where = `${finding.path}:${String(finding.line)}`;
    return {
      code: rule.code,
      summary:
        rule.standalone === true
          ? `${where}: ${rule.summary} \`${finding.what}\``
          : `${where}: ${rule.summary} \`${finding.what}\` outside ${TOKENS}`,
      expected:
        rule.standalone === true
          ? rule.expected
          : `${rule.expected} (${TOKENS} is the one file that holds raw values)`,
      actual: `\`${finding.declaration}\``,
      next: finding.next ?? rule.next,
    };
  });
  return [...failures, ...findings];
}

export const check: Check = { name: "ui-literals", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
