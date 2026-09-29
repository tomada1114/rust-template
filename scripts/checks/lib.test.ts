import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError, type FailureDetails } from "../lib/fail.ts";
import type { ScriptContext } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "checks-lib-"));
  dirs.push(dir);
  return dir;
}

const violation = (code: string): FailureDetails => ({
  code,
  summary: `${code} happened`,
  expected: "nothing",
  actual: "something",
  next: "fix it",
});

function context(root: string, argv: readonly string[] = []) {
  const lines: string[] = [];
  const ctx: ScriptContext = {
    argv,
    env: {},
    root,
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    log: (line) => lines.push(line),
  };
  return { ctx, lines };
}

function caught(action: () => void): ScriptError {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

describe("readRepoFile", () => {
  it("reads a file under the root, or undefined when it is absent", () => {
    const root = tempRoot();
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "b.txt"), "hi");
    expect(readRepoFile(root, "a/b.txt")).toBe("hi");
    expect(readRepoFile(root, "a/missing.txt")).toBeUndefined();
  });
});

describe("checkMain", () => {
  it("runs the check against the context root and logs a pass", () => {
    const root = tempRoot();
    const seen: string[] = [];
    const check: Check = { name: "demo", run: (r) => (seen.push(r), []) };
    const { ctx, lines } = context(root);
    checkMain(check)(ctx);
    expect(seen).toEqual([root]);
    expect(lines).toEqual(["check demo: ok"]);
  });

  it("takes the root from --root", () => {
    const root = tempRoot();
    const seen: string[] = [];
    const check: Check = { name: "demo", run: (r) => (seen.push(r), []) };
    checkMain(check)(context("/elsewhere", ["--root", root]).ctx);
    expect(seen).toEqual([root]);
  });

  it("throws the first violation and logs every one", () => {
    const check: Check = {
      name: "demo",
      run: () => [violation("ERR_CHECK_ONE"), violation("ERR_CHECK_TWO")],
    };
    const { ctx, lines } = context(tempRoot());
    const error = caught(() => {
      checkMain(check)(ctx);
    });
    expect(error.details.code).toBe("ERR_CHECK_ONE");
    expect(error.details.summary).toContain("(1 of 2)");
    expect(lines.join("\n")).toContain("ERR_CHECK_TWO: ERR_CHECK_TWO happened");
  });

  it.each([
    [["--fast"], "--fast"],
    [["--root"], "--root with no value"],
    [["--root", "/definitely/not/here"], "/definitely/not/here"],
  ])("fails with ERR_CHECK_USAGE for %j", (argv, actual) => {
    const check: Check = { name: "demo", run: () => [] };
    const error = caught(() => {
      checkMain(check)(context(tempRoot(), argv).ctx);
    });
    expect(error.details.code).toBe("ERR_CHECK_USAGE");
    expect(error.details.actual).toBe(actual);
  });
});
