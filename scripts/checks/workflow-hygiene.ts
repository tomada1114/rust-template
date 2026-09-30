/**
 * Every GitHub Actions workflow is pinned, least-privileged, bounded in time, fails
 * closed, installs from the lockfile, and cannot cancel a run on `main`
 * (issue #129). Ported from macos-app-template's workflow-hygiene.sh and
 * workflow-pins-and-permissions.sh, with instant-composition's workflow rules, reading
 * each file with the `yaml` parser instead of by line.
 *
 *   node scripts/checks/workflow-hygiene.ts [--root DIR]
 *
 * Files: <root>/.github/workflows/*.yml|*.yaml (absent directory: nothing to check); the
 * repository's own composite actions (every action.yml|action.yaml under
 * <root>/.github/actions/, and any other one a step's `uses: ./…` names); <root>/justfile
 * for the lockfile rule; and for the bot-prefix rule <root>/.github/dependabot.yml|.yaml
 * and the Renovate config (shared/workflows.ts's readRenovate; a JSON5 config is a finding,
 * since it cannot be read).
 * Rules, per workflow (the step rules also per composite action step):
 *   - pins: every `uses:` (a step's, or a job's reusable-workflow call) other than a
 *     local `./` action is `owner/repo[/path]@<40 lowercase hex>`, and the raw source
 *     line carrying it has a `# vX.Y.Z` comment (the form Dependabot keeps when it bumps
 *     a pin). YAML drops comments, so that one rule reads the raw line.
 *   - every job has `timeout-minutes` (a reusable-workflow call cannot, and is exempt);
 *   - the top-level `permissions` is `{}` or grants at most `contents: read`; every job
 *     declares its own `permissions` mapping (never a `read-all`/`write-all` shorthand);
 *   - every `actions/checkout` step sets `persist-credentials: false`;
 *   - no `pull_request_target` trigger;
 *   - a workflow triggered on `pull_request` has a top-level `concurrency` whose group
 *     names `github.workflow`. On a workflow also triggered on `push`, every
 *     `concurrency` — the top-level one and each job's — never cancels a push run: its
 *     `cancel-in-progress` is absent, false, or an expression that is false on a push,
 *     and its group, evaluated for a push (shared/expressions.ts), contains
 *     `github.sha`, `github.run_id`, or `github.run_number`, since GitHub also cancels a
 *     *pending* run that a newer one joins in its group. An expression the evaluator
 *     cannot read counts as unproven, never as safe;
 *   - no `continue-on-error` on a job or a step, other than `false`: a failing step
 *     would report success;
 *   - fail-closed `run:` steps: each resolves (step `shell`, then the job's, then the
 *     workflow's `defaults.run.shell`) to exactly FAIL_CLOSED_SHELL, or its first
 *     command is `set -euo pipefail` (`-Eeuo` and similar count). A step whose own
 *     shell is not sh-family (`pwsh`, `python`) is outside this rule;
 *   - fail-open commands: no `set +e`/`+u` (or `set +o errexit|nounset|pipefail`) in a
 *     `run:`, and no command whose failure is swallowed by an `|| true`, `|| :`,
 *     `|| exit 0`, `|| echo …`, or `|| printf …` fallback;
 *   - every `pnpm install`/`pnpm i` (global options such as `--dir ui` before it
 *     included) has `--frozen-lockfile`; no `npm install`/`npm i`/`npm add`; every
 *     `cargo` CARGO_LOCKED subcommand has `--locked` (or `--frozen`) before any `--`;
 *     and every `tauri build`/`tauri dev` passes `--locked` (or `--frozen`) to cargo as
 *     a runner argument after its `--`. The same rule reads every justfile recipe line,
 *     which is what lets a `run:` that calls `just <recipe>` rely on the recipe.
 * And once for the repository:
 *   - bot commit prefixes: every Dependabot `updates[].commit-message.prefix` (and
 *     `prefix-development`), and Renovate's `commitMessagePrefix` (top level and in
 *     `packageRules`), exist and lead with a type every PR-title check accepts: the
 *     `types` input of each step using amannn/action-semantic-pull-request, or the
 *     action's defaults when the input is unset. Skipped when neither bot is configured.
 *
 * Git work tree: not required; the check reads files under --root.
 *
 * Errors (FailureDetails, one per finding; the runner prints them all):
 *   ERR_CHECK_USAGE                          bad arguments (scripts/checks/lib.ts)
 *   ERR_CHECK_WORKFLOW_UNREADABLE            a workflow (or local action) is not YAML, not a mapping, or has no `jobs` (`runs`) mapping
 *   ERR_CHECK_WORKFLOW_UNPINNED              a `uses:` is not pinned to a full commit SHA
 *   ERR_CHECK_WORKFLOW_PIN_COMMENT           a SHA pin has no `# vX.Y.Z` comment on its line
 *   ERR_CHECK_WORKFLOW_TIMEOUT               a job has no `timeout-minutes`
 *   ERR_CHECK_WORKFLOW_PERMISSIONS           the top-level `permissions` is missing or broader than `contents: read`
 *   ERR_CHECK_WORKFLOW_JOB_PERMISSIONS       a job declares no `permissions` mapping of its own
 *   ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS  an actions/checkout step keeps its credentials
 *   ERR_CHECK_WORKFLOW_PULL_REQUEST_TARGET   a workflow triggers on `pull_request_target`
 *   ERR_CHECK_WORKFLOW_CONCURRENCY           a PR workflow has no concurrency, or a concurrency can cancel a push run
 *   ERR_CHECK_WORKFLOW_CONTINUE_ON_ERROR     a job or step sets `continue-on-error`
 *   ERR_CHECK_WORKFLOW_SHELL                 a `run:` step does not fail closed
 *   ERR_CHECK_WORKFLOW_FAIL_OPEN             a `run:` turns errexit off or swallows a failure with an `||` fallback
 *   ERR_CHECK_WORKFLOW_UNLOCKED              an install, cargo, or tauri command (in a workflow, an action, or the justfile) ignores the lockfile
 *   ERR_CHECK_WORKFLOW_BOT_PREFIX            a bot's commit prefix is missing or not a PR-title type, or a bot config (a JSON5 Renovate one included) cannot be read
 */
