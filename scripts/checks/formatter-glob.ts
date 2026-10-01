/**
 * The Claude Code edit hook (`cargo xtask format-edited-file`,
 * xtask/src/format_edited_file.rs) formats with Prettier exactly the extensions
 * lefthook.yml's pre-commit `prettier` job checks, so an agent's edit is never left in a
 * shape the commit then refuses, and the hook never rewrites a file the gate ignores.
 * This check fails when the hook's `PRETTIER_EXTENSIONS` and the job's `glob`
 * (`"*.{ts,tsx,…}"`) name different sets.
 *
 * lefthook.yml is read with the `yaml` parser: `pre-commit.jobs[]`, the entry whose
 * `name` is `prettier`, and its `glob` in the `*.{a,b,…}` form. The Rust source is not a
 * structured format: the check reads the string literals inside the one
 * `PRETTIER_EXTENSIONS: &[&str] = &[…];` item.
 *
 *   node scripts/checks/formatter-glob.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING, ERR_CHECK_FORMATTER_GLOB_UNPARSED (lefthook.yml is
 * not YAML, the job's glob is not `*.{…}`, or the hook declares no
 * `PRETTIER_EXTENSIONS` list), ERR_CHECK_FORMATTER_GLOB_MISSING (no `prettier` job under
 * `pre-commit.jobs`), ERR_CHECK_FORMATTER_GLOB_DIVERGED.
 */
import { parse } from "yaml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const LEFTHOOK = "lefthook.yml";
const HOOK = "xtask/src/format_edited_file.rs";
const GLOB = /^\*\.\{([^{}]+)\}$/;
const EXTENSIONS_ITEM = /PRETTIER_EXTENSIONS:\s*&\[&str\]\s*=\s*&\[([^\]]*)\];/;
const STRING_LITERAL = /"([^"\\]*)"/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstLine = (message: string): string => message.split("\n")[0] ?? "";

const unparsed = (summary: string, actual: string): FailureDetails => ({
  code: "ERR_CHECK_FORMATTER_GLOB_UNPARSED",
  summary,
  expected: `${LEFTHOOK} as YAML whose pre-commit \`prettier\` job has \`glob: "*.{ext,ext,…}"\``,
  actual,
  next: `restore the prettier job's glob in ${LEFTHOOK}, or update scripts/checks/formatter-glob.ts's reader in the same change`,
});

function prettierGlob(
  text: string,
): { readonly glob: string } | { readonly failure: FailureDetails } {
  let config: unknown;
  try {
    config = parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: unparsed(`${LEFTHOOK} could not be parsed`, firstLine(message)) };
  }
  const preCommit = isRecord(config) ? config["pre-commit"] : undefined;
  const jobs: unknown = isRecord(preCommit) ? preCommit["jobs"] : undefined;
  const job: unknown = Array.isArray(jobs)
    ? jobs.find((candidate: unknown) => isRecord(candidate) && candidate["name"] === "prettier")
    : undefined;
  if (!isRecord(job)) {
    return {
      failure: {
        code: "ERR_CHECK_FORMATTER_GLOB_MISSING",
        summary: `${LEFTHOOK} has no pre-commit prettier job`,
        expected: `a \`name: prettier\` entry under \`pre-commit.jobs\` in ${LEFTHOOK}`,
        actual: "no such job",
        next: `restore the prettier job in ${LEFTHOOK}; if it was removed on purpose, remove ${HOOK}'s Prettier branch and this check in the same change`,
      },
    };
  }
  const glob = job["glob"];
  if (typeof glob !== "string") {
    return {
      failure: unparsed(
        `${LEFTHOOK}'s prettier job has no string glob`,
        `glob: ${JSON.stringify(glob)}`,
      ),
    };
  }
  return { glob };
}

const inputMissing = (path: string): FailureDetails => ({
  code: "ERR_CHECK_INPUT_MISSING",
  summary: `${path} does not exist`,
  expected: `${path} at the root (it is committed)`,
  actual: "no such file",
  next: `restore ${path} from version control`,
});

/** The extensions the hook's `PRETTIER_EXTENSIONS` item lists, or undefined without one. */
export function hookExtensions(source: string): string[] | undefined {
  const body = EXTENSIONS_ITEM.exec(source)?.[1];
  if (body === undefined) return undefined;
  return [...body.matchAll(STRING_LITERAL)].map((match) => match[1] ?? "");
}

function run(root: string): FailureDetails[] {
  const text = readRepoFile(root, LEFTHOOK);
  if (text === undefined) return [inputMissing(LEFTHOOK)];
  const source = readRepoFile(root, HOOK);
  if (source === undefined) return [inputMissing(HOOK)];
  const extensions = hookExtensions(source);
  if (extensions === undefined) {
    return [
      {
        code: "ERR_CHECK_FORMATTER_GLOB_UNPARSED",
        summary: `${HOOK} declares no PRETTIER_EXTENSIONS list`,
        expected: `a \`PRETTIER_EXTENSIONS: &[&str] = &[".ts", …];\` item in ${HOOK}`,
        actual: "no such item",
        next: `restore the item in ${HOOK}, or update scripts/checks/formatter-glob.ts's reader in the same change`,
      },
    ];
  }
  const found = prettierGlob(text);
  if ("failure" in found) return [found.failure];
  const braces = GLOB.exec(found.glob)?.[1];
  if (braces === undefined) {
    return [
      unparsed(
        `${LEFTHOOK}'s prettier glob is not \`*.{…}\``,
        `glob: ${JSON.stringify(found.glob)}`,
      ),
    ];
  }
  const hooked = [...new Set(braces.split(",").map((extension) => `.${extension.trim()}`))].sort();
  const edited = [...new Set(extensions)].sort();
  const onlyHooked = hooked.filter((extension) => !edited.includes(extension));
  const onlyEdited = edited.filter((extension) => !hooked.includes(extension));
  if (onlyHooked.length === 0 && onlyEdited.length === 0) return [];
  return [
    {
      code: "ERR_CHECK_FORMATTER_GLOB_DIVERGED",
      summary: `${HOOK}'s PRETTIER_EXTENSIONS and ${LEFTHOOK}'s prettier glob name different extensions`,
      expected: "the same extension set in both",
      actual: `only in ${LEFTHOOK}: ${onlyHooked.join(", ") || "none"}; only in PRETTIER_EXTENSIONS: ${onlyEdited.join(", ") || "none"}`,
      next: `move both in one change: edit PRETTIER_EXTENSIONS in ${HOOK} and the prettier job's glob in ${LEFTHOOK} to the same set`,
    },
  ];
}

export const check: Check = { name: "formatter-glob", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
