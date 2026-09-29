/**
 * The Tauri crate and its npm packages move together (design D8, § 2; the
 * `merging-dependency-prs` skill keeps each tauri crate and its @tauri-apps/* package in
 * step):
 *
 * - every `tauri` crate in Cargo.lock, and the resolved `@tauri-apps/api` and
 *   `@tauri-apps/cli` of pnpm-lock.yaml's root importer, share one MAJOR.MINOR;
 * - each `@tauri-apps/plugin-<x>` the root importer resolves has a `tauri-plugin-<x>`
 *   crate in Cargo.lock at exactly the same version. A plugin crate with no npm package
 *   is fine: some plugins have no JavaScript side.
 *
 * Both lockfiles are read with real parsers (smol-toml; yaml, every document, since
 * pnpm writes the package manager's own lock as a first document). A resolved npm
 * version's peer suffix (`2.10.0(@tauri-apps/api@2.11.1)`) is dropped.
 *
 *   node scripts/checks/tauri-versions.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING, ERR_CHECK_TAURI_VERSIONS_UNPARSED (a lockfile or a
 * version could not be read), ERR_CHECK_TAURI_VERSIONS_MISSING (tauri, api, or cli not
 * locked), ERR_CHECK_TAURI_VERSIONS_DIVERGED, ERR_CHECK_TAURI_PLUGIN_VERSIONS_DIVERGED.
 */
import { parse as parseToml } from "smol-toml";
import { parseAllDocuments } from "yaml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const CARGO_LOCK = "Cargo.lock";
const PNPM_LOCK = "pnpm-lock.yaml";
const NPM_CORE = ["@tauri-apps/api", "@tauri-apps/cli"];
const NPM_PLUGIN = "@tauri-apps/plugin-";
const CRATE_PLUGIN = "tauri-plugin-";
const VERSION = /^(\d+)\.(\d+)\.\d+(?:[-+][\w.-]+)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unparsed = (summary: string, actual: string): FailureDetails => ({
  code: "ERR_CHECK_TAURI_VERSIONS_UNPARSED",
  summary,
  expected: `${CARGO_LOCK} as TOML with [[package]] name/version entries, and ${PNPM_LOCK} as YAML with an \`importers: { .: … }\` root importer whose versions are release numbers`,
  actual,
  next: "regenerate the lockfile (`cargo update -w` or `pnpm install`), or update scripts/checks/tauri-versions.ts's reader in the same change",
});

/** Cargo.lock's packages as name → versions. */
function cargoVersions(text: string): Map<string, string[]> | FailureDetails {
  let lock: unknown;
  try {
    lock = parseToml(text);
  } catch (error: unknown) {
    const first = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    return unparsed(`${CARGO_LOCK} could not be parsed`, first);
  }
  const packages =
    isRecord(lock) && Array.isArray(lock["package"]) ? (lock["package"] as unknown[]) : [];
  const versions = new Map<string, string[]>();
  for (const entry of packages) {
    if (
      !isRecord(entry) ||
      typeof entry["name"] !== "string" ||
      typeof entry["version"] !== "string"
    )
      continue;
    versions.set(entry["name"], [...(versions.get(entry["name"]) ?? []), entry["version"]]);
  }
  return versions;
}

/** The root importer's resolved npm versions, as name → version. */
function npmVersions(text: string): Map<string, string> | FailureDetails {
  const documents = parseAllDocuments(text);
  const broken = documents.flatMap((doc) => doc.errors);
  if (broken.length > 0) {
    return unparsed(`${PNPM_LOCK} could not be parsed`, broken[0]?.message.split("\n")[0] ?? "");
  }
  const versions = new Map<string, string>();
  let found = false;
  for (const doc of documents) {
    const json: unknown = doc.toJS();
    const importers = isRecord(json) ? json["importers"] : undefined;
    const root = isRecord(importers) ? importers["."] : undefined;
    if (!isRecord(root)) continue;
    for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = root[group];
      if (!isRecord(deps)) continue;
      found = true;
      for (const [name, dep] of Object.entries(deps)) {
        const version = isRecord(dep) ? dep["version"] : undefined;
        if (typeof version === "string") versions.set(name, version.replace(/\(.*$/, ""));
      }
    }
  }
  if (!found)
    return unparsed(
      `${PNPM_LOCK} has no root importer dependencies`,
      "no `importers: { .: { dependencies | devDependencies } }` in any document",
    );
  return versions;
}

