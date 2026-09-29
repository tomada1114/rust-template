/**
 * Fails when lefthook's pre-commit hook is not installed in this checkout (design D11).
 * `just install` runs it last and `just check` first, so a clone that skipped
 * `lefthook install` is noticed before a commit bypasses the staged guard.
 *
 * Opt-outs: ALLOW_MISSING_GIT_HOOKS=1 (a checkout that deliberately commits without
 * hooks), and CI (no one commits there). Hook locations come from
 * `git rev-parse --git-path hooks`, so worktrees and core.hooksPath are honoured.
 *
 * Errors: ERR_HOOKS_NOT_A_REPO, ERR_HOOKS_CONFIG, ERR_HOOKS_NOT_INSTALLED.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { gitEnv } from "./lib/git-env.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

const OPT_OUT = "ALLOW_MISSING_GIT_HOOKS";

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && value !== "0" && value !== "false";

export function main(context: ScriptContext): void {
  const { env, root, log } = context;
  if (isSet(env[OPT_OUT])) {
    log(`verify-hooks: skipped (${OPT_OUT} is set); commits here bypass the staged guard`);
    return;
  }
  if (isSet(env["CI"])) {
    log("verify-hooks: skipped on CI, where no one commits");
    return;
  }

  const hooks = context.run("git", ["rev-parse", "--git-path", "hooks"], {
    cwd: root,
    env: gitEnv(env),
  });
  if (hooks.status !== 0) {
    throw new ScriptError({
      code: "ERR_HOOKS_NOT_A_REPO",
      summary: "not inside a git work tree",
      expected: "a git checkout of this repository",
      actual: hooks.stderr.trim(),
      next: "run from the repository root",
    });
  }

  const config = join(root, "lefthook.yml");
  if (!existsSync(config) || !/^pre-commit\s*:/m.test(readFileSync(config, "utf8"))) {
    throw new ScriptError({
      code: "ERR_HOOKS_CONFIG",
      summary: "lefthook.yml declares no pre-commit hook",
      expected: "a `pre-commit:` block in lefthook.yml",
      actual: existsSync(config) ? "lefthook.yml has no pre-commit block" : "no lefthook.yml",
      next: "restore lefthook.yml from version control",
    });
  }

  const dir = hooks.stdout.trim();
  const hook = join(isAbsolute(dir) ? dir : join(root, dir), "pre-commit");
  if (!existsSync(hook) || !readFileSync(hook, "utf8").includes("lefthook")) {
    throw new ScriptError({
      code: "ERR_HOOKS_NOT_INSTALLED",
      summary: "lefthook's pre-commit hook is not installed",
      expected: `a lefthook pre-commit hook at ${hook}`,
      actual: existsSync(hook) ? "a pre-commit hook that is not lefthook's" : "no pre-commit hook",
      next: `run \`just install\` (it runs \`lefthook install\`), or set ${OPT_OUT}=1 to commit without hooks on purpose`,
    });
  }
  log("verify-hooks: lefthook's pre-commit hook is installed");
}

if (import.meta.main) await runScript(main);
