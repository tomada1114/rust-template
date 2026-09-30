/**
 * No issue-number reference in a document an agent reads as standing instructions (design
 * D14). An agent reading "see #139" cannot open the issue offline, and a repository cut
 * from the template has different issues under the same numbers, so the text states the
 * rule and its reason itself instead of pointing at an issue.
 *
 *   node scripts/checks/no-issue-references.ts [--root DIR]
 *
 * Read: `AGENTS.md`, `CLAUDE.md`, and every `*.md` under `.claude/rules/`, `docs/`, and
 * `.agents/skills/` (prose, code spans, and code blocks alike). Not read: `docs/template/`,
 * the template's own design record, which cites the upstream template's issues and which
 * the bootstrap deletes; and a skill's scripts and tests, which are code.
 *
 * A reference is any of: `#` then digits (`#139`, `owner/repo#7`); an issue or pull-request
 * URL path (`/issues/139`, `/pull/12`, GitLab's `/-/merge_requests/3`); the word issue,
 * PR, pull request, or merge request followed by a number (`issue 166`, `PR-4`); and
 * `GH-12`. Not a reference: a Markdown link anchor (`#4-review-the-branch`,
 * `SKILL.md#8c-...`, where a letter or `-` follows the digits), an HTML entity (`&#123;`),
 * a six- or eight-digit hex color (`#000000`), a three- or four-digit one followed by `;`
 * (`color: #000;`), and the placeholder `#N`. Every file is optional. No git work tree
 * needed.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_ISSUE_REFERENCE.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const HASH = /(?<!&)#(\d+)(?![\w-])/g;
/** The other spellings; none can also match HASH, so a reference is reported once. */
const OTHER_FORMS = [
  /\/(?:issues|pull|pulls|merge_requests)\/\d+(?!\w)/g,
  /\b(?:issues?|PRs?|pull[ -]requests?|merge[ -]requests?)[ -]?\d+(?!\w)/gi,
  /\bGH-\d+(?!\w)/gi,
];
/** Under `docs/`, not read: the template's design record. */
const SKIPPED = new Set(["docs/template"]);

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
        if (entry.isDirectory()) return SKIPPED.has(path) ? [] : markdownFiles(root, path);
        return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
      });
  } catch {
    return [];
  }
}

/** Every reference on one line, in the order they appear. */
function references(line: string): { index: number; text: string }[] {
  const found: { index: number; text: string }[] = [];
  for (const match of line.matchAll(HASH)) {
    if (isColor(match[1] ?? "", line.slice(match.index + match[0].length))) continue;
    found.push({ index: match.index, text: match[0] });
  }
  for (const form of OTHER_FORMS) {
    for (const match of line.matchAll(form)) found.push({ index: match.index, text: match[0] });
  }
  return found.sort((a, b) => a.index - b.index);
}

function run(root: string): FailureDetails[] {
  const violations: FailureDetails[] = [];
  const paths = [
    "AGENTS.md",
    "CLAUDE.md",
    ...markdownFiles(root, ".claude/rules"),
    ...markdownFiles(root, "docs"),
    ...markdownFiles(root, ".agents/skills"),
  ];
  for (const path of paths) {
    const text = readRepoFile(root, path);
    if (text === undefined) continue;
    text.split("\n").forEach((line, index) => {
      for (const { text: reference } of references(line)) {
        violations.push({
          code: "ERR_CHECK_ISSUE_REFERENCE",
          summary: `${path}:${String(index + 1)} cites \`${reference}\``,
          expected:
            "no issue or pull-request reference in a standing document an agent reads: the text carries the rule and its reason itself",
          actual: line.trim(),
          next: `rewrite the sentence in ${path} to state what the issue decided, and drop the reference`,
        });
      }
    });
  }
  return violations;
}

export const check: Check = { name: "no-issue-references", run };
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
