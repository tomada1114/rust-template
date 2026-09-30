import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, HUMAN_RECIPES, main } from "./settings-allow-list.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROUTINE = [
  "Bash(just check)",
  "Bash(just test-fast:*)",
  "Bash(just logs)",
  "Bash(just sidecar:*)",
  "Bash(gh pr view:*)",
  "Bash(gh api -X GET:*)",
  "Read(./just run)",
];

function settings(allow: readonly unknown[]): string {
  return `${JSON.stringify(
    {
      permissions: {
        allow,
        ask: ["Bash(just run)", "Bash(just labels)"],
        deny: ["Bash(just bootstrap:*)", "Bash(git push --force:*)"],
      },
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "just install" }] }] },
    },
    null,
    2,
  )}\n`;
}

function fixture(content: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "settings-allow-list-"));
  dirs.push(root);
  if (content !== undefined) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), content);
  }
  return root;
}

/** The recipes each violation names, one array per violation. */
function admittedBy(allow: readonly unknown[]): string[][] {
  return check
    .run(fixture(settings(allow)))
    .map((v) => [...v.summary.matchAll(/`just ([a-z-]+)`/g)].map((m) => m[1] ?? ""));
}

describe("settings-allow-list", () => {
  it("passes when allow holds only routine rules and ask/deny/hooks name human recipes", () => {
    expect(check.run(fixture(settings(ROUTINE)))).toEqual([]);
  });

  it("passes without .claude/settings.json", () => {
    expect(check.run(fixture(undefined))).toEqual([]);
  });

  it.each(HUMAN_RECIPES)("reports `Bash(just %s)` in allow", (recipe) => {
    expect(admittedBy([...ROUTINE, `Bash(just ${recipe})`])).toEqual([[recipe]]);
  });

  it.each([
    "Bash(just run)",
    "Bash(just run:*)",
    "Bash(just run *)",
    "Bash(just run*)",
    "Bash(just run --release)",
    "Bash(mise exec -- just run)",
    "Bash(* just run)",
    "Bash(*just run*)",
    "Bash(just --justfile justfile run)",
    "Bash(just -v run)",
    "Bash(just --dotenv-load --set x y run:*)",
  ])("reports the spelling %s", (rule) => {
    expect(admittedBy([rule])).toEqual([["run"]]);
  });

  it.each([
    "Bash",
    "Bash(*)",
    "Bash(just:*)",
    "Bash(just *)",
    "Bash(just*)",
    "Bash(mise exec -- just:*)",
    "Bash(mise exec -- just *)",
    "Bash(* just *)",
  ])("reports %s, which admits every recipe", (rule) => {
    expect(admittedBy([rule])).toEqual([[...HUMAN_RECIPES]]);
  });

  it("reports each recipe a partial wildcard reaches, and only those", () => {
    expect(admittedBy(["Bash(just r*)"])).toEqual([
      ["run", "reset-permissions", "ruleset", "release-prep"],
    ]);
  });

  it.each(["Bash(just install-app)", "Bash(just logs-follow)", "Bash(just test-local:*)"])(
    "tells %s apart from its shorter neighbour",
    (rule) => {
      const recipe = /just ([a-z-]+)/.exec(rule)?.[1] ?? "";
      expect(admittedBy([rule])).toEqual([[recipe]]);
    },
  );

  it.each([
    "Bash(just runner)",
    "Bash(just test-fast run)",
    "Bash(just clean-cache)",
    "Bash(just lint)",
    "Bash(mise exec -- just test-fast:*)",
  ])("passes %s, which names no human recipe", (rule) => {
    expect(admittedBy([rule])).toEqual([]);
  });

  it("reports the rule's line and one violation per rule", () => {
    const content = settings([...ROUTINE, "Bash(just dev)", "Bash(just ruleset:*)"]);
    const violations = check.run(fixture(content));
    expect(violations.map((v) => v.code)).toEqual([
      "ERR_CHECK_ALLOW_HUMAN_RECIPE",
      "ERR_CHECK_ALLOW_HUMAN_RECIPE",
    ]);
    const line = content.split("\n").findIndex((l) => l.includes('"Bash(just dev)"')) + 1;
    expect(violations[0]?.summary).toBe(
      `.claude/settings.json:${String(line)} allows "Bash(just dev)", which admits \`just dev\``,
    );
  });

  it("fails on a .claude/settings.json that is not JSON", () => {
    const violations = check.run(fixture("{ nope"));
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_INPUT_UNREADABLE"]);
  });

  it.each([
    ["no permissions object", '{ "permissions": ["Bash(just run)"] }'],
    ["a permissions object without allow", '{ "permissions": { "deny": ["Bash(just run)"] } }'],
    ["an allow that is not a list", '{ "permissions": { "allow": "Bash(just run)" } }'],
    ["a JSON value that is not an object", "null"],
  ])("reads no rule from %s", (_label, content) => {
    expect(check.run(fixture(content))).toEqual([]);
  });

  it("skips an allow entry that is not a string", () => {
    expect(admittedBy([42, { rule: "Bash(just run)" }, ...ROUTINE])).toEqual([]);
  });

  it("runs as a script and logs a pass", () => {
    const lines: string[] = [];
    const context: ScriptContext = {
      argv: ["--root", fixture(settings(ROUTINE))],
      env: {},
      root: "/nowhere",
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => lines.push(line),
    };
    main(context);
    expect(lines).toEqual(["check settings-allow-list: ok"]);
  });
});
