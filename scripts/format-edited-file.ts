/**
 * Formats the one file a Claude Code Edit/Write/MultiEdit just touched (design D20):
 * `.claude/settings.json`'s PostToolUse hook pipes its JSON payload in.
 *
 *   <hook JSON on stdin> | node scripts/format-edited-file.ts [--root DIR]
 *
 * Reads `tool_input.file_path`; formats a `.rs` file with rustfmt (rustfmt.toml applies)
 * and a `.ts`/`.tsx` file with Prettier, from the root. Nothing else in the tree is
 * touched. It does nothing, and exits 0, when the payload names no file, the file is of
 * another type, no longer exists, or lies outside the root once symlinks are resolved.
 * The formatters are called by bare name; the caller provides PATH (`mise exec --`).
 *
 * Exit codes: 0 formatted or nothing to do; 2 on failure, because Claude Code feeds a
 * PostToolUse hook's stderr back to the agent only on exit 2.
 *
 * Errors (exit 2): ERR_FORMAT_USAGE (bad arguments, no stdin), ERR_FORMAT_FAILED (the
 * formatter exited non-zero on the edited file).
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import { ScriptError, type FailureDetails } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

const USAGE = "node scripts/format-edited-file.ts [--root DIR] < hook-payload.json";
const HOOK_FAILURE = { exitCode: 2 } as const;

const usageError = (summary: string, actual: string): ScriptError =>
  new ScriptError(
    { code: "ERR_FORMAT_USAGE", summary, expected: USAGE, actual, next: `run ${USAGE}` },
    HOOK_FAILURE,
  );

/** The formatter command for a file, or undefined when this hook leaves it alone. */
export function formatterFor(path: string): { command: string; args: string[] } | undefined {
  switch (extname(path)) {
    case ".rs":
      return { command: "rustfmt", args: [path] };
    case ".ts":
    case ".tsx":
      return { command: "pnpm", args: ["exec", "prettier", "--write", path] };
    default:
      return undefined;
  }
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

  const formatter = formatterFor(real);
  if (formatter === undefined) return;
  const result = context.run(formatter.command, formatter.args, { cwd: root });
  if (result.status !== 0) {
    const details: FailureDetails = {
      code: "ERR_FORMAT_FAILED",
      summary: `${formatter.command} could not format the edited file`,
      expected: `${formatter.command} exits 0 on ${inside}`,
      actual: `${result.stderr}${result.stdout}`.trim().split("\n").slice(-5).join(" "),
      next: `fix the syntax error, then run: mise exec -- ${[formatter.command, ...formatter.args.slice(0, -1), inside].join(" ")}`,
    };
    throw new ScriptError(details, HOOK_FAILURE);
  }
}

if (import.meta.main) await runScript(main);
