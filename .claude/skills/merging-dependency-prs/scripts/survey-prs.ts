/**
 * Surveys the open Dependabot and Renovate pull requests for the `merging-dependency-prs`
 * skill: each one's ecosystem, the versions it moves and their semver level, its check
 * rollup, its merge state, the files it touches, the files two of them contest, and
 * whether the batch keeps each Tauri crate in step with its `@tauri-apps/*` npm packages.
 * Read-only: it runs `gh pr list` and reads `Cargo.lock` and `package.json`, and it
 * is the one step of the skill that runs before the human's approval.
 * It marks a Tauri pair split across PRs, at least one of which breaks it alone, and each
 * major bump.
 *
 *   node .agents/skills/merging-dependency-prs/scripts/survey-prs.ts [--json]
 *
 * Needs `gh`, authenticated against this repository. It works in any directory `gh`
 * resolves a repository from; outside one, `gh` fails and so does this script.
 *
 * A thin dispatcher: the survey itself is `scripts/lib/dependency-prs.ts`.
 *
 * Errors: ERR_SURVEY_USAGE (an unknown argument), ERR_SURVEY_GH (`gh` missing, failing,
 * or printing something other than a JSON list).
 */
import {
  collect,
  contestedFiles,
  currentTauriVersions,
  FIELDS,
  formatReport,
  tauriReport,
} from "../../../../scripts/lib/dependency-prs.ts";
import { ScriptError } from "../../../../scripts/lib/fail.ts";
import { runScript, type ScriptContext } from "../../../../scripts/lib/script.ts";

function ghPullRequests(context: ScriptContext): unknown[] {
  const args = ["pr", "list", "--state", "open", "--limit", "100", "--json", FIELDS];
  const result = context.run("gh", args, { cwd: context.root, timeoutMs: 120_000 });
  const failure = (actual: string) =>
    new ScriptError({
      code: "ERR_SURVEY_GH",
      summary: "`gh pr list` did not return the open pull requests",
      expected: "the GitHub CLI on PATH, authenticated, printing a JSON list",
      actual,
      next: "run `gh auth status` and confirm this checkout has a GitHub remote",
    });
  if (result.status !== 0) {
    throw failure(result.stderr.trim() || `exit status ${String(result.status)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout === "" ? "[]" : result.stdout);
  } catch {
    throw failure(`output that is not JSON: ${result.stdout.slice(0, 120)}`);
  }
  if (!Array.isArray(parsed))
    throw failure(`JSON that is not a list: ${result.stdout.slice(0, 120)}`);
  return parsed;
}

export function main(context: ScriptContext): void {
  const unknown = context.argv.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    throw new ScriptError({
      code: "ERR_SURVEY_USAGE",
      summary: `unknown argument: ${unknown.join(" ")}`,
      expected: "no argument, or --json",
      actual: context.argv.join(" "),
      next: "run `node .agents/skills/merging-dependency-prs/scripts/survey-prs.ts`",
    });
  }
  const rows = collect(ghPullRequests(context));
  const tauri = tauriReport(rows, currentTauriVersions(context.root));
  if (context.argv.includes("--json")) {
    const contested = Object.fromEntries(contestedFiles(rows));
    context.log(JSON.stringify({ rows, contested, tauri }, null, 2));
    return;
  }
  if (rows.length === 0) {
    context.log("No open Dependabot or Renovate pull requests.");
    return;
  }
  for (const line of formatReport(rows, tauri)) context.log(line);
}

if (import.meta.main) await runScript(main);
