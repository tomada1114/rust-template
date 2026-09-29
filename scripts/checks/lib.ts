/**
 * The shape every harness check under `scripts/checks/` shares (design D14). A check
 * module exports `check`: a name and a `run(root)` that returns its violations (empty
 * when the claim holds), so the runner (`scripts/check-harness.ts`, `just check-harness`)
 * can run them all and a test can run one against a fixture root. Each module also runs
 * alone: `node scripts/checks/<name>.ts [--root DIR]`, with `checkMain(check)` as `main`.
 *
 * A violation is a {@link FailureDetails}: its code is `ERR_CHECK_<WHAT>`.
 *
 * Errors: ERR_CHECK_USAGE (bad arguments), and the first violation's own code.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { formatFailure, ScriptError, type FailureDetails } from "../lib/fail.ts";
import type { ScriptContext } from "../lib/script.ts";

export interface Check {
  /** The module's file name without `.ts`, e.g. `just-recipes-exist`. */
  readonly name: string;
  /** Every violation of the check's claim under `root`; empty when it holds. */
  readonly run: (root: string) => FailureDetails[];
}

/** A file under the root as text, or undefined when it does not exist. */
export function readRepoFile(root: string, path: string): string | undefined {
  const full = join(root, path);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : undefined;
}

function usage(summary: string, actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_CHECK_USAGE",
    summary,
    expected: "node scripts/checks/<name>.ts [--root DIR]",
    actual,
    next: "pass --root with an existing directory, or no arguments for this checkout",
  });
}

function parseRoot(argv: readonly string[], fallback: string): string {
  let root = fallback;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== "--root") throw usage("unknown argument", String(arg));
    const value = argv[i + 1];
    if (value === undefined) throw usage("--root needs a directory", "--root with no value");
    root = resolve(value);
    i += 1;
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw usage("--root is not a directory", root);
  }
  return root;
}

/** A script `main` that runs one check and fails on its first violation. */
export function checkMain(check: Check): (context: ScriptContext) => void {
  return (context) => {
    const violations = check.run(parseRoot(context.argv, context.root));
    const [first] = violations;
    if (first === undefined) {
      context.log(`check ${check.name}: ok`);
      return;
    }
    for (const other of violations.slice(1)) context.log(formatFailure(other));
    throw new ScriptError({
      ...first,
      summary: `${first.summary} (1 of ${String(violations.length)})`,
    });
  };
}
