/**
 * Every required status check in the main-branch ruleset names a job that reports on
 * every pull request, so renaming a CI job, filtering its workflow, or
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
 *     not report under it either). A job reports as its `name:`, or its id without one,
 *     and a context must equal one of the names it reports exactly. A `strategy.matrix`
 *     written as literal lists is expanded as GitHub does (the product of its lists,
 *     less `exclude`, plus `include`), and each `${{ … }}` in a name is evaluated for a
 *     pull request with one combination's `matrix.*` values (shared/expressions.ts). A
 *     matrix job whose name has no expression reports as `<name> (<values>)`, its
 *     combination's values joined by `, `. A job that calls a reusable workflow in this
 *     repository (`uses: ./.github/workflows/<file>.yml`, the documented form, at most
 *     ten levels of workflows deep) reports each called job as `<caller> / <called job>`.
 *     A name this check cannot know from the files — an expression that is not fixed on a
 *     pull request, a computed matrix or one past 256 jobs, a matrix name whose
 *     expressions never read `matrix`, a workflow in another repository — matches nothing
 *     (fail closed), and the failure names it with the edit that would make it known.
 *     A job's `name:` that is a number or a boolean reports as GitHub's workflow parser
 *     converts a scalar where it expects a string (`123`, `true`); a null or fractional
 *     one is not known, and none is ever compared under the job's id.
 *   - the gated branches: each `conditions.ref_name.include` entry of the ruleset:
 *     `refs/heads/<branch>` (no pattern; a pattern include fails closed), `~ALL` (every
 *     branch), or `~DEFAULT_BRANCH`. GitHub keeps the default branch as a repository
 *     setting, not in a file, and this check stays offline, so it takes the one branch
 *     ci.yml's `on: push: branches:` names literally (patterns aside). When --root is the
 *     top of a git work tree whose `refs/remotes/origin/HEAD` exists (a developer's clone,
 *     or the Template Bootstrap Smoke job's scratch clone on a push to main; never an
 *     actions/checkout checkout, which has none), that branch must agree with it; with no
 *     single literal branch, origin/HEAD names the default branch itself (one of the
 *     literals, when ci.yml lists several). Not knowing the name fails nothing on its own:
 *     a trigger with no branch filter, or only `branches: ['**']`, fires into every branch.
 *     Only a required job whose trigger filters branches needs it, and then the check
 *     fails rather than guessing `main`.
 *   - runs on every pull request: a matching job counts only when its workflow's
 *     `pull_request` trigger has no `paths` or `paths-ignore` filter, its `branches`
 *     (when set) match every gated branch and no `!` pattern there matches one, its
 *     `branches-ignore` (when set) match none of them (under `~ALL`, neither filter but
 *     `branches: ['**']`), and its `types`, when set, include `opened`,
 *     `synchronize`, and `reopened`; its `if:`, when set, is true on every pull request
 *     (evaluated as above; one the evaluator cannot read is unproven, never true); and
 *     every job it `needs` runs on every pull request too. A called job counts only when
 *     the calling job and the called job (with the `needs` inside its workflow) both do.
 *   A workflow that does not parse is workflow-hygiene's to report; its jobs match nothing
 *   here.
 *
 * Git work tree: not required; the check reads files under --root, and reads
 * `refs/remotes/origin/HEAD` only when --root is the top of a work tree that has one.
 *
 * Errors (FailureDetails; the runner prints them all):
 *   ERR_CHECK_USAGE                    bad arguments (scripts/checks/lib.ts)
 *   ERR_CHECK_RULESET_MISSING          .github/rulesets/main.json does not exist
 *   ERR_CHECK_RULESET_UNREADABLE       .github/rulesets/main.json is not JSON
 *   ERR_CHECK_RULESET_BRANCH_UNKNOWN   a ruleset include is not one this check reads, or a required
 *                                      job filters branches and the default branch is not known
 *   ERR_CHECK_RULESET_BRANCH_MISMATCH  ci.yml's one literal push branch is not this clone's origin/HEAD
 *   ERR_CHECK_RULESET_CONTEXT          a required context matches no job in a pull_request workflow
 *   ERR_CHECK_RULESET_CONTEXT_SKIPPED  a required context matches only jobs that may not run on every pull request
 */
import { realpathSync } from "node:fs";

