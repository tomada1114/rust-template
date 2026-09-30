/**
 * A GitHub Actions expression (`${{ … }}`) evaluated as it would be for one event, a
 * `push` or a `pull_request`, so a concurrency rule can ask what a group or a
 * `cancel-in-progress` value becomes on a push run, and a ruleset rule whether a job's
 * `if:` or `name:` is fixed on a pull request, instead of grepping for a token. Reads
 * literals, context paths, `!`, `==`, `!=`, `&&`, `||`, and parentheses — the forms a
 * concurrency block, a job condition, or a job name uses. Anything else (a function
 * call, `<`, an index) makes the whole value unreadable, and a caller treats unreadable
 * as unproven, never as safe.
 *
 * On a push, `github.event_name` is `'push'`, `github.head_ref` and `github.base_ref` are
 * empty, and `github.event.pull_request` is null. On a pull request, `github.event_name`
 * is `'pull_request'`, and `github.head_ref`, `github.base_ref`, and
 * `github.event.pull_request` are set. Every other context path stays symbolic: its
 * truthiness is known only for the NON_EMPTY paths of that event, so `!x` or `x && y`
 * over any other path is unknown rather than guessed.
 */

/** The events an expression can be evaluated for. */
export type Event = "push" | "pull_request";

/** What an expression is on a run of one event: a literal, a symbolic context path, or unknown. */
export type ExpressionValue =
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "context"; readonly path: string }
  | { readonly kind: "unknown" };

/** What an expression is on a push run (see {@link ExpressionValue}). */
export type PushValue = ExpressionValue;

/** Context paths that are never empty on a run of any event. */
const ALWAYS_SET = [
  "github.sha",
  "github.ref",
  "github.ref_name",
  "github.workflow",
  "github.run_id",
  "github.run_number",
  "github.run_attempt",
  "github.repository",
  "github.actor",
];

/** Context paths that are never empty, per event. */
const NON_EMPTY: Readonly<Record<Event, ReadonlySet<string>>> = {
  push: new Set(ALWAYS_SET),
  pull_request: new Set([
    ...ALWAYS_SET,
    "github.head_ref",
    "github.base_ref",
    "github.event.number",
    "github.event.pull_request",
    "github.event.pull_request.number",
  ]),
};

type Token =
  | { readonly type: "op"; readonly op: string }
  | { readonly type: "value"; readonly value: ExpressionValue };

const UNKNOWN: ExpressionValue = { kind: "unknown" };
const literal = (value: string | number | boolean | null): ExpressionValue => ({
  kind: "literal",
  value,
});

function contextOn(event: Event, path: string): ExpressionValue {
  const lower = path.toLowerCase();
  if (lower === "github.event_name") return literal(event);
  if (event === "push") {
    if (lower === "github.head_ref" || lower === "github.base_ref") return literal("");
    if (lower === "github.event.number" || lower.startsWith("github.event.pull_request")) {
      return literal(null);
    }
  }
  return { kind: "context", path: lower };
}

const PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\*))*/;
const NUMBER = /^-?\d+(?:\.\d+)?/;

function tokenize(source: string, event: Event): Token[] | undefined {
  const tokens: Token[] = [];
  let rest = source.trim();
  while (rest !== "") {
    const op = ["==", "!=", "&&", "||", "!", "(", ")"].find((candidate) =>
      rest.startsWith(candidate),
    );
    if (op !== undefined) {
      tokens.push({ type: "op", op });
      rest = rest.slice(op.length).trimStart();
      continue;
    }
    if (rest.startsWith("'")) {
      const end = /^'((?:[^']|'')*)'/.exec(rest);
      if (end === null) return undefined;
      tokens.push({ type: "value", value: literal((end[1] ?? "").replaceAll("''", "'")) });
      rest = rest.slice(end[0].length).trimStart();
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number !== null) {
      tokens.push({ type: "value", value: literal(Number(number[0])) });
      rest = rest.slice(number[0].length).trimStart();
      continue;
    }
    const path = PATH.exec(rest);
    if (path === null) return undefined;
    rest = rest.slice(path[0].length).trimStart();
    // A function call or an index is outside what this reads.
    if (rest.startsWith("(") || rest.startsWith("[")) return undefined;
    const word = path[0];
    const keyword = word === "true" ? true : word === "false" ? false : undefined;
    tokens.push({
      type: "value",
      value:
        keyword !== undefined
          ? literal(keyword)
          : word === "null"
            ? literal(null)
            : contextOn(event, word),
    });
  }
  return tokens;
}

/**
 * Whether a value is truthy on a run of `event` (a push unless named), or undefined when
 * that is not known.
 */
