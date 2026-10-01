/**
 * Formats the one file a Claude Code Edit/Write/MultiEdit just touched. Meant to be
 * registered as a PostToolUse hook in a personal settings file (`~/.claude/settings.json`
 * or the gitignored `.claude/settings.local.json`; see AGENTS.md), which pipes its JSON
 * payload in.
 *
 *   <hook JSON on stdin> | node scripts/format-edited-file.ts [--root DIR]
 *
 * Reads `tool_input.file_path` and formats that one file; nothing else in the tree is
 * touched. A `.rs` file goes through rustfmt on standard input, with `--config-path`
 * naming the nearest `rustfmt.toml` between the file and the root (the one rustfmt would
 * find from the file), and the result is written back: given a path, rustfmt would also
 * rewrite every out-of-line `mod` child the file declares. Every
 * extension the pre-commit hook's Prettier job checks (TypeScript, JavaScript, JSON, CSS,
 * HTML, YAML) goes through `prettier --write`, from the root, so `.prettierignore` applies.
 * It does nothing, and exits 0, when the payload names no file, the file is of another
 * type, no longer exists, or lies outside the root once symlinks are resolved. The
 * formatters are called by bare name; the caller provides PATH (`mise exec --`).
 *
 * Exit codes: 0 formatted or nothing to do; 2 on failure, because Claude Code feeds a
 * PostToolUse hook's stderr back to the agent only on exit 2.
 *
 * Errors (exit 2): ERR_FORMAT_USAGE (bad arguments, no stdin), ERR_FORMAT_FAILED (the
 * formatter exited non-zero on the edited file).
 */
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ScriptError, type FailureDetails } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

const USAGE = "node scripts/format-edited-file.ts [--root DIR] < hook-payload.json";
const HOOK_FAILURE = { exitCode: 2 } as const;
/** rustfmt echoes the whole file back; spawnSync's 1 MiB default would cut a large one off. */
const RUSTFMT_MAX_BUFFER = 64 * 1024 * 1024;

/** The extensions `lefthook.yml`'s prettier job checks; this hook formats the same set. */
export const PRETTIER_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".html",
  ".yml",
  ".yaml",
];

/**
 * How one file is formatted: `stdin` formatters read the file on standard input and
 * print the result, which this hook writes back; the others rewrite the file in place.
 */
export interface Formatter {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: boolean;
}

const usageError = (summary: string, actual: string): ScriptError =>
  new ScriptError(
    { code: "ERR_FORMAT_USAGE", summary, expected: USAGE, actual, next: `run ${USAGE}` },
    HOOK_FAILURE,
  );

const RUSTFMT_CONFIGS = ["rustfmt.toml", ".rustfmt.toml"];

/**
 * The rustfmt config rustfmt itself would pick for `path`: the nearest one in its
 * directory or a parent, looking no higher than `root`.
 */
function rustfmtConfig(path: string, root: string): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const found = RUSTFMT_CONFIGS.map((name) => join(dir, name)).find((c) => existsSync(c));
    if (found !== undefined) return found;
    if (dir === root || dirname(dir) === dir) return undefined;
  }
}

/** The formatter for a file under `root`, or undefined when this hook leaves it alone. */
export function formatterFor(path: string, root: string): Formatter | undefined {
  const extension = extname(path);
  if (extension === ".rs") {
    const config = rustfmtConfig(path, root);
    return {
      command: "rustfmt",
      args: config === undefined ? [] : ["--config-path", config],
      stdin: true,
    };
  }
  if (PRETTIER_EXTENSIONS.includes(extension)) {
    return { command: "pnpm", args: ["exec", "prettier", "--write", path], stdin: false };
  }
  return undefined;
}

function parseRoot(argv: readonly string[], fallback: string): string {
  let root = fallback;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== "--root") throw usageError("unknown argument", String(arg));
    const value = argv[i + 1];
    if (value === undefined) throw usageError("--root needs a directory", "--root with no value");
    root = value;
    i += 1;
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw usageError("--root is not a directory", root);
  }
  return realpathSync(root);
}

function editedPath(payload: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("tool_input" in parsed)) return undefined;
  const input = parsed.tool_input;
  if (typeof input !== "object" || input === null || !("file_path" in input)) return undefined;
  const path = input.file_path;
  return typeof path === "string" && path !== "" ? path : undefined;
}

export function main(context: ScriptContext): void {
  const root = parseRoot(context.argv, context.root);
  if (context.stdin === undefined) throw usageError("no standard input", "stdin unavailable");
  const path = editedPath(context.stdin());
  if (path === undefined) return;

  const absolute = isAbsolute(path) ? path : resolve(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return;
  const real = realpathSync(absolute);
  const inside = relative(root, real);
  if (inside === "" || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return;

  const formatter = formatterFor(real, root);
  if (formatter === undefined) return;
  const original = formatter.stdin ? readFileSync(real, "utf8") : undefined;
  const result = context.run(
    formatter.command,
    formatter.args,
    original === undefined
      ? { cwd: root }
      : { cwd: dirname(real), input: original, maxBuffer: RUSTFMT_MAX_BUFFER },
  );
  if (result.status !== 0) {
    const details: FailureDetails = {
      code: "ERR_FORMAT_FAILED",
      summary: `${formatter.command} could not format the edited file`,
      expected: `${formatter.command} exits 0 on ${inside}`,
      actual: `${result.stderr}${result.stdout}`.trim().split("\n").slice(-5).join(" "),
      next: formatter.stdin
        ? `fix the syntax error in ${inside} (that edit re-runs this hook); to check the file by hand, writing nothing: mise exec -- rustfmt --check ${inside}`
        : `fix the syntax error, then run: mise exec -- pnpm exec prettier --write ${inside}`,
    };
    throw new ScriptError(details, HOOK_FAILURE);
  }
  // An empty result is never written back: it would erase the file rather than format it.
  if (original !== undefined && result.stdout !== "" && result.stdout !== original) {
    writeFileSync(real, result.stdout);
  }
}

if (import.meta.main) await runScript(main);
