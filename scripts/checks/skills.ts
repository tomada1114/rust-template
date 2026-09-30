/**
 * Every skill under `.agents/skills/` loads in both Claude Code and Codex CLI, and
 * `AGENTS.md`'s Skills table indexes exactly those skills. A skill with a
 * stray key, a mismatched name, or a value Codex CLI's strict YAML parser rejects mirrors
 * cleanly and then silently never loads; one with no row is never found by a reader.
 *
 *   node scripts/checks/skills.ts [--root DIR]
 *
 * For each directory `.agents/skills/<dir>/` (`.claude/skills/` is its byte-identical
 * mirror, checked by `just agents-check`):
 *   - `<dir>/SKILL.md` opens with a `---` line and a later `---` line closes the block;
 *     the block parses as strict YAML (the `yaml` package, duplicate keys rejected) into
 *     a mapping of exactly `name` and `description`. This approximates Codex CLI's own
 *     YAML parser, which this check does not run: strict `yaml` is a proxy that rejects
 *     the failures seen so far, and a value it accepts may still fail under Codex CLI
 *     (or the reverse). A skill found not to load there gets a fixture and a rule here;
 *   - `name` is a string equal to `<dir>`: lowercase letters, digits, and single hyphens,
 *     at most 64 characters (the Agent Skills format);
 *   - `description` is a non-empty string of printable ASCII (tab and newline allowed),
 *     at most 1,024 characters once trailing whitespace is dropped, and neither value
 *     carries a trailing YAML comment (an unquoted ` #` silently cuts the value short);
 *   - no file named `SKILL.md` exists below `<dir>/` other than `<dir>/SKILL.md`;
 *   - the body after the closing `---` is at most 200 lines;
 *   - nothing under `.agents/skills/` is a symbolic link (links are not followed).
 * The index is the first table (lines starting with `|`) after `AGENTS.md`'s `## Skills`
 * heading and before the next heading, fenced code skipped; each row's first cell, with
 * backticks stripped, names one skill, and the rows and the directories must agree.
 *
 * Git work tree: not required; the check reads files under --root.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_INPUT_MISSING (no AGENTS.md or .agents/skills/),
 * ERR_CHECK_SKILL_FRONTMATTER, ERR_CHECK_SKILL_DESCRIPTION, ERR_CHECK_SKILL_NESTED,
 * ERR_CHECK_SKILL_BODY, ERR_CHECK_SKILL_SYMLINK, ERR_CHECK_SKILL_INDEX.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isMap, isScalar, parseDocument } from "yaml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const SKILLS = ".agents/skills";
const MAX_DESCRIPTION = 1024;
const MAX_BODY_LINES = 200;
const MAX_NAME = 64;
const NAME_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIX_SKILL =
  "fix the skill under .agents/skills/ (the authoring-skills skill), then `just agents-sync`";

function frontmatterViolation(dir: string, actual: string): FailureDetails {
  return {
    code: "ERR_CHECK_SKILL_FRONTMATTER",
    summary: `${SKILLS}/${dir}/SKILL.md has a frontmatter that would not load as a skill`,
    expected: `a --- block of strict YAML holding exactly \`name: ${dir}\` and a non-empty string \`description\``,
    actual,
    next: FIX_SKILL,
  };
}

function descriptionViolation(dir: string, actual: string): FailureDetails {
  return {
    code: "ERR_CHECK_SKILL_DESCRIPTION",
    summary: `${SKILLS}/${dir}/SKILL.md has a frontmatter value that would not load in both hosts`,
    expected: `a printable-ASCII description of at most ${String(MAX_DESCRIPTION)} characters, and no YAML comment cutting a value short`,
    actual,
    next: `${FIX_SKILL} (quote the value, or use \`description: >\`)`,
  };
}

/** Checks one SKILL.md's frontmatter and body length. */
function skillFileViolations(dir: string, text: string): FailureDetails[] {
  const lines = text.split("\n");
  if (lines[0] !== "---")
    return [frontmatterViolation(dir, "SKILL.md does not start with a `---` line")];
  const close = lines.indexOf("---", 1);
  if (close === -1)
    return [frontmatterViolation(dir, "the frontmatter block is never closed with a `---` line")];

  const violations: FailureDetails[] = [];
  const body = lines.slice(close + 1);
  if (body.at(-1) === "") body.pop();
  if (body.length > MAX_BODY_LINES) {
    violations.push({
      code: "ERR_CHECK_SKILL_BODY",
      summary: `${SKILLS}/${dir}/SKILL.md is over the ${String(MAX_BODY_LINES)}-line body cap`,
      expected: `at most ${String(MAX_BODY_LINES)} lines after the closing \`---\` (the target is 150)`,
      actual: `${String(body.length)} lines`,
      next: "move tables, long examples, and edge cases into references/ (the authoring-skills skill), then `just agents-sync`",
    });
  }

  const doc = parseDocument(lines.slice(1, close).join("\n"), { strict: true, uniqueKeys: true });
  const [problem] = [...doc.errors, ...doc.warnings];
  if (problem !== undefined) {
    return [
      frontmatterViolation(
        dir,
        `the block does not parse as YAML: ${problem.message.split("\n")[0] ?? ""}`,
      ),
      ...violations,
    ];
  }
  if (!isMap(doc.contents))
    return [frontmatterViolation(dir, "the block is not a mapping of keys"), ...violations];

  const values = new Map<string, unknown>();
  for (const pair of doc.contents.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (key !== "name" && key !== "description") {
      violations.push(
        frontmatterViolation(
          dir,
          `unexpected key \`${key}\` (only \`name\` and \`description\` are allowed)`,
        ),
      );
      continue;
    }
    if (isScalar(pair.value) && typeof pair.value.comment === "string") {
      violations.push(
        descriptionViolation(
          dir,
          `\`${key}\` is followed by a YAML comment (\`#${pair.value.comment}\`), which drops that text from the value`,
        ),
      );
    }
    values.set(key, isScalar(pair.value) ? pair.value.value : pair.value?.toJSON());
  }

  const name = values.get("name");
  if (!values.has("name")) violations.push(frontmatterViolation(dir, "no `name` key"));
  else if (typeof name !== "string")
    violations.push(frontmatterViolation(dir, "`name` is not a string"));
  else if (name !== dir)
    violations.push(
      frontmatterViolation(dir, `\`name\` is \`${name}\`, but the directory is \`${dir}\``),
    );
  else if (!NAME_SHAPE.test(name) || name.length > MAX_NAME) {
    violations.push(
      frontmatterViolation(
        dir,
        `\`name\` \`${name}\` is not lowercase letters, digits, and single hyphens of at most ${String(MAX_NAME)} characters`,
      ),
    );
  }

  const description = values.get("description");
  if (!values.has("description"))
    violations.push(frontmatterViolation(dir, "no `description` key"));
  else if (typeof description !== "string")
    violations.push(frontmatterViolation(dir, "`description` is not a string"));
  else if (description.trim() === "")
    violations.push(frontmatterViolation(dir, "`description` is empty"));
  else {
    const text = description.trimEnd();
    if (/[^\t\n\x20-\x7e]/.test(text)) {
      violations.push(
        descriptionViolation(
          dir,
          "`description` holds a non-ASCII or non-printable character (an em dash or a curly quote, say)",
        ),
      );
    }
    if (text.length > MAX_DESCRIPTION) {
      violations.push(
        descriptionViolation(dir, `\`description\` is ${String(text.length)} characters`),
      );
    }
  }
  return violations;
}

