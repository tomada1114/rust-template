/**
 * Every `just <recipe>` the documents name exists, and every recipe `.claude/settings.json`
 * permits exists (design D14), so a renamed or removed recipe cannot leave a document
 * pointing at nothing or a permission rule that can never match.
 *
 *   node scripts/checks/just-recipes-exist.ts [--root DIR]
 *
 * Read: `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `docs/*.md` (not subdirectories), and
 * every `*.md` under `.agents/skills/`. Only code is read — inline code spans (which may
 * wrap across lines, but never across a blank line) and fenced blocks — so English prose
 * ("just to be safe") never counts. A token is `just` not preceded by a name character,
 * then a recipe name (a letter or `_`, then letters, digits, `_`, `-`), so `just --list`
 * and the placeholder `just <recipe>` name nothing. From `.claude/settings.json`, each
 * `permissions` rule of the form `Bash(just <recipe>…)`; a hook's command is not a rule.
 *
 * The recipes are parsed from the justfile's column-0 lines: each recipe header (with or
 * without parameters, `[private]` and `_`-prefixed ones included, since `just` still runs
 * them) and each `alias`. Every file but the justfile is optional. No git work tree needed.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_INPUT_MISSING (no justfile), ERR_CHECK_INPUT_UNREADABLE
 * (`.claude/settings.json` is not JSON), ERR_CHECK_RECIPE_MISSING (a document names an
 * undefined recipe), ERR_CHECK_PERMISSION_RECIPE_MISSING (a permission names one).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const NAME = "[A-Za-z_][A-Za-z0-9_-]*";
const NOT_A_RECIPE = new Set(["set", "export", "unexport", "import", "mod", "alias"]);

/** The recipe and alias names a justfile defines. */
function justfileRecipes(text: string): Set<string> {
  const recipes = new Set<string>();
  for (const line of text.split("\n")) {
    const alias = new RegExp(`^alias\\s+(${NAME})\\s*:=`).exec(line);
    if (alias?.[1] !== undefined) {
      recipes.add(alias[1]);
      continue;
    }
    if (new RegExp(`^(?:export\\s+)?${NAME}\\s*:=`).test(line)) continue;
    const header = new RegExp(`^@?(${NAME})(?=[\\s:])[^\\n]*:`).exec(line);
    const name = header?.[1];
    if (name !== undefined && !NOT_A_RECIPE.has(name)) recipes.add(name);
  }
  return recipes;
}

interface Found {
  readonly line: number;
  readonly recipe: string;
}

/**
 * Where, in a fenced block, `just` starts a command rather than a sentence: at the start
 * of the line, after a prompt, a comment marker, a quote, a backtick, a shell operator,
 * `--`, an environment assignment, or a command prefix — so a prompt template's "its CI
 * just failed" is prose, while `# just lint` and `mise exec -- just check` are not.
 */
