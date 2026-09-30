import { describe, expect, it } from "vitest";

import { CARGO_METADATA_ARGS, cargoTargetDir } from "./cargo.ts";
import { ScriptError } from "./fail.ts";
import type { Run, RunOptions, RunResult } from "./script.ts";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions | undefined;
}

function fakeCargo(result: Partial<RunResult>): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "", ...result };
  };
  return { run, calls };
}

function failure(run: Run): ScriptError {
  try {
    cargoTargetDir(run, "/repo", "SIDECAR");
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("cargoTargetDir did not fail");
}

describe("cargoTargetDir", () => {
  it("returns the target_directory cargo metadata reports, asked from the root", () => {
    const { run, calls } = fakeCargo({
      stdout: JSON.stringify({
        packages: [],
        target_directory: "/scratch/cargo-target",
        workspace_root: "/repo",
      }),
    });
    expect(cargoTargetDir(run, "/repo", "SIDECAR")).toBe("/scratch/cargo-target");
    expect(calls).toEqual([
      { command: "cargo", args: [...CARGO_METADATA_ARGS], options: { cwd: "/repo" } },
    ]);
    expect(CARGO_METADATA_ARGS).toContain("--no-deps");
  });

  it("fails with the caller's stage when cargo fails, carrying cargo's reason", () => {
    const error = failure(
      fakeCargo({ status: 101, stderr: "error: could not find Cargo.toml\n" }).run,
    );
    expect(error.details.code).toBe("ERR_SIDECAR_TARGET_DIR");
    expect(error.details.actual).toBe("exit status 101: error: could not find Cargo.toml");
  });

  it.each([
    ["output that is not JSON", "warning: something\n"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["an object without target_directory", '{"workspace_root":"/repo"}'],
    ["a target_directory that is not a string", '{"target_directory":7}'],
    ["an empty target_directory", '{"target_directory":""}'],
  ])("fails on %s", (_, stdout) => {
    const error = failure(fakeCargo({ stdout }).run);
    expect(error.details.code).toBe("ERR_SIDECAR_TARGET_DIR");
    expect(error.details.actual).toBe("no target_directory in its output");
  });
});
