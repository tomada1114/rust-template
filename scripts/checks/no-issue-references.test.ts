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

// Everything here is allowed: link anchors, hex colors, an HTML entity, placeholders, and
// an upstream project's issue, cited as a source by URL or by owner/repo#N.
const CLEAN = `# Guide

See [Skills](#skills), [step 4](#4-review-the-branch), and
[step 8c](../SKILL.md#8c-take-the-runs-own-output-back-into-the-queue).
Colors: \`#0366d6\`, \`#000000\`, \`#11223344\`, \`color: #000;\`. An entity: &#123;.
A body says \`Closes #N\` and \`Depends on #N\`.
Words that are not references: an issue-number rule, issues and PRs in general, the
\`gh issue view\` command, \`gh issue view <n>\`, \`gh pr view {n}\`, \`issue <n>\`,
\`/issues/new\`, a GH-hosted runner, and the v2 release.
Sources: https://github.com/tauri-apps/tauri/issues/139 and
[an upstream fix](https://github.com/Other/widgets/pull/12), and
<https://gitlab.com/group/project/-/merge_requests/3>. Upstream shorthand:
tauri-apps/tauri#1234, (other/repo#12), \`Other-Org/some.repo_x#5\`.
`;

// An issue form, which is YAML: a comment and a placeholder, neither a reference.
const FORM = `# Issue form: GitHub renders these strings as Markdown.
name: Task
body:
  - type: input
    attributes:
      label: Dependencies
      placeholder: "Depends on: #N"
`;

