import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, compare, main, parseJustfile, type Exceptions } from "./just-check-matches-ci.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JUSTFILE = `set shell := ["bash", "-euo", "pipefail", "-c"]
flag := "x"

# List the recipes
default:
    @just --list

# The gate
check: hooks fmt lint test build # trailing comment

hooks:
    node scripts/verify-hooks.ts

fmt:
    cargo fmt --all

lint: (prep "a")
    cargo fmt --all --check

    -pnpm lint

prep arg:
    echo {{ arg }}

test: test-core && test-ui

test-core:
    cargo nextest run --locked \\
      -p core

test-ui:
    pnpm test:ui

build:
    #!/usr/bin/env bash
    set -euo pipefail
    just helper

helper:
    @cargo build --locked

extra:
    cargo shear

gen:
    cargo test --locked export_bindings
`;

const CI = `on: [push, pull_request]
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@abc
      - run: corepack enable pnpm
      - run: cargo   fmt --all --check
      - run: |
          # a comment
          pnpm lint
          just --quiet prep a
      - run: just test-core
      - run: just test-ui
      - run: just build
      - name: Drift
        run: |
          just gen
          git diff --exit-code
  bootstrap:
    name: Template Bootstrap Smoke
    steps:
      - run: cp -R . "$RUNNER_TEMP/copy"
