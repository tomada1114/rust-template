import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, jobNames, main, matrixCombinations, type JobNames } from "./ruleset-contexts.ts";

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
      ["branches not matching main", '\n    branches: ["release/**"]'],
      ["branches negating main", '\n    branches: ["**", "!main"]'],
      ["branches-ignore matching main", "\n    branches-ignore: [main]"],
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

    it.each([
      ["branches: [main]", "\n    branches: [main]"],
      ["a glob matching main", '\n    branches: ["**"]'],
      ["branches-ignore not matching main", '\n    branches-ignore: ["dependabot/**"]'],
    ])("passes a trigger with %s", (_label, trigger) => {
      expect(
        codes({
          ".github/workflows/docs.yml": workflow(trigger, "    name: Docs Only\n"),
          ".github/rulesets/main.json": ruleset(["Docs Only"]),
        }),
      ).toEqual([]);
    });

    it("reads the gated branch from a refs/heads include", () => {
      const gated = JSON.stringify({
        ...(JSON.parse(ruleset(["Docs Only"])) as Record<string, unknown>),
        conditions: { ref_name: { include: ["refs/heads/trunk"], exclude: [] } },
      });
      expect(
        codes({
          ".github/workflows/docs.yml": workflow("\n    branches: [main]", "    name: Docs Only\n"),
          ".github/rulesets/main.json": gated,
        }),
      ).toEqual(["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
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

  /** A context that matches nothing because a job's names cannot be known, with why and what to do. */
  const failsClosed = (overrides: Files, reason: string, next: string): void => {
    const found = check.run(root(overrides));
    expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
    expect(found[0]?.actual).toContain(reason);
    expect(found[0]?.next).toContain(next);
  };

  describe("a name that is only an expression", () => {
    const named = (name: string, condition = "", matrix = true): string => `on: pull_request
jobs:
  any:
    name: ${JSON.stringify(name)}
    runs-on: ubuntu-24.04${condition}${
      matrix
        ? `
    strategy:
      matrix:
        os: [ubuntu, macos]`
        : ""
    }
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
          ".github/workflows/any.yml": named(name, "", false),
          ".github/rulesets/main.json": ruleset(["PR Build"]),
        }),
      ).toEqual([]);
      expect(
        codes({
          ".github/workflows/any.yml": named(name, "", false),
          ".github/rulesets/main.json": ruleset(["Push Build"]),
        }),
      ).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
    });

    it("resolves to each value of a literal matrix", () => {
      for (const context of ["ubuntu", "macos"]) {
        expect(
          codes({
            ".github/workflows/any.yml": named("${{ matrix.os }}"),
            ".github/rulesets/main.json": ruleset([context]),
          }),
          context,
        ).toEqual([]);
      }
    });

    it("still matches nothing when the matrix is computed", () => {
      failsClosed(
        {
          ".github/workflows/any.yml": `on: pull_request
jobs:
  any:
    name: \${{ matrix.os }}
    strategy:
      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}
`,
          ".github/rulesets/main.json": ruleset(["ubuntu"]),
        },
        "its matrix is computed by an expression",
        "write the job's `strategy.matrix` as literal lists",
      );
    });

    it("fails closed on a matrix job whose name's expressions never read matrix", () => {
      failsClosed(
        {
          ".github/workflows/any.yml": named("Build ${{ github.event_name }}"),
          ".github/rulesets/main.json": ruleset(["Build pull_request"]),
        },
        "none reads `matrix`",
        "read the matrix in the name",
      );
    });
  });

  describe("a name mixing text and an expression", () => {
    it("fails a context whose matrix value the workflow no longer has", () => {
      const found = check.run(
        root({ ".github/rulesets/main.json": ruleset(["Analyze (python)"]) }),
      );
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
      expect(found[0]?.actual).toContain("Analyze (rust), Analyze (actions)");
    });

    it("passes a context naming each value the matrix has", () => {
      expect(
        codes({ ".github/rulesets/main.json": ruleset(["Analyze (rust)", "Analyze (actions)"]) }),
      ).toEqual([]);
    });

    const job = (name: string, matrix: string): string => `on: pull_request
jobs:
  any:
    name: ${JSON.stringify(name)}
    runs-on: ubuntu-24.04
    strategy:
      matrix:
${matrix}`;

    it("reads a matrix key the combination does not have as an empty string", () => {
      const workflow = job("Lint (${{ matrix.arch }})", "        os: [ubuntu]\n");
      expect(
        codes({
          ".github/workflows/any.yml": workflow,
          ".github/rulesets/main.json": ruleset(["Lint ()"]),
        }),
      ).toEqual([]);
      const found = check.run(
        root({
          ".github/workflows/any.yml": workflow,
          ".github/rulesets/main.json": ruleset(["Lint (ubuntu)"]),
        }),
      );
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
      expect(found[0]?.actual).toContain("Lint ()");
    });

    it.each([
      [
        "an expression that is not fixed on a pull request",
        "Lint (${{ github.head_ref }})",
        "        os: [ubuntu]\n",
        "reads `github.head_ref`, which is not fixed on a pull request",
        "build the job's `name:` only from text",
      ],
      [
        "a function call",
        "Lint (${{ format('{0}', matrix.os) }})",
        "        os: [ubuntu]\n",
        "this check cannot evaluate",
        "build the job's `name:` only from text",
      ],
      [
        "a matrix value that is a mapping",
        "Lint (${{ matrix.target }})",
        "        target: [{ os: ubuntu }]\n",
        "has no text this check can know",
        "build the job's `name:` only from text",
      ],
      [
        "a matrix computed from another job's output",
        "Lint (${{ matrix.os }})",
        "        os: ${{ fromJSON(needs.plan.outputs.os) }}\n",
        "computed by an expression",
        "write the job's `strategy.matrix` as literal lists",
      ],
      [
        "an include computed at run time",
        "Lint (${{ matrix.os }})",
        "        include: ${{ fromJSON(needs.plan.outputs.include) }}\n",
        "computed by an expression",
        "write the job's `strategy.matrix` as literal lists",
      ],
    ])("fails closed on %s, naming the job", (_label, name, matrix, reason, next) => {
      failsClosed(
        {
          ".github/workflows/any.yml": job(name, matrix),
          ".github/rulesets/main.json": ruleset(["Lint (ubuntu)"]),
        },
        `\`${name}\` (`,
        `for \`${name}\`, ${next}`,
      );
      const found = check.run(
        root({
          ".github/workflows/any.yml": job(name, matrix),
          ".github/rulesets/main.json": ruleset(["Lint (ubuntu)"]),
        }),
      );
      expect(found[0]?.actual).toContain(reason);
    });

    it("expands include and exclude as GitHub does", () => {
      const matrix = `        os: [ubuntu, macos]
        rust: [stable, beta]
        exclude:
          - os: macos
            rust: beta
        include:
          - os: windows
            rust: stable
`;
      const workflow = job("Test ${{ matrix.os }}-${{ matrix.rust }}", matrix);
      for (const context of ["Test ubuntu-beta", "Test macos-stable", "Test windows-stable"]) {
        expect(
          codes({
            ".github/workflows/any.yml": workflow,
            ".github/rulesets/main.json": ruleset([context]),
          }),
          context,
        ).toEqual([]);
      }
      expect(
        codes({
          ".github/workflows/any.yml": workflow,
          ".github/rulesets/main.json": ruleset(["Test macos-beta"]),
        }),
      ).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
    });
  });

  describe("a job that calls a reusable workflow", () => {
    const caller = (job: string): string => `on: pull_request
jobs:
  call:
${job}`;
    const reusable = `on:
  workflow_call:
jobs:
  checks:
    name: Checks
    runs-on: ubuntu-24.04
  matrix:
    runs-on: ubuntu-24.04
    strategy:
      matrix:
        os: [ubuntu, macos]
  gated:
    name: Gated
    if: github.event_name == 'push'
    runs-on: ubuntu-24.04
`;
    const withCaller = (job: string, contexts: readonly string[], extra: Files = {}): string[] =>
      codes({
        ".github/workflows/caller.yml": caller(job),
        ".github/workflows/reusable.yml": reusable,
        ".github/rulesets/main.json": ruleset(contexts),
        ...extra,
      });

    it("passes a context naming <caller> / <called job>", () => {
      expect(
        withCaller("    name: Reusable\n    uses: ./.github/workflows/reusable.yml\n", [
          "Reusable / Checks",
          "Reusable / matrix (macos)",
        ]),
      ).toEqual([]);
      expect(withCaller("    uses: ./.github/workflows/reusable.yml\n", ["call / Checks"])).toEqual(
        [],
      );
    });

    it("expands a calling job's matrix in front of the called job", () => {
      const job = `    name: Reusable (\${{ matrix.target }})
    strategy:
      matrix:
        target: [app, cli]
    uses: ./.github/workflows/reusable.yml
`;
      expect(withCaller(job, ["Reusable (cli) / Checks"])).toEqual([]);
      expect(withCaller(job, ["Reusable (web) / Checks"])).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
    });

    it("follows a called workflow that calls another", () => {
      const middle = `on: workflow_call
jobs:
  inner:
    name: Inner
    uses: ./.github/workflows/reusable.yml
`;
      expect(
        withCaller(
          "    name: Outer\n    uses: ./.github/workflows/middle.yml\n",
          ["Outer / Inner / Checks"],
          { ".github/workflows/middle.yml": middle },
        ),
      ).toEqual([]);
    });

    /** A pull_request workflow calling a chain of `called` reusable workflows, and the leaf's context. */
    const chain = (called: number): [Files, string] => {
      const files: Files = {
        ".github/workflows/caller.yml": caller("    uses: ./.github/workflows/level1.yml\n"),
      };
      for (let level = 1; level <= called; level += 1) {
        files[`.github/workflows/level${String(level)}.yml`] =
          level < called
            ? `on: workflow_call\njobs:\n  hop:\n    uses: ./.github/workflows/level${String(level + 1)}.yml\n`
            : "on: workflow_call\njobs:\n  leaf:\n    name: Leaf\n    runs-on: ubuntu-24.04\n";
      }
      return [files, ["call", ...Array<string>(called - 1).fill("hop"), "Leaf"].join(" / ")];
    };

    it("follows ten levels of workflows, GitHub's limit, and fails closed past it", () => {
      const [ten, deepest] = chain(9);
      expect(codes({ ...ten, ".github/rulesets/main.json": ruleset([deepest]) })).toEqual([]);
      const [eleven, past] = chain(10);
      failsClosed(
        { ...eleven, ".github/rulesets/main.json": ruleset([past]) },
        "below 10 levels of workflows, past GitHub's limit of 10",
        "flatten the chain of reusable-workflow calls to at most 10 levels",
      );
    });

    it("rejects the caller's name, or the called job's, on its own", () => {
      for (const context of ["Reusable", "Checks"]) {
        expect(
          withCaller("    name: Reusable\n    uses: ./.github/workflows/reusable.yml\n", [context]),
          context,
        ).toEqual(["ERR_CHECK_RULESET_CONTEXT"]);
      }
    });

    it("rejects a called job that may be skipped, or a caller that may be", () => {
      const found = check.run(
        root({
          ".github/workflows/caller.yml": caller(
            "    name: Reusable\n    uses: ./.github/workflows/reusable.yml\n",
          ),
          ".github/workflows/reusable.yml": reusable,
          ".github/rulesets/main.json": ruleset(["Reusable / Gated"]),
        }),
      );
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
      expect(found[0]?.actual).toContain("reusable.yml: job `gated`");
      expect(found[0]?.expected).toContain("the calling job");
      const byCaller = check.run(
        root({
          ".github/workflows/caller.yml": caller(
            "    name: Reusable\n    if: github.event_name == 'push'\n    uses: ./.github/workflows/reusable.yml\n",
          ),
          ".github/workflows/reusable.yml": reusable,
          ".github/rulesets/main.json": ruleset(["Reusable / Checks"]),
        }),
      );
      expect(byCaller.map((v) => v.code)).toEqual(["ERR_CHECK_RULESET_CONTEXT_SKIPPED"]);
      expect(byCaller[0]?.actual).toContain("caller.yml: job `call`");
    });

    it.each([
      [
        "another repository's workflow",
        "octo/ci/.github/workflows/x.yml@v1",
        {},
        "a workflow in another repository",
        "copy the called workflow into .github/workflows/",
      ],
      [
        "a missing file",
        "./.github/workflows/nowhere.yml",
        {},
        "does not exist or does not parse",
        "restore .github/workflows/nowhere.yml",
      ],
      [
        "a file outside .github/workflows",
        "./reusable.yml",
        { "reusable.yml": reusable },
        "not the documented",
        "with no `..` or subdirectory",
      ],
      [
        "a path through ..",
        "./.github/workflows/../workflows/reusable.yml",
        {},
        "not the documented",
        "with no `..` or subdirectory",
      ],
      [
        "a subdirectory of .github/workflows",
        "./.github/workflows/sub/reusable.yml",
        { ".github/workflows/sub/reusable.yml": reusable },
        "not the documented",
        "with no `..` or subdirectory",
      ],
      [
        "a workflow with no workflow_call trigger",
        "./.github/workflows/push.yml",
        {},
        "does not name `workflow_call`",
        "add `workflow_call` to the `on:` of .github/workflows/push.yml",
      ],
      [
        "a workflow that calls back",
        "./.github/workflows/loop.yml",
        {
          ".github/workflows/loop.yml":
            "on: workflow_call\njobs:\n  again:\n    uses: ./.github/workflows/loop.yml\n",
        },
        "through a cycle",
        "break the cycle",
      ],
    ])("fails closed on %s", (_label, uses, extra: Files, reason, next) => {
      failsClosed(
        {
          ".github/workflows/caller.yml": caller(`    name: Reusable\n    uses: ${uses}\n`),
          ".github/workflows/reusable.yml": reusable,
          ".github/rulesets/main.json": ruleset(["Reusable / Checks"]),
          ...extra,
        },
        reason,
        next,
      );
    });

    it("fails closed on a uses: that is not a string", () => {
      failsClosed(
        {
          ".github/workflows/caller.yml": caller("    uses: [1]\n"),
          ".github/rulesets/main.json": ruleset(["call / Checks"]),
        },
        "`call` (its `uses:` is not a string)",
        "write the job's `uses:` as `./.github/workflows/<file>.yml`",
      );
    });

    it("fails closed on a strategy that is not a mapping", () => {
      failsClosed(
        {
          ".github/workflows/caller.yml": caller(
            "    name: Reusable\n    strategy: [1]\n    uses: ./.github/workflows/reusable.yml\n",
          ),
          ".github/workflows/reusable.yml": reusable,
          ".github/rulesets/main.json": ruleset(["Reusable / Checks"]),
        },
        "its `strategy` is not a mapping",
        "write the job's `strategy:` as a mapping",
      );
    });
  });

  describe("jobNames", () => {
    const reason = (names: JobNames): string =>
      "unresolved" in names ? names.unresolved.reason : `resolved: ${names.names.join(", ")}`;
    const values = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `v${String(index)}`);

    it("reports a name without a matrix as its evaluated text", () => {
      expect(jobNames("Build", undefined)).toEqual({ names: ["Build"] });
      expect(jobNames("${{ 'Build' }}", undefined)).toEqual({ names: ["Build"] });
      expect(jobNames("a${{ null }}b", undefined)).toEqual({ names: ["ab"] });
      expect(reason(jobNames("${{ matrix.os }}", undefined))).toContain(
        "reads `matrix.os`, which is not fixed",
      );
    });

    it("suffixes a matrix job's name with its values when the name has no expression", () => {
      expect(jobNames("Test", { os: ["ubuntu", "macos"], n: [1] })).toEqual({
        names: ["Test (ubuntu, 1)", "Test (macos, 1)"],
      });
      expect(jobNames("Test", { include: [{ os: "a", flag: true }] })).toEqual({
        names: ["Test (a, true)"],
      });
    });

    it("fails closed on a null or a mapping in the appended values", () => {
      for (const matrix of [{ include: [{ os: "a", none: null }] }, { os: [{ name: "a" }] }]) {
        expect(reason(jobNames("Test", matrix)), JSON.stringify(matrix)).toContain(
          "null, a mapping, or a list",
        );
      }
    });

    it("appends include-added values after the matrix's own, in the order written", () => {
      expect(jobNames("T", { os: ["a"], include: [{ os: "a", zeta: "1", beta: "2" }] })).toEqual({
        names: ["T (a, 1, 2)"],
      });
      expect(
        jobNames("T", {
          os: ["a", "b"],
          include: [{ color: "green" }, { os: "b", color: "pink", size: "L" }],
        }),
      ).toEqual({ names: ["T (a, green)", "T (b, pink, L)"] });
    });

    it("drops every combination a partial exclude entry matches", () => {
      expect(
        jobNames("T ${{ matrix.os }}-${{ matrix.rust }}", {
          os: ["a", "b"],
          rust: ["x", "y"],
          exclude: [{ os: "b" }],
        }),
      ).toEqual({ names: ["T a-x", "T a-y"] });
    });

    it("reads nested matrix values case-insensitively, and a missing one as empty", () => {
      expect(jobNames("T ${{ Matrix.Target.OS }}", { target: [{ Os: "mac" }] })).toEqual({
        names: ["T mac"],
      });
      expect(jobNames("T ${{ matrix.arch }}${{ matrix.os.name }}", { os: ["u"] })).toEqual({
        names: ["T "],
      });
      expect(reason(jobNames("T ${{ matrix.target }}", { target: [{ os: "mac" }] }))).toContain(
        "has no text this check can know",
      );
      expect(reason(jobNames("T ${{ matrix.os.* }}", { os: [{ a: "b" }] }))).toContain(
        "has no text this check can know",
      );
    });

    it("fails closed on a matrix job whose name's expressions never read matrix", () => {
      expect(
        reason(
          jobNames("${{ github.event_name == 'pull_request' && 'PR' || 'Push' }}", { os: ["a"] }),
        ),
      ).toContain("none reads `matrix`");
    });

    it("evaluates a name that reads matrix per combination, with no suffix", () => {
      expect(
        jobNames("${{ github.event_name == 'pull_request' && matrix.os || 'Push' }}", {
          os: ["a", "b"],
        }),
      ).toEqual({ names: ["a", "b"] });
    });

    it("takes GitHub's limit of 256 jobs per matrix", () => {
      expect(jobNames("T", { a: values(16), b: values(16) })).toHaveProperty("names.length", 256);
      expect(reason(jobNames("T", { a: values(16), b: values(17) }))).toContain(
        "more than 256 combinations",
      );
      expect(reason(jobNames("T", { a: values(300), b: values(300) }))).toContain(
        "more than 65536 combinations before `exclude`",
      );
    });

    it("lists each name once", () => {
      expect(jobNames("Lint", undefined)).toEqual({ names: ["Lint"] });
      expect(jobNames("Lint ${{ matrix.os }}", { os: ["a", "a"] })).toEqual({ names: ["Lint a"] });
    });
  });

  describe("matrixCombinations", () => {
    const shape = (matrix: unknown): unknown => {
      const found = matrixCombinations(matrix);
      return Array.isArray(found)
        ? found.map((combination) => Object.fromEntries(combination))
        : found.reason;
    };

    it("follows GitHub's documented include example", () => {
      expect(
        shape({
          fruit: ["apple", "pear"],
          animal: ["cat", "dog"],
          include: [
            { color: "green" },
            { color: "pink", animal: "cat" },
            { fruit: "apple", shape: "circle" },
            { fruit: "banana" },
            { fruit: "banana", animal: "cat" },
          ],
        }),
      ).toEqual([
        { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
        { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
        { fruit: "pear", animal: "cat", color: "pink" },
        { fruit: "pear", animal: "dog", color: "green" },
        { fruit: "banana" },
        { fruit: "banana", animal: "cat" },
      ]);
    });

    it.each([
      ["an expression", "${{ fromJSON(needs.a.outputs.m) }}", "computed"],
      ["a list", ["a"], "not a mapping"],
      ["an empty list", { os: [] }, "not a non-empty list"],
      ["a scalar dimension", { os: "ubuntu" }, "not a non-empty list"],
      ["an include that is not a list of mappings", { os: ["a"], include: ["b"] }, "`include`"],
      ["an exclude that is not a list", { os: ["a"], exclude: { os: "a" } }, "`exclude`"],
      ["every combination excluded", { os: ["a"], exclude: [{ os: "a" }] }, "no combinations"],
      ["nothing at all", {}, "no combinations"],
      ["absent", undefined, "not a mapping"],
      ["keyed by digits", { "1": ["a"] }, "made only of digits"],
      ["keyed by digits in an include", { include: [{ "2": "a" }] }, "made only of digits"],
    ])("does not know a matrix that is %s", (_label, matrix, reason) => {
      expect(shape(matrix)).toContain(reason);
    });
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
