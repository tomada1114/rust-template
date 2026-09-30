/**
 * The core boundary holds, and its three lists agree:
 *
 * 1. `myapp-core`'s dependency closure over normal and build edges (no dev-dependency,
 *    across every target, from `cargo metadata`'s resolved graph) contains none of
 *    {@link FORBIDDEN_IN_CORE}. A build edge counts because a `[build-dependencies]`
 *    crate compiles and runs on every build of core, so `tauri-build` or `objc2` there
 *    ties core to the platform as surely as a normal edge. The walk stops at the first
 *    forbidden crate on a path, so each violation names the crate to remove and how core
 *    reaches it, marking a build edge `-(build)->`.
 * 2. `myapp-test-support` is never a normal, optional, or build-dependency of a
 *    workspace crate: test-only code never ships.
 * 3. The crates AGENTS.md's boundary sentence names ("… normal and build dependency closure
 *    reaches `a`, `b`, or `c`.") equal {@link FORBIDDEN_IN_CORE}, and `deny.toml`'s
 *    `[bans] deny` wrapper entries are the boundary's: `tauri` → `myapp` only,
 *    `myapp-platform` → `myapp` and `myapp-cli` only, and every `tauri-plugin-*` a
 *    workspace crate depends on has an entry with `myapp` as its only wrapper.
 *
 *   node scripts/checks/core-boundary.ts [--root DIR]
 *
 * The graph comes from `cargo metadata --format-version 1 --locked --offline` run in the
 * root. It needs cargo and the registry cache (`cargo fetch --locked`) but no build and
 * no macOS, so it works on a Linux runner. When it fails the check reports a violation;
 * it never skips. Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING (AGENTS.md or deny.toml absent),
 * ERR_CHECK_CORE_BOUNDARY_METADATA (cargo metadata failed or is not the expected
 * shape), ERR_CHECK_CORE_BOUNDARY_CLOSURE, ERR_CHECK_TEST_SUPPORT_NOT_DEV,
 * ERR_CHECK_CORE_BOUNDARY_UNPARSED (a list could not be read),
 * ERR_CHECK_CORE_BOUNDARY_DIVERGED (AGENTS.md's list differs),
 * ERR_CHECK_CORE_BOUNDARY_WRAPPERS (a deny.toml wrapper entry differs from the boundary).
 */
import { spawnSync } from "node:child_process";

import { parse as parseToml } from "smol-toml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript, type Run } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

/** What core's normal and build dependency closure must never contain; `x*` is a prefix. */
export const FORBIDDEN_IN_CORE: readonly string[] = [
  "tauri*",
  "wry",
  "tao",
  "objc2*",
  "core-foundation*",
  "security-framework*",
  "myapp-platform",
];

const CORE = "myapp-core";
const TEST_SUPPORT = "myapp-test-support";
const PLUGIN_PREFIX = "tauri-plugin-";
/** The boundary's direct-edge rule: the only crates that may depend on each of these directly. */
const WRAPPERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["tauri", ["myapp"]],
  ["myapp-platform", ["myapp", "myapp-cli"]],
]);
const PLUGIN_WRAPPERS: readonly string[] = ["myapp"];
const METADATA_ARGS = ["metadata", "--format-version", "1", "--locked", "--offline"];
const METADATA_COMMAND = `cargo ${METADATA_ARGS.join(" ")}`;
/** The workspace's metadata is several MB; spawnSync's default buffer is 1 MiB. */
const METADATA_MAX_BUFFER = 256 * 1024 * 1024;

export interface CargoDependency {
  readonly name: string;
  /** null for a normal dependency, else "dev" or "build". */
  readonly kind: string | null;
  readonly optional: boolean;
}

export interface CargoPackage {
  readonly id: string;
  readonly name: string;
  readonly dependencies: readonly CargoDependency[];
}

export interface ResolvedNode {
  readonly id: string;
  readonly deps: readonly { readonly pkg: string; readonly kinds: readonly (string | null)[] }[];
}

/** The parts of `cargo metadata --format-version 1` the check reads. */
export interface CargoMetadata {
  readonly packages: readonly CargoPackage[];
  readonly workspaceMembers: readonly string[];
  /** Absent under `--no-deps`. */
  readonly nodes: readonly ResolvedNode[] | undefined;
}

export type MetadataResult =
  { readonly metadata: CargoMetadata } | { readonly violation: FailureDetails };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: unknown[] = value;
  return items.every((item) => typeof item === "string") ? items : undefined;
}

const kindOf = (value: unknown): string | null | undefined =>
  value === null || typeof value === "string" ? value : undefined;

