/**
 * Every label something in the repository applies is declared exactly once in
 * `.github/labels.yml`, and every label `scripts/label-pr.ts` applies has a release-notes
 * category — so `just labels` creates every label the repository expects,
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
 *   - the Renovate config (shared/workflows.ts's readRenovate): every `labels`/`addLabels`
 *     string list; a JSON5 config is unreadable, never skipped;
 *   - `.github/release.yml`: the labels its categories and `exclude` name (`*` aside);
 *   - `scripts/label-pr.ts`, when the root has one: the labels of its `TYPE_LABELS` map,
 *     read from the root's own copy with the TypeScript parser (a `new Map([…])` of
 *     `["type", "label"]` string pairs; any other shape is unreadable), each of which must
 *     also be listed by a release category.
 * And, when the root has `scripts/label-pr.ts`: every type a PR-title check accepts (the
 * `types` of each workflow step using amannn/action-semantic-pull-request, or the
 * action's defaults) is a key of `TYPE_LABELS`, so no accepted title goes unlabelled and
 * out of the release notes.
 * Matching is exact, case included. No git work tree needed.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_INPUT_MISSING (no labels.yml), ERR_CHECK_INPUT_UNREADABLE
 * (a file above does not parse, labels.yml is not a list of named items or fails
 * `parseLabelManifest` — the parser `just labels` uses, or label-pr's
 * map is not a literal it can read), ERR_CHECK_LABEL_DUPLICATE, ERR_CHECK_LABEL_UNDECLARED,
 * ERR_CHECK_LABEL_NO_CATEGORY, ERR_CHECK_LABEL_TYPE_UNMAPPED.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

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

import { ScriptError, type FailureDetails } from "../lib/fail.ts";
import { parseLabelManifest } from "../lib/labels.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import { readRenovate, readWorkflows, titleChecks } from "./shared/workflows.ts";

const LABELS = ".github/labels.yml";
const RELEASE = ".github/release.yml";
const LABEL_PR = "scripts/label-pr.ts";
const TYPE_MAP = "TYPE_LABELS";

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
  const reading = readRenovate(root);
  if (reading === undefined) return [];
  if ("problem" in reading) {
    problems.push(unreadable(reading.path, reading.problem));
    return [];
  }
  const { path, text, config } = reading;
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
}

/** One `["type", "label"]` entry of label-pr's map, with its line. */
interface TypeLabel {
  readonly type: string;
  readonly label: string;
  readonly line: number;
}

/**
 * label-pr's `TYPE_LABELS` as written in `text`: a `new Map([…])` whose entries are
 * `["type", "label"]` string-literal pairs, or why it is not that.
 */
export function readTypeLabels(text: string): TypeLabel[] | string {
  const file = ts.createSourceFile(LABEL_PR, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOfNode = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === TYPE_MAP
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (initializer === undefined) return `no \`${TYPE_MAP}\` declaration with a value`;
  const [entries] = ts.isNewExpression(initializer) ? (initializer.arguments ?? []) : [];
  if (
    !ts.isNewExpression(initializer) ||
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== "Map" ||
    initializer.arguments?.length !== 1 ||
    entries === undefined ||
    !ts.isArrayLiteralExpression(entries)
  ) {
    return `\`${TYPE_MAP}\` at line ${String(lineOfNode(initializer))} is not \`new Map([…])\` over an array literal`;
  }
  const pairs: TypeLabel[] = [];
  for (const entry of entries.elements) {
    const [type, label] = ts.isArrayLiteralExpression(entry) ? entry.elements : [];
    if (
      !ts.isArrayLiteralExpression(entry) ||
      entry.elements.length !== 2 ||
      type === undefined ||
      label === undefined ||
      !ts.isStringLiteralLike(type) ||
      !ts.isStringLiteralLike(label)
    ) {
      return `the \`${TYPE_MAP}\` entry at line ${String(lineOfNode(entry))} is not a ["type", "label"] pair of string literals`;
    }
    pairs.push({ type: type.text, label: label.text, line: lineOfNode(entry) });
  }
  return pairs;
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

/** Every violation under `root`. */
export function findLabelViolations(root: string): FailureDetails[] {
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

  // `just labels` parses through parseLabelManifest; a duplicate is already reported above.
  if (names !== undefined && violations.length === 0) {
    try {
      parseLabelManifest(readRepoFile(root, LABELS) ?? "");
    } catch (error: unknown) {
      if (!(error instanceof ScriptError)) throw error;
      problems.push(unreadable(LABELS, error.details.actual));
    }
  }

  const release = releaseLabels(root, problems);
  const labelPrText = readRepoFile(root, LABEL_PR);
  const typeLabels = labelPrText === undefined ? [] : readTypeLabels(labelPrText);
  if (typeof typeLabels === "string") {
    problems.push({
      ...unreadable(LABEL_PR, typeLabels),
      expected: `${LABEL_PR}'s \`${TYPE_MAP}\` to be \`new Map([["type", "label"], …])\` of string literals`,
      next: `restore that shape in ${LABEL_PR}, or update scripts/checks/labels-declared.ts's reader in the same change`,
    });
  }
  const pairs = typeof typeLabels === "string" ? [] : typeLabels;
  const labelPr = [...new Set(pairs.map(({ label }) => label))];
  const uses: Use[] = [
    ...formUses(root, problems),
    ...workflowUses(root, problems),
    ...dependabotUses(root, problems),
    ...renovateUses(root, problems),
    ...(release?.uses ?? []),
    ...labelPr.map((label) => ({
      where: `${LABEL_PR}:${String(pairs.find((pair) => pair.label === label)?.line ?? 0)}`,
      label,
      verb: "applies" as const,
    })),
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
      summary: `${LABEL_PR} applies \`${label}\`, which no ${RELEASE} category lists`,
      expected: `every label scripts/label-pr.ts applies to be listed by a category in ${RELEASE}, so its pull requests reach the release notes`,
      actual: release === undefined ? `no ${RELEASE}` : `no category's labels include \`${label}\``,
      next: `add \`${label}\` to a category in ${RELEASE}, or change the mapping in scripts/label-pr.ts`,
    });
  }
  if (labelPrText !== undefined && typeof typeLabels !== "string") {
    const mapped = new Set(pairs.map(({ type }) => type));
    for (const title of titleChecks(readWorkflows(root).workflows)) {
      for (const type of title.types.filter((accepted) => !mapped.has(accepted))) {
        violations.push({
          code: "ERR_CHECK_LABEL_TYPE_UNMAPPED",
          summary: `${title.where} accepts the PR-title type \`${type}\`, which ${LABEL_PR}'s ${TYPE_MAP} does not map to a label`,
          expected: `every type a PR-title check accepts to be a key of ${LABEL_PR}'s ${TYPE_MAP}, so its pull requests are labelled and reach the release notes`,
          actual: `${TYPE_MAP} maps: ${[...mapped].join(", ") || "nothing"}`,
          next: `add \`["${type}", "<label>"]\` to ${TYPE_MAP} in ${LABEL_PR} (a label ${RELEASE} categorises), or drop \`${type}\` from the title check's \`types\``,
        });
      }
    }
  }
  return [...problems, ...violations];
}

export const check: Check = {
  name: "labels-declared",
  run: (root) => findLabelViolations(root),
};
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
