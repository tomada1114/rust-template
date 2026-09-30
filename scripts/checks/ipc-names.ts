/**
 * The IPC names agree across the language boundary (design D4):
 *
 * - Commands: the functions registered in `tauri::generate_handler![…]` (in any `.rs`
 *   file under `src-tauri/src/`; each entry's last path segment is the command name)
 *   equal the names passed to `invoke` anywhere in `ui/src/ipc/` (every non-test
 *   TypeScript or JavaScript file there; `commands.ts` in practice).
 * - Events: the names Rust emits (the event argument of every `emit`, `emit_to`,
 *   `emit_filter`, and `emit_str*` call under `src-tauri/src/`, called as a method —
 *   `app.emit(…)` — or through a path — `tauri::Emitter::emit(app, …)`,
 *   `<AppHandle as Emitter>::emit(&app, …)`, whose first argument is the emitter — and
 *   named by a string literal, or a `const NAME: &str = "…"` declared there,
 *   `src-tauri/src/commands.rs`'s `pub const`s in practice) equal the names passed to
 *   `listen` or `once` anywhere in `ui/src/ipc/` (`events.ts` in practice).
 *
 * Rust is read as text with comments removed; TypeScript with the TypeScript compiler's
 * parser. A TypeScript name is a string literal, a template literal without
 * substitutions, or a `const` declared in the same file with such a value. A name the
 * check cannot read (a variable, an expression) is a violation, never a silent skip:
 * a name built at run time is a name no check can compare.
 *
 *   node scripts/checks/ipc-names.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING (src-tauri/src/lib.rs, commands.ts, or events.ts
 * absent), ERR_CHECK_IPC_UNPARSED (no generate_handler!, or a name that is not a
 * literal or a resolvable const), ERR_CHECK_IPC_COMMANDS_DIVERGED,
 * ERR_CHECK_IPC_EVENTS_DIVERGED.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const RUST_DIR = "src-tauri/src";
const LIB_RS = `${RUST_DIR}/lib.rs`;
const IPC_DIR = "ui/src/ipc";
const COMMANDS_TS = `${IPC_DIR}/commands.ts`;
const EVENTS_TS = `${IPC_DIR}/events.ts`;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Where a name was found: `path:line`. */
type Sites = Map<string, string[]>;

interface Found {
  readonly names: Sites;
  readonly violations: FailureDetails[];
}

function addSite(sites: Sites, name: string, site: string): void {
  sites.set(name, [...(sites.get(name) ?? []), site]);
}

const unparsed = (site: string, what: string, expected: string): FailureDetails => ({
  code: "ERR_CHECK_IPC_UNPARSED",
  summary: `${site}: ${what}`,
  expected,
  actual: what,
  next: "name the command or event with a string literal or a const holding one, so the Rust and TypeScript lists can be compared (design D4)",
});

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

const RAW_STRING = /b?r(#*)"/y;
const CHAR_LITERAL = /'(?:\\.[^']*|[^\\'])'/y;

/** The length of the Rust token at `i` that must be kept whole: a string or a char. */
function literalLength(source: string, i: number): number | undefined {
  RAW_STRING.lastIndex = i;
  const raw = /\w/.test(source[i - 1] ?? "") ? null : RAW_STRING.exec(source);
  if (raw !== null) {
    const hashes = raw[1] ?? "";
    const end = source.indexOf(`"${hashes}`, i + raw[0].length);
    return (end === -1 ? source.length : end + 1 + hashes.length) - i;
  }
  if (source[i] === '"') {
    let j = i + 1;
    while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
    return j + 1 - i;
  }
  if (source[i] === "'") {
    CHAR_LITERAL.lastIndex = i;
    // A lifetime (`'a`) is not a literal: one character, and scanning goes on.
    return CHAR_LITERAL.exec(source)?.[0].length ?? 1;
  }
  return undefined;
}

/**
 * Rust source with comments blanked (newlines kept, so offsets and lines survive).
 * Strings, raw strings, and char literals are kept whole.
 */
function stripRustComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  let out = "";
  let i = 0;
  while (i < source.length) {
    const literal = literalLength(source, i);
    let stop = i + (literal ?? 1);
    if (literal === undefined && source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
    } else if (literal === undefined && source.startsWith("/*", i)) {
      let depth = 0;
      stop = i;
      do {
        if (source.startsWith("/*", stop)) depth += 1;
        if (source.startsWith("*/", stop)) depth -= 1;
        stop += source.startsWith("/*", stop) || source.startsWith("*/", stop) ? 2 : 1;
      } while (depth > 0 && stop < source.length);
      out += blank(source.slice(i, stop));
    } else {
      out += source.slice(i, stop);
    }
    i = stop;
  }
  return out;
}

