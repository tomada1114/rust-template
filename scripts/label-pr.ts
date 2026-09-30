/**
 * Labels a pull request by its title's Conventional Commit type, for the release-notes
 * categories in `.github/release.yml`. Run by `.github/workflows/pr-label.yml` from the
 * base commit, never the pull request's head, with PR_NUMBER, PR_TITLE, GH_TOKEN, and GH_REPO set.
 *
 * It adds the title's label and removes a stale type label left by an earlier title, but
 * only when that label is the pull request's one managed label: with two, either could
 * be a human's. It never removes `dependencies` (Dependabot applies it itself) and never
 * creates a label (`just labels` does). A `gh` failure — a fork's read-only token, a
 * label not created yet — is a notice, never a failed check.
 *
 * Errors: ERR_LABEL_PR_NUMBER (PR_NUMBER unset: a misconfigured workflow).
 */
import { ScriptError } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

/**
 * Every type `.github/workflows/check-pr-title.yml` accepts, and its label. The
 * labels-declared harness check parses this literal and fails on a title type it lacks,
 * so it stays a `new Map([…])` of string pairs.
 */
const TYPE_LABELS: ReadonlyMap<string, string> = new Map([
  ["feat", "enhancement"],
  ["perf", "enhancement"],
  ["fix", "bug"],
  ["docs", "documentation"],
  ["style", "chore"],
  ["refactor", "chore"],
  ["test", "chore"],
  ["build", "chore"],
  ["chore", "chore"],
  ["revert", "chore"],
  ["ci", "ci"],
  ["deps", "dependencies"],
]);

/** The labels this script may add or remove; no other label is ever touched. */
export const MANAGED_LABELS: ReadonlySet<string> = new Set(TYPE_LABELS.values());

const UNREMOVABLE = new Set(["dependencies"]);

/** `type`, `type(scope)`, either with a breaking `!`, then a colon. */
const TITLE = /^([a-z]+)(?:\([^)]*\))?!?:/;

export function labelForTitle(title: string): string | undefined {
  const type = TITLE.exec(title)?.[1];
  return type === undefined ? undefined : TYPE_LABELS.get(type);
}

export interface LabelUpdate {
  readonly add: string | undefined;
  readonly remove: readonly string[];
}

export function computeLabelUpdate(title: string, current: readonly string[]): LabelUpdate {
  const wanted = labelForTitle(title);
  if (wanted === undefined) return { add: undefined, remove: [] };
  const managed = current.filter((label) => MANAGED_LABELS.has(label));
  const [only] = managed;
  const stale =
    managed.length === 1 && only !== undefined && only !== wanted && !UNREMOVABLE.has(only);
  return {
    add: current.includes(wanted) ? undefined : wanted,
    remove: stale ? [only] : [],
  };
}

function currentLabels(context: ScriptContext, pr: string): string[] {
  const result = context.run("gh", ["pr", "view", pr, "--json", "labels"]);
  if (result.status !== 0) {
    context.log(`::notice::Could not read the pull request's labels: ${result.stderr.trim()}`);
    return [];
  }
  const labels: unknown = (JSON.parse(result.stdout) as { labels?: unknown }).labels;
  if (!Array.isArray(labels)) return [];
  return labels.map((label: { name?: unknown }) => String(label.name));
}

export function main(context: ScriptContext): void {
  const pr = context.env["PR_NUMBER"] ?? "";
  if (pr === "") {
    throw new ScriptError({
      code: "ERR_LABEL_PR_NUMBER",
      summary: "PR_NUMBER is not set",
      expected: "the pull request number, set by .github/workflows/pr-label.yml",
      actual: "an empty PR_NUMBER",
      next: "run this from that workflow, or set PR_NUMBER and PR_TITLE yourself",
    });
  }
  const title = context.env["PR_TITLE"] ?? "";
  const { add, remove } = computeLabelUpdate(title, currentLabels(context, pr));
  if (add === undefined && remove.length === 0) {
    context.log(`label-pr: nothing to change for ${JSON.stringify(title)}`);
    return;
  }

  const args = ["pr", "edit", pr];
  if (add !== undefined) args.push("--add-label", add);
  for (const label of remove) args.push("--remove-label", label);
  const result = context.run("gh", args);
  if (result.status !== 0) {
    context.log(
      `::notice::Could not update labels (add ${add ?? "none"}, remove ${remove.join(", ") || "none"}): ${result.stderr.trim()}`,
    );
    return;
  }
  context.log(`label-pr: ${args.slice(3).join(" ")}`);
}

if (import.meta.main) await runScript(main);
