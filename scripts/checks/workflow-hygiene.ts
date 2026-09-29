/**
 * Every GitHub Actions workflow is pinned, least-privileged, bounded in time, fails
 * closed, installs from the lockfile, and cannot cancel a run on `main` (design D14,
 * issue #129). Ported from macos-app-template's workflow-hygiene.sh and
 * workflow-pins-and-permissions.sh, with instant-composition's workflow rules, reading
 * each file with the `yaml` parser instead of by line.
 *
 *   node scripts/checks/workflow-hygiene.ts [--root DIR]
 *
 * Files: <root>/.github/workflows/*.yml|*.yaml (absent directory: nothing to check), and
 * for the bot-prefix rule <root>/.github/dependabot.yml|.yaml and the first JSON Renovate
 * config found (RENOVATE_FILES; a JSON5 config is not read). Rules, per workflow:
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
 *     names `github.workflow`. A workflow also triggered on `push` never cancels a push
 *     run: `cancel-in-progress` is absent, false, or an expression true only for pull
 *     requests (`github.event_name == 'pull_request'` or `!= 'push'`), and its group
 *     is unique per push run (`github.sha`, `github.run_id`, or `github.run_number`),
 *     since GitHub also cancels a *pending* run that a newer one joins in its group;
 *   - fail-closed `run:` steps: each resolves (step `shell`, then the job's, then the
 *     workflow's `defaults.run.shell`) to exactly FAIL_CLOSED_SHELL, or its first
 *     command is `set -euo pipefail` (`-Eeuo` and similar count). A step whose own
 *     shell is not sh-family (`pwsh`, `python`) is outside this rule;
 *   - every `pnpm install`/`pnpm i` in a `run:` has `--frozen-lockfile`, and every
 *     `cargo build|test|clippy|nextest|llvm-cov|run` has `--locked` (or `--frozen`)
 *     before any `--`. A `just <recipe>` call is exempt: the justfile carries `--locked`.
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
 *   ERR_CHECK_WORKFLOW_UNREADABLE            a workflow is not YAML, not a mapping, or has no `jobs` mapping
 *   ERR_CHECK_WORKFLOW_UNPINNED              a `uses:` is not pinned to a full commit SHA
 *   ERR_CHECK_WORKFLOW_PIN_COMMENT           a SHA pin has no `# vX.Y.Z` comment on its line
 *   ERR_CHECK_WORKFLOW_TIMEOUT               a job has no `timeout-minutes`
 *   ERR_CHECK_WORKFLOW_PERMISSIONS           the top-level `permissions` is missing or broader than `contents: read`
 *   ERR_CHECK_WORKFLOW_JOB_PERMISSIONS       a job declares no `permissions` mapping of its own
 *   ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS  an actions/checkout step keeps its credentials
 *   ERR_CHECK_WORKFLOW_PULL_REQUEST_TARGET   a workflow triggers on `pull_request_target`
 *   ERR_CHECK_WORKFLOW_CONCURRENCY           a PR workflow has no concurrency, or it can cancel a push run
 *   ERR_CHECK_WORKFLOW_SHELL                 a `run:` step does not fail closed
 *   ERR_CHECK_WORKFLOW_UNLOCKED              an install or cargo command ignores the lockfile
 *   ERR_CHECK_WORKFLOW_BOT_PREFIX            a bot's commit prefix is missing or not a PR-title type
 */
import { basename } from "node:path";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import {
  DEPENDABOT_FILES,
  RENOVATE_FILES,
  isRecord,
  jobsOf,
  readWorkflows,
  readYaml,
  scriptLines,
  stepsOf,
  triggerNames,
  type Key,
  type Workflow,
  type YamlFile,
} from "./shared/workflows.ts";

const WORKFLOWS_DIR = ".github/workflows";

/** The shell every `run:` step resolves to unless it starts with `set -euo pipefail`. */
export const FAIL_CLOSED_SHELL = "bash --noprofile --norc -euo pipefail {0}";

/** amannn/action-semantic-pull-request's `types` when the input is unset (v6). */
const DEFAULT_TITLE_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];
const TITLE_ACTION = "amannn/action-semantic-pull-request@";

