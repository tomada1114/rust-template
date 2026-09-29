import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, main, nameMatches } from "./ruleset-contexts.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    name: Build
    runs-on: ubuntu-24.04
  lint:
    runs-on: ubuntu-24.04
  analyze:
    name: Analyze (\${{ matrix.language }})
    strategy:
      matrix:
        language: [rust, actions]
  test:
    name: Test
    strategy:
      matrix:
        os: [ubuntu, macos]
`;

const TITLE = `on: [pull_request]
jobs:
  main:
    name: Validate PR title
`;

const PUSH_ONLY = `on: push
jobs:
  deploy:
    name: Deploy
`;

const TARGET = `on:
  pull_request_target:
jobs:
  label:
    name: Label
`;

function ruleset(contexts: readonly string[]): string {
  return JSON.stringify({
    name: "main",
    rules: [
      { type: "deletion" },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: contexts.map((context) => ({ context, integration_id: 1 })),
        },
      },
    ],
  });
}

const PASSING = ["Build", "lint", "Analyze (rust)", "Test (ubuntu)", "Validate PR title"];

type Files = Record<string, string | undefined>;

function root(overrides: Files = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ruleset-contexts-"));
  dirs.push(dir);
  const files: Files = {
    ".github/rulesets/main.json": ruleset(PASSING),
    ".github/workflows/ci.yml": CI,
    ".github/workflows/title.yaml": TITLE,
    ".github/workflows/push.yml": PUSH_ONLY,
    ".github/workflows/target.yml": TARGET,
    ".github/workflows/broken.yml": "jobs: [\n",
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const codes = (overrides: Files = {}): string[] =>
  check.run(root(overrides)).map((violation) => violation.code);

describe("ruleset-contexts", () => {
  it("passes when every context names a pull_request job (by name, id, or matrix)", () => {
    expect(check.run(root())).toEqual([]);
  });

  it("rejects a context no job reports, naming it", () => {
    const found = check.run(root({ ".github/rulesets/main.json": ruleset(["Build", "Bild"]) }));
    expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
    expect(found[0]?.summary).toContain('"Bild"');
  });

  it("rejects a context whose job runs only on push", () => {
    expect(codes({ ".github/rulesets/main.json": ruleset(["Deploy"]) })).toEqual([
      "ERR_CHECK_RULESET_CONTEXT",
    ]);
  });

  it("rejects a context whose job runs only on pull_request_target", () => {
    expect(codes({ ".github/rulesets/main.json": ruleset(["Label"]) })).toEqual([
      "ERR_CHECK_RULESET_CONTEXT",
    ]);
  });

  it("rejects a job's id once the job has a name", () => {
    expect(codes({ ".github/rulesets/main.json": ruleset(["build"]) })).toEqual([
      "ERR_CHECK_RULESET_CONTEXT",
    ]);
  });

  it("passes a ruleset with no required status checks", () => {
    expect(
      codes({ ".github/rulesets/main.json": JSON.stringify({ rules: [{ type: "deletion" }] }) }),
    ).toEqual([]);
    expect(codes({ ".github/rulesets/main.json": "[]" })).toEqual([]);
  });

  it("fails when the ruleset is missing", () => {
    expect(codes({ ".github/rulesets/main.json": undefined })).toEqual([
      "ERR_CHECK_RULESET_MISSING",
    ]);
  });

  it("fails when the ruleset is not JSON", () => {
    expect(codes({ ".github/rulesets/main.json": "{" })).toEqual(["ERR_CHECK_RULESET_UNREADABLE"]);
  });

  it("matches a name's expressions as wildcards", () => {
    expect(nameMatches("Analyze (rust)", "Analyze (${{ matrix.language }})", false)).toBe(true);
    expect(nameMatches("Analyze rust", "Analyze (${{ matrix.language }})", false)).toBe(false);
    expect(nameMatches("a-x-b-y", "a-${{ x }}-b-${{ y }}", false)).toBe(true);
    expect(nameMatches("Test (macos)", "Test", true)).toBe(true);
    expect(nameMatches("Test", "Test", true)).toBe(false);
    expect(nameMatches("Test.", "Test?", false)).toBe(false);
  });

  it("main logs ok, or throws the first violation", () => {
    const lines: string[] = [];
    const context = (dir: string): ScriptContext => ({
      argv: [],
      env: {},
      root: dir,
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => lines.push(line),
    });
    main(context(root()));
    expect(lines).toEqual(["check ruleset-contexts: ok"]);
    expect(() => {
      main(context(root({ ".github/rulesets/main.json": ruleset(["Nope"]) })));
    }).toThrow(/^ERR_CHECK_RULESET_CONTEXT/);
  });
});
