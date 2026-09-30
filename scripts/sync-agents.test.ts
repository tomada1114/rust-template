import {
  chmodSync,
  existsSync,
  lstatSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitEnv } from "./lib/git-env.ts";
import { runCommand, type Run, type ScriptContext } from "./lib/script.ts";
import { main } from "./sync-agents.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SOURCE = ".agents/skills";
const MIRROR = ".claude/skills";

function write(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-agents-"));
  dirs.push(dir);
  mkdirSync(join(dir, SOURCE), { recursive: true });
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  return dir;
}

function run(
  root: string,
  argv: string[] = [],
  env: Readonly<Record<string, string | undefined>> = {},
  runner: Run = runCommand,
): { error: string | undefined; actual: string | undefined; lines: string[] } {
  const lines: string[] = [];
  const context: ScriptContext = {
    argv,
    env,
    root,
    run: runner,
    log: (line) => lines.push(line),
  };
  try {
    main(context);
    return { error: undefined, actual: undefined, lines };
  } catch (error: unknown) {
    const actual =
      error !== null && typeof error === "object" && "details" in error
        ? (error.details as { actual: string }).actual
        : undefined;
    return { error: error instanceof Error ? error.message : String(error), actual, lines };
  }
}

const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8");

describe("sync-agents (sync)", () => {
  it("creates the mirror as real files, byte for byte", () => {
    const binary = Buffer.from([0, 1, 2, 255, 10]);
    const root = repo({ [`${SOURCE}/a/SKILL.md`]: "# a\n", [`${SOURCE}/a/references/x.md`]: "x" });
    write(root, `${SOURCE}/b/bin.dat`, binary);
    const result = run(root);
    expect(result.error).toBeUndefined();
    expect(read(root, `${MIRROR}/a/SKILL.md`)).toBe("# a\n");
    expect(read(root, `${MIRROR}/a/references/x.md`)).toBe("x");
    expect(readFileSync(join(root, `${MIRROR}/b/bin.dat`)).equals(binary)).toBe(true);
    expect(lstatSync(join(root, MIRROR)).isSymbolicLink()).toBe(false);
    expect(result.lines.join("\n")).toContain("updated 3 path(s)");
    expect(result.lines).toContain("- missing: a/SKILL.md");
  });

  it("updates changed files, removes stale ones, and prunes emptied directories", () => {
    const root = repo({
      [`${SOURCE}/a/SKILL.md`]: "new",
      [`${MIRROR}/a/SKILL.md`]: "old",
      [`${MIRROR}/gone/deep/file.md`]: "stale",
      [`${MIRROR}/a/extra.md`]: "stale",
    });
    const result = run(root);
    expect(result.error).toBeUndefined();
    expect(read(root, `${MIRROR}/a/SKILL.md`)).toBe("new");
    expect(existsSync(join(root, `${MIRROR}/a/extra.md`))).toBe(false);
    expect(existsSync(join(root, `${MIRROR}/gone`))).toBe(false);
    expect(existsSync(join(root, MIRROR))).toBe(true);
    expect(result.lines).toEqual(
      expect.arrayContaining(["- differs: a/SKILL.md", "- extra: gone/deep/file.md"]),
    );
    expect(run(root, ["--check"]).error).toBeUndefined();
  });

  it("replaces a path that changed kind between file and directory", () => {
    const root = repo({
      [`${SOURCE}/a/SKILL.md`]: "dir now",
      [`${SOURCE}/b`]: "file now",
      [`${MIRROR}/a`]: "was a file",
      [`${MIRROR}/b/inner.md`]: "was a dir",
    });
    expect(run(root).error).toBeUndefined();
    expect(read(root, `${MIRROR}/a/SKILL.md`)).toBe("dir now");
    expect(read(root, `${MIRROR}/b`)).toBe("file now");
  });

  it("copies a changed executable bit, even when the bytes match", () => {
    const root = repo({ [`${SOURCE}/run.sh`]: "echo\n", [`${MIRROR}/run.sh`]: "echo\n" });
    chmodSync(join(root, `${SOURCE}/run.sh`), 0o755);
    expect(run(root, ["--check"]).actual).toBe(`differs: ${MIRROR}/run.sh`);
    expect(run(root).error).toBeUndefined();
    expect(statSync(join(root, `${MIRROR}/run.sh`)).mode & 0o111).toBe(0o111);
    expect(run(root, ["--check"]).error).toBeUndefined();
  });

  it("reports an already-synced mirror and leaves it alone", () => {
    const root = repo({ [`${SOURCE}/a.md`]: "a", [`${MIRROR}/a.md`]: "a" });
    const result = run(root);
    expect(result.error).toBeUndefined();
    expect(result.lines).toEqual([`agents:sync: ${MIRROR}/ was already in sync.`]);
  });

  it("ignores .DS_Store on both sides", () => {
    const root = repo({
      [`${SOURCE}/.DS_Store`]: "finder",
      [`${SOURCE}/a.md`]: "a",
      [`${MIRROR}/a.md`]: "a",
      [`${MIRROR}/sub/.DS_Store`]: "finder",
    });
    expect(run(root).lines).toEqual([`agents:sync: ${MIRROR}/ was already in sync.`]);
    expect(existsSync(join(root, `${MIRROR}/.DS_Store`))).toBe(false);
    expect(run(root, ["--check"]).error).toBeUndefined();
  });
  it("ignores Python bytecode on both sides", () => {
    const root = repo({
      [`${SOURCE}/a/scripts/tests/__pycache__/t.cpython-311.pyc`]: "bytecode",
      [`${SOURCE}/a/scripts/stray.pyc`]: "bytecode",
      [`${SOURCE}/a/SKILL.md`]: "a",
      [`${MIRROR}/a/SKILL.md`]: "a",
      [`${MIRROR}/b/__pycache__/t.cpython-311.pyc`]: "bytecode",
    });
    expect(run(root).lines).toEqual([`agents:sync: ${MIRROR}/ was already in sync.`]);
    expect(existsSync(join(root, `${MIRROR}/a/scripts/tests/__pycache__`))).toBe(false);
    expect(existsSync(join(root, `${MIRROR}/a/scripts/stray.pyc`))).toBe(false);
    expect(run(root, ["--check"]).error).toBeUndefined();
  });
});