/** The top-level comma-separated arguments of the call whose `(` is at `open`. */
function callArguments(text: string, open: number): { text: string; offset: number }[] {
  const args: { text: string; offset: number }[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    const literal = i > open ? literalLength(text, i) : undefined;
    if (literal !== undefined) {
      i += literal - 1;
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push({ text: text.slice(start, i), offset: start });
        return args;
      }
    } else if (char === "," && depth === 1) {
      args.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  return args;
}

interface RustFile {
  readonly path: string;
  readonly text: string;
}

function rustFiles(root: string, dir: string): RustFile[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return rustFiles(root, path);
      const text = entry.name.endsWith(".rs") ? readRepoFile(root, path) : undefined;
      return text === undefined ? [] : [{ path, text: stripRustComments(text) }];
    });
}

function rustCommands(files: readonly RustFile[]): Found | undefined {
  const names: Sites = new Map();
  const violations: FailureDetails[] = [];
  let seen = false;
  for (const { path, text } of files) {
    for (const match of text.matchAll(/generate_handler!\s*[[(]/g)) {
      seen = true;
      const open = match.index + match[0].length - 1;
      for (const arg of callArguments(text, open)) {
        const entry = arg.text.trim();
        if (entry === "") continue;
        const site = `${path}:${String(lineAt(text, arg.offset + arg.text.indexOf(entry)))}`;
        const name = /^(?:[A-Za-z_]\w*\s*::\s*)*([A-Za-z_]\w*)$/.exec(entry)?.[1];
        if (name === undefined) {
          violations.push(
            unparsed(
              site,
              `\`${entry}\` in generate_handler! is not a command path`,
              "each generate_handler! entry a path to a #[tauri::command] function",
            ),
          );
        } else addSite(names, name, site);
      }
    }
  }
  return seen ? { names, violations } : undefined;
}

/**
 * A call of an `Emitter` method: `.emit(` as a method, or `::emit(` through a path, where
 * the emitter is the first argument and the event moves one place right.
 */
const EMIT = /(\.|::)\s*(emit(?:_str)?(?:_to|_filter)?)\s*(?:::\s*<[^>]*>\s*)?\(/g;
const RUST_CONST =
  /\bconst\s+([A-Za-z_]\w*)\s*:\s*&\s*(?:'static\s+)?str\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g;

function rustEvents(files: readonly RustFile[]): Found {
  const consts = new Map<string, string>();
  for (const { text } of files) {
    for (const [, name, value] of text.matchAll(RUST_CONST)) consts.set(name ?? "", value ?? "");
  }
  const names: Sites = new Map();
  const violations: FailureDetails[] = [];
  for (const { path, text } of files) {
    for (const match of text.matchAll(EMIT)) {
      const throughPath = match[1] === "::";
      const method = match[2] ?? "";
      const args = callArguments(text, match.index + match[0].length - 1);
      const arg = args[(method.endsWith("_to") ? 1 : 0) + (throughPath ? 1 : 0)];
      const site = `${path}:${String(lineAt(text, match.index))}`;
      const expr = (arg?.text ?? "").trim().replace(/^&\s*/, "");
      const literal = /^"((?:[^"\\]|\\.)*)"$/.exec(expr)?.[1];
      const constName = /^(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)$/.exec(expr)?.[1];
      const name = literal ?? (constName === undefined ? undefined : consts.get(constName));
      if (name === undefined) {
        violations.push(
          unparsed(
            site,
            `the event \`${expr}\` passed to ${throughPath ? "::" : "."}${method} is not a string literal or a \`const …: &str\` under ${RUST_DIR}`,
            'each event emitted with a `pub const NAME: &str = "…"` (design D4), or a string literal',
          ),
        );
      } else addSite(names, name, site);
    }
  }
  return { names, violations };
}

/** Every non-test TypeScript or JavaScript file under `dir`, sorted. */
function scriptFiles(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return scriptFiles(root, path);
      return SCRIPT_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
    });
}

const SCRIPT_KINDS: readonly (readonly [RegExp, ts.ScriptKind])[] = [
  [/\.tsx$/, ts.ScriptKind.TSX],
  [/\.jsx$/, ts.ScriptKind.JSX],
  [/\.[cm]?js$/, ts.ScriptKind.JS],
];

/** The names `paths` pass as the first argument to calls of `callees`. */
function tsNames(root: string, paths: readonly string[], callees: ReadonlySet<string>): Found {
  const names: Sites = new Map();
  const violations: FailureDetails[] = [];
  for (const path of paths) {
    const found = fileNames(root, path, callees);
    for (const [name, sites] of found.names) for (const site of sites) addSite(names, name, site);
    violations.push(...found.violations);
  }
  return { names, violations };
}

