import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, main } from "./no-issue-references.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Everything here is allowed: link anchors, hex colors, an HTML entity, and `#N`.
const CLEAN = `# Guide

See [Skills](#skills), [step 4](#4-review-the-branch), and
[step 8c](../SKILL.md#8c-take-the-runs-own-output-back-into-the-queue).
Colors: \`#0366d6\`, \`#000000\`, \`#11223344\`, \`color: #000;\`. An entity: &#123;.
A body says \`Closes #N\` and \`Depends on #N\`.
`;

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(overrides: Record<string, string | undefined> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "no-issue-references-"));
  dirs.push(root);
  const files: Record<string, string | undefined> = {
    "AGENTS.md": CLEAN,
    ".agents/skills/demo/SKILL.md": CLEAN,
    ".agents/skills/demo/references/more.md": CLEAN,
    // Only Markdown is read: code may cite an issue.
    ".agents/skills/demo/scripts/plan.py": "# See issue #139.\n",
    // Only AGENTS.md and the skills are read.
    "README.md": "Fixed in #12.\n",
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content !== undefined) write(root, path, content);
  }
  return root;
}

describe("no-issue-references", () => {
  it("passes on anchors, colors, entities, and placeholders", () => {
    expect(check.run(fixture())).toEqual([]);
  });

  it("passes when there is neither an AGENTS.md nor a skills tree", () => {
    const root = mkdtempSync(join(tmpdir(), "no-issue-references-"));
    dirs.push(root);
    expect(check.run(root)).toEqual([]);
  });

  it.each([
    ["AGENTS.md", "Excluded from typos (issue #139).", "#139"],
    [".agents/skills/demo/SKILL.md", "The staged guard (#42) refuses it.", "#42"],
    [".agents/skills/demo/references/more.md", "Upstream tracks it in owner/repo#7.", "#7"],
    [".agents/skills/demo/references/deep/x.md", "Closes #12", "#12"],
  ])("reports a reference in %s with its line", (path, text, ref) => {
    const violations = check.run(fixture({ [path]: `# Title\n\n${text}\n` }));
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_ISSUE_REFERENCE"]);
    expect(violations[0]?.summary).toBe(`${path}:3 cites \`${ref}\``);
  });

  it("reports every reference on a line", () => {
    const violations = check.run(fixture({ "AGENTS.md": "See #1, #2 and #3.\n" }));
    expect(violations.map((v) => v.summary)).toEqual([
      "AGENTS.md:1 cites `#1`",
      "AGENTS.md:1 cites `#2`",
      "AGENTS.md:1 cites `#3`",
    ]);
  });

  it("reads code spans and blocks too", () => {
    const violations = check.run(fixture({ "AGENTS.md": "```bash\ngh issue view #321\n```\n" }));
    expect(violations.map((v) => v.summary)).toEqual(["AGENTS.md:2 cites `#321`"]);
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
    expect(lines).toEqual(["check no-issue-references: ok"]);
  });
});
