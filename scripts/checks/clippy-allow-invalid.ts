/**
 * No `clippy.toml` sets `allow-invalid`. The key tells clippy to accept a
 * `disallowed-*` path it cannot resolve without a word, so `scripts/clippy-guard.ts`
 * never sees the warning it turns into ERR_CLIPPY_BAN_UNRESOLVED and the ban silently
 * does nothing. Any value is refused, `false` included: it is the default, and a key
 * that only needs flipping to `true` is one edit from a no-op ban.
 *
 *   node scripts/checks/clippy-allow-invalid.ts [--root DIR]
 *
 * Read: every `clippy.toml` and `.clippy.toml` under --root (clippy reads either, from a
 * crate's directory or one above it), skipping `.git`, `node_modules`, `target`, and any
 * directory holding its own `.git` (another checkout or worktree, such as
 * `.claude/worktrees/`). The key is found at any depth, spelled with a hyphen or an
 * underscore.
 *
 * An entry that genuinely needs the key (a ban on an item that exists on one target
 * only) is a human's decision, recorded in EXCEPTIONS below with its reason; an
 * exception whose entry no longer carries the key fails as stale.
 *
 * Git work tree: not required; the check reads files under --root.
 *
 * Errors (FailureDetails; the runner prints them all):
 *   ERR_CHECK_USAGE                  bad arguments (scripts/checks/lib.ts)
 *   ERR_CHECK_CLIPPY_UNREADABLE      a clippy.toml does not parse
 *   ERR_CHECK_CLIPPY_ALLOW_INVALID   a clippy.toml sets allow-invalid outside EXCEPTIONS
 *   ERR_CHECK_CLIPPY_EXCEPTION_STALE an exception names an entry that no longer sets it
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import { isRecord } from "./shared/workflows.ts";

const THIS = "scripts/checks/clippy-allow-invalid.ts";
const CONFIG_FILES = new Set(["clippy.toml", ".clippy.toml"]);
const SKIPPED_DIRS = new Set([".git", "node_modules", "target"]);

/**
 * Entries allowed to carry `allow-invalid`, keyed `<clippy.toml path> <ban path>`
 * (e.g. `src-tauri/clippy.toml std::os::linux::fs::MetadataExt::st_dev`), each
 * with its reason. Adding one is weakening a gate (AGENTS.md › Security and human
 * approval): it needs a human's sign-off.
 */
export const EXCEPTIONS: Readonly<Record<string, string>> = {};

/** Every clippy configuration file under `root`, as sorted `/`-separated relative paths. */
export function configFiles(root: string, dir = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isFile() && CONFIG_FILES.has(entry.name)) {
      found.push(path);
    } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
      const nested = readdirSync(join(root, path)).includes(".git");
      if (!nested) found.push(...configFiles(root, path));
    }
  }
  return found.sort();
}

/** Where the key sits: its TOML location and, inside a ban entry, the entry's `path`. */
interface Hit {
  readonly location: string;
  readonly ban?: string;
}

function findKey(value: unknown, location: string, hits: Hit[]): void {
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      findKey(item, `${location}[${String(index)}]`, hits);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key.replaceAll("_", "-") === "allow-invalid") {
      const ban = value["path"];
      hits.push({
        location: location === "" ? key : `${location}.${key}`,
        ...(typeof ban === "string" ? { ban } : {}),
      });
    } else {
      findKey(inner, location === "" ? key : `${location}.${key}`, hits);
    }
  }
}

/** The check's violations under `root`, given the exception list. */
export function scan(root: string, exceptions: Readonly<Record<string, string>>): FailureDetails[] {
  const violations: FailureDetails[] = [];
  const used = new Set<string>();
  for (const file of configFiles(root)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(readRepoFile(root, file) ?? "");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      violations.push({
        code: "ERR_CHECK_CLIPPY_UNREADABLE",
        summary: `${file} does not parse`,
        expected: `${file} to parse, so its keys can be checked for allow-invalid`,
        actual: message.split("\n")[0] ?? "",
        next: `fix ${file}`,
      });
      continue;
    }
    const hits: Hit[] = [];
    findKey(parsed, "", hits);
    for (const hit of hits) {
      const key = hit.ban === undefined ? undefined : `${file} ${hit.ban}`;
      if (key !== undefined && exceptions[key] !== undefined) {
        used.add(key);
        continue;
      }
      violations.push({
        code: "ERR_CHECK_CLIPPY_ALLOW_INVALID",
        summary: `${file} sets ${hit.location}${hit.ban === undefined ? "" : ` on the ban of ${hit.ban}`}`,
        expected:
          "no allow-invalid key in any clippy.toml: it hides the unresolved-path warning scripts/clippy-guard.ts fails on, so the ban can silently do nothing",
        actual: `${file}: ${hit.location}`,
        next: `remove the key and correct the ban's path so \`just lint\` resolves it; an entry that genuinely needs the key goes in ${THIS}'s EXCEPTIONS with a human's sign-off (AGENTS.md › Security and human approval)`,
      });
    }
  }
  for (const key of Object.keys(exceptions).sort()) {
    if (used.has(key)) continue;
    violations.push({
      code: "ERR_CHECK_CLIPPY_EXCEPTION_STALE",
      summary: `the exception for ${key} no longer applies`,
      expected: `every EXCEPTIONS entry in ${THIS} to name a ban that sets allow-invalid`,
      actual: `no clippy.toml entry matches ${key}`,
      next: `remove the entry from ${THIS}'s EXCEPTIONS`,
    });
  }
  return violations;
}

export const check: Check = {
  name: "clippy-allow-invalid",
  run: (root) => scan(root, EXCEPTIONS),
};
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
