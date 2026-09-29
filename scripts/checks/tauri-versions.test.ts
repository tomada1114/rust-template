/**
 * tauri-versions against a temp root holding the passing lockfiles below: tauri
 * 2.11.6, @tauri-apps/api 2.11.1, @tauri-apps/cli 2.11.5, and tauri-plugin-log with
 * @tauri-apps/plugin-log at 2.10.0, in a two-document pnpm-lock.yaml like pnpm 12
 * writes. Each failing case changes one version. The lockfiles are written at run time,
 * not committed under fixtures/, so GitHub's dependency graph never reads them as the
 * repository's own.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FailureDetails } from "../lib/fail.ts";
import { check } from "./tauri-versions.ts";

const CARGO_LOCK = `version = 4

[[package]]
name = "myapp"
version = "0.1.0"
dependencies = [
 "tauri",
 "tauri-plugin-log",
]

[[package]]
name = "tauri"
version = "2.11.6"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tauri-build"
version = "2.6.3"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tauri-plugin-log"
version = "2.10.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
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

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@tauri-apps/api':
        specifier: ~2.11.1
        version: 2.11.1
      '@tauri-apps/plugin-log':
        specifier: ~2.10.0
        version: 2.10.0(@tauri-apps/api@2.11.1)
      react:
        specifier: ^19.3.0
        version: 19.3.0
    devDependencies:
      '@tauri-apps/cli':
        specifier: ~2.11.5
        version: 2.11.5

packages:

  '@tauri-apps/api@2.11.1':
    resolution: {integrity: sha512-AAAA}
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyPass(): string {
  const dir = mkdtempSync(join(tmpdir(), "tauri-versions-"));
  dirs.push(dir);
  writeFileSync(join(dir, "Cargo.lock"), CARGO_LOCK);
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

const TAURI_LOCK = 'name = "tauri"\nversion = "2.11.6"';

describe("tauri-versions", () => {
  it("passes when tauri and @tauri-apps/* share a minor and plugins match exactly", () => {
    expect(check.run(copyPass())).toEqual([]);
  });

  describe("tauri, @tauri-apps/api, and @tauri-apps/cli", () => {
    it("fails when @tauri-apps/api moves to another minor", () => {
      const root = copyPass();
      editFile(root, "pnpm-lock.yaml", "version: 2.11.1\n", "version: 2.12.0\n");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_TAURI_VERSIONS_DIVERGED"]);
      expect(text(violations)).toContain("@tauri-apps/api 2.12.0");
    });

    it("fails when @tauri-apps/cli is on another major", () => {
      const root = copyPass();
      editFile(root, "pnpm-lock.yaml", "version: 2.11.5", "version: 3.0.0-alpha.3");
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_TAURI_VERSIONS_DIVERGED"]);
    });

    it("fails when the tauri crate moves alone", () => {
      const root = copyPass();
      editFile(root, "Cargo.lock", TAURI_LOCK, 'name = "tauri"\nversion = "2.12.0"');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_TAURI_VERSIONS_DIVERGED"]);
      expect(text(violations)).toContain("tauri 2.12.0");
    });

    it("fails when Cargo.lock holds a second tauri on another minor", () => {
      const root = copyPass();
      editFile(
        root,
        "Cargo.lock",
        TAURI_LOCK,
        `${TAURI_LOCK}\n\n[[package]]\nname = "tauri"\nversion = "2.12.0"`,
      );
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_TAURI_VERSIONS_DIVERGED"]);
    });

    it("fails when the tauri crate is not locked", () => {
      const root = copyPass();
      editFile(root, "Cargo.lock", 'name = "tauri"\n', 'name = "tauri-other"\n');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_TAURI_VERSIONS_MISSING"]);
      expect(text(violations)).toContain("Cargo.lock");
    });

    it("fails when @tauri-apps/cli is not a root dependency", () => {
      const root = copyPass();
      editFile(root, "pnpm-lock.yaml", "'@tauri-apps/cli':", "'@tauri-apps/other':");
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_TAURI_VERSIONS_MISSING"]);
      expect(text(violations)).toContain("@tauri-apps/cli");
    });

    it("fails on a resolved version that is not a release number", () => {
      const root = copyPass();
      editFile(root, "pnpm-lock.yaml", "version: 2.11.1\n", "version: link:../api\n");
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_TAURI_VERSIONS_UNPARSED"]);
    });
  });

  describe("plugins", () => {
    it("fails when a plugin crate and its npm package differ by a patch", () => {
      const root = copyPass();
      editFile(root, "Cargo.lock", 'version = "2.10.0"', 'version = "2.10.1"');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_TAURI_PLUGIN_VERSIONS_DIVERGED"]);
      expect(text(violations)).toContain("tauri-plugin-log 2.10.1");
    });

    it("fails when an npm plugin has no crate", () => {
      const root = copyPass();
      editFile(root, "Cargo.lock", 'name = "tauri-plugin-log"', 'name = "tauri-plugin-other"');
      const violations = check.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_TAURI_PLUGIN_VERSIONS_DIVERGED"]);
      expect(text(violations)).toContain("@tauri-apps/plugin-log");
    });

    it("allows a plugin crate with no JavaScript package", () => {
      const root = copyPass();
      editFile(root, "pnpm-lock.yaml", "'@tauri-apps/plugin-log':", "'@other/plugin-log':");
      expect(check.run(root)).toEqual([]);
    });
  });

  describe("inputs", () => {
    it.each([["Cargo.lock"], ["pnpm-lock.yaml"]])("fails when %s is missing", (path) => {
      const root = copyPass();
      rmSync(join(root, path));
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_INPUT_MISSING"]);
    });

    it("fails when Cargo.lock is not TOML", () => {
      const root = copyPass();
      writeFileSync(join(root, "Cargo.lock"), "version = = 4\n");
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_TAURI_VERSIONS_UNPARSED"]);
    });

    it("fails when pnpm-lock.yaml is not YAML", () => {
      const root = copyPass();
      writeFileSync(join(root, "pnpm-lock.yaml"), "importers: [\n");
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_TAURI_VERSIONS_UNPARSED"]);
    });

    it("fails when pnpm-lock.yaml has no root importer", () => {
      const root = copyPass();
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      expect(codes(check.run(root))).toEqual(["ERR_CHECK_TAURI_VERSIONS_UNPARSED"]);
    });
  });
});
