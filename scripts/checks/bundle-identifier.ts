/**
 * The bundle identifier is one value in three places: `identifier` in
 * `src-tauri/tauri.conf.json` (what macOS knows the app by), `BUNDLE_IDENTIFIER` in
 * `crates/myapp-platform/src/paths.rs` (which names the app's data and log
 * directories), and the justfile's `bundle_id` variable (which `just logs` and
 * `just reset-permissions` use). A rename that misses one leaves the app writing where the tools never look.
 *
 * tauri.conf.json is read with JSON.parse; the Rust const
 * (`pub const BUNDLE_IDENTIFIER: &str = "…";`) and the justfile assignment
 * (`bundle_id := "…"`, either quote) are read as text.
 *
 *   node scripts/checks/bundle-identifier.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING, ERR_CHECK_BUNDLE_ID_UNPARSED,
 * ERR_CHECK_BUNDLE_ID_DIVERGED.
 */
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

interface Site {
  readonly path: string;
  /** What the site looks like, for the Expected line. */
  readonly shape: string;
  readonly read: (text: string) => string | undefined;
}

function jsonIdentifier(text: string): string | undefined {
  try {
    const json: unknown = JSON.parse(text);
    const value =
      typeof json === "object" && json !== null
        ? (json as Record<string, unknown>)["identifier"]
        : undefined;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

const SITES: readonly Site[] = [
  { path: "src-tauri/tauri.conf.json", shape: '"identifier": "…"', read: jsonIdentifier },
  {
    path: "crates/myapp-platform/src/paths.rs",
    shape: 'pub const BUNDLE_IDENTIFIER: &str = "…";',
    read: (text) =>
      /\bconst\s+BUNDLE_IDENTIFIER\s*:\s*&\s*(?:'static\s+)?str\s*=\s*"([^"\\]*)"\s*;/.exec(
        text,
      )?.[1],
  },
  {
    path: "justfile",
    shape: 'bundle_id := "…"',
    read: (text) => /^bundle_id\s*:=\s*(["'])(.*?)\1\s*(?:#.*)?$/m.exec(text)?.[2],
  },
];

function run(root: string): FailureDetails[] {
  const violations: FailureDetails[] = [];
  const found: { path: string; value: string }[] = [];
  for (const site of SITES) {
    const text = readRepoFile(root, site.path);
    const value = text === undefined ? undefined : site.read(text);
    if (text === undefined) {
      violations.push({
        code: "ERR_CHECK_INPUT_MISSING",
        summary: `${site.path} does not exist`,
        expected: `${site.path}, one of the bundle identifier's three sites`,
        actual: "no such file",
        next: `restore ${site.path} from version control, or update scripts/checks/bundle-identifier.ts if it moved`,
      });
    } else if (value === undefined) {
      violations.push({
        code: "ERR_CHECK_BUNDLE_ID_UNPARSED",
        summary: `${site.path}: no bundle identifier could be read`,
        expected: `\`${site.shape}\` in ${site.path}`,
        actual: "no such line, or not a string",
        next: "restore the identifier in the shape Expected names, or update scripts/checks/bundle-identifier.ts's reader in the same change",
      });
    } else found.push({ path: site.path, value });
  }
  if (violations.length === 0 && new Set(found.map((f) => f.value)).size > 1) {
    violations.push({
      code: "ERR_CHECK_BUNDLE_ID_DIVERGED",
      summary: "the bundle identifier differs between its three sites",
      expected:
        "one identifier in tauri.conf.json, BUNDLE_IDENTIFIER, and the justfile's bundle_id",
      actual: found.map((f) => `${f.path}: ${f.value}`).join("; "),
      next: "set all three to the same value in one commit (the bootstrap rewrites all three for a new app); changing an app's identifier moves its data and log directories and resets its TCC grants, an ADR decision",
    });
  }
  return violations;
}

export const check: Check = { name: "bundle-identifier", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
