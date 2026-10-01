/**
 * Prints the path of the app bundle the Tauri CLI built for one profile, found under the
 * target directory `cargo metadata` reports, so `just run` and `just install-app` honour a
 * `CARGO_TARGET_DIR` or `build.target-dir` instead of assuming `./target`. It only reads
 * cargo's metadata and the file system, so it needs no git work tree and runs anywhere.
 *
 * Failure codes: ERR_BUNDLE_ARGS, ERR_BUNDLE_TARGET_DIR, ERR_BUNDLE_MISSING.
 *
 * Usage: node scripts/bundle-path.ts debug|release
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { cargoTargetDir } from "./lib/cargo.ts";
import { ScriptError } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

export const APP_NAME = "MyApp";

export type Profile = "debug" | "release";

/** Where the Tauri CLI puts the `.app` for `profile` under cargo's target directory. */
export function appBundlePath(targetDir: string, profile: Profile): string {
  return join(targetDir, profile, "bundle", "macos", `${APP_NAME}.app`);
}

export function parseProfile(argv: readonly string[]): Profile {
  const [profile, ...rest] = argv;
  if ((profile === "debug" || profile === "release") && rest.length === 0) return profile;
  throw new ScriptError({
    code: "ERR_BUNDLE_ARGS",
    summary: "unrecognised arguments",
    expected: "exactly one argument: debug or release",
    actual: argv.length === 0 ? "no arguments" : argv.join(" "),
    next: "run `node scripts/bundle-path.ts debug`",
  });
}

export function main(context: ScriptContext): void {
  const profile = parseProfile(context.argv);
  // The Tauri CLI runs cargo in src-tauri/, where a relative CARGO_TARGET_DIR resolves.
  const targetDir = cargoTargetDir(context.run, join(context.root, "src-tauri"), "BUNDLE");
  const app = appBundlePath(targetDir, profile);
  if (!existsSync(app)) {
    throw new ScriptError({
      code: "ERR_BUNDLE_MISSING",
      summary: `the ${profile} app bundle is not there`,
      expected: app,
      actual: "no such directory",
      next: profile === "debug" ? "run `just build`" : "run `just smoke` or `just install-app`",
    });
  }
  context.log(app);
}

if (import.meta.main) await runScript(main);
