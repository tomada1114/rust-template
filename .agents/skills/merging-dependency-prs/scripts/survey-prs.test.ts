import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError } from "../../../../scripts/lib/fail.ts";
import type { RunResult, ScriptContext } from "../../../../scripts/lib/script.ts";
import {
  checkSummary,
  contestedFiles,
  currentTauriVersions,
  ecosystemOf,
  highestLevel,
  main,
  parseBumps,
  semverLevel,
  tauriReport,
  type Row,
} from "./survey-prs.ts";

describe("parseBumps", () => {
  it("reads a single Dependabot bump from the title", () => {
    expect(parseBumps("deps: bump serde from 1.0.228 to 1.0.229", "")).toEqual([
      { name: "serde", from: "1.0.228", to: "1.0.229" },
    ]);
  });

  it("reads every update a grouped Dependabot body lists, not the group title", () => {
    const body = [
      "Bumps the cargo-minor-and-patch group with 2 updates: [tauri](https://example.invalid) and [serde](https://example.invalid).",
      "",
      "Updates `tauri` from 2.11.6 to 2.12.0",
      "- [Release notes](https://example.invalid)",
      "",
      "Updates `serde` from 1.0.228 to 1.0.229",
    ].join("\n");
    expect(parseBumps("deps: bump the cargo-minor-and-patch group with 2 updates", body)).toEqual([
      { name: "tauri", from: "2.11.6", to: "2.12.0" },
      { name: "serde", from: "1.0.228", to: "1.0.229" },
    ]);
  });

  it("reads a Renovate table row, with either arrow", () => {
    const body = [
      "| Package | Update | Change |",
      "|---|---|---|",
      "| [just](https://example.invalid) | minor | `1.58.0` -> `1.59.0` |",
      "| rust | patch | `1.98.0` → `1.98.1` |",
    ].join("\n");
    expect(parseBumps("deps: update just to v1.59.0", body)).toEqual([
      { name: "just", from: "1.58.0", to: "1.59.0" },
      { name: "rust", from: "1.98.0", to: "1.98.1" },
    ]);
  });

  it("returns nothing for a title and body that name no bump", () => {
    expect(parseBumps("deps: refresh the lockfile", "No versions here.")).toEqual([]);
  });
});

describe("semverLevel", () => {
  it("classifies major, minor, and patch moves", () => {
    expect(semverLevel("1.2.3", "2.0.0")).toBe("major");
    expect(semverLevel("1.2.3", "1.3.0")).toBe("minor");
    expect(semverLevel("1.2.3", "1.2.4")).toBe("patch");
    expect(semverLevel("v4.1.0", "v4.2.0")).toBe("minor");
    expect(semverLevel("^10.6", "^10.7")).toBe("minor");
  });

  it("treats a move below 1.0.0 that caret ranges call incompatible as major", () => {
    expect(semverLevel("0.2.5", "0.3.0")).toBe("major");
    expect(semverLevel("0.0.3", "0.0.4")).toBe("major");
    expect(semverLevel("0.2.5", "0.2.6")).toBe("patch");
    expect(semverLevel("1.2.3", "1.2.3")).toBe("patch");
  });

  it("is unknown when either side is missing or unparsable", () => {
    expect(semverLevel(undefined, "1.0.0")).toBe("unknown");
    expect(semverLevel("latest", "1.0.0")).toBe("unknown");
  });
});

describe("highestLevel", () => {
  it("takes the highest known level and ignores unknown ones", () => {
    expect(highestLevel(["patch", "unknown", "minor"])).toBe("minor");
    expect(highestLevel(["minor", "major"])).toBe("major");
    expect(highestLevel(["unknown"])).toBe("unknown");
    expect(highestLevel([])).toBe("unknown");
  });
});

