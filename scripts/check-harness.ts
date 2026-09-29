/**
 * Runs every harness check under `scripts/checks/` (design D14; `just check-harness`,
 * part of `just check` and CI's `Repo Lint & Harness` job). A check is any
 * `scripts/checks/*.ts` other than `lib.ts` and the tests, exporting `check` (see
 * scripts/checks/lib.ts), so adding a check is adding a file. Every check runs, and each
 * violation is printed, before the run fails.
 *
 * Errors: ERR_HARNESS_FAILED (a check found violations), ERR_HARNESS_MODULE (a module
 * exports no check).
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { formatFailure, ScriptError } from "./lib/fail.ts";
import type { Check } from "./checks/lib.ts";
import { REPO_ROOT, runScript, type ScriptContext } from "./lib/script.ts";

const CHECKS_DIR = join(REPO_ROOT, "scripts", "checks");

/** The check modules in `dir`, sorted by name. */
export function discoverChecks(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        entry.name !== "lib.ts",
    )
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** Run each check against `root`, printing a line per check; returns the failures. */
export function runChecks(
  checks: readonly Check[],
  root: string,
  log: (line: string) => void,
): number {
  let failures = 0;
  for (const check of checks) {
    const violations = check.run(root);
    if (violations.length === 0) {
      log(`ok    ${check.name}`);
      continue;
    }
    failures += 1;
    log(`FAIL  ${check.name}`);
    for (const violation of violations) log(formatFailure(violation));
  }
  return failures;
}

function isCheck(value: unknown): value is Check {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof Check, unknown>>;
  return typeof candidate.name === "string" && typeof candidate.run === "function";
}

async function loadChecks(dir: string): Promise<Check[]> {
  const checks: Check[] = [];
  for (const path of discoverChecks(dir)) {
    const module = (await import(pathToFileURL(path).href)) as { check?: unknown };
    if (!isCheck(module.check)) {
      throw new ScriptError({
        code: "ERR_HARNESS_MODULE",
        summary: `${basename(path)} exports no check`,
        expected: "`export const check: Check = { name, run }` (scripts/checks/lib.ts)",
        actual: `the module's exports: ${Object.keys(module).join(", ") || "none"}`,
        next: "export the check, or move a helper into scripts/checks/lib.ts",
      });
    }
    checks.push(module.check);
  }
  return checks;
}

export async function main(context: ScriptContext, dir: string = CHECKS_DIR): Promise<void> {
  const checks = await loadChecks(dir);
  const failures = runChecks(checks, context.root, context.log);
  if (failures > 0) {
    throw new ScriptError({
      code: "ERR_HARNESS_FAILED",
      summary: "a harness check found the repository contradicting itself",
      expected: "every check under scripts/checks/ to pass",
      actual: `${String(failures)} of ${String(checks.length)} checks failed (each is printed above)`,
      next: "fix what each ERR_CHECK_* line names, or run one check alone: node scripts/checks/<name>.ts",
    });
  }
  context.log(`check-harness: ${String(checks.length)} checks passed`);
}

if (import.meta.main) await runScript(main);
