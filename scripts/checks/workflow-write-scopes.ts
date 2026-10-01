/**
 * No workflow job whose token holds a write scope runs repository code. A job's token
 * is what a compromised dependency, build script, or `mise.toml` tool would act with, so
 * a job that writes (a release, a label, a SARIF upload, an OIDC token) must not also
 * put the repository's code on the runner and run it. release.yml keeps every write
 * scope in `publish`, which downloads the build job's verified artifact instead of
 * checking out; this check keeps it, and every other workflow, that way.
 *
 *   node scripts/checks/workflow-write-scopes.ts [--root DIR]
 *
 * Read: every `.github/workflows/*.yml` and `*.yaml` under --root. A workflow that does
 * not parse is skipped here: workflow-hygiene.ts reports it as
 * ERR_CHECK_WORKFLOW_UNREADABLE.
 *
 * Rules:
 * - A job's effective permissions are its own `permissions` when it has the key,
 *   whatever the value, else the workflow's top-level `permissions`, else the default
 *   token's. The default counts as write: the repository setting may grant it, and an
 *   unproven grant is never safe. `write-all`, `id-token: write`, and any scope value
 *   other than `read` or `none` count as write.
 * - A job holding a write scope fails when a step uses `actions/checkout` or
 *   `jdx/mise-action`, or a local action (`uses: ./…`, repository code by definition);
 *   when a `run:` line names `pnpm`, `cargo`, or `just` as a word (or a path ending in
 *   one); or when the job calls a remote reusable workflow, whose steps the check cannot
 *   see. A local reusable workflow is checked in its own file, with its own permissions.
 *   A step's or a job's `if:` is ignored: a conditional step still counts.
 * - A job that genuinely needs a write scope and one of these is a human's decision,
 *   recorded in EXCEPTIONS below with the triggers it may keep and its reason; an
 *   exception that no longer applies, or a trigger it allows that the job no longer has,
 *   fails as stale.
 *
 * Git work tree: not required; the check reads files under --root.
 *
 * Errors (FailureDetails; the runner prints them all):
 *   ERR_CHECK_USAGE                          bad arguments (scripts/checks/lib.ts)
 *   ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE       a job holding a write scope runs repository
 *                                            code outside EXCEPTIONS
 *   ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE an exception names no write-holding job, or
 *                                            allows a trigger the job no longer has
 */
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, type Check } from "./lib.ts";
import {
  isRecord,
  jobsOf,
  readWorkflows,
  scriptLines,
  stepsOf,
  type Key,
  type Workflow,
} from "./shared/workflows.ts";

const THIS = "scripts/checks/workflow-write-scopes.ts";

/** The actions that put repository code on the runner, or run it. */
export const REPO_CODE_ACTIONS = ["actions/checkout", "jdx/mise-action"] as const;
/** The commands that run repository code (its manifests, scripts, and recipes). */
export const REPO_CODE_COMMANDS = ["pnpm", "cargo", "just"] as const;

export type Trigger =
  | (typeof REPO_CODE_ACTIONS)[number]
  | (typeof REPO_CODE_COMMANDS)[number]
  | "local action"
  | "reusable workflow";

export interface WriteException {
  /** The triggers this job may keep while it holds a write scope. */
  readonly allows: readonly Trigger[];
  readonly reason: string;
}

/**
 * Jobs allowed to hold a write scope and keep the triggers in `allows`, keyed
 * `<workflow path> <job id>`. Adding an entry, or a trigger to one, is weakening a gate
 * (AGENTS.md › Security and human approval): it needs a human's sign-off.
 */
export const EXCEPTIONS: Readonly<Record<string, WriteException>> = {
  ".github/workflows/codeql.yml analyze": {
    allows: ["actions/checkout"],
    reason:
      "security-events: write uploads the SARIF; CodeQL extracts the checked-out source with build-mode: none, so no repository code runs",
  },
  ".github/workflows/pr-label.yml label": {
    allows: ["actions/checkout", "jdx/mise-action"],
    reason:
      "pull-requests: write applies the label; the checkout is the pull request's base commit, never its head, so the script and mise.toml that run with the token are already on the default branch",
  },
  ".github/workflows/scorecard.yml analysis": {
    allows: ["actions/checkout"],
    reason:
      "security-events: write uploads the SARIF and id-token: write publishes the score; scorecard-action reads the checkout and runs no repository code",
  },
};

