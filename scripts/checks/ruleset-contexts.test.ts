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

  describe("a context must be reported on every pull request", () => {
    const workflow = (trigger: string, job: string): string => `on:
  pull_request:${trigger}
jobs:
  build:
    name: Build
    runs-on: ubuntu-24.04
  docs:
    runs-on: ubuntu-24.04
${job}`;

    it.each([
      ["paths", '\n    paths: ["docs/**"]'],
      ["paths-ignore", '\n    paths-ignore: ["**.md"]'],
      ["branches", "\n    branches: [main]"],
      ["branches-ignore", '\n    branches-ignore: ["release/**"]'],
      ["types without synchronize", "\n    types: [opened, reopened]"],
    ])("rejects a context whose workflow's pull_request trigger filters %s", (_label, trigger) => {
      const found = check.run(
        root({
          ".github/workflows/docs.yml": workflow(trigger, "    name: Docs Only\n"),
          ".github/rulesets/main.json": ruleset(["Build", "Docs Only"]),
        }),
      );
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
      expect(found[0]?.summary).toContain('"Docs Only"');
      expect(found[0]?.actual).toContain(".github/workflows/docs.yml");
    });

    it("passes a trigger whose types keep every default one", () => {
      expect(
        codes({
          ".github/workflows/docs.yml": workflow(
            "\n    types: [opened, synchronize, reopened, edited]",
            "    name: Docs Only\n",
          ),
          ".github/rulesets/main.json": ruleset(["Docs Only"]),
        }),
      ).toEqual([]);
    });

    it.each([
      ["runs only on push", "github.event_name == 'push'"],
      ["depends on the branch", "${{ github.ref == 'refs/heads/main' }}"],
      ["calls a function the evaluator does not read", "always()"],
      ["is false", "false"],
    ])("rejects a context whose job's if: %s", (_label, condition) => {
      expect(
        codes({
          ".github/workflows/docs.yml": workflow(
            "",
            `    name: Docs Only\n    if: ${JSON.stringify(condition)}\n`,
          ),
          ".github/rulesets/main.json": ruleset(["Docs Only"]),
        }),
      ).toEqual(["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
    });

    it.each([
      ["true", "true"],
      ["an expression true on every pull request", "github.event_name == 'pull_request'"],
      ["a wrapped one", "${{ github.event_name != 'push' }}"],
    ])("passes a job whose if: is %s", (_label, condition) => {
      expect(
        codes({
          ".github/workflows/docs.yml": workflow(
            "",
            `    name: Docs Only\n    if: ${JSON.stringify(condition)}\n`,
          ),
          ".github/rulesets/main.json": ruleset(["Docs Only"]),
        }),
      ).toEqual([]);
    });

    it("rejects a context whose job needs a job that can be skipped", () => {
      const docs = `on: pull_request
jobs:
  gate:
    if: github.event_name == 'push'
    runs-on: ubuntu-24.04
  docs:
    name: Docs Only
    needs: [gate]
    runs-on: ubuntu-24.04
`;
      const found = check.run(
        root({
          ".github/workflows/docs.yml": docs,
          ".github/rulesets/main.json": ruleset(["Docs Only"]),
        }),
      );
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
      expect(found[0]?.actual).toContain("job `gate`");
    });

    it("rejects a job that needs a missing job, or itself", () => {
      const docs = (needs: string): string => `on: pull_request
jobs:
  docs:
    name: Docs Only
    needs: ${needs}
    runs-on: ubuntu-24.04
  loop:
    needs: docs
    runs-on: ubuntu-24.04
`;
      for (const needs of ["nowhere", "loop", "[1]"]) {
        expect(
          codes({
            ".github/workflows/docs.yml": docs(needs),
            ".github/rulesets/main.json": ruleset(["Docs Only"]),
          }),
          needs,
        ).toEqual(["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
      }
    });

    it("passes a context one always-running job reports, whatever another does", () => {
      expect(
        codes({
          ".github/workflows/docs.yml": workflow('\n    paths: ["docs/**"]', "    name: Build\n"),
        }),
      ).toEqual([]);
    });
  });

  describe("a name that is only an expression", () => {
    const named = (name: string, condition = ""): string => `on: pull_request
jobs:
  any:
    name: ${JSON.stringify(name)}
    runs-on: ubuntu-24.04${condition}
    strategy:
      matrix:
        os: [ubuntu, macos]
`;

    it("matches no context when it is not a literal on a pull request", () => {
      expect(
        codes({
          ".github/workflows/any.yml": named(
            "${{ matrix.os }}",
            "\n    if: github.event_name == 'push'",
          ),
          ".github/rulesets/main.json": ruleset(["Totally Renamed Job"]),
        }),
      ).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
      expect(
        codes({
          ".github/workflows/any.yml": named("${{ matrix.os }} ${{ matrix.arch }}"),
          ".github/rulesets/main.json": ruleset(["Totally Renamed Job"]),
        }),
      ).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
    });

    it("matches the text it evaluates to on a pull request", () => {
      const name = "${{ github.event_name == 'pull_request' && 'PR Build' || 'Push Build' }}";
      expect(
        codes({
          ".github/workflows/any.yml": named(name),
          ".github/rulesets/main.json": ruleset(["PR Build"]),
        }),
      ).toEqual([]);
      expect(
        codes({
          ".github/workflows/any.yml": named(name),
          ".github/rulesets/main.json": ruleset(["Push Build"]),
        }),
      ).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
    });
  });

  it("matches a name's expressions as wildcards", () => {
    expect(nameMatches("Analyze (rust)", "Analyze (${{ matrix.language }})", false)).toBe(true);
    expect(nameMatches("Analyze rust", "Analyze (${{ matrix.language }})", false)).toBe(false);
    expect(nameMatches("a-x-b-y", "a-${{ x }}-b-${{ y }}", false)).toBe(true);
    expect(nameMatches("Test (macos)", "Test", true)).toBe(true);
    expect(nameMatches("Test", "Test", true)).toBe(false);
    expect(nameMatches("Test.", "Test?", false)).toBe(false);
    expect(nameMatches("anything", "${{ matrix.os }}", false)).toBe(false);
    expect(nameMatches("Build", "${{ 'Build' }}", false)).toBe(true);
    expect(nameMatches("", "${{ null }}", false)).toBe(true);
    expect(nameMatches("Lint (x)", "Lint (${{ format('{0}', matrix.x) }})", false)).toBe(true);
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
