import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isFailure, markdownFiles, repository } from "./documents.ts";

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
