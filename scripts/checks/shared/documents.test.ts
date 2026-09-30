import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isFailure,
  issueTemplates,
  markdownFiles,
  repository,
  standingDocuments,
} from "./documents.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: readonly string[], contents: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "documents-"));
  dirs.push(root);
  for (const path of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents[path] ?? "");
  }
  return root;
}

describe("markdownFiles", () => {
  it("lists Markdown recursively in code-unit order, without the unchecked records", () => {
    const root = tree([
      "docs/b.md",
      "docs/Z.md",
      "docs/a/z.md",
      "docs/notes.txt",
      "docs/template/design.md",
      "docs/architecture/README.md",
      "docs/architecture/roadmap.md",
      "docs/architecture/adr/0001-x.md",
      "docs/architecture/adr/template.md",
    ]);
    expect(markdownFiles(root, "docs")).toEqual([
      "docs/Z.md",
      "docs/a/z.md",
      "docs/architecture/README.md",
      "docs/b.md",
    ]);
  });

  it("lists nothing for a directory that does not exist", () => {
    expect(markdownFiles(tree([]), "docs")).toEqual([]);
  });
});

describe("issueTemplates", () => {
  it("lists the forms and Markdown templates GitHub reads, in code-unit order", () => {
    const root = tree([
      ".github/ISSUE_TEMPLATE/task.yml",
      ".github/ISSUE_TEMPLATE/Bug.yaml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/ISSUE_TEMPLATE/legacy.md",
      ".github/ISSUE_TEMPLATE/notes.txt",
      ".github/ISSUE_TEMPLATE/drafts/old.yml",
    ]);
    expect(issueTemplates(root)).toEqual([
      ".github/ISSUE_TEMPLATE/Bug.yaml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/ISSUE_TEMPLATE/legacy.md",
      ".github/ISSUE_TEMPLATE/task.yml",
    ]);
  });

  it("lists nothing when there is no issue-template directory", () => {
    expect(issueTemplates(tree([]))).toEqual([]);
  });
});

describe("standingDocuments", () => {
  it("lists the guides, rules, sub-agents, docs, skills, and issue templates", () => {
    const root = tree([
      "README.md",
      ".claude/rules/rust.md",
      ".claude/agents/executor.md",
      ".claude/skills/demo/SKILL.md",
      "docs/guide.md",
      "docs/architecture/roadmap.md",
      ".agents/skills/demo/SKILL.md",
      ".github/ISSUE_TEMPLATE/task.yml",
      ".github/PULL_REQUEST_TEMPLATE.md",
    ]);
    expect(standingDocuments(root)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/rules/rust.md",
      ".claude/agents/executor.md",
      "docs/guide.md",
      ".agents/skills/demo/SKILL.md",
      ".github/ISSUE_TEMPLATE/task.yml",
    ]);
  });
});

describe("repository", () => {
  const CONFIG = ".github/ISSUE_TEMPLATE/config.yml";

  it("reads owner/repo from the first github.com contact link", () => {
    const root = tree([CONFIG], {
      [CONFIG]:
        "contact_links:\n  - url: https://example.com/x\n  - url: https://github.com/acme/widgets.git\n",
    });
    expect(repository(root)).toEqual({ owner: "acme", name: "widgets" });
  });

  it("fails closed when the config is missing or names no github.com URL", () => {
    const missing = repository(tree([]));
    expect(isFailure(missing) && missing.code).toBe("ERR_CHECK_INPUT_MISSING");
    const bare = repository(tree([CONFIG], { [CONFIG]: "contact_links:\n  - name: x\n" }));
    expect(isFailure(bare) && bare.code).toBe("ERR_CHECK_INPUT_UNREADABLE");
  });
});
