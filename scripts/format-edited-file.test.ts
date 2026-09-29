import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatterFor, main } from "./format-edited-file.ts";
import { ScriptError } from "./lib/fail.ts";
import type { RunResult, ScriptContext } from "./lib/script.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "format-edited-")));
  dirs.push(dir);
  return dir;
}

function payload(filePath: unknown): string {
  return JSON.stringify({ tool_name: "Edit", tool_input: { file_path: filePath } });
}

interface Harness {
  readonly context: ScriptContext;
  readonly calls: { command: string; args: readonly string[]; cwd: string | undefined }[];
}

function harness(
  root: string,
  stdin: string,
  argv: readonly string[] = [],
  result: RunResult = { status: 0, stdout: "", stderr: "" },
): Harness {
  const calls: Harness["calls"] = [];
  return {
    calls,
    context: {
      argv,
      env: {},
      root,
      stdin: () => stdin,
      run: (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd });
        return result;
      },
      log: () => undefined,
    },
  };
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

describe("formatterFor", () => {
  it("formats Rust with rustfmt and TypeScript with Prettier", () => {
    expect(formatterFor("/r/a.rs")).toEqual({ command: "rustfmt", args: ["/r/a.rs"] });
    expect(formatterFor("/r/a.ts")).toEqual({
      command: "pnpm",
      args: ["exec", "prettier", "--write", "/r/a.ts"],
    });
    expect(formatterFor("/r/a.tsx")?.command).toBe("pnpm");
  });

  it("leaves every other file alone", () => {
    expect(formatterFor("/r/a.md")).toBeUndefined();
    expect(formatterFor("/r/a.json")).toBeUndefined();
    expect(formatterFor("/r/rs")).toBeUndefined();
  });
});

describe("main", () => {
  it("formats the one edited Rust file from the root", () => {
    const root = tempDir();
    const file = join(root, "src", "lib.rs");
    mkdirSync(join(root, "src"));
    writeFileSync(file, "fn main(){}");
    const { context, calls } = harness(root, payload(file));
    main(context);
    expect(calls).toEqual([{ command: "rustfmt", args: [file], cwd: root }]);
  });

  it("formats an edited TypeScript file given relative to the root", () => {
    const root = tempDir();
    writeFileSync(join(root, "a.tsx"), "export {}");
    const { context, calls } = harness(root, payload("a.tsx"));
    main(context);
    expect(calls).toEqual([
      {
        command: "pnpm",
        args: ["exec", "prettier", "--write", join(root, "a.tsx")],
        cwd: root,
      },
    ]);
  });

  it("takes the root from --root", () => {
    const root = tempDir();
    writeFileSync(join(root, "a.ts"), "");
    const { context, calls } = harness("/elsewhere", payload(join(root, "a.ts")), ["--root", root]);
    main(context);
    expect(calls[0]?.cwd).toBe(root);
  });

  it.each([
    ["no JSON", "not json"],
    ["no tool_input", JSON.stringify({ tool_name: "Bash" })],
    ["a non-string file_path", payload(42)],
    ["an empty file_path", payload("")],
  ])("does nothing for a payload with %s", (_label, stdin) => {
    const { context, calls } = harness(tempDir(), stdin);
    main(context);
    expect(calls).toEqual([]);
  });

  it("does nothing for a file of another type, a missing file, or a directory", () => {
    const root = tempDir();
    writeFileSync(join(root, "notes.md"), "");
    mkdirSync(join(root, "dir.ts"));
    for (const path of ["notes.md", "gone.rs", "dir.ts"]) {
      const { context, calls } = harness(root, payload(join(root, path)));
      main(context);
      expect(calls).toEqual([]);
    }
  });

  it("does nothing for a file outside the root, even through a symlink", () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "a.rs"), "");
    symlinkSync(join(outside, "a.rs"), join(root, "link.rs"));
    for (const path of [join(outside, "a.rs"), join(root, "link.rs"), join(root, "..", "x.rs")]) {
      const { context, calls } = harness(root, payload(path));
      main(context);
      expect(calls).toEqual([]);
    }
  });

  it("fails with ERR_FORMAT_FAILED and exit code 2 when the formatter fails", () => {
    const root = tempDir();
    writeFileSync(join(root, "bad.rs"), "fn (");
    const { context } = harness(root, payload(join(root, "bad.rs")), [], {
      status: 1,
      stdout: "",
      stderr: "error: expected identifier\n --> bad.rs:1:4",
    });
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_FORMAT_FAILED");
    expect(error.exitCode).toBe(2);
    expect(error.details.actual).toContain("expected identifier");
    expect(error.details.next).toContain("bad.rs");
  });

  it.each([
    [["--fast"], "--fast"],
    [["--root"], "--root with no value"],
    [["--root", "/definitely/not/here"], "/definitely/not/here"],
  ])("fails with ERR_FORMAT_USAGE and exit code 2 for %j", (argv, actual) => {
    const error = caught(() => {
      main(harness(tempDir(), payload("a.rs"), argv).context);
    });
    expect(error.details.code).toBe("ERR_FORMAT_USAGE");
    expect(error.exitCode).toBe(2);
    expect(error.details.actual).toBe(actual);
  });

  it("fails with ERR_FORMAT_USAGE when no standard input is available", () => {
    const { argv, env, root, run, log } = harness(tempDir(), "").context;
    const context: ScriptContext = { argv, env, root, run, log };
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_FORMAT_USAGE");
  });
});
