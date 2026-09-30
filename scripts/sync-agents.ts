/**
 * Mirrors `.agents/skills/` into `.claude/skills/`, byte for byte and executable bit for
 * executable bit (the two things git records about a file).
 *
 *   node scripts/sync-agents.ts           make the mirror equal the source (`just agents-sync`)
 *   node scripts/sync-agents.ts --check   report drift, write nothing (`just agents-check`)
 *   node scripts/sync-agents.ts --check --staged
 *                                         report drift in the git index (the pre-commit hook)
 *
 * Skills are authored once, under `.agents/skills/` — the path Codex CLI reads. Claude
 * Code reads only `.claude/skills/`, so the same tree has to exist there too. It is a
 * real, committed copy, never a symlink: a link does not survive a fresh clone on every
 * platform, and Codex follows a linked directory into its subdirectories and registers a
 * nested `references/SKILL.md` as a skill of its own. Both modes ignore `.DS_Store`,
 * which Finder drops into any directory it has shown, and Python bytecode (`__pycache__/`,
 * `*.pyc`), which a skill's bundled tests write when run directly; both are gitignored.
 * They never write outside `.claude/skills/`.
 *
 * `--staged` judges what the commit will contain rather than the working tree: it compares
 * the blob id and mode the index records under each tree, so staging an edited source
 * without its synced mirror (or the reverse) is drift even when both working copies match.
 * An intent-to-add entry (`git add -N`) is skipped: the commit will not contain it. It
 * keeps GIT_INDEX_FILE, which `git commit -- <path>` points at a temporary index, and drops
 * every other GIT_* variable. Outside a git work tree it refuses (ERR_AGENTS_NOT_A_REPO);
 * the working-tree modes need no git.
 *
 * Errors: ERR_AGENTS_USAGE, ERR_AGENTS_SOURCE_MISSING, ERR_AGENTS_SYMLINK,
 * ERR_AGENTS_MIRROR_NOT_DIRECTORY, ERR_AGENTS_NOT_A_REPO, ERR_AGENTS_INDEX_UNREADABLE,
 * ERR_AGENTS_SOURCE_NOT_STAGED, ERR_AGENTS_DRIFT.
 */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { stagedGuardEnv } from "./lib/git-env.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

/** Authoring copy: what a human or an agent edits. */
const SOURCE = ".agents/skills";
/** Generated copy: committed, never hand-edited. */
const MIRROR = ".claude/skills";
const IGNORED = new Set([".DS_Store", "__pycache__"]);
/** Whether a file or directory name is local debris neither tree carries. */
const ignored = (name: string): boolean => IGNORED.has(name) || name.endsWith(".pyc");
const SYMLINK_MODE = "120000";

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
      if (ignored(entry.name)) continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(current, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      else throw symlinkError(`${label}/${relative}`, `${label}/${relative}`);
    }
  };
  if (stat(directory) !== undefined) visit(directory, "");
  return files.sort();
}

/** Whether git would record the file as executable (100755): the owner's execute bit. */
const executable = (path: string): boolean => (statSync(path).mode & 0o100) !== 0;

function sameFile(a: string, b: string): boolean {
  return executable(a) === executable(b) && readFileSync(a).equals(readFileSync(b));
}

function diffTrees(source: string, mirror: string): Difference[] {
  const mirrorFiles = new Set(listFiles(mirror, MIRROR));
  const differences: Difference[] = [];
  for (const relative of listFiles(source, SOURCE)) {
    if (!mirrorFiles.delete(relative)) differences.push({ kind: "missing", relative });
    else if (!sameFile(join(source, relative), join(mirror, relative)))
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

function sourceNotDirectory(actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_AGENTS_SOURCE_MISSING",
    summary: `${SOURCE}/ does not exist`,
    expected: `skills authored under ${SOURCE}/`,
    actual,
    next: `restore ${SOURCE}/ from version control, then run \`just agents-sync\``,
  });
}

function mirrorNotDirectory(): ScriptError {
  return new ScriptError({
    code: "ERR_AGENTS_MIRROR_NOT_DIRECTORY",
    summary: `${MIRROR} is not a directory`,
    expected: `${MIRROR}/ to be a real directory holding a copy of ${SOURCE}/`,
    actual: `${MIRROR} is a file`,
    next: `remove ${MIRROR} (\`git rm ${MIRROR}\`), then run \`just agents-sync\``,
  });
}

function driftError(differences: readonly Difference[], where: string): ScriptError {
  return new ScriptError({
    code: "ERR_AGENTS_DRIFT",
    summary: `${MIRROR}/ is not a copy of ${SOURCE}/${where}`,
    expected: `${MIRROR}/ byte-identical to ${SOURCE}/ (ignoring .DS_Store)`,
    actual: differences.map(({ kind, relative }) => `${kind}: ${MIRROR}/${relative}`).join("; "),
    next: "run `just agents-sync` and stage both trees (`git add .agents/skills .claude/skills`)",
  });
}

/** One stage-0 index entry under a skills tree: its mode and blob id, by relative path. */
type IndexTree = Map<string, { readonly mode: string; readonly blob: string }>;

