/**
 * `just bindings`: regenerates `ui/src/ipc/generated/` from core's ts-rs types (design
 * D4). ts-rs writes one `.ts` file per exported type from a test that only core's
 * `export-bindings` feature compiles, into `TS_RS_EXPORT_DIR`. This script points that at
 * a fresh directory beside the tracked one and swaps it in only when the export exits 0
 * and wrote at least one `.ts` file, so a failed build keeps the old bindings and a type
 * no longer exported leaves no stale file. The swap is two renames in one directory: the
 * old tree aside, the new one in (the old one is restored if that fails), then the old
 * one is removed.
 *
 * Usage: node scripts/bindings.ts
 * It works on files under the repository root and runs no git, so it needs no work tree.
 *
 * Errors: ERR_BINDINGS_ARGS, ERR_BINDINGS_EXPORT, ERR_BINDINGS_EMPTY, ERR_BINDINGS_SWAP.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

const CORE_PACKAGE = "myapp-core";
const FEATURE = "export-bindings";
const GENERATED = join("ui", "src", "ipc", "generated");

/** The cargo invocation that runs ts-rs's export tests (and nothing else). */
export const EXPORT_ARGS = [
  "test",
  "--locked",
  "-p",
  CORE_PACKAGE,
  "--lib",
  "--features",
  FEATURE,
  "export_bindings",
  "--quiet",
] as const;

export type Rename = (from: string, to: string) => void;

function swapFailed(target: string, error: unknown, note: string): ScriptError {
  return new ScriptError({
    code: "ERR_BINDINGS_SWAP",
    summary: `could not move the new bindings into ${target}`,
    expected: "two renames inside ui/src/ipc/ to succeed",
    actual: `${error instanceof Error ? error.message : String(error)}; ${note}`,
    next: "check the permissions on ui/src/ipc/, then rerun `just bindings`",
  });
}

/**
 * Replace `target` with `fresh`, which must sit in the same directory so each step is a
 * rename. When the second rename fails the old tree is renamed back; either way `fresh`
 * is left for the caller to remove.
 */
export function replaceDirectory(fresh: string, target: string, rename: Rename = renameSync): void {
  const aside = `${fresh}.old`;
  const hadTarget = existsSync(target);
  if (hadTarget) {
    try {
      rename(target, aside);
    } catch (error: unknown) {
      throw swapFailed(target, error, "nothing was changed");
    }
  }
  try {
    rename(fresh, target);
  } catch (error: unknown) {
    if (!hadTarget) throw swapFailed(target, error, "there were no previous bindings");
    try {
      rename(aside, target);
    } catch {
      throw swapFailed(
        target,
        error,
        `the previous bindings could not be put back and are in ${aside}`,
      );
    }
    throw swapFailed(target, error, "the previous bindings are back in place");
  }
  if (hadTarget) rmSync(aside, { recursive: true, force: true });
}

export function main(context: ScriptContext): void {
  if (context.argv.length > 0) {
    throw new ScriptError({
      code: "ERR_BINDINGS_ARGS",
      summary: "unrecognised arguments",
      expected: "no arguments",
      actual: context.argv.join(" "),
      next: "run `just bindings`",
    });
  }
  const target = join(context.root, GENERATED);
  const fresh = mkdtempSync(join(dirname(target), `.${basename(target)}-`));
  try {
    const { status } = context.run("cargo", EXPORT_ARGS, {
      cwd: context.root,
      inherit: true,
      env: { ...context.env, TS_RS_EXPORT_DIR: fresh },
    });
    if (status !== 0) {
      throw new ScriptError({
        code: "ERR_BINDINGS_EXPORT",
        summary: `ts-rs's export failed; ${GENERATED}/ is unchanged`,
        expected: `\`cargo ${EXPORT_ARGS.join(" ")}\` to exit 0`,
        actual: `exit status ${String(status)}`,
        next: "read cargo's errors above, fix them, then rerun `just bindings`",
      });
    }
    const exported = readdirSync(fresh).filter((name) => name.endsWith(".ts"));
    if (exported.length === 0) {
      throw new ScriptError({
        code: "ERR_BINDINGS_EMPTY",
        summary: `the export wrote no bindings; ${GENERATED}/ is unchanged`,
        expected: "one .ts file per core type exported by ts-rs",
        actual: "no .ts file in the export directory",
        next: `check ${CORE_PACKAGE}'s ${FEATURE} feature and each IPC type's \`cfg_attr(feature = "${FEATURE}", ts(export))\`, then rerun \`just bindings\``,
      });
    }
    // mkdtemp creates the directory owner-only; the tracked one is an ordinary directory.
    chmodSync(fresh, 0o755);
    replaceDirectory(fresh, target);
    context.log(`bindings: ${String(exported.length)} file(s) in ${GENERATED}/`);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

if (import.meta.main) await runScript(main);
