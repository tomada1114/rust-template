import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError } from "../../../../scripts/lib/fail.ts";
import type { RunResult, ScriptContext } from "../../../../scripts/lib/script.ts";
import { main } from "./survey-prs.ts";

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

  it("prints an aligned pair that is not split without the split marker", () => {
    const both = [
      {
        ...PULLS[0],
        number: 18,
        body: [
          "Updates `tauri` from 2.11.6 to 2.11.7",
          "Updates `@tauri-apps/api` from 2.11.1 to 2.11.2",
        ].join("\n"),
      },
    ];
    const root = tempRoot({ "Cargo.lock": CARGO_LOCK, "package.json": PACKAGE_JSON });
    const { context, lines } = harness([], () => ({ stdout: JSON.stringify(both) }), root);
    main(context);
    const text = lines.join("\n");
    expect(text).toContain("tauri: aligned -- ");
    expect(text).not.toContain(", split across");
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