/** The index entries under SOURCE and MIRROR, read with `git ls-files --stage -z`. */
function readIndex(context: ScriptContext): { source: IndexTree; mirror: IndexTree } {
  const env = stagedGuardEnv(context.env);
  const git = (...args: string[]) => context.run("git", args, { cwd: context.root, env });
  if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") {
    throw new ScriptError({
      code: "ERR_AGENTS_NOT_A_REPO",
      summary: "--staged needs a git work tree",
      expected: "to run from inside the repository whose index is being committed",
      actual: `\`git rev-parse --is-inside-work-tree\` did not print true in ${context.root}`,
      next: "run `just agents-check` to compare the working trees instead",
    });
  }
  const read = (...args: string[]): string => {
    const result = git(...args, "-z", "--", SOURCE, MIRROR);
    if (result.status === 0) return result.stdout;
    throw new ScriptError({
      code: "ERR_AGENTS_INDEX_UNREADABLE",
      summary: "could not list the staged skills",
      expected: `\`git ${args.join(" ")} -- ${SOURCE} ${MIRROR}\` to exit 0`,
      actual: result.stderr.trim() || `exit ${String(result.status)}`,
      next: "check `git status` and the index, then retry the commit",
    });
  };
  const listed = read("ls-files", "--stage");
  // Comparing the work tree with the index, only an intent-to-add entry can be "added":
  // a file the index lacks is not listed at all. Its placeholder blob is not committed.
  // diff-files is plumbing: unlike `git diff`, it never rewrites the index it reads.
  const intentToAdd = new Set(read("diff-files", "--name-only", "--diff-filter=A").split("\0"));
  const trees: { source: IndexTree; mirror: IndexTree } = { source: new Map(), mirror: new Map() };
  for (const record of listed.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode = "", blob = "", stage = ""] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    // A conflicted path has stages 1-3 and no commit can be made until it is resolved.
    if (stage !== "0" || intentToAdd.has(path)) continue;
    for (const [label, tree] of [
      [SOURCE, trees.source],
      [MIRROR, trees.mirror],
    ] as const) {
      if (path === label) {
        if (mode === SYMLINK_MODE) throw symlinkError(label, label);
        if (label === SOURCE) throw sourceNotDirectory(`${SOURCE} is staged as a file`);
        throw mirrorNotDirectory();
      }
      if (!path.startsWith(`${label}/`)) continue;
      const relative = path.slice(label.length + 1);
      if (relative.split("/").some(ignored)) continue;
      if (mode === SYMLINK_MODE) throw symlinkError(path, path);
      tree.set(relative, { mode, blob });
    }
  }
  return trees;
}

/**
 * Drift between the staged trees, compared by mode and blob id (equal ids are equal
 * bytes), so an executable bit staged on one side only is drift too.
 */
function diffIndex(source: IndexTree, mirror: IndexTree): Difference[] {
  const differences: Difference[] = [];
  for (const [relative, { mode, blob }] of [...source].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const copy = mirror.get(relative);
    if (copy === undefined) differences.push({ kind: "missing", relative });
    else if (copy.blob !== blob || copy.mode !== mode)
      differences.push({ kind: "differs", relative });
  }
  for (const relative of [...mirror.keys()].sort()) {
    if (!source.has(relative)) differences.push({ kind: "extra", relative });
  }
  return differences;
}

function checkStaged(context: ScriptContext): void {
  const { source, mirror } = readIndex(context);
  if (source.size === 0) {
    throw new ScriptError({
      code: "ERR_AGENTS_SOURCE_NOT_STAGED",
      summary: `the index holds no skill under ${SOURCE}/`,
      expected: `the skills tracked under ${SOURCE}/ to stay in the commit`,
      actual: `nothing staged under ${SOURCE}/ (the commit would drop the authored skills)`,
      next: `stage the skills (\`git add ${SOURCE} ${MIRROR}\`), or \`git restore --staged ${SOURCE}\` if the removal was unintended`,
    });
  }
  const differences = diffIndex(source, mirror);
  if (differences.length > 0) throw driftError(differences, " in the index");
  context.log(`agents:check: the staged ${MIRROR}/ is in sync.`);
}

export function main(context: ScriptContext): void {
  const { argv, root, log } = context;
  const unknown = argv.filter((argument) => argument !== "--check" && argument !== "--staged");
  const check = argv.includes("--check");
  const staged = argv.includes("--staged");
  if (unknown.length > 0 || (staged && !check)) {
    throw new ScriptError({
      code: "ERR_AGENTS_USAGE",
      summary:
        unknown.length > 0
          ? `unknown argument(s): ${unknown.join(" ")}`
          : "--staged only works with --check",
      expected: "no arguments, --check, or --check --staged",
      actual: `arguments: ${argv.join(" ")}`,
      next: "run `just agents-sync` or `just agents-check`",
    });
  }
  if (staged) {
    checkStaged(context);
    return;
  }
  const source = join(root, SOURCE);
  const mirror = join(root, MIRROR);

  const sourceStat = stat(source);
  if (sourceStat?.isSymbolicLink() === true) throw symlinkError(SOURCE, SOURCE);
  if (sourceStat?.isDirectory() !== true) {
    throw sourceNotDirectory(
      sourceStat === undefined ? `no such path: ${SOURCE}` : `${SOURCE} is not a directory`,
    );
  }
  const mirrorStat = stat(mirror);
  if (mirrorStat?.isSymbolicLink() === true) throw symlinkError(MIRROR, MIRROR);
  if (mirrorStat !== undefined && !mirrorStat.isDirectory()) throw mirrorNotDirectory();

  const differences = diffTrees(source, mirror);
  if (check) {
    if (differences.length > 0) throw driftError(differences, "");
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