// This repository, as the issue-template config names it.
const CONFIG = `blank_issues_enabled: false
contact_links:
  - name: Discussions
    url: https://example.com/forum
  - name: Report a security vulnerability
    url: https://github.com/acme/widgets/security/advisories/new
`;

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(overrides: Record<string, string | undefined> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "no-issue-references-"));
  dirs.push(root);
  const files: Record<string, string | undefined> = {
    ".github/ISSUE_TEMPLATE/config.yml": CONFIG,
    "AGENTS.md": CLEAN,
    ".agents/skills/demo/SKILL.md": CLEAN,
    ".agents/skills/demo/references/more.md": CLEAN,
    // Only Markdown is read: code may cite an issue.
    ".agents/skills/demo/scripts/plan.py": "# See issue #139.\n",
    "CLAUDE.md": CLEAN,
    ".claude/rules/docs.md": CLEAN,
    ".claude/agents/executor.md": CLEAN,
    ".github/ISSUE_TEMPLATE/task.yml": FORM,
    ".github/ISSUE_TEMPLATE/legacy.md": CLEAN,
    // GitHub reads neither a subdirectory of the issue templates nor another extension.
    ".github/ISSUE_TEMPLATE/drafts/old.yml": "Fixed in #12.\n",
    ".github/ISSUE_TEMPLATE/notes.txt": "Fixed in #12.\n",
    "docs/guide.md": CLEAN,
    "docs/design/system.md": CLEAN,
    "docs/architecture/README.md": CLEAN,
    // Planning and decision records link their issues, and are not read.
    "docs/template/design.md": "Decided in #140 (issue 166).\n",
    "docs/architecture/roadmap.md":
      "- **Sync** — Issues: [#12](https://github.com/acme/widgets/issues/12), #13.\n",
    "docs/architecture/adr/0001-design-lock.md":
      "## Follow-ups\n\n- Tokens: tracked in https://github.com/acme/widgets/issues/14.\n",
    // Only the agent-read documents are read.
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

  it("passes when there is no document at all", () => {
    const root = mkdtempSync(join(tmpdir(), "no-issue-references-"));
    dirs.push(root);
    write(root, ".github/ISSUE_TEMPLATE/config.yml", CONFIG);
    expect(check.run(root)).toEqual([]);
  });

  it.each([
    ["is missing", undefined, "ERR_CHECK_INPUT_MISSING"],
    ["is not YAML", "contact_links: [\n", "ERR_CHECK_INPUT_UNREADABLE"],
    [
      "names no github.com URL",
      "contact_links:\n  - url: https://example.com/x\n",
      "ERR_CHECK_INPUT_UNREADABLE",
    ],
    ["has no contact links", "blank_issues_enabled: false\n", "ERR_CHECK_INPUT_UNREADABLE"],
  ])("fails closed when the issue-template config %s", (_label, config, code) => {
    const violations = check.run(fixture({ ".github/ISSUE_TEMPLATE/config.yml": config }));
    expect(violations.map((v) => v.code)).toEqual([code]);
    expect(violations[0]?.summary).toContain("owner/repo");
  });

  it("still reads a normal docs/ page beside the roadmap and the ADRs", () => {
    const text = "Tracked in https://github.com/acme/widgets/issues/14.\n";
    const violations = check.run(fixture({ "docs/architecture/overview.md": text }));
    expect(violations.map((v) => v.summary)).toEqual([
      "docs/architecture/overview.md:1 cites `https://github.com/acme/widgets/issues/14`",
    ]);
  });

  it.each([
    ["AGENTS.md", "Excluded from typos (issue #139).", "#139"],
    [".agents/skills/demo/SKILL.md", "The staged guard (#42) refuses it.", "#42"],
    [".agents/skills/demo/references/more.md", "Tracked here in acme/widgets#7.", "acme/widgets#7"],
    [".agents/skills/demo/references/deep/x.md", "Closes #12", "#12"],
    ["CLAUDE.md", "The hook changed in #88.", "#88"],
    [".claude/rules/x.md", "Banned since #5.", "#5"],
    ["docs/x.md", "Decided in #31.", "#31"],
    ["docs/architecture/README.md", "Indexed in #31.", "#31"],
    [".claude/agents/x.md", "see #12", "#12"],
    [".github/ISSUE_TEMPLATE/bug_report.yml", "description: see #12", "#12"],
    [".github/ISSUE_TEMPLATE/feature.yaml", "description: see #12", "#12"],
    [".github/ISSUE_TEMPLATE/legacy.md", "see #12", "#12"],
  ])("reports a reference in %s with its line", (path, text, ref) => {
    const violations = check.run(fixture({ [path]: `# Title\n\n${text}\n` }));
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_ISSUE_REFERENCE"]);
    expect(violations[0]?.summary).toBe(`${path}:3 cites \`${ref}\``);
  });

  it.each([
    [
      "an issue URL on this repository",
      "See https://github.com/acme/widgets/issues/139.",
      "https://github.com/acme/widgets/issues/139",
    ],
    [
      "a pull-request URL on this repository, in another case",
      "Landed in [it](https://www.github.com/Acme/Widgets/pull/12/files).",
      "https://www.github.com/Acme/Widgets/pull/12",
    ],
    ["a relative issue link", "See [it](../../issues/3).", "../../issues/3"],
    ["the word issue", "Brought under the cap (issue 166).", "issue 166"],
    ["issue number N", "Settled by issue number 12.", "issue number 12"],
    ["issue no. N", "Settled by issue no. 12.", "issue no. 12"],
    ["a gh issue command", "Read it with `gh issue view 19`.", "gh issue view 19"],
    ["a gh pr command", "Watch `gh pr checks 12 --watch`.", "gh pr checks 12"],
    ["a capitalised Issue", "Issue 7 decided it.", "Issue 7"],
    ["a PR number", "Reverted by PR-4.", "PR-4"],
    ["a pull request number", "Per pull request 9.", "pull request 9"],
    ["a GH- reference", "Fixed by GH-12.", "GH-12"],
  ])("reports %s", (_label, text, ref) => {
    const violations = check.run(fixture({ "docs/x.md": `# Title\n\n${text}\n` }));
    expect(violations.map((v) => v.summary)).toEqual([`docs/x.md:3 cites \`${ref}\``]);
  });

  it("treats an upstream owner/repo#N like its URL, and this repository's as a reference", () => {
    const config = CONFIG.replace("acme/widgets", "tomada1114/tauri-template");
    const text = [
      "Upstream: other/repo#12 and acme/widgets#12.",
      "Bare: #12.",
      "This repository: tomada1114/tauri-template#12 and Tomada1114/Tauri-Template#13.",
      "A path is not an owner/repo: docs/a/b#14.",
    ].join("\n");
    const root = fixture({ ".github/ISSUE_TEMPLATE/config.yml": config, "AGENTS.md": text });
    expect(check.run(root).map((v) => v.summary)).toEqual([
      "AGENTS.md:2 cites `#12`",
      "AGENTS.md:3 cites `tomada1114/tauri-template#12`",
      "AGENTS.md:3 cites `Tomada1114/Tauri-Template#13`",
      "AGENTS.md:4 cites `#14`",
    ]);
  });

  it("reports this repository's owner/repo#N even where a bare one would be a color", () => {
    const violations = check.run(fixture({ "AGENTS.md": "See acme/widgets#123456.\n" }));
    expect(violations.map((v) => v.summary)).toEqual(["AGENTS.md:1 cites `acme/widgets#123456`"]);
  });

  it("reports the references on a line in the order they appear", () => {
    const violations = check.run(
      fixture({ "CLAUDE.md": "GH-1, then https://github.com/acme/widgets/issues/2, then #3.\n" }),
    );
    expect(violations.map((v) => v.summary)).toEqual([
      "CLAUDE.md:1 cites `GH-1`",
      "CLAUDE.md:1 cites `https://github.com/acme/widgets/issues/2`",
      "CLAUDE.md:1 cites `#3`",
    ]);
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
