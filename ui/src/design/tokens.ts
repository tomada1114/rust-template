/**
 * Reads tokens.css the way the contrast test needs: the custom properties declared on
 * `:root`, and those the dark `prefers-color-scheme` block overrides, with `var()`
 * references resolved to their final value. `requiredPairs` reads primitives.css for the
 * foreground/background token pairs its rules combine, so the contrast test can fail on
 * one that `CONTRAST_PAIRS` does not list.
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

/** A foreground and background token that one rule of the primitives' CSS combines. */
export interface RequiredPair {
  readonly selector: string;
  readonly foreground: string;
  readonly background: string;
}

type Role = "text" | "fill" | "boundary";
type Roles = Partial<Record<Role, string>>;

const SIDES = ["top", "right", "bottom", "left"] as const;
const ROLE_OF: ReadonlyMap<string, Role> = new Map<string, Role>([
  ["color", "text"],
  ["background", "fill"],
  ["background-color", "fill"],
  ["border", "boundary"],
  ["border-color", "boundary"],
  ["outline", "boundary"],
  ["outline-color", "boundary"],
  ...SIDES.flatMap((side): [string, Role][] => [
    [`border-${side}`, "boundary"],
    [`border-${side}-color`, "boundary"],
  ]),
]);

/** Each innermost `selectors { declarations }` rule, at-rule wrappers read through. */
function innermostRules(css: string): { selectors: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors = "", body = ""]) => ({
    selectors,
    body,
  }));
}

/** The roles a declaration block sets: each the last `--color-` token of its last declaration. */
function rolesOf(body: string, into: Roles): void {
  for (const declaration of body.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const role = ROLE_OF.get(declaration.slice(0, colon).trim().toLowerCase());
    if (role === undefined) continue;
    const tokens = [...declaration.slice(colon + 1).matchAll(/var\(\s*(--color-[\w-]+)/g)];
    const last = tokens.at(-1)?.[1];
    if (last !== undefined) into[role] = last;
  }
}

function baseOf(selector: string): string {
  const colon = selector.indexOf(":");
  const bare = colon === -1 ? selector : selector.slice(0, colon);
  const modifier = /^\.([\w-]+?)--[\w-]+$/.exec(bare);
  return modifier?.[1] === undefined ? bare : `.${modifier[1]}`;
}

/**
 * The foreground/background token pairs the rules in `css` combine: `color` with the
 * rule's own background, or else with each surface; a border or outline with each
 * surface, unless the rule's background is itself a surface. A `.x--mod` or `.x:state`
 * rule takes the roles it does not set from `.x`, and emits only when it sets one.
 */
export function requiredPairs(css: string, surfaces: readonly string[]): RequiredPair[] {
  const bySelector = new Map<string, Roles>();
  for (const { selectors, body } of innermostRules(css.replace(/\/\*[\s\S]*?\*\//g, ""))) {
    for (const raw of selectors.split(",")) {
      const selector = raw.trim();
      if (selector === "") continue;
      const roles = bySelector.get(selector) ?? {};
      rolesOf(body, roles);
      bySelector.set(selector, roles);
    }
  }
  const pairs: RequiredPair[] = [];
  const seen = new Set<string>();
  const add = (selector: string, foreground: string, background: string): void => {
    const key = `${selector}|${foreground}|${background}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ selector, foreground, background });
  };
  for (const [selector, own] of bySelector) {
    if (own.text === undefined && own.fill === undefined && own.boundary === undefined) continue;
    const base = baseOf(selector);
    const inherited = base === selector ? {} : (bySelector.get(base) ?? {});
    const roles: Roles = { ...inherited, ...own };
    if (roles.text !== undefined) {
      if (roles.fill === undefined) {
        for (const surface of surfaces) add(selector, roles.text, surface);
      } else add(selector, roles.text, roles.fill);
    }
    if (roles.boundary !== undefined && !surfaces.includes(roles.fill ?? "")) {
      for (const surface of surfaces) add(selector, roles.boundary, surface);
    }
  }
  return pairs;
}

/** Each required pair that no listed entry has the same foreground and background as. */
export function missingPairs(
  required: readonly RequiredPair[],
  listed: readonly { readonly foreground: string; readonly background: string }[],
): RequiredPair[] {
  return required.filter(
    (pair) =>
      !listed.some(
        (entry) => entry.foreground === pair.foreground && entry.background === pair.background,
      ),
  );
}
