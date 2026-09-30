/**
 * No reference to this repository's issues or pull requests in a document an agent reads
 * as standing instructions. An agent reading "see #139" cannot open the issue
 * offline, and a repository cut from the template has different issues under the same
 * numbers, so the text states the rule and its reason itself instead of pointing at one.
 *
 *   node scripts/checks/no-issue-references.ts [--root DIR]
 *
 * Read: `AGENTS.md`, `CLAUDE.md`, and every `*.md` under `.claude/rules/`, `docs/`, and
 * `.agents/skills/` (prose, code spans, and code blocks alike). Not read: a skill's scripts
 * and tests, which are code, and the planning and decision records (`docs/template/`, the
 * template's design record the bootstrap deletes; the roadmap, which links the issues
 * behind each outcome; and the ADRs, which say where a follow-up is tracked), listed in
 * `shared/documents.ts`'s UNCHECKED_DOCUMENTS.
 *
 * A reference is any of:
 * - `#` then digits (`#139`, `owner/repo#7`);
 * - an issue, pull-request, or merge-request URL (`…/issues/139`, `…/pull/12`) on this
 *   repository or relative to it. An upstream project's (another owner/repo on github.com,
 *   or another host) is a source for an external claim and is not a reference. This
 *   repository's owner/repo is read from `.github/ISSUE_TEMPLATE/config.yml`, which the
 *   bootstrap rewrites; when it cannot be read the check fails rather than guess;
 * - the word issue, PR, pull request, or merge request before a number (`issue 166`,
 *   `PR-4`, `issue number 12`, `issue no. 12`);
 * - `GH-` then digits (`GH-12`);
 * - a `gh issue` or `gh pr` command given a number (`gh issue view 19`, `gh pr checks 12`).
 * Not a reference: a Markdown link anchor (`#4-review-the-branch`, `SKILL.md#8c-...`, where
 * a letter or `-` follows the digits), an HTML entity (`&#123;`), a six- or eight-digit hex
 * color (`#000000`), a three- or four-digit one followed by `;` (`color: #000;`), and a
 * placeholder (`#N`, `issue <n>`, `gh issue view {n}`). Every document is optional. No git
 * work tree needed.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_INPUT_MISSING and ERR_CHECK_INPUT_UNREADABLE (this
 * repository's owner/repo cannot be read), ERR_CHECK_ISSUE_REFERENCE.
 */
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import { isFailure, markdownFiles, repository, type Repository } from "./shared/documents.ts";

const HASH = /(?<!&)#(\d+)(?![\w-])/g;
/** A URL, absolute or relative, whose path ends in an issue or pull-request number. */
const URL = /[^\s()<>[\]"'`]*\/(?:issues|pulls?|-\/merge_requests|merge_requests)\/\d+(?!\w)/g;
/** The spellings that name no URL; none can also match HASH or URL, so each is one report. */
const WORD_FORMS = [
  /\b(?:issues?|PRs?|pull[ -]requests?|merge[ -]requests?)(?:[ -]?|\s+(?:numbers?|no\.)\s*)\d+(?!\w)/gi,
  /\bGH-\d+(?!\w)/gi,
  /\bgh\s+(?:issue|pr)\s+[a-z][a-z-]*\s+\d+(?!\w)/g,
];

function isColor(digits: string, after: string): boolean {
  return (
    digits.length === 6 ||
    digits.length === 8 ||
    ((digits.length === 3 || digits.length === 4) && after.startsWith(";"))
  );
}

/**
 * Whether an issue or pull-request URL points at this repository: a github.com URL whose
 * owner/repo is this one, or a relative link, which GitHub resolves against this one.
 */
function isOwnUrl(url: string, own: Repository): boolean {
  // A host is a dotted name ending in letters, so a relative `../../issues/3` has none.
  const hosted =
    /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})\/([^/]+)\/([^/]+)\//i.exec(url);
  if (hosted === null) return true;
  const [, host = "", owner = "", name = ""] = hosted;
  if (!/^(?:www\.)?github\.com$/i.test(host)) return false;
  return (
    owner.toLowerCase() === own.owner.toLowerCase() && name.toLowerCase() === own.name.toLowerCase()
  );
}

/** Every reference on one line, in the order they appear. */
function references(line: string, own: Repository): { index: number; text: string }[] {
  const found: { index: number; text: string }[] = [];
  for (const match of line.matchAll(HASH)) {
    if (isColor(match[1] ?? "", line.slice(match.index + match[0].length))) continue;
    found.push({ index: match.index, text: match[0] });
  }
  for (const match of line.matchAll(URL)) {
    if (isOwnUrl(match[0], own)) found.push({ index: match.index, text: match[0] });
  }
  for (const form of WORD_FORMS) {
    for (const match of line.matchAll(form)) found.push({ index: match.index, text: match[0] });
  }
  return found.sort((a, b) => a.index - b.index);
}

function run(root: string): FailureDetails[] {
  const own = repository(root);
  if (isFailure(own)) return [own];
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
      for (const { text: reference } of references(line, own)) {
        violations.push({
          code: "ERR_CHECK_ISSUE_REFERENCE",
          summary: `${path}:${String(index + 1)} cites \`${reference}\``,
          expected: `no reference to an issue or pull request of ${own.owner}/${own.name} in a standing document an agent reads: the text carries the rule and its reason itself`,
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
