/**
 * Removes temporary directories that are known to be safe to delete, so an agent never
 * needs a raw `rm -rf`:
 *
 * - every `verify-bootstrap-*` directory directly under the OS temp directory (what
 *   `scripts/verify-bootstrap.ts` leaves behind when a run is interrupted);
 * - each Claude Code session's `scratchpad` for this checkout,
 *   `<claude-base>/<slug>/<session>/scratchpad`, where `<slug>` is the checkout's absolute
 *   path with every non-alphanumeric character replaced by `-` — only when nothing under
 *   that session directory changed in the last 24 hours, so a live session is untouched.
 *
 *   node scripts/prune-temp.ts [--dry-run] [--temp-dir DIR] [--claude-base DIR] [--now MS]
 *
 * `--temp-dir` defaults to `TMPDIR` (else `os.tmpdir()`), `--claude-base` to
 * `/private/tmp/claude-<uid>`, and `--now` (epoch milliseconds) to the current time.
 * Symlinks are never followed: a matching entry that does not resolve inside its expected
 * parent is refused. Prints each path removed (or that would be, with `--dry-run`), or
 * `nothing to prune`. No git work tree needed.
 *
 * Errors: ERR_PRUNE_USAGE, ERR_PRUNE_ESCAPES_PARENT, ERR_PRUNE_REMOVE_FAILED.
 */
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

/** The prefix `scripts/verify-bootstrap.ts` gives its `mkdtemp` directories. */
export const BOOTSTRAP_PREFIX = "verify-bootstrap-";
/** How long a session directory must sit untouched before its scratchpad is pruned. */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

const USAGE =
  "node scripts/prune-temp.ts [--dry-run] [--temp-dir DIR] [--claude-base DIR] [--now MS]";

interface Options {
  readonly dryRun: boolean;
  readonly tempDir: string | undefined;
  readonly claudeBase: string | undefined;
  readonly now: number | undefined;
}

function usage(actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_PRUNE_USAGE",
    summary: "unrecognised arguments",
    expected: USAGE,
    actual,
    next: "rerun with the arguments above, e.g. `just prune-temp --dry-run`",
  });
}

function parseArgs(argv: readonly string[]): Options {
  let dryRun = false;
  let tempDir: string | undefined;
  let claudeBase: string | undefined;
  let now: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || !["--temp-dir", "--claude-base", "--now"].includes(arg ?? "")) {
      throw usage(argv.join(" "));
    }
    i += 1;
    if (arg === "--temp-dir") tempDir = value;
    else if (arg === "--claude-base") claudeBase = value;
    else {
      now = Number(value);
      if (!Number.isFinite(now)) throw usage(`--now ${value} is not epoch milliseconds`);
    }
  }
  return { dryRun, tempDir, claudeBase, now };
}

/** Claude Code's directory name for a checkout: every non-alphanumeric character becomes `-`. */
export function claudeSlug(checkout: string): string {
  return checkout.replace(/[^A-Za-z0-9]/g, "-");
}

/** A real directory or a symlink (which {@link confined} then refuses); false for anything else. */
const candidate = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    return false;
  }
};

/** Refuse a path that does not resolve to exactly `<parent>/<name>` (a symlink out, say). */
function confined(parent: string, name: string): string {
  const path = join(parent, name);
  const real = realpathSync(path);
  const expected = join(realpathSync(parent), name);
  if (real !== expected || lstatSync(path).isSymbolicLink()) {
    throw new ScriptError({
      code: "ERR_PRUNE_ESCAPES_PARENT",
      summary: `${path} does not resolve inside ${parent}`,
      expected: `a real directory at ${expected}`,
      actual: `it resolves to ${real}`,
      next: `inspect ${path} by hand; prune-temp never follows a symlink out of its parent`,
    });
  }
  return path;
}

/** The newest mtime anywhere under `path`, never following a symlink. */
function newestMtime(path: string): number {
  const stat = lstatSync(path);
  let newest = stat.mtimeMs;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      newest = Math.max(newest, newestMtime(join(path, entry)));
    }
  }
  return newest;
}

function bootstrapDirs(tempDir: string): string[] {
  if (!candidate(tempDir)) return [];
  return readdirSync(tempDir)
    .filter((name) => name.startsWith(BOOTSTRAP_PREFIX) && candidate(join(tempDir, name)))
    .sort()
    .map((name) => confined(tempDir, name));
}

function staleScratchpads(claudeBase: string, checkout: string, now: number): string[] {
  const slug = claudeSlug(checkout);
  if (!candidate(join(claudeBase, slug))) return [];
  const project = confined(claudeBase, slug);
  const found: string[] = [];
  for (const session of readdirSync(project).sort()) {
    if (!candidate(join(project, session))) continue;
    const sessionDir = confined(project, session);
    if (!candidate(join(sessionDir, "scratchpad"))) continue;
    const scratchpad = confined(sessionDir, "scratchpad");
    if (now - newestMtime(sessionDir) < SESSION_IDLE_MS) continue;
    found.push(scratchpad);
  }
  return found;
}

function defaultClaudeBase(): string | undefined {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : `/private/tmp/claude-${String(uid)}`;
}

export function main(context: ScriptContext): void {
  const options = parseArgs(context.argv);
  const tempDir = resolve(options.tempDir ?? context.env["TMPDIR"] ?? tmpdir());
  const claudeBase = options.claudeBase ?? defaultClaudeBase();
  const now = options.now ?? Date.now();

  const targets = [
    ...bootstrapDirs(tempDir),
    ...(claudeBase === undefined
      ? []
      : staleScratchpads(resolve(claudeBase), resolve(context.root), now)),
  ];
  if (targets.length === 0) {
    context.log("prune-temp: nothing to prune");
    return;
  }
  for (const target of targets) {
    if (!options.dryRun) {
      try {
        rmSync(target, { recursive: true });
      } catch (error: unknown) {
        throw new ScriptError({
          code: "ERR_PRUNE_REMOVE_FAILED",
          summary: `could not remove ${target}`,
          expected: `${target} removed`,
          actual: error instanceof Error ? error.message : String(error),
          next: "check the directory's permissions, then rerun `just prune-temp`",
        });
      }
    }
    context.log(`${options.dryRun ? "would remove" : "removed"} ${target}`);
  }
}

if (import.meta.main) await runScript(main);
