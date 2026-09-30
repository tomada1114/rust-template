/**
 * The gates `just check` runs and the steps CI runs stay the same set, apart from a
 * reasoned exception list (EXCEPTIONS below), so a gate added to one side cannot pass
 * locally and fail in CI, or the reverse. Ported from
 * macos-app-template's just-check-matches-ci.sh; ci.yml is read with `yaml`, the
 * justfile (not YAML or TOML) line by line.
 *
 *   node scripts/checks/just-check-matches-ci.ts [--root DIR]
 *
 * Files (both required): <root>/justfile and <root>/.github/workflows/ci.yml. CI means
 * ci.yml alone, the workflow whose jobs are the merge gate; the security and PR
 * workflows check things no local recipe could.
 *   - `just check`'s gates: every recipe reachable from `check` through dependencies
 *     (`a: b (c "x") && d`) and `just <recipe>` lines in a body.
 *   - a recipe's commands: its body lines, `\` continuations joined, comment and
 *     shebang lines dropped, a leading `@`/`-` removed, whitespace collapsed.
 *   - CI's steps: every `run:` in ci.yml's jobs (a job named in EXCEPTIONS.ciOnlyJobs
 *     aside), split into command lines the same way. A step that also names `uses:`
 *     runs nothing of its own.
 *   - what CI runs unconditionally: a command line counts as running a gate only in a
 *     step that runs on every CI run and whose failure fails the run — no `if:` on the
 *     step or its job, no `continue-on-error` other than `false` on either — and only
 *     when the line neither has an `||` fallback nor is a condition (`if`, `elif`,
 *     `while`, `until`, or `!` in front). Anything else may never run the gate, or run
 *     it without failing, so it counts as not running it.
 * Both directions:
 *   - every gate is run by CI unconditionally: some step says `just <gate>` (or `just`
 *     a recipe that reaches it), or every command in its body is a CI command line
 *     verbatim (so `lint`'s lines, split across CI's jobs, count), or its body is empty
 *     (its dependencies are gates themselves), or it is in EXCEPTIONS.localOnly;
 *   - every CI step is a gate: a step that calls `just` calls only gates (or
 *     EXCEPTIONS.ciOnlyRecipes; its other lines are glue, such as the bindings diff),
 *     and each line of a step that calls no recipe is a gate's command verbatim or in
 *     EXCEPTIONS.ciOnlyCommands.
 *   An exception that no longer applies (a localOnly recipe `just check` stopped
 *   running or CI now runs; a ciOnly recipe or command CI stopped running or a gate now
 *   runs) is reported as stale, so the list cannot outlive its reasons. ciOnlyJobs is
 *   not: the bootstrap removes that job from an app cut from the template.
 *
 * Git work tree: not required; the check reads files under --root.
 *
 * Errors (FailureDetails; the runner prints them all):
 *   ERR_CHECK_USAGE              bad arguments (scripts/checks/lib.ts)
 *   ERR_CHECK_JUST_CI_INPUT      the justfile or ci.yml is missing, or ci.yml has no jobs mapping
 *   ERR_CHECK_JUST_CI_NO_CHECK   the justfile defines no `check` recipe
 *   ERR_CHECK_JUST_CI_DIVERGED   a gate runs on one side only (or in CI only conditionally) and is not an exception
 *   ERR_CHECK_JUST_CI_STALE      an exception no longer applies
 */
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import {
  continuesOnError,
  isRecord,
  jobsOf,
  readYaml,
  scriptLines,
  stepsOf,
} from "./shared/workflows.ts";

const JUSTFILE = "justfile";
const CI = ".github/workflows/ci.yml";
const THIS = "scripts/checks/just-check-matches-ci.ts";

export interface Exceptions {
  /** `just check` gates CI deliberately does not run, with the reason. */
  readonly localOnly: Readonly<Record<string, string>>;
  /** Recipes CI runs (`just <recipe>`) that `just check` deliberately leaves out. */
  readonly ciOnlyRecipes: Readonly<Record<string, string>>;
  /** Command lines (whitespace collapsed) CI runs that no gate's recipe runs. */
  readonly ciOnlyCommands: Readonly<Record<string, string>>;
  /** Whole ci.yml jobs, by `name:` or id, outside the comparison. */
  readonly ciOnlyJobs: Readonly<Record<string, string>>;
}

/**
 * The exception list, one reason per entry. Adding an entry is weakening a gate
 * (AGENTS.md › Security and human approval): it needs the same review.
 */
