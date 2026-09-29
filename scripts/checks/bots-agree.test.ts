import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, main, toDays } from "./bots-agree.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DEPENDABOT = `version: 2
updates:
  - package-ecosystem: cargo
    directory: /
    cooldown:
      default-days: 7
  - package-ecosystem: npm
    directory: /
    cooldown:
      default-days: 7
`;

const RENOVATE = JSON.stringify({
  minimumReleaseAge: "7 days",
  packageRules: [{ matchManagers: ["mise"], minimumReleaseAge: "1 week" }, { enabled: true }],
});

const PNPM = "verifyDepsBeforeRun: error\nminimumReleaseAge: 10080\n";

type Files = Record<string, string | undefined>;

const BASE: Files = {
  ".github/dependabot.yml": DEPENDABOT,
  ".github/renovate.json": RENOVATE,
  "pnpm-workspace.yaml": PNPM,
};

function root(overrides: Files = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "bots-agree-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries({ ...BASE, ...overrides })) {
    if (content === undefined) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const codes = (overrides: Files = {}): string[] =>
  check.run(root(overrides)).map((violation) => violation.code);

describe("bots-agree", () => {
  it("passes when Dependabot, Renovate, and pnpm all wait 7 days", () => {
    expect(check.run(root())).toEqual([]);
  });

  it("passes when no bot or pnpm config exists", () => {
    expect(
      codes({
        ".github/dependabot.yml": undefined,
        ".github/renovate.json": undefined,
        "pnpm-workspace.yaml": undefined,
      }),
    ).toEqual([]);
  });

  it("reads a root renovate.json and a .yaml Dependabot file", () => {
    expect(
      codes({
        ".github/renovate.json": undefined,
        "renovate.json": JSON.stringify({ minimumReleaseAge: "168 hours" }),
        ".github/dependabot.yml": undefined,
        ".github/dependabot.yaml": DEPENDABOT,
      }),
    ).toEqual([]);
  });

  it("rejects a Dependabot cooldown that differs, naming every value", () => {
    const found = check.run(
      root({
        ".github/dependabot.yml": DEPENDABOT.replace(
          "default-days: 7\n  - ",
          "default-days: 3\n  - ",
        ),
      }),
    );
    expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_BOTS_COOLDOWN_DISAGREE"]);
    expect(found[0]?.actual).toContain(
      ".github/dependabot.yml:6: Dependabot `cargo` cooldown.default-days = 3 day(s)",
    );
    expect(found[0]?.actual).toContain("pnpm-workspace.yaml:2: pnpm minimumReleaseAge = 7 day(s)");
  });

  it("rejects a Renovate age that differs", () => {
    expect(
      codes({ ".github/renovate.json": JSON.stringify({ minimumReleaseAge: "3 days" }) }),
    ).toEqual(["ERR_CHECK_BOTS_COOLDOWN_DISAGREE"]);
  });

  it("rejects a Renovate packageRules age that differs", () => {
    const renovate = JSON.stringify({
      minimumReleaseAge: "7 days",
      packageRules: [{ minimumReleaseAge: "14 days" }],
    });
    expect(codes({ ".github/renovate.json": renovate })).toEqual([
      "ERR_CHECK_BOTS_COOLDOWN_DISAGREE",
    ]);
  });

  it("rejects a pnpm age that is not 7 days in minutes", () => {
    expect(codes({ "pnpm-workspace.yaml": "minimumReleaseAge: 1440\n" })).toEqual([
      "ERR_CHECK_BOTS_COOLDOWN_DISAGREE",
    ]);
  });

  it("rejects a Dependabot entry with no cooldown", () => {
    const without = DEPENDABOT.replace("    cooldown:\n      default-days: 7\n", "");
    expect(codes({ ".github/dependabot.yml": without })).toEqual([
      "ERR_CHECK_BOTS_COOLDOWN_MISSING",
    ]);
  });

  it("rejects a Dependabot cooldown that is not a whole number of days", () => {
    expect(
      codes({
        ".github/dependabot.yml": DEPENDABOT.replace(
          "default-days: 7\n  - ",
          'default-days: "a week"\n  - ',
        ),
      }),
    ).toEqual(["ERR_CHECK_BOTS_COOLDOWN_MISSING"]);
  });

  it("rejects a Renovate config with no minimumReleaseAge", () => {
    expect(codes({ ".github/renovate.json": "{}" })).toEqual(["ERR_CHECK_BOTS_COOLDOWN_MISSING"]);
  });

  it("rejects a Renovate age it cannot read as days", () => {
    expect(
      codes({ ".github/renovate.json": JSON.stringify({ minimumReleaseAge: "5 hours" }) }),
    ).toEqual(["ERR_CHECK_BOTS_COOLDOWN_MISSING"]);
  });

  it("rejects a pnpm-workspace.yaml with no minimumReleaseAge", () => {
    expect(codes({ "pnpm-workspace.yaml": "verifyDepsBeforeRun: error\n" })).toEqual([
      "ERR_CHECK_BOTS_COOLDOWN_MISSING",
    ]);
  });

  it("rejects a pnpm age that is not whole days", () => {
    expect(codes({ "pnpm-workspace.yaml": "minimumReleaseAge: 10000\n" })).toEqual([
      "ERR_CHECK_BOTS_COOLDOWN_MISSING",
    ]);
  });

  it("reports each config it cannot parse", () => {
    expect(
      codes({
        ".github/dependabot.yml": "updates: [\n",
        ".github/renovate.json": "{ // json5 }",
        "pnpm-workspace.yaml": "a: [\n",
      }),
    ).toEqual([
      "ERR_CHECK_BOTS_UNREADABLE",
      "ERR_CHECK_BOTS_UNREADABLE",
      "ERR_CHECK_BOTS_UNREADABLE",
    ]);
  });

  it("reads Renovate durations as whole days", () => {
    expect(toDays("7 days")).toBe(7);
    expect(toDays("1 day")).toBe(1);
    expect(toDays("2 weeks")).toBe(14);
    expect(toDays("1w")).toBe(7);
    expect(toDays("48h")).toBe(2);
    expect(toDays("10080 minutes")).toBe(7);
    expect(toDays("7d")).toBe(7);
    expect(toDays("36 hours")).toBeUndefined();
    expect(toDays("soon")).toBeUndefined();
  });

  it("main logs ok, or throws the first violation", () => {
    const lines: string[] = [];
    const context = (dir: string): ScriptContext => ({
      argv: [],
      env: {},
      root: dir,
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => lines.push(line),
    });
    main(context(root()));
    expect(lines).toEqual(["check bots-agree: ok"]);
    expect(() => {
      main(context(root({ "pnpm-workspace.yaml": "minimumReleaseAge: 1440\n" })));
    }).toThrow(/^ERR_CHECK_BOTS_COOLDOWN_DISAGREE/);
  });
});
