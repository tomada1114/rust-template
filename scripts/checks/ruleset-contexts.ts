/**
 * Every required status check in the main-branch ruleset names a job that reports on a
 * pull request (design D14), so renaming a CI job cannot leave a required check that
 * never reports and blocks every PR. Ported from macos-app-template's
 * ruleset-contexts.sh, reading the ruleset with JSON.parse and workflows with `yaml`.
 *
 *   node scripts/checks/ruleset-contexts.ts [--root DIR]
 *
 * Files: <root>/.github/rulesets/main.json (required) and .github/workflows/*.yml|*.yaml.
 *   - contexts: every `context` under a `required_status_checks` rule's
 *     `parameters.required_status_checks`. A ruleset with no such rule requires nothing.
 *   - jobs: those of workflows whose `on:` names `pull_request` (not
 *     `pull_request_target`: it runs the base branch's workflow, so a renamed job would
 *     not report under it either). A job reports as its `name:`, or its id without one.
 *     Each `${{ … }}` in a name matches any text; a matrix job whose name has no
 *     expression reports as `<name> (<values>)`, and matches that shape.
 *   A workflow that does not parse is workflow-hygiene's to report; its jobs match nothing
 *   here.
 *
 * Git work tree: not required; the check reads files under --root.
 *
 * Errors (FailureDetails; the runner prints them all):
 *   ERR_CHECK_USAGE               bad arguments (scripts/checks/lib.ts)
 *   ERR_CHECK_RULESET_MISSING     .github/rulesets/main.json does not exist
 *   ERR_CHECK_RULESET_UNREADABLE  .github/rulesets/main.json is not JSON
 *   ERR_CHECK_RULESET_CONTEXT     a required context matches no job in a pull_request workflow
 */
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import { isRecord, jobsOf, readWorkflows, triggerNames } from "./shared/workflows.ts";

const RULESET = ".github/rulesets/main.json";

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a status context is what a job named `name` reports: each `${{ … }}` in the
 * name matches any text, and a matrix job whose name has no expression reports as
 * `<name> (<values>)`.
 */
export function nameMatches(context: string, name: string, matrix: boolean): boolean {
  const literals = name.split(/\$\{\{.*?\}\}/);
  let pattern = literals.map(escape).join(".*");
  if (matrix && literals.length === 1) pattern += " \\(.*\\)";
  return new RegExp(`^${pattern}$`, "s").test(context);
}

interface ReportingJob {
  readonly name: string;
  readonly matrix: boolean;
}

function pullRequestJobs(root: string): ReportingJob[] {
  return readWorkflows(root)
    .workflows.filter((workflow) => triggerNames(workflow.data).includes("pull_request"))
    .flatMap((workflow) =>
      jobsOf(workflow).map(([id, job]) => {
        const strategy = job["strategy"];
        return {
          name: typeof job["name"] === "string" ? job["name"] : id,
          matrix: isRecord(strategy) && strategy["matrix"] !== undefined,
        };
      }),
    );
}

function requiredContexts(ruleset: unknown): string[] {
  const rules = isRecord(ruleset) ? ruleset["rules"] : undefined;
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule: unknown) => {
    if (!isRecord(rule) || rule["type"] !== "required_status_checks") return [];
    const parameters = rule["parameters"];
    const checks = isRecord(parameters) ? parameters["required_status_checks"] : undefined;
    return (Array.isArray(checks) ? checks : []).flatMap((entry: unknown) =>
      isRecord(entry) && typeof entry["context"] === "string" ? [entry["context"]] : [],
    );
  });
}

export const check: Check = {
  name: "ruleset-contexts",
  run: (root) => {
    const text = readRepoFile(root, RULESET);
    if (text === undefined) {
      return [
        {
          code: "ERR_CHECK_RULESET_MISSING",
          summary: `${RULESET} does not exist`,
          expected: `the main-branch ruleset at ${RULESET} (applied by \`just ruleset\`)`,
          actual: "no file",
          next: `restore ${RULESET} from version control`,
        },
      ];
    }
    let ruleset: unknown;
    try {
      ruleset = JSON.parse(text);
    } catch (error: unknown) {
      return [
        {
          code: "ERR_CHECK_RULESET_UNREADABLE",
          summary: `${RULESET} is not JSON`,
          expected: "a JSON ruleset in the shape GitHub's rulesets API takes",
          actual: error instanceof Error ? error.message : String(error),
          next: `fix the syntax of ${RULESET}`,
        },
      ];
    }
    const jobs = pullRequestJobs(root);
    return requiredContexts(ruleset)
      .filter((context) => !jobs.some((job) => nameMatches(context, job.name, job.matrix)))
      .map((context): FailureDetails => ({
        code: "ERR_CHECK_RULESET_CONTEXT",
        summary: `${RULESET}: required context "${context}" matches no job in a pull_request-triggered workflow`,
        expected:
          "every required context to equal a job's `name:` (or id) in a .github/workflows/*.yml triggered on pull_request",
        actual: `pull_request jobs report: ${jobs.map((job) => job.name).join(", ") || "none"}`,
        next: `rename the context in ${RULESET} to the job's current name, or restore the job (then \`just ruleset\` after merging, a human's step)`,
      }));
  },
};

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