/** Every path under `dir` (root-relative), without following symbolic links. */
function walk(root: string, dir: string): { path: string; link: boolean; file: boolean }[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    const self = { path, link: entry.isSymbolicLink(), file: entry.isFile() };
    return entry.isDirectory() ? [self, ...walk(root, path)] : [self];
  });
}

function symlinkViolation(path: string): FailureDetails {
  return {
    code: "ERR_CHECK_SKILL_SYMLINK",
    summary: `${path} is a symbolic link`,
    expected:
      "real files only under .agents/skills/ (git checks a link out as a link only where core.symlinks allows)",
    actual: "a symbolic link",
    next: "replace the link with the file it points to, then `just agents-sync`",
  };
}

function treeViolations(root: string, dir: string): FailureDetails[] {
  const violations: FailureDetails[] = [];
  const top = `${SKILLS}/${dir}/SKILL.md`;
  for (const entry of walk(root, `${SKILLS}/${dir}`)) {
    if (entry.link) {
      violations.push(symlinkViolation(entry.path));
    } else if (entry.file && entry.path.endsWith("/SKILL.md") && entry.path !== top) {
      violations.push({
        code: "ERR_CHECK_SKILL_NESTED",
        summary: `${entry.path} is a SKILL.md below a skill's top directory`,
        expected:
          "SKILL.md only at .agents/skills/<dir>/SKILL.md, so a host never loads a second skill from a subdirectory",
        actual: entry.path,
        next: "rename the nested file for its content (references/<topic>.md), then `just agents-sync`",
      });
    }
  }
  return violations;
}