const COMMAND_POSITION =
  /(?:^|[$#>%"'`(;|&{]|--|\b[A-Za-z_]\w*=\S*|\b(?:then|do|else|exec|time|env|xargs))$/;

/**
 * `just <recipe>` tokens in `code`, whose first character is on line `line`. With
 * `commands`, only tokens in a command position count (a fenced block's lines).
 */
function tokens(code: string, line: number, commands = false): Found[] {
  const found: Found[] = [];
  for (const match of code.matchAll(new RegExp(`(?<![A-Za-z0-9_-])just[ \\t\\n]+(${NAME})`, "g"))) {
    const recipe = match[1];
    if (recipe === undefined) continue;
    const before = code.slice(0, match.index);
    if (commands && !COMMAND_POSITION.test(before.trimEnd())) continue;
    found.push({ line: line + (before.match(/\n/g)?.length ?? 0), recipe });
  }
  return found;
}

/** Tokens inside the inline code spans of one paragraph (CommonMark backtick runs). */
function spanTokens(paragraph: string, firstLine: number): Found[] {
  const found: Found[] = [];
  const runs = [...paragraph.matchAll(/`+/g)];
  let i = 0;
  while (i < runs.length) {
    const open = runs[i];
    if (open === undefined) break;
    const closeAt = runs.findIndex((run, j) => j > i && run[0].length === open[0].length);
    if (closeAt === -1) {
      i += 1;
      continue;
    }
    const close = runs[closeAt];
    if (close === undefined) break;
    const start = open.index + open[0].length;
    const lineOfStart = firstLine + (paragraph.slice(0, start).match(/\n/g)?.length ?? 0);
    found.push(...tokens(paragraph.slice(start, close.index), lineOfStart));
    i = closeAt + 1;
  }
  return found;
}

/** Every `just <recipe>` token in a Markdown document's code. */
function markdownTokens(text: string): Found[] {
  const found: Found[] = [];
  let fence: string | undefined;
  let paragraph: string[] = [];
  let paragraphStart = 0;
  const flush = (): void => {
    if (paragraph.length > 0) found.push(...spanTokens(paragraph.join("\n"), paragraphStart));
    paragraph = [];
  };
  text.split("\n").forEach((line, index) => {
    const number = index + 1;
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker?.startsWith(fence[0] ?? "") === true && marker.length >= fence.length) {
        fence = undefined;
      } else {
        found.push(...tokens(line, number, true));
      }
      return;
    }
    if (marker !== undefined) {
      flush();
      fence = marker;
      return;
    }
    if (line.trim() === "") {
      flush();
      return;
    }
    if (paragraph.length === 0) paragraphStart = number;
    paragraph.push(line);
  });
  flush();
  return found;
}

/** The Markdown files whose recipe references are checked, as root-relative paths. */
function documents(root: string): string[] {
  const paths = ["AGENTS.md", "README.md", "CONTRIBUTING.md"];
  const list = (dir: string): string[] => {
    try {
      return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return dir === "docs" ? [] : list(path);
        return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
      });
    } catch {
      return [];
    }
  };
  return [...paths, ...list("docs").sort(), ...list(".agents/skills").sort()];
}

function settingsViolations(root: string, recipes: ReadonlySet<string>): FailureDetails[] {
  const path = ".claude/settings.json";
  const text = readRepoFile(root, path);
  if (text === undefined) return [];
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (error: unknown) {
    return [
      {
        code: "ERR_CHECK_INPUT_UNREADABLE",
        summary: `${path} is not JSON`,
        expected: "a JSON object whose `permissions` lists hold the permission rules",
        actual: error instanceof Error ? error.message : String(error),
        next: `fix the JSON in ${path}`,
      },
    ];
  }
  const permissions =
    typeof settings === "object" && settings !== null && "permissions" in settings
      ? settings.permissions
      : undefined;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return [];
  }
  const lines = text.split("\n");
  const violations: FailureDetails[] = [];
  for (const rules of Object.values(permissions)) {
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (typeof rule !== "string") continue;
      const recipe = new RegExp(`^Bash\\(\\s*just\\s+(${NAME})`).exec(rule)?.[1];
      if (recipe === undefined || recipes.has(recipe)) continue;
      const line = lines.findIndex((l) => l.includes(JSON.stringify(rule))) + 1;
      violations.push({
        code: "ERR_CHECK_PERMISSION_RECIPE_MISSING",
        summary: `${path}:${String(line)} permits \`just ${recipe}\`, which the justfile does not define`,
        expected: `every \`Bash(just <recipe>…)\` rule in ${path} to name a recipe the justfile defines`,
        actual: `the rule ${JSON.stringify(rule)}, and no recipe or alias named \`${recipe}\``,
        next: `drop or rename the rule in ${path}, or add the recipe to the justfile (\`just --list\` shows them)`,
      });
    }
  }
  return violations;
}

function run(root: string): FailureDetails[] {
  const justfile = readRepoFile(root, "justfile");
  if (justfile === undefined) {
    return [
      {
        code: "ERR_CHECK_INPUT_MISSING",
        summary: "there is no justfile",
        expected: `a justfile at ${root}/justfile`,
        actual: "no such file",
        next: "run the check against the repository root (--root DIR)",
      },
    ];
  }
  const recipes = justfileRecipes(justfile);
  const violations: FailureDetails[] = [];
  for (const path of documents(root)) {
    const text = readRepoFile(root, path);
    if (text === undefined) continue;
    for (const { line, recipe } of markdownTokens(text)) {
      if (recipes.has(recipe)) continue;
      violations.push({
        code: "ERR_CHECK_RECIPE_MISSING",
        summary: `${path}:${String(line)} names \`just ${recipe}\`, which the justfile does not define`,
        expected:
          "every `just <recipe>` in a document's code spans and blocks to be a recipe or alias in the justfile",
        actual: `no recipe or alias named \`${recipe}\``,
        next: `rename the reference in ${path} to an existing recipe (\`just --list\`), or add the recipe to the justfile`,
      });
    }
  }
  return [...violations, ...settingsViolations(root, recipes)];
}

export const check: Check = { name: "just-recipes-exist", run };
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
