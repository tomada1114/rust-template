import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, processContext, runCommand, runScript, type ScriptContext } from "./script.ts";

describe("runCommand", () => {
  it("captures stdout and the exit status", () => {
    const result = runCommand(process.execPath, [
      "-e",
      "process.stdout.write('hi'); process.exit(3)",
    ]);
    expect(result).toMatchObject({ status: 3, stdout: "hi", stderr: "" });
    expect(result.pid).toBeGreaterThan(0);
  });

  it("passes input, cwd, and env to the child", () => {
    const result = runCommand(
      process.execPath,
      [
        "-e",
        "process.stdin.on('data', d => process.stdout.write(d + process.cwd() + process.env.PROBE))",
      ],
      { input: "in:", cwd: REPO_ROOT, env: { ...process.env, PROBE: ":env" } },
    );
    expect(result.stdout).toBe(`in:${REPO_ROOT}:env`);
  });

  it("reports a command that cannot start as status null", () => {
    const result = runCommand("definitely-not-a-command-here", []);
    expect(result.status).toBeNull();
    expect(result.stderr).toContain("ENOENT");
  });

  it("kills a child that outlives its timeout", () => {
    const result = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 200,
    });
    expect(result.status).toBeNull();
    expect(result.stderr).toContain("ETIMEDOUT");
  });

  it("can pass output through instead of capturing it", () => {
    const result = runCommand(process.execPath, ["-e", "process.exit(0)"], { inherit: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("processContext", () => {
  it("points at the repository root and the process arguments", () => {
    const context = processContext();
    expect(existsSync(join(context.root, "package.json"))).toBe(true);
    expect(existsSync(join(context.root, "scripts", "lib", "script.ts"))).toBe(true);
    expect(context.argv).toEqual(process.argv.slice(2));
    expect(context.env).toBe(process.env);
    expect(context.run).toBe(runCommand);
  });

  it("reads standard input on request", () => {
    const result = runCommand(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { processContext } from ${JSON.stringify(join(REPO_ROOT, "scripts/lib/script.ts"))};
         process.stdout.write("got:" + processContext().stdin());`,
      ],
      { input: "payload" },
    );
    expect(result.stdout).toBe("got:payload");
  });

  it("logs a line to stdout", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      written.push(chunk);
      return true;
    };
    try {
      processContext().log("hello");
    } finally {
      process.stdout.write = original;
    }
    expect(written).toEqual(["hello\n"]);
  });
});

describe("runScript", () => {
  it("calls main with the context", async () => {
    const seen: ScriptContext[] = [];
    const context: ScriptContext = {
      argv: ["x"],
      env: {},
      root: "/r",
      run: runCommand,
      log: () => undefined,
    };
    await runScript(
      (ctx) => {
        seen.push(ctx);
      },
      () => context,
    );
    expect(seen).toEqual([context]);
  });
});
