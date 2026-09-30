import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, main } from "./advisory-ignores-agree.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OSV = `[[IgnoredVulns]]
id = "GHSA-wrw7-89jp-8q8g"
ignoreUntil = 2026-12-27T00:00:00Z
reason = "Linux-only"

[[IgnoredVulns]]
id = "RUSTSEC-2024-0370"
ignoreUntil = 2026-12-27T00:00:00Z
reason = "Linux-only"
`;

const workflow = (allow: string | undefined): string => `name: Dependency Review
on:
  pull_request:
jobs:
  dependency-review:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294 # v5.0.0
        with:
${allow === undefined ? "" : `          allow-ghsas: ${allow}\n`}          allow-licenses: MIT
`;

const WORKFLOW = ".github/workflows/dependency-review.yml";

function fixture(overrides: Record<string, string | undefined> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "advisory-ignores-agree-"));
  dirs.push(root);
  const files: Record<string, string | undefined> = {
    "osv-scanner.toml": OSV,
    [WORKFLOW]: workflow("GHSA-wrw7-89jp-8q8g"),
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const codes = (root: string): string[] => check.run(root).map((v) => v.code);

describe("advisory-ignores-agree", () => {
  it("passes when allow-ghsas lists exactly the OSV GHSA ignores", () => {
    expect(check.run(fixture())).toEqual([]);
  });

  it("accepts a comma-separated list in another case", () => {
    const osv = `${OSV}\n[[IgnoredVulns]]\nid = "GHSA-aaaa-bbbb-cccc"\n`;
    const root = fixture({
      "osv-scanner.toml": osv,
      [WORKFLOW]: workflow("ghsa-aaaa-bbbb-cccc, GHSA-wrw7-89jp-8q8g"),
    });
    expect(check.run(root)).toEqual([]);
  });

  it("fails when allow-ghsas is missing an OSV GHSA ignore", () => {
    const [violation, ...rest] = check.run(fixture({ [WORKFLOW]: workflow(undefined) }));
    expect(rest).toEqual([]);
    expect(violation?.code).toBe("ERR_CHECK_ADVISORY_DISAGREE");
    expect(violation?.actual).toBe("missing: GHSA-WRW7-89JP-8Q8G; not ignored by OSV: none");
  });

  it("fails when allow-ghsas lists an advisory OSV does not ignore", () => {
    const root = fixture({ [WORKFLOW]: workflow("GHSA-wrw7-89jp-8q8g GHSA-xxxx-yyyy-zzzz") });
    expect(check.run(root).map((v) => v.actual)).toEqual([
      "missing: none; not ignored by OSV: GHSA-XXXX-YYYY-ZZZZ",
    ]);
  });

  it("fails when OSV drops the ignore but allow-ghsas keeps it", () => {
    expect(codes(fixture({ "osv-scanner.toml": "" }))).toEqual(["ERR_CHECK_ADVISORY_DISAGREE"]);
  });

  it("treats an absent osv-scanner.toml as no ignores", () => {
    expect(codes(fixture({ "osv-scanner.toml": undefined }))).toEqual([
      "ERR_CHECK_ADVISORY_DISAGREE",
    ]);
    const root = fixture({ "osv-scanner.toml": undefined, [WORKFLOW]: workflow(undefined) });
    expect(check.run(root)).toEqual([]);
  });

  it("ignores malformed IgnoredVulns entries and a non-list IgnoredVulns", () => {
    const osv = `IgnoredVulns = "none"\n`;
    expect(
      check.run(fixture({ "osv-scanner.toml": osv, [WORKFLOW]: workflow(undefined) })),
    ).toEqual([]);
    const odd = `IgnoredVulns = [1, { id = 2 }, { id = "GHSA-wrw7-89jp-8q8g" }]\n`;
    expect(check.run(fixture({ "osv-scanner.toml": odd }))).toEqual([]);
  });

  it("passes without the workflow, or without a dependency-review step", () => {
    expect(check.run(fixture({ [WORKFLOW]: undefined }))).toEqual([]);
    const other =
      "jobs:\n  a:\n    steps:\n      - run: echo\n      - uses: actions/checkout@v1\n  b: 1\n";
    expect(check.run(fixture({ [WORKFLOW]: other }))).toEqual([]);
    expect(check.run(fixture({ [WORKFLOW]: "name: x\n" }))).toEqual([]);
  });

  it.each([
    ["osv-scanner.toml", "[[IgnoredVulns\n"],
    [WORKFLOW, "jobs: [\n"],
  ])("fails with ERR_CHECK_ADVISORY_UNREADABLE when %s does not parse", (path, content) => {
    expect(codes(fixture({ [path]: content }))).toEqual(["ERR_CHECK_ADVISORY_UNREADABLE"]);
  });

  it("passes on the repository's own files", () => {
    expect(check.run(join(import.meta.dirname, "..", ".."))).toEqual([]);
  });

  it("runs as a script and logs a pass", () => {
    const lines: string[] = [];
    const context: ScriptContext = {
      argv: ["--root", fixture()],
      env: {},
      root: "/nowhere",
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => lines.push(line),
    };
    main(context);
    expect(lines).toEqual(["check advisory-ignores-agree: ok"]);
  });
});
