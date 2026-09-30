/**
 * The clippy outputs below are cargo's real stderr on the pinned toolchain (observed
 * 2026-09-30, rustc 1.98.1), with the checkout's absolute path replaced by ROOT and the
 * crates' names by CORE and SUPPORT (so the bootstrap's rename has nothing to rewrite
 * here): one run with `std::thread::park_timeout` in core's clippy.toml misspelled as
 * `park_timeoutz`, and one with main's list.
 */
import { describe, expect, it } from "vitest";

import { configDiagnostics, main } from "./clippy-guard.ts";
import { ScriptError } from "./lib/fail.ts";
import type { RunOptions, RunResult, ScriptContext } from "./lib/script.ts";

const ROOT = "/work/repo";
const CORE = "app-core";
const SUPPORT = "app-test-support";
const LINT = [
  "cargo",
  "clippy",
  "--workspace",
  "--all-targets",
  "--locked",
  "--",
  "-D",
  "warnings",
];

const MISSPELLED = `    Checking ${CORE} v0.1.0 (${ROOT}/crates/${CORE})
warning: \`std::thread::park_timeoutz\` does not refer to a reachable function
  --> ${ROOT}/crates/${CORE}/clippy.toml:32:3
   |
32 |   { path = "std::thread::park_timeoutz", reason = "core never waits; the shell schedules" },
   |   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   |
   = help: add \`allow-invalid = true\` to the entry to suppress this warning

warning: \`${CORE}\` (lib) generated 1 warning
    Checking ${SUPPORT} v0.1.0 (${ROOT}/crates/${SUPPORT})
warning: \`${CORE}\` (test "serialization") generated 1 warning (1 duplicate)
warning: \`${CORE}\` (lib test) generated 1 warning (1 duplicate)
    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 12.18s
`;

const MAIN_LIST = `    Checking ${CORE} v0.1.0 (${ROOT}/crates/${CORE})
    Checking ${SUPPORT} v0.1.0 (${ROOT}/crates/${SUPPORT})
    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 0.49s
`;

const LINT_FAILURE = `    Checking ${CORE} v0.1.0 (${ROOT}/crates/${CORE})
error: use of a disallowed method \`std::thread::sleep\`
  --> crates/${CORE}/src/lib.rs:10:5
   |
10 |     std::thread::sleep(duration);
   |     ^^^^^^^^^^^^^^^^^^
   |
   = note: core never waits; the shell schedules

error: could not compile \`${CORE}\` (lib) due to 1 previous error
`;

const ESC = String.fromCharCode(27);
const paint = (text: string): string => `${ESC}[1m${ESC}[33m${text}${ESC}[0m`;

interface Outcome {
  readonly error: string | undefined;
  readonly actual: string | undefined;
  readonly lines: string[];
  readonly calls: { command: string; args: readonly string[]; options?: RunOptions }[];
}

function guard(argv: readonly string[], result: Partial<RunResult>): Outcome {
  const lines: string[] = [];
  const calls: Outcome["calls"] = [];
  const context: ScriptContext = {
    argv,
    env: { PATH: "/bin" },
    root: ROOT,
    run: (command, args, options) => {
      calls.push({ command, args, ...(options === undefined ? {} : { options }) });
      return { status: 0, stdout: "", stderr: "", ...result };
    },
    log: (line) => lines.push(line),
  };
  try {
    main(context);
    return { error: undefined, actual: undefined, lines, calls };
  } catch (error: unknown) {
    return {
      error: error instanceof Error ? error.message : String(error),
      actual: error instanceof ScriptError ? error.details.actual : undefined,
      lines,
      calls,
    };
  }
}