import type { FailureDetails } from "../lib/fail.ts";
import { gitEnv } from "../lib/git-env.ts";
import { runCommand, runScript, type Run } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import {
  conditionOn,
  evaluateOn,
  type ExpressionValue,
  type Resolve,
} from "./shared/expressions.ts";
import {
  isRecord,
  jobsOf,
  readWorkflows,
  readYaml,
  triggerNames,
  type Workflow,
} from "./shared/workflows.ts";

const RULESET = ".github/rulesets/main.json";
/** The workflow whose `on: push: branches:` declares the default branch. */
const CI = ".github/workflows/ci.yml";
const DEFAULT_BRANCH = "~DEFAULT_BRANCH";
const HEADS = "refs/heads/";
const ORIGIN = "refs/remotes/origin/";
/**
 * The characters that make a branch filter entry or a ruleset include a pattern (or a
 * negation). `+` is left out: it is literal in a git branch name and a ruleset include.
 */
const PATTERN = /[*?[\]!]/;
const EVENT = "pull_request";
const FILTERS = ["paths", "paths-ignore"];
/** The activity types a `pull_request` trigger runs on when it names none. */
const DEFAULT_TYPES = ["opened", "synchronize", "reopened"];
const EMBEDDED = /\$\{\{([\s\S]*?)\}\}/g;
/** The one form GitHub documents for calling a workflow in the same repository. */
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/[^/]+\.ya?ml$/;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One matrix combination: each key's value, in the order GitHub lists them. */
export type Combination = ReadonlyMap<string, unknown>;

/** Why a job's names cannot be known from the files, and the edit that would make them known. */
export interface Unresolved {
  readonly reason: string;
  readonly next: string;
}

/** The names a job reports on a pull request, or why they cannot be known from the files. */
export type JobNames = { readonly names: readonly string[] } | { readonly unresolved: Unresolved };

/** GitHub's limit on the jobs one matrix generates. */
export const MATRIX_LIMIT = 256;
/** How many combinations this check expands before `exclude`, to bound its own work. */
const EXPANSION_LIMIT = MATRIX_LIMIT * MATRIX_LIMIT;
/** GitHub's limit on the levels of workflows one run connects, the top-level one included. */
export const WORKFLOW_LEVELS = 10;

const LITERAL_MATRIX =
  "write the job's `strategy.matrix` as literal lists and mappings (no `${{ }}`), or require a job whose matrix is literal";
const FIXED_NAME =
  "build the job's `name:` only from text and expressions fixed on a pull request, such as `${{ matrix.os }}` over a literal matrix";
const CALL_FORM = "write the job's `uses:` as `./.github/workflows/<file>.yml`";

const unresolved = (reason: string, next: string): { readonly unresolved: Unresolved } => ({
  unresolved: { reason, next },
});

type Scalar = string | number | boolean | null;

const isScalar = (value: unknown): value is Scalar =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const hasExpression = (value: unknown): boolean =>
  value !== undefined && JSON.stringify(value).includes("${{");

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function entryList(
  matrix: Record<string, unknown>,
  key: "include" | "exclude",
): Record<string, unknown>[] | Unresolved {
  const value = matrix[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    return { reason: `its matrix's \`${key}\` is not a list of mappings`, next: LITERAL_MATRIX };
  }
  return value;
}

/**
 * A `strategy.matrix`'s combinations as GitHub expands them, or why they cannot be known
 * from the file: the product of its lists, less every combination an `exclude` entry
 * matches, then each `include` entry added to every combination whose original values
 * it agrees with (overwriting only values an earlier `include` added), or appended as a
 * combination of its own when it agrees with none. A matrix, list, or entry holding an
 * expression is computed at run time, so it is not known; neither is one past GitHub's
 * limit of 256 jobs, nor one with a key made only of digits, whose order a parsed
 * mapping does not keep.
 */
