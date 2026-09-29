/**
 * Builds the `myapp-cli` helper and copies it to
 * `src-tauri/binaries/myapp-cli-<target-triple>`, where Tauri's `bundle.externalBin`
 * expects it (design D5). Tauri documents no way to build a workspace binary into
 * place, so this script is that step. `tauri.conf.json` runs it as
 * `beforeDevCommand`/`beforeBuildCommand`, and `just sidecar` runs it for every recipe
 * that compiles the Tauri crate, because `tauri-build` fails when the file is missing.
 *
 * Usage: node scripts/build-sidecar.ts [--release] [--target <triple>]
 * Without flags it reads TAURI_ENV_TARGET_TRIPLE / TAURI_ENV_DEBUG (set by the Tauri
 * CLI for its before-commands; DEBUG only in a debug build), then falls back to the host
 * triple and a debug build.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

export type RunCommand = (command: string, args: readonly string[]) => { status: number | null };

export interface SidecarOptions {
  readonly triple: string;
  readonly release: boolean;
}

const HELPER = "myapp-cli";

function argsError(actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_SIDECAR_ARGS",
    summary: "unrecognised arguments",
    expected: "[--release] [--target <triple>]",
    actual,
    next: "run `just sidecar`, or pass only the flags above",
  });
}

/** Work out the target triple and profile from the arguments, then Tauri's env, then the host. */
export function parseOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  hostTriple: () => string,
): SidecarOptions {
  let triple: string | undefined;
  let release: boolean | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--release") {
      release = true;
    } else if (arg === "--target") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        throw argsError("--target without a value");
      triple = value;
      i += 1;
    } else {
      throw argsError(String(arg));
    }
  }
  // The Tauri CLI exports TAURI_ENV_TARGET_TRIPLE to its before-commands, plus
  // TAURI_ENV_DEBUG=true for a debug build only (observed with the 2.11 CLI).
  const tauriTriple = env["TAURI_ENV_TARGET_TRIPLE"];
  const fromTauri = tauriTriple === undefined ? undefined : env["TAURI_ENV_DEBUG"] !== "true";
  return {
    triple: triple ?? tauriTriple ?? hostTriple(),
    release: release ?? fromTauri ?? false,
  };
}

/** Where Tauri looks for the helper built for `triple`. */
export function sidecarPath(root: string, triple: string): string {
  return join(root, "src-tauri", "binaries", `${HELPER}-${triple}`);
}

/** Build the helper with cargo and copy it into place. Returns the copied file's path. */
export function buildSidecar(
  options: SidecarOptions & { readonly root: string },
  run: RunCommand,
): string {
  const { root, triple, release } = options;
  const args = [
    "build",
    "--locked",
    "-p",
    HELPER,
    "--target",
    triple,
    ...(release ? ["--release"] : []),
  ];
  const { status } = run("cargo", args);
  if (status !== 0) {
    throw new ScriptError({
      code: "ERR_SIDECAR_BUILD",
      summary: `cargo could not build ${HELPER}`,
      expected: "cargo build to exit 0",
      actual: `exit status ${String(status)}`,
      next: "read cargo's errors above, fix them, then run `just sidecar` again",
    });
  }
  const built = join(root, "target", triple, release ? "release" : "debug", HELPER);
  if (!existsSync(built)) {
    throw new ScriptError({
      code: "ERR_SIDECAR_MISSING",
      summary: "cargo reported success but the helper binary is not where it should be",
      expected: built,
      actual: "no such file",
      next: "check CARGO_TARGET_DIR is unset (the script expects ./target), then rerun",
    });
  }
  const out = sidecarPath(root, triple);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(built, out);
  chmodSync(out, 0o755);
  return out;
}

/** The whole script: parse the options, build, and say where the helper went. */
export function main(context: ScriptContext): void {
  const options = parseOptions(context.argv, context.env, () => {
    const { status, stdout } = context.run("rustc", ["--print", "host-tuple"]);
    if (status !== 0) {
      throw new ScriptError({
        code: "ERR_SIDECAR_TRIPLE",
        summary: "could not ask rustc for the host target triple",
        expected: "`rustc --print host-tuple` to succeed",
        actual: `exit status ${String(status)}`,
        next: "run `just install` so the pinned Rust toolchain is present",
      });
    }
    return stdout.trim();
  });
  const out = buildSidecar({ ...options, root: context.root }, (command, args) =>
    context.run(command, args, { cwd: context.root, inherit: true }),
  );
  context.log(`sidecar: ${out}`);
}

if (import.meta.main) await runScript(main);
