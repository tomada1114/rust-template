import {
  existsSync,
  lstatSync,
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

import { runCommand, type ScriptContext } from "./lib/script.ts";
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
): { error: string | undefined; actual: string | undefined; lines: string[] } {
  const lines: string[] = [];
  const context: ScriptContext = {
    argv,
    env: {},
    root,
    run: runCommand,
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
