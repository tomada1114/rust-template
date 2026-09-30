import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildSidecar, main, parseOptions, sidecarPath, type RunCommand } from "./build-sidecar.ts";
import { ScriptError } from "./lib/fail.ts";
import type { ScriptContext } from "./lib/script.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "build-sidecar-"));
  roots.push(root);
  return root;
}

/**
 * A stand-in for `cargo build`: records each call and writes the binary cargo would have
 * built under `targetDir`.
 */
function fakeCargo(targetDir: string, calls: string[][]): RunCommand {
  return (command, args) => {
    calls.push([command, ...args]);
    const target = args[args.indexOf("--target") + 1] ?? "";
    const profile = args.includes("--release") ? "release" : "debug";
    const dir = join(targetDir, target, profile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "myapp-cli"), `built for ${target} ${profile}`);
    return { status: 0 };
  };
}

describe("parseOptions", () => {
  it("defaults to a debug build for the host triple", () => {
    expect(parseOptions([], {}, () => "aarch64-apple-darwin")).toEqual({
      triple: "aarch64-apple-darwin",
      release: false,
    });
  });

  it("takes --release and --target from the arguments", () => {
    expect(
      parseOptions(["--release", "--target", "x86_64-apple-darwin"], {}, () => "host"),
    ).toEqual({
      triple: "x86_64-apple-darwin",
      release: true,
    });
  });

  it("builds for release when Tauri runs it for a release build", () => {
    // Observed with the Tauri 2.11 CLI: a release build exports the triple and no
    // TAURI_ENV_DEBUG; a debug build adds TAURI_ENV_DEBUG=true.
    const env = { TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" };
    expect(parseOptions([], env, () => "host")).toEqual({
      triple: "aarch64-apple-darwin",
      release: true,
    });
  });

  it("builds for debug when Tauri runs it for a debug build", () => {
    const env = { TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin", TAURI_ENV_DEBUG: "true" };
    expect(parseOptions([], env, () => "host").release).toBe(false);
  });

  it("rejects an unknown argument", () => {
    expect(() => parseOptions(["--fast"], {}, () => "host")).toThrow(/ERR_SIDECAR_ARGS/);
  });

  it("rejects --target without a value", () => {
    expect(() => parseOptions(["--target"], {}, () => "host")).toThrow(/ERR_SIDECAR_ARGS/);
  });
});

describe("buildSidecar", () => {
  it("builds the helper with cargo and copies it next to the Tauri crate, suffixed with the triple", () => {
    const root = tempRoot();
    const calls: string[][] = [];
    const out = buildSidecar(
      { root, targetDir: join(root, "target"), triple: "aarch64-apple-darwin", release: true },
      fakeCargo(join(root, "target"), calls),
    );

    expect(calls).toEqual([
      [
        "cargo",
        "build",
        "--locked",
        "-p",
        "myapp-cli",
        "--target",
        "aarch64-apple-darwin",
        "--release",
      ],
    ]);
    expect(out).toBe(sidecarPath(root, "aarch64-apple-darwin"));
    expect(out).toBe(join(root, "src-tauri", "binaries", "myapp-cli-aarch64-apple-darwin"));
    expect(readFileSync(out, "utf8")).toBe("built for aarch64-apple-darwin release");
    expect(statSync(out).mode & 0o111).not.toBe(0);
  });

  it("builds a debug helper without --release", () => {
    const root = tempRoot();
    const calls: string[][] = [];
    const out = buildSidecar(
      { root, targetDir: join(root, "target"), triple: "aarch64-apple-darwin", release: false },
      fakeCargo(join(root, "target"), calls),
    );
    expect(calls[0]).not.toContain("--release");
    expect(readFileSync(out, "utf8")).toBe("built for aarch64-apple-darwin debug");
  });

  it("fails with ERR_SIDECAR_BUILD when cargo fails", () => {
    const root = tempRoot();
    const failing: RunCommand = () => ({ status: 101 });
    let caught: unknown;
    try {
      buildSidecar(
        { root, targetDir: join(root, "target"), triple: "aarch64-apple-darwin", release: false },
        failing,
      );
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScriptError);
    expect((caught as ScriptError).details.code).toBe("ERR_SIDECAR_BUILD");
    expect((caught as ScriptError).details.actual).toContain("101");
  });

  it("fails with ERR_SIDECAR_MISSING when cargo succeeds but produced no binary", () => {
    const root = tempRoot();
    expect(() =>
      buildSidecar(
        { root, targetDir: join(root, "target"), triple: "aarch64-apple-darwin", release: false },
        () => ({ status: 0 }),
      ),
    ).toThrow(/ERR_SIDECAR_MISSING/);
  });

  it("looks for the binary in the target directory it is given, not ./target", () => {
    const root = tempRoot();
    const elsewhere = tempRoot();
    const out = buildSidecar(
      { root, targetDir: elsewhere, triple: "aarch64-apple-darwin", release: false },
      fakeCargo(elsewhere, []),
    );
    expect(readFileSync(out, "utf8")).toBe("built for aarch64-apple-darwin debug");
    expect(() =>
      buildSidecar(
        { root, targetDir: join(root, "target"), triple: "aarch64-apple-darwin", release: true },
        fakeCargo(elsewhere, []),
      ),
    ).toThrow(/ERR_SIDECAR_MISSING/);
  });
});

describe("main", () => {
  function context(
    root: string,
    calls: string[][],
    lines: string[],
    {
      rustc = { status: 0, stdout: "aarch64-apple-darwin\n" },
      targetDir = join(root, "target"),
      metadata = { status: 0, stdout: JSON.stringify({ target_directory: targetDir }) },
    }: {
      rustc?: { status: number; stdout: string };
      targetDir?: string;
      metadata?: { status: number; stdout: string };
    } = {},
    cwds: [string, string, string | undefined][] = [],
  ): ScriptContext {
    const cargo = fakeCargo(targetDir, calls);
    return {
      argv: ["--release"],
      env: {},
      root,
      run: (command, args, options) => {
        if (command === "rustc") return { ...rustc, stderr: "" };
        cwds.push([command, args[0] ?? "", options?.cwd]);
        if (args[0] === "metadata") return { ...metadata, stderr: "" };
        return { ...cargo(command, args), stdout: "", stderr: "" };
      },
      log: (line) => {
        lines.push(line);
      },
    };
  }

  it("asks rustc for the host triple, builds, and reports where the helper went", () => {
    const root = tempRoot();
    const calls: string[][] = [];
    const lines: string[] = [];
    main(context(root, calls, lines));
    expect(calls[0]).toContain("--release");
    expect(calls[0]).toContain("aarch64-apple-darwin");
    expect(lines).toEqual([`sidecar: ${sidecarPath(root, "aarch64-apple-darwin")}`]);
  });

  it("finds the helper in the target directory cargo metadata reports (CARGO_TARGET_DIR)", () => {
    const root = tempRoot();
    const targetDir = tempRoot();
    const lines: string[] = [];
    main(context(root, [], lines, { targetDir }));
    const out = sidecarPath(root, "aarch64-apple-darwin");
    expect(lines).toEqual([`sidecar: ${out}`]);
    expect(readFileSync(out, "utf8")).toBe("built for aarch64-apple-darwin release");
  });

  it("asks cargo metadata from the directory its cargo build runs in", () => {
    const root = tempRoot();
    const cwds: [string, string, string | undefined][] = [];
    main(context(root, [], [], {}, cwds));
    const cargoCalls = cwds.filter(([command]) => command === "cargo");
    expect(cargoCalls).toEqual([
      ["cargo", "metadata", root],
      ["cargo", "build", root],
    ]);
  });

  it("fails with ERR_SIDECAR_TRIPLE when rustc cannot answer", () => {
    const root = tempRoot();
    expect(() => {
      main(context(root, [], [], { rustc: { status: 1, stdout: "" } }));
    }).toThrow(/ERR_SIDECAR_TRIPLE/);
  });

  it("fails with ERR_SIDECAR_TARGET_DIR before building when cargo metadata fails", () => {
    const root = tempRoot();
    const calls: string[][] = [];
    expect(() => {
      main(context(root, calls, [], { metadata: { status: 101, stdout: "" } }));
    }).toThrow(/ERR_SIDECAR_TARGET_DIR/);
    expect(calls).toEqual([]);
  });
});
