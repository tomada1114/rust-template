import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, findLabelViolations, main } from "./labels-declared.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const declare = (names: readonly string[]): string =>
  names
    .map((name) => `- name: ${JSON.stringify(name)}\n  color: "ededed"\n  description: "x"\n`)
    .join("");

const LABELS = [
  "bug",
  "enhancement",
  "documentation",
  "chore",
  "dependencies",
  "ci",
  "priority: P1",
];

const WORKFLOW = `name: Label
on: pull_request
jobs:
  label:
    runs-on: ubuntu-24.04
    steps:
      - uses: example/semantic@0000000000000000000000000000000000000000 # v1.0.0
        with:
          ignoreLabels: |
            dependencies
      - run: |
          gh pr edit 1 --add-label ci --label=bug
          gh pr edit 1 --add-label "$LABEL"
          gh pr edit 1 --remove-label stale
`;

const DEPENDABOT = `version: 2
updates:
  - package-ecosystem: "cargo"
    directory: "/"
    labels:
      - "dependencies"
  - package-ecosystem: "npm"
    directory: "/"
  - package-ecosystem: "github-actions"
    directory: "/"
    labels: []
`;

const RENOVATE = `{
  "labels": ["dependencies"],
  "packageRules": [{ "matchManagers": ["mise"], "addLabels": ["chore"] }]
}
`;

const RELEASE = `changelog:
  exclude:
    labels: ["ignore-for-release"]
  categories:
    - title: Features
      labels: [enhancement]
    - title: Fixes
      labels: [bug]
    - title: Docs
      labels: [documentation]
    - title: Maintenance
      labels: [chore]
    - title: Dependencies
      labels: [dependencies]
    - title: CI
      labels: [ci]
    - title: Other
      labels: ["*"]
`;

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(overrides: Record<string, string | undefined> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "labels-declared-"));
  dirs.push(root);
  const files: Record<string, string | undefined> = {
    ".github/labels.yml": declare([...LABELS, "ignore-for-release"]),
    ".github/ISSUE_TEMPLATE/bug.yml": 'name: Bug\nlabels: ["bug"]\nbody: []\n',
    ".github/ISSUE_TEMPLATE/task.yml": "name: Task\nlabels:\n  - chore\nbody: []\n",
    ".github/ISSUE_TEMPLATE/feature.yaml": "name: Feature\nlabels: enhancement, documentation\n",
    ".github/ISSUE_TEMPLATE/config.yml": "blank_issues_enabled: false\n",
    ".github/workflows/label.yml": WORKFLOW,
    ".github/dependabot.yml": DEPENDABOT,
    ".github/renovate.json": RENOVATE,
    ".github/release.yml": RELEASE,
    "scripts/label-pr.ts": "// its TYPE_LABELS are imported, not parsed\n",
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content !== undefined) write(root, path, content);
  }
  return root;
}

const summaries = (root: string): string[] => check.run(root).map((v) => v.summary);
const codes = (root: string): string[] => check.run(root).map((v) => v.code);