import { basename } from "node:path";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import { isWholeExpression, templateOnPush, truthy, type PushValue } from "./shared/expressions.ts";
import {
  DEPENDABOT_FILES,
  actionStepsOf,
  continuesOnError,
  isRecord,
  jobsOf,
  readActions,
  readRenovate,
  readWorkflows,
  readYaml,
  scriptLines,
  stepsOf,
  TITLE_ACTION,
  titleChecks,
  triggerNames,
  type Action,
  type Key,
  type Workflow,
  type YamlFile,
} from "./shared/workflows.ts";

const WORKFLOWS_DIR = ".github/workflows";
const JUSTFILE = "justfile";

/** The shell every `run:` step resolves to unless it starts with `set -euo pipefail`. */
export const FAIL_CLOSED_SHELL = "bash --noprofile --norc -euo pipefail {0}";

const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const VERSION_COMMENT = /#\s*v\d+\.\d+\.\d+(?:[\s-]|$)/;
const SET_FAIL_CLOSED = /^set\s+-(?=[A-Za-z]*e)(?=[A-Za-z]*u)[A-Za-z]*o\s+pipefail(?:[\s;]|$)/;
const PER_RUN_CONTEXTS = new Set(["github.sha", "github.run_id", "github.run_number"]);
const SH_FAMILY = new Set(["sh", "bash", "dash", "ksh", "zsh"]);
/** Cargo subcommands that resolve Cargo.lock, and so take `--locked`. */
const CARGO_LOCKED = new Set([
  "bench",
  "build",
  "check",
  "clippy",
  "deny",
  "doc",
  "fetch",
  "install",
  "llvm-cov",
  "nextest",
  "run",
  "shear",
  "test",
]);
const PNPM_INSTALL = new Set(["install", "i"]);
const NPM_INSTALL = new Set(["install", "i", "add"]);
const TAURI_BUILDS = new Set(["build", "dev"]);
/** An `||` whose right side is a command that always succeeds. */
const SWALLOWING_FALLBACK =
  /\|\|\s*(?:(?:true|:|exit\s+0)(?=\s*(?:$|[;&|)}#]))|(?:echo|printf)(?=$|[\s;&|)}]))/;
const ERREXIT_OFF =
  /^set\s(?:.*\s)?(?:\+[A-Za-z]*[eu][A-Za-z]*|\+o\s+(?:errexit|nounset|pipefail))(?:\s|$)/;

interface Rule {
  readonly code: string;
  readonly expected: string;
  readonly next: string;
}

const RULES = {
  unpinned: {
    code: "ERR_CHECK_WORKFLOW_UNPINNED",
    expected: "every non-local `uses:` to read `owner/repo[/path]@<40-hex SHA> # vX.Y.Z`",
    next: "replace the ref with the release's full commit SHA and a trailing `# vX.Y.Z` comment",
  },
  pinComment: {
    code: "ERR_CHECK_WORKFLOW_PIN_COMMENT",
    expected: "a `# vX.Y.Z` comment after the SHA on the same line (the release the SHA is)",
    next: "append the release tag the SHA points at, e.g. `# v4.3.0`, so Dependabot and a reviewer can read it",
  },
  timeout: {
    code: "ERR_CHECK_WORKFLOW_TIMEOUT",
    expected: "`timeout-minutes:` on every job (a hung job otherwise holds a runner for 6 hours)",
    next: "add `timeout-minutes:` to the job, a little above its slowest green run",
  },
  permissions: {
    code: "ERR_CHECK_WORKFLOW_PERMISSIONS",
    expected: "a top-level `permissions:` of `{}` or `contents: read`, and nothing broader",
    next: "set the top-level `permissions:` to `contents: read` and move each wider scope into the job that needs it",
  },
  jobPermissions: {
    code: "ERR_CHECK_WORKFLOW_JOB_PERMISSIONS",
    expected: "a `permissions:` mapping on every job, naming only the scopes that job uses",
    next: "add `permissions:` to the job (e.g. `contents: read`), spelling out scopes instead of a shorthand",
  },
  checkout: {
    code: "ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS",
    expected: "`with: persist-credentials: false` on every actions/checkout step",
    next: "add `persist-credentials: false` under the step's `with:` (a later step that pushes gets its own token)",
  },
  pullRequestTarget: {
    code: "ERR_CHECK_WORKFLOW_PULL_REQUEST_TARGET",
    expected: "no workflow triggered on `pull_request_target`",
    next: "trigger on `pull_request` instead; a write that must run on forks belongs in a separate, reviewed workflow",
  },
  concurrency: {
    code: "ERR_CHECK_WORKFLOW_CONCURRENCY",
    expected:
      "a top-level `concurrency:` on every pull_request workflow with a group naming `github.workflow`; on a workflow also run on push, every concurrency (top-level and per job) with a group that is unique per push run when evaluated for a push, and a cancel that is false on a push",
    next: "copy ci.yml's block: `group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}` and `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`",
  },
  continueOnError: {
    code: "ERR_CHECK_WORKFLOW_CONTINUE_ON_ERROR",
    expected:
      "no `continue-on-error` on a job or step (AGENTS.md › Security and human approval lists it as weakening a gate)",
    next: "remove it; a step that must not run in some case is skipped by an `if:` on that condition instead",
  },
  shell: {
    code: "ERR_CHECK_WORKFLOW_SHELL",
    expected: `every \`run:\` step to resolve to \`shell: ${FAIL_CLOSED_SHELL}\` or to start with \`set -euo pipefail\``,
    next: `add a top-level \`defaults: run: shell: ${FAIL_CLOSED_SHELL}\` (as ci.yml does), or start the script with \`set -euo pipefail\``,
  },
  failOpen: {
    code: "ERR_CHECK_WORKFLOW_FAIL_OPEN",
    expected:
      "no `set +e`/`set +u`/`set +o errexit|nounset|pipefail`, and no `|| true`, `|| :`, `|| exit 0`, `|| echo`, or `|| printf` fallback, in a `run:`",
    next: "let the command fail the step; when a failure is expected, test for it explicitly (`if ! cmd; then …; exit 1; fi`) or skip the step with an `if:`",
  },
  unlocked: {
    code: "ERR_CHECK_WORKFLOW_UNLOCKED",
    expected:
      "`--frozen-lockfile` on every `pnpm install`, no `npm install`, `--locked` on every cargo build/check/clippy/doc/test/bench/run/install/fetch/nextest/llvm-cov/deny/shear before any `--`, and `-- --locked` on every `tauri build`/`tauri dev`",
    next: "add the flag (a `tauri build` passes it to cargo after `--`), or call the `just` recipe that already carries it",
  },
  botPrefix: {
    code: "ERR_CHECK_WORKFLOW_BOT_PREFIX",
    expected:
      "every Dependabot `commit-message.prefix` and Renovate `commitMessagePrefix` set, with a type every PR-title check's `types` lists",
    next: "set the prefix (e.g. `deps:`) and add its type to check-pr-title.yml's `types` in the same change, or use a type it already lists",
  },
} as const satisfies Record<string, Rule>;

function finding(rule: Rule, summary: string, actual: string): FailureDetails {
  return { code: rule.code, summary, expected: rule.expected, actual, next: rule.next };
}

function at(file: YamlFile, keys: readonly Key[]): string {
  return `${file.path}:${String(file.locate(keys).line)}`;
}

/** One step, in a workflow's job or a composite action, with what the step rules need. */
interface StepSite {
  readonly file: YamlFile;
  /** Who owns the step, for a message: "job `build`" or "action `…/action.yml`". */
  readonly owner: string;
  /** The key path to the step mapping. */
  readonly keys: readonly Key[];
  readonly step: Record<string, unknown>;
  /** The job's or workflow's `defaults.run.shell`, which a step without its own inherits. */
  readonly defaultShell: string | undefined;
}

function shellOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const run = value["run"];
  if (!isRecord(run)) return undefined;
  const shell = run["shell"];
  return typeof shell === "string" ? shell : undefined;
}

function workflowSteps(workflow: Workflow): StepSite[] {
  const workflowShell = shellOf(workflow.data["defaults"]);
  return jobsOf(workflow).flatMap(([id, job]) => {
    const defaultShell = shellOf(job["defaults"]) ?? workflowShell;
    return stepsOf(job).map(([index, step]) => ({
      file: workflow,
      owner: `job \`${id}\``,
      keys: ["jobs", id, "steps", index],
      step,
      defaultShell,
    }));
  });
}

function actionSteps(action: Action): StepSite[] {
  return actionStepsOf(action).map(([index, step]) => ({
    file: action,
    owner: `action \`${action.path}\``,
    keys: ["runs", "steps", index],
    step,
    defaultShell: undefined,
  }));
}

function checkUses(file: YamlFile, keys: readonly Key[], uses: string): FailureDetails[] {
  if (uses.startsWith("./")) return [];
  const where = at(file, keys);
  if (!PINNED.test(uses)) {
    return [finding(RULES.unpinned, `${where}: \`${uses}\` is not pinned to a commit SHA`, uses)];
  }
  const raw = file.lines[file.locate(keys).line - 1] ?? "";
  if (!VERSION_COMMENT.test(raw)) {
    return [
      finding(RULES.pinComment, `${where}: \`${uses}\` has no \`# vX.Y.Z\` comment`, raw.trim()),
    ];
  }
  return [];
}

function checkJobCalls(workflow: Workflow): FailureDetails[] {
  return jobsOf(workflow).flatMap(([id, job]) => {
    const call = job["uses"];
    return typeof call === "string" ? checkUses(workflow, ["jobs", id, "uses"], call) : [];
  });
}

function checkStepPins(site: StepSite): FailureDetails[] {
  const uses = site.step["uses"];
  return typeof uses === "string" ? checkUses(site.file, [...site.keys, "uses"], uses) : [];
}

function checkTimeouts(workflow: Workflow): FailureDetails[] {
  return jobsOf(workflow)
    .filter(([, job]) => job["uses"] === undefined && job["timeout-minutes"] === undefined)
    .map(([id]) =>
      finding(
        RULES.timeout,
        `${at(workflow, ["jobs", id])}: job \`${id}\` has no timeout-minutes`,
        "no `timeout-minutes:` on the job (a step's does not count)",
      ),
    );
}

function describePermissions(value: unknown): string {
  return value === undefined ? "none declared" : JSON.stringify(value);
}

function checkPermissions(workflow: Workflow): FailureDetails[] {
  const found: FailureDetails[] = [];
  const top = workflow.data["permissions"];
  const narrow =
    isRecord(top) &&
    Object.entries(top).every(
      ([scope, level]) => scope === "contents" && (level === "read" || level === "none"),
    );
  if (!narrow) {
    found.push(
      finding(
        RULES.permissions,
        top === undefined
          ? `${workflow.path}: no top-level permissions`
          : `${at(workflow, ["permissions"])}: the top-level permissions are broader than contents: read`,
        `permissions: ${describePermissions(top)}`,
      ),
    );
  }
  for (const [id, job] of jobsOf(workflow)) {
    const own = job["permissions"];
    if (isRecord(own)) continue;
    found.push(
      finding(
        RULES.jobPermissions,
        `${at(workflow, ["jobs", id])}: job \`${id}\` declares no permissions mapping of its own`,
        `permissions: ${describePermissions(own)}`,
      ),
    );
  }
  return found;
}

function checkCheckout(site: StepSite): FailureDetails[] {
  const uses = site.step["uses"];
  if (typeof uses !== "string" || !uses.startsWith("actions/checkout@")) return [];
  const withInputs = site.step["with"];
  const persist = isRecord(withInputs) ? withInputs["persist-credentials"] : undefined;
  if (persist === false || persist === "false") return [];
  return [
    finding(
      RULES.checkout,
      `${at(site.file, [...site.keys, "uses"])}: actions/checkout in ${site.owner} keeps its credentials`,
      `persist-credentials: ${describePermissions(persist)}`,
    ),
  ];
}

/** Why a push run's concurrency group is not unique per run, or undefined when it is. */
function sharedPushGroup(group: string): string | undefined {
  const parts = templateOnPush(group);
  if (parts === undefined) {
    return `group \`${group}\` cannot be evaluated for a push run (only literals, contexts, !, ==, !=, &&, ||, and parentheses are read), so it is not shown unique per push run`;
  }
  const perRun = parts.some(
    (part: PushValue) => part.kind === "context" && PER_RUN_CONTEXTS.has(part.path),
  );
  if (perRun) return undefined;
  return `group \`${group}\` is shared by push runs (on a push it has no github.sha, run_id, or run_number), so a newer push cancels a pending one`;
}

/** Whether a `cancel-in-progress` value is false on a push run. */
function cancelSafeOnPush(cancel: unknown): boolean {
  if (cancel === undefined || cancel === false || cancel === "false") return true;
  if (typeof cancel !== "string" || !isWholeExpression(cancel)) return false;
  const [value] = templateOnPush(cancel.trim()) ?? [];
  return value !== undefined && truthy(value) === false;
}

/** What is wrong with one concurrency (top-level or a job's) on a workflow run on push. */
function pushConcurrencyProblems(concurrency: unknown): string[] {
  const group = isRecord(concurrency) ? concurrency["group"] : concurrency;
  const cancel = isRecord(concurrency) ? concurrency["cancel-in-progress"] : undefined;
  const problems: string[] = [];
  if (!cancelSafeOnPush(cancel)) {
    problems.push(
      `cancel-in-progress \`${JSON.stringify(cancel)}\` is not false on a push, so it can cancel a push run`,
    );
  }
  if (typeof group === "string") {
    const shared = sharedPushGroup(group);
    if (shared !== undefined) problems.push(shared);
  }
  return problems;
}

function checkTriggersAndConcurrency(workflow: Workflow): FailureDetails[] {
  const found: FailureDetails[] = [];
  const events = triggerNames(workflow.data);
  if (events.includes("pull_request_target")) {
    found.push(
      finding(
        RULES.pullRequestTarget,
        `${at(workflow, ["on"])}: the workflow runs on pull_request_target`,
        `on: ${events.join(", ")}`,
      ),
    );
  }
  const onPush = events.includes("push");
  for (const [id, job] of jobsOf(workflow)) {
    const own = job["concurrency"];
    if (own === undefined || !onPush) continue;
    const group = isRecord(own) ? own["group"] : own;
    const problems = pushConcurrencyProblems(own);
    if (typeof group !== "string" || group.trim() === "") {
      problems.unshift("the job's concurrency has no group");
    }
    for (const problem of problems) {
      found.push(
        finding(
          RULES.concurrency,
          `${at(workflow, ["jobs", id, "concurrency"])}: job \`${id}\`: ${problem}`,
          JSON.stringify(own),
        ),
      );
    }
  }
  const concurrency = workflow.data["concurrency"];
  const where = at(workflow, ["concurrency"]);
  const onPullRequest = events.includes("pull_request") || events.includes("pull_request_target");
  if (concurrency === undefined) {
    if (onPullRequest) {
      found.push(
        finding(
          RULES.concurrency,
          `${workflow.path}: runs on pull requests but has no top-level concurrency`,
          "no `concurrency:`, so a superseded run keeps its runner until it finishes",
        ),
      );
    }
    return found;
  }
  const group = isRecord(concurrency) ? concurrency["group"] : concurrency;
  const problems: string[] = [];
  if (typeof group !== "string" || group.trim() === "") {
    problems.push("the concurrency has no group");
  } else if (!group.includes("github.workflow")) {
    problems.push(
      `group \`${group}\` does not name github.workflow, so another workflow can share it`,
    );
  }
  if (onPush) problems.push(...pushConcurrencyProblems(concurrency));
  for (const problem of problems) {
    found.push(finding(RULES.concurrency, `${where}: ${problem}`, JSON.stringify(concurrency)));
  }
  return found;
}

function checkJobContinueOnError(workflow: Workflow): FailureDetails[] {
  return jobsOf(workflow)
    .filter(([, job]) => continuesOnError(job["continue-on-error"]))
    .map(([id, job]) =>
      finding(
        RULES.continueOnError,
        `${at(workflow, ["jobs", id, "continue-on-error"])}: job \`${id}\` sets continue-on-error, so its failure never fails the run`,
        `continue-on-error: ${JSON.stringify(job["continue-on-error"])}`,
      ),
    );
}

function checkStepContinueOnError(site: StepSite): FailureDetails[] {
  const value = site.step["continue-on-error"];
  if (!continuesOnError(value)) return [];
  return [
    finding(
      RULES.continueOnError,
      `${at(site.file, [...site.keys, "continue-on-error"])}: a step in ${site.owner} sets continue-on-error, so its failure never fails the job`,
      `continue-on-error: ${JSON.stringify(value)}`,
    ),
  ];
}

const normalize = (text: string): string => text.trim().replace(/\s+/g, " ");

function checkShell(site: StepSite): FailureDetails[] {
  const run = site.step["run"];
  if (typeof run !== "string") return [];
  const own = typeof site.step["shell"] === "string" ? site.step["shell"] : undefined;
  const shell = own ?? site.defaultShell;
  const program = basename(shell?.trim().split(/\s+/)[0] ?? "bash");
  if (!SH_FAMILY.has(program)) return [];
  if (shell !== undefined && normalize(shell) === FAIL_CLOSED_SHELL) return [];
  const first = scriptLines(run)[0]?.[1] ?? "";
  if (SET_FAIL_CLOSED.test(first)) return [];
  return [
    finding(
      RULES.shell,
      `${at(site.file, [...site.keys, "run"])}: a run step in ${site.owner} does not fail closed`,
      `shell: ${shell ?? "(the runner's default, bash -e {0})"}; first command: ${first}`,
    ),
  ];
}

/** A run script's logical lines with the file line each starts on. */
function runLines(site: StepSite): [number, string][] {
  const run = site.step["run"];
  if (typeof run !== "string") return [];
  const { line, block } = site.file.locate([...site.keys, "run"]);
  return scriptLines(run).map(([offset, text]): [number, string] => [
    block ? line + 1 + offset : line,
    text,
  ]);
}

/** A line with its single-quoted strings emptied and a trailing comment dropped. */
const unquoted = (text: string): string =>
  text.replace(/'[^']*'/g, "''").replace(/(?:^|\s)#.*$/, "");

/** Why one shell line fails open, or undefined when it does not. */
export function failOpenLine(line: string): string | undefined {
  const text = unquoted(line);
  const fallback = SWALLOWING_FALLBACK.exec(text);
  if (fallback !== null) {
    return `\`${normalize(fallback[0])}\` swallows the failure of the command before it`;
  }
  for (const command of text.split(/&&|\|\||;|\||\bthen\b|\bdo\b/)) {
    if (ERREXIT_OFF.test(command.trim())) {
      return `\`${normalize(command)}\` turns off failing on an error`;
    }
  }
  return undefined;
}

function checkFailOpen(site: StepSite): FailureDetails[] {
  const lines = runLines(site);
  const found: FailureDetails[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const [lineNumber, first] = lines[index] ?? [0, ""];
    let text = first;
    // Bash continues a line that ends in `||` onto the next one.
    while (/\|\|\s*$/.test(text) && index + 1 < lines.length) {
      index += 1;
      text = `${text} ${lines[index]?.[1] ?? ""}`;
    }
    const problem = failOpenLine(text);
    if (problem === undefined) continue;
    found.push(
      finding(
        RULES.failOpen,
        `${site.file.path}:${String(lineNumber)}: a run step in ${site.owner} fails open: ${problem}`,
        text,
      ),
    );
  }
  return found;
}

/** The subcommand after a package manager's global options, with its index. */
function subcommand(
  words: readonly string[],
  index: number,
  wanted: ReadonlySet<string>,
): string | undefined {
  let at = index + 1;
  while (words[at]?.startsWith("-") === true) {
    const flag = words[at] ?? "";
    at += 1;
    const next = words[at];
    // `--dir ui install`: a flag's value, unless it is already the wanted subcommand.
    if (!flag.includes("=") && next !== undefined && !next.startsWith("-") && !wanted.has(next)) {
      at += 1;
    }
  }
  return words[at];
}

/** Why one shell command ignores the lockfile, or undefined when it does not. */
export function unlockedCommand(command: string): string | undefined {
  const words = command.split(/\s+/).filter((word) => word !== "");
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "pnpm") {
      const sub = subcommand(words, index, PNPM_INSTALL);
      if (sub !== undefined && PNPM_INSTALL.has(sub) && !words.includes("--frozen-lockfile")) {
        return "`pnpm install` without --frozen-lockfile";
      }
    }
    if (word === "npm") {
      const sub = subcommand(words, index, NPM_INSTALL);
      if (sub !== undefined && NPM_INSTALL.has(sub)) {
        return `\`npm ${sub}\`, which resolves without pnpm-lock.yaml (use \`pnpm install --frozen-lockfile\`)`;
      }
    }
    if (word === "tauri") {
      const sub = words[index + 1];
      if (sub === undefined || !TAURI_BUILDS.has(sub)) continue;
      const rest = words.slice(index + 2);
      const separator = rest.indexOf("--");
      const runner = separator === -1 ? [] : rest.slice(separator + 1);
      const appSeparator = runner.indexOf("--");
      const runnerArgs = appSeparator === -1 ? runner : runner.slice(0, appSeparator);
      if (!runnerArgs.includes("--locked") && !runnerArgs.includes("--frozen")) {
        return `\`tauri ${sub}\` without \`-- --locked\` for cargo`;
      }
    }
    if (word === "cargo") {
      const start = words[index + 1]?.startsWith("+") === true ? index + 1 : index;
      const sub = subcommand(words, start, CARGO_LOCKED);
      if (sub === undefined || !CARGO_LOCKED.has(sub)) continue;
      // Global flags before the subcommand count too: `cargo --locked build` is locked.
      const rest = words.slice(start + 1);
      const separator = rest.indexOf("--");
      const args = separator === -1 ? rest : rest.slice(0, separator);
      if (!args.includes("--locked") && !args.includes("--frozen")) {
        return `\`cargo ${sub}\` without --locked`;
      }
    }
  }
  return undefined;
}