function toDependency(value: unknown): CargoDependency | undefined {
  if (!isRecord(value) || typeof value["name"] !== "string") return undefined;
  const kind = kindOf(value["kind"]);
  if (kind === undefined) return undefined;
  return { name: value["name"], kind, optional: value["optional"] === true };
}

function toPackage(value: unknown): CargoPackage | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["name"] !== "string") {
    return undefined;
  }
  const raw = value["dependencies"];
  if (!Array.isArray(raw)) return undefined;
  const dependencies = raw.map(toDependency);
  if (dependencies.some((dep) => dep === undefined)) return undefined;
  return { id: value["id"], name: value["name"], dependencies: dependencies as CargoDependency[] };
}

function toNode(value: unknown): ResolvedNode | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || !Array.isArray(value["deps"])) {
    return undefined;
  }
  const deps: { pkg: string; kinds: (string | null)[] }[] = [];
  for (const dep of value["deps"] as unknown[]) {
    if (!isRecord(dep) || typeof dep["pkg"] !== "string" || !Array.isArray(dep["dep_kinds"])) {
      return undefined;
    }
    const kinds = (dep["dep_kinds"] as unknown[]).map((k) =>
      isRecord(k) ? kindOf(k["kind"]) : undefined,
    );
    if (kinds.some((k) => k === undefined)) return undefined;
    deps.push({ pkg: dep["pkg"], kinds: kinds as (string | null)[] });
  }
  return { id: value["id"], deps };
}

function metadataViolation(actual: string): { violation: FailureDetails } {
  return {
    violation: {
      code: "ERR_CHECK_CORE_BOUNDARY_METADATA",
      summary: "cargo metadata could not give myapp-core's dependency graph",
      expected: `\`${METADATA_COMMAND}\` to print the workspace's resolved graph, with myapp-core a member`,
      actual,
      next: "run `cargo fetch --locked` (the check reads the registry cache offline), then the command above to see cargo's error",
    },
  };
}

/** Read `cargo metadata`'s JSON; `source` names where it came from in a violation. */
export function parseCargoMetadata(text: string, source: string): MetadataResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return metadataViolation(`${source} printed text that is not JSON`);
  }
  const shape = `${source} is not \`cargo metadata --format-version 1\` output`;
  if (!isRecord(json) || !Array.isArray(json["packages"])) return metadataViolation(shape);
  const packages = (json["packages"] as unknown[]).map(toPackage);
  const members = stringArray(json["workspace_members"]);
  if (members === undefined || packages.some((p) => p === undefined)) {
    return metadataViolation(shape);
  }
  const resolve = json["resolve"];
  let nodes: ResolvedNode[] | undefined;
  if (isRecord(resolve)) {
    const raw = Array.isArray(resolve["nodes"]) ? (resolve["nodes"] as unknown[]) : [undefined];
    const parsed = raw.map(toNode);
    if (parsed.some((node) => node === undefined)) return metadataViolation(shape);
    nodes = parsed as ResolvedNode[];
  }
  return {
    metadata: { packages: packages as CargoPackage[], workspaceMembers: members, nodes },
  };
}

/** `run`, with a buffer big enough for the workspace's metadata. */
const runCargo: Run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: METADATA_MAX_BUFFER,
  });
  return result.error === undefined
    ? { status: result.status, stdout: result.stdout, stderr: result.stderr }
    : { status: null, stdout: "", stderr: result.error.message };
};

/** Run `cargo metadata` in `root`; a failure is a violation, never a skip. */
export function loadCargoMetadata(root: string, run: Run = runCargo): MetadataResult {
  const result = run("cargo", METADATA_ARGS, { cwd: root });
  if (result.status !== 0) {
    const detail = result.stderr.trim().split("\n")[0] ?? "";
    return metadataViolation(
      `exit ${result.status === null ? "none (did not start)" : String(result.status)}: ${detail || "no error output"}`,
    );
  }
  return parseCargoMetadata(result.stdout, METADATA_COMMAND);
}

