// lefthook.yml's pre-commit hook, run by the real lefthook through a real `git commit`
// in a throwaway repository: the commit that concludes a conflicted merge, or one made at
// a conflicted rebase stop, carries a resolution no hook has seen, so the staged guard and
// the skills mirror must still run for it. The throwaway repository gets the checkout's
// lefthook.yml and the two scripts those jobs run; nothing is written to the checkout.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { isRecord } from "./checks/shared/workflows.ts";
import { gitEnv } from "./lib/git-env.ts";
import { runCommand, type RunResult } from "./lib/script.ts";

const ROOT = join(import.meta.dirname, "..");

// Assembled at runtime: this file must never hold a credential-shaped literal.
const GITHUB_TOKEN = ["gh", "p_", "Z".repeat(36)].join("");

const SKILL = "demo/SKILL.md";

/**
 * The directory holding the pinned lefthook. A mise shim picks its version from the
 * working directory's mise.toml, which a throwaway repository lacks, so the hook there
 * needs the real binary on PATH: ask mise from the checkout, or else trust PATH as given.
 */
function lefthookDir(): string | undefined {
  const viaMise = runCommand("mise", ["which", "lefthook"], { cwd: ROOT, env: process.env });
  return viaMise.status === 0 ? dirname(viaMise.stdout.trim()) : undefined;
}

const LEFTHOOK_DIR = lefthookDir();

/**
 * This process's environment without GIT_* or LEFTHOOK* (either would change the run),
 * with no global or system git config (a user's core.hooksPath or merge.ff=only would),
 * and the node running this test first on PATH: the hook's `node scripts/…` jobs run in
 * a directory no mise.toml covers, where a node shim would not resolve.
 */