describe("checkSummary", () => {
  it("is NONE when no check reported", () => {
    expect(checkSummary([])).toEqual({ state: "NONE", failing: [] });
  });

  it("passes only on SUCCESS, NEUTRAL, and SKIPPED", () => {
    const rollup = [
      { name: "Rust Core", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Template Bootstrap Smoke", status: "COMPLETED", conclusion: "SKIPPED" },
      { context: "osv", state: "SUCCESS" },
      { name: "Scorecard", status: "COMPLETED", conclusion: "NEUTRAL" },
    ];
    expect(checkSummary(rollup)).toEqual({ state: "PASSING", failing: [] });
  });

  it("fails closed on a failure, an unrecognised conclusion, or none at all", () => {
    const rollup = [
      { name: "Frontend", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "macOS Build & Smoke", status: "COMPLETED", conclusion: "STARTUP_FAILURE" },
      { name: "Mystery" },
      { name: "Rust Core", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    expect(checkSummary(rollup)).toEqual({
      state: "FAILING",
      failing: ["Frontend=FAILURE", "macOS Build & Smoke=STARTUP_FAILURE", "Mystery=UNKNOWN"],
    });
  });

  it("is PENDING while a check runs, unless another already failed", () => {
    const running = { name: "macOS Build & Smoke", status: "IN_PROGRESS" };
    const queued = { context: "osv", state: "PENDING" };
    expect(checkSummary([running, queued]).state).toBe("PENDING");
    expect(checkSummary([running, { name: "Frontend", conclusion: "TIMED_OUT" }]).state).toBe(
      "FAILING",
    );
  });

  it("ignores rollup entries that are not objects", () => {
    expect(checkSummary([null, "x"])).toEqual({
      state: "FAILING",
      failing: ["?=UNKNOWN", "?=UNKNOWN"],
    });
  });
});

describe("ecosystemOf", () => {
  it("reads Dependabot's ecosystem from its branch name", () => {
    expect(ecosystemOf("dependabot/cargo/cargo-minor-and-patch-a1b2", [])).toBe("cargo");
    expect(ecosystemOf("dependabot/npm_and_yarn/vite-8.4.0", [])).toBe("npm");
    expect(ecosystemOf("dependabot/github_actions/actions/checkout-7.1.0", [])).toBe(
      "github-actions",
    );
  });

  it("reads Renovate's manager from the file it edits", () => {
    expect(ecosystemOf("renovate/just-1.x", ["mise.toml"])).toBe("mise");
    expect(ecosystemOf("renovate/rust-1.x", ["rust-toolchain.toml"])).toBe("rust-toolchain");
  });

  it("falls back to the manifests a branch touches, then to other", () => {
    expect(ecosystemOf("somebot/x", ["Cargo.lock"])).toBe("cargo");
    expect(ecosystemOf("somebot/x", ["pnpm-lock.yaml"])).toBe("npm");
    expect(ecosystemOf("somebot/x", [".github/workflows/ci.yml"])).toBe("github-actions");
    expect(ecosystemOf("somebot/x", ["README.md"])).toBe("other");
  });
});

function row(overrides: Partial<Row> & Pick<Row, "number">): Row {
  return {
    title: `deps: bump something ${String(overrides.number)}`,
    url: "",
    branch: "",
    author: "app/dependabot",
    ecosystem: "cargo",
    bumps: [],
    level: "unknown",
    checks: "PASSING",
    failingChecks: [],
    mergeState: "CLEAN",
    files: [],
    ...overrides,
  };
}

describe("contestedFiles", () => {
  it("maps each file two or more PRs touch to those PRs, and nothing else", () => {
    const rows = [
      row({ number: 1, files: ["Cargo.lock", "Cargo.toml"] }),
      row({ number: 2, files: ["Cargo.lock"] }),
      row({ number: 3, files: [".github/workflows/ci.yml"] }),
    ];
    expect([...contestedFiles(rows)]).toEqual([["Cargo.lock", [1, 2]]]);
  });
});

describe("tauriReport", () => {
  const current = new Map([
    ["tauri", "2.11.6"],
    ["@tauri-apps/api", "2.11.1"],
    ["@tauri-apps/cli", "2.11.5"],
  ]);

  it("says the family stays aligned when both sides reach the same minor", () => {
    const rows = [
      row({ number: 11, bumps: [{ name: "tauri", from: "2.11.6", to: "2.12.0" }] }),
      row({
        number: 12,
        ecosystem: "npm",
        bumps: [
          { name: "@tauri-apps/api", from: "2.11.1", to: "2.12.0" },
          { name: "@tauri-apps/cli", from: "2.11.5", to: "2.12.1" },
        ],
      }),
    ];
    const report = tauriReport(rows, current);
    expect(report.majors).toEqual([]);
    expect(report.pairs).toEqual([
      {
        key: "tauri",
        prs: [11, 12],
        aligned: true,
        split: true,
        versions: [
          { name: "tauri", version: "2.12.0", pr: 11 },
          { name: "@tauri-apps/api", version: "2.12.0", pr: 12 },
          { name: "@tauri-apps/cli", version: "2.12.1", pr: 12 },
        ],
      },
    ]);
  });

  it("flags a batch that would move the crate without the npm packages", () => {
    const rows = [row({ number: 11, bumps: [{ name: "tauri", from: "2.11.6", to: "2.12.0" }] })];
    const [pair] = tauriReport(rows, current).pairs;
    expect(pair?.aligned).toBe(false);
    expect(pair?.split).toBe(false);
    expect(pair?.versions).toContainEqual({ name: "@tauri-apps/api", version: "2.11.1" });
  });

  it("pairs a plugin crate with its npm package and leaves untouched pairs out", () => {
    const withPlugin = new Map([
      ...current,
      ["tauri-plugin-log", "2.10.0"],
      ["@tauri-apps/plugin-log", "2.10.0"],
    ]);
    const rows = [
      row({
        number: 20,
        ecosystem: "npm",
        bumps: [{ name: "@tauri-apps/plugin-log", from: "2.10.0", to: "2.11.0" }],
      }),
    ];
    expect(tauriReport(rows, withPlugin).pairs).toEqual([
      {
        key: "plugin-log",
        prs: [20],
        aligned: false,
        split: false,
        versions: [
          { name: "tauri-plugin-log", version: "2.10.0" },
          { name: "@tauri-apps/plugin-log", version: "2.11.0", pr: 20 },
        ],
      },
    ]);
  });

  it("holds a plugin pair to one exact version, not one minor", () => {
    const withPlugin = new Map([
      ...current,
      ["tauri-plugin-log", "2.10.0"],
      ["@tauri-apps/plugin-log", "~2.10.0"],
    ]);
    const bump = (number: number, name: string, to: string) =>
      row({ number, bumps: [{ name, from: "2.10.0", to }] });
    const patchApart = [bump(21, "tauri-plugin-log", "2.10.1")];
    expect(tauriReport(patchApart, withPlugin).pairs[0]?.aligned).toBe(false);
    expect(tauriReport(patchApart, withPlugin).pairs[0]?.split).toBe(false);
    const together = [
      bump(21, "tauri-plugin-log", "2.10.1"),
      bump(22, "@tauri-apps/plugin-log", "2.10.1"),
    ];
    expect(tauriReport(together, withPlugin).pairs[0]?.aligned).toBe(true);
    expect(tauriReport(together, withPlugin).pairs[0]?.split).toBe(true);
  });

  it("does not call a pair split when each PR keeps it within the current minor", () => {
    const rows = [
      row({ number: 11, bumps: [{ name: "tauri", from: "2.11.6", to: "2.11.7" }] }),
      row({
        number: 12,
        ecosystem: "npm",
        bumps: [{ name: "@tauri-apps/api", from: "2.11.1", to: "2.11.2" }],
      }),
    ];
    const [pair] = tauriReport(rows, current).pairs;
    expect(pair).toMatchObject({ aligned: true, split: false });
  });

  it("does not call a pair split when one PR moves both sides", () => {
    const rows = [
      row({
        number: 11,
        bumps: [
          { name: "tauri", from: "2.11.6", to: "2.12.0" },
          { name: "@tauri-apps/api", from: "2.11.1", to: "2.12.0" },
          { name: "@tauri-apps/cli", from: "2.11.5", to: "2.12.1" },
        ],
      }),
    ];
    const [pair] = tauriReport(rows, current).pairs;
    expect(pair).toMatchObject({ aligned: true, split: false });
  });

  it("lists a Tauri major separately, whatever else moves", () => {
    const rows = [
      row({ number: 30, bumps: [{ name: "tauri-build", from: "2.7.0", to: "3.0.0" }] }),
      row({ number: 31, bumps: [{ name: "serde", from: "1.0.0", to: "2.0.0" }] }),
    ];
    expect(tauriReport(rows, current).majors).toEqual([
      { pr: 30, name: "tauri-build", from: "2.7.0", to: "3.0.0" },
    ]);
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "survey-prs-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const CARGO_LOCK = [
  "version = 4",
  "",
  "[[package]]",
  'name = "serde"',
  'version = "1.0.228"',
  "",
  "[[package]]",
  'name = "tauri"',
  'version = "2.11.6"',
  "",
  "[[package]]",
  'name = "tauri-plugin-log"',
  'version = "2.10.0"',
].join("\n");

const PACKAGE_JSON = JSON.stringify({
  dependencies: { "@tauri-apps/api": "~2.11.1", react: "^19.3.0" },
  devDependencies: { "@tauri-apps/cli": "~2.11.5" },
});

describe("currentTauriVersions", () => {
  it("reads the Tauri family from Cargo.lock and package.json", () => {
    const versions = currentTauriVersions(
      tempRoot({ "Cargo.lock": CARGO_LOCK, "package.json": PACKAGE_JSON }),
    );
    expect([...versions]).toEqual([
      ["tauri", "2.11.6"],
      ["tauri-plugin-log", "2.10.0"],
      ["@tauri-apps/api", "~2.11.1"],
      ["@tauri-apps/cli", "~2.11.5"],
    ]);
  });

  it("is empty when neither file exists or parses", () => {
    expect(currentTauriVersions(tempRoot({})).size).toBe(0);
    expect(
      currentTauriVersions(tempRoot({ "Cargo.lock": "not = [toml", "package.json": "{" })).size,
    ).toBe(0);
  });
});

type Responder = (args: readonly string[]) => Partial<RunResult>;

function harness(argv: readonly string[], respond: Responder, root = tempRoot({})) {
  const calls: (readonly string[])[] = [];
  const lines: string[] = [];
  const context: ScriptContext = {
    argv,
    env: {},
    root,
    run: (command, args) => {
      expect(command).toBe("gh");
      calls.push(args);
      return { status: 0, stdout: "", stderr: "", ...respond(args) };
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

const PULLS = [
  {
    number: 12,
    title: "deps: bump the cargo-minor-and-patch group with 1 update",
    body: "Updates `tauri` from 2.11.6 to 2.12.0",
    author: { login: "app/dependabot" },
    headRefName: "dependabot/cargo/cargo-minor-and-patch-1",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [{ name: "Rust Core", status: "COMPLETED", conclusion: "SUCCESS" }],
    files: [{ path: "Cargo.lock" }],
    url: "https://example.invalid/pull/12",
  },
  {
    number: 10,
    title: "ci: bump actions/checkout from 7.0.1 to 7.1.0",
    body: "",
    author: { login: "app/dependabot" },
    headRefName: "dependabot/github_actions/actions/checkout-7.1.0",
    mergeStateStatus: "BEHIND",
    statusCheckRollup: [{ name: "Repo Lint & Harness", status: "IN_PROGRESS" }],
    files: [{ path: ".github/workflows/ci.yml" }],
    url: "https://example.invalid/pull/10",
  },
  {
    number: 11,
    title: "feat: a human's pull request",
    body: "",
    author: { login: "someone" },
    headRefName: "feat/11-thing",
    files: [{ path: "Cargo.lock" }],
  },
];

const listing: Responder = () => ({ stdout: JSON.stringify(PULLS) });

describe("main", () => {
  it("lists only bot pull requests, in number order, with the Tauri check", () => {
    const root = tempRoot({ "Cargo.lock": CARGO_LOCK, "package.json": PACKAGE_JSON });
    const { context, calls, lines } = harness([], listing, root);
    main(context);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["pr", "list", "--state"]);
    const text = lines.join("\n");
    expect(text).toContain("2 open bot PR(s)");
    expect(text.indexOf("#10")).toBeLessThan(text.indexOf("#12"));
    expect(text).not.toContain("#11 ");
    expect(text).toContain("checks=PENDING");
    expect(text).toContain("tauri 2.11.6 -> 2.12.0");
    expect(text).toContain("tauri: MISMATCH");
    expect(text).toContain("@tauri-apps/api ~2.11.1");
  });

  it("sets a Tauri major apart from the batch", () => {
    const major = [
      {
        ...PULLS[0],
        number: 14,
        title: "deps: bump tauri from 2.12.0 to 3.0.0",
        body: "",
        headRefName: "dependabot/cargo/tauri-3.0.0",
      },
    ];
    const { context, lines } = harness([], () => ({ stdout: JSON.stringify(major) }));
    main(context);
    expect(lines).toContain("Tauri major (a migration issue, never part of a batch):");
    expect(lines).toContain("  #14 tauri 2.12.0 -> 3.0.0");
  });

  it("prints JSON with --json", () => {
    const { context, lines } = harness(["--json"], listing);
    main(context);
    const parsed: unknown = JSON.parse(lines.join("\n"));
    expect(parsed).toMatchObject({
      rows: [
        { number: 10, ecosystem: "github-actions", level: "minor", checks: "PENDING" },
        { number: 12, ecosystem: "cargo", level: "minor", checks: "PASSING" },
      ],
      contested: {},
      tauri: { pairs: [{ key: "tauri", split: false }] },
    });
  });

  it("names the PRs a split Tauri pair spans", () => {
    const pair = [
      {
        ...PULLS[0],
        number: 16,
        title: "deps: bump the npm-tauri group with 2 updates",
        body: [
          "Updates `@tauri-apps/api` from 2.11.1 to 2.12.0",
          "Updates `@tauri-apps/cli` from 2.11.5 to 2.12.1",
        ].join("\n"),
        headRefName: "dependabot/npm_and_yarn/npm-tauri-1",
        files: [{ path: "pnpm-lock.yaml" }],
      },
      {
        ...PULLS[0],
        number: 15,
        title: "deps: bump the cargo-tauri group with 1 update",
        headRefName: "dependabot/cargo/cargo-tauri-1",
      },
    ];
    const root = tempRoot({ "Cargo.lock": CARGO_LOCK, "package.json": PACKAGE_JSON });
    const { context, lines } = harness([], () => ({ stdout: JSON.stringify(pair) }), root);
    main(context);
    expect(lines.join("\n")).toContain("tauri: aligned, split across #15 #16");
  });

  it("marks each major bump inside a grouped PR", () => {
    const group = [
      {
        ...PULLS[0],
        number: 17,
        title: "deps: bump the cargo-minor-and-patch group with 2 updates",
        body: [
          "Updates `toml` from 0.8.2 to 0.9.0",
          "Updates `serde` from 1.0.228 to 1.0.229",
        ].join("\n"),
      },
    ];
    const { context, lines } = harness([], () => ({ stdout: JSON.stringify(group) }));
    main(context);
    const text = lines.join("\n");
    expect(text).toContain("toml 0.8.2 -> 0.9.0 (major)");
    expect(text).toContain("serde 1.0.228 -> 1.0.229");
    expect(text).not.toContain("serde 1.0.228 -> 1.0.229 (major)");
    expect(text).toMatch(/#17\s+\[cargo\s*\] major/);
  });

  it("names the files two bot PRs contest", () => {
    const both = [
      PULLS[0],
      { ...PULLS[0], number: 13, headRefName: "dependabot/cargo/serde-1.0.229" },
    ];
    const { context, lines } = harness([], () => ({ stdout: JSON.stringify(both) }));
    main(context);
    expect(lines).toContain("  Cargo.lock: #12, #13");
  });

  it("says so when there is no open bot pull request", () => {
    const { context, lines } = harness([], () => ({ stdout: "[]" }));
    main(context);
    expect(lines).toEqual(["No open Dependabot or Renovate pull requests."]);
  });

  it("fails with ERR_SURVEY_USAGE on an unknown argument", () => {
    const { context, calls } = harness(["--merge"], listing);
    expect(
      caught(() => {
        main(context);
      }).details.code,
    ).toBe("ERR_SURVEY_USAGE");
    expect(calls).toHaveLength(0);
  });

  it("fails with ERR_SURVEY_GH when gh cannot start", () => {
    const { context } = harness([], () => ({ status: null, stderr: "spawn gh ENOENT" }));
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_SURVEY_GH");
    expect(error.details.actual).toContain("ENOENT");
  });

  it("fails with ERR_SURVEY_GH when gh fails or prints something other than a list", () => {
    const failed = harness([], () => ({ status: 1, stderr: "HTTP 401" }));
    expect(
      caught(() => {
        main(failed.context);
      }).details.actual,
    ).toContain("HTTP 401");
    const notList = harness([], () => ({ stdout: '{"not":"a list"}' }));
    expect(
      caught(() => {
        main(notList.context);
      }).details.code,
    ).toBe("ERR_SURVEY_GH");
    const notJson = harness([], () => ({ stdout: "<html>" }));
    expect(
      caught(() => {
        main(notJson.context);
      }).details.code,
    ).toBe("ERR_SURVEY_GH");
  });
});
