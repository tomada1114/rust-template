/**
 * ipc-names against a fixture tree: `fixtures/ipc-names/pass` registers, invokes, emits,
 * and listens to the same names through every form the check reads (a path in
 * `generate_handler!`, a literal, a const, `emit_to`, `emit_filter`, `once`). Each
 * failing case copies it to a temp root and breaks one thing.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    it("fails when events.ts listens to an event Rust never emits", () => {
      const root = copyPass();
      appendFile(
        root,
        EVENTS_TS,
        'export const onTick = () => listen<number>("tick", () => {});\n',
      );
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_IPC_EVENTS_DIVERGED"]);
      expect(text(violations)).toContain(`${EVENTS_TS}:11`);
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
