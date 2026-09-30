import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkSummary,
  collect,
  contestedFiles,
  currentTauriVersions,
  ecosystemOf,
  formatReport,
  highestLevel,
  parseBumps,
  semverLevel,
  tauriReport,
  type Row,
} from "./dependency-prs.ts";

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

  it("calls a pair split when only one of its PRs breaks it alone", () => {
    const rows = [
      row({ number: 11, bumps: [{ name: "tauri", from: "2.11.6", to: "2.12.0" }] }),
      row({
        number: 12,
        ecosystem: "npm",
        bumps: [{ name: "@tauri-apps/api", from: "2.11.1", to: "2.11.2" }],
      }),
      row({
        number: 13,
        ecosystem: "npm",
        bumps: [
          { name: "@tauri-apps/api", from: "2.11.2", to: "2.12.0" },
          { name: "@tauri-apps/cli", from: "2.11.5", to: "2.12.1" },
        ],
      }),
    ];
    const [pair] = tauriReport(rows, current).pairs;
    expect(pair).toMatchObject({ prs: [11, 12, 13], aligned: true, split: true });
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
  const root = mkdtempSync(join(tmpdir(), "dependency-prs-"));
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

describe("collect", () => {
  const pulls = [
    {
      number: 12,
      title: "deps: bump the cargo-minor-and-patch group with 2 updates",
      body: "Updates `tauri` from 2.11.6 to 2.12.0\nUpdates `toml` from 0.8.2 to 0.9.0",
      author: { login: "app/dependabot" },
      headRefName: "dependabot/cargo/cargo-minor-and-patch-1",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ name: "Rust Core", status: "COMPLETED", conclusion: "FAILURE" }],
      files: [{ path: "Cargo.lock" }, { path: "Cargo.toml" }],
      url: "https://example.invalid/pull/12",
    },
    {
      number: 7,
      title: "deps: update just to v1.59.0",
      body: "| [just](https://example.invalid) | minor | `1.58.0` -> `1.59.0` |",
      author: { login: "renovate[bot]" },
      headRefName: "renovate/just-1.x",
      files: [{ path: "mise.toml" }],
    },
    { number: 9, title: "feat: a human's pull request", author: { login: "someone" } },
  ];

  it("keeps only bot pull requests, in number order, with every field read", () => {
    expect(collect(pulls)).toEqual([
      {
        number: 7,
        title: "deps: update just to v1.59.0",
        url: "",
        branch: "renovate/just-1.x",
        author: "renovate[bot]",
        ecosystem: "mise",
        bumps: [{ name: "just", from: "1.58.0", to: "1.59.0" }],
        level: "minor",
        checks: "NONE",
        failingChecks: [],
        mergeState: "?",
        files: ["mise.toml"],
      },
      {
        number: 12,
        title: "deps: bump the cargo-minor-and-patch group with 2 updates",
        url: "https://example.invalid/pull/12",
        branch: "dependabot/cargo/cargo-minor-and-patch-1",
        author: "app/dependabot",
        ecosystem: "cargo",
        bumps: [
          { name: "tauri", from: "2.11.6", to: "2.12.0" },
          { name: "toml", from: "0.8.2", to: "0.9.0" },
        ],
        level: "major",
        checks: "FAILING",
        failingChecks: ["Rust Core=FAILURE"],
        mergeState: "CLEAN",
        files: ["Cargo.lock", "Cargo.toml"],
      },
    ]);
  });

  it("returns nothing for an empty listing or one with no bot pull request", () => {
    expect(collect([])).toEqual([]);
    expect(collect([{ number: 3, author: { login: "someone" } }])).toEqual([]);
  });
});

describe("formatReport", () => {
  it("prints one entry per row, then contested files, Tauri pairs, and Tauri majors", () => {
    const rows = [
      row({
        number: 15,
        title: "deps: bump tauri",
        level: "major",
        checks: "FAILING",
        failingChecks: ["Rust Core=FAILURE"],
        bumps: [
          { name: "tauri", from: "2.11.6", to: "3.0.0" },
          { name: "serde", from: "1.0.228", to: "1.0.229" },
        ],
        files: ["Cargo.lock"],
      }),
      row({ number: 16, ecosystem: "npm", level: "patch", files: ["Cargo.lock"] }),
    ];
    const lines = formatReport(rows, {
      pairs: [
        {
          key: "tauri",
          prs: [15, 16],
          aligned: true,
          split: true,
          versions: [
            { name: "tauri", version: "3.0.0", pr: 15 },
            { name: "@tauri-apps/api", version: "~3.0.0", pr: 16 },
            { name: "@tauri-apps/cli", version: "~3.0.1" },
          ],
        },
        { key: "plugin-log", prs: [16], aligned: false, split: false, versions: [] },
      ],
      majors: [{ pr: 15, name: "tauri", from: "2.11.6", to: "3.0.0" }],
    });
    expect(lines).toEqual([
      "2 open bot PR(s)",
      "",
      "  #15   [cargo         ] major   checks=FAILING  merge=CLEAN",
      "        deps: bump tauri",
      "        tauri 2.11.6 -> 3.0.0 (major)",
      "        serde 1.0.228 -> 1.0.229",
      "        HELD: Rust Core=FAILURE",
      "        files: Cargo.lock",
      "",
      "  #16   [npm           ] patch   checks=PASSING  merge=CLEAN",
      "        deps: bump something 16",
      "        files: Cargo.lock",
      "",
      "Contested files (one combined branch):",
      "  Cargo.lock: #15, #16",
      "",
      "Tauri family (one branch; tauri on its packages' minor, a plugin on its package's version):",
      "  tauri: aligned, split across #15 #16 -- tauri 3.0.0 (#15), @tauri-apps/api ~3.0.0 (#16), @tauri-apps/cli ~3.0.1",
      "  plugin-log: MISMATCH -- ",
      "",
      "Tauri major (a migration issue, never part of a batch):",
      "  #15 tauri 2.11.6 -> 3.0.0",
    ]);
  });

  it("prints only the rows, marking a PR that touches no file, when nothing else applies", () => {
    expect(formatReport([row({ number: 4 })], { pairs: [], majors: [] })).toEqual([
      "1 open bot PR(s)",
      "",
      "  #4    [cargo         ] unknown checks=PASSING  merge=CLEAN",
      "        deps: bump something 4",
      "        files: (none)",
    ]);
  });
});
