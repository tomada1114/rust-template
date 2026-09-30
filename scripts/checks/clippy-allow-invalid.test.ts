import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, configFiles, EXCEPTIONS, main, scan } from "./clippy-allow-invalid.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CORE = "crates/core/clippy.toml";

const ROOT_CONFIG = "allow-unwrap-in-tests = true\nallow-expect-in-tests = true\n";

const coreConfig = (extra = ""): string => `allow-unwrap-in-tests = true
disallowed-methods = [
  { path = "std::time::SystemTime::now", reason = "inject time through the Clock port" },
  { path = "std::env::var", reason = "configuration reaches core as arguments"${extra} },
]
`;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "clippy-allow-invalid-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const codes = (root: string): string[] => check.run(root).map((v) => v.code);

describe("clippy-allow-invalid", () => {
  it("passes when no clippy.toml sets allow-invalid", () => {
    expect(check.run(fixture({ "clippy.toml": ROOT_CONFIG, [CORE]: coreConfig() }))).toEqual([]);
  });

  it("passes when there is no clippy.toml at all", () => {
    expect(check.run(fixture({ "README.md": "# app\n" }))).toEqual([]);
  });

  it("fails when a ban entry sets allow-invalid = true, naming the file and the ban", () => {
    const root = fixture({
      "clippy.toml": ROOT_CONFIG,
      [CORE]: coreConfig(", allow-invalid = true"),
    });
    const [violation, ...rest] = check.run(root);
    expect(rest).toEqual([]);
    expect(violation?.code).toBe("ERR_CHECK_CLIPPY_ALLOW_INVALID");
    expect(violation?.summary).toBe(
      "crates/core/clippy.toml sets disallowed-methods[1].allow-invalid on the ban of std::env::var",
    );
    expect(violation?.actual).toBe("crates/core/clippy.toml: disallowed-methods[1].allow-invalid");
  });

  it.each([
    ["allow-invalid = false", ", allow-invalid = false"],
    ["the underscore spelling", ", allow_invalid = true"],
  ])("refuses %s too", (_label, extra) => {
    expect(codes(fixture({ [CORE]: coreConfig(extra) }))).toEqual([
      "ERR_CHECK_CLIPPY_ALLOW_INVALID",
    ]);
  });

  it("finds the key in a .clippy.toml, at the top level, and in a nested table", () => {
    const root = fixture({
      ".clippy.toml": "allow-invalid = true\n",
      "src-tauri/clippy.toml": "[extra.deeper]\nallow-invalid = true\n",
      "crates/cli/clippy.toml": "disallowed-types = [{ path = 1, allow-invalid = true }]\n",
    });
    expect(check.run(root).map((v) => v.summary)).toEqual([
      ".clippy.toml sets allow-invalid",
      "crates/cli/clippy.toml sets disallowed-types[0].allow-invalid",
      "src-tauri/clippy.toml sets extra.deeper.allow-invalid",
    ]);
  });

  it("skips .git, node_modules, target, and another checkout inside the tree", () => {
    const bad = "allow-invalid = true\n";
    const root = fixture({
      "clippy.toml": ROOT_CONFIG,
      ".git/clippy.toml": bad,
      "node_modules/some-crate/clippy.toml": bad,
      "target/package/clippy.toml": bad,
      ".claude/worktrees/issue-1/.git": "gitdir: /elsewhere\n",
      ".claude/worktrees/issue-1/clippy.toml": bad,
    });
    expect(configFiles(root)).toEqual(["clippy.toml"]);
    expect(check.run(root)).toEqual([]);
  });

  it("fails with ERR_CHECK_CLIPPY_UNREADABLE when a clippy.toml does not parse", () => {
    expect(codes(fixture({ [CORE]: "disallowed-methods = [\n" }))).toEqual([
      "ERR_CHECK_CLIPPY_UNREADABLE",
    ]);
  });

  it("lets an exception through and reports one that no longer applies", () => {
    const root = fixture({ [CORE]: coreConfig(", allow-invalid = true") });
    const exception = { [`${CORE} std::env::var`]: "exists on one target only" };
    expect(scan(root, exception)).toEqual([]);

    const stale = scan(fixture({ [CORE]: coreConfig() }), exception);
    expect(stale.map((v) => [v.code, v.summary])).toEqual([
      [
        "ERR_CHECK_CLIPPY_EXCEPTION_STALE",
        "the exception for crates/core/clippy.toml std::env::var no longer applies",
      ],
    ]);
  });

  it("never excepts a key outside a ban entry", () => {
    const root = fixture({ "clippy.toml": "allow-invalid = true\n" });
    expect(scan(root, {}).map((v) => v.code)).toEqual(["ERR_CHECK_CLIPPY_ALLOW_INVALID"]);
  });

  it("ships with no exceptions", () => {
    expect(EXCEPTIONS).toEqual({});
  });

  it("passes on the repository's own files", () => {
    expect(check.run(join(import.meta.dirname, "..", ".."))).toEqual([]);
  });

  const context = (root: string, lines: string[]): ScriptContext => ({
    argv: ["--root", root],
    env: {},
    root: "/nowhere",
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    log: (line) => lines.push(line),
  });

  it("runs as a script and logs a pass", () => {
    const lines: string[] = [];
    main(context(fixture({ [CORE]: coreConfig() }), lines));
    expect(lines).toEqual(["check clippy-allow-invalid: ok"]);
  });

  it("runs as a script and fails with the violation's code", () => {
    const root = fixture({ [CORE]: coreConfig(", allow-invalid = true") });
    expect(() => {
      main(context(root, []));
    }).toThrow(/^ERR_CHECK_CLIPPY_ALLOW_INVALID: /);
  });
});