function fileNames(root: string, path: string, callees: ReadonlySet<string>): Found {
  const text = readRepoFile(root, path) ?? "";
  const kind = SCRIPT_KINDS.find(([pattern]) => pattern.test(path))?.[1] ?? ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const consts = new Map<string, string>();
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      consts.set(node.name.text, node.initializer.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name !== undefined && callees.has(name)) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const names: Sites = new Map();
  const violations: FailureDetails[] = [];
  for (const call of calls) {
    const site = `${path}:${String(file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1)}`;
    const [arg] = call.arguments;
    const name =
      arg === undefined
        ? undefined
        : ts.isStringLiteralLike(arg)
          ? arg.text
          : ts.isIdentifier(arg)
            ? consts.get(arg.text)
            : undefined;
    if (name === undefined) {
      violations.push(
        unparsed(
          site,
          `the name passed to ${call.expression.getText(file)}(…) is \`${arg?.getText(file) ?? "missing"}\`, not a string literal or a const in this file`,
          "each IPC name a string literal, or a `const` in the same file holding one",
        ),
      );
    } else addSite(names, name, site);
  }
  return { names, violations };
}

function compare(
  code: string,
  kind: string,
  rust: Sites,
  rustWhere: string,
  typescript: Sites,
  tsWhere: string,
): FailureDetails[] {
  const quote = kind === "command" ? (n: string) => `\`${n}\`` : (n: string) => `"${n}"`;
  const missing = (from: Sites, to: Sites, fromWhere: string, toWhere: string): FailureDetails[] =>
    [...from.keys()]
      .filter((name) => !to.has(name))
      .sort()
      .map((name) => ({
        code,
        summary: `the ${kind} ${quote(name)} is in ${fromWhere} but not ${toWhere}`,
        expected: `the same ${kind} names in ${rustWhere} and ${tsWhere} (design D4)`,
        actual: `${quote(name)} at ${(from.get(name) ?? []).join(", ")}; ${toWhere} has ${[...to.keys()].sort().map(quote).join(", ") || "none"}`,
        next: `add the ${kind} to ${toWhere}, or remove or rename it in ${fromWhere}; a rename changes both sides in one commit`,
      }));
  return [
    ...missing(rust, typescript, rustWhere, tsWhere),
    ...missing(typescript, rust, tsWhere, rustWhere),
  ];
}

function run(root: string): FailureDetails[] {
  const missing = [LIB_RS, COMMANDS_TS, EVENTS_TS]
    .filter((path) => readRepoFile(root, path) === undefined)
    .map((path): FailureDetails => ({
      code: "ERR_CHECK_INPUT_MISSING",
      summary: `${path} does not exist`,
      expected: `${path}, one side of the IPC name lists (design D4)`,
      actual: "no such file",
      next: `restore ${path} from version control, or update scripts/checks/ipc-names.ts if it moved`,
    }));
  if (missing.length > 0) return missing;

  const files = rustFiles(root, RUST_DIR);
  const ipcFiles = scriptFiles(root, IPC_DIR);
  const violations: FailureDetails[] = [];
  const commands = rustCommands(files);
  const invoked = tsNames(root, ipcFiles, new Set(["invoke"]));
  if (commands === undefined) {
    violations.push(
      unparsed(
        RUST_DIR,
        "no tauri::generate_handler![…] in any .rs file",
        "`builder.invoke_handler(tauri::generate_handler![…])` in src-tauri/src/lib.rs",
      ),
    );
  }
  violations.push(...(commands?.violations ?? []), ...invoked.violations);
  if (commands !== undefined && violations.length === 0) {
    violations.push(
      ...compare(
        "ERR_CHECK_IPC_COMMANDS_DIVERGED",
        "command",
        commands.names,
        "generate_handler!",
        invoked.names,
        `${IPC_DIR}/'s invokes`,
      ),
    );
  }

  const emitted = rustEvents(files);
  const heard = tsNames(root, ipcFiles, new Set(["listen", "once"]));
  const eventProblems = [...emitted.violations, ...heard.violations];
  violations.push(...eventProblems);
  if (eventProblems.length === 0) {
    violations.push(
      ...compare(
        "ERR_CHECK_IPC_EVENTS_DIVERGED",
        "event",
        emitted.names,
        `${RUST_DIR}'s emits`,
        heard.names,
        `${IPC_DIR}/'s listens`,
      ),
    );
  }
  return violations;
}

export const check: Check = { name: "ipc-names", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
