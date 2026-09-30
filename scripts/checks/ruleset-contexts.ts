/**
 * Every required status check in the main-branch ruleset names a job that reports on
 * every pull request (design D14), so renaming a CI job, filtering its workflow, or
 * guarding it with an `if:` cannot leave a required check that never reports and blocks
 * every PR, or one that is skipped and passes without running. Ported from
 * macos-app-template's ruleset-contexts.sh, reading the ruleset with JSON.parse and
 * workflows with `yaml`.
 *
 *   node scripts/checks/ruleset-contexts.ts [--root DIR]
 *
 * Files: <root>/.github/rulesets/main.json (required) and .github/workflows/*.yml|*.yaml.
 *   - contexts: every `context` under a `required_status_checks` rule's
 *     `parameters.required_status_checks`. A ruleset with no such rule requires nothing.
 *   - jobs: those of workflows whose `on:` names `pull_request` (not
 *     `pull_request_target`: it runs the base branch's workflow, so a renamed job would
 *     not report under it either). A job reports as its `name:`, or its id without one.
 *     Each `${{ … }}` in a name is evaluated for a pull request (shared/expressions.ts):
 *     one that is a literal there is that text, and any other matches any text — unless
 *     the name has no literal text of its own, when it matches nothing, since
 *     `${{ matrix.os }}` would otherwise match every context. A matrix job whose name has
 *     no expression reports as `<name> (<values>)`, and matches that shape.
 *   - runs on every pull request: a matching job counts only when its workflow's
 *     `pull_request` trigger has no `paths`, `paths-ignore`, `branches`, or
 *     `branches-ignore` filter and its `types`, when set, include `opened`,
 *     `synchronize`, and `reopened`; its `if:`, when set, is true on every pull request
 *     (evaluated as above; one the evaluator cannot read is unproven, never true); and
 *     every job it `needs` runs on every pull request too.
 *   A workflow that does not parse is workflow-hygiene's to report; its jobs match nothing
 *   here.
 *
 * Git work tree: not required; the check reads files under --root.
 *
 * Errors (FailureDetails; the runner prints them all):
 *   ERR_CHECK_USAGE                    bad arguments (scripts/checks/lib.ts)
 *   ERR_CHECK_RULESET_MISSING          .github/rulesets/main.json does not exist
 *   ERR_CHECK_RULESET_UNREADABLE       .github/rulesets/main.json is not JSON
 *   ERR_CHECK_RULESET_CONTEXT          a required context matches no job in a pull_request workflow
 *   ERR_CHECK_RULESET_CONTEXT_SKIPPED  a required context matches only jobs that may not run on every pull request
 */
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import { conditionOn, evaluateOn } from "./shared/expressions.ts";
import {
  isRecord,
  jobsOf,
  readWorkflows,
  triggerNames,
  type Workflow,
} from "./shared/workflows.ts";

const RULESET = ".github/rulesets/main.json";
const EVENT = "pull_request";
const FILTERS = ["paths", "paths-ignore", "branches", "branches-ignore"];
/** The activity types a `pull_request` trigger runs on when it names none. */
const DEFAULT_TYPES = ["opened", "synchronize", "reopened"];
const EMBEDDED = /\$\{\{([\s\S]*?)\}\}/g;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a status context is what a job named `name` reports on a pull request: each
 * `${{ … }}` that is a literal there stands for its text, and any other matches any
 * text, unless the name has no literal text besides whitespace (then it matches
 * nothing). A matrix job whose name has no expression reports as `<name> (<values>)`.
 */
export function nameMatches(context: string, name: string, matrix: boolean): boolean {
  let pattern = "";
  let text = "";
  let last = 0;
  let open = false;
  let expressions = 0;
  for (const match of name.matchAll(EMBEDDED)) {
    expressions += 1;
    const before = name.slice(last, match.index);
    pattern += escape(before);
    text += before;
    const value = evaluateOn(EVENT, match[1] ?? "");
    if (value?.kind === "literal") {
      pattern += escape(value.value === null ? "" : String(value.value));
    } else {
      pattern += ".*";
      open = true;
    }
    last = match.index + match[0].length;
  }
  const after = name.slice(last);
  pattern += escape(after);
  text += after;
  if (open && text.trim() === "") return false;
  if (matrix && expressions === 0) pattern += " \\(.*\\)";
  return new RegExp(`^${pattern}$`, "s").test(context);
}