/** Whether `name` matches a list entry: exact, or a prefix for `x*`. */
export function matchesForbidden(name: string, pattern: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

function closureViolations(metadata: CargoMetadata): FailureDetails[] {
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const core = metadata.workspaceMembers.find((id) => byId.get(id)?.name === CORE);
  if (core === undefined) {
    return [metadataViolation(`no workspace member named ${CORE}`).violation];
  }
  if (metadata.nodes === undefined) {
    return [metadataViolation("no resolved dependency graph (was --no-deps passed?)").violation];
  }
  const nodes = new Map(metadata.nodes.map((node) => [node.id, node]));
  const nameOf = (id: string): string => byId.get(id)?.name ?? id;
  const parent = new Map<string, string>();
  const seen = new Set([core]);
  const queue = [core];
  const violations: FailureDetails[] = [];
  const viaBuild = new Set<string>();
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const dep of nodes.get(id)?.deps ?? []) {
      const normal = dep.kinds.includes(null);
      if (seen.has(dep.pkg) || (!normal && !dep.kinds.includes("build"))) continue;
      seen.add(dep.pkg);
      parent.set(dep.pkg, id);
      if (!normal) viaBuild.add(dep.pkg);
      const name = nameOf(dep.pkg);
      const pattern = FORBIDDEN_IN_CORE.find((p) => matchesForbidden(name, p));
      if (pattern === undefined) {
        queue.push(dep.pkg);
        continue;
      }
      let path = nameOf(dep.pkg);
      for (let at = dep.pkg, from = parent.get(at); from !== undefined;) {
        path = `${nameOf(from)} ${viaBuild.has(at) ? "-(build)->" : "->"} ${path}`;
        at = from;
        from = parent.get(at);
      }
      violations.push({
        code: "ERR_CHECK_CORE_BOUNDARY_CLOSURE",
        summary: `${CORE}'s dependency closure reaches ${name} (forbidden as \`${pattern}\`)`,
        expected: `no ${FORBIDDEN_IN_CORE.map((p) => `\`${p}\``).join(", ")} among ${CORE}'s normal or build dependencies, direct or transitive`,
        actual: `dependency path: ${path}`,
        next: `remove the edge that brings ${name} into core (crates/${CORE}/Cargo.toml's [dependencies] or [build-dependencies], or a dependency's features); OS and Tauri code belongs in myapp-platform or src-tauri behind a port`,
      });
    }
  }
  return violations;
}

function testSupportViolations(metadata: CargoMetadata): FailureDetails[] {
  const members = new Set(metadata.workspaceMembers);
  return metadata.packages
    .filter((pkg) => members.has(pkg.id))
    .flatMap((pkg) =>
      pkg.dependencies
        .filter((dep) => dep.name === TEST_SUPPORT && dep.kind !== "dev")
        .map((dep) => {
          const edge = `${dep.optional ? "an optional " : "a "}${dep.kind ?? "normal"} dependency`;
          return {
            code: "ERR_CHECK_TEST_SUPPORT_NOT_DEV",
            summary: `${pkg.name} takes ${TEST_SUPPORT} as ${edge}`,
            expected: `${TEST_SUPPORT} only under [dev-dependencies] (test-only code never ships)`,
            actual: `${pkg.name}'s Cargo.toml declares ${TEST_SUPPORT} as ${edge}`,
            next: `move ${TEST_SUPPORT} to ${pkg.name}'s [dev-dependencies]; a fake the shipped code needs is a real adapter in myapp-platform instead`,
          };
        }),
    );
}

const inputMissing = (path: string, why: string): FailureDetails => ({
  code: "ERR_CHECK_INPUT_MISSING",
  summary: `${path} does not exist`,
  expected: `${path} at the root (${why})`,
  actual: "no such file",
  next: `restore ${path} from version control`,
});

const unparsed = (summary: string, expected: string, actual: string): FailureDetails => ({
  code: "ERR_CHECK_CORE_BOUNDARY_UNPARSED",
  summary,
  expected,
  actual,
  next: "restore the list in the shape Expected names, or update scripts/checks/core-boundary.ts's parser in the same change",
});