const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const VERSION_COMMENT = /#\s*v\d+\.\d+\.\d+(?:[\s-]|$)/;
const SET_FAIL_CLOSED = /^set\s+-(?=[A-Za-z]*e)(?=[A-Za-z]*u)[A-Za-z]*o\s+pipefail(?:[\s;]|$)/;
const PR_ONLY_CANCEL = /^\$\{\{\s*github\.event_name\s*(?:==\s*'pull_request'|!=\s*'push')\s*\}\}$/;
const PER_RUN_GROUP = /github\.(?:sha|run_id|run_number)\b/;
const SH_FAMILY = new Set(["sh", "bash", "dash", "ksh", "zsh"]);
const CARGO_LOCKED = new Set(["build", "test", "clippy", "nextest", "llvm-cov", "run"]);

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
      "a top-level `concurrency:` on every pull_request workflow with a group naming `github.workflow`; on a workflow also run on push, a group unique per push run and a cancel limited to pull requests",
    next: "copy ci.yml's block: `group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}` and `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`",
  },
  shell: {
    code: "ERR_CHECK_WORKFLOW_SHELL",
    expected: `every \`run:\` step to resolve to \`shell: ${FAIL_CLOSED_SHELL}\` or to start with \`set -euo pipefail\``,
    next: `add a top-level \`defaults: run: shell: ${FAIL_CLOSED_SHELL}\` (as ci.yml does), or start the script with \`set -euo pipefail\``,
  },
  unlocked: {
    code: "ERR_CHECK_WORKFLOW_UNLOCKED",
    expected:
      "`--frozen-lockfile` on every `pnpm install` and `--locked` on every cargo build/test/clippy/nextest/llvm-cov/run, before any `--`",
    next: "add the flag, or call the `just` recipe that already carries it",
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

function checkUses(workflow: Workflow, keys: readonly Key[], uses: string): FailureDetails[] {
  if (uses.startsWith("./")) return [];
  const where = at(workflow, keys);
  if (!PINNED.test(uses)) {
    return [finding(RULES.unpinned, `${where}: \`${uses}\` is not pinned to a commit SHA`, uses)];
  }
  const raw = workflow.lines[workflow.locate(keys).line - 1] ?? "";
  if (!VERSION_COMMENT.test(raw)) {
    return [
      finding(RULES.pinComment, `${where}: \`${uses}\` has no \`# vX.Y.Z\` comment`, raw.trim()),
    ];
  }
  return [];
}

function checkPins(workflow: Workflow): FailureDetails[] {
  return jobsOf(workflow).flatMap(([id, job]) => {
    const found: FailureDetails[] = [];
    const call = job["uses"];
    if (typeof call === "string") found.push(...checkUses(workflow, ["jobs", id, "uses"], call));
    for (const [index, step] of stepsOf(job)) {
      const uses = step["uses"];
      if (typeof uses === "string") {
        found.push(...checkUses(workflow, ["jobs", id, "steps", index, "uses"], uses));
      }
    }
    return found;
  });
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

function checkCheckouts(workflow: Workflow): FailureDetails[] {
  const found: FailureDetails[] = [];
  for (const [id, job] of jobsOf(workflow)) {
    for (const [index, step] of stepsOf(job)) {
      const uses = step["uses"];
      if (typeof uses !== "string" || !uses.startsWith("actions/checkout@")) continue;
      const withInputs = step["with"];
      const persist = isRecord(withInputs) ? withInputs["persist-credentials"] : undefined;
      if (persist === false || persist === "false") continue;
      found.push(
        finding(
          RULES.checkout,
          `${at(workflow, ["jobs", id, "steps", index, "uses"])}: actions/checkout in job \`${id}\` keeps its credentials`,
          `persist-credentials: ${describePermissions(persist)}`,
        ),
      );
    }
  }
  return found;
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
  const cancel = isRecord(concurrency) ? concurrency["cancel-in-progress"] : undefined;
  const problems: string[] = [];
  if (typeof group !== "string" || group.trim() === "") {
    problems.push("the concurrency has no group");
  } else if (!group.includes("github.workflow")) {
    problems.push(
      `group \`${group}\` does not name github.workflow, so another workflow can share it`,
    );
  }
  if (events.includes("push")) {
    const cancelSafe =
      cancel === undefined ||
      cancel === false ||
      cancel === "false" ||
      (typeof cancel === "string" && PR_ONLY_CANCEL.test(cancel.trim()));
    if (!cancelSafe) {
      problems.push(
        `cancel-in-progress \`${JSON.stringify(cancel)}\` is not limited to pull requests, so it can cancel a push run`,
      );
    }
    if (typeof group === "string" && !PER_RUN_GROUP.test(group)) {
      problems.push(
        `group \`${group}\` is shared by push runs, so a newer push cancels a pending one (key push runs by github.sha)`,
      );
    }
  }
  for (const problem of problems) {
    found.push(finding(RULES.concurrency, `${where}: ${problem}`, JSON.stringify(concurrency)));
  }
  return found;
}

function shellOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const run = value["run"];
  if (!isRecord(run)) return undefined;
  const shell = run["shell"];
  return typeof shell === "string" ? shell : undefined;
}

const normalize = (text: string): string => text.trim().replace(/\s+/g, " ");

function checkShells(workflow: Workflow): FailureDetails[] {
  const found: FailureDetails[] = [];
  const workflowShell = shellOf(workflow.data["defaults"]);
  for (const [id, job] of jobsOf(workflow)) {
    const jobShell = shellOf(job["defaults"]);
    for (const [index, step] of stepsOf(job)) {
      const run = step["run"];
      if (typeof run !== "string") continue;
      const own = typeof step["shell"] === "string" ? step["shell"] : undefined;
      const shell = own ?? jobShell ?? workflowShell;
      const program = basename(shell?.trim().split(/\s+/)[0] ?? "bash");
      if (!SH_FAMILY.has(program)) continue;
      if (shell !== undefined && normalize(shell) === FAIL_CLOSED_SHELL) continue;
      const first = scriptLines(run)[0]?.[1] ?? "";
      if (SET_FAIL_CLOSED.test(first)) continue;
      found.push(
        finding(
          RULES.shell,
          `${at(workflow, ["jobs", id, "steps", index, "run"])}: a run step in job \`${id}\` does not fail closed`,
          `shell: ${shell ?? "(the runner's default, bash -e {0})"}; first command: ${first}`,
        ),
      );
    }
  }
  return found;
}

/** Why one shell command ignores the lockfile, or undefined when it does not. */
export function unlockedCommand(command: string): string | undefined {
  const words = command.split(/\s+/).filter((word) => word !== "");
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "pnpm") {
      const sub = words[index + 1];
      if ((sub === "install" || sub === "i") && !words.includes("--frozen-lockfile")) {
        return "`pnpm install` without --frozen-lockfile";
      }
    }
    if (word === "cargo") {
      let subIndex = index + 1;
      if (words[subIndex]?.startsWith("+") === true) subIndex += 1;
      const sub = words[subIndex];
      if (sub === undefined || !CARGO_LOCKED.has(sub)) continue;
      const rest = words.slice(subIndex + 1);
      const separator = rest.indexOf("--");
      const args = separator === -1 ? rest : rest.slice(0, separator);
      if (!args.includes("--locked") && !args.includes("--frozen")) {
        return `\`cargo ${sub}\` without --locked`;
      }
    }
  }
  return undefined;
}