export const EXCEPTIONS: Exceptions = {
  localOnly: {
    "verify-hooks":
      "asserts lefthook's pre-commit hook is installed in this checkout; a CI checkout has none and nobody commits there (the script skips when CI is set)",
    fmt: "rewrites files; CI checks the same formatting read-only through `just lint`'s `cargo fmt --all --check` and `pnpm format:check` lines, which this check matches verbatim",
  },
  ciOnlyRecipes: {
    bindings:
      "regenerates ui/src/ipc/generated/ (it writes files); CI runs it and diffs the result to catch a commit that forgot `just bindings`, while a developer runs it and commits the output",
  },
  ciOnlyCommands: {
    "corepack enable pnpm":
      "runner setup: `just install` enables pnpm once on a developer's Mac, not on every `just check`",
    'echo "path=$(pnpm store path)" >> "$GITHUB_OUTPUT"':
      "hands the pnpm store path to actions/cache: CI plumbing with no local meaning",
    "pnpm install --frozen-lockfile":
      "dependency install: `just install` runs it once on a developer's Mac, not on every `just check`",
    "node scripts/clippy-guard.ts cargo clippy --locked -p myapp-core -p myapp-test-support -p myapp-platform -p myapp-cli --all-targets -- -D warnings":
      "the Linux job lints only the crates that build without WebKitGTK; the macOS job runs `just lint`'s whole-workspace clippy line verbatim",
    "cargo deny --locked check":
      "`just deny`: fetches the RustSec advisory database over the network, so it stays out of the offline local gate; AGENTS.md › Validating a change runs it when a manifest or lockfile changes",
    "cargo shear --locked":
      "unused-dependency detection; AGENTS.md › Validating a change runs `mise exec -- cargo shear` when a manifest changes, and CI on every change",
    "cargo fetch --locked":
      "fills the Linux harness job's registry so `cargo metadata --offline` (the core-boundary check) can resolve; a developer's Mac already holds the crates after any build",
    "zizmor --format github .":
      "workflow security audit in GitHub's annotation format, with a read-only token for its online audits; AGENTS.md › Validating a change runs `mise exec -- zizmor` locally when a workflow changes",
  },
  ciOnlyJobs: {
    "Template Bootstrap Smoke":
      "template-only: bootstraps a throwaway copy and runs `just check` there; it tests the bootstrap, not this tree, and the bootstrap removes the job",
  },
};

export interface Recipe {
  readonly deps: string[];
  /** Body command lines, normalized (see the header). */
  readonly commands: string[];
  /** Recipes a body line runs with `just <recipe>`. */
  readonly calls: string[];
}

const HEADER = /^@?([A-Za-z_][A-Za-z0-9_-]*)(?:\s[^:]*)?:(?!=)(.*)$/;
const NOT_RECIPE = /^(?:set|export|alias|import|mod)\s/;
const DEP = /\(\s*([A-Za-z_][A-Za-z0-9_-]*)[^)]*\)|([A-Za-z_][A-Za-z0-9_-]*)/g;
const RECIPE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const normalize = (text: string): string => text.trim().replace(/\s+/g, " ");

/** The recipes a command runs through `just <recipe>` (flags skipped). */
function justCalls(command: string): string[] {
  const words = command.split(/[\s;&|()]+/);
  const calls: string[] = [];
  words.forEach((word, index) => {
    if (word !== "just") return;
    let next = index + 1;
    while (words[next]?.startsWith("-") === true) next += 1;
    const recipe = words[next];
    if (recipe !== undefined && RECIPE_NAME.test(recipe)) calls.push(recipe);
  });
  return calls;
}

function commandsOf(lines: readonly string[]): string[] {
  return scriptLines(lines.join("\n"))
    .map(([, text]) => normalize(text.replace(/^[@-]+/, "")))
    .filter((text) => text !== "");
}

/** The justfile's recipes by name, in file order. */
export function parseJustfile(text: string): Map<string, Recipe> {
  const recipes = new Map<string, Recipe>();
  let body: string[] | undefined;
  const flush = (name: string, deps: string[], lines: string[]): void => {
    const commands = commandsOf(lines);
    recipes.set(name, { deps, commands, calls: commands.flatMap(justCalls) });
  };
  let pending: { name: string; deps: string[] } | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || /^\s/.test(line)) {
      if (body !== undefined && line.trim() !== "") body.push(line);
      continue;
    }
    if (pending !== undefined && body !== undefined) flush(pending.name, pending.deps, body);
    pending = undefined;
    body = undefined;
    if (line.startsWith("#") || line.startsWith("[") || NOT_RECIPE.test(line)) continue;
    const match = HEADER.exec(line);
    if (match === null) continue;
    const [, name = "", rest = ""] = match;
    const deps = [...rest.replace(/\s+#.*$/, "").matchAll(DEP)].map(
      ([, inParens, bare]) => inParens ?? bare ?? "",
    );
    pending = { name, deps };
    body = [];
  }
  if (pending !== undefined && body !== undefined) flush(pending.name, pending.deps, body);
  return recipes;
}

