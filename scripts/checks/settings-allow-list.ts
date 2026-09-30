/**
 * `.claude/settings.json`'s `allow` list admits none of the recipes that open the app,
 * need a human, or write beyond the working tree (AGENTS.md › "Enforcement layers"), so
 * adding one to `allow` fails here instead of relying on review to notice it.
 *
 *   node scripts/checks/settings-allow-list.ts [--root DIR]
 *
 * An `allow` rule admits a recipe when it names `just <recipe>` anywhere, with any global
 * flags (each with up to two values) between `just` and the recipe (so
 * `Bash(mise exec -- just run)` and `Bash(just --justfile justfile run)` count), or when
 * its pattern, matched the way Claude Code matches a Bash rule, covers one of the
 * candidate commands `just <recipe>`, `mise exec -- just <recipe>`, or `x just <recipe>`,
 * each also followed by an argument: a bare `Bash`, `Bash(*)`, `Bash(just:*)`,
 * `Bash(mise exec -- just:*)`, and `Bash(* just run)` all count. In a pattern `*` stands
 * for any text, a trailing `:*` is a trailing ` *`, and a trailing ` *` that is the only wildcard also
 * matches the bare command. Only `allow` is read: `ask` and `deny` are where these recipes
 * belong. The file is optional. No git work tree needed.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_INPUT_UNREADABLE (`.claude/settings.json` is not
 * JSON), ERR_CHECK_ALLOW_HUMAN_RECIPE (an `allow` rule admits one of the recipes).
 */
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

/** The recipes AGENTS.md keeps out of `allow`: they open the app, need a human, or write beyond the tree. */
export const HUMAN_RECIPES = [
  "dev",
  "run",
  "install-app",
  "test-local",
  "logs-follow",
  "reset-permissions",
  "install",
  "clean",
  "labels",
  "ruleset",
  "release-prep",
  "bootstrap",
] as const;

const PATH = ".claude/settings.json";

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Commands a rule may wrap `just <recipe>` in: bare, under `mise exec --`, or after any prefix. */
const PREFIXES = ["", "mise exec -- ", "x "] as const;

/** The command texts a Bash rule matches, as a regex; undefined for a rule of another tool. */
function bashRule(rule: string): RegExp | undefined {
  if (rule === "Bash") return /^/;
  const inner = /^Bash\((.*)\)$/s.exec(rule)?.[1];
  if (inner === undefined) return undefined;
  const pattern = inner.endsWith(":*") ? `${inner.slice(0, -2)} *` : inner;
  const parts = pattern.split("*");
  if (parts.length === 2 && pattern.endsWith(" *")) {
    return new RegExp(`^${escape(pattern.slice(0, -2))}(?: .*)?$`, "s");
  }
  return new RegExp(`^${parts.map(escape).join(".*")}$`, "s");
}

/** The recipes of {@link HUMAN_RECIPES} that one `allow` rule admits. */
function admitted(rule: string): string[] {
  const matcher = bashRule(rule);
  if (matcher === undefined) return [];
  return HUMAN_RECIPES.filter(
    (recipe) =>
      PREFIXES.some(
        (prefix) =>
          matcher.test(`${prefix}just ${recipe}`) || matcher.test(`${prefix}just ${recipe} x`),
      ) ||
      new RegExp(
        `(?<![A-Za-z0-9_-])just(?:\\s+-\\S*(?:\\s+[^-\\s]\\S*){0,2})*\\s+${escape(recipe)}(?![A-Za-z0-9_-])`,
      ).test(rule),
  );
}

function run(root: string): FailureDetails[] {
  const text = readRepoFile(root, PATH);
  if (text === undefined) return [];
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (error: unknown) {
    return [
      {
        code: "ERR_CHECK_INPUT_UNREADABLE",
        summary: `${PATH} is not JSON`,
        expected: "a JSON object whose `permissions.allow` list holds the allow rules",
        actual: error instanceof Error ? error.message : String(error),
        next: `fix the JSON in ${PATH}`,
      },
    ];
  }
  const permissions =
    typeof settings === "object" && settings !== null && "permissions" in settings
      ? settings.permissions
      : undefined;
  const allow =
    typeof permissions === "object" && permissions !== null && "allow" in permissions
      ? permissions.allow
      : undefined;
  if (!Array.isArray(allow)) return [];
  const lines = text.split("\n");
  const violations: FailureDetails[] = [];
  for (const rule of allow) {
    if (typeof rule !== "string") continue;
    const recipes = admitted(rule);
    if (recipes.length === 0) continue;
    const line = lines.findIndex((l) => l.includes(JSON.stringify(rule))) + 1;
    const named = recipes.map((recipe) => `\`just ${recipe}\``).join(", ");
    violations.push({
      code: "ERR_CHECK_ALLOW_HUMAN_RECIPE",
      summary: `${PATH}:${String(line)} allows ${JSON.stringify(rule)}, which admits ${named}`,
      expected: `no \`allow\` rule in ${PATH} admitting a recipe that opens the app, needs a human, or writes beyond the working tree (${HUMAN_RECIPES.join(", ")})`,
      actual: `the rule ${JSON.stringify(rule)} runs ${named} without a prompt`,
      next: `remove the rule from \`allow\` in ${PATH} (or narrow its wildcard) so the recipe stops for a human`,
    });
  }
  return violations;
}

export const check: Check = { name: "settings-allow-list", run };
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