export function truthy(value: ExpressionValue, event: Event = "push"): boolean | undefined {
  switch (value.kind) {
    case "literal":
      return (
        value.value !== false && value.value !== 0 && value.value !== "" && value.value !== null
      );
    case "context":
      return NON_EMPTY[event].has(value.path) ? true : undefined;
    case "unknown":
      return undefined;
  }
}

function toNumber(value: string | number | boolean | null): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" ? value : Number(value);
}

function equal(left: ExpressionValue, right: ExpressionValue): boolean | undefined {
  if (left.kind !== "literal" || right.kind !== "literal") return undefined;
  const [a, b] = [left.value, right.value];
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b;
  return toNumber(a) === toNumber(b);
}

/** A recursive-descent parse over the tokens, by GitHub's precedence: `!`, `==`/`!=`, `&&`, `||`. */
function parse(tokens: readonly Token[], event: Event): ExpressionValue | undefined {
  let index = 0;
  const peek = (op: string): boolean => {
    const token = tokens[index];
    return token?.type === "op" && token.op === op;
  };

  const primary = (): ExpressionValue | undefined => {
    const token = tokens[index];
    if (token === undefined) return undefined;
    index += 1;
    if (token.type === "value") return token.value;
    if (token.op !== "(") return undefined;
    const inner = or();
    if (inner === undefined || !peek(")")) return undefined;
    index += 1;
    return inner;
  };

  const unary = (): ExpressionValue | undefined => {
    if (!peek("!")) return primary();
    index += 1;
    const operand = unary();
    if (operand === undefined) return undefined;
    const test = truthy(operand, event);
    return test === undefined ? UNKNOWN : literal(!test);
  };

  const equality = (): ExpressionValue | undefined => {
    let left = unary();
    while (left !== undefined && (peek("==") || peek("!="))) {
      const negate = peek("!=");
      index += 1;
      const right = unary();
      if (right === undefined) return undefined;
      const same = equal(left, right);
      left = same === undefined ? UNKNOWN : literal(negate ? !same : same);
    }
    return left;
  };

  const and = (): ExpressionValue | undefined => {
    let left = equality();
    while (left !== undefined && peek("&&")) {
      index += 1;
      const right = equality();
      if (right === undefined) return undefined;
      const test = truthy(left, event);
      left = test === undefined ? UNKNOWN : test ? right : left;
    }
    return left;
  };

  function or(): ExpressionValue | undefined {
    let left = and();
    while (left !== undefined && peek("||")) {
      index += 1;
      const right = and();
      if (right === undefined) return undefined;
      const test = truthy(left, event);
      left = test === undefined ? UNKNOWN : test ? left : right;
    }
    return left;
  }

  const value = or();
  return value !== undefined && index === tokens.length ? value : undefined;
}

/** One expression's value on a run of `event`, or undefined when it cannot be read. */
export function evaluateOn(event: Event, expression: string): ExpressionValue | undefined {
  const tokens = tokenize(expression, event);
  return tokens === undefined ? undefined : parse(tokens, event);
}

/** One expression's value on a push run, or undefined when it cannot be read. */
export function evaluateOnPush(expression: string): PushValue | undefined {
  return evaluateOn("push", expression);
}

const EMBEDDED = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * A string that may embed `${{ … }}` expressions, as the parts it is made of on a run of
 * `event` (the text between expressions as literals), or undefined when one expression
 * cannot be read.
 */
export function templateOn(event: Event, text: string): ExpressionValue[] | undefined {
  const parts: ExpressionValue[] = [];
  let last = 0;
  for (const match of text.matchAll(EMBEDDED)) {
    if (match.index > last) parts.push(literal(text.slice(last, match.index)));
    const value = evaluateOn(event, match[1] ?? "");
    if (value === undefined) return undefined;
    parts.push(value);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(literal(text.slice(last)));
  return parts;
}

/** {@link templateOn} for a push run. */
export function templateOnPush(text: string): PushValue[] | undefined {
  return templateOn("push", text);
}

/**
 * Whether an `if:` value is true on a run of `event`, or undefined when that is not
 * known. An `if:` is an expression with or without its `${{ }}` wrapper; a YAML boolean
 * is itself; text mixing an expression with other text is not read.
 */
export function conditionOn(event: Event, value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const source = isWholeExpression(value)
    ? value.trim().slice(3, -2)
    : value.includes("${{")
      ? undefined
      : value;
  const result = source === undefined ? undefined : evaluateOn(event, source);
  return result === undefined ? undefined : truthy(result, event);
}

/** Whether a string is exactly one `${{ … }}` expression and nothing else. */
export function isWholeExpression(text: string): boolean {
  const trimmed = text.trim();
  const matches = [...trimmed.matchAll(EMBEDDED)];
  return matches.length === 1 && matches[0]?.[0] === trimmed;
}
