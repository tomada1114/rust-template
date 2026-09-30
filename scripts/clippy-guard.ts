/**
 * Runs a `cargo clippy` command and fails when clippy's configuration names something
 * clippy cannot resolve. A `path` in a `clippy.toml` (core's bans are in its crate's)
 * that is misspelled, renamed or moved in a Rust release, or missing on the build's
 * target makes clippy print only a configuration warning ("… does not refer to a
 * reachable function"). That warning is not a lint, so `-D warnings` leaves the exit
 * status 0 and the ban silently does nothing. `just lint` and CI's clippy steps run
 * clippy through this script so that warning fails them.
 * Cargo replays a fresh crate's cached diagnostics and re-checks a crate whose
 * `clippy.toml` changed, so a warm build reports the warning too.
 *
 *   node scripts/clippy-guard.ts cargo clippy <cargo clippy arguments…>
 *
 * The command is spelled out, not implied, so the lockfile check in
 * `scripts/checks/workflow-hygiene.ts` still sees `cargo clippy … --locked`. Clippy's
 * output is captured, then printed to stdout once it exits; when stdout is a terminal and
 * CARGO_TERM_COLOR is unset, cargo is asked for colour anyway. A diagnostic counts as a
 * configuration one when its primary location is a `clippy.toml` or `.clippy.toml`, or
 * when its message says a path does not refer to a reachable item. Any other
 * configuration diagnostic (a deprecated or unknown key, which clippy also reports only as
 * a warning when deprecated) fails too, under its own code.
 *
 * Git work tree: not required; cargo runs in the repository root.
 *
 * Errors:
 *   ERR_CLIPPY_USAGE             the arguments are not a `cargo clippy` command
 *   ERR_CLIPPY_BAN_UNRESOLVED    a `path` in a clippy.toml does not refer to a reachable item
 *   ERR_CLIPPY_CONFIG_INVALID    any other diagnostic located in a clippy.toml (a deprecated
 *                                or unknown key)
 *   ERR_CLIPPY_FAILED            clippy exited non-zero (its findings are printed above)
 */
import { basename, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { ScriptError } from "./lib/fail.ts";
import { processContext, runScript, type ScriptContext } from "./lib/script.ts";

/** One diagnostic clippy reported about its configuration. */
export interface ConfigDiagnostic {
  /** `unresolved`: a path names nothing clippy reaches; `invalid`: any other config problem. */
  readonly kind: "unresolved" | "invalid";
  readonly message: string;
  /** `file:line:column`, as the diagnostic's `-->` line gives it; absent without one. */
  readonly location?: string;
}

/** A whole workspace's output fits with room to spare; Node's 1 MiB default may not. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const CONFIG_FILES = new Set(["clippy.toml", ".clippy.toml"]);
const HEADER = /^(?:warning|error)(?:\[[^\]]+\])?: (.+)$/;
const PRIMARY_LOCATION = /^\s*--> (.+:\d+:\d+)\s*$/;
// clippy 1.98.1's wording; a `-->` line in a clippy.toml catches a rewording too.
const UNRESOLVED = "does not refer to a reachable";

function kindOf(
  message: string,
  location: string | undefined,
): ConfigDiagnostic["kind"] | undefined {
  if (message.includes(UNRESOLVED)) return "unresolved";
  if (location === undefined) return undefined;
  return CONFIG_FILES.has(basename(location.replace(/:\d+:\d+$/, ""))) ? "invalid" : undefined;
}

/** The configuration diagnostics in rustc's human-readable output, each once. */
export function configDiagnostics(output: string): ConfigDiagnostic[] {
  const found = new Map<string, ConfigDiagnostic>();
  let pending: { message: string; location?: string } | undefined;
  const flush = (): void => {
    if (pending === undefined) return;
    const kind = kindOf(pending.message, pending.location);
    if (kind === undefined) return;
    found.set(`${pending.message}\n${pending.location ?? ""}`, { kind, ...pending });
  };
  for (const line of stripVTControlCharacters(output).split("\n")) {
    const header = HEADER.exec(line);
    if (header !== null) {
      flush();
      pending = { message: header[1] ?? "" };
      continue;
    }
    const location = PRIMARY_LOCATION.exec(line);
    if (location !== null && pending !== undefined && pending.location === undefined) {
      pending.location = location[1] ?? "";
    }
  }
  flush();
  return [...found.values()];
}

function parseCommand(argv: readonly string[]): [string, string[]] {
  const [program, ...args] = argv;
  const separator = args.indexOf("--");
  const cargoArgs = separator === -1 ? args : args.slice(0, separator);
  if (program !== "cargo" || !cargoArgs.includes("clippy")) {
    throw new ScriptError({
      code: "ERR_CLIPPY_USAGE",
      summary: "the arguments are not a `cargo clippy` command",
      expected: "node scripts/clippy-guard.ts cargo clippy <arguments…>",
      actual: argv.length === 0 ? "no arguments" : `\`${argv.join(" ")}\``,
      next: "run `just lint`, or pass the whole `cargo clippy …` command after the script",
    });
  }
  return [program, args];
}

function describeDiagnostic(diagnostic: ConfigDiagnostic, root: string): string {
  if (diagnostic.location === undefined) return diagnostic.message;
  const location = diagnostic.location.startsWith(`${root}/`)
    ? relative(root, diagnostic.location)
    : diagnostic.location;
  return `${diagnostic.message} (${location})`;
}

/**
 * The environment cargo runs with: colour on when the output ends up on a terminal and the
 * caller chose nothing, since capturing the output would otherwise turn it off.
 */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  isTerminal: boolean,
): Readonly<Record<string, string | undefined>> {
  if (!isTerminal || env["CARGO_TERM_COLOR"] !== undefined) return env;
  return { ...env, CARGO_TERM_COLOR: "always" };
}