interface Row {
  readonly line: number;
  readonly name: string;
}

/** The Skills table's rows, or undefined when there is no table. */
function indexRows(agents: string): Row[] | undefined {
  const lines = agents.split("\n");
  const start = lines.findIndex((line) => /^## Skills\s*$/.test(line));
  if (start === -1) return undefined;
  let fenced = false;
  let rows: Row[] | undefined;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (line.startsWith("#")) break;
    if (!line.startsWith("|")) {
      if (rows !== undefined) break;
      continue;
    }
    if (rows === undefined) {
      rows = [];
      continue;
    }
    if (/^\|[\s:|-]*$/.test(line)) continue;
    const cell = (line.split("|")[1] ?? "").replaceAll("`", "").trim();
    rows.push({ line: i + 1, name: cell });
  }
  return rows;
}

function indexViolation(summary: string, actual: string): FailureDetails {
  return {
    code: "ERR_CHECK_SKILL_INDEX",
    summary,
    expected:
      "one row in AGENTS.md's Skills table per directory under .agents/skills/, and no other rows",
    actual,
    next: "add, rename, or remove the row in AGENTS.md's Skills table (or the skill directory) in the same commit",
  };
}

function indexViolations(agents: string, dirs: readonly string[]): FailureDetails[] {
  const rows = indexRows(agents);
  if (rows === undefined) {
    return [
      indexViolation("AGENTS.md has no Skills table", "no table under a `## Skills` heading"),
    ];
  }
  const violations: FailureDetails[] = [];
  const seen = new Set<string>();
  for (const { line, name } of rows) {
    const where = `AGENTS.md:${String(line)}`;
    if (name === "") {
      violations.push(
        indexViolation(
          `${where}: a Skills table row has an empty first cell`,
          "an empty first cell",
        ),
      );
    } else if (seen.has(name)) {
      violations.push(
        indexViolation(`${where}: \`${name}\` is indexed twice`, `a second row for \`${name}\``),
      );
    } else if (!dirs.includes(name)) {
      violations.push(
        indexViolation(
          `${where}: \`${name}\` has a row but no .agents/skills/${name}/`,
          "a row for a skill that does not exist",
        ),
      );
    }
    seen.add(name);
  }
  for (const dir of dirs) {
    if (!seen.has(dir)) {
      violations.push(
        indexViolation(
          `.agents/skills/${dir}/ has no row, \`${dir}\`, in AGENTS.md's Skills table`,
          "a skill no row indexes",
        ),
      );
    }
  }
  return violations;
}

function run(root: string): FailureDetails[] {
  const agents = readRepoFile(root, "AGENTS.md");
  const missing = [
    agents === undefined ? "AGENTS.md" : undefined,
    existsSync(join(root, SKILLS)) ? undefined : `${SKILLS}/`,
  ];
  const absent = missing.filter((path) => path !== undefined);
  if (agents === undefined || absent.length > 0) {
    return [
      {
        code: "ERR_CHECK_INPUT_MISSING",
        summary: `${absent.join(" and ")} does not exist`,
        expected: "AGENTS.md and .agents/skills/ under the root",
        actual: `missing: ${absent.join(", ")}`,
        next: "run the check against the repository root (--root DIR)",
      },
    ];
  }

  const entries = readdirSync(join(root, SKILLS), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));
  const violations: FailureDetails[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      violations.push(symlinkViolation(`${SKILLS}/${entry.name}`));
      continue;
    }
    const text = readRepoFile(root, `${SKILLS}/${entry.name}/SKILL.md`);
    violations.push(
      ...(text === undefined
        ? [frontmatterViolation(entry.name, "the directory has no SKILL.md")]
        : skillFileViolations(entry.name, text)),
    );
    violations.push(...treeViolations(root, entry.name));
  }
  const skillDirs = entries.map((entry) => entry.name);
  return [...violations, ...indexViolations(agents, skillDirs)];
}

export const check: Check = { name: "skills", run };
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