export function matrixCombinations(matrix: unknown): Combination[] | Unresolved {
  if (hasExpression(matrix)) {
    return { reason: "its matrix is computed by an expression", next: LITERAL_MATRIX };
  }
  if (!isRecord(matrix)) return { reason: "its matrix is not a mapping", next: LITERAL_MATRIX };
  const entries = [matrix, ...[matrix["include"], matrix["exclude"]].flat()].flatMap((entry) =>
    isRecord(entry) ? Object.keys(entry) : [],
  );
  const digits = entries.find((key) => /^\d+$/.test(key));
  if (digits !== undefined) {
    return {
      reason: `its matrix has the key \`${digits}\`, made only of digits, whose order this check cannot keep`,
      next: "rename that matrix key so it starts with a letter",
    };
  }
  const dimensions = Object.entries(matrix).filter(
    ([key]) => key !== "include" && key !== "exclude",
  );
  let size = 1;
  for (const [key, values] of dimensions) {
    if (!Array.isArray(values) || values.length === 0) {
      return { reason: `its matrix's \`${key}\` is not a non-empty list`, next: LITERAL_MATRIX };
    }
    size *= values.length;
  }
  const tooMany = {
    reason: `its matrix makes more than ${String(MATRIX_LIMIT)} combinations, GitHub's limit`,
    next: `cut the matrix to at most ${String(MATRIX_LIMIT)} combinations, or split the job`,
  };
  if (size > EXPANSION_LIMIT) {
    return {
      reason: `its matrix's lists multiply to more than ${String(EXPANSION_LIMIT)} combinations before \`exclude\`, more than this check expands`,
      next: tooMany.next,
    };
  }
  let combinations: Map<string, unknown>[] =
    dimensions.length === 0 ? [] : [new Map<string, unknown>()];
  for (const [key, values] of dimensions) {
    const list: unknown[] = Array.isArray(values) ? values : [];
    combinations = combinations.flatMap((combination) =>
      list.map((value) => new Map<string, unknown>([...combination, [key, value]])),
    );
  }
  const exclude = entryList(matrix, "exclude");
  const include = entryList(matrix, "include");
  if (!Array.isArray(exclude)) return exclude;
  if (!Array.isArray(include)) return include;
  combinations = combinations.filter(
    (combination) =>
      !exclude.some((entry) =>
        Object.entries(entry).every(([key, value]) => same(combination.get(key), value)),
      ),
  );
  const original = new Set(dimensions.map(([key]) => key));
  const expanded = combinations.length;
  for (const entry of include) {
    const pairs = Object.entries(entry);
    const agreeing = combinations
      .slice(0, expanded)
      .filter((combination) =>
        pairs.every(([key, value]) => !original.has(key) || same(combination.get(key), value)),
      );
    for (const combination of agreeing) {
      for (const [key, value] of pairs) combination.set(key, value);
    }
    if (agreeing.length === 0) combinations.push(new Map(pairs));
  }
  if (combinations.length === 0) {
    return { reason: "its matrix has no combinations", next: LITERAL_MATRIX };
  }
  return combinations.length > MATRIX_LIMIT ? tooMany : combinations;
}

/**
 * The `matrix.*` paths one combination defines, matched case-insensitively as GitHub
 * does. A property the combination does not have is `''`, as GitHub's contexts
 * reference documents for a nonexistent property; an object, a list, or a `*` filter is
 * unknown, since its text in a name is not documented.
 */
function matrixResolver(combination: Combination | undefined): Resolve {
  return (path: string): ExpressionValue | undefined => {
    if (combination === undefined || !path.startsWith("matrix.")) return undefined;
    let entries: [string, unknown][] = [...combination];
    let value: unknown;
    for (const key of path.split(".").slice(1)) {
      if (key === "*") return { kind: "unknown" };
      const found = entries.find(([name]) => name.toLowerCase() === key);
      if (found === undefined) return { kind: "literal", value: "" };
      value = found[1];
      entries = isRecord(value) ? Object.entries(value) : [];
    }
    return isScalar(value) ? { kind: "literal", value } : { kind: "unknown" };
  };
}

/**
 * A name with its expressions evaluated for a pull request and one combination, and
 * whether any of them reads `matrix`, or why it cannot be known.
 */
function renderName(
  name: string,
  combination: Combination | undefined,
): { readonly name: string; readonly readsMatrix: boolean } | { readonly unresolved: Unresolved } {
  let rendered = "";
  let last = 0;
  let readsMatrix = false;
  const fromMatrix = matrixResolver(combination);
  const resolve: Resolve = (path) => {
    if (path === "matrix" || path.startsWith("matrix.")) readsMatrix = true;
    return fromMatrix(path);
  };
  for (const match of name.matchAll(EMBEDDED)) {
    const value = evaluateOn(EVENT, match[1] ?? "", resolve);
    if (value === undefined) {
      return unresolved(
        `this check cannot evaluate \`${match[0]}\` (a function call, an index, or another form it does not read)`,
        FIXED_NAME,
      );
    }
    if (value.kind === "context") {
      return unresolved(
        `\`${match[0]}\` reads \`${value.path}\`, which is not fixed on a pull request`,
        FIXED_NAME,
      );
    }
    if (value.kind === "unknown") {
      return unresolved(`\`${match[0]}\` has no text this check can know`, FIXED_NAME);
    }
    rendered += name.slice(last, match.index) + (value.value === null ? "" : String(value.value));
    last = match.index + match[0].length;
  }
  return { name: rendered + name.slice(last), readsMatrix };
}