describe("sync-agents --check", () => {
  it("passes when the mirror equals the source", () => {
    const root = repo({ [`${SOURCE}/a/SKILL.md`]: "a", [`${MIRROR}/a/SKILL.md`]: "a" });
    const result = run(root, ["--check"]);
    expect(result.error).toBeUndefined();
    expect(result.lines).toEqual([`agents:check: ${MIRROR}/ is in sync.`]);
  });

  it("lists every differing path without writing", () => {
    const root = repo({
      [`${SOURCE}/missing.md`]: "m",
      [`${SOURCE}/same.md`]: "s",
      [`${SOURCE}/changed.md`]: "new",
      [`${MIRROR}/same.md`]: "s",
      [`${MIRROR}/changed.md`]: "old",
      [`${MIRROR}/extra.md`]: "e",
    });
    const result = run(root, ["--check"]);
    expect(result.error).toMatch(/^ERR_AGENTS_DRIFT: /);
    expect(result.actual).toContain(`missing: ${MIRROR}/missing.md`);
    expect(result.actual).toContain(`differs: ${MIRROR}/changed.md`);
    expect(result.actual).toContain(`extra: ${MIRROR}/extra.md`);
    expect(result.actual).not.toContain("same.md");
    expect(existsSync(join(root, `${MIRROR}/missing.md`))).toBe(false);
    expect(existsSync(join(root, `${MIRROR}/extra.md`))).toBe(true);
    expect(read(root, `${MIRROR}/changed.md`)).toBe("old");
  });

  it("fails when the mirror does not exist, and does not create it", () => {
    const root = repo({ [`${SOURCE}/a.md`]: "a" });
    const result = run(root, ["--check"]);
    expect(result.error).toMatch(/^ERR_AGENTS_DRIFT/);
    expect(result.actual).toContain(`missing: ${MIRROR}/a.md`);
    expect(existsSync(join(root, MIRROR))).toBe(false);
  });

  it("passes for an empty source and an absent mirror", () => {
    expect(run(repo(), ["--check"]).error).toBeUndefined();
  });
});

