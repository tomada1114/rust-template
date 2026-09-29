/**
 * Surveys the open Dependabot and Renovate pull requests for the `merging-dependency-prs`
 * skill: each one's ecosystem, the versions it moves and their semver level, its check
 * rollup, its merge state, the files it touches, the files two of them contest, and
 * whether the batch keeps the Tauri crates and the `@tauri-apps/*` npm packages on one
 * minor. Read-only: it runs `gh pr list` and reads `Cargo.lock` and `package.json`, and it
 * is the one step of the skill that runs before the human's approval.
 *
 *   node .agents/skills/merging-dependency-prs/scripts/survey-prs.ts [--json]
 *
 * Needs `gh`, authenticated against this repository. It works in any directory `gh`
 * resolves a repository from; outside one, `gh` fails and so does this script.
 *
 * Errors: ERR_SURVEY_USAGE (an unknown argument), ERR_SURVEY_GH (`gh` missing, failing,
 * or printing something other than a JSON list).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { ScriptError } from "../../../../scripts/lib/fail.ts";
import { runScript, type ScriptContext } from "../../../../scripts/lib/script.ts";

export type Level = "major" | "minor" | "patch" | "unknown";
export type Ecosystem = "cargo" | "npm" | "github-actions" | "mise" | "rust-toolchain" | "other";
export type CheckState = "PASSING" | "FAILING" | "PENDING" | "NONE";

/** One dependency a pull request moves. */
export interface Bump {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/** One open bot pull request, as the survey reports it. */
export interface Row {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly branch: string;
  readonly author: string;
  readonly ecosystem: Ecosystem;
  readonly bumps: readonly Bump[];
  /** The highest level among `bumps`. */
  readonly level: Level;
  readonly checks: CheckState;
  readonly failingChecks: readonly string[];
  readonly mergeState: string;
  readonly files: readonly string[];
}

/** One Tauri crate and the npm packages that must share its minor. */
export interface TauriPair {
  readonly key: string;
  /** The pull requests that move a member of the pair. */
  readonly prs: readonly number[];
  readonly aligned: boolean;
  /** Each member's version once the batch lands; `pr` names the PR that moves it. */
  readonly versions: readonly {
    readonly name: string;
    readonly version: string;
    readonly pr?: number;
  }[];
}

export interface TauriMajor {
  readonly pr: number;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

const FIELDS = [
  "number",
  "title",
  "body",
  "author",
  "headRefName",
  "mergeStateStatus",
  "statusCheckRollup",
  "files",
  "url",
].join(",");

// Dependabot, one dependency: "bump serde from 1.0.228 to 1.0.229", or "update eslint
// requirement from ^10.6.0 to ^10.7.0".
const TITLE_BUMP =
  /(?:bump|update)\s+(?<name>\S+?)(?:\s+requirement)?\s+from\s+(?<from>\S+)\s+to\s+(?<to>\S+)/i;
// Dependabot, a group: one "Updates `name` from A to B" line per dependency in the body.
const BODY_BUMP = /^Updates `(?<name>[^`]+)` from (?<from>\S+) to (?<to>\S+?)\.?$/gm;
// Renovate: a table row "| name | minor | `A` -> `B` |", the name often a Markdown link.
const TABLE_BUMP =
  /^\|\s*\[?(?<name>[^\]|]+?)\]?(?:\([^)]*\))?\s*\|[^|\n]*\|\s*`(?<from>[^`]+)`\s*(?:->|→)\s*`(?<to>[^`]+)`\s*\|/gm;

// A range such as `^10.7` has no patch component, so that group is optional.
const VERSION = /(\d+)\.(\d+)(?:\.(\d+))?/;

const LEVEL_ORDER: readonly Level[] = ["unknown", "patch", "minor", "major"];

// The only conclusions that let a PR through: an allow-list, so a conclusion this script
// has never seen (STARTUP_FAILURE, STALE, one GitHub adds later) holds the PR instead of
// passing it. SKIPPED is how a conditional job says "not applicable".
const PASSING_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING_STATES = new Set(["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "EXPECTED"]);

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown, key: string): string | undefined {
  const read = field(value, key);
  return typeof read === "string" ? read : undefined;
}

function list(value: unknown, key: string): unknown[] {
  const read = field(value, key);
  return Array.isArray(read) ? read : [];
}

/** Every dependency a bot PR moves: the body's list first, the title when the body has none. */
export function parseBumps(title: string, body: string): Bump[] {
  const found = new Map<string, Bump>();
  for (const pattern of [BODY_BUMP, TABLE_BUMP]) {
    for (const match of body.matchAll(pattern)) {
      const { name, from, to } = match.groups ?? {};
      if (name !== undefined && from !== undefined && to !== undefined && !found.has(name.trim())) {
        found.set(name.trim(), { name: name.trim(), from, to });
      }
    }
  }
  if (found.size > 0) return [...found.values()];
  const { name, from, to } = TITLE_BUMP.exec(title)?.groups ?? {};
  return name !== undefined && from !== undefined && to !== undefined ? [{ name, from, to }] : [];
}

/**
 * The semver level of a move, judged the way Cargo's and npm's caret ranges judge
 * compatibility: below 1.0.0 the first non-zero component is the breaking one, so
 * 0.2 -> 0.3 is a major move (https://doc.rust-lang.org/cargo/reference/semver.html).
 */
export function semverLevel(from: string | undefined, to: string | undefined): Level {
  const before = from === undefined ? null : VERSION.exec(from);
  const after = to === undefined ? null : VERSION.exec(to);
  if (before === null || after === null) return "unknown";
  const [major, minor, patch] = [1, 2, 3].map((index) => [
    Number(before[index] ?? "0"),
    Number(after[index] ?? "0"),
  ]) as [[number, number], [number, number], [number, number]];
  if (major[0] !== major[1]) return "major";
  if (minor[0] !== minor[1]) return major[0] === 0 ? "major" : "minor";
  if (patch[0] !== patch[1]) return major[0] === 0 && minor[0] === 0 ? "major" : "patch";
  return "patch";
}

export function highestLevel(levels: readonly Level[]): Level {
  return levels.reduce<Level>(
    (best, level) => (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(best) ? level : best),
    "unknown",
  );
}

/** One verdict for a check rollup, failing closed; `failing` names each check held. */
export function checkSummary(rollup: readonly unknown[]): {
  state: CheckState;
  failing: string[];
} {
  if (rollup.length === 0) return { state: "NONE", failing: [] };
  const failing: string[] = [];
  let pending = false;
  for (const check of rollup) {
    // A check run reports conclusion and status; a commit status reports state.
    const state = (text(check, "conclusion") ?? text(check, "state") ?? "").toUpperCase();
    const status = (text(check, "status") ?? "").toUpperCase();
    const name = text(check, "name") ?? text(check, "context") ?? "?";
    if (state === "" && status !== "" && status !== "COMPLETED") {
      pending = true;
    } else if (PENDING_STATES.has(state)) {
      pending = true;
    } else if (!PASSING_STATES.has(state)) {
      failing.push(`${name}=${state === "" ? "UNKNOWN" : state}`);
    }
  }
  if (failing.length > 0) return { state: "FAILING", failing };
  return { state: pending ? "PENDING" : "PASSING", failing: [] };
}

/** Dependabot names its branch after the ecosystem; Renovate is told apart by the file it edits. */
export function ecosystemOf(branch: string, files: readonly string[]): Ecosystem {
  if (branch.startsWith("dependabot/cargo/")) return "cargo";
  // Dependabot still calls its npm updater `npm_and_yarn`, pnpm included.
  if (branch.startsWith("dependabot/npm_and_yarn/")) return "npm";
  if (branch.startsWith("dependabot/github_actions/")) return "github-actions";
  if (files.includes("rust-toolchain.toml")) return "rust-toolchain";
  if (files.includes("mise.toml")) return "mise";
  if (files.some((path) => path === "Cargo.lock" || path.endsWith("Cargo.toml"))) return "cargo";
  if (files.some((path) => path === "pnpm-lock.yaml" || path.endsWith("package.json"))) {
    return "npm";
  }
  if (files.some((path) => path.startsWith(".github/workflows/"))) return "github-actions";
  return "other";
}

/** Each file two or more PRs touch, with those PRs: the case for a combined branch. */
export function contestedFiles(rows: readonly Row[]): Map<string, number[]> {
  const seen = new Map<string, number[]>();
  for (const row of rows) {
    for (const path of row.files) seen.set(path, [...(seen.get(path) ?? []), row.number]);
  }
  return new Map([...seen].filter(([, numbers]) => numbers.length > 1));
}

/**
 * Which pair a Tauri package belongs to: the `tauri` crate with `@tauri-apps/api` and
 * `@tauri-apps/cli`, and `tauri-plugin-<x>` with `@tauri-apps/plugin-<x>`. The other
 * `tauri-*` crates (tauri-build, tauri-utils, ...) carry their own version numbers and
 * follow `tauri` through Cargo's resolution, so they pair with nothing.
 */
function pairKey(name: string): string | undefined {
  if (name === "tauri" || name === "@tauri-apps/api" || name === "@tauri-apps/cli") return "tauri";
  const plugin = /^(?:tauri-plugin-|@tauri-apps\/plugin-)(?<plugin>[a-z0-9-]+)$/.exec(name);
  return plugin?.groups?.["plugin"] === undefined ? undefined : `plugin-${plugin.groups["plugin"]}`;
}

function isTauriFamily(name: string): boolean {
  return name === "tauri" || name.startsWith("tauri-") || name.startsWith("@tauri-apps/");
}

function minorOf(version: string): string | undefined {
  const match = VERSION.exec(version);
  return match === null ? undefined : `${match[1] ?? ""}.${match[2] ?? ""}`;
}

/**
 * Whether the batch leaves each Tauri pair on one minor, from the versions the checkout
 * has now plus every move the open PRs make; and every Tauri major, which is a migration
 * rather than a bump.
 */
export function tauriReport(
  rows: readonly Row[],
  current: ReadonlyMap<string, string>,
): { pairs: TauriPair[]; majors: TauriMajor[] } {
  const landed = new Map<string, { version: string; pr?: number }>(
    [...current].map(([name, version]) => [name, { version }]),
  );
  const moved = new Map<string, number[]>();
  const majors: TauriMajor[] = [];
  for (const row of rows) {
    for (const bump of row.bumps) {
      if (!isTauriFamily(bump.name)) continue;
      if (semverLevel(bump.from, bump.to) === "major") majors.push({ pr: row.number, ...bump });
      landed.set(bump.name, { version: bump.to, pr: row.number });
      const key = pairKey(bump.name);
      if (key !== undefined) moved.set(key, [...new Set([...(moved.get(key) ?? []), row.number])]);
    }
  }
  const pairs = [...moved].map(([key, prs]): TauriPair => {
    const versions = [...landed]
      .filter(([name]) => pairKey(name) === key)
      .sort(([left], [right]) => Number(left.startsWith("@")) - Number(right.startsWith("@")))
      .map(([name, { version, pr }]) =>
        pr === undefined ? { name, version } : { name, version, pr },
      );
    const minors = new Set(versions.map(({ version }) => minorOf(version)));
    return { key, prs: [...prs].sort((a, b) => a - b), aligned: minors.size === 1, versions };
  });
  return { pairs, majors };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The Tauri family's versions in this checkout: locked crates, and npm ranges as written. */
export function currentTauriVersions(root: string): Map<string, string> {
  const versions = new Map<string, string>();
  const lock = readText(join(root, "Cargo.lock"));
  if (lock !== undefined) {
    try {
      for (const pkg of list(parseToml(lock), "package")) {
        const name = text(pkg, "name");
        const version = text(pkg, "version");
        if (name !== undefined && version !== undefined && pairKey(name) !== undefined) {
          versions.set(name, version);
        }
      }
    } catch {
      // An unparsable lockfile gives no baseline; `cargo` itself reports it.
    }
  }
  const manifest = readText(join(root, "package.json"));
  if (manifest !== undefined) {
    try {
      const parsed: unknown = JSON.parse(manifest);
      for (const section of ["dependencies", "devDependencies"]) {
        for (const [name, range] of Object.entries(field(parsed, section) ?? {})) {
          if (typeof range === "string" && pairKey(name) !== undefined) versions.set(name, range);
        }
      }
    } catch {
      // As above: pnpm reports a broken package.json better than this survey can.
    }
  }
  return versions;
}

function ghPullRequests(context: ScriptContext): unknown[] {
  const args = ["pr", "list", "--state", "open", "--limit", "100", "--json", FIELDS];
  const result = context.run("gh", args, { cwd: context.root, timeoutMs: 120_000 });
  const failure = (actual: string) =>
    new ScriptError({
      code: "ERR_SURVEY_GH",
      summary: "`gh pr list` did not return the open pull requests",
      expected: "the GitHub CLI on PATH, authenticated, printing a JSON list",
      actual,
      next: "run `gh auth status` and confirm this checkout has a GitHub remote",
    });
  if (result.status !== 0) {
    throw failure(result.stderr.trim() || `exit status ${String(result.status)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout === "" ? "[]" : result.stdout);
  } catch {
    throw failure(`output that is not JSON: ${result.stdout.slice(0, 120)}`);
  }
  if (!Array.isArray(parsed))
    throw failure(`JSON that is not a list: ${result.stdout.slice(0, 120)}`);
  return parsed;
}