const COMMAND_SEPARATORS = /&&|\|\||;|\|/;

function checkLocked(site: StepSite): FailureDetails[] {
  const found: FailureDetails[] = [];
  for (const [line, text] of runLines(site)) {
    for (const command of text.split(COMMAND_SEPARATORS)) {
      const problem = unlockedCommand(command);
      if (problem === undefined) continue;
      found.push(
        finding(
          RULES.unlocked,
          `${site.file.path}:${String(line)}: ${problem} in ${site.owner}`,
          command.trim(),
        ),
      );
    }
  }
  return found;
}

/**
 * The lockfile rule over every justfile recipe line (an indented line, `\` continuations
 * joined, a leading `@`/`-` dropped), since a workflow's `just <recipe>` relies on it.
 */
function checkJustfileLocked(root: string): FailureDetails[] {
  const text = readRepoFile(root, JUSTFILE);
  if (text === undefined) return [];
  const lines = text.split("\n");
  const found: FailureDetails[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    let line = lines[index] ?? "";
    if (!/^\s+\S/.test(line)) continue;
    while (line.endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      line = `${line.slice(0, -1)} ${lines[index] ?? ""}`;
    }
    const body = line.trim().replace(/^[@-]+/, "");
    if (body.startsWith("#")) continue;
    for (const command of body.split(COMMAND_SEPARATORS)) {
      const problem = unlockedCommand(command);
      if (problem === undefined) continue;
      found.push(
        finding(
          RULES.unlocked,
          `${JUSTFILE}:${String(start + 1)}: ${problem} in a recipe`,
          command.trim(),
        ),
      );
    }
  }
  return found;
}