function listed(found: readonly ConfigDiagnostic[], root: string): string {
  return found.map((diagnostic) => describeDiagnostic(diagnostic, root)).join("; ");
}

export function main(context: ScriptContext): void {
  const [program, args] = parseCommand(context.argv);
  const command = `${program} ${args.join(" ")}`;
  const result = context.run(program, args, {
    cwd: context.root,
    env: context.env,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  // A process that never started has no output of its own: stderr holds the spawn error.
  const started = result.pid !== 0;
  for (const stream of started ? [result.stdout, result.stderr] : []) {
    const text = stream.replace(/\n+$/, "");
    if (text !== "") context.log(text);
  }

  const found = configDiagnostics(`${result.stdout}\n${result.stderr}`);
  const unresolved = found.filter((diagnostic) => diagnostic.kind === "unresolved");
  const invalid = found.filter((diagnostic) => diagnostic.kind === "invalid");
  if (unresolved.length > 0) {
    throw new ScriptError({
      code: "ERR_CLIPPY_BAN_UNRESOLVED",
      summary: `clippy's configuration names what clippy cannot resolve, so ${unresolved.length === 1 ? "that entry is" : "those entries are"} a no-op`,
      expected:
        "every `path` in a clippy.toml (core's bans in its crate's clippy.toml) to name an item clippy reaches on this target",
      actual: listed(unresolved, context.root),
      next: "correct the path (a typo, or an item Rust renamed or moved) and rerun `just lint`; never add `allow-invalid = true`, and removing a ban is weakening a gate (AGENTS.md › Security and human approval)",
    });
  }
  if (invalid.length > 0) {
    throw new ScriptError({
      code: "ERR_CLIPPY_CONFIG_INVALID",
      summary: "clippy reported a problem in a clippy.toml, so a setting there may not apply",
      expected: "every key in a clippy.toml to be one this clippy knows and has not deprecated",
      actual: listed(invalid, context.root),
      next: "change the clippy.toml key as the message says (a deprecated key names its replacement), keeping every ban and setting it held, then rerun `just lint`",
    });
  }
  if (result.status !== 0) {
    throw new ScriptError({
      code: "ERR_CLIPPY_FAILED",
      summary: "cargo clippy failed",
      expected: `\`${command}\` to exit 0`,
      actual: !started
        ? `cargo did not start: ${result.stderr.trim().split("\n")[0] ?? ""}`
        : result.status === null
          ? "cargo was stopped before it exited (a signal or a timeout); its output is printed above"
          : `cargo exited ${String(result.status)}; its findings are printed above`,
      next: "fix what clippy reports above (`just fix` applies the automatic fixes), then rerun `just lint`",
    });
  }
}

if (import.meta.main) {
  await runScript(main, () => {
    const context = processContext();
    return { ...context, env: childEnv(context.env, process.stdout.isTTY) };
  });
}
