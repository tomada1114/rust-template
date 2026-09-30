/**
 * The IPC names agree across the language boundary (design D4):
 *
 * - Commands: the functions registered in `tauri::generate_handler![…]` (in any `.rs`
 *   file under `src-tauri/src/`; each entry's last path segment is the command name)
 *   equal the names passed to Tauri's `invoke` anywhere in `ui/src/ipc/` (`commands.ts`
 *   in practice).
 * - Events: the names Rust emits (the event argument of every `emit`, `emit_to`,
 *   `emit_filter`, and `emit_str*` call under `src-tauri/src/`, called as a method —
 *   `app.emit(…)` — or through a path that names the `Emitter` trait —
 *   `tauri::Emitter::emit(app, …)`, `<AppHandle as Emitter>::emit(&app, …)`, whose first
 *   argument is the emitter — and named by a string literal, or a
 *   `const NAME: &str = "…"` declared there, `src-tauri/src/commands.rs`'s `pub const`s
 *   in practice) equal the names passed to Tauri's `listen` or `once` anywhere in
 *   `ui/src/ipc/` (`events.ts` in practice).
 *
 * The TypeScript side reads every non-test script under `ui/src/ipc/` except
 * `testing.ts` (test-only). A call counts when its callee is bound to Tauri: `invoke`
 * imported from `@tauri-apps/api/core` or `listen`/`once` from `@tauri-apps/api/event`
 * (under any local name, or through a namespace import), or a `.listen`/`.once` method
 * on a value that comes from an `@tauri-apps/*` import (`getCurrentWindow().once(…)`).
 * A same-named helper of the app's own (`once(() => …)`) is not a call to Tauri.
 *
 * Rust is read as text with comments removed; TypeScript with the TypeScript compiler's
 * parser and a checker over the one file. A TypeScript name is a string literal, a
 * template literal without substitutions, or a `const` in scope with such a value. A name the
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
import {
  blank,
  constInitializer,
  importOf,
  parseScript,
  SCRIPT_FILE,
  TEST_FILE,
} from "./shared/sources.ts";

const RUST_DIR = "src-tauri/src";
const LIB_RS = `${RUST_DIR}/lib.rs`;
const IPC_DIR = "ui/src/ipc";
const COMMANDS_TS = `${IPC_DIR}/commands.ts`;
const EVENTS_TS = `${IPC_DIR}/events.ts`;
const TESTING_TS = `${IPC_DIR}/testing.ts`;

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
 * A call of an `Emitter` method: `.emit(` as a method, or `Emitter::emit(` through a path
 * that names the trait (`tauri::Emitter`, `<T as Emitter<R>>`), where the emitter is the
 * first argument and the event moves one place right. A path call of any other function
 * named `emit` (an app's own `events::emit`) is not Tauri's.
 */
const EMIT =
  /(\.|\bEmitter\s*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*)?>?\s*::)\s*(emit(?:_str)?(?:_to|_filter)?)\s*(?:::\s*<[^>]*>\s*)?\(/g;
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
      const throughPath = match[1] !== ".";
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

/** Every script under `dir` that ships: no test file, and not `testing.ts`. */
function scriptFiles(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return scriptFiles(root, path);
      const ships = SCRIPT_FILE.test(entry.name) && !TEST_FILE.test(entry.name);
      return ships && path !== TESTING_TS ? [path] : [];
    });
}

/** The Tauri functions whose first argument is an IPC name, and the module each is from. */
type Callees = ReadonlyMap<string, string>;

const COMMAND_CALLEES: Callees = new Map([["invoke", "@tauri-apps/api/core"]]);
const EVENT_CALLEES: Callees = new Map([
  ["listen", "@tauri-apps/api/event"],
  ["once", "@tauri-apps/api/event"],
]);

/** The identifier an expression such as `getCurrentWindow().once` or `w.listen` starts from. */
function rootIdentifier(node: ts.Expression): ts.Identifier | undefined {
  let inner = node;
  for (;;) {
    if (ts.isIdentifier(inner)) return inner;
    if (
      ts.isCallExpression(inner) ||
      ts.isPropertyAccessExpression(inner) ||
      ts.isElementAccessExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isAwaitExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isAsExpression(inner)
    ) {
      inner = inner.expression;
    } else return undefined;
  }
}