/** AGENTS.md's forbidden list: the backticked names in "… closure reaches `a`, … `z`." */
function agentsViolations(root: string): FailureDetails[] {
  const text = readRepoFile(root, "AGENTS.md");
  if (text === undefined)
    return [inputMissing("AGENTS.md", "its boundary sentence lists core's forbidden crates")];
  const sentence = /normal and build dependency\s+closure\s+reaches\s+([^.]*)\./.exec(
    text.replace(/\s+/g, " "),
  );
  const listed = [...(sentence?.[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
  if (listed.length === 0) {
    return [
      unparsed(
        "AGENTS.md's forbidden-crate list could not be read",
        'a sentence in AGENTS.md › Architecture: "… normal and build dependency closure reaches `tauri*`, `wry`, … or `myapp-platform`."',
        "no such sentence, or one naming no backticked crate",
      ),
    ];
  }
  const inAgents = new Set(listed);
  const inCheck = new Set(FORBIDDEN_IN_CORE);
  const diverged = (name: string, where: string): FailureDetails => ({
    code: "ERR_CHECK_CORE_BOUNDARY_DIVERGED",
    summary: `\`${name}\` is ${where}`,
    expected:
      "AGENTS.md › Architecture's closure list to equal FORBIDDEN_IN_CORE in scripts/checks/core-boundary.ts",
    actual: `AGENTS.md: ${listed.map((n) => `\`${n}\``).join(", ")}; the check: ${FORBIDDEN_IN_CORE.map((n) => `\`${n}\``).join(", ")}`,
    next: "change both lists in the same commit (adding strengthens the gate; removing one weakens it and needs a human's sign-off, AGENTS.md › Security and human approval)",
  });
  return [
    ...[...inAgents]
      .filter((n) => !inCheck.has(n))
      .map((n) =>
        diverged(n, "in AGENTS.md's boundary list but not forbidden by the closure check"),
      ),
    ...[...inCheck]
      .filter((n) => !inAgents.has(n))
      .map((n) =>
        diverged(n, "forbidden by the closure check but missing from AGENTS.md's boundary list"),
      ),
  ];
}

/** deny.toml's `[bans] deny` entries, as crate name → wrappers (undefined: none). */
function denyEntries(text: string): Map<string, readonly string[] | undefined> | string {
  let toml: unknown;
  try {
    toml = parseToml(text);
  } catch (error: unknown) {
    return `deny.toml is not valid TOML: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`;
  }
  const bans = isRecord(toml) ? toml["bans"] : undefined;
  const deny = isRecord(bans) ? bans["deny"] : undefined;
  if (!Array.isArray(deny)) return "deny.toml has no [bans] deny array";
  const entries = new Map<string, readonly string[] | undefined>();
  for (const entry of deny as unknown[]) {
    const spec =
      typeof entry === "string"
        ? entry
        : isRecord(entry)
          ? (entry["crate"] ?? entry["name"])
          : undefined;
    if (typeof spec !== "string") continue;
    const name = spec.split(/[@:]/)[0] ?? spec;
    entries.set(name, isRecord(entry) ? stringArray(entry["wrappers"]) : undefined);
  }
  return entries;
}

function wrapperViolations(root: string, metadata: CargoMetadata | undefined): FailureDetails[] {
  const text = readRepoFile(root, "deny.toml");
  if (text === undefined)
    return [inputMissing("deny.toml", "its [bans] wrappers are core's direct-edge rule")];
  const entries = denyEntries(text);
  if (typeof entries === "string") {
    return [
      unparsed(
        "deny.toml's [bans] deny list could not be read",
        'a [bans] table with a `deny = [ { crate = "…", wrappers = ["…"] }, … ]` array',
        entries,
      ),
    ];
  }
  const members = new Set(metadata?.workspaceMembers ?? []);
  const plugins = new Set(
    (metadata?.packages ?? [])
      .filter((pkg) => members.has(pkg.id))
      .flatMap((pkg) => pkg.dependencies.map((dep) => dep.name))
      .filter((name) => name.startsWith(PLUGIN_PREFIX)),
  );
  for (const name of entries.keys()) if (name.startsWith(PLUGIN_PREFIX)) plugins.add(name);
  const required = new Map(WRAPPERS);
  for (const plugin of [...plugins].sort()) required.set(plugin, PLUGIN_WRAPPERS);

  const violations: FailureDetails[] = [];
  for (const [crate, wrappers] of required) {
    const found = entries.get(crate);
    const want = [...wrappers].sort();
    const have = found === undefined ? undefined : [...found].sort();
    if (have?.join(",") === want.join(",")) continue;
    violations.push({
      code: "ERR_CHECK_CORE_BOUNDARY_WRAPPERS",
      summary: `deny.toml's [bans] entry for ${crate} does not match the core boundary`,
      expected: `{ crate = "${crate}", wrappers = [${want.map((w) => `"${w}"`).join(", ")}] } in [bans] deny`,
      actual: entries.has(crate)
        ? `wrappers = [${(have ?? []).map((w) => `"${w}"`).join(", ")}]${found === undefined ? " (no wrappers: the crate is banned outright)" : ""}`
        : `no entry for ${crate}`,
      next: `set the entry to Expected; letting another crate depend on ${crate} directly weakens the boundary and needs a human's sign-off (AGENTS.md › Security and human approval)`,
    });
  }
  return violations;
}

/** The check, with the metadata loader injected so a test can feed a fixture file. */
export function makeCheck(load: (root: string) => MetadataResult): Check {
  return {
    name: "core-boundary",
    run: (root) => {
      const loaded = load(root);
      const metadata = "metadata" in loaded ? loaded.metadata : undefined;
      return [
        ...("violation" in loaded ? [loaded.violation] : []),
        ...(metadata === undefined ? [] : closureViolations(metadata)),
        ...(metadata === undefined ? [] : testSupportViolations(metadata)),
        ...agentsViolations(root),
        ...wrapperViolations(root, metadata),
      ];
    },
  };
}

export const check: Check = makeCheck((root) => loadCargoMetadata(root));

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
