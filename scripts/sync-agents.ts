/**
 * Mirrors `.agents/skills/` into `.claude/skills/`, byte for byte.
 *
 *   node scripts/sync-agents.ts           make the mirror equal the source (`just agents-sync`)
 *   node scripts/sync-agents.ts --check   report drift, write nothing (`just agents-check`)
 *
 * Skills are authored once, under `.agents/skills/` — the path Codex CLI reads. Claude
 * Code reads only `.claude/skills/`, so the same tree has to exist there too. It is a
 * real, committed copy, never a symlink: a link does not survive a fresh clone on every
 * platform, and Codex follows a linked directory into its subdirectories and registers a
 * nested `references/SKILL.md` as a skill of its own. Both modes ignore `.DS_Store`,
 * which Finder drops into any directory it has shown, and never write outside
 * `.claude/skills/`.
 *
 * Errors: ERR_AGENTS_USAGE, ERR_AGENTS_SOURCE_MISSING, ERR_AGENTS_SYMLINK,
 * ERR_AGENTS_MIRROR_NOT_DIRECTORY, ERR_AGENTS_DRIFT.
 */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

/** Authoring copy: what a human or an agent edits. */
const SOURCE = ".agents/skills";
/** Generated copy: committed, never hand-edited. */
const MIRROR = ".claude/skills";
const IGNORED = new Set([".DS_Store"]);

interface Difference {
  readonly kind: "missing" | "extra" | "differs";
  readonly relative: string;
}

/** `lstat` that answers undefined for a path that does not exist. */
function stat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function symlinkError(label: string, entry: string): ScriptError {
  return new ScriptError({
    code: "ERR_AGENTS_SYMLINK",
    summary: `${label} is a symlink`,
    expected: `real files and directories only under ${SOURCE}/ and ${MIRROR}/, so both copies work from a fresh clone`,
    actual: `a symlink at ${entry}`,
    next: `replace it with a real file or directory (author under ${SOURCE}/), then run \`just agents-sync\``,
  });
}

/** Every regular file under `directory` (absent: none), relative, `/`-separated, sorted. */
function listFiles(directory: string, label: string): string[] {
  const files: string[] = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(current, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      else throw symlinkError(`${label}/${relative}`, `${label}/${relative}`);
    }
  };
  if (stat(directory) !== undefined) visit(directory, "");
  return files.sort();
}

function diffTrees(source: string, mirror: string): Difference[] {
  const mirrorFiles = new Set(listFiles(mirror, MIRROR));
  const differences: Difference[] = [];
  for (const relative of listFiles(source, SOURCE)) {
    if (!mirrorFiles.delete(relative)) differences.push({ kind: "missing", relative });
    else if (!readFileSync(join(source, relative)).equals(readFileSync(join(mirror, relative))))
      differences.push({ kind: "differs", relative });
  }
  for (const relative of mirrorFiles) differences.push({ kind: "extra", relative });
  return differences;
}

/** Remove `directory` and its parents while they are empty, stopping at `stopAt`. */
function pruneEmpty(directory: string, stopAt: string): void {
  let current = directory;
  while (current !== stopAt && readdirSync(current).length === 0) {
    rmSync(current, { recursive: true });
    current = dirname(current);
  }
}

function syncTrees(source: string, mirror: string, differences: readonly Difference[]): void {
  mkdirSync(mirror, { recursive: true });
  // Deletions first: a path that changed kind (file <-> directory) is one `extra` and
  // one `missing`, and copying first would hit the stale entry.
  for (const { kind, relative } of differences) {
    if (kind !== "extra") continue;
    const target = join(mirror, relative);
    rmSync(target);
    pruneEmpty(dirname(target), mirror);
  }
  for (const { kind, relative } of differences) {
    if (kind === "extra") continue;
    const target = join(mirror, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, relative), target);
  }
}

export function main(context: ScriptContext): void {
  const { argv, root, log } = context;
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    throw new ScriptError({
      code: "ERR_AGENTS_USAGE",
      summary: `unknown argument(s): ${unknown.join(" ")}`,
      expected: "no arguments, or --check",
      actual: `arguments: ${argv.join(" ")}`,
      next: "run `just agents-sync` or `just agents-check`",
    });
  }
  const check = argv.includes("--check");
  const source = join(root, SOURCE);
  const mirror = join(root, MIRROR);

  const sourceStat = stat(source);
  if (sourceStat?.isSymbolicLink() === true) throw symlinkError(SOURCE, SOURCE);
  if (sourceStat?.isDirectory() !== true) {
    throw new ScriptError({
      code: "ERR_AGENTS_SOURCE_MISSING",
      summary: `${SOURCE}/ does not exist`,
      expected: `skills authored under ${SOURCE}/`,
      actual: sourceStat === undefined ? `no such path: ${SOURCE}` : `${SOURCE} is not a directory`,
      next: `restore ${SOURCE}/ from version control, then run \`just agents-sync\``,
    });
  }
  const mirrorStat = stat(mirror);
  if (mirrorStat?.isSymbolicLink() === true) throw symlinkError(MIRROR, MIRROR);
  if (mirrorStat !== undefined && !mirrorStat.isDirectory()) {
    throw new ScriptError({
      code: "ERR_AGENTS_MIRROR_NOT_DIRECTORY",
      summary: `${MIRROR} is not a directory`,
      expected: `${MIRROR}/ to be a real directory holding a copy of ${SOURCE}/`,
      actual: `${MIRROR} is a file`,
      next: `remove ${MIRROR} (\`git rm ${MIRROR}\`), then run \`just agents-sync\``,
    });
  }

  const differences = diffTrees(source, mirror);
  if (check) {
    if (differences.length > 0) {
      throw new ScriptError({
        code: "ERR_AGENTS_DRIFT",
        summary: `${MIRROR}/ is not a copy of ${SOURCE}/`,
        expected: `${MIRROR}/ byte-identical to ${SOURCE}/ (ignoring .DS_Store)`,
        actual: differences
          .map(({ kind, relative }) => `${kind}: ${MIRROR}/${relative}`)
          .join("; "),
        next: "run `just agents-sync` and commit both trees",
      });
    }
    log(`agents:check: ${MIRROR}/ is in sync.`);
    return;
  }
  if (differences.length === 0) {
    log(`agents:sync: ${MIRROR}/ was already in sync.`);
    return;
  }
  syncTrees(source, mirror, differences);
  log(`agents:sync: updated ${String(differences.length)} path(s) in ${MIRROR}/.`);
  for (const { kind, relative } of differences) log(`- ${kind}: ${relative}`);
}

if (import.meta.main) await runScript(main);
