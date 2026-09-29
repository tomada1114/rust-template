/**
 * Helpers the workflow checks share: reading YAML with line numbers, the workflow files
 * and their jobs and steps, the Dependabot and Renovate file locations, and a run script's
 * logical lines. Lives under `shared/`, which scripts/check-harness.ts never loads as a
 * check (it reads only the top level of `scripts/checks/`).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

import type { FailureDetails } from "../../lib/fail.ts";
import { readRepoFile } from "../lib.ts";

const WORKFLOWS_DIR = ".github/workflows";

export const DEPENDABOT_FILES = [".github/dependabot.yml", ".github/dependabot.yaml"];
export const RENOVATE_FILES = [
  "renovate.json",
  ".github/renovate.json",
  ".gitlab/renovate.json",
  ".renovaterc",
  ".renovaterc.json",
];

export type Key = string | number;

/** Where a key path sits in a YAML file. */
export interface Location {
  /** 1-based line of the deepest key (or sequence item) found on the path. */
  readonly line: number;
  /** Whether the value at the full path is a block scalar (`|` or `>`). */
  readonly block: boolean;
}

/** A parsed YAML file: its plain data and a way to point at a key's line. */
export interface YamlFile {
  readonly path: string;
  readonly lines: readonly string[];
  readonly data: unknown;
  readonly locate: (keys: readonly Key[]) => Location;
}

export interface Workflow extends YamlFile {
  readonly data: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a YAML file under the root; a string is the parse error, undefined an absent file. */
export function readYaml(root: string, path: string): YamlFile | string | undefined {
  const text = readRepoFile(root, path);
  if (text === undefined) return undefined;
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const [error] = doc.errors;
  if (error !== undefined) {
    const line = error.linePos?.[0].line;
    return `${path}${line === undefined ? "" : `:${String(line)}`}: ${error.message.split("\n")[0] ?? ""}`;
  }
  const locate = (keys: readonly Key[]): Location => {
    let node: unknown = doc.contents;
    let offset = 0;
    let complete = true;
    for (const key of keys) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isScalar(item.key) && item.key.value === key);
        if (pair === undefined) {
          complete = false;
          break;
        }
        offset = isScalar(pair.key) ? (pair.key.range?.[0] ?? offset) : offset;
        node = pair.value;
      } else if (isSeq(node) && typeof key === "number" && node.items[key] !== undefined) {
        node = node.items[key];
        offset =
          isScalar(node) || isMap(node) || isSeq(node) ? (node.range?.[0] ?? offset) : offset;
      } else {
        complete = false;
        break;
      }
    }
    const block =
      complete && isScalar(node) && (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED");
    return { line: lineCounter.linePos(offset).line, block };
  };
  return { path, lines: text.split("\n"), data: doc.toJS() as unknown, locate };
}

/** The workflow files under the root, as repository-relative paths, sorted. */
export function workflowPaths(root: string): string[] {
  const dir = join(root, WORKFLOWS_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => `${WORKFLOWS_DIR}/${name}`);
}

const UNREADABLE = {
  code: "ERR_CHECK_WORKFLOW_UNREADABLE",
  expected: "every .github/workflows/*.yml to parse as a YAML mapping with a `jobs` mapping",
  next: "fix the file so `mise exec -- actionlint` accepts it, then rerun the check",
};

/** Every workflow parsed, and a finding for each one that cannot be read. */
export function readWorkflows(root: string): {
  workflows: Workflow[];
  unreadable: FailureDetails[];
} {
  const workflows: Workflow[] = [];
  const unreadable: FailureDetails[] = [];
  for (const path of workflowPaths(root)) {
    const file = readYaml(root, path);
    if (file === undefined) continue;
    let problem: string | undefined;
    if (typeof file === "string") problem = file;
    else if (!isRecord(file.data)) problem = `${path}: the document is not a mapping`;
    else if (!isRecord(file.data["jobs"])) problem = `${path}: no \`jobs\` mapping`;
    else workflows.push({ ...file, data: file.data });
    if (problem !== undefined) {
      unreadable.push({
        ...UNREADABLE,
        summary: `${path} cannot be read as a workflow`,
        actual: problem,
      });
    }
  }
  return { workflows, unreadable };
}

/** The event names a workflow's `on:` declares, in any of its shapes. */
export function triggerNames(data: Record<string, unknown>): string[] {
  const on = data["on"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((event): event is string => typeof event === "string");
  if (isRecord(on)) return Object.keys(on);
  return [];
}

/** A job's steps that are mappings, with their index. */
export function stepsOf(job: Record<string, unknown>): [number, Record<string, unknown>][] {
  const steps = job["steps"];
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step: unknown, index): [number, Record<string, unknown>][] =>
    isRecord(step) ? [[index, step]] : [],
  );
}

/** The jobs of a workflow that are mappings, by id. */
export function jobsOf(workflow: Workflow): [string, Record<string, unknown>][] {
  const jobs = workflow.data["jobs"];
  return isRecord(jobs)
    ? Object.entries(jobs).flatMap(([id, job]): [string, Record<string, unknown>][] =>
        isRecord(job) ? [[id, job]] : [],
      )
    : [];
}

/** A run script's lines with `\` continuations joined, each with its 0-based first line. */
export function scriptLines(script: string): [number, string][] {
  const physical = script.split("\n");
  const joined: [number, string][] = [];
  for (let index = 0; index < physical.length; index += 1) {
    const start = index;
    let line = physical[index] ?? "";
    while (line.endsWith("\\") && index + 1 < physical.length) {
      index += 1;
      line = `${line.slice(0, -1)} ${physical[index] ?? ""}`;
    }
    const text = line.trim();
    if (text !== "" && !text.startsWith("#")) joined.push([start, text]);
  }
  return joined;
}
