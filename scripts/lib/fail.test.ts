import { describe, expect, it } from "vitest";

import { ScriptError, formatFailure, runMain } from "./fail.ts";

const details = {
  code: "ERR_DEMO_THING",
  summary: "the thing failed",
  expected: "a thing",
  actual: "no thing",
  next: "make a thing",
};

function recorder(): { lines: string[]; codes: number[]; io: Parameters<typeof runMain>[1] } {
  const lines: string[] = [];
  const codes: number[] = [];
  return {
    lines,
    codes,
    io: {
      error: (line: string) => lines.push(line),
      exit: (code: number) => codes.push(code),
    },
  };
}

describe("formatFailure", () => {
  it("writes the code line, then Expected, Actual, and Next", () => {
    expect(formatFailure(details)).toBe(
      "ERR_DEMO_THING: the thing failed\nExpected: a thing\nActual: no thing\nNext: make a thing",
    );
  });
});

describe("runMain", () => {
  it("reports a ScriptError with its own details and exits 1", async () => {
    const { lines, codes, io } = recorder();
    await runMain(() => {
      throw new ScriptError(details);
    }, io);
    expect(lines).toEqual([formatFailure(details)]);
    expect(codes).toEqual([1]);
  });

  it("reports any other error as ERR_INTERNAL_UNEXPECTED", async () => {
    const { lines, codes, io } = recorder();
    await runMain(() => Promise.reject(new Error("boom")), io);
    expect(lines[0]?.split("\n")[0]).toBe("ERR_INTERNAL_UNEXPECTED: boom");
    expect(codes).toEqual([1]);
  });

  it("reports a thrown non-Error by its string form", async () => {
    const { lines, io } = recorder();
    await runMain(() => {
      const thrown: unknown = "plain";
      throw thrown;
    }, io);
    expect(lines[0]).toContain("ERR_INTERNAL_UNEXPECTED: plain");
  });

  it("does nothing when main succeeds", async () => {
    const { lines, codes, io } = recorder();
    await runMain(() => undefined, io);
    expect(lines).toEqual([]);
    expect(codes).toEqual([]);
  });

  it("writes to stderr and sets the exit code by default", async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => {
      written.push(chunk);
      return true;
    };
    try {
      await runMain(() => {
        throw new ScriptError(details);
      });
    } finally {
      process.stderr.write = original;
    }
    expect(written.join("")).toBe(`${formatFailure(details)}\n`);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