`;

const EXCEPTIONS: Exceptions = {
  localOnly: { hooks: "no hooks on CI", fmt: "rewrites files" },
  ciOnlyRecipes: { gen: "writes files; CI diffs them" },
  ciOnlyCommands: { "corepack enable pnpm": "runner setup" },
  ciOnlyJobs: { "Template Bootstrap Smoke": "tests the bootstrap, not this tree" },
};

type Files = Record<string, string | undefined>;

function root(overrides: Files = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "just-check-matches-ci-"));
  dirs.push(dir);
  const files: Files = { justfile: JUSTFILE, ".github/workflows/ci.yml": CI, ...overrides };
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function codes(overrides: Files = {}, exceptions: Exceptions = EXCEPTIONS): string[] {
  return compare(root(overrides), exceptions).map((violation) => violation.code);
}

const withCi = (from: string, to: string): Files => {
  const changed = CI.replace(from, to);
  if (changed === CI) throw new Error(`the base ci.yml has no ${JSON.stringify(from)}`);
  return { ".github/workflows/ci.yml": changed };
};

const withJustfile = (from: string, to: string): Files => {
  const changed = JUSTFILE.replace(from, to);
  if (changed === JUSTFILE) throw new Error(`the base justfile has no ${JSON.stringify(from)}`);
  return { justfile: changed };
};

describe("parseJustfile", () => {
  it("reads recipes, their dependencies, and their command lines", () => {
    const recipes = parseJustfile(JUSTFILE);
    expect([...recipes.keys()]).toEqual([
      "default",
      "check",
      "hooks",
      "fmt",
      "lint",
      "prep",
      "test",
      "test-core",
      "test-ui",
      "build",
      "helper",
      "extra",
      "gen",
    ]);
    expect(recipes.get("check")?.deps).toEqual(["hooks", "fmt", "lint", "test", "build"]);
    expect(recipes.get("lint")?.deps).toEqual(["prep"]);
    expect(recipes.get("lint")?.commands).toEqual(["cargo fmt --all --check", "pnpm lint"]);
    expect(recipes.get("test")?.deps).toEqual(["test-core", "test-ui"]);
    expect(recipes.get("test-core")?.commands).toEqual(["cargo nextest run --locked -p core"]);
    expect(recipes.get("build")?.commands).toEqual(["set -euo pipefail", "just helper"]);
    expect(recipes.get("build")?.calls).toEqual(["helper"]);
    expect(recipes.get("default")?.calls).toEqual([]);
    expect(recipes.get("helper")?.commands).toEqual(["cargo build --locked"]);
  });
});

describe("just-check-matches-ci", () => {
  it("passes when both sides run the same gates apart from the exceptions", () => {
    expect(compare(root(), EXCEPTIONS)).toEqual([]);
  });

  describe("a gate only `just check` runs", () => {
    it("rejects a new check dependency no CI step runs", () => {
      const found = compare(
        root(
          withJustfile(
            "check: hooks fmt lint test build",
            "check: hooks fmt lint test build extra",
          ),
        ),
        EXCEPTIONS,
      );
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_JUST_CI_DIVERGED"]);
      expect(found[0]?.summary).toContain("`just extra`");
      expect(found[0]?.actual).toContain("cargo shear");
    });

    it("rejects a recipe body line CI does not run verbatim", () => {
      expect(
        codes(withJustfile("    -pnpm lint\n", "    -pnpm lint\n    pnpm typecheck\n")),
      ).toEqual(["ERR_CHECK_JUST_CI_DIVERGED"]);
    });
  });

  describe("a step only CI runs", () => {
    it("rejects a CI step running a recipe outside `just check`", () => {
      const found = compare(
        root(
          withCi(
            "      - run: just test-ui\n",
            "      - run: just test-ui\n      - run: just extra\n",
          ),
        ),
        EXCEPTIONS,
      );
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_JUST_CI_DIVERGED"]);
      expect(found[0]?.summary).toContain(".github/workflows/ci.yml:");
    });

    it("rejects a raw CI command no gate runs and no exception lists", () => {
      expect(
        codes(
          withCi(
            "      - run: just test-ui\n",
            "      - run: just test-ui\n      - run: cargo deny check\n",
          ),
        ),
      ).toEqual(["ERR_CHECK_JUST_CI_DIVERGED"]);
    });

    it("rejects an unlisted command in an excepted job's sibling job", () => {
      expect(codes(withCi("    name: Template Bootstrap Smoke\n", "    name: Other\n"))).toEqual([
        "ERR_CHECK_JUST_CI_DIVERGED",
      ]);
    });

    it("accepts `just check` itself in CI, which leaves no gate local-only", () => {
      const found = compare(
        root(
          withCi(
            "      - run: just test-ui\n",
            "      - run: just test-ui\n      - run: just check\n",
          ),
        ),
        EXCEPTIONS,
      );
      expect(found.map((v) => v.code)).toEqual([
        "ERR_CHECK_JUST_CI_STALE",
        "ERR_CHECK_JUST_CI_STALE",
      ]);
      expect(found.map((v) => v.summary)).toEqual([
        expect.stringContaining("localOnly `hooks`"),
        expect.stringContaining("localOnly `fmt`"),
      ]);
    });
  });

  describe("stale exceptions", () => {
    it("rejects a local-only recipe `just check` no longer runs", () => {
      expect(
        codes({}, { ...EXCEPTIONS, localOnly: { ...EXCEPTIONS.localOnly, gone: "old" } }),
      ).toEqual(["ERR_CHECK_JUST_CI_STALE"]);
    });

    it("rejects a local-only recipe CI now runs", () => {
      expect(
        codes(
          withCi(
            "      - run: just test-ui\n",
            "      - run: just test-ui\n      - run: just fmt\n",
          ),
        ),
      ).toEqual(["ERR_CHECK_JUST_CI_STALE"]);
    });

    it("rejects a CI-only recipe no CI step runs", () => {
      expect(
        codes({}, { ...EXCEPTIONS, ciOnlyRecipes: { ...EXCEPTIONS.ciOnlyRecipes, gone: "old" } }),
      ).toEqual(["ERR_CHECK_JUST_CI_STALE"]);
    });

    it("rejects a CI-only recipe that `just check` now runs", () => {
      expect(
        codes(
          withJustfile("check: hooks fmt lint test build", "check: hooks fmt lint test build gen"),
        ),
      ).toEqual(["ERR_CHECK_JUST_CI_STALE"]);
    });

    it("rejects a CI-only command no CI step runs", () => {
      expect(
        codes(
          {},
          { ...EXCEPTIONS, ciOnlyCommands: { ...EXCEPTIONS.ciOnlyCommands, "cargo gone": "old" } },
        ),
      ).toEqual(["ERR_CHECK_JUST_CI_STALE"]);
    });

    it("rejects a CI-only command a gate's body now runs", () => {
      expect(
        codes(
          {},
          { ...EXCEPTIONS, ciOnlyCommands: { ...EXCEPTIONS.ciOnlyCommands, "pnpm lint": "old" } },
        ),
      ).toEqual(["ERR_CHECK_JUST_CI_STALE"]);
    });
  });

  describe("inputs", () => {
    it("fails when the justfile is missing", () => {
      expect(codes({ justfile: undefined })).toEqual(["ERR_CHECK_JUST_CI_INPUT"]);
    });

    it("fails when ci.yml is missing or unreadable", () => {
      expect(codes({ ".github/workflows/ci.yml": undefined })).toEqual(["ERR_CHECK_JUST_CI_INPUT"]);
      expect(codes({ ".github/workflows/ci.yml": "jobs: [\n" })).toEqual([
        "ERR_CHECK_JUST_CI_INPUT",
      ]);
    });

    it("fails when the justfile has no check recipe", () => {
      expect(codes({ justfile: "lint:\n    pnpm lint\n" })).toEqual(["ERR_CHECK_JUST_CI_NO_CHECK"]);
    });
  });

  it("applies its own exception list: on a tree whose CI runs none of it, every CI entry is stale", () => {
    const found = check.run(
      root({
        justfile:
          "check: verify-hooks fmt\nverify-hooks:\n    node scripts/verify-hooks.ts\nfmt:\n    cargo fmt --all\n",
        ".github/workflows/ci.yml": "on: pull_request\njobs: {}\n",
      }),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found.map((v) => v.code))).toEqual(new Set(["ERR_CHECK_JUST_CI_STALE"]));
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
    expect(() => {
      main(context(root({ justfile: undefined })));
    }).toThrow(/^ERR_CHECK_JUST_CI_INPUT/);
  });
});
