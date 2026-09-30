/**
 * The IPC names agree across the language boundary:
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
 * exported by `@tauri-apps/api/core` or `listen`/`once` by `@tauri-apps/api/event` —
 * imported under any local name or through a namespace import, aliased by a `const`, or
 * re-exported by another script under `ui/src/ipc/` (`export { invoke } from …`,
 * `export { local as name }`, `export * from …`, `export * as ns from …`,
 * `export default …`) — or a `.listen`/`.once` method on a value reached from such an
 * export (`getCurrentWindow().once(…)`). A same-named helper of the app's own
 * (`once(() => …)`), declared in a script or re-exported from one, is not a call to
 * Tauri. So is `invoke` on `__TAURI_INTERNALS__`, the global `@tauri-apps/api/core`'s
 * `invoke` wraps whatever `withGlobalTauri` is: `window.__TAURI_INTERNALS__.invoke(…)`,
 * bare or through `globalThis`, with a fixed member name. Any other use of
 * `__TAURI_INTERNALS__` in running code — an alias, a destructuring, a key held in a
 * variable, another member — is a call the check cannot bind, and a violation; a type
 * or a `declare` that names it runs nothing and is not.
 *
 * Rust is read as text with comments removed; TypeScript with the TypeScript compiler's
 * parser and a checker over those scripts together, following their relative imports of
 * each other. A TypeScript name is a string literal, a template literal without
 * substitutions, or a `const` in scope with such a value. A name the check cannot read
 * (a variable, an expression) is a violation, never a silent skip: a name built at run
 * time is a name no check can compare.
 *
 *   node scripts/checks/ipc-names.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING (src-tauri/src/lib.rs, commands.ts, or events.ts
 * absent), ERR_CHECK_IPC_UNPARSED (no generate_handler!, a name that is not a literal
 * or a resolvable const, or `__TAURI_INTERNALS__` used other than by calling its
 * `invoke`), ERR_CHECK_IPC_COMMANDS_DIVERGED,
 * ERR_CHECK_IPC_EVENTS_DIVERGED.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import {
  bindingOf,
  blank,
  constInitializer,
  memberName,
  moduleOrigins,
  parseScripts,
  SCRIPT_FILE,
  TEST_FILE,
  withoutWrappers,
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

const unparsed = (
  site: string,
  what: string,
  expected: string,
  next = "name the command or event with a string literal or a const holding one, so the Rust and TypeScript lists can be compared",
): FailureDetails => ({
  code: "ERR_CHECK_IPC_UNPARSED",
  summary: `${site}: ${what}`,
  expected,
  actual: what,
  next,
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
            'each event emitted with a `pub const NAME: &str = "…"`, or a string literal',
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

/** The global `@tauri-apps/api/core`'s `invoke` wraps, present whatever `withGlobalTauri` is. */
const INTERNALS = "__TAURI_INTERNALS__";

/**
 * The node that names Tauri's internals in `node` — `__TAURI_INTERNALS__`,
 * `x.__TAURI_INTERNALS__`, or `x["__TAURI_INTERNALS__"]` — if it is one of those.
 */
function internalsName(node: ts.Expression): ts.Node | undefined {
  const inner = withoutWrappers(node);
  if (ts.isIdentifier(inner)) return inner.text === INTERNALS ? inner : undefined;
  if (memberName(inner) !== INTERNALS) return undefined;
  if (ts.isPropertyAccessExpression(inner)) return inner.name;
  return ts.isElementAccessExpression(inner) ? inner.argumentExpression : undefined;
}

/** For a callee `<internals>.invoke` or `<internals>["invoke"]`, the node naming the internals. */
function internalsInvoke(callee: ts.Expression): ts.Node | undefined {
  const inner = withoutWrappers(callee);
  if (memberName(inner) !== "invoke") return undefined;
  return ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)
    ? internalsName(inner.expression)
    : undefined;
}

/**
 * Code that never runs: a type, an interface, a type alias, or an ambient `declare`. A
 * class's `extends` clause is a type node that holds a running expression, so it is read.
 */
