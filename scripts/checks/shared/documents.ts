/**
 * The documents the document checks (`just-recipes-exist`, `no-issue-references`) read,
 * listed one way for both, and the owner/repo of this repository, which tells one of its
 * own issue references from an upstream project's. Lives under `shared/`, which
 * scripts/check-harness.ts never loads as a check.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import type { FailureDetails } from "../../lib/fail.ts";
import { readRepoFile } from "../lib.ts";

/**
 * Documents neither check reads. `docs/template/` is the template's own design record: it
 * cites the upstream template's issues and plans recipes before they exist, and the
 * bootstrap deletes it. The roadmap and the ADRs are an app's own planning and decision
 * records: the roadmap links the issues behind each outcome, an ADR says where its
 * follow-ups are tracked, and both may name a recipe that is still to be written.
 */
export const UNCHECKED_DOCUMENTS: readonly string[] = [
  "docs/template",
  "docs/architecture/roadmap.md",
  "docs/architecture/adr",
];

/**
 * Every `*.md` file under `dir` (absent: none), recursively, as root-relative `/`-separated
 * paths in code-unit order, leaving out each path in UNCHECKED_DOCUMENTS and what is
 * under it.
 */
export function markdownFiles(root: string, dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .map((entry) => ({ entry, path: `${dir}/${entry.name}` }))
    .filter(({ path }) => !UNCHECKED_DOCUMENTS.includes(path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .flatMap(({ entry, path }) => {
      if (entry.isDirectory()) return markdownFiles(root, path);
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    });
}

/** Where GitHub reads the issue forms and templates a filer, human or agent, follows. */
export const ISSUE_TEMPLATES = ".github/ISSUE_TEMPLATE";

/**
 * The files directly in ISSUE_TEMPLATES (absent: none) that GitHub reads — the `*.yml` and
 * `*.yaml` issue forms, `config.yml` among them, and `*.md` templates — as root-relative
 * paths in code-unit order. GitHub reads no subdirectory there, so neither does this.
 */
export function issueTemplates(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, ISSUE_TEMPLATES), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.(?:md|ya?ml)$/.test(entry.name))
    .map((entry) => `${ISSUE_TEMPLATES}/${entry.name}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The documents an agent reads as standing instructions, which both document checks read:
 * `AGENTS.md`, `CLAUDE.md`, every `*.md` under `.claude/rules/`, `.claude/agents/` (the
 * sub-agent definitions), `docs/`, and `.agents/skills/` (UNCHECKED_DOCUMENTS aside), and
 * the issue templates. Every one is optional here; a check that needs one says so itself.
 */
export function standingDocuments(root: string): string[] {
  return [
    "AGENTS.md",
    "CLAUDE.md",
    ...markdownFiles(root, ".claude/rules"),
    ...markdownFiles(root, ".claude/agents"),
    ...markdownFiles(root, "docs"),
    ...markdownFiles(root, ".agents/skills"),
    ...issueTemplates(root),
  ];
}

/** Where the repository's own GitHub URL is read: a file the bootstrap rewrites. */
export const REPOSITORY_SOURCE = `${ISSUE_TEMPLATES}/config.yml`;

/** This repository on GitHub, as `owner/repo`. */
export interface Repository {
  readonly owner: string;
  readonly name: string;
}

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:\/|$)/;

/**
 * This repository's owner and name, from the first `contact_links` URL on github.com in
 * REPOSITORY_SOURCE (the security-advisory link), or the failure that says why it could
 * not be read. A check that needs it fails closed on that failure rather than guessing.
 */
export function repository(root: string): Repository | FailureDetails {
  const text = readRepoFile(root, REPOSITORY_SOURCE);
  const failure = (actual: string): FailureDetails => ({
    code: text === undefined ? "ERR_CHECK_INPUT_MISSING" : "ERR_CHECK_INPUT_UNREADABLE",
    summary: `cannot tell this repository's owner/repo from ${REPOSITORY_SOURCE}`,
    expected: `${REPOSITORY_SOURCE} with a \`contact_links\` entry whose \`url\` is https://github.com/<owner>/<repo>/…`,
    actual,
    next: `restore ${REPOSITORY_SOURCE} from version control (the bootstrap rewrites its URL to the new repository)`,
  });
  if (text === undefined) return failure("no such file");
  let config: unknown;
  try {
    config = parse(text);
  } catch (error: unknown) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  const links: unknown =
    typeof config === "object" && config !== null && "contact_links" in config
      ? config.contact_links
      : undefined;
  const list: unknown[] = Array.isArray(links) ? links : [];
  for (const link of list) {
    const url: unknown =
      typeof link === "object" && link !== null && "url" in link ? link.url : undefined;
    const match = typeof url === "string" ? GITHUB_URL.exec(url) : null;
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], name: match[2].replace(/\.git$/, "") };
    }
  }
  return failure("no `contact_links` url on https://github.com/<owner>/<repo>");
}

/** Whether a value `repository` returned is the failure rather than the repository. */
export function isFailure(value: Repository | FailureDetails): value is FailureDetails {
  return "code" in value;
}
