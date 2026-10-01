/**
 * pnpm is pinned in two places on purpose, and they name the same version: mise.toml
 * installs it (Node 25 stopped bundling corepack, so nothing else puts pnpm on PATH),
 * and package.json's `packageManager` is what pnpm itself reads to refuse running as
 * another version. Renovate bumps mise.toml's pin; this check fails the pull request
 * that moves one without the other (.claude/rules/project.md › Tool Pinning).
 *
 * mise.toml is read with smol-toml: the one `[tools]` entry named `pnpm` or
 * `<backend>:pnpm/pnpm` (`"aqua:pnpm/pnpm" = "12.6.0"`, or the table form
 * `{ version = "12.6.0" }`); package.json with JSON.parse (`"packageManager":
 * "pnpm@12.6.0"`, an optional `+sha…` hash suffix dropped).
 *
 *   node scripts/checks/pnpm-pin.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING, ERR_CHECK_PNPM_PIN_UNPARSED (a file or a version
 * could not be read), ERR_CHECK_PNPM_PIN_MISSING (no pnpm in mise.toml's [tools], or no
 * pnpm `packageManager` in package.json), ERR_CHECK_PNPM_PIN_DIVERGED.
 */
import { parse as parseToml } from "smol-toml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const MISE = "mise.toml";
const PACKAGE = "package.json";
const TOOL = /^(?:pnpm|[\w-]+:pnpm\/pnpm)$/;
const MANAGER = /^pnpm@(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\+[\w.-]+)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstLine = (message: string): string => message.split("\n")[0] ?? "";

const unparsed = (summary: string, actual: string): FailureDetails => ({
  code: "ERR_CHECK_PNPM_PIN_UNPARSED",
  summary,
  expected: `${MISE} as TOML with an exact \`[tools]\` pnpm version, and ${PACKAGE} as JSON whose \`packageManager\` is \`pnpm@<exact version>\``,
  actual,
  next: `restore the pin in ${MISE} or ${PACKAGE}, or update scripts/checks/pnpm-pin.ts's reader in the same change`,
});

const missing = (what: string, next: string): FailureDetails => ({
  code: "ERR_CHECK_PNPM_PIN_MISSING",
  summary: `${what} is not pinned`,
  expected: `pnpm in ${MISE}'s [tools] (\`"aqua:pnpm/pnpm" = "<version>"\`), and \`"packageManager": "pnpm@<version>"\` in ${PACKAGE}`,
  actual: `no entry for ${what}`,
  next,
});

type Found = { readonly version: string } | { readonly failure: FailureDetails };

function misePnpm(text: string): Found {
  let config: unknown;
  try {
    config = parseToml(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: unparsed(`${MISE} could not be parsed`, firstLine(message)) };
  }
  const tools = isRecord(config) ? config["tools"] : undefined;
  const entry = isRecord(tools)
    ? Object.entries(tools).find(([name]) => TOOL.test(name))
    : undefined;
  if (entry === undefined) {
    return {
      failure: missing(
        `pnpm in ${MISE}'s [tools]`,
        `pin pnpm in ${MISE} at the version ${PACKAGE}'s packageManager names (\`"aqua:pnpm/pnpm" = "<version>"\`), then \`mise install\``,
      ),
    };
  }
  const [name, pin] = entry;
  const version = isRecord(pin) ? pin["version"] : pin;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    return {
      failure: unparsed(
        `${MISE}'s pnpm pin is not an exact version`,
        `${name} = ${JSON.stringify(pin)}`,
      ),
    };
  }
  return { version };
}

function packageManager(text: string): Found {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: unparsed(`${PACKAGE} could not be parsed`, firstLine(message)) };
  }
  const field = isRecord(manifest) ? manifest["packageManager"] : undefined;
  if (field === undefined) {
    return {
      failure: missing(
        `packageManager in ${PACKAGE}`,
        `set \`"packageManager": "pnpm@<version>"\` in ${PACKAGE} to the version ${MISE} pins`,
      ),
    };
  }
  const version = typeof field === "string" ? MANAGER.exec(field)?.[1] : undefined;
  if (version === undefined) {
    return {
      failure: unparsed(
        `${PACKAGE}'s packageManager is not \`pnpm@<exact version>\``,
        `packageManager: ${JSON.stringify(field)}`,
      ),
    };
  }
  return { version };
}

function run(root: string): FailureDetails[] {
  const absent = [MISE, PACKAGE].filter((path) => readRepoFile(root, path) === undefined);
  if (absent.length > 0) {
    return absent.map((path) => ({
      code: "ERR_CHECK_INPUT_MISSING",
      summary: `${path} does not exist`,
      expected: `${path} at the root (it is committed)`,
      actual: "no such file",
      next: `restore ${path} from version control`,
    }));
  }
  const mise = misePnpm(readRepoFile(root, MISE) ?? "");
  const manager = packageManager(readRepoFile(root, PACKAGE) ?? "");
  if (!("version" in mise) || !("version" in manager)) {
    return [mise, manager].flatMap((found) => ("failure" in found ? [found.failure] : []));
  }
  if (mise.version === manager.version) return [];
  return [
    {
      code: "ERR_CHECK_PNPM_PIN_DIVERGED",
      summary: `${MISE} installs pnpm ${mise.version}, but ${PACKAGE}'s packageManager names ${manager.version}`,
      expected: `the same pnpm version in ${MISE} and ${PACKAGE}'s packageManager`,
      actual: `${MISE} pnpm ${mise.version}; ${PACKAGE} pnpm@${manager.version}`,
      next: `move both in one change: set the other to the version the bot's pull request chose, then \`mise install\` and \`pnpm install --frozen-lockfile\``,
    },
  ];
}

export const check: Check = { name: "pnpm-pin", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