/** Every recipe reachable from `starts` through dependencies and `just` calls. */
function closure(recipes: ReadonlyMap<string, Recipe>, starts: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const recipe = recipes.get(name);
    if (recipe !== undefined) queue.push(...recipe.deps, ...recipe.calls);
  }
  return seen;
}

interface CiStep {
  readonly where: string;
  readonly job: string;
  readonly lines: string[];
  readonly calls: string[];
  /** The lines that run whenever CI runs and fail it when they fail. */
  readonly counted: string[];
  /** Each other line, with why it does not count as running what it calls. */
  readonly uncounted: { readonly line: string; readonly why: string }[];
}

/** Whether a `continue-on-error` value lets a failure pass. */
/** Why a whole step never counts as running a gate, or undefined when it can. */
function stepCondition(
  job: Record<string, unknown>,
  step: Record<string, unknown>,
): string | undefined {
  if (job["if"] !== undefined) return "behind its job's `if:`";
  if (continuesOnError(job["continue-on-error"])) return "in a job with `continue-on-error`";
  if (step["if"] !== undefined) return "behind the step's `if:`";
  if (continuesOnError(step["continue-on-error"])) return "with `continue-on-error`";
  return undefined;
}

const CONDITION = /^(?:if|elif|while|until|!)\s/;

