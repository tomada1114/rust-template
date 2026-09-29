/**
 * What a repository script receives from the process, gathered in one place so each
 * script's `main(context)` is a plain function its tests call with fakes. A script's
 * entry point is one line: `if (import.meta.main) await runScript(main);`.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMain } from "./fail.ts";

export interface RunResult {
  readonly status: number | null;
  /** The child's process id; 0 when it never started. */
  readonly pid?: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  /** Pass the child's output through to this process instead of capturing it. */
  readonly inherit?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly input?: string;
  /** Kill the child after this many milliseconds; its status is then null. */
  readonly timeoutMs?: number;
}

export type Run = (command: string, args: readonly string[], options?: RunOptions) => RunResult;

export interface ScriptContext {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The repository root (the parent of `scripts/`). */
  readonly root: string;
  readonly run: Run;
  readonly log: (line: string) => void;
}

/** The repository root, derived from this file's location. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Run a command synchronously. Output is captured unless `inherit` is set. */
export const runCommand: Run = (command, args, options = {}) => {
  const captured = options.inherit !== true;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...options.env },
    input: options.input,
    encoding: "utf8",
    stdio: captured ? "pipe" : "inherit",
    timeout: options.timeoutMs,
  });
  return {
    status: result.error === undefined ? result.status : null,
    pid: result.pid,
    // With inherited stdio Node returns null streams, whatever the types say.
    stdout: captured && result.error === undefined ? result.stdout : "",
    stderr: result.error === undefined ? (captured ? result.stderr : "") : result.error.message,
  };
};

/** The context of the running process. */
export function processContext(): ScriptContext {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    root: REPO_ROOT,
    run: runCommand,
    log: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}

/** Run a script's `main` with the process context under the failure contract. */
export async function runScript(
  main: (context: ScriptContext) => void | Promise<void>,
  context: () => ScriptContext = processContext,
): Promise<void> {
  await runMain(() => main(context()));
}