function checkLocked(workflow: Workflow): FailureDetails[] {
  const found: FailureDetails[] = [];
  for (const [id, job] of jobsOf(workflow)) {
    for (const [index, step] of stepsOf(job)) {
      const run = step["run"];
      if (typeof run !== "string") continue;
      const keys = ["jobs", id, "steps", index, "run"];
      const { line, block } = workflow.locate(keys);
      for (const [offset, text] of scriptLines(run)) {
        for (const command of text.split(/&&|\|\||;|\|/)) {
          const problem = unlockedCommand(command);
          if (problem === undefined) continue;
          const where = `${workflow.path}:${String(block ? line + 1 + offset : line)}`;
          found.push(
            finding(RULES.unlocked, `${where}: ${problem} in job \`${id}\``, command.trim()),
          );
        }
      }
    }
  }
  return found;
}

interface TitleCheck {
  readonly where: string;
  readonly types: readonly string[];
}

function titleChecks(workflows: readonly Workflow[]): TitleCheck[] {
  const checks: TitleCheck[] = [];
  for (const workflow of workflows) {
    for (const [id, job] of jobsOf(workflow)) {
      for (const [index, step] of stepsOf(job)) {
        const uses = step["uses"];
        if (typeof uses !== "string" || !uses.startsWith(TITLE_ACTION)) continue;
        const withInputs = step["with"];
        const types = isRecord(withInputs) ? withInputs["types"] : undefined;
        checks.push({
          where: at(workflow, ["jobs", id, "steps", index, "uses"]),
          types:
            typeof types === "string"
              ? types.split(/[\s,]+/).filter((type) => type !== "")
              : DEFAULT_TITLE_TYPES,
        });
      }
    }
  }
  return checks;
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
  for (const path of RENOVATE_FILES) {
    const text = readRepoFile(root, path);
    if (text === undefined) continue;
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch (error: unknown) {
      return {
        prefixes: [],
        problems: [`${path}: not JSON (${error instanceof Error ? error.message : String(error)})`],
      };
    }
    const top = isRecord(config) ? config : {};
    const prefixes: Prefix[] = [
      { where: path, setting: "Renovate commitMessagePrefix", value: top["commitMessagePrefix"] },
    ];
    const rules = top["packageRules"];
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
  return undefined;
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
    return [
      ...unreadable,
      ...workflows.flatMap((workflow) => [
        ...checkPins(workflow),
        ...checkTimeouts(workflow),
        ...checkPermissions(workflow),
        ...checkCheckouts(workflow),
        ...checkTriggersAndConcurrency(workflow),
        ...checkShells(workflow),
        ...checkLocked(workflow),
      ]),
      ...checkBotPrefixes(root, workflows),
    ];
  },
};

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
