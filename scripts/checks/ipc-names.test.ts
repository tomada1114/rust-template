/**
 * ipc-names against a fixture tree: `fixtures/ipc-names/pass` registers, invokes, emits,
 * and listens to the same names through every form the check reads (a path in
 * `generate_handler!`, a literal, a const, `emit_to`, `emit_filter`, a path call through
 * `Emitter`, `once`, an invoke outside commands.ts, an invoke and a `once` imported from
 * a local module that re-exports them, `window.__TAURI_INTERNALS__.invoke`, and a test
 * file's invoke that does not count). Each failing case copies it to a temp root and
 * breaks one thing.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FailureDetails } from "../lib/fail.ts";
import type { ScriptContext } from "../lib/script.ts";
import { check, main } from "./ipc-names.ts";

const PASS = join(import.meta.dirname, "fixtures", "ipc-names", "pass");
const LIB = "src-tauri/src/lib.rs";
const COMMANDS_RS = "src-tauri/src/commands.rs";
const COMMANDS_TS = "ui/src/ipc/commands.ts";
const EVENTS_TS = "ui/src/ipc/events.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyPass(): string {
  const dir = mkdtempSync(join(tmpdir(), "ipc-names-"));
  dirs.push(dir);
  cpSync(PASS, dir, { recursive: true });
  return dir;
}

function editFile(root: string, path: string, from: string, to: string): void {
  const full = join(root, path);
  const before = readFileSync(full, "utf8");
  if (!before.includes(from)) throw new Error(`${path} has no ${from}`);
  writeFileSync(full, before.replace(from, to));
}

function appendFile(root: string, path: string, text: string): void {
  const full = join(root, path);
  writeFileSync(full, readFileSync(full, "utf8") + text);
}

const codes = (violations: readonly FailureDetails[]): string[] => violations.map((v) => v.code);
const text = (violations: readonly FailureDetails[]): string =>
  violations.map((v) => [v.summary, v.expected, v.actual, v.next].join("\n")).join("\n\n");

describe("ipc-names", () => {
  it("passes when every registered command is invoked and every emitted event heard", () => {
    expect(check.run(PASS)).toEqual([]);
  });

  it("logs a pass through main", () => {
    const lines: string[] = [];
    const context: ScriptContext = {
      argv: ["--root", PASS],
      env: {},
      root: "/nowhere",
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => lines.push(line),
    };
    main(context);
    expect(lines).toEqual(["check ipc-names: ok"]);
  });

  describe("commands", () => {
    it("fails when Rust registers a command commands.ts never invokes", () => {
      const root = copyPass();
      editFile(root, LIB, "commands::increment,", "commands::increment,\n        commands::reset,");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_COMMANDS_DIVERGED"]);
      expect(text(violations)).toContain("`reset`");
    });

    it("fails when commands.ts invokes a command Rust does not register", () => {
      const root = copyPass();
      appendFile(root, COMMANDS_TS, 'export const reset = () => invoke("rest");\n');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_COMMANDS_DIVERGED"]);
      expect(text(violations)).toContain("`rest`");
      expect(text(violations)).toContain(`${COMMANDS_TS}:10`);
    });

    it("fails when no generate_handler! can be found", () => {
      const root = copyPass();
      editFile(root, LIB, "tauri::generate_handler![", "tauri::handlers![");
      expect(codes(check.run(root))).toContain("ERR_CHECK_IPC_UNPARSED");
    });

    it("fails on a generate_handler! entry that is not a path", () => {
      const root = copyPass();
      editFile(root, LIB, "log_from_ui, //", "make_handler(), //");
      expect(codes(check.run(root))).toContain("ERR_CHECK_IPC_UNPARSED");
    });

    it("fails on an invoke whose name it cannot read", () => {
      const root = copyPass();
      appendFile(root, COMMANDS_TS, "export const any = (name: string) => invoke(name);\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
      expect(text(violations)).toContain(`${COMMANDS_TS}:10`);
    });

    it("reads an invoke in another ui/src/ipc/ file", () => {
      const root = copyPass();
      writeFileSync(
        join(root, "ui/src/ipc/danger.ts"),
        'import { invoke } from "@tauri-apps/api/core";\nexport const nuke = () => invoke("delete_everything");\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_COMMANDS_DIVERGED"]);
      expect(text(violations)).toContain("`delete_everything` at ui/src/ipc/danger.ts:2");
    });

    it("reads an invoke in a nested ui/src/ipc/ JavaScript file", () => {
      const root = copyPass();
      mkdirSync(join(root, "ui/src/ipc/extra"));
      writeFileSync(
        join(root, "ui/src/ipc/extra/raw.jsx"),
        'import { invoke } from "@tauri-apps/api/core";\nexport const x = () => invoke("ghost");\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_COMMANDS_DIVERGED"]);
      expect(text(violations)).toContain("ui/src/ipc/extra/raw.jsx:2");
    });

    it.each([
      [
        "an aliased import",
        'import { invoke as call } from "@tauri-apps/api/core";\nexport const x = () => call("ghost");\n',
      ],
      [
        "a namespace import",
        'import * as core from "@tauri-apps/api/core";\nexport const x = () => core.invoke("ghost");\n',
      ],
    ])("reads an invoke through %s", (_label, source) => {
      const root = copyPass();
      writeFileSync(join(root, "ui/src/ipc/other.ts"), source);
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_COMMANDS_DIVERGED"]);
      expect(text(violations)).toContain("ui/src/ipc/other.ts:2");
    });

    it.each([
      [
        "a helper of the app's own named once",
        'import { once } from "./memo";\nexport const init = once(() => 1);\n',
      ],
      [
        "a local function named invoke",
        "const invoke = (name: unknown) => name;\nexport const x = () => invoke(1);\n",
      ],
      [
        "a parameter shadowing Tauri's invoke",
        'import { invoke } from "@tauri-apps/api/core";\nexport const x = (invoke: (n: unknown) => void) => invoke(2);\n',
      ],
      [
        "an invoke imported from somewhere else",
        'import { invoke } from "./bridge";\nexport const x = () => invoke(name);\n',
      ],
    ])("ignores %s", (_label, source) => {
      const root = copyPass();
      writeFileSync(join(root, "ui/src/ipc/memo-user.ts"), source);
      expect(check.run(root)).toEqual([]);
    });

    it("skips ui/src/ipc/testing.ts, which only tests import", () => {
      const root = copyPass();
      writeFileSync(
        join(root, "ui/src/ipc/testing.ts"),
        'import { invoke } from "@tauri-apps/api/core";\nexport const probe = (name: string) => invoke(name ?? "only_in_tests");\n',
      );
      expect(check.run(root)).toEqual([]);
    });

    it("names the file to edit on each side", () => {
      const root = copyPass();
      writeFileSync(
        join(root, "ui/src/ipc/danger.ts"),
        'import { invoke } from "@tauri-apps/api/core";\nexport const nuke = () => invoke("delete_everything");\n',
      );
      editFile(root, LIB, "commands::increment,", "commands::increment,\n        commands::reset,");
      const [missingInTs, missingInRust] = check.run(root);
      expect(missingInTs?.summary).toContain("`reset` is in generate_handler!");
      expect(missingInTs?.next).toContain(COMMANDS_TS);
      expect(missingInRust?.summary).toContain("used in ui/src/ipc/danger.ts");
      expect(missingInRust?.next).toContain("generate_handler!");
      expect(missingInRust?.next).toContain("ui/src/ipc/danger.ts");
    });

    it.each([
      ["window's", 'window.__TAURI_INTERNALS__.invoke("ghost_one");\n'],
      ["the bare global's", '__TAURI_INTERNALS__.invoke("ghost_one");\n'],
      [
        "globalThis's, by computed keys,",
        'globalThis["__TAURI_INTERNALS__"]["invoke"]("ghost_one");\n',
      ],
      [
        "a cast window's, optionally chained,",
        '(window as unknown as { __TAURI_INTERNALS__: T }).__TAURI_INTERNALS__?.invoke("ghost_one");\n',
      ],
      [
        "a class heritage's",
        'export class A extends base(window.__TAURI_INTERNALS__.invoke("ghost_one")) {}\n',
      ],
    ])("compares a command invoked through %s __TAURI_INTERNALS__", (_label, source) => {
      const root = copyPass();
      writeFileSync(join(root, "ui/src/ipc/extra.ts"), source);
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_COMMANDS_DIVERGED"]);
      expect(text(violations)).toContain("`ghost_one` at ui/src/ipc/extra.ts:1");
    });

    it.each([
      ["a type alias", "type Internals = typeof window.__TAURI_INTERNALS__;\n"],
      ["an annotation", "let t: { __TAURI_INTERNALS__: unknown } | undefined;\n"],
      ["an ambient declaration", "declare const __TAURI_INTERNALS__: unknown;\n"],
      ["an interface", "interface W {\n  __TAURI_INTERNALS__: unknown;\n}\n"],
    ])("ignores __TAURI_INTERNALS__ named in %s, which never runs", (_label, source) => {
      const root = copyPass();
      writeFileSync(join(root, "ui/src/ipc/extra.ts"), source);
      expect(check.run(root)).toEqual([]);
    });

    it("fails on a __TAURI_INTERNALS__.invoke whose name it cannot read", () => {
      const root = copyPass();
      writeFileSync(
        join(root, "ui/src/ipc/extra.ts"),
        "export const any = (name: string) => window.__TAURI_INTERNALS__.invoke(name);\n",
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
      expect(text(violations)).toContain("ui/src/ipc/extra.ts:1");
    });

    it.each([
      ["an alias", 'const t = window.__TAURI_INTERNALS__;\nt.invoke("get_counter");\n'],
      ["destructuring", 'const { invoke } = window.__TAURI_INTERNALS__;\ninvoke("get_counter");\n'],
      [
        "its invoke kept for later",
        'const f = window.__TAURI_INTERNALS__.invoke;\nf("get_counter");\n',
      ],
      [
        "a key held in a const",
        'const KEY = "__TAURI_INTERNALS__";\nwindow[KEY].invoke("get_counter");\n',
      ],
      ["a member other than invoke", "window.__TAURI_INTERNALS__.ipc(message);\n"],
      ["an argument", "send(window.__TAURI_INTERNALS__);\n"],
    ])("fails on __TAURI_INTERNALS__ reached through %s", (_label, source) => {
      const root = copyPass();
      writeFileSync(join(root, "ui/src/ipc/extra.ts"), source);
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
      expect(text(violations)).toContain("ui/src/ipc/extra.ts:1");
      expect(violations[0]?.next).toContain("@tauri-apps/api/core");
    });

    it.each([
      [
        "a named re-export",
        'export { invoke } from "@tauri-apps/api/core";\n',
        "{ invoke }",
        "invoke",
      ],
      ["a star re-export", 'export * from "@tauri-apps/api/core";\n', "{ invoke }", "invoke"],
      [
        "a re-export under another name",
        'import { invoke as call } from "@tauri-apps/api/core";\nexport { call as run };\n',
        "{ run }",
        "run",
      ],
      [
        "an exported const alias",
        'import { invoke } from "@tauri-apps/api/core";\nexport const run = invoke;\n',
        "{ run }",
        "run",
      ],
      [
        "a default export",
        'import { invoke } from "@tauri-apps/api/core";\nexport default invoke;\n',
        "run",
        "run",
      ],
      [
        "a namespace import of the re-exporting module",
        'export * from "@tauri-apps/api/core";\n',
        "* as re",
        "re.invoke",
      ],
      [
        "a re-exported namespace",
        'export * as core from "@tauri-apps/api/core";\n',
        "{ core }",
        "core.invoke",
      ],
    ])(
      "compares an invoke imported from a local module through %s",
      (_label, re, binding, callee) => {
        const root = copyPass();
        writeFileSync(join(root, "ui/src/ipc/re.ts"), re);
        writeFileSync(
          join(root, "ui/src/ipc/use.ts"),
          `import ${binding} from "./re";\nexport const x = () => ${callee}("ghost_two");\n`,
        );
        const violations = check.run(root);
        expect(codes(violations)).toEqual(["ERR_CHECK_IPC_COMMANDS_DIVERGED"]);
        expect(text(violations)).toContain("`ghost_two` at ui/src/ipc/use.ts:2");
      },
    );

    it("follows a re-export through a directory's index", () => {
      const root = copyPass();
      mkdirSync(join(root, "ui/src/ipc/tauri"));
      writeFileSync(join(root, "ui/src/ipc/tauri/index.ts"), 'export * from "./core";\n');
      writeFileSync(
        join(root, "ui/src/ipc/tauri/core.ts"),
        'export { invoke } from "@tauri-apps/api/core";\n',
      );
      writeFileSync(
        join(root, "ui/src/ipc/use.ts"),
        'import { invoke } from "./tauri";\nexport const x = () => invoke("ghost_two");\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_COMMANDS_DIVERGED"]);
      expect(text(violations)).toContain("`ghost_two` at ui/src/ipc/use.ts:2");
    });

    it("fails on a locally re-exported invoke whose name it cannot read", () => {
      const root = copyPass();
      writeFileSync(
        join(root, "ui/src/ipc/re.ts"),
        'export { invoke } from "@tauri-apps/api/core";\n',
      );
      writeFileSync(
        join(root, "ui/src/ipc/use.ts"),
        'import { invoke } from "./re";\nexport const any = (name: string) => invoke(name);\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
      expect(text(violations)).toContain("ui/src/ipc/use.ts:2");
    });

    it("ignores a helper of the app's own re-exported under Tauri's name", () => {
      const root = copyPass();
      writeFileSync(
        join(root, "ui/src/ipc/memo.ts"),
        "export function invoke(f: unknown) { return f; }\nexport const once = (f: unknown) => f;\n",
      );
      writeFileSync(join(root, "ui/src/ipc/re.ts"), 'export * from "./memo";\n');
      writeFileSync(
        join(root, "ui/src/ipc/use.ts"),
        'import { invoke, once } from "./re";\nexport const x = () => [invoke(name), once(() => 1)];\n',
      );
      expect(check.run(root)).toEqual([]);
    });

    it("fails on an invoke with no arguments", () => {
      const root = copyPass();
      appendFile(root, COMMANDS_TS, "export const none = () => invoke();\n");
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
    });
  });

  describe("events", () => {
    it("fails when Rust emits an event events.ts never listens to", () => {
      const root = copyPass();
      appendFile(root, COMMANDS_RS, 'fn later(app: &AppHandle) { app.emit("tick", ()); }\n');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_EVENTS_DIVERGED"]);
      expect(text(violations)).toContain('"tick"');
    });

    it("reads emits in a submodule under src-tauri/src/", () => {
      const root = copyPass();
      appendFile(
        root,
        "src-tauri/src/menu/mod.rs",
        'fn later(app: &AppHandle) { app.emit("tick", ()); }\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_EVENTS_DIVERGED"]);
      expect(text(violations)).toContain("src-tauri/src/menu/mod.rs:6");
    });

    it("reads an emit_str_to's event name from its second argument", () => {
      const root = copyPass();
      appendFile(
        root,
        LIB,
        'fn later(app: &AppHandle) { app.emit_str_to(EventTarget::webview_window("main"), crate::commands::TICK, s); }\n',
      );
      appendFile(root, COMMANDS_RS, 'pub const TICK: &str = "tick";\n');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_EVENTS_DIVERGED"]);
      expect(text(violations)).toContain('"tick"');
    });

    it.each([
      ["a path call through tauri::Emitter", 'tauri::Emitter::emit(app, "ghost-event", ());'],
      ["a path call through Emitter", 'Emitter :: emit(&app, "ghost-event", ());'],
      ["a qualified path call", '<AppHandle<R> as Emitter<R>>::emit(app, "ghost-event", ());'],
      ["a path call with a turbofish", 'Emitter::emit::<()>(app, "ghost-event", ());'],
      ["an emit_to path call", 'Emitter::emit_to(app, "main", "ghost-event", ());'],
      [
        "an emit_str_filter path call",
        'Emitter::emit_str_filter(app, "ghost-event", s, |_| true);',
      ],
    ])("reads the event of %s from the argument after the emitter", (_label, call) => {
      const root = copyPass();
      appendFile(
        root,
        COMMANDS_RS,
        `fn later<R: Runtime>(app: &AppHandle<R>) { let _ = ${call} }\n`,
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_EVENTS_DIVERGED"]);
      expect(text(violations)).toContain(`"ghost-event" at ${COMMANDS_RS}:13`);
    });

    it("ignores a path call of an app's own function named emit", () => {
      const root = copyPass();
      appendFile(
        root,
        COMMANDS_RS,
        "fn later(app: &AppHandle, view: &View) { crate::events::emit(app, view); events::emit_to(app, view); }\n",
      );
      expect(check.run(root)).toEqual([]);
    });

    it("reads a listen on a value from a Tauri import", () => {
      const root = copyPass();
      writeFileSync(
        join(root, "ui/src/ipc/window.ts"),
        'import { getCurrentWindow } from "@tauri-apps/api/window";\nconst w = getCurrentWindow();\nexport const onTick = () => w.listen("tick", () => {});\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_EVENTS_DIVERGED"]);
      expect(violations[0]?.next).toContain("ui/src/ipc/window.ts");
    });

    it("tells a missing listener where it belongs", () => {
      const root = copyPass();
      appendFile(root, COMMANDS_RS, 'fn later(app: &AppHandle) { app.emit("tick", ()); }\n');
      const [violation] = check.run(root);
      expect(violation?.next).toContain(EVENTS_TS);
    });

    it("fails on a path-call emit whose event it cannot resolve", () => {
      const root = copyPass();
      appendFile(
        root,
        COMMANDS_RS,
        "fn later(app: &AppHandle) { Emitter::emit(app, name(), ()); }\n",
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
      expect(text(violations)).toContain("::emit");
    });

    it("reads a listen in another ui/src/ipc/ file", () => {
      const root = copyPass();
      writeFileSync(
        join(root, "ui/src/ipc/more.ts"),
        'import { listen } from "@tauri-apps/api/event";\nexport const onTick = () => listen("tick", () => {});\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_EVENTS_DIVERGED"]);
      expect(text(violations)).toContain("ui/src/ipc/more.ts:2");
    });

    it.each([
      [
        "a named re-export",
        'export { listen } from "@tauri-apps/api/event";\n',
        "{ listen }",
        "listen",
      ],
      ["a star re-export", 'export * from "@tauri-apps/api/event";\n', "{ once }", "once"],
      [
        "a re-export under another name",
        'import { listen as l } from "@tauri-apps/api/event";\nexport { l as on };\n',
        "{ on }",
        "on",
      ],
      [
        "a re-exported value's method",
        'export { getCurrentWindow } from "@tauri-apps/api/window";\n',
        "{ getCurrentWindow }",
        "getCurrentWindow().listen",
      ],
      [
        "a re-exported const of a Tauri value",
        'import { getCurrentWindow } from "@tauri-apps/api/window";\nexport const w = getCurrentWindow();\n',
        "{ w }",
        "w.once",
      ],
    ])("compares an event heard through %s from a local module", (_label, re, binding, callee) => {
      const root = copyPass();
      writeFileSync(join(root, "ui/src/ipc/re.ts"), re);
      writeFileSync(
        join(root, "ui/src/ipc/use.ts"),
        `import ${binding} from "./re";\nexport const x = () => ${callee}("ghost-event", () => {});\n`,
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_EVENTS_DIVERGED"]);
      expect(text(violations)).toContain('"ghost-event" at ui/src/ipc/use.ts:2');
    });

    it("fails on a locally re-exported listen whose event it cannot read", () => {
      const root = copyPass();
      writeFileSync(
        join(root, "ui/src/ipc/re.ts"),
        'export { listen } from "@tauri-apps/api/event";\n',
      );
      writeFileSync(
        join(root, "ui/src/ipc/use.ts"),
        'import { listen } from "./re";\nexport const on = (id: string) => listen(`tick-${id}`, () => {});\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
      expect(text(violations)).toContain("ui/src/ipc/use.ts:2");
    });

    it("fails when events.ts listens to an event Rust never emits", () => {
      const root = copyPass();
      appendFile(
        root,
        EVENTS_TS,
        'export const onTick = () => listen<number>("tick", () => {});\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_EVENTS_DIVERGED"]);
      expect(text(violations)).toContain(`${EVENTS_TS}:12`);
    });

    it("fails when a const event name differs between the two sides", () => {
      const root = copyPass();
      editFile(root, COMMANDS_RS, '"counter-changed"', '"counter_changed"');
      const violations = check.run(root);
      expect(codes(violations)).toEqual([
        "ERR_CHECK_IPC_EVENTS_DIVERGED",
        "ERR_CHECK_IPC_EVENTS_DIVERGED",
      ]);
    });

    it("fails on an emit whose event it cannot resolve", () => {
      const root = copyPass();
      appendFile(root, COMMANDS_RS, "fn later(app: &AppHandle) { app.emit(UNKNOWN, ()); }\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
      expect(text(violations)).toContain(`${COMMANDS_RS}:13`);
    });

    it("fails on an emit whose event is an expression", () => {
      const root = copyPass();
      appendFile(root, COMMANDS_RS, "fn later(app: &AppHandle) { app.emit(name(), ()); }\n");
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
    });

    it("fails on a listen whose event is built at run time", () => {
      const root = copyPass();
      appendFile(
        root,
        EVENTS_TS,
        "export const on = (id: string) => listen(`tick-${id}`, () => {});\n",
      );
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_IPC_UNPARSED"]);
    });
  });

  describe("inputs", () => {
    it.each([[LIB], [COMMANDS_TS], [EVENTS_TS]])("fails when %s is missing", (path) => {
      const root = copyPass();
      rmSync(join(root, path));
      expect(codes(check.run(root))).toContain("ERR_CHECK_INPUT_MISSING");
    });
  });
});
