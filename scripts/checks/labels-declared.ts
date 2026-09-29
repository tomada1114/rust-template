/**
 * Every label something in the repository applies is declared exactly once in
 * `.github/labels.yml`, and every label `scripts/label-pr.ts` applies has a release-notes
 * category (design D14) — so `just labels` creates every label the repository expects,
 * never two conflicting ones, and no merged pull request falls out of the release notes.
 *
 *   node scripts/checks/labels-declared.ts [--root DIR]
 *
 * Declared: each item's `name` in `.github/labels.yml` (required); two names differing
 * only in case are a duplicate, as GitHub compares them case-insensitively. Applied,
 * from whichever of these exist (YAML and JSON read with real parsers):
 *   - `.github/ISSUE_TEMPLATE/*.yml|*.yaml`: the top-level `labels` (a list, or a
 *     comma-separated string);
 *   - `.github/workflows/*.yml|*.yaml`: in each step's (and each job's) `run:`, a literal
 *     `--add-label`/`--label` value (comma lists split; a `$` variable skipped), and a
 *     `with:` input whose name ends in `labels` (`labels`, `ignoreLabels`; a list, or a
 *     string split on commas and newlines);
 *   - `.github/dependabot.yml`: each `updates` entry's `labels`, or, for an entry without
 *     the key, Dependabot's default `dependencies` (its ecosystem label Dependabot creates
 *     itself, so it is not required); `labels: []` applies none;
 *   - `.github/renovate.json` and `renovate.json`: every `labels`/`addLabels` string list;
 *   - `.github/release.yml`: the labels its categories and `exclude` name (`*` aside);
 *   - `scripts/label-pr.ts`, when the root has one: its `MANAGED_LABELS` (imported from
 *     this checkout's copy), each of which must also be listed by a release category.
 * Matching is exact, case included. No git work tree needed.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_INPUT_MISSING (no labels.yml), ERR_CHECK_INPUT_UNREADABLE
 * (a file above does not parse, or labels.yml is not a list of named items),
 * ERR_CHECK_LABEL_DUPLICATE, ERR_CHECK_LABEL_UNDECLARED, ERR_CHECK_LABEL_NO_CATEGORY.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  Scalar,
  type Document,
  type Node,
} from "yaml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { MANAGED_LABELS } from "../label-pr.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const LABELS = ".github/labels.yml";
const RELEASE = ".github/release.yml";

interface Use {
  /** `path:line`, or a path alone. */
  readonly where: string;
  readonly label: string;
  readonly verb: "applies" | "names";
  readonly note?: string;
}

interface Parsed {
  readonly doc: Document;
  readonly lines: LineCounter;
}

function unreadable(path: string, actual: string): FailureDetails {
  return {
    code: "ERR_CHECK_INPUT_UNREADABLE",
    summary: `${path} could not be read for its labels`,
    expected: `${path} to parse${path === LABELS ? " as a YAML list of items that each have a `name`" : ""}`,
    actual,
    next: `fix ${path}, then rerun the check`,
  };
}

function parseYaml(root: string, path: string, problems: FailureDetails[]): Parsed | undefined {
  const text = readRepoFile(root, path);
  if (text === undefined) return undefined;
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: false });
  const [error] = doc.errors;
  if (error !== undefined) {
    problems.push(unreadable(path, error.message.split("\n")[0] ?? ""));
    return undefined;
  }
  return { doc, lines };
}

function lineOf(parsed: Parsed, node: Node | null | undefined): number {
  return node?.range === undefined || node.range === null
    ? 0
    : parsed.lines.linePos(node.range[0]).line;
}

function get(node: unknown, key: string): unknown {
  return isMap(node) ? node.get(key, true) : undefined;
}

/** Each item of a string list, or of a string split on `separators`, with its line. */
function items(
  parsed: Parsed,
  node: unknown,
  separators: RegExp,
): { label: string; line: number }[] {
  if (isSeq(node)) {
    return node.items.flatMap((item) =>
      isScalar(item) && typeof item.value === "string"
        ? [{ label: item.value.trim(), line: lineOf(parsed, item) }]
        : [],
    );
  }
  if (!isScalar(node) || typeof node.value !== "string") return [];
  const block = node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED;
  const first = lineOf(parsed, node) + (block ? 1 : 0);
  return node.value.split("\n").flatMap((text, index) =>
    text
      .split(separators)
      .map((label) => ({ label: label.trim(), line: first + index }))
      .filter(({ label }) => label !== ""),
  );
}