interface ReportingJob {
  readonly name: string;
  readonly matrix: boolean;
  /** Why the job may not run on every pull request; empty when it always does. */
  readonly skips: readonly string[];
}

/** Why a workflow's `pull_request` trigger may not fire on every pull request. */
function triggerSkips(workflow: Workflow): string[] {
  const on = workflow.data["on"];
  const trigger = isRecord(on) ? on[EVENT] : undefined;
  if (!isRecord(trigger)) return [];
  const skips = FILTERS.filter((key) => trigger[key] !== undefined).map(
    (key) => `${workflow.path}: its pull_request trigger filters \`${key}\``,
  );
  const types = trigger["types"];
  if (types !== undefined) {
    const listed = Array.isArray(types) ? types : [types];
    const missing = DEFAULT_TYPES.filter((type) => !listed.includes(type));
    if (missing.length > 0) {
      skips.push(
        `${workflow.path}: its pull_request trigger's \`types\` leave out ${missing.join(", ")}`,
      );
    }
  }
  return skips;
}

/** Why a job may not run on every pull request, following its `needs`. */
function jobSkips(
  workflow: Workflow,
  jobs: ReadonlyMap<string, Record<string, unknown>>,
  id: string,
  seen: ReadonlySet<string>,
): string[] {
  const job = jobs.get(id);
  if (job === undefined) return [`${workflow.path}: a job needs \`${id}\`, which does not exist`];
  if (seen.has(id)) return [`${workflow.path}: job \`${id}\` needs itself through a cycle`];
  const skips: string[] = [];
  const condition = job["if"];
  if (condition !== undefined && conditionOn(EVENT, condition) !== true) {
    skips.push(
      `${workflow.path}: job \`${id}\` has \`if: ${typeof condition === "string" ? condition : JSON.stringify(condition)}\`, which is not provably true on every pull request`,
    );
  }
  const needs = job["needs"];
  const needed = typeof needs === "string" ? [needs] : Array.isArray(needs) ? needs : [];
  for (const need of needed) {
    skips.push(
      ...(typeof need === "string"
        ? jobSkips(workflow, jobs, need, new Set([...seen, id]))
        : [`${workflow.path}: job \`${id}\` has a \`needs\` entry that is not a job id`]),
    );
  }
  return skips;
}

function pullRequestJobs(root: string): ReportingJob[] {
  return readWorkflows(root)
    .workflows.filter((workflow) => triggerNames(workflow.data).includes(EVENT))
    .flatMap((workflow) => {
      const trigger = triggerSkips(workflow);
      const jobs = new Map(jobsOf(workflow));
      return [...jobs].map(([id, job]) => {
        const strategy = job["strategy"];
        return {
          name: typeof job["name"] === "string" ? job["name"] : id,
          matrix: isRecord(strategy) && strategy["matrix"] !== undefined,
          skips: [...trigger, ...jobSkips(workflow, jobs, id, new Set())],
        };
      });
    });
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

function contextViolation(context: string, jobs: readonly ReportingJob[]): FailureDetails[] {
  const matching = jobs.filter((job) => nameMatches(context, job.name, job.matrix));
  if (matching.length === 0) {
    return [
      {
        code: "ERR_CHECK_RULESET_CONTEXT",
        summary: `${RULESET}: required context "${context}" matches no job in a pull_request-triggered workflow`,
        expected:
          "every required context to equal a job's `name:` (or id) in a .github/workflows/*.yml triggered on pull_request",
        actual: `pull_request jobs report: ${jobs.map((job) => job.name).join(", ") || "none"}`,
        next: `rename the context in ${RULESET} to the job's current name, or restore the job (then \`just ruleset\` after merging, a human's step)`,
      },
    ];
  }
  if (matching.some((job) => job.skips.length === 0)) return [];
  return [
    {
      code: "ERR_CHECK_RULESET_CONTEXT_SKIPPED",
      summary: `${RULESET}: required context "${context}" is reported only by jobs that may not run on every pull request`,
      expected:
        "a job reporting each required context on every pull request: no paths or branches filter on its workflow's pull_request trigger, the default activity types, and no `if:` (on it or a job it needs) that can be false",
      actual: [...new Set(matching.flatMap((job) => job.skips))].join("; "),
      next: `drop the filter or the \`if:\` from the job ${RULESET} requires (skip inside its steps instead), or remove the context from ${RULESET} (then \`just ruleset\` after merging, a human's step)`,
    },
  ];
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
    return requiredContexts(ruleset).flatMap((context) => contextViolation(context, jobs));
  },
};

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