const DEFAULT_TOKEN = "the default token permissions (no permissions on the job or the workflow)";

/**
 * The write grants a job's token holds, as strings; empty when it holds none. The job's
 * own `permissions` replace the workflow's whole, so `contents: read` under a top-level
 * `write-all` holds no write.
 */
export function writeScopes(workflow: Workflow, job: Record<string, unknown>): string[] {
  let source: unknown;
  if (Object.hasOwn(job, "permissions")) source = job["permissions"];
  else if (Object.hasOwn(workflow.data, "permissions")) source = workflow.data["permissions"];
  else return [DEFAULT_TOKEN];
  if (source === "write-all") return ["write-all"];
  if (source === "read-all") return [];
  if (typeof source === "string") return [`permissions: ${source}`];
  if (isRecord(source)) {
    return Object.entries(source).flatMap(([scope, value]) =>
      value === "read" || value === "none" ? [] : [`${scope}: ${String(value)}`],
    );
  }
  return [`permissions: ${JSON.stringify(source)}`];
}

/** One trigger in a write-holding job: where it is, and what to say about it. */
interface Hit {
  readonly trigger: Trigger;
  readonly line: number;
  readonly what: string;
  readonly actual: string;
}

function lineOf(workflow: Workflow, keys: readonly Key[]): number {
  return workflow.locate(keys).line;
}

function actionHit(uses: string, line: number): Hit | undefined {
  if (uses.startsWith("actions/checkout@")) {
    return {
      trigger: "actions/checkout",
      line,
      what: "checks out the repository (actions/checkout)",
      actual: uses,
    };
  }
  if (uses.startsWith("jdx/mise-action@")) {
    return { trigger: "jdx/mise-action", line, what: "runs jdx/mise-action", actual: uses };
  }
  if (uses.startsWith("./")) {
    return {
      trigger: "local action",
      line,
      what: `runs the local action \`${uses}\``,
      actual: uses,
    };
  }
  return undefined;
}

/** A run line's repository-code commands, each the first word naming it. */
function commandsIn(line: string): (typeof REPO_CODE_COMMANDS)[number][] {
  const found: (typeof REPO_CODE_COMMANDS)[number][] = [];
  for (const word of line.split(/\s+/)) {
    const tool = REPO_CODE_COMMANDS.find((name) => word === name || word.endsWith(`/${name}`));
    if (tool !== undefined && !found.includes(tool)) found.push(tool);
  }
  return found;
}

/** The first line each command appears on in a run step, in order of appearance. */
function runHits(workflow: Workflow, keys: readonly Key[], run: string): Hit[] {
  const { line, block } = workflow.locate(keys);
  const hits: Hit[] = [];
  for (const [offset, text] of scriptLines(run)) {
    for (const tool of commandsIn(text)) {
      if (hits.some((hit) => hit.trigger === tool)) continue;
      hits.push({
        trigger: tool,
        line: block ? line + 1 + offset : line,
        what: `runs \`${tool}\``,
        actual: text,
      });
    }
  }
  return hits;
}

/** Every trigger a job has, in step order; a local reusable call has none here. */
function jobHits(workflow: Workflow, id: string, job: Record<string, unknown>): Hit[] {
  const uses = job["uses"];
  if (typeof uses === "string") {
    if (uses.startsWith("./")) return [];
    return [
      {
        trigger: "reusable workflow",
        line: lineOf(workflow, ["jobs", id, "uses"]),
        what: `calls the reusable workflow \`${uses}\``,
        actual: uses,
      },
    ];
  }
  return stepsOf(job).flatMap(([index, step]) => {
    const keys: Key[] = ["jobs", id, "steps", index];
    const stepUses = step["uses"];
    const run = step["run"];
    if (typeof stepUses === "string") {
      const hit = actionHit(stepUses, lineOf(workflow, [...keys, "uses"]));
      return hit === undefined ? [] : [hit];
    }
    return typeof run === "string" ? runHits(workflow, [...keys, "run"], run) : [];
  });
}

