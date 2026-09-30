import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, main } from "./just-recipes-exist.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JUSTFILE = `set shell := ["bash", "-c"]
app_name := "Widget"
export FOO := "bar"
alias b := build

# Build it.
build:
    echo build

[private]
_helper:
    echo helper

test-fast filter:
    echo {{filter}}

release-prep version *flags:
    echo {{version}}

@quiet:
    echo quiet
`;

const AGENTS = `# Guide

Run \`just build\`, then \`just test-fast <filter>\`; \`just --list\` lists them, and
\`just <recipe>\` is a placeholder. English prose is never read: just bogus-prose.
A code span may wrap: \`mise exec -- just
quiet\`, and \`adjust nothing\` is not a token.

\`\`\`bash
just build        # build it
just release-prep 0.2.0
just b && just _helper
\`\`\`
`;

const SETTINGS = `{
  "permissions": {
    "allow": ["Bash(just build)", "Bash(just test-fast:*)", "Bash(git status)", "Bash(just:*)"],
    "deny": ["Bash(just quiet)"]
  },
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "just nothing-here" }] }]
  }
}
`;

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(overrides: Record<string, string | undefined> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "just-recipes-exist-"));
  dirs.push(root);
  const files: Record<string, string | undefined> = {
    justfile: JUSTFILE,
    "AGENTS.md": AGENTS,
    "README.md": "# Readme\n\n`just quiet`\n",
    "CONTRIBUTING.md": "# Contributing\n\n~~~sh\njust build\n~~~\n",
    "docs/guide.md": "Run `just build`.\n",
    "docs/design/system.md": "Check it with `just quiet`.\n",
    "docs/template/plan.md": "A planned `just not-yet` (docs/template/ is not read).\n",
    "CLAUDE.md": "# Claude\n\nThe hook runs `just build`.\n",
    ".claude/rules/docs.md": "---\npaths:\n  - docs/**\n---\n\n- Run `just build`.\n",
    ".github/PULL_REQUEST_TEMPLATE.md": "## Test Plan\n\n- [ ] `just build` passes\n",
    ".agents/skills/demo/SKILL.md": "---\nname: demo\n---\n\nRun `just build`.\n",
    ".agents/skills/demo/references/more.md": "Iterate with `just test-fast x`.\n",
    ".agents/skills/demo/scripts/run.sh": "just not-markdown\n",
    ".claude/settings.json": SETTINGS,
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content !== undefined) write(root, path, content);
  }
  return root;
}

function lineOf(text: string, needle: string): number {
  return text.split("\n").findIndex((line) => line.includes(needle)) + 1;
}