function checkSteps(sites: readonly StepSite[]): FailureDetails[] {
  return sites.flatMap((site) => [
    ...checkStepPins(site),
    ...checkCheckout(site),
    ...checkStepContinueOnError(site),
    ...checkShell(site),
    ...checkFailOpen(site),
    ...checkLocked(site),
  ]);
}

interface Prefix {
  readonly where: string;
  readonly setting: string;
  readonly value: unknown;
}

function dependabotPrefixes(root: string): { prefixes: Prefix[]; problems: string[] } | undefined {
  const path = DEPENDABOT_FILES.find((candidate) => readRepoFile(root, candidate) !== undefined);
  if (path === undefined) return undefined;
  const file = readYaml(root, path);
  if (typeof file !== "object") return { prefixes: [], problems: [String(file)] };
  const updates = isRecord(file.data) ? file.data["updates"] : undefined;
  const prefixes: Prefix[] = [];
  (Array.isArray(updates) ? updates : []).forEach((entry: unknown, index) => {
    if (!isRecord(entry)) return;
    const ecosystem = entry["package-ecosystem"];
    const who = `Dependabot \`${typeof ecosystem === "string" ? ecosystem : `updates[${String(index)}]`}\``;
    const message = entry["commit-message"];
    const settings = isRecord(message) ? message : {};
    prefixes.push({
      where: at(file, ["updates", index, "commit-message", "prefix"]),
      setting: `${who} commit-message.prefix`,
      value: settings["prefix"],
    });
    if (settings["prefix-development"] !== undefined) {
      prefixes.push({
        where: at(file, ["updates", index, "commit-message", "prefix-development"]),
        setting: `${who} commit-message.prefix-development`,
        value: settings["prefix-development"],
      });
    }
  });
  return { prefixes, problems: [] };
}

