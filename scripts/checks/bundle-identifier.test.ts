/**
 * bundle-identifier against temp roots holding the three sites below, which agree on
 * `com.example.myapp`. The files are written at run time rather than committed under
 * fixtures/, so no tool that looks for a `tauri.conf.json` or a `justfile` in the tree
 * ever finds a fixture's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FailureDetails } from "../lib/fail.ts";
import { check } from "./bundle-identifier.ts";

const CONF = "src-tauri/tauri.conf.json";
const PATHS = "crates/myapp-platform/src/paths.rs";
const JUSTFILE = "justfile";

const PASSING: Readonly<Record<string, string>> = {
  [CONF]: '{\n  "productName": "MyApp",\n  "identifier": "com.example.myapp"\n}\n',
  [PATHS]: [
    "//! Where the app keeps its files.",
    "",
    "/// The bundle identifier, which names the app's data and log directories.",
    'pub const BUNDLE_IDENTIFIER: &str = "com.example.myapp";',
    "",
  ].join("\n"),
  [JUSTFILE]: [
    'set shell := ["bash", "-euo", "pipefail", "-c"]',
    "",
    'bundle_id := "com.example.myapp"',
    'log_dir := env("HOME", "") / "Library/Logs" / bundle_id',
    "",
  ].join("\n"),
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rootWith(changes: Readonly<Record<string, string | undefined>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-identifier-"));
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

describe("bundle-identifier", () => {
  it("passes when tauri.conf.json, paths.rs, and the justfile agree", () => {
    expect(check.run(rootWith())).toEqual([]);
  });

  it("fails when tauri.conf.json's identifier differs", () => {
    const violations = check.run(
      rootWith(replaced(CONF, "com.example.myapp", "com.example.other")),
    );
    expect(codes(violations)).toEqual(["ERR_CHECK_BUNDLE_ID_DIVERGED"]);
    expect(violations[0]?.actual).toContain(`${CONF}: com.example.other`);
    expect(violations[0]?.actual).toContain(`${PATHS}: com.example.myapp`);
  });

  it("fails when BUNDLE_IDENTIFIER differs", () => {
    const violations = check.run(
      rootWith(replaced(PATHS, '"com.example.myapp"', '"com.example.app"')),
    );
    expect(codes(violations)).toEqual(["ERR_CHECK_BUNDLE_ID_DIVERGED"]);
  });

  it("fails when the justfile's bundle_id differs", () => {
    const violations = check.run(
      rootWith(
        replaced(JUSTFILE, 'bundle_id := "com.example.myapp"', "bundle_id := 'com.example.x'"),
      ),
    );
    expect(codes(violations)).toEqual(["ERR_CHECK_BUNDLE_ID_DIVERGED"]);
    expect(violations[0]?.actual).toContain(`${JUSTFILE}: com.example.x`);
  });

  it.each([
    [CONF, '{ "productName": "MyApp" }'],
    [CONF, "{ not json"],
    [CONF, '{ "identifier": 7 }'],
    [PATHS, 'pub const BUNDLE_ID: &str = "com.example.myapp";\n'],
    [JUSTFILE, 'bundle := "com.example.myapp"\n'],
  ])("fails when %s holds no readable identifier: %s", (path, text) => {
    const violations = check.run(rootWith({ [path]: text }));
    expect(codes(violations)).toEqual(["ERR_CHECK_BUNDLE_ID_UNPARSED"]);
    expect(violations[0]?.summary).toContain(path);
  });

  it.each([[CONF], [PATHS], [JUSTFILE]])("fails when %s is missing", (path) => {
    expect(codes(check.run(rootWith({ [path]: undefined })))).toEqual(["ERR_CHECK_INPUT_MISSING"]);
  });
});
