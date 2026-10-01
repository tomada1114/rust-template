import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError } from "./lib/fail.ts";
import type { ScriptContext } from "./lib/script.ts";
import { claudeSlug, main, SESSION_IDLE_MS } from "./prune-temp.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 8, 30);
const OLD = new Date(NOW - SESSION_IDLE_MS - 60_000);
const FRESH = new Date(NOW - 60_000);
const CHECKOUT = "/Users/someone/ghq/github.com/me/my_app.v2";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "prune-temp-test-"));
  dirs.push(dir);
  return dir;
}

/** A tree of temp dir + Claude base, every mtime set to `OLD`. */
function fixture(): { temp: string; base: string; project: string } {
  const root = scratch();
  const temp = join(root, "tmp");
  const base = join(root, "claude-501");
  const project = join(base, claudeSlug(CHECKOUT));
  mkdirSync(temp, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { temp, base, project };
}

function session(project: string, id: string, mtime: Date): string {
  const dir = join(project, id);
  mkdirSync(join(dir, "scratchpad", "nested"), { recursive: true });
  writeFileSync(join(dir, "scratchpad", "nested", "file.txt"), "x");
  for (const path of [
    join(dir, "scratchpad", "nested", "file.txt"),
    join(dir, "scratchpad", "nested"),
    join(dir, "scratchpad"),
    dir,
  ]) {
    utimesSync(path, OLD, OLD);
  }
  if (mtime !== OLD) {
    writeFileSync(join(dir, "transcript.log"), "live");
    utimesSync(join(dir, "transcript.log"), mtime, mtime);
  }
  return join(dir, "scratchpad");
}

function context(argv: readonly string[], env: Record<string, string> = {}) {
  const lines: string[] = [];
  const ctx: ScriptContext = {
    argv,
    env,
    root: CHECKOUT,
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    log: (line) => {
      lines.push(line);
    },
  };
  return { ctx, lines };
}

function args(temp: string, base: string, ...extra: string[]): string[] {
  return ["--temp-dir", temp, "--claude-base", base, "--now", String(NOW), ...extra];
}

function failure(fn: () => void): string {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error.details.code;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

describe("claudeSlug", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(claudeSlug("/Users/masuyama/.claude")).toBe("-Users-masuyama--claude");
    expect(claudeSlug(CHECKOUT)).toBe("-Users-someone-ghq-github-com-me-my-app-v2");
  });
});

describe("prune-temp", () => {
  it("removes verify-bootstrap dirs and idle scratchpads, keeping everything else", () => {
    const { temp, base, project } = fixture();
    mkdirSync(join(temp, "verify-bootstrap-abc"));
    mkdirSync(join(temp, "verify-bootstrap-product-def"));
    mkdirSync(join(temp, "other-dir"));
    writeFileSync(join(temp, "verify-bootstrap-file"), "not a dir");
    const idle = session(project, "s1", OLD);
    const live = session(project, "s2", FRESH);
    mkdirSync(join(project, "s3"));
    writeFileSync(join(project, "stray.json"), "{}");
    const otherProject = join(base, "-Users-someone-else");
    mkdirSync(join(otherProject, "s9", "scratchpad"), { recursive: true });

    const { ctx, lines } = context(args(temp, base));
    main(ctx);

    expect(lines).toEqual([
      `removed ${join(temp, "verify-bootstrap-abc")}`,
      `removed ${join(temp, "verify-bootstrap-product-def")}`,
      `removed ${idle}`,
    ]);
    expect(existsSync(join(temp, "verify-bootstrap-abc"))).toBe(false);
    expect(existsSync(idle)).toBe(false);
    expect(existsSync(join(project, "s1"))).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(join(temp, "other-dir"))).toBe(true);
    expect(existsSync(join(temp, "verify-bootstrap-file"))).toBe(true);
    expect(existsSync(join(otherProject, "s9", "scratchpad"))).toBe(true);
  });

  it("only prints with --dry-run", () => {
    const { temp, base, project } = fixture();
    mkdirSync(join(temp, "verify-bootstrap-abc"));
    const idle = session(project, "s1", OLD);

    const { ctx, lines } = context(args(temp, base, "--dry-run"));
    main(ctx);

    expect(lines).toEqual([
      `would remove ${join(temp, "verify-bootstrap-abc")}`,
      `would remove ${idle}`,
    ]);
    expect(existsSync(join(temp, "verify-bootstrap-abc"))).toBe(true);
    expect(existsSync(idle)).toBe(true);
  });

  it("says nothing to prune when there is nothing, including missing directories", () => {
    const root = scratch();
    const { ctx, lines } = context(args(join(root, "nope"), join(root, "nobase")));
    main(ctx);
    expect(lines).toEqual(["prune-temp: nothing to prune"]);
  });

  it("reads the temp dir from TMPDIR when --temp-dir is absent", () => {
    const { temp, base } = fixture();
    mkdirSync(join(temp, "verify-bootstrap-x"));
    const { ctx, lines } = context(["--claude-base", base, "--now", String(NOW), "--dry-run"], {
      TMPDIR: `${temp}/`,
    });
    main(ctx);
    expect(lines).toEqual([`would remove ${join(temp, "verify-bootstrap-x")}`]);
  });

  it("refuses a matching symlink that points out of the temp dir", () => {
    const { temp, base } = fixture();
    const outside = scratch();
    symlinkSync(outside, join(temp, "verify-bootstrap-evil"));
    const { ctx } = context(args(temp, base));
    expect(
      failure(() => {
        main(ctx);
      }),
    ).toBe("ERR_PRUNE_ESCAPES_PARENT");
    expect(existsSync(outside)).toBe(true);
  });

  it("refuses a scratchpad that is a symlink out of its session", () => {
    const { temp, base, project } = fixture();
    const outside = scratch();
    mkdirSync(join(project, "s1"));
    symlinkSync(outside, join(project, "s1", "scratchpad"));
    utimesSync(join(project, "s1"), OLD, OLD);
    const { ctx } = context(args(temp, base));
    expect(
      failure(() => {
        main(ctx);
      }),
    ).toBe("ERR_PRUNE_ESCAPES_PARENT");
    expect(existsSync(outside)).toBe(true);
  });

  it("reports a removal that fails", () => {
    const { temp, base } = fixture();
    const locked = join(temp, "verify-bootstrap-locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    writeFileSync(join(locked, "inner", "f"), "x");
    chmodSync(join(locked, "inner"), 0o500);
    try {
      const { ctx } = context(args(temp, base));
      expect(
        failure(() => {
          main(ctx);
        }),
      ).toBe("ERR_PRUNE_REMOVE_FAILED");
    } finally {
      chmodSync(join(locked, "inner"), 0o700);
    }
  });

  it.each([["--bogus"], ["--now"], ["--now", "soon"], ["--temp-dir"]])(
    "rejects the arguments %j",
    (...argv: string[]) => {
      const { ctx } = context(argv);
      expect(
        failure(() => {
          main(ctx);
        }),
      ).toBe("ERR_PRUNE_USAGE");
    },
  );
});
