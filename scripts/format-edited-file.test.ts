import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatterFor, main, PRETTIER_EXTENSIONS } from "./format-edited-file.ts";
import { ScriptError } from "./lib/fail.ts";
import { type RunResult, type ScriptContext } from "./lib/script.ts";

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
  readonly calls: {
    command: string;
    args: readonly string[];
    cwd: string | undefined;
    input?: string | undefined;
  }[];
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
        calls.push(
          options?.input === undefined
            ? { command, args, cwd: options?.cwd }
            : { command, args, cwd: options.cwd, input: options.input },
        );
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
  it("pipes Rust through rustfmt, naming no path it could follow into mod children", () => {
    const root = tempDir();
    expect(formatterFor(join(root, "a.rs"), root)).toEqual({
      command: "rustfmt",
      args: [],
      stdin: true,
    });
  });

  it("hands rustfmt the nearest rustfmt.toml up to the root, as rustfmt would find it", () => {
    const outer = tempDir();
    const root = join(outer, "repo");
    mkdirSync(join(root, "crates", "a", "src"), { recursive: true });
    writeFileSync(join(outer, "rustfmt.toml"), "");
    const file = join(root, "crates", "a", "src", "lib.rs");
    // A config above the root is not the project's.
    expect(formatterFor(file, root)?.args).toEqual([]);
    writeFileSync(join(root, "rustfmt.toml"), 'edition = "2024"\n');
    expect(formatterFor(file, root)?.args).toEqual(["--config-path", join(root, "rustfmt.toml")]);
    writeFileSync(join(root, "crates", "a", ".rustfmt.toml"), "");
    expect(formatterFor(file, root)?.args).toEqual([
      "--config-path",
      join(root, "crates", "a", ".rustfmt.toml"),
    ]);
  });

  it.each([
    [".ts"],
    [".tsx"],
    [".mts"],
    [".cts"],
    [".js"],
    [".mjs"],
    [".cjs"],
    [".json"],
    [".css"],
    [".html"],
    [".yml"],
    [".yaml"],
  ])("formats %s with Prettier, in place", (extension) => {
    expect(formatterFor(`/r/a${extension}`, "/r")).toEqual({
      command: "pnpm",
      args: ["exec", "prettier", "--write", `/r/a${extension}`],
      stdin: false,
    });
  });

  it("leaves every other file alone", () => {
    expect(formatterFor("/r/a.md", "/r")).toBeUndefined();
    expect(formatterFor("/r/a.toml", "/r")).toBeUndefined();
    expect(formatterFor("/r/rs", "/r")).toBeUndefined();
  });

  it("formats every extension in PRETTIER_EXTENSIONS with Prettier", () => {
    for (const extension of PRETTIER_EXTENSIONS) {
      expect(formatterFor(`/r/a${extension}`, "/r")?.args).toEqual([
        "exec",
        "prettier",
        "--write",
        `/r/a${extension}`,
      ]);
    }
  });
});

describe("main", () => {
  it("feeds rustfmt only the edited file's text, with no path, and writes the result back", () => {
    const root = tempDir();
    const file = join(root, "src", "lib.rs");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "rustfmt.toml"), 'edition = "2024"\n');
    writeFileSync(file, "mod child;\nfn main(){}");
    const { context, calls } = harness(root, payload(file), [], {
      status: 0,
      stdout: "mod child;\nfn main() {}\n",
      stderr: "",
    });
    main(context);
    // The only path rustfmt is given is its config: with the file's path it would also
    // format every out-of-line `mod` child, here `src/child.rs`.
    expect(calls).toEqual([
      {
        command: "rustfmt",
        args: ["--config-path", join(root, "rustfmt.toml")],
        cwd: join(root, "src"),
        input: "mod child;\nfn main(){}",
      },
    ]);
    expect(readFileSync(file, "utf8")).toBe("mod child;\nfn main() {}\n");
  });

  it("never writes back an empty rustfmt result", () => {
    const root = tempDir();
    const file = join(root, "lib.rs");
    writeFileSync(file, "fn main(){}");
    main(harness(root, payload(file)).context);
    expect(readFileSync(file, "utf8")).toBe("fn main(){}");
  });

  it("formats an edited YAML file with Prettier", () => {
    const root = tempDir();
    writeFileSync(join(root, "ci.yml"), "a:   1\n");
    const { context, calls } = harness(root, payload("ci.yml"));
    main(context);
    expect(calls).toEqual([
      { command: "pnpm", args: ["exec", "prettier", "--write", join(root, "ci.yml")], cwd: root },
    ]);
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
    expect(error.details.next).toBe(
      "fix the syntax error in bad.rs (that edit re-runs this hook); to check the file by hand, writing nothing: mise exec -- rustfmt --check bad.rs",
    );
    expect(readFileSync(join(root, "bad.rs"), "utf8")).toBe("fn (");
  });

  it("names the single-file Prettier command when Prettier fails", () => {
    const root = tempDir();
    writeFileSync(join(root, "bad.ts"), "export {");
    const { context } = harness(root, payload(join(root, "bad.ts")), [], {
      status: 2,
      stdout: "",
      stderr: "SyntaxError: '}' expected.",
    });
    const error = caught(() => {
      main(context);
    });
    expect(error.details.next).toBe(
      "fix the syntax error, then run: mise exec -- pnpm exec prettier --write bad.ts",
    );
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
