import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appBundlePath, main, parseProfile } from "./bundle-path.ts";
import { ScriptError } from "./lib/fail.ts";
import type { Run, ScriptContext } from "./lib/script.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-path-"));
  dirs.push(dir);
  return dir;
}

function fakeCargo(targetDir: string, cwds: (string | undefined)[]): Run {
  return (_command, _args, options) => {
    cwds.push(options?.cwd);
    return { status: 0, stdout: JSON.stringify({ target_directory: targetDir }), stderr: "" };
  };
}

function context(argv: string[], run: Run, root: string, lines: string[]): ScriptContext {
  return { argv, env: {}, root, run, log: (line) => lines.push(line) };
}

function codeOf(action: () => void): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof ScriptError) return error.details.code;
    throw error;
  }
  return undefined;
}

describe("parseProfile", () => {
  it("accepts debug and release", () => {
    expect(parseProfile(["debug"])).toBe("debug");
    expect(parseProfile(["release"])).toBe("release");
  });

  it("refuses no argument, an unknown profile, or extra arguments", () => {
    expect(codeOf(() => parseProfile([]))).toBe("ERR_BUNDLE_ARGS");
    expect(codeOf(() => parseProfile(["profile"]))).toBe("ERR_BUNDLE_ARGS");
    expect(codeOf(() => parseProfile(["debug", "extra"]))).toBe("ERR_BUNDLE_ARGS");
  });
});

describe("main", () => {
  it("prints the bundle under the target directory cargo reports, asked from src-tauri", () => {
    const root = tempDir();
    const targetDir = join(tempDir(), "elsewhere");
    const app = join(targetDir, "release", "bundle", "macos", "MyApp.app");
    mkdirSync(app, { recursive: true });
    const cwds: (string | undefined)[] = [];
    const lines: string[] = [];

    main(context(["release"], fakeCargo(targetDir, cwds), root, lines));

    expect(lines).toEqual([app]);
    expect(cwds).toEqual([join(root, "src-tauri")]);
    expect(appBundlePath(targetDir, "release")).toBe(app);
  });

  it("fails with ERR_BUNDLE_MISSING and prints nothing when the bundle was not built", () => {
    const lines: string[] = [];
    const run = fakeCargo(tempDir(), []);
    expect(
      codeOf(() => {
        main(context(["debug"], run, tempDir(), lines));
      }),
    ).toBe("ERR_BUNDLE_MISSING");
    expect(lines).toEqual([]);
  });

  it("fails with ERR_BUNDLE_TARGET_DIR when cargo metadata fails", () => {
    const run: Run = () => ({ status: 101, stdout: "", stderr: "no Cargo.toml" });
    expect(
      codeOf(() => {
        main(context(["debug"], run, tempDir(), []));
      }),
    ).toBe("ERR_BUNDLE_TARGET_DIR");
  });
});