describe("just-recipes-exist", () => {
  it("passes when every referenced recipe and permitted recipe exists", () => {
    expect(check.run(fixture())).toEqual([]);
  });

  it("passes without .claude/settings.json or any document but AGENTS.md", () => {
    const root = fixture({
      ".claude/settings.json": undefined,
      "README.md": undefined,
      "CONTRIBUTING.md": undefined,
      "CLAUDE.md": undefined,
      ".github/PULL_REQUEST_TEMPLATE.md": undefined,
    });
    expect(check.run(root)).toEqual([]);
  });

  it("fails when there is no AGENTS.md, rather than passing on nothing", () => {
    const violations = check.run(fixture({ "AGENTS.md": undefined }));
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_INPUT_MISSING"]);
    expect(violations[0]?.summary).toBe("there is no AGENTS.md");
  });

  it("reports a missing recipe in an inline code span, with its line", () => {
    const agents = `${AGENTS}\nThen run \`just bogus\`.\n`;
    const violations = check.run(fixture({ "AGENTS.md": agents }));
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_RECIPE_MISSING"]);
    expect(violations[0]?.summary).toContain(`AGENTS.md:${String(lineOf(agents, "`just bogus`"))}`);
    expect(violations[0]?.summary).toContain("`just bogus`");
  });

  it("reports the second recipe of a chain", () => {
    const readme = "`just build && just bogus-two`\n";
    const violations = check.run(fixture({ "README.md": readme }));
    expect(violations.map((v) => v.summary)).toEqual([
      "README.md:1 names `just bogus-two`, which the justfile does not define",
    ]);
  });

  it("reports every line of a fenced block", () => {
    const contributing = "# C\n\n```bash\njust build\njust bogus-three  # comment\n```\n";
    const violations = check.run(fixture({ "CONTRIBUTING.md": contributing }));
    expect(violations.map((v) => v.summary)).toEqual([
      "CONTRIBUTING.md:5 names `just bogus-three`, which the justfile does not define",
    ]);
  });

  it("reads a fenced line only where `just` starts a command", () => {
    const readme = [
      "```",
      "Its CI just failed: fix it.",
      "pnpm lint  # just bogus-comment",
      'run --verify "just bogus-quoted"',
      "FOO=1 just bogus-env && mise exec -- just bogus-dashes",
      "```",
    ].join("\n");
    expect(check.run(fixture({ "README.md": readme })).map((v) => v.summary)).toEqual([
      "README.md:3 names `just bogus-comment`, which the justfile does not define",
      "README.md:4 names `just bogus-quoted`, which the justfile does not define",
      "README.md:5 names `just bogus-env`, which the justfile does not define",
      "README.md:5 names `just bogus-dashes`, which the justfile does not define",
    ]);
  });

  it("reads to the end of the file when a fence is never closed", () => {
    const readme = "````md\n```\njust bogus-open\n";
    expect(check.run(fixture({ "README.md": readme })).map((v) => v.code)).toEqual([
      "ERR_CHECK_RECIPE_MISSING",
    ]);
  });

  it.each([
    ["docs/*.md", "docs/other.md"],
    ["a docs/ subdirectory", "docs/design/x.md"],
    ["a docs/architecture page", "docs/architecture/overview.md"],
    ["CLAUDE.md", "CLAUDE.md"],
    ["a Claude Code rule", ".claude/rules/x.md"],
    ["the pull request template", ".github/PULL_REQUEST_TEMPLATE.md"],
    ["a SKILL.md", ".agents/skills/demo/SKILL.md"],
    ["a skill's reference file", ".agents/skills/demo/references/deep/more.md"],
  ])("reads %s", (_label, path) => {
    const violations = check.run(fixture({ [path]: "Run `just bogus-four`.\n" }));
    expect(violations.map((v) => v.summary)).toEqual([
      `${path}:1 names \`just bogus-four\`, which the justfile does not define`,
    ]);
  });

  it("reads neither docs/template/, the roadmap, nor an ADR, which plan recipes ahead", () => {
    const root = fixture({
      "docs/template/deep/x.md": "Run `just bogus-template`.\n",
      "docs/architecture/roadmap.md": "Done when `just export-csv` passes.\n",
      "docs/architecture/adr/0002-export.md": "Adds a `just export-csv` recipe.\n",
    });
    expect(check.run(root)).toEqual([]);
  });

  it("never pairs backticks across a blank line", () => {
    const readme = "A stray ` backtick.\n\n`just bogus-five`\n";
    expect(check.run(fixture({ "README.md": readme })).map((v) => v.summary)).toEqual([
      "README.md:3 names `just bogus-five`, which the justfile does not define",
    ]);
  });

  it("reads a double-backtick code span", () => {
    const readme = "``just `x` bogus-six`` and ``just bogus-seven``\n";
    expect(check.run(fixture({ "README.md": readme })).map((v) => v.summary)).toEqual([
      "README.md:1 names `just bogus-seven`, which the justfile does not define",
    ]);
  });

  it("reports a permission rule for a recipe the justfile lacks, with its line", () => {
    const settings = SETTINGS.replace(
      '"deny": [',
      '"ask": ["Bash(just bogus-rule --flag)"],\n    "deny": [',
    );
    const violations = check.run(fixture({ ".claude/settings.json": settings }));
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_PERMISSION_RECIPE_MISSING"]);
    expect(violations[0]?.summary).toBe(
      `.claude/settings.json:${String(lineOf(settings, "bogus-rule"))} permits \`just bogus-rule\`, which the justfile does not define`,
    );
  });

  it("fails on a .claude/settings.json that is not JSON", () => {
    const violations = check.run(fixture({ ".claude/settings.json": "{ nope" }));
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_INPUT_UNREADABLE"]);
  });

  it("reads no rule from a settings file without a permissions object", () => {
    const root = fixture({ ".claude/settings.json": '{ "permissions": ["Bash(just bogus)"] }' });
    expect(check.run(root)).toEqual([]);
  });

  it("fails when there is no justfile", () => {
    const violations = check.run(fixture({ justfile: undefined }));
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_INPUT_MISSING"]);
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
    expect(lines).toEqual(["check just-recipes-exist: ok"]);
  });
});