function run(root: string): FailureDetails[] {
  const missing = [CARGO_LOCK, PNPM_LOCK].filter((path) => readRepoFile(root, path) === undefined);
  if (missing.length > 0) {
    return missing.map((path) => ({
      code: "ERR_CHECK_INPUT_MISSING",
      summary: `${path} does not exist`,
      expected: `${path} at the root (the lockfiles are committed)`,
      actual: "no such file",
      next:
        path === CARGO_LOCK
          ? "run `cargo generate-lockfile` and commit Cargo.lock"
          : "run `pnpm install` and commit pnpm-lock.yaml",
    }));
  }
  const crates = cargoVersions(readRepoFile(root, CARGO_LOCK) ?? "");
  const npm = npmVersions(readRepoFile(root, PNPM_LOCK) ?? "");
  if (!(crates instanceof Map) || !(npm instanceof Map)) {
    return [crates, npm].filter((r): r is FailureDetails => !(r instanceof Map));
  }

  const violations: FailureDetails[] = [];
  const locked: { what: string; version: string }[] = [
    ...(crates.get("tauri") ?? []).map((version) => ({ what: "tauri", version })),
    ...NPM_CORE.flatMap((name) => {
      const version = npm.get(name);
      return version === undefined ? [] : [{ what: name, version }];
    }),
  ];
  const absent = [
    ...(crates.has("tauri") ? [] : [`the tauri crate in ${CARGO_LOCK}`]),
    ...NPM_CORE.filter((name) => !npm.has(name)).map(
      (name) => `${name} in ${PNPM_LOCK}'s root importer`,
    ),
  ];
  for (const what of absent) {
    violations.push({
      code: "ERR_CHECK_TAURI_VERSIONS_MISSING",
      summary: `${what} is not locked`,
      expected: `tauri in ${CARGO_LOCK}, and @tauri-apps/api and @tauri-apps/cli in ${PNPM_LOCK}'s root importer`,
      actual: `no entry for ${what}`,
      next: "restore the dependency (Cargo.toml's [workspace.dependencies], package.json), then `cargo update -w` / `pnpm install`",
    });
  }
  const unreadable = locked.filter(({ version }) => !VERSION.test(version));
  for (const { what, version } of unreadable) {
    violations.push(
      unparsed(
        `${what}'s locked version \`${version}\` is not a release number`,
        `${what} ${version}`,
      ),
    );
  }
  const minors = new Set(
    locked
      .filter((l) => !unreadable.includes(l))
      .map(({ version }) => VERSION.exec(version)?.slice(1, 3).join(".")),
  );
  if (minors.size > 1) {
    violations.push({
      code: "ERR_CHECK_TAURI_VERSIONS_DIVERGED",
      summary: "the tauri crate and @tauri-apps/api and @tauri-apps/cli are on different minors",
      expected:
        "one MAJOR.MINOR across tauri (Cargo.lock), @tauri-apps/api, and @tauri-apps/cli (pnpm-lock.yaml)",
      actual: locked.map(({ what, version }) => `${what} ${version}`).join(", "),
      next: "bump them together in one change (the merging-dependency-prs skill); a new major is a migration with an ADR, not a bump",
    });
  }

  for (const [name, npmVersion] of [...npm].filter(([n]) => n.startsWith(NPM_PLUGIN)).sort()) {
    const crate = `${CRATE_PLUGIN}${name.slice(NPM_PLUGIN.length)}`;
    const crateVersions = crates.get(crate) ?? [];
    if (crateVersions.length > 0 && crateVersions.every((v) => v === npmVersion)) continue;
    violations.push({
      code: "ERR_CHECK_TAURI_PLUGIN_VERSIONS_DIVERGED",
      summary: `${name} ${npmVersion} has ${crateVersions.length === 0 ? "no" : "a different"} ${crate} crate`,
      expected: `${crate} in ${CARGO_LOCK} at exactly ${npmVersion}, the version of ${name} in ${PNPM_LOCK}`,
      actual:
        crateVersions.length === 0
          ? `no ${crate} in ${CARGO_LOCK}`
          : crateVersions.map((v) => `${crate} ${v}`).join(", "),
      next: `lock ${crate} and ${name} to one version in the same change (\`cargo update -p ${crate} --precise ${npmVersion}\`, or bump ${name}); a plugin used from JavaScript needs its crate registered in src-tauri`,
    });
  }
  return violations;
}

export const check: Check = { name: "tauri-versions", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