/**
 * Every name a job written as `name` reports on a pull request, given its
 * `strategy.matrix` (undefined without one). A matrix job whose name has no expression
 * reports as `<name> (<values>)`, its values each a string, number, or boolean; one
 * whose name reads `matrix` reports the name evaluated for each combination, with no
 * suffix. Whether GitHub appends the values to a name whose expressions never read
 * `matrix` is not documented, so that name is not known.
 */
export function jobNames(name: string, matrix: unknown): JobNames {
  if (matrix === undefined) {
    const rendered = renderName(name, undefined);
    return "name" in rendered ? { names: [rendered.name] } : rendered;
  }
  const combinations = matrixCombinations(matrix);
  if (!Array.isArray(combinations)) return { unresolved: combinations };
  const expressions = [...name.matchAll(EMBEDDED)].length;
  const names: string[] = [];
  for (const combination of combinations) {
    if (expressions === 0) {
      const values = [...combination.values()];
      if (!values.every((value) => value !== null && isScalar(value))) {
        return unresolved(
          "a matrix value is null, a mapping, or a list, whose text in the appended values is not documented",
          "name the job with the values it reads, such as `name: Test (${{ matrix.os }})`",
        );
      }
      names.push(`${name} (${values.map(String).join(", ")})`);
      continue;
    }
    const rendered = renderName(name, combination);
    if (!("name" in rendered)) return rendered;
    if (!rendered.readsMatrix) {
      return unresolved(
        "its name has expressions but none reads `matrix`, so whether GitHub appends the matrix values is not known",
        "read the matrix in the name (such as `${{ matrix.os }}`), or drop the name's expressions so GitHub appends the values",
      );
    }
    names.push(rendered.name);
  }
  return { names: [...new Set(names)] };
}

interface ReportingJob {
  /** The job as written, for messages: its name, or `<caller> / <called job>`. */
  readonly label: string;
  readonly names: JobNames;
  /** Why the job may not run on every pull request; empty when it always does. */
  readonly skips: readonly string[];
  /** Its workflow's branch filters that only the default branch's name could judge. */
  readonly needsDefault: readonly string[];
}

/**
 * A branch the ruleset gates: one by name, every branch (`~ALL`), or the default branch
 * when neither ci.yml nor this clone gives its name.
 */
export type Gated =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "all" }
  | ({ readonly kind: "unknown" } & Unresolved);

/**
 * Whether a GitHub branch filter pattern matches `branch`: `**` matches any text, `*`
 * any text but `/`, `?` one character.
 */
export function branchMatches(pattern: string, branch: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char === "*" && pattern.charAt(i + 1) === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += ".";
    else source += escape(char);
  }
  return new RegExp(`^${source}$`).test(branch);
}

/**
 * The branch `refs/remotes/origin/HEAD` names when `root` is the top of a git work tree
 * that has one, else undefined: a CI checkout has none, and a fixture is no work tree.
 */
export function originHead(root: string, run: Run = runCommand): string | undefined {
  const git = (args: readonly string[]): string | undefined => {
    const result = run("git", args, { cwd: root, env: gitEnv(process.env) });
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top === undefined || top === "") return undefined;
  try {
    if (realpathSync(top) !== realpathSync(root)) return undefined;
  } catch {
    return undefined;
  }
  const ref = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  return ref?.startsWith(ORIGIN) === true ? ref.slice(ORIGIN.length) : undefined;
}

const branchUnknown = (actual: string, next: string): FailureDetails => ({
  code: "ERR_CHECK_RULESET_BRANCH_UNKNOWN",
  summary: `${RULESET}: the branches the ruleset gates cannot be read from it`,
  expected: `each \`conditions.ref_name.include\` entry to be \`${DEFAULT_BRANCH}\`, \`~ALL\`, or \`refs/heads/<branch>\` with no pattern`,
  actual,
  next,
});