function erased(node: ts.Node): boolean {
  return (
    (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
  );
}

/** The member chain `node` sits in (`window.__TAURI_INTERNALS__.invoke`), for a message. */
function memberChain(node: ts.Node): ts.Node {
  let outer = node;
  while (
    ts.isPropertyAccessExpression(outer.parent) ||
    ts.isElementAccessExpression(outer.parent) ||
    ts.isParenthesizedExpression(outer.parent)
  ) {
    outer = outer.parent;
  }
  return outer;
}

/** The names `ui/src/ipc/`'s scripts pass to Tauri's `invoke` (commands) and `listen`/`once` (events). */
function tsNames(root: string, paths: readonly string[]): { commands: Found; events: Found } {
  const commands: Found = { names: new Map(), violations: [] };
  const events: Found = { names: new Map(), violations: [] };
  const { files, checker } = parseScripts(
    paths.map((path) => ({ path, source: readRepoFile(root, path) ?? "" })),
  );
  const fromTauriModule = (node: ts.Expression): boolean =>
    moduleOrigins(checker, node).some((origin) => origin.module.startsWith("@tauri-apps/"));
  /** Whether a value is, or is reached from, a value an `@tauri-apps/*` module exports. */
  const fromTauri = (node: ts.Expression, seen: ReadonlySet<ts.Node>): boolean => {
    if (fromTauriModule(node)) return true;
    const inner = withoutWrappers(node);
    if (
      ts.isCallExpression(inner) ||
      ts.isPropertyAccessExpression(inner) ||
      ts.isElementAccessExpression(inner) ||
      ts.isAwaitExpression(inner)
    ) {
      return fromTauri(inner.expression, seen);
    }
    if (!ts.isIdentifier(inner)) return false;
    const binding = bindingOf(checker, inner);
    const initializer =
      binding !== undefined &&
      ts.isVariableDeclaration(binding.declaration) &&
      (ts.getCombinedNodeFlags(binding.declaration) & ts.NodeFlags.Const) !== 0
        ? binding.values[0]
        : undefined;
    return (
      initializer !== undefined &&
      !seen.has(initializer) &&
      fromTauri(initializer, new Set([...seen, initializer]))
    );
  };
  /** Whether `callee` is one of Tauri's `callees`, or a same-named method of a Tauri value. */
  const isTauriCall = (callee: ts.Expression, callees: Callees): boolean => {
    const origins = moduleOrigins(checker, callee);
    if (origins.length > 0) {
      return origins.some((origin) => callees.get(origin.name) === origin.module);
    }
    const inner = withoutWrappers(callee);
    const method = memberName(inner);
    return (
      method !== undefined &&
      callees.has(method) &&
      (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) &&
      fromTauri(inner.expression, new Set())
    );
  };
  const nameOf = (arg: ts.Expression | undefined): string | undefined => {
    if (arg === undefined) return undefined;
    if (ts.isStringLiteralLike(arg)) return arg.text;
    const initializer = ts.isIdentifier(arg) ? constInitializer(checker, arg) : undefined;
    return initializer !== undefined && ts.isStringLiteralLike(initializer)
      ? initializer.text
      : undefined;
  };
  for (const [path, file] of files) {
    const siteOf = (node: ts.Node): string =>
      `${path}:${String(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)}`;
    const record = (found: Found, node: ts.CallExpression): void => {
      const [arg] = node.arguments;
      const name = nameOf(arg);
      if (name === undefined) {
        found.violations.push(
          unparsed(
            siteOf(node),
            `the name passed to ${node.expression.getText(file)}(…) is \`${arg?.getText(file) ?? "missing"}\`, not a string literal or a const in scope`,
            "each IPC name a string literal, or a `const` in scope holding one",
          ),
        );
      } else addSite(found.names, name, siteOf(node));
    };
    /** The internals nodes read as a direct `.invoke(…)` call; any other is a violation. */
    const read = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (erased(node)) return;
      if (ts.isCallExpression(node)) {
        const internals = internalsInvoke(node.expression);
        if (internals !== undefined) {
          read.add(internals);
          record(commands, node);
        } else if (isTauriCall(node.expression, COMMAND_CALLEES)) record(commands, node);
        else if (isTauriCall(node.expression, EVENT_CALLEES)) record(events, node);
      } else if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        node.text === INTERNALS &&
        !read.has(node)
      ) {
        commands.violations.push(
          unparsed(
            siteOf(node),
            `\`${memberChain(node).getText(file)}\` reaches ${INTERNALS} other than by calling its invoke directly, so no name can be read from it`,
            `Tauri reached through @tauri-apps/api's invoke, listen, or once, or \`window.${INTERNALS}.invoke("…")\` called directly`,
            `call invoke from @tauri-apps/api/core in ${COMMANDS_TS} instead of reaching ${INTERNALS}`,
          ),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { commands, events };
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
  const expected = `the same ${side.kind} names in ${side.rustWhere} and ${IPC_DIR}/`;
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
      expected: `${path}, one side of the IPC name lists`,
      actual: "no such file",
      next: `restore ${path} from version control, or update scripts/checks/ipc-names.ts if it moved`,
    }));
  if (missing.length > 0) return missing;

  const files = rustFiles(root, RUST_DIR);
  const ipcFiles = scriptFiles(root, IPC_DIR);
  const violations: FailureDetails[] = [];
  const commands = rustCommands(files);
  const { commands: invoked, events: heard } = tsNames(root, ipcFiles);
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
