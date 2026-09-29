/**
 * The app's version is one value at its three sites (design D18): `version` under
 * `[workspace.package]` in Cargo.toml, `version` in src-tauri/tauri.conf.json, and
 * `version` in package.json. `just release-prep` sets all three, and the release
 * workflow refuses a tag that differs from them; this catches a hand edit to one of
 * them before a tag is ever pushed. Each is read with a real parser (smol-toml,
 * JSON.parse).
 *
 *   node scripts/checks/version-sites.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING, ERR_CHECK_VERSION_UNPARSED,
 * ERR_CHECK_VERSION_DIVERGED.
 */
import { parse as parseToml } from "smol-toml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

interface Site {
  readonly path: string;
  readonly key: string;
  readonly parse: (text: string) => unknown;
  readonly keys: readonly string[];
}

const SITES: readonly Site[] = [
  {
    path: "Cargo.toml",
    key: "[workspace.package] version",
    parse: parseToml,
    keys: ["workspace", "package", "version"],
  },
  { path: "src-tauri/tauri.conf.json", key: "version", parse: JSON.parse, keys: ["version"] },
  { path: "package.json", key: "version", parse: JSON.parse, keys: ["version"] },
];

/** `value[keys[0]][keys[1]]…` when every step is an object and the end is a string. */
function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function versionOf(site: Site, text: string): string | undefined {
  try {
    return stringAt(site.parse(text), site.keys);
  } catch {
    return undefined;
  }
}

function run(root: string): FailureDetails[] {
  const violations: FailureDetails[] = [];
  const found: { path: string; version: string }[] = [];
  for (const site of SITES) {
    const text = readRepoFile(root, site.path);
    const version = text === undefined ? undefined : versionOf(site, text);
    if (text === undefined) {
      violations.push({
        code: "ERR_CHECK_INPUT_MISSING",
        summary: `${site.path} does not exist`,
        expected: `${site.path}, one of the app's three version sites (design D18)`,
        actual: "no such file",
        next: `restore ${site.path} from version control`,
      });
    } else if (version === undefined) {
      violations.push({
        code: "ERR_CHECK_VERSION_UNPARSED",
        summary: `${site.path}: no ${site.key} string could be read`,
        expected: `${site.path} parses and holds ${site.key} as a string`,
        actual: "the file does not parse, or the key is absent or not a string",
        next: `restore ${site.key} in ${site.path} (\`just release-prep <version>\` rewrites all three sites)`,
      });
    } else found.push({ path: site.path, version });
  }
  if (violations.length === 0 && new Set(found.map((f) => f.version)).size > 1) {
    violations.push({
      code: "ERR_CHECK_VERSION_DIVERGED",
      summary: "the app's version differs between its three sites",
      expected:
        "one version in Cargo.toml [workspace.package], src-tauri/tauri.conf.json, and package.json (design D18)",
      actual: found.map((f) => `${f.path}: ${f.version}`).join("; "),
      next: "run `just release-prep <version>`, which sets all three and Cargo.lock, rather than editing one by hand",
    });
  }
  return violations;
}

export const check: Check = { name: "version-sites", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