describe("sync-agents refusals", () => {
  it("refuses unknown arguments", () => {
    const root = repo({ [`${SOURCE}/a.md`]: "a" });
    const result = run(root, ["--check", "--force"]);
    expect(result.error).toMatch(/^ERR_AGENTS_USAGE: unknown argument\(s\): --force/);
    expect(existsSync(join(root, MIRROR))).toBe(false);
  });

  it("refuses a missing source directory", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-agents-"));
    dirs.push(root);
    expect(run(root).error).toMatch(/^ERR_AGENTS_SOURCE_MISSING/);
  });

  it("refuses a source that is a file", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-agents-"));
    dirs.push(root);
    write(root, SOURCE, "not a dir");
    expect(run(root).error).toMatch(/^ERR_AGENTS_SOURCE_MISSING/);
  });

  it("refuses a symlinked source directory", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-agents-"));
    dirs.push(root);
    mkdirSync(join(root, "real"));
    mkdirSync(join(root, ".agents"));
    symlinkSync(join(root, "real"), join(root, SOURCE));
    expect(run(root).error).toMatch(/^ERR_AGENTS_SYMLINK: \.agents\/skills is a symlink/);
  });

  it("refuses a symlinked mirror directory and leaves its target untouched", () => {
    const root = repo({ [`${SOURCE}/a.md`]: "a" });
    mkdirSync(join(root, "elsewhere"));
    mkdirSync(join(root, ".claude"));
    symlinkSync(join(root, "elsewhere"), join(root, MIRROR));
    for (const argv of [[], ["--check"]]) {
      expect(run(root, argv).error).toMatch(/^ERR_AGENTS_SYMLINK: \.claude\/skills is a symlink/);
    }
    expect(existsSync(join(root, "elsewhere/a.md"))).toBe(false);
  });

  it("refuses a mirror path that is a file", () => {
    const root = repo({ [`${SOURCE}/a.md`]: "a", [MIRROR]: "file" });
    expect(run(root).error).toMatch(/^ERR_AGENTS_MIRROR_NOT_DIRECTORY/);
  });

  it("refuses a symlinked entry in the source", () => {
    const root = repo({ [`${SOURCE}/a/SKILL.md`]: "a" });
    symlinkSync(join(root, `${SOURCE}/a/SKILL.md`), join(root, `${SOURCE}/a/link.md`));
    const result = run(root);
    expect(result.error).toMatch(/^ERR_AGENTS_SYMLINK: .agents\/skills\/a\/link.md/);
    expect(existsSync(join(root, MIRROR))).toBe(false);
  });

  it("refuses a symlinked entry in the mirror", () => {
    const root = repo({ [`${SOURCE}/a.md`]: "a" });
    mkdirSync(join(root, MIRROR), { recursive: true });
    symlinkSync(join(root, `${SOURCE}/a.md`), join(root, `${MIRROR}/a.md`));
    expect(run(root, ["--check"]).error).toMatch(/^ERR_AGENTS_SYMLINK: .claude\/skills\/a.md/);
  });

  it("rethrows an unexpected filesystem error", () => {
    const root = repo({ [`${SOURCE}/a.md`]: "a" });
    // A NUL byte makes every fs call throw ERR_INVALID_ARG_VALUE, not ENOENT.
    expect(run(`${root}\0`).error).not.toMatch(/^ERR_AGENTS_/);
  });
});

/** A throwaway git repository holding `files`; nothing is staged yet. */
function gitRepo(files: Record<string, string> = {}): string {
  const root = repo(files);
  git(root, "init", "--quiet");
  return root;
}