function renovatePrefixes(root: string): { prefixes: Prefix[]; problems: string[] } | undefined {
  const reading = readRenovate(root);
  if (reading === undefined) return undefined;
  if ("problem" in reading) return { prefixes: [], problems: [reading.problem] };
  const { path, config } = reading;
  const prefixes: Prefix[] = [
    { where: path, setting: "Renovate commitMessagePrefix", value: config["commitMessagePrefix"] },
  ];
  const rules = config["packageRules"];
  (Array.isArray(rules) ? rules : []).forEach((rule: unknown, index) => {
    if (isRecord(rule) && rule["commitMessagePrefix"] !== undefined) {
      prefixes.push({
        where: path,
        setting: `Renovate packageRules[${String(index)}].commitMessagePrefix`,
        value: rule["commitMessagePrefix"],
      });
    }
  });
  return { prefixes, problems: [] };
}

function checkBotPrefixes(root: string, workflows: readonly Workflow[]): FailureDetails[] {
  const bots = [dependabotPrefixes(root), renovatePrefixes(root)].filter(
    (bot) => bot !== undefined,
  );
  if (bots.length === 0) return [];
  const found = bots.flatMap((bot) =>
    bot.problems.map((problem) =>
      finding(RULES.botPrefix, "a dependency bot's config cannot be read", problem),
    ),
  );
  const checks = titleChecks(workflows);
  if (checks.length === 0) {
    return [
      ...found,
      finding(
        RULES.botPrefix,
        `no workflow step uses amannn/action-semantic-pull-request, so no bot prefix can be checked`,
        `no ${TITLE_ACTION}… step under ${WORKFLOWS_DIR}/`,
      ),
    ];
  }
  for (const { where, setting, value } of bots.flatMap((bot) => bot.prefixes)) {
    if (typeof value !== "string" || value.trim() === "") {
      found.push(
        finding(
          RULES.botPrefix,
          `${where}: ${setting} is not set`,
          "no prefix, so the bot titles its PRs `Bump …`",
        ),
      );
      continue;
    }
    const type = /^[A-Za-z0-9_-]+/.exec(value.trim())?.[0];
    const refusing = checks.filter((title) => type === undefined || !title.types.includes(type));
    for (const title of refusing) {
      found.push(
        finding(
          RULES.botPrefix,
          `${where}: ${setting} \`${value}\` is not a type the title check at ${title.where} accepts`,
          `type ${type === undefined ? "(none)" : `\`${type}\``}; accepted: ${title.types.join(", ")}`,
        ),
      );
    }
  }
  return found;
}

export const check: Check = {
  name: "workflow-hygiene",
  run: (root) => {
    const { workflows, unreadable } = readWorkflows(root);
    const { actions, unreadable: unreadableActions } = readActions(root, workflows);
    return [
      ...unreadable,
      ...unreadableActions,
      ...workflows.flatMap((workflow) => [
        ...checkJobCalls(workflow),
        ...checkTimeouts(workflow),
        ...checkPermissions(workflow),
        ...checkTriggersAndConcurrency(workflow),
        ...checkJobContinueOnError(workflow),
        ...checkSteps(workflowSteps(workflow)),
      ]),
      ...actions.flatMap((action) => checkSteps(actionSteps(action))),
      ...checkJustfileLocked(root),
      ...checkBotPrefixes(root, workflows),
    ];
  },
};

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
