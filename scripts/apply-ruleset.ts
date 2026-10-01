/**
 * Creates or updates every ruleset this repository commits under .github/rulesets/ —
 * main.json (branch protection for the default branch) and release-tags.json (who may
 * create, move, or delete a release tag) — each from the JSON body
 * `POST /repos/{owner}/{repo}/rulesets` (and `PUT .../rulesets/{id}`) accept.
 *
 *   node scripts/apply-ruleset.ts
 *
 * A human-run, admin-only step: applying a ruleset needs repository admin rights, so
 * it never runs from CI or a hook, and running it against the live repository needs
 * sign-off like any other remote write. "Use this template" does not copy rulesets,
 * so every repository made from the template runs this once.
 *
 * Idempotent and additive: each file is applied by its own "name" and "target" — a
 * repository-scoped ruleset with both is updated in place with PUT, otherwise one is
 * created with POST. It never deletes a ruleset, including one no file names. Every
 * file is validated before the first gh call, so a malformed one applies nothing.
 * `gh` comes from the caller's PATH and must already be authenticated. Rulesets on a
 * private repository need a paid plan; that refusal is ERR_RULESET_PLAN_UNSUPPORTED
 * rather than a raw 403. The `release` environment is not a ruleset and stays a
 * manual step (docs/distribution.md).
 *
 * Errors: ERR_RULESET_FILE_MISSING, ERR_RULESET_FILE_INVALID, ERR_RULESET_GH_MISSING,
 * ERR_RULESET_PLAN_UNSUPPORTED, ERR_RULESET_FORBIDDEN.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { runScript, type RunResult, type ScriptContext } from "./lib/script.ts";

const RULESET_DIR = join(".github", "rulesets");

interface Ruleset {
  readonly file: string;
  readonly name: string;
  readonly target: string;
}

function listRulesetFiles(dir: string): string[] {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((entry) => entry.endsWith(".json"))
        .sort()
    : [];
  if (files.length === 0) {
    throw new ScriptError({
      code: "ERR_RULESET_FILE_MISSING",
      summary: `${RULESET_DIR} holds no ruleset definition`,
      expected: `at least one committed *.json ruleset under ${RULESET_DIR}`,
      actual: existsSync(dir) ? `no *.json file in ${dir}` : `no directory at ${dir}`,
      next: `restore ${RULESET_DIR} from version control`,
    });
  }
  return files;
}

function stringField(parsed: unknown, key: string): string | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const value: unknown = Object.entries(parsed).find(([k]) => k === key)?.[1];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readRuleset(root: string, entry: string): Ruleset {
  const relative = join(RULESET_DIR, entry);
  const file = join(root, relative);
  let parsed: unknown;
  let problem: string | undefined;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error: unknown) {
    problem = `it is not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  const name = stringField(parsed, "name");
  const target = stringField(parsed, "target");
  if (problem === undefined && name === undefined) problem = `it has no non-empty string "name"`;
  if (problem === undefined && target === undefined)
    problem = `it has no non-empty string "target"`;
  if (problem !== undefined || name === undefined || target === undefined) {
    throw new ScriptError({
      code: "ERR_RULESET_FILE_INVALID",
      summary: `${relative} is not a usable ruleset definition`,
      expected: `a JSON object with a string "name" and "target"`,
      actual: problem ?? "it is not a JSON object",
      next: `fix ${relative}, or restore it from version control`,
    });
  }
  return { file, name, target };
}

/** Run one gh call, turning a failure into the matching ERR_RULESET_ code. */
function gh(context: ScriptContext, action: string, args: readonly string[]): RunResult {
  const result = context.run("gh", args, { cwd: context.root, env: context.env });
  if (result.status === null) {
    throw new ScriptError({
      code: "ERR_RULESET_GH_MISSING",
      summary: "'gh' could not be started",
      expected: "the GitHub CLI ('gh') on the caller's PATH, authenticated against this repository",
      actual: result.stderr.trim(),
      next: "install the GitHub CLI and run `gh auth login`",
    });
  }
  if (result.status === 0) return result;
  const message = result.stderr.trim();
  if (/upgrade/i.test(message)) {
    throw new ScriptError({
      code: "ERR_RULESET_PLAN_UNSUPPORTED",
      summary: `${action} was refused: rulesets need a paid GitHub plan on a private repository`,
      expected: "GitHub Free supports rulesets on public repositories only",
      actual: message,
      next: "make the repository public, or use a paid GitHub plan",
    });
  }
  throw new ScriptError({
    code: "ERR_RULESET_FORBIDDEN",
    summary: `${action} was refused`,
    expected: "the GitHub API to accept the request from a repository admin",
    actual: message,
    next: "run `gh auth status` and confirm this account is an admin of the repository",
  });
}

function applyOne(context: ScriptContext, repo: string, ruleset: Ruleset): void {
  const { file, name, target } = ruleset;
  // includes_parents=false: organization rulesets have ids the repository-scoped PUT
  // cannot address. --paginate: a match past the first page is still found.
  const existing = gh(context, `listing rulesets (\`gh api repos/${repo}/rulesets\`)`, [
    "api",
    "--paginate",
    `repos/${repo}/rulesets?includes_parents=false`,
    "--jq",
    `.[] | select(.name == ${JSON.stringify(name)} and .target == ${JSON.stringify(target)} and .source_type == "Repository") | .id`,
  ])
    .stdout.split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");

  if (existing === undefined) {
    gh(context, `creating the ruleset ${name} (\`gh api repos/${repo}/rulesets\`)`, [
      "api",
      `repos/${repo}/rulesets`,
      "--method",
      "POST",
      "--input",
      file,
    ]);
    context.log(`apply-ruleset: created ruleset ${name} in ${repo}`);
    return;
  }
  gh(context, `updating the ruleset ${name} (\`gh api repos/${repo}/rulesets/${existing}\`)`, [
    "api",
    `repos/${repo}/rulesets/${existing}`,
    "--method",
    "PUT",
    "--input",
    file,
  ]);
  context.log(`apply-ruleset: updated ruleset ${name} (id ${existing}) in ${repo}`);
}

export function main(context: ScriptContext): void {
  const rulesets = listRulesetFiles(join(context.root, RULESET_DIR)).map((entry) =>
    readRuleset(context.root, entry),
  );

  const repo = gh(context, "resolving the repository (`gh repo view`)", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).stdout.trim();

  for (const ruleset of rulesets) applyOne(context, repo, ruleset);
}

if (import.meta.main) await runScript(main);
