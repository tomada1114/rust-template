/**
 * Cargo's target directory, as `cargo metadata` reports it. Cargo resolves
 * `CARGO_TARGET_DIR`, `build.target-dir` in any `.cargo/config.toml`, and the `./target`
 * default itself, so a script that joins `<root>/target` looks in the wrong place for
 * anyone who set one of the first two. A relative `CARGO_TARGET_DIR` resolves against the
 * directory cargo runs in, so ask from the directory the matching build runs cargo in.
 *
 * Failure code: `ERR_<STAGE>_TARGET_DIR`, with the calling script's stage.
 */
import { ScriptError } from "./fail.ts";
import type { Run } from "./script.ts";

export const CARGO_METADATA_ARGS = [
  "metadata",
  "--format-version",
  "1",
  "--no-deps",
  "--locked",
] as const;

function targetDirectoryOf(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("target_directory" in parsed)) {
    return undefined;
  }
  const dir = parsed.target_directory;
  return typeof dir === "string" && dir !== "" ? dir : undefined;
}

/** The absolute target directory cargo uses when it runs in `cwd`. */
export function cargoTargetDir(run: Run, cwd: string, stage: string): string {
  const { status, stdout, stderr } = run("cargo", CARGO_METADATA_ARGS, { cwd });
  const dir = status === 0 ? targetDirectoryOf(stdout) : undefined;
  if (dir === undefined) {
    throw new ScriptError({
      code: `ERR_${stage}_TARGET_DIR`,
      summary: "could not ask cargo for the workspace's target directory",
      expected: `\`cargo ${CARGO_METADATA_ARGS.join(" ")}\` to exit 0 with a JSON target_directory`,
      actual:
        status === 0
          ? "no target_directory in its output"
          : `exit status ${String(status)}: ${stderr.trim()}`,
      next: `run \`cargo ${CARGO_METADATA_ARGS.join(" ")}\` in ${cwd} and fix what it reports`,
    });
  }
  return dir;
}
