// The TypeScript rules the skills and .claude/rules/typescript.md say a gate enforces,
// probed against the real eslint.config.mjs and ui/tsconfig.json: each case is code the
// gate must refuse, beside the code it must still accept. Linting reads the checkout and
// writes nothing; the tsc probe writes only to a temp directory.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ESLint } from "eslint";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

// Existing files, so the project service types the probe with ui/tsconfig.json; the
// probe text replaces their content for the lint only.
const SCREEN = "ui/src/counter/useCounter.ts";
const SCREEN_TEST = "ui/src/counter/useCounter.test.tsx";
const IPC = "ui/src/ipc/commands.ts";
const IPC_TEST = "ui/src/ipc/commands.test.ts";
const LOG_FORWARDER = "ui/src/ipc/log.ts";
const TEST_SETUP = "ui/src/test/setup.ts";

const eslint = new ESLint({ cwd: ROOT });

/** The rule ids ESLint reports for `code` linted as if it were `file`. */
async function lint(file: string, code: string): Promise<(string | null)[]> {
  const results = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return results.flatMap((result) => result.messages.map((message) => message.ruleId));
}

// The first lint loads the ui/ TypeScript program and every plugin: seconds alone, but
// past the per-test budget when the whole suite competes for the CPU under coverage.
// Paying it here keeps each case's own timeout about that case.
beforeAll(async () => {
  await lint(SCREEN, "export {};\n");
}, 300_000);

const KIND = 'import type { StorageErrorKind } from "../ipc/types";\n';

describe("switch-exhaustiveness-check", () => {
  it("refuses a default that hides a missing union member", async () => {
    const code = `${KIND}export function f(k: StorageErrorKind): number {
  switch (k) {
    case "corrupt":
      return 1;
    default:
      return 2;
  }
}
`;
    expect(await lint(SCREEN, code)).toEqual(["@typescript-eslint/switch-exhaustiveness-check"]);
  });

  it("refuses a default on a switch that already names every member", async () => {
    const code = `${KIND}export function f(k: StorageErrorKind): number {
  switch (k) {
    case "corrupt":
      return 1;
    case "unavailable":
      return 2;
    default:
      return 3;
  }
}
`;
    expect(await lint(SCREEN, code)).toEqual(["@typescript-eslint/switch-exhaustiveness-check"]);
  });

  it("accepts every member and no default, and a default over a plain string", async () => {
    const code = `${KIND}export function f(k: StorageErrorKind): number {
  switch (k) {
    case "corrupt":
      return 1;
    case "unavailable":
      return 2;
  }
}
export function g(s: string): number {
  switch (s) {
    case "a":
      return 1;
    default:
      return 2;
  }
}
`;
    expect(await lint(SCREEN, code)).toEqual([]);
  });
});

describe("the IPC import boundary", () => {
  const dynamic = (specifier: string): string =>
    `export async function load(): Promise<unknown> {\n  return import("${specifier}");\n}\n`;

  it.each([
    ["@tauri-apps/api/window", SCREEN],
    ["../ipc/generated/CounterError", SCREEN],
    ["../ipc/testing", SCREEN],
    ["./testing", IPC],
    ["@tauri-apps/api/core", SCREEN_TEST],
    ["../ipc/generated/CounterError", SCREEN_TEST],
  ])("refuses a dynamic import of %s from %s", async (specifier, file) => {
    expect(await lint(file, dynamic(specifier))).toEqual(["no-restricted-syntax"]);
  });

  it("refuses a dynamic import whose specifier is not a string literal", async () => {
    const code =
      "export async function load(name: string): Promise<unknown> {\n  return import(name);\n}\n";
    expect(await lint(SCREEN, code)).toEqual(["no-restricted-syntax"]);
  });

  it.each([
    ['export { mockCommands } from "../ipc/testing";\n', SCREEN],
    ['export { mockCommands } from "./testing";\n', IPC],
    ['export { invoke } from "@tauri-apps/api/core";\n', SCREEN],
    ['export type { CounterError } from "../ipc/generated/CounterError";\n', SCREEN],
  ])("refuses the static import %j in %s", async (code, file) => {
    expect(await lint(file, code)).toEqual(["no-restricted-imports"]);
  });

  it.each([
    [dynamic("@tauri-apps/api/window"), IPC],
    [dynamic("./generated/CounterError"), IPC],
    [dynamic("./testing"), IPC_TEST],
    ['export { mockCommands } from "../ipc/testing";\n', SCREEN_TEST],
    ['export { resetIpcMocks } from "../ipc/testing";\n', TEST_SETUP],
  ])("accepts %j in %s", async (code, file) => {
    expect(await lint(file, code)).toEqual([]);
  });
});

describe("console outside ui/src/ipc/log.ts", () => {
  it.each(["window", "globalThis", "self"])("refuses %s.console", async (object) => {
    const code = `export function f(): void {\n  ${object}.console.log("x");\n}\n`;
    expect(await lint(SCREEN, code)).toEqual(["no-restricted-properties"]);
  });

  it("accepts window.console in the log forwarder", async () => {
    const code = 'export function f(): void {\n  window.console.error("x");\n}\n';
    expect(await lint(LOG_FORWARDER, code)).toEqual([]);
  });
});

describe("ui/tsconfig.json", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The diagnostic codes tsc reports for `code` compiled with ui/tsconfig.json's options. */
  function compile(code: string): number[] {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(ROOT, "ui", "tsconfig.json"),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        },
      },
    );
    if (parsed === undefined) throw new Error("ui/tsconfig.json did not parse");
    const { options } = parsed;
    const dir = mkdtempSync(join(tmpdir(), "ui-tsconfig-"));
    dirs.push(dir);
    const file = join(dir, "probe.ts");
    writeFileSync(file, code);
    // `types` names packages resolved from ui/; the probe needs none of them.
    const program = ts.createProgram([file], { ...options, types: [] });
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code);
  }

  const NOT_ERASABLE = 1294;

  it.each([
    ["an enum", "export enum Direction {\n  Up,\n  Down,\n}\n"],
    ["a namespace", "export namespace Legacy {\n  export const value = 1;\n}\n"],
    [
      "a parameter property",
      "export class Holder {\n  constructor(readonly value: number) {}\n}\n",
    ],
  ])("refuses %s (erasableSyntaxOnly)", (_name, code) => {
    expect(compile(code)).toContain(NOT_ERASABLE);
  });

  it("accepts a string-literal union", () => {
    expect(compile('export type Direction = "up" | "down";\n')).toEqual([]);
  });
});
