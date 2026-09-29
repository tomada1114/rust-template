/**
 * version-sites against temp roots holding the three version sites below (design D18),
 * which agree on 1.2.3. The files are written at run time rather than committed under
 * fixtures/, so no tool that discovers a `Cargo.toml`, a `package.json`, or a
 * `tauri.conf.json` in the tree ever finds a fixture's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FailureDetails } from "../lib/fail.ts";
import { check } from "./version-sites.ts";

const CARGO = "Cargo.toml";
const CONF = "src-tauri/tauri.conf.json";
const PACKAGE = "package.json";

const PASSING: Readonly<Record<string, string>> = {
  [CARGO]: [
    "[workspace]",
    'members = ["crates/*"]',
    "",
    "[workspace.package]",
    'version = "1.2.3" # one of the three version sites',
    'edition = "2024"',
    "",
    "[workspace.dependencies]",
    'serde = { version = "1" }',
    "",
  ].join("\n"),
  [CONF]: '{\n  "productName": "MyApp",\n  "version": "1.2.3"\n}\n',
  [PACKAGE]: '{\n  "name": "myapp",\n  "version": "1.2.3",\n  "private": true\n}\n',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rootWith(changes: Readonly<Record<string, string | undefined>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "version-sites-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries({ ...PASSING, ...changes })) {
    if (text === undefined) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const codes = (violations: readonly FailureDetails[]): string[] => violations.map((v) => v.code);
const replaced = (path: string, from: string, to: string): Record<string, string> => ({
  [path]: (PASSING[path] ?? "").replace(from, to),
});

describe("version-sites", () => {
  it("passes when the three sites hold one version", () => {
    expect(check.run(rootWith())).toEqual([]);
  });

  it.each([
    [CARGO, 'version = "1.2.3"', 'version = "1.2.4"'],
    [CONF, '"version": "1.2.3"', '"version": "1.3.0"'],
    [PACKAGE, '"version": "1.2.3"', '"version": "2.0.0"'],
  ])("fails when %s holds another version", (path, from, to) => {
    const violations = check.run(rootWith(replaced(path, from, to)));
    expect(codes(violations)).toEqual(["ERR_CHECK_VERSION_DIVERGED"]);
    expect(violations[0]?.actual).toContain(`${path}: ${/"([\d.]+)"/.exec(to)?.[1] ?? ""}`);
  });

  it.each([
    [CARGO, "[workspace]\nmembers = []\n"],
    [CARGO, "[workspace.package]\nversion = 1\n"],
    [CARGO, "version = = 1\n"],
    [CONF, "{}"],
    [CONF, "{ not json"],
    [PACKAGE, '{ "version": ["1.2.3"] }'],
    [PACKAGE, "[]"],
  ])("fails when %s holds no readable version: %j", (path, text) => {
    const violations = check.run(rootWith({ [path]: text }));
    expect(codes(violations)).toEqual(["ERR_CHECK_VERSION_UNPARSED"]);
    expect(violations[0]?.summary).toContain(path);
  });

  it.each([[CARGO], [CONF], [PACKAGE]])("fails when %s is missing", (path) => {
    expect(codes(check.run(rootWith({ [path]: undefined })))).toEqual(["ERR_CHECK_INPUT_MISSING"]);
  });
});