/** Why one command line does not count as running what it calls, or undefined. */
function lineCondition(line: string): string | undefined {
  if (line.replace(/'[^']*'/g, "''").includes("||")) return "with an `||` fallback";
  if (CONDITION.test(line)) return "as a condition";
  return undefined;
}

function input(actual: string): FailureDetails[] {
  return [
    {
      code: "ERR_CHECK_JUST_CI_INPUT",
      summary: "the justfile or ci.yml cannot be read",
      expected: `${JUSTFILE} and ${CI} (with a \`jobs\` mapping) under the root`,
      actual,
      next: "restore the file from version control",
    },
  ];
}

function readCiSteps(root: string, exceptions: Exceptions): CiStep[] | FailureDetails[] {
  const file = readYaml(root, CI);
  if (file === undefined) return input(`${CI}: no file`);
  if (typeof file === "string") return input(file);
  const data = file.data;
  if (!isRecord(data) || !isRecord(data["jobs"])) return input(`${CI}: no \`jobs\` mapping`);
  const steps: CiStep[] = [];
  for (const [id, job] of jobsOf({ ...file, data })) {
    const name = typeof job["name"] === "string" ? job["name"] : id;
    if (exceptions.ciOnlyJobs[name] !== undefined || exceptions.ciOnlyJobs[id] !== undefined) {
      continue;
    }
    for (const [index, step] of stepsOf(job)) {
      const run = step["run"];
      if (typeof run !== "string" || step["uses"] !== undefined) continue;
      const { line } = file.locate(["jobs", id, "steps", index, "run"]);
      const lines = scriptLines(run).map(([, text]) => normalize(text));
      const condition = stepCondition(job, step);
      const counted: string[] = [];
      const uncounted: { line: string; why: string }[] = [];
      for (const text of lines) {
        const why = condition ?? lineCondition(text);
        if (why === undefined) counted.push(text);
        else uncounted.push({ line: text, why });
      }
      steps.push({
        where: `${CI}:${String(line)}`,
        job: id,
        lines,
        calls: lines.flatMap(justCalls),
        counted,
        uncounted,
      });
    }
  }
  return steps;
}

const DIVERGED = {
  code: "ERR_CHECK_JUST_CI_DIVERGED",
  expected: `every \`just check\` gate run by a ${CI} step (as \`just <recipe>\`, or its recipe's lines verbatim), and every CI step to run only \`just check\` gates, apart from the exceptions in ${THIS}`,
  next: `add the gate to the side that lacks it (a CI step running \`just <recipe>\`, or the recipe joining \`check:\`), or, if it belongs on one side only, add it with its reason to EXCEPTIONS in ${THIS}`,
};

const STALE = {
  code: "ERR_CHECK_JUST_CI_STALE",
  expected: "every exception in EXCEPTIONS to describe a difference that still exists",
  next: `remove the stale entry and its reason from EXCEPTIONS in ${THIS}`,
};

/** The check against an explicit exception list (the tests pass their own). */
export function compare(root: string, exceptions: Exceptions): FailureDetails[] {
  const text = readRepoFile(root, JUSTFILE);
  if (text === undefined) return input(`${JUSTFILE}: no file`);
  const steps = readCiSteps(root, exceptions);
  if (steps.some((step) => "code" in step)) return steps as FailureDetails[];
  const ciSteps = steps as CiStep[];
  const recipes = parseJustfile(text);
  if (!recipes.has("check")) {
    return [
      {
        code: "ERR_CHECK_JUST_CI_NO_CHECK",
        summary: `${JUSTFILE} defines no \`check\` recipe`,
        expected: `a \`check: <recipe> …\` recipe in ${JUSTFILE}`,
        actual: `recipes: ${[...recipes.keys()].join(", ") || "none"}`,
        next: `restore the \`check\` recipe, or update ${THIS} in the same change`,
      },
    ];
  }

  const gates = closure(recipes, ["check"]);
  const gateCommands = new Set([...gates].flatMap((gate) => recipes.get(gate)?.commands ?? []));
  // Every line CI runs, for the stray and stale checks; only the counted ones run a gate.
  const ciCommands = new Set(ciSteps.flatMap((step) => step.lines));
  const ciCalls = new Set(ciSteps.flatMap((step) => step.calls));
  const countedCommands = new Set(ciSteps.flatMap((step) => step.counted));
  const countedReach = closure(
    recipes,
    ciSteps.flatMap((step) => step.counted.flatMap(justCalls)),
  );
  const unrun = (gate: string): string[] | undefined => {
    if (countedReach.has(gate)) return undefined;
    const missing = (recipes.get(gate)?.commands ?? []).filter(
      (line) => !countedCommands.has(line),
    );
    return missing.length === 0 ? undefined : missing;
  };
  /** Where CI runs a gate only conditionally, for the message. */
  const conditionally = (gate: string): string[] => {
    const commands = new Set(recipes.get(gate)?.commands ?? []);
    return ciSteps.flatMap((step) =>
      step.uncounted
        .filter(({ line }) => commands.has(line) || closure(recipes, justCalls(line)).has(gate))
        .map(({ line, why }) => `\`${line}\` at ${step.where}, ${why}`),
    );
  };

  const found: FailureDetails[] = [];
  for (const gate of gates) {
    if (gate === "check" || exceptions.localOnly[gate] !== undefined) continue;
    const missing = unrun(gate);
    if (missing === undefined) continue;
    const partial = conditionally(gate);
    found.push({
      ...DIVERGED,
      summary:
        partial.length === 0
          ? `${JUSTFILE}: \`just check\` runs \`just ${gate}\`, but no ${CI} step runs it`
          : `${JUSTFILE}: \`just check\` runs \`just ${gate}\`, but ${CI} runs it only conditionally, so a failure can pass CI`,
      actual: [
        `CI runs neither \`just ${gate}\` nor these lines of its recipe on every run, failing on failure: ${missing.join("; ")}`,
        ...(partial.length === 0 ? [] : [`it runs only as ${partial.join("; ")}`]),
      ].join("; "),
    });
  }
  for (const step of ciSteps) {
    const strays =
      step.calls.length > 0
        ? step.calls
            .filter((call) => !gates.has(call) && exceptions.ciOnlyRecipes[call] === undefined)
            .map((call) => `\`just ${call}\``)
        : step.lines
            .filter(
              (line) => !gateCommands.has(line) && exceptions.ciOnlyCommands[line] === undefined,
            )
            .map((line) => `\`${line}\``);
    for (const stray of strays) {
      found.push({
        ...DIVERGED,
        summary: `${step.where}: job \`${step.job}\` runs ${stray}, which \`just check\` does not run`,
        actual: `the step runs: ${step.lines.join("; ")}`,
      });
    }
  }

  const stale = (entry: string, why: string): void => {
    found.push({ ...STALE, summary: `EXCEPTIONS lists ${entry}, but ${why}`, actual: why });
  };
  for (const recipe of Object.keys(exceptions.localOnly)) {
    if (!gates.has(recipe)) stale(`localOnly \`${recipe}\``, "`just check` no longer runs it");
    else if (unrun(recipe) === undefined) stale(`localOnly \`${recipe}\``, `${CI} now runs it`);
  }
  for (const recipe of Object.keys(exceptions.ciOnlyRecipes)) {
    if (!ciCalls.has(recipe)) stale(`ciOnlyRecipes \`${recipe}\``, `no ${CI} step runs it`);
    else if (gates.has(recipe)) stale(`ciOnlyRecipes \`${recipe}\``, "`just check` now runs it");
  }
  for (const command of Object.keys(exceptions.ciOnlyCommands)) {
    const line = normalize(command);
    if (!ciCommands.has(line)) stale(`ciOnlyCommands \`${line}\``, `no ${CI} step runs it`);
    else if (gateCommands.has(line)) {
      stale(`ciOnlyCommands \`${line}\``, "a `just check` recipe now runs it");
    }
  }
  return found;
}

export const check: Check = {
  name: "just-check-matches-ci",
  run: (root) => compare(root, EXCEPTIONS),
};

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
