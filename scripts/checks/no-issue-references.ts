/**
 * No issue-number reference in `AGENTS.md` or a skill (design D14). An agent reading
 * "see #139" cannot open the issue offline, and a repository cut from the template has
 * different issues under the same numbers, so the text states the rule and its reason
 * itself instead of pointing at an issue.
 *
 *   node scripts/checks/no-issue-references.ts [--root DIR]
 *
 * Read: `AGENTS.md` and every `*.md` under `.agents/skills/` (prose, code spans, and code
 * blocks alike). A skill's scripts and tests are code and are not read. A reference is `#`
 * then digits, as in `#139` or `owner/repo#7`. Not a reference: a Markdown link anchor
 * (`#4-review-the-branch`, `SKILL.md#8c-...`, where a letter or `-` follows the digits),
 * an HTML entity (`&#123;`), a six- or eight-digit hex color (`#000000`), a three- or
 * four-digit one followed by `;` (`color: #000;`), and the placeholder `#N`. Both files
 * are optional. No git work tree needed.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_ISSUE_REFERENCE.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const REFERENCE = /(?<!&)#(\d+)(?![\w-])/g;

function isColor(digits: string, after: string): boolean {
  return (
    digits.length === 6 ||
    digits.length === 8 ||
    ((digits.length === 3 || digits.length === 4) && after.startsWith(";"))
  );
}

function markdownFiles(root: string, dir: string): string[] {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return markdownFiles(root, path);
        return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
      });
  } catch {
    return [];
  }
}

function run(root: string): FailureDetails[] {
  const violations: FailureDetails[] = [];
  for (const path of ["AGENTS.md", ...markdownFiles(root, ".agents/skills")]) {
    const text = readRepoFile(root, path);
    if (text === undefined) continue;
    text.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(REFERENCE)) {
        const digits = match[1] ?? "";
        if (isColor(digits, line.slice(match.index + match[0].length))) continue;
        violations.push({
          code: "ERR_CHECK_ISSUE_REFERENCE",
          summary: `${path}:${String(index + 1)} cites \`${match[0]}\``,
          expected:
            "no issue-number reference in AGENTS.md or a skill: the text carries the rule and its reason itself",
          actual: line.trim(),
          next: `rewrite the sentence in ${path} to state what the issue decided, and drop the number`,
        });
      }
    });
  }
  return violations;
}

export const check: Check = { name: "no-issue-references", run };
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
