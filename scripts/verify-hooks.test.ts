import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitEnv } from "./lib/git-env.ts";
import { runCommand, type ScriptContext } from "./lib/script.ts";
import { main } from "./verify-hooks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(options: { hook?: string; config?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-hooks-"));
  dirs.push(dir);
  runCommand("git", ["init", "-q"], { cwd: dir, env: gitEnv(process.env) });
  writeFileSync(join(dir, "lefthook.yml"), options.config ?? "pre-commit:\n  jobs: []\n");
  if (options.hook !== undefined) {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), options.hook);
  }
  return dir;
}

function run(
  root: string,
  env: Record<string, string> = {},
): { error: string | undefined; lines: string[] } {
  const lines: string[] = [];
  const context: ScriptContext = {
    argv: [],
    env,
    root,
    run: runCommand,
    log: (line) => lines.push(line),
  };
  try {
    main(context);
    return { error: undefined, lines };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error), lines };
  }
}

const LEFTHOOK_HOOK = "#!/bin/sh\n# lefthook generated\ncall_lefthook run pre-commit\n";

describe("verify-hooks", () => {
  it("passes when lefthook's pre-commit hook is installed", () => {
    const result = run(repo({ hook: LEFTHOOK_HOOK }));
    expect(result.error).toBeUndefined();
    expect(result.lines.join("\n")).toContain("pre-commit hook is installed");
  });

  it("fails when no pre-commit hook is installed", () => {
    expect(run(repo()).error).toMatch(/^ERR_HOOKS_NOT_INSTALLED/);
  });

  it("fails when the installed hook is not lefthook's", () => {
    expect(run(repo({ hook: "#!/bin/sh\necho custom\n" })).error).toMatch(
      /^ERR_HOOKS_NOT_INSTALLED/,
    );
  });

  it("fails when lefthook.yml has no pre-commit block", () => {
    expect(run(repo({ hook: LEFTHOOK_HOOK, config: "pre-push:\n  jobs: []\n" })).error).toMatch(
      /^ERR_HOOKS_CONFIG/,
    );
  });

  it("fails when lefthook.yml is missing", () => {
    const dir = repo({ hook: LEFTHOOK_HOOK });
    rmSync(join(dir, "lefthook.yml"));
    expect(run(dir).error).toMatch(/^ERR_HOOKS_CONFIG/);
  });

  it("fails outside a git work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-repo-"));
    dirs.push(dir);
    expect(run(dir).error).toMatch(/^ERR_HOOKS_NOT_A_REPO/);
  });

  it("honours the ALLOW_MISSING_GIT_HOOKS opt-out", () => {
    const result = run(repo(), { ALLOW_MISSING_GIT_HOOKS: "1" });
    expect(result.error).toBeUndefined();
    expect(result.lines.join("\n")).toContain("ALLOW_MISSING_GIT_HOOKS");
  });

  it.each(["0", "false", ""])(
    "does not treat ALLOW_MISSING_GIT_HOOKS=%j as an opt-out",
    (value) => {
      expect(run(repo(), { ALLOW_MISSING_GIT_HOOKS: value }).error).toMatch(
        /^ERR_HOOKS_NOT_INSTALLED/,
      );
    },
  );

  it("skips on CI, where no one commits", () => {
    const result = run(repo(), { CI: "true" });
    expect(result.error).toBeUndefined();
    expect(result.lines.join("\n")).toContain("CI");
  });
});