const RUNS_CODE = {
  code: "ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE",
  expected: `no job holding a write scope or \`id-token: write\` (its own \`permissions\`, or the workflow's it inherits) checks out the repository, runs jdx/mise-action or a local action, calls a remote reusable workflow, or runs pnpm, cargo, or just, outside EXCEPTIONS in ${THIS}`,
  next: "move the write scopes into a job that runs none of these (release.yml's `publish` downloads the verified artifact instead of checking out); if the job genuinely needs both, add an EXCEPTIONS entry with its reason, which is weakening a gate and needs a human's sign-off",
};

/** What the scan knows about each job, keyed `<workflow path> <job id>`. */
interface JobFacts {
  readonly scopes: readonly string[];
  readonly triggers: ReadonlySet<Trigger>;
}

function stale(key: string, why: string, actual: string): FailureDetails {
  return {
    code: "ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE",
    summary: `the exception for \`${key}\` ${why}`,
    expected:
      "every EXCEPTIONS entry to name a job that holds a write scope and still has each trigger it allows",
    actual,
    next: `remove the entry, or the trigger from its \`allows\`, in ${THIS}'s EXCEPTIONS`,
  };
}

function staleFindings(
  key: string,
  exception: WriteException,
  jobs: ReadonlyMap<string, JobFacts>,
): FailureDetails[] {
  const space = key.indexOf(" ");
  if (space === -1) {
    return [stale(key, "does not split into `<workflow path> <job id>`", `key: ${key}`)];
  }
  const facts = jobs.get(key);
  if (facts === undefined) {
    return [
      stale(
        key,
        "names no job in a readable workflow",
        `no job \`${key.slice(space + 1)}\` in ${key.slice(0, space)}`,
      ),
    ];
  }
  if (facts.scopes.length === 0) {
    return [stale(key, "names a job that holds no write scope", "write scopes: none")];
  }
  if (exception.allows.length === 0) {
    return [stale(key, "allows no trigger", "allows: []")];
  }
  return [...new Set(exception.allows)]
    .filter((trigger) => !facts.triggers.has(trigger))
    .map((trigger) =>
      stale(
        key,
        `allows \`${trigger}\`, which the job no longer has`,
        `the job's triggers: ${[...facts.triggers].join(", ") || "none"}`,
      ),
    );
}

/** The check's violations under `root`, given the exception list. */
export function scan(
  root: string,
  exceptions: Readonly<Record<string, WriteException>>,
): FailureDetails[] {
  const { workflows } = readWorkflows(root);
  const violations: FailureDetails[] = [];
  const jobs = new Map<string, JobFacts>();
  for (const workflow of workflows) {
    for (const [id, job] of jobsOf(workflow)) {
      const key = `${workflow.path} ${id}`;
      const scopes = writeScopes(workflow, job);
      const hits = scopes.length === 0 ? [] : jobHits(workflow, id, job);
      jobs.set(key, { scopes, triggers: new Set(hits.map((hit) => hit.trigger)) });
      const allowed = exceptions[key]?.allows ?? [];
      for (const hit of hits) {
        if (allowed.includes(hit.trigger)) continue;
        violations.push({
          ...RUNS_CODE,
          summary: `${workflow.path}:${String(hit.line)}: job \`${id}\` holds ${scopes.join(", ")} and ${hit.what}`,
          actual: hit.actual,
        });
      }
    }
  }
  for (const [key, exception] of Object.entries(exceptions)) {
    violations.push(...staleFindings(key, exception, jobs));
  }
  return violations;
}

export const check: Check = {
  name: "workflow-write-scopes",
  run: (root) => scan(root, EXCEPTIONS),
};
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