/** Literal `--add-label`/`--label` values in a `run:` script. */
function runLabels(parsed: Parsed, node: unknown): { label: string; line: number }[] {
  if (!isScalar(node) || typeof node.value !== "string") return [];
  const block = node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED;
  const first = lineOf(parsed, node) + (block ? 1 : 0);
  return node.value.split("\n").flatMap((text, index) =>
    [...text.matchAll(/--(?:add-)?label(?:\s+|=)("[^"]*"|'[^']*'|[^\s;)|&]+)/g)].flatMap((match) =>
      (match[1] ?? "")
        .replace(/^["']|["']$/g, "")
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label !== "" && !label.startsWith("$"))
        .map((label) => ({ label, line: first + index })),
    ),
  );
}

function yamlFiles(root: string, dir: string): string[] {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => `${dir}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

function formUses(root: string, problems: FailureDetails[]): Use[] {
  return yamlFiles(root, ".github/ISSUE_TEMPLATE").flatMap((path) => {
    const parsed = parseYaml(root, path, problems);
    if (parsed === undefined) return [];
    return items(parsed, get(parsed.doc.contents, "labels"), /,/).map(({ label, line }) => ({
      where: `${path}:${String(line)}`,
      label,
      verb: "applies" as const,
    }));
  });
}

function workflowUses(root: string, problems: FailureDetails[]): Use[] {
  return yamlFiles(root, ".github/workflows").flatMap((path) => {
    const parsed = parseYaml(root, path, problems);
    if (parsed === undefined) return [];
    const jobs = get(parsed.doc.contents, "jobs");
    const units = isMap(jobs)
      ? jobs.items.flatMap((pair) => {
          const steps = get(pair.value, "steps");
          return [pair.value, ...(isSeq(steps) ? steps.items : [])];
        })
      : [];
    const found = units.flatMap((unit) => {
      const inputs = get(unit, "with");
      const fromInputs = isMap(inputs)
        ? inputs.items.flatMap((pair) =>
            isScalar(pair.key) && /labels$/i.test(String(pair.key.value))
              ? items(parsed, pair.value, /[,\n]/)
              : [],
          )
        : [];
      return [...runLabels(parsed, get(unit, "run")), ...fromInputs];
    });
    return found
      .filter(({ label }) => !label.includes("${{"))
      .sort((a, b) => a.line - b.line)
      .map(({ label, line }) => ({
        where: `${path}:${String(line)}`,
        label,
        verb: "applies" as const,
      }));
  });
}

function dependabotUses(root: string, problems: FailureDetails[]): Use[] {
  const path = ".github/dependabot.yml";
  const parsed = parseYaml(root, path, problems);
  if (parsed === undefined) return [];
  const updates = get(parsed.doc.contents, "updates");
  if (!isSeq(updates)) return [];
  return updates.items.flatMap((entry): Use[] => {
    if (!isMap(entry)) return [];
    if (!entry.has("labels")) {
      return [
        {
          where: `${path}:${String(lineOf(parsed, entry))}`,
          label: "dependencies",
          verb: "applies",
          note: " (Dependabot's default for an entry with no labels key)",
        },
      ];
    }
    return items(parsed, entry.get("labels", true), /,/).map(({ label, line }) => ({
      where: `${path}:${String(line)}`,
      label,
      verb: "applies" as const,
    }));
  });
}

function renovateUses(root: string, problems: FailureDetails[]): Use[] {
  return [".github/renovate.json", "renovate.json"].flatMap((path) => {
    const text = readRepoFile(root, path);
    if (text === undefined) return [];
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch (error: unknown) {
      problems.push(unreadable(path, error instanceof Error ? error.message : String(error)));
      return [];
    }
    const labels: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, inner] of Object.entries(value)) {
        if ((key === "labels" || key === "addLabels") && Array.isArray(inner)) {
          labels.push(...inner.filter((label): label is string => typeof label === "string"));
        } else {
          walk(inner);
        }
      }
    };
    walk(config);
    const lines = text.split("\n");
    return labels.map((label) => ({
      where: `${path}:${String(lines.findIndex((line) => line.includes(JSON.stringify(label))) + 1)}`,
      label,
      verb: "applies" as const,
    }));
  });
}

/** The labels release.yml's categories and exclude name, and the categorised ones. */
function releaseLabels(
  root: string,
  problems: FailureDetails[],
): { uses: Use[]; categorised: Set<string> } | undefined {
  const parsed = parseYaml(root, RELEASE, problems);
  if (parsed === undefined) return undefined;
  const changelog = get(parsed.doc.contents, "changelog");
  const categories = get(changelog, "categories");
  const categoryNodes = isSeq(categories)
    ? categories.items.map((category) => get(category, "labels"))
    : [];
  const categorised = new Set(
    categoryNodes.flatMap((node) => items(parsed, node, /,/).map(({ label }) => label)),
  );
  const uses = [...categoryNodes, get(get(changelog, "exclude"), "labels")]
    .flatMap((node) => items(parsed, node, /,/))
    .filter(({ label }) => label !== "*")
    .sort((a, b) => a.line - b.line)
    .map(({ label, line }) => ({
      where: `${RELEASE}:${String(line)}`,
      label,
      verb: "names" as const,
    }));
  return { uses, categorised };
}

/** The declared names with their lines, or undefined when labels.yml is unusable. */
function declared(
  root: string,
  problems: FailureDetails[],
): { name: string; line: number }[] | undefined {
  const parsed = parseYaml(root, LABELS, problems);
  if (parsed === undefined) return undefined;
  const list = parsed.doc.contents;
  if (!isSeq(list)) {
    problems.push(unreadable(LABELS, "the top level is not a list"));
    return undefined;
  }
  const names: { name: string; line: number }[] = [];
  for (const item of list.items) {
    const name = get(item, "name");
    if (!isScalar(name) || typeof name.value !== "string" || name.value === "") {
      problems.push(
        unreadable(LABELS, `the item at line ${String(lineOf(parsed, item as Node))} has no name`),
      );
      return undefined;
    }
    names.push({ name: name.value, line: lineOf(parsed, name) });
  }
  return names;
}

/** Every violation under `root`, with `managed` standing for label-pr's labels. */
export function findLabelViolations(root: string, managed: ReadonlySet<string>): FailureDetails[] {
  if (readRepoFile(root, LABELS) === undefined) {
    return [
      {
        code: "ERR_CHECK_INPUT_MISSING",
        summary: `${LABELS} does not exist`,
        expected: `the label declarations at ${root}/${LABELS}`,
        actual: "no such file",
        next: "run the check against the repository root (--root DIR)",
      },
    ];
  }
  const problems: FailureDetails[] = [];
  const names = declared(root, problems);
  const violations: FailureDetails[] = [];
  const first = new Map<string, number>();
  for (const { name, line } of names ?? []) {
    const earlier = first.get(name.toLowerCase());
    if (earlier === undefined) {
      first.set(name.toLowerCase(), line);
      continue;
    }
    violations.push({
      code: "ERR_CHECK_LABEL_DUPLICATE",
      summary: `${LABELS}:${String(line)} declares \`${name}\` again (first at line ${String(earlier)})`,
      expected: `each label in exactly one item of ${LABELS} (GitHub compares names case-insensitively)`,
      actual: `a second item for \`${name}\``,
      next: "merge the two items into one, keeping the color and description you mean",
    });
  }

  const release = releaseLabels(root, problems);
  const labelPr = readRepoFile(root, "scripts/label-pr.ts") === undefined ? [] : [...managed];
  const uses: Use[] = [
    ...formUses(root, problems),
    ...workflowUses(root, problems),
    ...dependabotUses(root, problems),
    ...renovateUses(root, problems),
    ...(release?.uses ?? []),
    ...labelPr.map((label) => ({ where: "scripts/label-pr.ts", label, verb: "applies" as const })),
  ];
  const known = new Set((names ?? []).map(({ name }) => name));
  if (names !== undefined) {
    for (const use of uses) {
      if (known.has(use.label)) continue;
      violations.push({
        code: "ERR_CHECK_LABEL_UNDECLARED",
        summary: `${use.where} ${use.verb} \`${use.label}\`${use.note ?? ""}, which ${LABELS} does not declare`,
        expected: `every label an issue form, workflow, dependency bot, release category, or scripts/label-pr.ts uses to be declared in ${LABELS}`,
        actual: `no item named \`${use.label}\` (names match exactly, case included)`,
        next: `declare the label in ${LABELS} (name, color, description), or change the file to a declared label; \`just labels\` then creates it`,
      });
    }
  }
  // An unreadable release.yml is already reported; only a missing one leaves every label uncategorised.
  const releaseUnreadable = release === undefined && readRepoFile(root, RELEASE) !== undefined;
  for (const label of releaseUnreadable ? [] : labelPr) {
    if (release?.categorised.has(label) === true) continue;
    violations.push({
      code: "ERR_CHECK_LABEL_NO_CATEGORY",
      summary: `scripts/label-pr.ts applies \`${label}\`, which no ${RELEASE} category lists`,
      expected: `every label scripts/label-pr.ts applies to be listed by a category in ${RELEASE}, so its pull requests reach the release notes`,
      actual: release === undefined ? `no ${RELEASE}` : `no category's labels include \`${label}\``,
      next: `add \`${label}\` to a category in ${RELEASE}, or change the mapping in scripts/label-pr.ts`,
    });
  }
  return [...problems, ...violations];
}

export const check: Check = {
  name: "labels-declared",
  run: (root) => findLabelViolations(root, MANAGED_LABELS),
};
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