function hookEnv(): Record<string, string | undefined> {
  const env = Object.fromEntries(
    Object.entries(gitEnv(process.env)).filter(([name]) => !name.startsWith("LEFTHOOK")),
  );
  const first = [dirname(process.execPath), ...(LEFTHOOK_DIR === undefined ? [] : [LEFTHOOK_DIR])];
  return {
    ...env,
    NO_COLOR: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: [...first, env["PATH"] ?? ""].join(delimiter),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(repo: string, command: string, ...args: string[]): RunResult {
  return runCommand(command, args, { cwd: repo, env: hookEnv() });
}

function git(repo: string, ...args: string[]): string {
  const result = run(repo, "git", ...args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** Write `files`, stage them, and commit without a hook (none is installed yet). */
function commit(repo: string, message: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) write(repo, path, content);
  git(repo, "add", "--", ...Object.keys(files));
  git(repo, "commit", "-q", "-m", message);
}

/**
 * A repository with the checkout's lefthook.yml and the scripts its jobs run, where
 * `main` and `side` both changed `files` from a common base, with lefthook's hooks
 * installed and `main` checked out.
 */
function divergedRepo(files: (side: string) => Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "lefthook-merge-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  cpSync(join(ROOT, "lefthook.yml"), join(repo, "lefthook.yml"));
  for (const script of ["check-staged.ts", "sync-agents.ts", "lib"]) {
    cpSync(join(ROOT, "scripts", script), join(repo, "scripts", script), {
      recursive: true,
      filter: (source) => !source.endsWith(".test.ts"),
    });
  }
  git(repo, "add", "lefthook.yml", "scripts");
  commit(repo, "base", files("base"));
  git(repo, "switch", "-q", "-c", "side");
  commit(repo, "side", files("side"));
  git(repo, "switch", "-q", "main");
  commit(repo, "main", files("main"));

  const installed = run(repo, "lefthook", "install");
  if (installed.status !== 0) {
    throw new Error(
      `lefthook install failed (run the tests under mise, e.g. \`mise exec -- just test-scripts\`): ${installed.stderr}`,
    );
  }
  return repo;
}

/** `side` merged into `main`, every file in `files` conflicting; the merge is left open. */
function conflictedMerge(files: (side: string) => Record<string, string>): string {
  const repo = divergedRepo(files);
  expect(run(repo, "git", "merge", "side").status).not.toBe(0);
  expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  return repo;
}

/** `git commit` with `args`, its status and everything it printed. */
function commitNow(repo: string, ...args: string[]): { status: number | null; output: string } {
  const result = run(repo, "git", "commit", ...args);
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/** Conclude the open merge the way a person does after resolving it. */
function concludeMerge(repo: string): { status: number | null; output: string } {
  return commitNow(repo, "--no-edit");
}

function mergeConcluded(repo: string): boolean {
  return !existsSync(join(repo, ".git", "MERGE_HEAD"));
}

describe("lefthook.yml", () => {
  it("never skips the staged guard or the skills mirror during a merge or a rebase", () => {
    const config: unknown = parse(readFileSync(join(ROOT, "lefthook.yml"), "utf8"));
    const hook = isRecord(config) ? config["pre-commit"] : undefined;
    if (!isRecord(hook) || !Array.isArray(hook["jobs"])) {
      throw new Error("lefthook.yml has no pre-commit block with a jobs list");
    }
    expect(hook["skip"]).toBeUndefined();
    expect(hook["only"]).toBeUndefined();
    const jobs: unknown[] = hook["jobs"];
    for (const name of ["staged guard", "skills mirror"]) {
      const job = jobs.find((candidate) => isRecord(candidate) && candidate["name"] === name);
      if (!isRecord(job)) throw new Error(`lefthook.yml has no "${name}" job`);
      expect(job["skip"], name).toBeUndefined();
      expect(job["only"], name).toBeUndefined();
    }
  });
});

describe("the pre-commit hook on the commit that concludes a conflicted merge", () => {
  it("refuses a credential-shaped line staged as the resolution", () => {
    const repo = conflictedMerge((side) => ({ "notes.txt": `${side}\n` }));
    write(repo, "notes.txt", `resolved\ntoken = ${GITHUB_TOKEN}\n`);
    git(repo, "add", "notes.txt");

    const result = concludeMerge(repo);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("ERR_STAGED_CREDENTIAL_SHAPED: notes.txt");
    expect(result.output).not.toContain(GITHUB_TOKEN);
    expect(mergeConcluded(repo)).toBe(false);
  });

  it("refuses a resolved skill conflict staged without its synced mirror", () => {
    const repo = conflictedMerge((side) => ({
      [`.agents/skills/${SKILL}`]: `${side}\n`,
      [`.claude/skills/${SKILL}`]: `${side}\n`,
    }));
    write(repo, `.agents/skills/${SKILL}`, "resolved\n");
    write(repo, `.claude/skills/${SKILL}`, "main\n");
    git(repo, "add", ".agents", ".claude");

    const result = concludeMerge(repo);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("ERR_AGENTS_DRIFT");
    expect(result.output).toContain(`.claude/skills/${SKILL}`);
    expect(mergeConcluded(repo)).toBe(false);
  });

  it("concludes a clean resolution, skipping only the style jobs", () => {
    const repo = conflictedMerge((side) => ({
      "notes.txt": `${side}\n`,
      [`.agents/skills/${SKILL}`]: `${side}\n`,
      [`.claude/skills/${SKILL}`]: `${side}\n`,
    }));
    for (const path of ["notes.txt", `.agents/skills/${SKILL}`, `.claude/skills/${SKILL}`]) {
      write(repo, path, "resolved\n");
    }
    git(repo, "add", "--all");

    const result = concludeMerge(repo);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("staged guard");
    for (const job of ["rustfmt", "prettier", "eslint", "typos"]) {
      expect(result.output).toContain(`${job} (skip) by condition`);
    }
    expect(mergeConcluded(repo)).toBe(true);
  });
});

describe("the pre-commit hook on a `git commit` at a conflicted rebase stop", () => {
  it("refuses a credential-shaped line staged as the resolution", () => {
    const repo = divergedRepo((side) => ({ "notes.txt": `${side}\n` }));
    expect(run(repo, "git", "rebase", "side").status).not.toBe(0);
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(true);
    write(repo, "notes.txt", `resolved\ntoken = ${GITHUB_TOKEN}\n`);
    git(repo, "add", "notes.txt");

    const result = commitNow(repo, "-m", "main, resolved");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("ERR_STAGED_CREDENTIAL_SHAPED: notes.txt");
    expect(result.output).not.toContain(GITHUB_TOKEN);
  });
});
