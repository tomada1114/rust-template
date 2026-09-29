/**
 * Creates or updates this repository's "main" ruleset — the committed, reviewable
 * definition of branch protection — from .github/rulesets/main.json, the JSON body
 * `POST /repos/{owner}/{repo}/rulesets` (and `PUT .../rulesets/{id}`) accept.
 *
 *   node scripts/apply-ruleset.ts
 *
 * A human-run, admin-only step: applying a ruleset needs repository admin rights, so
 * it never runs from CI or a hook, and running it against the live repository needs
 * sign-off like any other remote write. "Use this template" does not copy rulesets,
 * so every repository made from the template runs this once.
 *
 * Idempotent: a ruleset already named "main" (repository-scoped) is updated in place
 * with PUT; otherwise one is created with POST. `gh` comes from the caller's PATH and
 * must already be authenticated. Rulesets on a private repository need a paid plan;
 * that refusal is ERR_RULESET_PLAN_UNSUPPORTED rather than a raw 403.
 *
 * Errors: ERR_RULESET_FILE_MISSING, ERR_RULESET_FILE_INVALID, ERR_RULESET_GH_MISSING,
 * ERR_RULESET_PLAN_UNSUPPORTED, ERR_RULESET_FORBIDDEN.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { runScript, type RunResult, type ScriptContext } from "./lib/script.ts";

const RULESET_FILE = join(".github", "rulesets", "main.json");
const RULESET_NAME = "main";

function readRuleset(path: string): void {
  if (!existsSync(path)) {
    throw new ScriptError({
      code: "ERR_RULESET_FILE_MISSING",
      summary: `${RULESET_FILE} does not exist`,
      expected: `a committed ruleset definition at ${RULESET_FILE}`,
      actual: `no file at ${path}`,
      next: `restore ${RULESET_FILE} from version control`,
    });
  }
  let parsed: unknown;
  let problem: string | undefined;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    problem = `it is not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  if (problem === undefined) {
    const name =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["name"]
        : undefined;
    if (name !== RULESET_NAME)
      problem = name === undefined ? `it has no "name"` : `its "name" is ${JSON.stringify(name)}`;
  }
  if (problem !== undefined) {
    throw new ScriptError({
      code: "ERR_RULESET_FILE_INVALID",
      summary: `${RULESET_FILE} is not a usable ruleset definition`,
      expected: `a JSON object with "name": "${RULESET_NAME}"`,
      actual: problem,
      next: `fix ${RULESET_FILE}, or restore it from version control`,
    });
  }
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

export function main(context: ScriptContext): void {
  const file = join(context.root, RULESET_FILE);
  readRuleset(file);

  const repo = gh(context, "resolving the repository (`gh repo view`)", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).stdout.trim();

  // includes_parents=false: organization rulesets have ids the repository-scoped PUT
  // cannot address. --paginate: a "main" past the first page is still found.
  const existing = gh(context, `listing rulesets (\`gh api repos/${repo}/rulesets\`)`, [
    "api",
    "--paginate",
    `repos/${repo}/rulesets?includes_parents=false`,
    "--jq",
    `.[] | select(.name == "${RULESET_NAME}" and .source_type == "Repository") | .id`,
  ])
    .stdout.split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");

  if (existing === undefined) {
    gh(context, `creating the ruleset (\`gh api repos/${repo}/rulesets\`)`, [
      "api",
      `repos/${repo}/rulesets`,
      "--method",
      "POST",
      "--input",
      file,
    ]);
    context.log(`apply-ruleset: created ruleset ${RULESET_NAME} in ${repo}`);
    return;
  }
  gh(context, `updating the ruleset (\`gh api repos/${repo}/rulesets/${existing}\`)`, [
    "api",
    `repos/${repo}/rulesets/${existing}`,
    "--method",
    "PUT",
    "--input",
    file,
  ]);
  context.log(`apply-ruleset: updated ruleset ${RULESET_NAME} (id ${existing}) in ${repo}`);
}

if (import.meta.main) await runScript(main);
