import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverChecks, main, runChecks } from "./check-harness.ts";
import { ScriptError } from "./lib/fail.ts";
import type { Check } from "./checks/lib.ts";
import type { ScriptContext } from "./lib/script.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-harness-"));
  dirs.push(dir);
  return dir;
}

const ok = (name: string): Check => ({ name, run: () => [] });
const bad = (name: string, code: string): Check => ({
  name,
  run: () => [{ code, summary: "broken", expected: "e", actual: "a", next: "n" }],
});

function ctx(root: string, argv: readonly string[] = []) {
  const lines: string[] = [];
  const context: ScriptContext = {
    argv,
    env: {},
    root,
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    log: (line) => lines.push(line),
  };
  return { context, lines };
}

describe("discoverChecks", () => {
  it("lists every check module in the directory, sorted, skipping lib and tests", () => {
    const dir = tempDir();
    for (const name of ["b-check.ts", "a-check.ts", "lib.ts", "a-check.test.ts", "notes.md"]) {
      writeFileSync(join(dir, name), "");
    }
    mkdirSync(join(dir, "fixtures"));
    expect(discoverChecks(dir)).toEqual([join(dir, "a-check.ts"), join(dir, "b-check.ts")]);
  });
});

describe("runChecks", () => {
  it("runs every check and reports each result", () => {
    const { context, lines } = ctx("/repo");
    const failures = runChecks([ok("one"), bad("two", "ERR_CHECK_TWO")], "/repo", context.log);
    expect(failures).toBe(1);
    expect(lines[0]).toBe("ok    one");
    expect(lines.join("\n")).toContain("FAIL  two");
    expect(lines.join("\n")).toContain("ERR_CHECK_TWO: broken");
  });
});

describe("main", () => {
  it("runs each discovered check against the context's root and passes when all pass", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "needs-marker.ts"),
      `import { existsSync } from "node:fs";\nimport { join } from "node:path";\nexport const check = { name: "needs-marker", run: (root) => existsSync(join(root, "marker")) ? [] : [{ code: "ERR_CHECK_X", summary: "s", expected: "e", actual: "a", next: "n" }] };\n`,
    );
    const root = tempDir();
    writeFileSync(join(root, "marker"), "");
    const { context, lines } = ctx(root);
    await main(context, dir);
    expect(lines).toEqual(["ok    needs-marker", "check-harness: 1 checks passed"]);
  });

  it("fails with ERR_HARNESS_FAILED naming the count", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "always-fails.ts"),
      `export const check = { name: "always-fails", run: () => [{ code: "ERR_CHECK_X", summary: "s", expected: "e", actual: "a", next: "n" }] };\n`,
    );
    const { context } = ctx(tempDir());
    let error: unknown;
    try {
      await main(context, dir);
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ScriptError);
    expect((error as ScriptError).details.code).toBe("ERR_HARNESS_FAILED");
    expect((error as ScriptError).details.actual).toContain("1 of 1");
  });

  it("fails with ERR_HARNESS_MODULE when a module exports no check", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "empty-check.ts"), "export const nothing = 1;\n");
    let error: unknown;
    try {
      await main(ctx(tempDir()).context, dir);
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect((error as ScriptError).details.code).toBe("ERR_HARNESS_MODULE");
  });
});