/**
 * The default branch's name, or why it is not known: the one literal branch among
 * ci.yml's `on: push: branches:` (patterns and negations aside), checked against
 * `readOrigin` (this clone's origin/HEAD); else origin/HEAD itself, when ci.yml names no
 * literal branch or names it among several. Not knowing it fails nothing on its own: only
 * a required job whose trigger filters branches needs the name.
 */
export function defaultBranch(
  root: string,
  readOrigin: () => string | undefined,
): { readonly name: string } | Unresolved | FailureDetails {
  const file = readYaml(root, CI);
  const data = file === undefined || typeof file === "string" ? undefined : file.data;
  const on = isRecord(data) ? data["on"] : undefined;
  const push = isRecord(on) ? on["push"] : undefined;
  const branches = isRecord(push) ? push["branches"] : undefined;
  const entries: unknown[] =
    typeof branches === "string" ? [branches] : Array.isArray(branches) ? branches : [];
  const literals = [
    ...new Set(
      entries.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry !== "" && !PATTERN.test(entry),
      ),
    ),
  ];
  const origin = readOrigin();
  const [only] = literals;
  if (literals.length === 1 && only !== undefined) {
    if (origin === undefined || origin === only) return { name: only };
    return {
      code: "ERR_CHECK_RULESET_BRANCH_MISMATCH",
      summary: `${CI} names \`${only}\` as the branch its push trigger runs on, but this clone's origin/HEAD is \`${origin}\``,
      expected: `the one branch \`on: push: branches:\` in ${CI} names literally to be the repository's default branch, the one \`${DEFAULT_BRANCH}\` in ${RULESET} gates`,
      actual: `${CI}: ${only}; refs/remotes/origin/HEAD: ${ORIGIN}${origin}`,
      next: `if the default branch was renamed, rename it in \`on: push: branches:\` in ${CI} too; if origin/HEAD is stale, run \`git remote set-head origin --auto\` and rerun the check`,
    };
  }
  if (origin !== undefined && (literals.length === 0 || literals.includes(origin))) {
    return { name: origin };
  }
  const named =
    literals.length === 0
      ? `${CI}'s \`on: push: branches:\` names no branch literally`
      : `${CI}'s \`on: push: branches:\` names several branches (${literals.join(", ")})`;
  return {
    reason: `${named}, and ${origin === undefined ? "this checkout has no origin/HEAD" : `origin/HEAD (\`${origin}\`) is none of them`}`,
    next: [
      "drop the `branches` filter from that job's pull_request trigger",
      ...(literals.length === 0 && branches !== undefined
        ? [
            `list the default branch by name in \`on: push: branches:\` in ${CI} (its patterns can stay)`,
          ]
        : []),
      "in a clone, run `git remote set-head origin --auto` so origin/HEAD names it (a CI checkout has none)",
      `or include the branch by name in ${RULESET} as \`refs/heads/<branch>\` (then \`just ruleset\` after merging, a human's step)`,
    ].join("; "),
  };
}

/**
 * The branches the ruleset gates, or why its includes cannot be read. `readOrigin` is
 * called only for `~DEFAULT_BRANCH`.
 */