describe("labels-declared", () => {
  it("passes when every applied label is declared once and categorised", () => {
    expect(check.run(fixture())).toEqual([]);
  });

  it("passes with only labels.yml present", () => {
    const root = mkdtempSync(join(tmpdir(), "labels-declared-"));
    dirs.push(root);
    write(root, ".github/labels.yml", declare(["bug"]));
    expect(check.run(root)).toEqual([]);
  });

  describe("declarations", () => {
    it("fails on a label declared twice, naming both lines", () => {
      const root = fixture({
        ".github/labels.yml": declare([...LABELS, "ignore-for-release", "bug"]),
      });
      expect(codes(root)).toEqual(["ERR_CHECK_LABEL_DUPLICATE"]);
      expect(summaries(root)).toEqual([
        ".github/labels.yml:25 declares `bug` again (first at line 1)",
      ]);
    });

    it("fails on names that differ only in case", () => {
      const root = fixture({
        ".github/labels.yml": declare([...LABELS, "ignore-for-release", "Priority: p1"]),
      });
      expect(codes(root)).toEqual(["ERR_CHECK_LABEL_DUPLICATE"]);
    });

    it.each([
      ["not YAML", "- name: [unclosed\n"],
      ["not a list", "bug: {}\n"],
      ["an item without a name", '- color: "ededed"\n'],
    ])("fails when labels.yml is %s", (_label, text) => {
      expect(codes(fixture({ ".github/labels.yml": text }))).toContain(
        "ERR_CHECK_INPUT_UNREADABLE",
      );
    });

    it("fails when labels.yml is missing", () => {
      expect(codes(fixture({ ".github/labels.yml": undefined }))).toEqual([
        "ERR_CHECK_INPUT_MISSING",
      ]);
    });
  });

  describe("issue forms", () => {
    it.each([
      [
        "a flow list",
        'name: Bug\nlabels: [bug, "needs triage"]\n',
        ".github/ISSUE_TEMPLATE/bug.yml:2 applies `needs triage`",
      ],
      [
        "a block list",
        "name: Task\nlabels:\n  - chore\n  - question\n",
        ".github/ISSUE_TEMPLATE/bug.yml:4 applies `question`",
      ],
      [
        "a comma-separated string",
        "name: Task\nlabels: chore, wontfix\n",
        ".github/ISSUE_TEMPLATE/bug.yml:2 applies `wontfix`",
      ],
    ])("fails on an undeclared label in %s", (_label, text, summary) => {
      const root = fixture({ ".github/ISSUE_TEMPLATE/bug.yml": text });
      expect(codes(root)).toEqual(["ERR_CHECK_LABEL_UNDECLARED"]);
      expect(summaries(root)).toEqual([`${summary}, which .github/labels.yml does not declare`]);
    });

    it("fails on a form that is not YAML", () => {
      const root = fixture({ ".github/ISSUE_TEMPLATE/bug.yml": "labels: [bug\n" });
      expect(codes(root)).toEqual(["ERR_CHECK_INPUT_UNREADABLE"]);
    });
  });

  describe("workflows", () => {
    it("fails on an undeclared --add-label or --label value, skipping variables", () => {
      const workflow = WORKFLOW.replace(
        "--remove-label stale",
        "--remove-label stale\n          gh issue edit 2 --add-label 'stale,ci' --label=triaged --label $X",
      );
      const root = fixture({ ".github/workflows/label.yml": workflow });
      expect(summaries(root)).toEqual([
        ".github/workflows/label.yml:15 applies `stale`, which .github/labels.yml does not declare",
        ".github/workflows/label.yml:15 applies `triaged`, which .github/labels.yml does not declare",
      ]);
    });

    it("fails on an undeclared label in a step's labels input", () => {
      const workflow = WORKFLOW.replace(
        "ignoreLabels: |\n            dependencies",
        "labels: triage, bug",
      );
      const root = fixture({ ".github/workflows/label.yml": workflow });
      expect(summaries(root)).toEqual([
        ".github/workflows/label.yml:9 applies `triage`, which .github/labels.yml does not declare",
      ]);
    });

    it("fails on an undeclared label a step's input names in a block scalar", () => {
      const workflow = WORKFLOW.replace(
        "            dependencies",
        "            dependencies\n            renovate",
      );
      const root = fixture({ ".github/workflows/label.yml": workflow });
      expect(summaries(root)).toEqual([
        ".github/workflows/label.yml:11 applies `renovate`, which .github/labels.yml does not declare",
      ]);
    });

    it("fails on a workflow that is not YAML", () => {
      const root = fixture({ ".github/workflows/broken.yaml": "jobs: [\n" });
      expect(codes(root)).toEqual(["ERR_CHECK_INPUT_UNREADABLE"]);
    });
  });

  describe("dependency bots", () => {
    it("fails on an undeclared explicit Dependabot label", () => {
      const root = fixture({
        ".github/dependabot.yml": DEPENDABOT.replace('- "dependencies"', "- rust"),
      });
      expect(summaries(root)).toEqual([
        ".github/dependabot.yml:6 applies `rust`, which .github/labels.yml does not declare",
      ]);
    });

    it("requires `dependencies` for a Dependabot entry with no labels key", () => {
      const without = LABELS.filter((name) => name !== "dependencies");
      const root = fixture({
        ".github/labels.yml": declare([...without, "ignore-for-release"]),
        ".github/dependabot.yml": DEPENDABOT.replace('    labels:\n      - "dependencies"\n', ""),
        ".github/renovate.json": undefined,
        ".github/release.yml": RELEASE.replace("labels: [dependencies]", "labels: [chore]"),
        ".github/workflows/label.yml": undefined,
        "scripts/label-pr.ts": undefined,
      });
      expect(summaries(root)).toEqual([
        ".github/dependabot.yml:3 applies `dependencies` (Dependabot's default for an entry with no labels key), which .github/labels.yml does not declare",
        ".github/dependabot.yml:5 applies `dependencies` (Dependabot's default for an entry with no labels key), which .github/labels.yml does not declare",
      ]);
    });

    it.each([[".github/renovate.json"], ["renovate.json"]])(
      "fails on an undeclared label in %s",
      (path) => {
        const root = fixture({
          [path]: RENOVATE.replace('"addLabels": ["chore"]', '"addLabels": ["tooling"]'),
        });
        expect(summaries(root)).toEqual([
          `${path}:3 applies \`tooling\`, which .github/labels.yml does not declare`,
        ]);
      },
    );

    it("fails on a Dependabot file or Renovate file that does not parse", () => {
      expect(codes(fixture({ ".github/dependabot.yml": "updates: [\n" }))).toEqual([
        "ERR_CHECK_INPUT_UNREADABLE",
      ]);
      expect(codes(fixture({ ".github/renovate.json": "{" }))).toEqual([
        "ERR_CHECK_INPUT_UNREADABLE",
      ]);
    });
  });

  describe("label-pr and the release notes", () => {
    it("fails on a label label-pr applies that labels.yml does not declare", () => {
      const violations = findLabelViolations(fixture(), new Set(["bug", "feature"]));
      expect(violations.map((v) => v.summary)).toEqual([
        "scripts/label-pr.ts applies `feature`, which .github/labels.yml does not declare",
        "scripts/label-pr.ts applies `feature`, which no .github/release.yml category lists",
      ]);
      expect(violations.map((v) => v.code)).toEqual([
        "ERR_CHECK_LABEL_UNDECLARED",
        "ERR_CHECK_LABEL_NO_CATEGORY",
      ]);
    });

    it("fails on a label label-pr applies that no release category lists", () => {
      const root = fixture({
        ".github/release.yml": RELEASE.replace("labels: [ci]", "labels: [chore]"),
      });
      expect(codes(root)).toEqual(["ERR_CHECK_LABEL_NO_CATEGORY"]);
      expect(summaries(root)).toEqual([
        "scripts/label-pr.ts applies `ci`, which no .github/release.yml category lists",
      ]);
    });

    it("fails on every label-pr label when there is no release.yml", () => {
      const root = fixture({ ".github/release.yml": undefined });
      expect(new Set(codes(root))).toEqual(new Set(["ERR_CHECK_LABEL_NO_CATEGORY"]));
    });

    it("skips label-pr's labels when the root has no scripts/label-pr.ts", () => {
      const root = fixture({ "scripts/label-pr.ts": undefined, ".github/release.yml": undefined });
      expect(check.run(root)).toEqual([]);
    });

    it("fails on a release category naming an undeclared label", () => {
      const root = fixture({
        ".github/release.yml": RELEASE.replace("labels: [bug]", "labels: [bug, regression]"),
      });
      expect(summaries(root)).toEqual([
        ".github/release.yml:8 names `regression`, which .github/labels.yml does not declare",
      ]);
    });

    it("fails on a release.yml that does not parse", () => {
      expect(codes(fixture({ ".github/release.yml": "changelog: [\n" }))).toEqual([
        "ERR_CHECK_INPUT_UNREADABLE",
      ]);
    });
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
    expect(lines).toEqual(["check labels-declared: ok"]);
  });
});
