/**
 * `@types/node` follows the Node that runs the scripts: the major of the `@types/node`
 * that pnpm-lock.yaml's root importer resolves equals the major of `mise.toml`'s `node`
 * pin, so the scripts type-check against the APIs of the runtime that executes them.
 * Renovate bumps `mise.toml` and Dependabot bumps `@types/node`, each in its own pull
 * request, and `tsc` usually still passes on the other major, so nothing else notices
 * when one moves alone. A Node major moves both together (the `merging-dependency-prs`
 * skill).
 *
 * mise.toml is read with smol-toml (`[tools] node = "24.21.0"`, or the table form
 * `node = { version = "24.21.0" }`); pnpm-lock.yaml with yaml, every document, since
 * pnpm writes the package manager's own lock as a first document. A resolved npm
 * version's peer suffix (`24.13.6(…)`) is dropped.
 *
 *   node scripts/checks/node-types-major.ts [--root DIR]
 *
 * Git work tree: not required.
 *
 * Errors: ERR_CHECK_INPUT_MISSING, ERR_CHECK_NODE_MAJOR_UNPARSED (a file or a version
 * could not be read), ERR_CHECK_NODE_MAJOR_MISSING (no `node` in mise.toml's [tools], or
 * no `@types/node` in the root importer), ERR_CHECK_NODE_MAJOR_DIVERGED.
 */
import { parse as parseToml } from "smol-toml";
import { parseAllDocuments } from "yaml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const MISE = "mise.toml";
const PNPM_LOCK = "pnpm-lock.yaml";
const TYPES = "@types/node";
const MAJOR = /^(\d+)(?:\.\d+){0,2}(?:[-+][\w.-]+)?$/;
const GROUPS = ["dependencies", "devDependencies", "optionalDependencies"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstLine = (message: string): string => message.split("\n")[0] ?? "";

const unparsed = (summary: string, actual: string): FailureDetails => ({
  code: "ERR_CHECK_NODE_MAJOR_UNPARSED",
  summary,
  expected: `${MISE} as TOML with an exact \`[tools] node\` version, and ${PNPM_LOCK} as YAML whose root importer resolves ${TYPES} to a release number`,
  actual,
  next: `restore the pin (${MISE}) or regenerate the lockfile (\`pnpm install\`), or update scripts/checks/node-types-major.ts's reader in the same change`,
});

const missing = (what: string, next: string): FailureDetails => ({
  code: "ERR_CHECK_NODE_MAJOR_MISSING",
  summary: `${what} is not pinned`,
  expected: `node in ${MISE}'s [tools], and ${TYPES} in ${PNPM_LOCK}'s root importer`,
  actual: `no entry for ${what}`,
  next,
});

type Found = { readonly version: string } | { readonly failure: FailureDetails };

/** `[tools] node` in mise.toml: a version string, or a table's `version`. */
function miseNode(text: string): Found {
  let config: unknown;
  try {
    config = parseToml(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: unparsed(`${MISE} could not be parsed`, firstLine(message)) };
  }
  const tools = isRecord(config) ? config["tools"] : undefined;
  const node = isRecord(tools) ? tools["node"] : undefined;
  if (node === undefined) {
    return {
      failure: missing(
        `node in ${MISE}'s [tools]`,
        `pin node in ${MISE} (\`node = "<exact version>"\`; .claude/rules/project.md › Tool Pinning), then \`mise install\``,
      ),
    };
  }
  const version = isRecord(node) ? node["version"] : node;
  if (typeof version !== "string") {
    return {
      failure: unparsed(
        `${MISE}'s node pin is not a version string`,
        `node = ${JSON.stringify(node)}`,
      ),
    };
  }
  return { version };
}

/** The version of `@types/node` pnpm-lock.yaml's root importer resolves. */
function lockedTypes(text: string): Found {
  const documents = parseAllDocuments(text);
  const broken = documents.flatMap((doc) => doc.errors);
  const [error] = broken;
  if (error !== undefined) {
    return { failure: unparsed(`${PNPM_LOCK} could not be parsed`, firstLine(error.message)) };
  }
  for (const doc of documents) {
    const json: unknown = doc.toJS();
    const importers = isRecord(json) ? json["importers"] : undefined;
    const root = isRecord(importers) ? importers["."] : undefined;
    if (!isRecord(root)) continue;
    for (const group of GROUPS) {
      const deps = root[group];
      const entry = isRecord(deps) ? deps[TYPES] : undefined;
      if (entry === undefined) continue;
      const version = isRecord(entry) ? entry["version"] : undefined;
      if (typeof version !== "string") {
        return {
          failure: unparsed(
            `${PNPM_LOCK}'s ${TYPES} entry has no version string`,
            `${TYPES}: ${JSON.stringify(entry)}`,
          ),
        };
      }
      return { version: version.replace(/\(.*$/, "") };
    }
  }
  return {
    failure: missing(
      `${TYPES} in ${PNPM_LOCK}'s root importer`,
      `add it on mise's Node major (\`pnpm add -D ${TYPES}@^<major>\`), and commit package.json with pnpm-lock.yaml`,
    ),
  };
}

function run(root: string): FailureDetails[] {
  const absent = [MISE, PNPM_LOCK].filter((path) => readRepoFile(root, path) === undefined);
  if (absent.length > 0) {
    return absent.map((path) => ({
      code: "ERR_CHECK_INPUT_MISSING",
      summary: `${path} does not exist`,
      expected: `${path} at the root (it is committed)`,
      actual: "no such file",
      next:
        path === MISE
          ? `restore ${MISE} from version control`
          : "run `pnpm install` and commit pnpm-lock.yaml",
    }));
  }
  const node = miseNode(readRepoFile(root, MISE) ?? "");
  const types = lockedTypes(readRepoFile(root, PNPM_LOCK) ?? "");
  if (!("version" in node) || !("version" in types)) {
    return [node, types].flatMap((found) => ("failure" in found ? [found.failure] : []));
  }

  const nodeMajor = MAJOR.exec(node.version)?.[1];
  const typesMajor = MAJOR.exec(types.version)?.[1];
  const violations: FailureDetails[] = [];
  if (nodeMajor === undefined) {
    violations.push(
      unparsed(`${MISE}'s node pin \`${node.version}\` is not a version number`, node.version),
    );
  }
  if (typesMajor === undefined) {
    violations.push(
      unparsed(
        `${TYPES}'s locked version \`${types.version}\` is not a release number`,
        types.version,
      ),
    );
  }
  if (nodeMajor !== undefined && typesMajor !== undefined && nodeMajor !== typesMajor) {
    violations.push({
      code: "ERR_CHECK_NODE_MAJOR_DIVERGED",
      summary: `${TYPES} is on major ${typesMajor}, but ${MISE} runs Node ${nodeMajor}`,
      expected: `the ${TYPES} major in ${PNPM_LOCK} equal to the node major in ${MISE}`,
      actual: `${MISE} node ${node.version}; ${PNPM_LOCK} ${TYPES} ${types.version}`,
      next: `move both in one change (the merging-dependency-prs skill): \`pnpm add -D ${TYPES}@^${nodeMajor}\` to follow ${MISE}, or bump ${MISE}'s node to a ${typesMajor}.x release and run \`mise install\``,
    });
  }
  return violations;
}

export const check: Check = { name: "node-types-major", run };

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