function git(root: string, ...args: string[]): string {
  const result = runCommand("git", args, { cwd: root, env: gitEnv(process.env) });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const STAGED = ["--check", "--staged"];
const hookEnv = (): Record<string, string | undefined> => gitEnv(process.env);

describe("sync-agents --check --staged", () => {
  it("fails when only the source is staged, although the working trees match", () => {
    const root = gitRepo({ [`${SOURCE}/a/SKILL.md`]: "old", [`${MIRROR}/a/SKILL.md`]: "old" });
    git(root, "add", SOURCE, MIRROR);
    write(root, `${SOURCE}/a/SKILL.md`, "new");
    expect(run(root).error).toBeUndefined();
    git(root, "add", SOURCE);

    expect(run(root, ["--check"]).error).toBeUndefined();
    const result = run(root, STAGED, hookEnv());
    expect(result.error).toMatch(/^ERR_AGENTS_DRIFT: .* in the index/);
    expect(result.actual).toBe(`differs: ${MIRROR}/a/SKILL.md`);
  });

  it("passes once both trees are staged, and reads only the index", () => {
    const root = gitRepo({ [`${SOURCE}/a/SKILL.md`]: "a", [`${MIRROR}/a/SKILL.md`]: "a" });
    git(root, "add", SOURCE, MIRROR);
    // An unstaged working-tree edit is not part of the commit.
    write(root, `${MIRROR}/a/SKILL.md`, "edited, unstaged");
    const result = run(root, STAGED, hookEnv());
    expect(result.error).toBeUndefined();
    expect(result.lines).toEqual([`agents:check: the staged ${MIRROR}/ is in sync.`]);
  });

  it("lists missing, differing, and extra staged paths, and ignores .DS_Store and bytecode", () => {
    const root = gitRepo({
      [`${SOURCE}/missing.md`]: "m",
      [`${SOURCE}/same.md`]: "s",
      [`${SOURCE}/changed.md`]: "new",
      [`${SOURCE}/sub/.DS_Store`]: "finder",
      [`${MIRROR}/same.md`]: "s",
      [`${MIRROR}/changed.md`]: "old",
      [`${MIRROR}/extra.md`]: "e",
      [`${MIRROR}/.DS_Store`]: "finder",
      [`${SOURCE}/sub/__pycache__/t.cpython-311.pyc`]: "bytecode",
      [`${MIRROR}/stray.pyc`]: "bytecode",
    });
    git(root, "add", "--force", SOURCE, MIRROR);
    const result = run(root, STAGED, hookEnv());
    expect(result.error).toMatch(/^ERR_AGENTS_DRIFT/);
    expect(result.actual).toBe(
      [
        `differs: ${MIRROR}/changed.md`,
        `missing: ${MIRROR}/missing.md`,
        `extra: ${MIRROR}/extra.md`,
      ].join("; "),
    );
  });

  it("judges the index GIT_INDEX_FILE names, and ignores an inherited GIT_DIR", () => {
    const root = gitRepo({ [`${SOURCE}/a.md`]: "old", [`${MIRROR}/a.md`]: "old" });
    git(root, "add", SOURCE, MIRROR);
    const alternate = join(root, ".git", "alternate-index");
    writeFileSync(alternate, readFileSync(join(root, ".git", "index")));
    write(root, `${SOURCE}/a.md`, "new");
    runCommand("git", ["add", SOURCE], {
      cwd: root,
      env: { ...gitEnv(process.env), GIT_INDEX_FILE: alternate },
    });
    const env = { ...hookEnv(), GIT_DIR: join(root, "nowhere") };
    expect(run(root, STAGED, env).error).toBeUndefined();
    expect(run(root, STAGED, { ...env, GIT_INDEX_FILE: alternate }).error).toMatch(
      /^ERR_AGENTS_DRIFT/,
    );
  });

  it("fails when an executable bit is staged on one side only", () => {
    const root = gitRepo({ [`${SOURCE}/run.sh`]: "echo\n", [`${MIRROR}/run.sh`]: "echo\n" });
    git(root, "add", SOURCE, MIRROR);
    expect(run(root, STAGED, hookEnv()).error).toBeUndefined();
    git(root, "update-index", "--chmod=+x", `${SOURCE}/run.sh`);
    const result = run(root, STAGED, hookEnv());
    expect(result.error).toMatch(/^ERR_AGENTS_DRIFT/);
    expect(result.actual).toBe(`differs: ${MIRROR}/run.sh`);
  });

  it("skips an intent-to-add entry, which the commit will not contain", () => {
    const root = gitRepo({
      [`${SOURCE}/a.md`]: "a",
      [`${MIRROR}/a.md`]: "a",
      [`${SOURCE}/draft.md`]: "not yet",
    });
    git(root, "add", `${SOURCE}/a.md`, MIRROR);
    git(root, "add", "--intent-to-add", `${SOURCE}/draft.md`);
    expect(git(root, "ls-files", "--", `${SOURCE}/draft.md`)).toBe(`${SOURCE}/draft.md\n`);
    expect(run(root, STAGED, hookEnv()).error).toBeUndefined();
    // Once really staged, the missing copy is drift again.
    git(root, "add", `${SOURCE}/draft.md`);
    expect(run(root, STAGED, hookEnv()).actual).toBe(`missing: ${MIRROR}/draft.md`);
  });

  it("refuses a staged symlink in either tree", () => {
    const root = gitRepo({ [`${SOURCE}/a.md`]: "a", [`${MIRROR}/a.md`]: "a" });
    symlinkSync("a.md", join(root, `${SOURCE}/link.md`));
    git(root, "add", SOURCE, MIRROR);
    expect(run(root, STAGED, hookEnv()).error).toMatch(
      /^ERR_AGENTS_SYMLINK: \.agents\/skills\/link\.md is a symlink/,
    );
  });

  it("refuses a mirror staged as a symlink or a file", () => {
    const linked = gitRepo({ [`${SOURCE}/a.md`]: "a" });
    mkdirSync(join(linked, ".claude"));
    symlinkSync("../.agents/skills", join(linked, MIRROR));
    git(linked, "add", SOURCE, MIRROR);
    expect(run(linked, STAGED, hookEnv()).error).toMatch(
      /^ERR_AGENTS_SYMLINK: \.claude\/skills is a symlink/,
    );

    const file = gitRepo({ [`${SOURCE}/a.md`]: "a", [MIRROR]: "file" });
    git(file, "add", SOURCE, MIRROR);
    expect(run(file, STAGED, hookEnv()).error).toMatch(/^ERR_AGENTS_MIRROR_NOT_DIRECTORY/);
  });

  it("refuses a source staged as a file, or nothing staged under it", () => {
    const file = gitRepo();
    rmSync(join(file, SOURCE), { recursive: true });
    write(file, SOURCE, "file");
    git(file, "add", SOURCE);
    expect(run(file, STAGED, hookEnv()).error).toMatch(/^ERR_AGENTS_SOURCE_MISSING/);

    const empty = gitRepo({ [`${MIRROR}/a.md`]: "a" });
    git(empty, "add", MIRROR);
    const result = run(empty, STAGED, hookEnv());
    expect(result.error).toMatch(/^ERR_AGENTS_SOURCE_NOT_STAGED/);
    expect(result.actual).toContain(`nothing staged under ${SOURCE}/`);
  });

  it("refuses to run outside a git work tree", () => {
    const root = repo({ [`${SOURCE}/a.md`]: "a" });
    const notARepo: Run = () => ({ status: 128, stdout: "", stderr: "not a git repository" });
    expect(run(root, STAGED, {}, notARepo).error).toMatch(/^ERR_AGENTS_NOT_A_REPO/);
  });

  it("fails when the index cannot be listed", () => {
    const failing: Run = (_command, args) =>
      args[0] === "rev-parse"
        ? { status: 0, stdout: "true\n", stderr: "" }
        : { status: 128, stdout: "", stderr: "fatal: index file corrupt" };
    const result = run(repo(), STAGED, {}, failing);
    expect(result.error).toMatch(/^ERR_AGENTS_INDEX_UNREADABLE/);
    expect(result.actual).toBe("fatal: index file corrupt");
  });

  it("skips the unmerged stages of a conflicted path", () => {
    const blob = "0123456789abcdef0123456789abcdef01234567";
    const listing = [
      `100644 ${blob} 0\t${SOURCE}/a.md`,
      `100644 ${blob} 0\t${MIRROR}/a.md`,
      `100644 ${blob} 1\t${SOURCE}/b.md`,
      `100644 ${blob} 2\t${SOURCE}/b.md`,
      "",
    ].join("\0");
    const answers: Record<string, string> = { "rev-parse": "true\n", "ls-files": listing };
    const fake: Run = (_command, args) => ({
      status: 0,
      stdout: answers[args[0] ?? ""] ?? "",
      stderr: "",
    });
    expect(run(repo(), STAGED, {}, fake).error).toBeUndefined();
  });

  it("refuses --staged without --check", () => {
    const result = run(repo(), ["--staged"]);
    expect(result.error).toMatch(/^ERR_AGENTS_USAGE: --staged only works with --check/);
  });
});