describe("clippy-guard", () => {
  it("fails on a misspelled path even though clippy exits 0", () => {
    const outcome = guard(LINT, { status: 0, stderr: MISSPELLED });
    expect(outcome.error).toMatch(/^ERR_CLIPPY_BAN_UNRESOLVED/);
    expect(outcome.lines.join("\n")).toContain("park_timeoutz");
  });

  it("passes on main's list", () => {
    const outcome = guard(LINT, { status: 0, stderr: MAIN_LIST });
    expect(outcome.error).toBeUndefined();
    expect(outcome.lines).toEqual([MAIN_LIST.trimEnd()]);
  });

  it("runs the given command in the repository root with the caller's environment", () => {
    const { calls } = guard(LINT, { status: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("cargo");
    expect(calls[0]?.args).toEqual(LINT.slice(1));
    expect(calls[0]?.options?.cwd).toBe(ROOT);
    expect(calls[0]?.options?.env).toEqual({ PATH: "/bin" });
    expect(calls[0]?.options?.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  it("reports an unresolved path before clippy's own failure", () => {
    const outcome = guard(LINT, { status: 101, stderr: `${MISSPELLED}${LINT_FAILURE}` });
    expect(outcome.error).toMatch(/^ERR_CLIPPY_BAN_UNRESOLVED/);
  });

  it("fails with clippy's failure when its configuration is sound", () => {
    const outcome = guard(LINT, { status: 101, stderr: LINT_FAILURE });
    expect(outcome.error).toMatch(/^ERR_CLIPPY_FAILED/);
  });

  it("fails when cargo does not finish", () => {
    const outcome = guard(LINT, { status: null, stderr: "spawnSync cargo ENOENT" });
    expect(outcome.error).toMatch(/^ERR_CLIPPY_FAILED/);
  });

  it("fails when cargo does not finish and prints nothing", () => {
    expect(guard(LINT, { status: null }).error).toMatch(/^ERR_CLIPPY_FAILED/);
  });

  it.each([
    ["no arguments", []],
    ["a command other than cargo", ["pnpm", "clippy"]],
    ["a cargo subcommand other than clippy", ["cargo", "build", "--locked"]],
    ["clippy only after `--`", ["cargo", "test", "--", "clippy"]],
  ])("refuses %s", (_name, argv) => {
    const outcome = guard(argv, {});
    expect(outcome.error).toMatch(/^ERR_CLIPPY_USAGE/);
    expect(outcome.calls).toHaveLength(0);
  });
});

describe("configDiagnostics", () => {
  it("finds the unresolved path once, at its clippy.toml line", () => {
    expect(configDiagnostics(MISSPELLED)).toEqual([
      {
        message: "`std::thread::park_timeoutz` does not refer to a reachable function",
        location: `${ROOT}/crates/${CORE}/clippy.toml:32:3`,
      },
    ]);
  });

  it("finds it in colored output (CI sets CARGO_TERM_COLOR=always)", () => {
    const colored = MISSPELLED.split("\n")
      .map((line) => (line.startsWith("warning") ? paint(line) : line))
      .join("\n");
    expect(configDiagnostics(colored)).toHaveLength(1);
  });

  it("reports a diagnostic repeated across crates once", () => {
    expect(configDiagnostics(`${MISSPELLED}${MISSPELLED}`)).toHaveLength(1);
  });

  it("counts any diagnostic whose primary location is a clippy.toml", () => {
    const wrongKind = [
      "warning: expected a function, found a struct",
      `  --> ${ROOT}/.clippy.toml:4:3`,
    ].join("\n");
    expect(configDiagnostics(wrongKind)).toEqual([
      { message: "expected a function, found a struct", location: `${ROOT}/.clippy.toml:4:3` },
    ]);
  });

  it("counts an unresolved-path message that carries no location", () => {
    expect(
      configDiagnostics("warning: `std::fs::nope` does not refer to an existing function\n"),
    ).toEqual([{ message: "`std::fs::nope` does not refer to an existing function" }]);
  });

  it("ignores a lint in source code and cargo's summary lines", () => {
    expect(configDiagnostics(LINT_FAILURE)).toEqual([]);
    expect(configDiagnostics(MAIN_LIST)).toEqual([]);
  });

  it("takes only the primary location, not a later span of the same diagnostic", () => {
    const text = [
      "warning: unused variable: `x`",
      `  --> crates/${CORE}/src/lib.rs:3:9`,
      `  --> crates/${CORE}/clippy.toml:1:1`,
    ].join("\n");
    expect(configDiagnostics(text)).toEqual([]);
  });
});

describe("the failure report", () => {
  it("names the entry relative to the repository root", () => {
    const { actual } = guard(LINT, { stderr: MISSPELLED });
    expect(actual).toBe(
      `\`std::thread::park_timeoutz\` does not refer to a reachable function (crates/${CORE}/clippy.toml:32:3)`,
    );
  });

  it("keeps a location outside the repository as clippy printed it", () => {
    const stderr =
      "warning: `a::b` does not refer to a reachable type\n  --> /elsewhere/clippy.toml:2:3\n";
    expect(guard(LINT, { stderr }).actual).toBe(
      "`a::b` does not refer to a reachable type (/elsewhere/clippy.toml:2:3)",
    );
  });

  it("lists every unresolved entry", () => {
    const second = MISSPELLED.replaceAll("park_timeoutz", "sleepz").replace(":32:3", ":31:3");
    expect(guard(LINT, { stderr: `${MISSPELLED}${second}` }).actual?.split("; ")).toHaveLength(2);
  });
});
