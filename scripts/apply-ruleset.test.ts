import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "./apply-ruleset.ts";
import { ScriptError } from "./lib/fail.ts";
import type { RunResult, ScriptContext } from "./lib/script.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(ruleset?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "apply-ruleset-"));
  dirs.push(dir);
  if (ruleset !== undefined) {
    mkdirSync(join(dir, ".github", "rulesets"), { recursive: true });
    writeFileSync(join(dir, ".github", "rulesets", "main.json"), ruleset);
  }
  return dir;
}

const VALID = JSON.stringify({ name: "main", target: "branch", enforcement: "active" });
const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const refused = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

/** A fake `run` answering gh calls in order from `answers`. */
function setup(dir: string, answers: RunResult[]) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const context: ScriptContext = {
    argv: [],
    env: {},
    root: dir,
    run: (command, args) => {
      calls.push({ command, args });
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
      return answer;
    },
    log: (line) => lines.push(line),
  };
  return { context, calls, lines };
}

function caught(action: () => void): ScriptError {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

describe("apply-ruleset", () => {
  it("creates the ruleset when none named main exists", () => {
    const dir = root(VALID);
    const { context, calls, lines } = setup(dir, [ok("owner/repo\n"), ok(""), ok("{}")]);
    main(context);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      [
        "gh",
        "api",
        "--paginate",
        "repos/owner/repo/rulesets?includes_parents=false",
        "--jq",
        '.[] | select(.name == "main" and .source_type == "Repository") | .id',
      ],
      [
        "gh",
        "api",
        "repos/owner/repo/rulesets",
        "--method",
        "POST",
        "--input",
        join(dir, ".github", "rulesets", "main.json"),
      ],
    ]);
    expect(lines.join("\n")).toContain("created ruleset main in owner/repo");
  });

  it("updates the first existing ruleset named main in place", () => {
    const dir = root(VALID);
    const { context, calls, lines } = setup(dir, [ok("owner/repo\n"), ok("42\n77\n"), ok("{}")]);
    main(context);
    expect(calls[2]?.args).toEqual([
      "api",
      "repos/owner/repo/rulesets/42",
      "--method",
      "PUT",
      "--input",
      join(dir, ".github", "rulesets", "main.json"),
    ]);
    expect(lines.join("\n")).toContain("updated ruleset main (id 42) in owner/repo");
  });

  it("fails when the ruleset file is missing", () => {
    const { context, calls } = setup(root(), []);
    expect(
      caught(() => {
        main(context);
      }).details.code,
    ).toBe("ERR_RULESET_FILE_MISSING");
    expect(calls).toEqual([]);
  });

  it.each([
    ["not JSON", "{ nope"],
    ["another name", JSON.stringify({ name: "release" })],
    ["not an object", "[]"],
    ["null", "null"],
  ])("fails when the ruleset file is %s", (_label, body) => {
    const { context } = setup(root(body), []);
    expect(
      caught(() => {
        main(context);
      }).details.code,
    ).toBe("ERR_RULESET_FILE_INVALID");
  });

  it("fails when gh cannot be started", () => {
    const { context } = setup(root(VALID), [
      { status: null, stdout: "", stderr: "spawn gh ENOENT" },
    ]);
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_RULESET_GH_MISSING");
    expect(error.details.actual).toContain("ENOENT");
  });

  it("maps a plan-gated refusal to ERR_RULESET_PLAN_UNSUPPORTED", () => {
    const { context } = setup(root(VALID), [
      ok("owner/repo\n"),
      refused("HTTP 403: Upgrade to GitHub Pro or make this repository public"),
    ]);
    expect(
      caught(() => {
        main(context);
      }).details.code,
    ).toBe("ERR_RULESET_PLAN_UNSUPPORTED");
  });

  it("maps any other refusal to ERR_RULESET_FORBIDDEN", () => {
    const { context } = setup(root(VALID), [refused("HTTP 401: Bad credentials")]);
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_RULESET_FORBIDDEN");
    expect(error.details.actual).toBe("HTTP 401: Bad credentials");
  });

  it("classifies a refused write the same way", () => {
    const { context } = setup(root(VALID), [
      ok("owner/repo\n"),
      ok("7\n"),
      refused("HTTP 404: Not Found"),
    ]);
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_RULESET_FORBIDDEN");
    expect(error.details.summary).toContain("updating the ruleset");
  });
});
