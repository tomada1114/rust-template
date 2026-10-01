// The TypeScript rules the skills and .claude/rules/typescript.md say a gate enforces,
// probed against the real eslint.config.mjs, tsconfig.json, and scripts/tsconfig.json: each
// case is code the gate must refuse, beside the code it must still accept. Linting reads the
// checkout and writes nothing; the tsc probe writes only to a temp directory.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ESLint } from "eslint";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

// Existing files, so the project service types each probe with the tsconfig.json that
// covers it; the probe text replaces their content for the lint only.
const SCRIPT = "scripts/lib/fail.ts";
const ROOT_CONFIG = "vitest.config.ts";

const eslint = new ESLint({ cwd: ROOT });

/** The rule ids ESLint reports for `code` linted as if it were `file`. */
async function lint(file: string, code: string): Promise<(string | null)[]> {
  const results = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return results.flatMap((result) => result.messages.map((message) => message.ruleId));
}

// The first lint loads a TypeScript program and every plugin: seconds alone, but past the
// per-test budget when the whole suite competes for the CPU under coverage. Paying it
// here keeps each case's own timeout about that case.
beforeAll(async () => {
  await lint(SCRIPT, "export {};\n");
}, 300_000);

const KIND = 'type StorageErrorKind = "corrupt" | "unavailable";\n';

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
    expect(await lint(SCRIPT, code)).toEqual(["@typescript-eslint/switch-exhaustiveness-check"]);
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
    expect(await lint(SCRIPT, code)).toEqual(["@typescript-eslint/switch-exhaustiveness-check"]);
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
    expect(await lint(SCRIPT, code)).toEqual([]);
  });
});

describe("console outside scripts/", () => {
  it.each(["window", "globalThis", "self"])("refuses %s.console", async (object) => {
    const code = `export function f(): void {\n  ${object}.console.log("x");\n}\n`;
    expect(await lint(ROOT_CONFIG, code)).toEqual(["no-restricted-properties"]);
  });

  it("refuses the bare console", async () => {
    const code = 'export function f(): void {\n  console.log("x");\n}\n';
    expect(await lint(ROOT_CONFIG, code)).toEqual(["no-console"]);
  });

  it("accepts console in a repository script", async () => {
    const code =
      'export function f(): void {\n  console.log("x");\n  globalThis.console.log("y");\n}\n';
    expect(await lint(SCRIPT, code)).toEqual([]);
  });
});

// The root config covers vitest.config.ts; scripts/ has its own.
describe.each(["tsconfig.json", "scripts/tsconfig.json"])("%s", (config) => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The diagnostic codes tsc reports for `code` compiled with `config`'s options. */
  function compile(code: string): number[] {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(ROOT, config),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        },
      },
    );
    if (parsed === undefined) throw new Error(`${config} did not parse`);
    const { options } = parsed;
    const dir = mkdtempSync(join(tmpdir(), "tsconfig-probe-"));
    dirs.push(dir);
    const file = join(dir, "probe.ts");
    writeFileSync(file, code);
    // `types` names packages resolved from the config's own tree; the probe needs none.
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
