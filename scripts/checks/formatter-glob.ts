/**
 * The Claude Code edit hook (scripts/format-edited-file.ts) formats with Prettier
 * exactly the extensions lefthook.yml's pre-commit `prettier` job checks, so an agent's
 * edit is never left in a shape the commit then refuses, and the hook never rewrites a
 * file the gate ignores. This check fails when `PRETTIER_EXTENSIONS` and the job's
 * `glob` (`"*.{ts,tsx,…}"`) name different sets.
 *
 * lefthook.yml is read with the `yaml` parser: `pre-commit.jobs[]`, the entry whose
 * `name` is `prettier`, and its `glob` in the `*.{a,b,…}` form.
 *
 *   node scripts/checks/formatter-glob.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING, ERR_CHECK_FORMATTER_GLOB_UNPARSED (lefthook.yml is
 * not YAML, or the job's glob is not `*.{…}`), ERR_CHECK_FORMATTER_GLOB_MISSING (no
 * `prettier` job under `pre-commit.jobs`), ERR_CHECK_FORMATTER_GLOB_DIVERGED.
 */
import { parse } from "yaml";

import { PRETTIER_EXTENSIONS } from "../format-edited-file.ts";
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const LEFTHOOK = "lefthook.yml";
const HOOK = "scripts/format-edited-file.ts";
const GLOB = /^\*\.\{([^{}]+)\}$/;

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

function run(root: string): FailureDetails[] {
  const text = readRepoFile(root, LEFTHOOK);
  if (text === undefined) {
    return [
      {
        code: "ERR_CHECK_INPUT_MISSING",
        summary: `${LEFTHOOK} does not exist`,
        expected: `${LEFTHOOK} at the root (it is committed)`,
        actual: "no such file",
        next: `restore ${LEFTHOOK} from version control`,
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
  const edited = [...new Set(PRETTIER_EXTENSIONS)].sort();
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
