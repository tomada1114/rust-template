/**
 * node-types-major against a temp root holding the passing files below: mise.toml pins
 * node 24.21.0, and a two-document pnpm-lock.yaml like pnpm 12 writes resolves
 * @types/node 24.13.6 in the root importer. Each failing case changes one input. The
 * files are written at run time, not committed under fixtures/, so neither mise nor
 * GitHub's dependency graph ever reads them as the repository's own.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FailureDetails } from "../lib/fail.ts";
import type { ScriptContext } from "../lib/script.ts";
import { check, main } from "./node-types-major.ts";

const MISE = `# Pinned CLI tool versions.
[tools]
node = "24.21.0"
just = "1.58.0"
`;

const PNPM_LOCK = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.6.0
        version: 12.6.0

packages: {}

---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      react:
        specifier: ^19.3.0
        version: 19.3.0
    devDependencies:
      '@types/node':
        specifier: ^24.13.6
        version: 24.13.6
      vite:
        specifier: ^8.3.0
        version: 8.3.0(@types/node@24.13.6)(yaml@2.9.1)

packages:

  '@types/node@24.13.6':
    resolution: {integrity: sha512-AAAA}
`;

const TYPES_VERSION = "        version: 24.13.6\n";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyPass(): string {
  const dir = mkdtempSync(join(tmpdir(), "node-types-major-"));
  dirs.push(dir);
  writeFileSync(join(dir, "mise.toml"), MISE);
  writeFileSync(join(dir, "pnpm-lock.yaml"), PNPM_LOCK);
  return dir;
}

function editFile(root: string, path: string, from: string, to: string): void {
  const full = join(root, path);
  const before = readFileSync(full, "utf8");
  if (!before.includes(from)) throw new Error(`${path} has no ${from}`);
  writeFileSync(full, before.replace(from, to));
}

const codes = (violations: readonly FailureDetails[]): string[] => violations.map((v) => v.code);
const text = (violations: readonly FailureDetails[]): string =>
  violations.map((v) => [v.summary, v.expected, v.actual, v.next].join("\n")).join("\n\n");

function context(root: string, lines: string[]): ScriptContext {
  return {
    argv: ["--root", root],
    env: {},
    root,
    run: () => {
      throw new Error("node-types-major spawns nothing");
    },
    log: (line) => lines.push(line),
  };
}

describe("node-types-major", () => {
  it("passes when @types/node is on mise's Node major", () => {
    expect(check.run(copyPass())).toEqual([]);
  });

  it("passes when node is pinned in mise's table form and @types/node is optional", () => {
    const root = copyPass();
    editFile(root, "mise.toml", 'node = "24.21.0"', 'node = { version = "24.21.0" }');
    editFile(root, "pnpm-lock.yaml", "    devDependencies:\n", "    optionalDependencies:\n");
    expect(check.run(root)).toEqual([]);
  });

  describe("majors differ", () => {
    it("fails when @types/node moves to the next major alone", () => {
      const root = copyPass();
      editFile(root, "pnpm-lock.yaml", TYPES_VERSION, "        version: 26.6.2\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_DIVERGED"]);
      expect(violations[0]?.actual).toBe(
        "mise.toml node 24.21.0; pnpm-lock.yaml @types/node 26.6.2",
      );
      expect(text(violations)).toContain("pnpm add -D @types/node@^24");
    });

    it("fails when mise.toml's node moves to the next major alone", () => {
      const root = copyPass();
      editFile(root, "mise.toml", 'node = "24.21.0"', 'node = "26.1.0"');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_DIVERGED"]);
      expect(violations[0]?.summary).toBe("@types/node is on major 24, but mise.toml runs Node 26");
    });

    it("compares the major only, after dropping a peer suffix", () => {
      const root = copyPass();
      editFile(
        root,
        "pnpm-lock.yaml",
        TYPES_VERSION,
        "        version: 24.0.1(typescript@6.0.2)\n",
      );
      expect(check.run(root)).toEqual([]);
    });
  });

  describe("missing entries", () => {
    it("fails when the lockfile's root importer has no @types/node", () => {
      const root = copyPass();
      editFile(root, "pnpm-lock.yaml", "      '@types/node':\n", "      '@types/other':\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_MISSING"]);
      expect(violations[0]?.summary).toBe(
        "@types/node in pnpm-lock.yaml's root importer is not pinned",
      );
    });

    it("fails when the lockfile has no root importer", () => {
      const root = copyPass();
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_NODE_MAJOR_MISSING"]);
    });

    it("fails when mise.toml pins no node", () => {
      const root = copyPass();
      editFile(root, "mise.toml", 'node = "24.21.0"\n', "");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_MISSING"]);
      expect(violations[0]?.summary).toBe("node in mise.toml's [tools] is not pinned");
    });

    it("fails when mise.toml has no [tools] table", () => {
      const root = copyPass();
      writeFileSync(join(root, "mise.toml"), 'min_version = "2026.1.0"\n');
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_NODE_MAJOR_MISSING"]);
    });

    it.each([["mise.toml"], ["pnpm-lock.yaml"]])("fails when %s does not exist", (path) => {
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
      writeFileSync(join(root, "mise.toml"), "[tools]\nnode = = 24\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_UNPARSED"]);
      expect(violations[0]?.summary).toBe("mise.toml could not be parsed");
    });

    it("fails when pnpm-lock.yaml is not YAML", () => {
      const root = copyPass();
      writeFileSync(join(root, "pnpm-lock.yaml"), "importers: [\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_UNPARSED"]);
      expect(violations[0]?.summary).toBe("pnpm-lock.yaml could not be parsed");
    });

    it("reports both files when neither parses", () => {
      const root = copyPass();
      writeFileSync(join(root, "mise.toml"), "node = = 24\n");
      writeFileSync(join(root, "pnpm-lock.yaml"), "importers: [\n");
      expect(codes(check.run(root))).toEqual([
        "ERR_CHECK_NODE_MAJOR_UNPARSED",
        "ERR_CHECK_NODE_MAJOR_UNPARSED",
      ]);
    });

    it.each([
      ["a number", "node = 24"],
      ["a list", 'node = ["24.21.0"]'],
      ["a table without a version", 'node = { postinstall = "true" }'],
    ])("fails when mise.toml's node pin is %s", (_, pin) => {
      const root = copyPass();
      editFile(root, "mise.toml", 'node = "24.21.0"', pin);
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_UNPARSED"]);
      expect(violations[0]?.summary).toBe("mise.toml's node pin is not a version string");
    });

    it.each([["lts"], ["latest"]])("fails when mise.toml's node pin is %s", (pin) => {
      const root = copyPass();
      editFile(root, "mise.toml", 'node = "24.21.0"', `node = "${pin}"`);
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_UNPARSED"]);
      expect(violations[0]?.summary).toBe(
        `mise.toml's node pin \`${pin}\` is not a version number`,
      );
    });

    it("fails when @types/node resolves to something other than a release", () => {
      const root = copyPass();
      editFile(root, "pnpm-lock.yaml", TYPES_VERSION, "        version: link:../types-node\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_UNPARSED"]);
      expect(text(violations)).toContain("link:../types-node");
    });

    it("fails when the @types/node entry has no version", () => {
      const root = copyPass();
      editFile(root, "pnpm-lock.yaml", TYPES_VERSION, "");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_NODE_MAJOR_UNPARSED"]);
      expect(violations[0]?.summary).toBe(
        "pnpm-lock.yaml's @types/node entry has no version string",
      );
    });
  });

  describe("main", () => {
    it("logs ok for a passing root", () => {
      const lines: string[] = [];
      main(context(copyPass(), lines));
      expect(lines).toEqual(["check node-types-major: ok"]);
    });

    it("throws the first violation's code for a failing root", () => {
      const root = copyPass();
      editFile(root, "mise.toml", 'node = "24.21.0"', 'node = "26.1.0"');
      expect(() => {
        main(context(root, []));
      }).toThrow("@types/node is on major 24, but mise.toml runs Node 26 (1 of 1)");
    });
  });
});