/** One row per open Dependabot or Renovate PR, in PR-number order. */
export function collect(pulls: readonly unknown[]): Row[] {
  const rows: Row[] = [];
  for (const pull of pulls) {
    const author = text(field(pull, "author"), "login") ?? "";
    if (!author.includes("dependabot") && !author.includes("renovate")) continue;
    const title = text(pull, "title") ?? "";
    const branch = text(pull, "headRefName") ?? "";
    const files = list(pull, "files")
      .map((file) => text(file, "path") ?? "")
      .filter((path) => path !== "");
    const bumps = parseBumps(title, text(pull, "body") ?? "");
    const { state, failing } = checkSummary(list(pull, "statusCheckRollup"));
    rows.push({
      number: Number(field(pull, "number") ?? 0),
      title,
      url: text(pull, "url") ?? "",
      branch,
      author,
      ecosystem: ecosystemOf(branch, files),
      bumps,
      level: highestLevel(bumps.map((bump) => semverLevel(bump.from, bump.to))),
      checks: state,
      failingChecks: failing,
      mergeState: text(pull, "mergeStateStatus") ?? "?",
      files,
    });
  }
  return rows.sort((left, right) => left.number - right.number);
}

function report(
  context: ScriptContext,
  rows: readonly Row[],
  tauri: { pairs: TauriPair[]; majors: TauriMajor[] },
): void {
  context.log(`${String(rows.length)} open bot PR(s)`);
  for (const row of rows) {
    context.log("");
    context.log(
      `  #${String(row.number).padEnd(4)} [${row.ecosystem.padEnd(14)}] ${row.level.padEnd(7)} ` +
        `checks=${row.checks.padEnd(8)} merge=${row.mergeState}`,
    );
    context.log(`        ${row.title}`);
    for (const bump of row.bumps) context.log(`        ${bump.name} ${bump.from} -> ${bump.to}`);
    if (row.failingChecks.length > 0) context.log(`        HELD: ${row.failingChecks.join(", ")}`);
    context.log(`        files: ${row.files.join(", ") || "(none)"}`);
  }
  const contested = contestedFiles(rows);
  if (contested.size > 0) {
    context.log("");
    context.log("Contested files (one combined branch):");
    for (const [path, numbers] of contested) {
      context.log(`  ${path}: ${numbers.map((n) => `#${String(n)}`).join(", ")}`);
    }
  }
  if (tauri.pairs.length > 0) {
    context.log("");
    context.log("Tauri family (every member lands in one branch, on one minor):");
    for (const pair of tauri.pairs) {
      const members = pair.versions
        .map(
          ({ name, version, pr }) =>
            `${name} ${version}${pr === undefined ? "" : ` (#${String(pr)})`}`,
        )
        .join(", ");
      context.log(`  ${pair.key}: ${pair.aligned ? "aligned" : "MISMATCH"} -- ${members}`);
    }
  }
  if (tauri.majors.length > 0) {
    context.log("");
    context.log("Tauri major (a migration issue, never part of a batch):");
    for (const major of tauri.majors) {
      context.log(`  #${String(major.pr)} ${major.name} ${major.from} -> ${major.to}`);
    }
  }
}

export function main(context: ScriptContext): void {
  const unknown = context.argv.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    throw new ScriptError({
      code: "ERR_SURVEY_USAGE",
      summary: `unknown argument: ${unknown.join(" ")}`,
      expected: "no argument, or --json",
      actual: context.argv.join(" "),
      next: "run `node .agents/skills/merging-dependency-prs/scripts/survey-prs.ts`",
    });
  }
  const rows = collect(ghPullRequests(context));
  const tauri = tauriReport(rows, currentTauriVersions(context.root));
  if (context.argv.includes("--json")) {
    const contested = Object.fromEntries(contestedFiles(rows));
    context.log(JSON.stringify({ rows, contested, tauri }, null, 2));
    return;
  }
  if (rows.length === 0) {
    context.log("No open Dependabot or Renovate pull requests.");
    return;
  }
  report(context, rows, tauri);
}

if (import.meta.main) await runScript(main);
