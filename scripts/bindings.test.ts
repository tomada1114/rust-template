import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXPORT_ARGS, main, replaceDirectory, type Rename } from "./bindings.ts";
import { ScriptError } from "./lib/fail.ts";
import type { RunOptions, RunResult, ScriptContext } from "./lib/script.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A root with tracked bindings: `Old.ts` and `Stale.ts`. */
function tempRoot(): { root: string; generated: string; ipc: string } {
  const root = mkdtempSync(join(tmpdir(), "bindings-"));
  roots.push(root);
  const ipc = join(root, "ui/src/ipc");
  const generated = join(ipc, "generated");
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(generated, "Old.ts"), "export type Old = 1;\n");
  writeFileSync(join(generated, "Stale.ts"), "export type Stale = 1;\n");
  return { root, generated, ipc };
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions | undefined;
}

/** A stand-in for cargo: writes `files` into TS_RS_EXPORT_DIR and exits with `status`. */
function context(
  root: string,
  { status = 0, files = ["CounterView.ts", "UiLogEntry.ts"] } = {},
): { context: ScriptContext; calls: Call[]; lines: string[] } {
  const calls: Call[] = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    context: {
      argv: [],
      env: { PATH: "/bin", TS_RS_EXPORT_DIR: "/dev/null/from-the-config" },
      root,
      run: (command, args, options): RunResult => {
        calls.push({ command, args, options });
        const dir = options?.env?.["TS_RS_EXPORT_DIR"] ?? "";
        for (const file of files) writeFileSync(join(dir, file), `// ${file}\n`);
        return { status, stdout: "", stderr: "" };
      },
      log: (line) => {
        lines.push(line);
      },
    },
  };
}

function failure(run: () => void): ScriptError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

describe("main", () => {
  it("exports into a fresh directory beside the tracked one and swaps it in, dropping stale files", () => {
    const { root, generated, ipc } = tempRoot();
    const { context: ctx, calls, lines } = context(root);
    main(ctx);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toBe("cargo");
    expect(call?.args).toEqual([...EXPORT_ARGS]);
    expect(call?.args).toContain("--locked");
    expect(call?.args).toEqual(expect.arrayContaining(["--features", "export-bindings"]));
    expect(call?.options?.cwd).toBe(root);
    expect(call?.options?.env?.["PATH"]).toBe("/bin");
    const exportDir = call?.options?.env?.["TS_RS_EXPORT_DIR"] ?? "";
    expect(exportDir.startsWith(join(ipc, ".generated-"))).toBe(true);

    expect(readdirSync(generated).sort()).toEqual(["CounterView.ts", "UiLogEntry.ts"]);
    expect(readFileSync(join(generated, "CounterView.ts"), "utf8")).toBe("// CounterView.ts\n");
    expect(statSync(generated).mode & 0o777).toBe(0o755);
    expect(readdirSync(ipc)).toEqual(["generated"]);
    expect(lines).toEqual(["bindings: 2 file(s) in ui/src/ipc/generated/"]);
  });

  it("creates the directory when there were no bindings yet", () => {
    const { root, generated } = tempRoot();
    rmSync(generated, { recursive: true });
    main(context(root).context);
    expect(readdirSync(generated).sort()).toEqual(["CounterView.ts", "UiLogEntry.ts"]);
  });

  it("keeps the tracked bindings and removes its scratch directory when the export fails", () => {
    const { root, generated, ipc } = tempRoot();
    const error = failure(() => {
      main(context(root, { status: 101 }).context);
    });
    expect(error.details.code).toBe("ERR_BINDINGS_EXPORT");
    expect(error.details.actual).toContain("101");
    expect(readdirSync(generated).sort()).toEqual(["Old.ts", "Stale.ts"]);
    expect(readdirSync(ipc)).toEqual(["generated"]);
  });

  it("keeps the tracked bindings when the export wrote no .ts file", () => {
    const { root, generated, ipc } = tempRoot();
    const error = failure(() => {
      main(context(root, { files: ["notes.txt"] }).context);
    });
    expect(error.details.code).toBe("ERR_BINDINGS_EMPTY");
    expect(readdirSync(generated).sort()).toEqual(["Old.ts", "Stale.ts"]);
    expect(readdirSync(ipc)).toEqual(["generated"]);
  });

  it("refuses arguments", () => {
    const { root } = tempRoot();
    const { context: ctx, calls } = context(root);
    const error = failure(() => {
      main({ ...ctx, argv: ["--all"] });
    });
    expect(error.details.code).toBe("ERR_BINDINGS_ARGS");
    expect(calls).toEqual([]);
  });
});

describe("replaceDirectory", () => {
  function fresh(ipc: string): string {
    const dir = join(ipc, ".generated-test");
    mkdirSync(dir);
    writeFileSync(join(dir, "New.ts"), "export type New = 1;\n");
    return dir;
  }

  it("restores the old bindings when moving the new ones in fails", () => {
    const { generated, ipc } = tempRoot();
    const dir = fresh(ipc);
    const renames: [string, string][] = [];
    const rename: Rename = (from, to) => {
      renames.push([from, to]);
      if (from === dir) throw new Error("EACCES: permission denied");
      renameSync(from, to);
    };
    const error = failure(() => {
      replaceDirectory(dir, generated, rename);
    });
    expect(error.details.code).toBe("ERR_BINDINGS_SWAP");
    expect(error.details.actual).toContain("back in place");
    expect(renames).toEqual([
      [generated, `${dir}.old`],
      [dir, generated],
      [`${dir}.old`, generated],
    ]);
    expect(readdirSync(generated).sort()).toEqual(["Old.ts", "Stale.ts"]);
    expect(existsSync(`${dir}.old`)).toBe(false);
  });

  it("changes nothing when the old bindings cannot be moved aside", () => {
    const { generated, ipc } = tempRoot();
    const dir = fresh(ipc);
    const error = failure(() => {
      replaceDirectory(dir, generated, () => {
        throw new Error("EBUSY");
      });
    });
    expect(error.details.code).toBe("ERR_BINDINGS_SWAP");
    expect(error.details.actual).toContain("nothing was changed");
    expect(readdirSync(generated).sort()).toEqual(["Old.ts", "Stale.ts"]);
  });

  it("names where the old bindings are when they cannot be put back", () => {
    const { generated, ipc } = tempRoot();
    const dir = fresh(ipc);
    const rename: Rename = (from, to) => {
      if (from !== generated) throw new Error("EIO");
      renameSync(from, to);
    };
    const error = failure(() => {
      replaceDirectory(dir, generated, rename);
    });
    expect(error.details.actual).toContain(`${dir}.old`);
    expect(readdirSync(`${dir}.old`).sort()).toEqual(["Old.ts", "Stale.ts"]);
  });

  it("reports a failed move when there were no old bindings", () => {
    const { generated, ipc } = tempRoot();
    rmSync(generated, { recursive: true });
    const dir = fresh(ipc);
    const error = failure(() => {
      replaceDirectory(dir, generated, () => {
        throw new Error("EACCES");
      });
    });
    expect(error.details.actual).toContain("no previous bindings");
  });
});
