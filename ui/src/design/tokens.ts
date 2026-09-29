/**
 * Reads tokens.css the way the contrast test needs: the custom properties declared on
 * `:root`, and those the dark `prefers-color-scheme` block overrides, with `var()`
 * references resolved to their final value.
 */
export interface TokenSets {
  readonly light: ReadonlyMap<string, string>;
  readonly dark: ReadonlyMap<string, string>;
  /** The names the dark block declares itself. */
  readonly darkDeclared: ReadonlySet<string>;
}

const DECLARATION = /(--[\w-]+)\s*:\s*([^;]+);/g;

function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(DECLARATION)) {
    if (name !== undefined && value !== undefined) found.set(name, value.trim());
  }
  return found;
}

/** The body of the first `{…}` block after `from`, braces balanced. */
function blockAfter(css: string, from: number): string {
  const open = css.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return css.slice(open + 1);
}

function resolve(
  name: string,
  values: ReadonlyMap<string, string>,
  seen = new Set<string>(),
): string {
  const value = values.get(name);
  if (value === undefined) throw new Error(`${name} is not declared`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference?.[1] === undefined) return value;
  if (seen.has(name)) throw new Error(`${name} refers to itself`);
  seen.add(name);
  return resolve(reference[1], values, seen);
}

function resolveAll(values: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...values.keys()].map((name) => [name, resolve(name, values)]));
}

export function parseTokens(source: string): TokenSets {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rootAt = css.search(/(^|\n):root\s*\{/);
  const light = declarations(blockAfter(css, rootAt));
  const darkAt = css.search(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/);
  const darkOverrides =
    darkAt === -1 ? new Map<string, string>() : declarations(blockAfter(css, darkAt));
  return {
    light: resolveAll(light),
    dark: resolveAll(new Map([...light, ...darkOverrides])),
    darkDeclared: new Set(darkOverrides.keys()),
  };
}

/** WCAG relative luminance of a `#rgb` or `#rrggbb` color. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (match?.[1] === undefined) throw new Error(`${hex} is not a hex color`);
  const digits = match[1].length === 3 ? match[1].replace(/./g, "$&$&") : match[1];
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => {
    const channel = Number.parseInt(digits.slice(i, i + 2), 16) / 255;
    return channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}
