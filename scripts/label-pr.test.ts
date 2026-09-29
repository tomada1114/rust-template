import { describe, expect, it } from "vitest";

import { computeLabelUpdate, labelForTitle, main, MANAGED_LABELS } from "./label-pr.ts";
import { ScriptError } from "./lib/fail.ts";
import type { RunResult, ScriptContext } from "./lib/script.ts";

describe("labelForTitle", () => {
  it.each([
    ["feat: add a thing", "enhancement"],
    ["feat(ui)!: redesign", "enhancement"],
    ["perf: faster", "enhancement"],
    ["fix: a crash", "bug"],
    ["fix!: breaking fix", "bug"],
    ["docs: words", "documentation"],
    ["style: format", "chore"],
    ["refactor(core): split", "chore"],
    ["test: more", "chore"],
    ["build: bump", "chore"],
    ["chore: tidy", "chore"],
    ["revert: undo", "chore"],
    ["ci: pin", "ci"],
    ["deps: bump serde", "dependencies"],
  ])("labels %j as %s", (title, label) => {
    expect(labelForTitle(title)).toBe(label);
  });

  it.each(["wip: something", "Add a thing", "feat add", "FEAT: shout", ""])(
    "gives no label to %j",
    (title) => {
      expect(labelForTitle(title)).toBeUndefined();
    },
  );

  it("maps every type the PR title check accepts", () => {
    for (const type of [
      "feat",
      "fix",
      "docs",
      "style",
      "refactor",
      "perf",
      "test",
      "build",
      "ci",
      "chore",
      "revert",
      "deps",
    ]) {
      expect(labelForTitle(`${type}: x`), type).toBeDefined();
    }
  });
});

describe("computeLabelUpdate", () => {
  it("adds the title's label", () => {
    expect(computeLabelUpdate("feat: x", [])).toEqual({ add: "enhancement", remove: [] });
  });

  it("adds nothing when the label is already there", () => {
    expect(computeLabelUpdate("feat: x", ["enhancement"])).toEqual({ add: undefined, remove: [] });
  });

  it("replaces the one stale type label after a retitle", () => {
    expect(computeLabelUpdate("fix: x", ["enhancement", "priority: P1"])).toEqual({
      add: "bug",
      remove: ["enhancement"],
    });
  });

  it("leaves two managed labels alone: one may be a human's", () => {
    expect(computeLabelUpdate("fix: x", ["enhancement", "documentation"])).toEqual({
      add: "bug",
      remove: [],
    });
  });

  it("never removes dependencies, which Dependabot applies itself", () => {
    expect(computeLabelUpdate("ci: bump actions", ["dependencies"])).toEqual({
      add: "ci",
      remove: [],
    });
  });

  it("removes nothing when the title has no type", () => {
    expect(computeLabelUpdate("Add a thing", ["enhancement"])).toEqual({
      add: undefined,
      remove: [],
    });
  });

  it("manages only type labels", () => {
    expect([...MANAGED_LABELS].sort()).toEqual([
      "bug",
      "chore",
      "ci",
      "dependencies",
      "documentation",
      "enhancement",
    ]);
  });
});

type Responder = (args: readonly string[]) => Partial<RunResult>;

function harness(env: Record<string, string>, respond: Responder) {
  const calls: (readonly string[])[] = [];
  const lines: string[] = [];
  const context: ScriptContext = {
    argv: [],
    env,
    root: "/repo",
    run: (command, args) => {
      expect(command).toBe("gh");
      calls.push(args);
      return { status: 0, stdout: "", stderr: "", ...respond(args) };
    },
    log: (line) => lines.push(line),
  };
  return { context, calls, lines };
}

const labelsJson = (...names: string[]): string =>
  JSON.stringify({ labels: names.map((name) => ({ name })) });

describe("main", () => {
  const env = { PR_NUMBER: "7", PR_TITLE: "fix: a crash" };

  it("reads the labels, then adds the new one and removes the stale one in one edit", () => {
    const { context, calls } = harness(env, (args) =>
      args[1] === "view" ? { stdout: labelsJson("enhancement") } : {},
    );
    main(context);
    expect(calls).toEqual([
      ["pr", "view", "7", "--json", "labels"],
      ["pr", "edit", "7", "--add-label", "bug", "--remove-label", "enhancement"],
    ]);
  });

  it("edits nothing when the labels are already right", () => {
    const { context, calls, lines } = harness(env, () => ({ stdout: labelsJson("bug") }));
    main(context);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual(['label-pr: nothing to change for "fix: a crash"']);
  });

  it("still adds the label when the current labels cannot be read", () => {
    const { context, calls, lines } = harness(env, (args) =>
      args[1] === "view" ? { status: 1, stderr: "HTTP 404" } : {},
    );
    main(context);
    expect(calls[1]).toEqual(["pr", "edit", "7", "--add-label", "bug"]);
    expect(lines[0]).toMatch(/^::notice::.*HTTP 404/);
  });

  it("treats an unexpected labels payload as no labels", () => {
    const { context, calls } = harness(env, (args) =>
      args[1] === "view" ? { stdout: '{"labels":"nope"}' } : {},
    );
    main(context);
    expect(calls[1]).toEqual(["pr", "edit", "7", "--add-label", "bug"]);
  });

  it("reports a failed edit as a notice, never a failure (a fork's read-only token)", () => {
    const { context, lines } = harness(env, (args) =>
      args[1] === "edit" ? { status: 1, stderr: "Resource not accessible" } : { stdout: "{}" },
    );
    main(context);
    expect(lines.at(-1)).toMatch(/^::notice::Could not update labels.*Resource not accessible/);
  });

  it("fails with ERR_LABEL_PR_NUMBER when PR_NUMBER is missing", () => {
    const { context } = harness({ PR_TITLE: "fix: x" }, () => ({}));
    let error: unknown;
    try {
      main(context);
    } catch (thrown: unknown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ScriptError);
    expect((error as ScriptError).details.code).toBe("ERR_LABEL_PR_NUMBER");
  });
});
