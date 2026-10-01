/**
 * pnpm-pin against a temp root holding the passing files below: mise.toml pins
 * aqua:pnpm/pnpm 12.6.0 and package.json's packageManager names pnpm@12.6.0. Each
 * failing case changes one input. The files are written at run time, not committed
 * under fixtures/, so neither mise nor GitHub's dependency graph reads them as the
 * repository's own.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FailureDetails } from "../lib/fail.ts";
import type { ScriptContext } from "../lib/script.ts";
import { check, main } from "./pnpm-pin.ts";

const MISE = `# Pinned CLI tool versions.
[tools]
node = "26.10.0"
"aqua:pnpm/pnpm" = "12.6.0"
just = "1.58.0"
`;

const PACKAGE = `{
  "name": "fixture",
  "packageManager": "pnpm@12.6.0"
}
`;

const PIN = '"aqua:pnpm/pnpm" = "12.6.0"';
const MANAGER = '"packageManager": "pnpm@12.6.0"';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyPass(): string {
  const dir = mkdtempSync(join(tmpdir(), "pnpm-pin-"));
  dirs.push(dir);
  writeFileSync(join(dir, "mise.toml"), MISE);
  writeFileSync(join(dir, "package.json"), PACKAGE);
  return dir;
}

function editFile(root: string, path: string, from: string, to: string): void {
  const full = join(root, path);
  const before = readFileSync(full, "utf8");
  if (!before.includes(from)) throw new Error(`${path} has no ${from}`);
  writeFileSync(full, before.replace(from, to));
}

const codes = (violations: readonly FailureDetails[]): string[] => violations.map((v) => v.code);

function context(root: string, lines: string[]): ScriptContext {
  return {
    argv: ["--root", root],
    env: {},
    root,
    run: () => {
      throw new Error("pnpm-pin spawns nothing");
    },
    log: (line) => lines.push(line),
  };
}

describe("pnpm-pin", () => {
  it("passes when mise.toml and packageManager name the same pnpm", () => {
    expect(check.run(copyPass())).toEqual([]);
  });

  it.each([
    ["the bare tool name", 'pnpm = "12.6.0"'],
    ["the table form", '"aqua:pnpm/pnpm" = { version = "12.6.0" }'],
  ])("passes with %s in mise.toml", (_, pin) => {
    const root = copyPass();
    editFile(root, "mise.toml", PIN, pin);
    expect(check.run(root)).toEqual([]);
  });

  it("passes when packageManager carries a hash suffix", () => {
    const root = copyPass();
    editFile(root, "package.json", MANAGER, '"packageManager": "pnpm@12.6.0+sha512.abc"');
    expect(check.run(root)).toEqual([]);
  });

  describe("versions differ", () => {
    it("fails when mise.toml's pnpm moves alone", () => {
      const root = copyPass();
      editFile(root, "mise.toml", PIN, '"aqua:pnpm/pnpm" = "12.7.0"');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_PNPM_PIN_DIVERGED"]);
      expect(violations[0]?.actual).toBe("mise.toml pnpm 12.7.0; package.json pnpm@12.6.0");
    });

    it("fails when packageManager moves alone", () => {
      const root = copyPass();
      editFile(root, "package.json", MANAGER, '"packageManager": "pnpm@12.5.1"');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_PNPM_PIN_DIVERGED"]);
      expect(violations[0]?.summary).toBe(
        "mise.toml installs pnpm 12.6.0, but package.json's packageManager names 12.5.1",
      );
    });
  });

  describe("missing entries", () => {
    it("fails when mise.toml pins no pnpm", () => {
      const root = copyPass();
      editFile(root, "mise.toml", `${PIN}\n`, "");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_PNPM_PIN_MISSING"]);
      expect(violations[0]?.summary).toBe("pnpm in mise.toml's [tools] is not pinned");
    });

    it("fails when mise.toml has no [tools] table", () => {
      const root = copyPass();
      writeFileSync(join(root, "mise.toml"), 'min_version = "2026.1.0"\n');
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_PNPM_PIN_MISSING"]);
    });

    it("fails when package.json has no packageManager", () => {
      const root = copyPass();
      writeFileSync(join(root, "package.json"), '{ "name": "fixture" }\n');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_PNPM_PIN_MISSING"]);
      expect(violations[0]?.summary).toBe("packageManager in package.json is not pinned");
    });

    it.each([["mise.toml"], ["package.json"]])("fails when %s does not exist", (path) => {
      const root = copyPass();
      rmSync(join(root, path));
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_INPUT_MISSING"]);
      expect(violations[0]?.summary).toBe(`${path} does not exist`);
    });
  });

  describe("unparsable input", () => {
    it("fails when mise.toml is not TOML", () => {
      const root = copyPass();
      writeFileSync(join(root, "mise.toml"), "[tools]\npnpm = = 12\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_PNPM_PIN_UNPARSED"]);
      expect(violations[0]?.summary).toBe("mise.toml could not be parsed");
    });

    it("fails when package.json is not JSON", () => {
      const root = copyPass();
      writeFileSync(join(root, "package.json"), "{ nope\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_PNPM_PIN_UNPARSED"]);
      expect(violations[0]?.summary).toBe("package.json could not be parsed");
    });

    it("reports both files when neither parses", () => {
      const root = copyPass();
      writeFileSync(join(root, "mise.toml"), "pnpm = = 12\n");
      writeFileSync(join(root, "package.json"), "[\n");
      expect(codes(check.run(root))).toEqual([
        "ERR_CHECK_PNPM_PIN_UNPARSED",
        "ERR_CHECK_PNPM_PIN_UNPARSED",
      ]);
    });

    it.each([
      ["a number", '"aqua:pnpm/pnpm" = 12'],
      ["latest", '"aqua:pnpm/pnpm" = "latest"'],
      ["a range", '"aqua:pnpm/pnpm" = "12"'],
      ["a table without a version", '"aqua:pnpm/pnpm" = { os = ["macos"] }'],
    ])("fails when mise.toml's pnpm pin is %s", (_, pin) => {
      const root = copyPass();
      editFile(root, "mise.toml", PIN, pin);
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_PNPM_PIN_UNPARSED"]);
      expect(violations[0]?.summary).toBe("mise.toml's pnpm pin is not an exact version");
    });

    it.each([
      ["another manager", '"packageManager": "yarn@4.9.0"'],
      ["a range", '"packageManager": "pnpm@12"'],
      ["not a string", '"packageManager": 12'],
    ])("fails when packageManager is %s", (_, field) => {
      const root = copyPass();
      editFile(root, "package.json", MANAGER, field);
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_PNPM_PIN_UNPARSED"]);
      expect(violations[0]?.summary).toBe(
        "package.json's packageManager is not `pnpm@<exact version>`",
      );
    });
  });

  describe("main", () => {
    it("logs ok for a passing root", () => {
      const lines: string[] = [];
      main(context(copyPass(), lines));
      expect(lines).toEqual(["check pnpm-pin: ok"]);
    });

    it("throws the first violation's code for a failing root", () => {
      const root = copyPass();
      editFile(root, "mise.toml", PIN, '"aqua:pnpm/pnpm" = "12.7.0"');
      expect(() => {
        main(context(root, []));
      }).toThrow(
        "mise.toml installs pnpm 12.7.0, but package.json's packageManager names 12.6.0 (1 of 1)",
      );
    });
  });
});