/** The names `paths` pass as the first argument to calls of Tauri's `callees`. */
function tsNames(root: string, paths: readonly string[], callees: Callees): Found {
  const names: Sites = new Map();
  const violations: FailureDetails[] = [];
  for (const path of paths) {
    const { file, checker } = parseScript(path, readRepoFile(root, path) ?? "");
    /** Whether `identifier` is bound to an `@tauri-apps/*` import, directly or through consts. */
    const fromTauri = (identifier: ts.Identifier, seen: ReadonlySet<ts.Node>): boolean => {
      if (importOf(checker, identifier)?.module.startsWith("@tauri-apps/") === true) return true;
      const initializer = constInitializer(checker, identifier);
      if (initializer === undefined || seen.has(initializer)) return false;
      const next = rootIdentifier(initializer);
      return next !== undefined && fromTauri(next, new Set([...seen, initializer]));
    };
    const isTauriCall = (callee: ts.Expression): boolean => {
      if (ts.isIdentifier(callee)) {
        const origin = importOf(checker, callee);
        return origin !== undefined && callees.get(origin.name) === origin.module;
      }
      if (!ts.isPropertyAccessExpression(callee) || !callees.has(callee.name.text)) return false;
      const receiver = callee.expression;
      if (ts.isIdentifier(receiver)) {
        const origin = importOf(checker, receiver);
        if (origin?.name === "*") return callees.get(callee.name.text) === origin.module;
      }
      const start = rootIdentifier(receiver);
      return start !== undefined && fromTauri(start, new Set());
    };
    const nameOf = (arg: ts.Expression | undefined): string | undefined => {
      if (arg === undefined) return undefined;
      if (ts.isStringLiteralLike(arg)) return arg.text;
      const initializer = ts.isIdentifier(arg) ? constInitializer(checker, arg) : undefined;
      return initializer !== undefined && ts.isStringLiteralLike(initializer)
        ? initializer.text
        : undefined;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isTauriCall(node.expression)) {
        const site = `${path}:${String(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)}`;
        const [arg] = node.arguments;
        const name = nameOf(arg);
        if (name === undefined) {
          violations.push(
            unparsed(
              site,
              `the name passed to ${node.expression.getText(file)}(…) is \`${arg?.getText(file) ?? "missing"}\`, not a string literal or a const in scope`,
              "each IPC name a string literal, or a `const` in scope holding one",
            ),
          );
        } else addSite(names, name, site);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { names, violations };
}

/** How one side of the comparison is named in a message. */
interface Side {
  readonly kind: "command" | "event";
  /** Where Rust declares the names, for a message. */
  readonly rustWhere: string;
  /** The TypeScript call that uses a name, as a verb: `invokes`, `listens to`. */
  readonly verb: string;
  /** The file a missing TypeScript wrapper belongs in. */
  readonly wrapperFile: string;
  /** How to add a name to the Rust side. */
  readonly rustFix: string;
}

const filesOf = (sites: readonly string[]): string =>
  [...new Set(sites.map((site) => site.replace(/:\d+$/, "")))].join(", ");

function compare(code: string, side: Side, rust: Sites, typescript: Sites): FailureDetails[] {
  const quote = side.kind === "command" ? (n: string) => `\`${n}\`` : (n: string) => `"${n}"`;
  const expected = `the same ${side.kind} names in ${side.rustWhere} and ${IPC_DIR}/ (design D4)`;
  const listed = (sites: Sites): string => [...sites.keys()].sort().map(quote).join(", ") || "none";
  const onlyRust = [...rust.keys()]
    .filter((name) => !typescript.has(name))
    .sort()
    .map((name): FailureDetails => {
      const sites = rust.get(name) ?? [];
      return {
        code,
        summary: `the ${side.kind} ${quote(name)} is in ${side.rustWhere} but no file under ${IPC_DIR}/ ${side.verb} it`,
        expected,
        actual: `${quote(name)} at ${sites.join(", ")}; ${IPC_DIR}/ ${side.verb} ${listed(typescript)}`,
        next: `add a wrapper that ${side.verb} it to ${side.wrapperFile}, or remove or rename it in ${filesOf(sites)}; a rename changes both sides in one commit`,
      };
    });
  const onlyTypeScript = [...typescript.keys()]
    .filter((name) => !rust.has(name))
    .sort()
    .map((name): FailureDetails => {
      const sites = typescript.get(name) ?? [];
      return {
        code,
        summary: `the ${side.kind} ${quote(name)} is used in ${filesOf(sites)} but not in ${side.rustWhere}`,
        expected,
        actual: `${quote(name)} at ${sites.join(", ")}; ${side.rustWhere} has ${listed(rust)}`,
        next: `${side.rustFix}, or remove or rename the call in ${filesOf(sites)}; a rename changes both sides in one commit`,
      };
    });
  return [...onlyRust, ...onlyTypeScript];
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
  const invoked = tsNames(root, ipcFiles, COMMAND_CALLEES);
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
        {
          kind: "command",
          rustWhere: "generate_handler!",
          verb: "invokes",
          wrapperFile: COMMANDS_TS,
          rustFix: `register it in generate_handler! (${LIB_RS})`,
        },
        commands.names,
        invoked.names,
      ),
    );
  }

  const emitted = rustEvents(files);
  const heard = tsNames(root, ipcFiles, EVENT_CALLEES);
  const eventProblems = [...emitted.violations, ...heard.violations];
  violations.push(...eventProblems);
  if (eventProblems.length === 0) {
    violations.push(
      ...compare(
        "ERR_CHECK_IPC_EVENTS_DIVERGED",
        {
          kind: "event",
          rustWhere: `${RUST_DIR}'s emits`,
          verb: "listens to",
          wrapperFile: EVENTS_TS,
          rustFix: `emit it under ${RUST_DIR} with a \`pub const\` name`,
        },
        emitted.names,
        heard.names,
      ),
    );
  }
  return violations;
}

export const check: Check = { name: "ipc-names", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