export function gatedBranches(
  ruleset: unknown,
  root: string,
  readOrigin: () => string | undefined,
): Gated[] | FailureDetails {
  const conditions = isRecord(ruleset) ? ruleset["conditions"] : undefined;
  const refName = isRecord(conditions) ? conditions["ref_name"] : undefined;
  const include = isRecord(refName) ? refName["include"] : undefined;
  if (!Array.isArray(include) || include.length === 0) {
    return branchUnknown(
      `${RULESET} has no \`conditions.ref_name.include\` list`,
      `add \`"conditions": { "ref_name": { "include": ["${DEFAULT_BRANCH}"], "exclude": [] } }\` to ${RULESET}`,
    );
  }
  const gated: Gated[] = [];
  for (const entry of include) {
    if (entry === "~ALL") {
      gated.push({ kind: "all" });
      continue;
    }
    if (entry === DEFAULT_BRANCH) {
      const resolved = defaultBranch(root, readOrigin);
      if ("code" in resolved) return resolved;
      gated.push(
        "name" in resolved ? { kind: "name", ...resolved } : { kind: "unknown", ...resolved },
      );
      continue;
    }
    const name =
      typeof entry === "string" && entry.startsWith(HEADS) ? entry.slice(HEADS.length) : "";
    if (name === "" || PATTERN.test(name)) {
      return branchUnknown(
        `${RULESET} includes ${JSON.stringify(entry)}, which is not one branch this check can judge (a pattern, or another form)`,
        `write each include in ${RULESET} as \`${DEFAULT_BRANCH}\`, \`~ALL\`, or \`refs/heads/<branch>\``,
      );
    }
    gated.push({ kind: "name", name });
  }
  const seen = new Set<string>();
  return gated.filter((target) => {
    const key = JSON.stringify(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface BranchJudgement {
  readonly skips: string[];
  readonly needsDefault: string[];
}

/**
 * Why a `pull_request` trigger may not fire on a pull request into `target`, and which
 * of its filters only the unknown default branch's name could judge. A trigger with no
 * branch filter, or only `branches: ['**']`, fires into every branch.
 */
function branchJudgement(
  trigger: Record<string, unknown>,
  target: Gated,
  path: string,
): BranchJudgement {
  const list = (key: string): string[] | undefined => {
    const value = trigger[key];
    if (value === undefined) return undefined;
    return (Array.isArray(value) ? value : [value]).map(String);
  };
  const judgement: BranchJudgement = { skips: [], needsDefault: [] };
  const branches = list("branches");
  const ignored = list("branches-ignore");
  const everything =
    ignored === undefined &&
    (branches === undefined ||
      (branches.includes("**") && !branches.some((p) => p.startsWith("!"))));
  if (everything) return judgement;
  switch (target.kind) {
    case "all":
      judgement.skips.push(
        `${path}: its pull_request trigger filters branches, and the ruleset gates every branch (\`~ALL\`)`,
      );
      return judgement;
    case "unknown":
      judgement.needsDefault.push(`${path}: its pull_request trigger filters branches`);
      return judgement;
    case "name": {
      const branch = target.name;
      if (
        branches !== undefined &&
        (!branches.some((p) => !p.startsWith("!") && branchMatches(p, branch)) ||
          branches.some((p) => p.startsWith("!") && branchMatches(p.slice(1), branch)))
      ) {
        judgement.skips.push(
          `${path}: its pull_request trigger's \`branches\` do not match \`${branch}\``,
        );
      }
      if (ignored?.some((p) => branchMatches(p, branch)) === true) {
        judgement.skips.push(
          `${path}: its pull_request trigger's \`branches-ignore\` match \`${branch}\``,
        );
      }
      return judgement;
    }
  }
}

/** Why a workflow's `pull_request` trigger may not fire on every pull request into `gated`. */
function triggerJudgement(workflow: Workflow, gated: readonly Gated[]): BranchJudgement {
  const on = workflow.data["on"];
  const trigger = isRecord(on) ? on[EVENT] : undefined;
  const judgement: BranchJudgement = { skips: [], needsDefault: [] };
  if (!isRecord(trigger)) return judgement;
  judgement.skips.push(
    ...FILTERS.filter((key) => trigger[key] !== undefined).map(
      (key) => `${workflow.path}: its pull_request trigger filters \`${key}\``,
    ),
  );
  for (const target of gated) {
    const branch = branchJudgement(trigger, target, workflow.path);
    judgement.skips.push(...branch.skips);
    judgement.needsDefault.push(...branch.needsDefault);
  }
  const types = trigger["types"];
  if (types !== undefined) {
    const listed = Array.isArray(types) ? types : [types];
    const missing = DEFAULT_TYPES.filter((type) => !listed.includes(type));
    if (missing.length > 0) {
      judgement.skips.push(
        `${workflow.path}: its pull_request trigger's \`types\` leave out ${missing.join(", ")}`,
      );
    }
  }
  return judgement;
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

/**
 * The workflow a job-level `uses:` calls, or why it cannot be read here: only the form
 * GitHub documents for a workflow in the same repository, `./.github/workflows/<file>`,
 * no deeper than GitHub's ten levels of workflows. `stack` holds the calling chain.
 */
function calledWorkflow(
  uses: unknown,
  byPath: ReadonlyMap<string, Workflow>,
  stack: readonly string[],
): Workflow | Unresolved {
  if (typeof uses !== "string") return { reason: "its `uses:` is not a string", next: CALL_FORM };
  if (!uses.startsWith("./")) {
    return {
      reason: `it calls \`${uses}\`, a workflow in another repository that this check cannot read`,
      next: "require a job this repository's workflows define, or copy the called workflow into .github/workflows/ and call it as `./.github/workflows/<file>.yml`",
    };
  }
  if (!LOCAL_WORKFLOW.test(uses)) {
    return {
      reason: `it calls \`${uses}\`, which is not the documented \`./.github/workflows/<file>.yml\` form`,
      next: `${CALL_FORM}: a file directly in that directory, with no \`..\` or subdirectory`,
    };
  }
  const path = uses.slice(2);
  const workflow = byPath.get(path);
  if (workflow === undefined) {
    return {
      reason: `it calls \`${uses}\`, which does not exist or does not parse as a workflow`,
      next: `restore ${path}, or point the job's \`uses:\` at an existing workflow (workflow-hygiene reports one that does not parse)`,
    };
  }
  if (stack.includes(path)) {
    return {
      reason: `it calls \`${uses}\`, which calls back through a cycle`,
      next: "break the cycle: a reusable workflow must not call itself, directly or through another",
    };
  }
  if (stack.length >= WORKFLOW_LEVELS) {
    return {
      reason: `it calls \`${uses}\` below ${String(stack.length)} levels of workflows, past GitHub's limit of ${String(WORKFLOW_LEVELS)}`,
      next: `flatten the chain of reusable-workflow calls to at most ${String(WORKFLOW_LEVELS)} levels, the top-level workflow included`,
    };
  }
  if (!triggerNames(workflow.data).includes("workflow_call")) {
    return {
      reason: `it calls \`${uses}\`, whose \`on:\` does not name \`workflow_call\``,
      next: `add \`workflow_call\` to the \`on:\` of ${path}`,
    };
  }
  return workflow;
}

/**
 * The text a job's `name:` reports as, before its expressions are evaluated: its id
 * without one, a string as written, and a boolean or an integer as GitHub's workflow
 * parser converts a scalar where it expects a string (its `toString`: `true`, `123`;
 * https://github.com/actions/languageservices/blob/main/workflow-parser/src/templates/template-reader.ts,
 * checked 2026-09-30). A null (converted to `''`), a fraction or an integer past 2^53
 * (whose text depends on the parser's number formatting), or a mapping is not known.
 */
export function jobNameText(id: string, name: unknown): string | Unresolved {
  if (name === undefined) return id;
  if (typeof name === "string") return name;
  if (typeof name === "boolean") return name ? "true" : "false";
  if (typeof name === "number" && Number.isSafeInteger(name)) return String(name);
  const shape =
    name === null
      ? "null"
      : typeof name === "number"
        ? `the number ${String(name)}`
        : "not a scalar";
  return {
    reason: `its \`name:\` is ${shape}, whose reported text this check does not know`,
    next: 'quote the job\'s `name:` as a string, such as `name: "Build"`',
  };
}

const joinNames = (caller: JobNames, called: JobNames): JobNames => {
  if ("unresolved" in caller) return caller;
  if ("unresolved" in called) return called;
  return {
    names: caller.names.flatMap((outer) => called.names.map((inner) => `${outer} / ${inner}`)),
  };
};

/**
 * What each job of a workflow reports, a job calling a reusable workflow standing for
 * each job it calls. `stack` is the chain of workflow paths being read.
 */
function reportingJobs(
  workflow: Workflow,
  byPath: ReadonlyMap<string, Workflow>,
  stack: readonly string[],
): ReportingJob[] {
  const jobs = new Map(jobsOf(workflow));
  return [...jobs].flatMap(([id, job]): ReportingJob[] => {
    const name = jobNameText(id, job["name"]);
    const label = typeof name === "string" ? name : id;
    const strategy = job["strategy"];
    const names =
      typeof name !== "string"
        ? { unresolved: name }
        : strategy === undefined || isRecord(strategy)
          ? jobNames(name, strategy?.["matrix"])
          : unresolved(
              "its `strategy` is not a mapping",
              "write the job's `strategy:` as a mapping",
            );
    const skips = jobSkips(workflow, jobs, id, new Set());
    if (job["uses"] === undefined) return [{ label, names, skips, needsDefault: [] }];
    const called = calledWorkflow(job["uses"], byPath, stack);
    if (!("data" in called)) {
      return [{ label, names: { unresolved: called }, skips, needsDefault: [] }];
    }
    return reportingJobs(called, byPath, [...stack, called.path]).map((inner) => ({
      label: `${label} / ${inner.label}`,
      names: joinNames(names, inner.names),
      skips: [...skips, ...inner.skips],
      needsDefault: [],
    }));
  });
}

function pullRequestJobs(root: string, gated: readonly Gated[]): ReportingJob[] {
  const { workflows } = readWorkflows(root);
  const byPath = new Map(workflows.map((workflow) => [workflow.path, workflow]));
  return workflows
    .filter((workflow) => triggerNames(workflow.data).includes(EVENT))
    .flatMap((workflow) => {
      const trigger = triggerJudgement(workflow, gated);
      return reportingJobs(workflow, byPath, [workflow.path]).map((job) => ({
        ...job,
        skips: [...trigger.skips, ...job.skips],
        needsDefault: trigger.needsDefault,
      }));
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

function contextViolation(
  context: string,
  jobs: readonly ReportingJob[],
  gated: readonly Gated[],
): FailureDetails[] {
  const matching = jobs.filter((job) => "names" in job.names && job.names.names.includes(context));
  if (matching.length === 0) {
    const reported = jobs.flatMap((job) => ("names" in job.names ? job.names.names : []));
    const unknown = jobs.flatMap((job) =>
      "unresolved" in job.names ? [{ job, ...job.names.unresolved }] : [],
    );
    return [
      {
        code: "ERR_CHECK_RULESET_CONTEXT",
        summary: `${RULESET}: required context "${context}" matches no job in a pull_request-triggered workflow`,
        expected:
          "every required context to equal a name a job reports in a .github/workflows/*.yml triggered on pull_request: its `name:` (or id) with each `${{ }}` evaluated, `<name> (<values>)` for each combination of a matrix job whose name has no expression, and `<caller> / <called job>` for a job calling a reusable workflow in this repository",
        actual: `pull_request jobs report: ${reported.join(", ") || "none"}${
          unknown.length > 0
            ? `; and jobs whose names this check cannot know from the files: ${unknown.map(({ job, reason }) => `\`${job.label}\` (${reason})`).join("; ")}`
            : ""
        }`,
        next: [
          `rename the context in ${RULESET} to a name a job reports, or restore the job`,
          ...unknown.map(({ job, next }) => `for \`${job.label}\`, ${next}`),
          `then \`just ruleset\` after merging, a human's step`,
        ].join("; "),
      },
    ];
  }
  const running = matching.filter((job) => job.skips.length === 0);
  if (running.some((job) => job.needsDefault.length === 0)) return [];
  const unknown = gated.find((target) => target.kind === "unknown");
  if (running.length > 0 && unknown?.kind === "unknown") {
    return [
      {
        code: "ERR_CHECK_RULESET_BRANCH_UNKNOWN",
        summary: `${RULESET}: required context "${context}" is reported by a job whose pull_request trigger filters branches, and the default branch the ruleset gates (\`${DEFAULT_BRANCH}\`) cannot be known offline`,
        expected: `the default branch's name, to judge the filter: the one branch \`on: push: branches:\` in ${CI} names literally, or this clone's origin/HEAD`,
        actual: `${[...new Set(running.flatMap((job) => job.needsDefault))].join("; ")}; ${unknown.reason}`,
        next: unknown.next,
      },
    ];
  }
  return [
    {
      code: "ERR_CHECK_RULESET_CONTEXT_SKIPPED",
      summary: `${RULESET}: required context "${context}" is reported only by jobs that may not run on every pull request`,
      expected:
        "a job reporting each required context on every pull request: no paths filter and no branch filter excluding the gated branch on its workflow's pull_request trigger, the default activity types, and no `if:` (on it or a job it needs) that can be false; for a job in a reusable workflow, the calling job (and every job it needs) must run on every pull request too",
      actual: [...new Set(matching.flatMap((job) => job.skips))].join("; "),
      next: `drop the filter or the \`if:\` from the job ${RULESET} requires, or from the job that calls it (skip inside its steps instead), or remove the context from ${RULESET} (then \`just ruleset\` after merging, a human's step)`,
    },
  ];
}

/** The check, with origin/HEAD's reader injected so a test can stand in for a clone. */
export function makeCheck(readOrigin: (root: string) => string | undefined): Check {
  return {
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
      const contexts = requiredContexts(ruleset);
      if (contexts.length === 0) return [];
      const gated = gatedBranches(ruleset, root, () => readOrigin(root));
      if (!Array.isArray(gated)) return [gated];
      const jobs = pullRequestJobs(root, gated);
      return contexts.flatMap((context) => contextViolation(context, jobs, gated));
    },
  };
}

export const check: Check = makeCheck(originHead);

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
