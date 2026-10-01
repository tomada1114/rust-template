import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { readWorkflows } from "./shared/workflows.ts";
import {
  check,
  EXCEPTIONS,
  main,
  REPO_CODE_ACTIONS,
  REPO_CODE_COMMANDS,
  scan,
  writeScopes,
  type Trigger,
} from "./workflow-write-scopes.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const W = ".github/workflows";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const MISE = "jdx/mise-action@c2a87611a18de5b3828c5652fe268e992400cb5c # v4.3.0";
const DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1";
const ATTEST = "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "workflow-write-scopes-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** One workflow file whose `jobs:` body is `jobs` (indented two spaces). */
const workflow = (jobs: string, top = "permissions:\n  contents: read\n"): string =>
  `name: W\non: push\n${top}jobs:\n${jobs}`;

/** One job with the given permissions block (already indented) and steps. */
const job = (id: string, permissions: string, steps: string): string =>
  `  ${id}:\n    runs-on: ubuntu-24.04\n${permissions}    steps:\n${steps}`;

const WRITE = "    permissions:\n      contents: write\n";
const READ = "    permissions:\n      contents: read\n";
const step = {
  checkout: `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n`,
  mise: `      - uses: ${MISE}\n`,
  run: (command: string): string => `      - run: ${command}\n`,
};

const one = (body: string, top?: string): string =>
  fixture({ [`${W}/w.yml`]: workflow(body, top) });
const codes = (root: string): string[] => scan(root, {}).map((v) => v.code);
const summaries = (root: string): string[] => scan(root, {}).map((v) => v.summary);

const RELEASE = workflow(
  [
    job(
      "build",
      READ,
      [
        step.checkout,
        step.mise,
        step.run("pnpm install --frozen-lockfile"),
        step.run("cargo build --locked"),
        step.run("just test"),
      ].join(""),
    ),
    `  publish:
    needs: [build]
    runs-on: ubuntu-24.04
    permissions:
      contents: write
      attestations: write
      id-token: write
    steps:
      - uses: ${DOWNLOAD}
        with:
          name: dmg
      - uses: ${ATTEST}
        with:
          subject-path: dist-release/*.dmg
      - run: gh release create "$TAG" --verify-tag dist-release/*.dmg
`,
  ].join(""),
  "permissions: {}\n",
);

describe("workflow-write-scopes: passing", () => {
  it("passes the release shape: writes only in a job that checks out nothing", () => {
    expect(scan(fixture({ [`${W}/release.yml`]: RELEASE }), {})).toEqual([]);
  });

  it("passes when there is no .github/workflows directory", () => {
    expect(scan(fixture({ "README.md": "# app\n" }), {})).toEqual([]);
  });

  it("passes a job with `permissions: {}` and one with read-all, whatever they run", () => {
    const steps = [step.checkout, step.mise, step.run("just test"), "      - uses: ./x\n"].join("");
    const root = one(
      job("empty", "    permissions: {}\n", steps) +
        job("reader", "    permissions: read-all\n", steps),
    );
    expect(scan(root, {})).toEqual([]);
  });

  it("passes a job without its own block under a top-level `contents: read`", () => {
    expect(scan(one(job("build", "", step.checkout)), {})).toEqual([]);
  });

  it("passes a job's own `contents: read` under a top-level write-all", () => {
    expect(scan(one(job("build", READ, step.checkout), "permissions: write-all\n"), {})).toEqual(
      [],
    );
  });
});

describe("workflow-write-scopes: ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE", () => {
  it("fails `contents: write` with actions/checkout, naming the line, job, scope, and trigger", () => {
    const [violation, ...rest] = scan(one(job("build", WRITE, step.checkout)), {});
    expect(rest).toEqual([]);
    expect(violation?.code).toBe("ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE");
    expect(violation?.summary).toBe(
      ".github/workflows/w.yml:11: job `build` holds contents: write and checks out the repository (actions/checkout)",
    );
    expect(violation?.actual).toBe(CHECKOUT.split(" ")[0]);
  });

  it("fails `id-token: write` alone with jdx/mise-action", () => {
    const root = one(job("sign", "    permissions:\n      id-token: write\n", step.mise));
    expect(summaries(root)).toEqual([
      ".github/workflows/w.yml:11: job `sign` holds id-token: write and runs jdx/mise-action",
    ]);
  });

  it("finds pnpm, cargo, and just in separate run steps", () => {
    const root = one(
      job(
        "build",
        WRITE,
        [
          step.run("pnpm install --frozen-lockfile"),
          step.run("cargo build --locked"),
          step.run("just test"),
        ].join(""),
      ),
    );
    expect(summaries(root)).toEqual([
      ".github/workflows/w.yml:11: job `build` holds contents: write and runs `pnpm`",
      ".github/workflows/w.yml:12: job `build` holds contents: write and runs `cargo`",
      ".github/workflows/w.yml:13: job `build` holds contents: write and runs `just`",
    ]);
  });

  it("finds a tool behind `mise exec --` or by path, on a block run's own line", () => {
    const block = `      - run: |
          echo start
          /home/runner/.cargo/bin/cargo test --locked
      - run: mise exec -- just test
`;
    const violations = scan(one(job("build", WRITE, block)), {});
    expect(violations.map((v) => [v.summary, v.actual])).toEqual([
      [
        ".github/workflows/w.yml:13: job `build` holds contents: write and runs `cargo`",
        "/home/runner/.cargo/bin/cargo test --locked",
      ],
      [
        ".github/workflows/w.yml:14: job `build` holds contents: write and runs `just`",
        "mise exec -- just test",
      ],
    ]);
  });

  it("ignores commands that only mention the tools' files or a longer name", () => {
    const steps = [
      step.run("node scripts/x.ts"),
      step.run('gh release create "$TAG"'),
      step.run("cat justfile pnpm-lock.yaml"),
      step.run("cargo-nextest --version"),
    ].join("");
    expect(scan(one(job("build", WRITE, steps)), {})).toEqual([]);
  });

  it("fails a local action as `local action`", () => {
    const root = one(job("build", WRITE, "      - uses: ./.github/actions/setup\n"));
    expect(summaries(root)).toEqual([
      ".github/workflows/w.yml:11: job `build` holds contents: write and runs the local action `./.github/actions/setup`",
    ]);
  });

  it("fails a remote reusable call, and checks a local one in the callee's file", () => {
    const caller = workflow(`  remote:
    permissions:
      contents: write
    uses: octo/repo/.github/workflows/x.yml@3d3c42e5aac5ba805825da76410c181273ba90b1
  local:
    permissions:
      contents: write
    uses: ./.github/workflows/callee.yml
`);
    const callee = `name: Callee
on: workflow_call
jobs:
${job("inner", WRITE, step.checkout)}`;
    const root = fixture({ [`${W}/caller.yml`]: caller, [`${W}/callee.yml`]: callee });
    expect(summaries(root)).toEqual([
      ".github/workflows/callee.yml:9: job `inner` holds contents: write and checks out the repository (actions/checkout)",
      ".github/workflows/caller.yml:9: job `remote` holds contents: write and calls the reusable workflow `octo/repo/.github/workflows/x.yml@3d3c42e5aac5ba805825da76410c181273ba90b1`",
    ]);
  });

  it.each([
    ["no job block under a top-level write-all", "", "permissions: write-all\n", "write-all"],
    [
      "no job block under a top-level `contents: write`",
      "",
      "permissions:\n  contents: write\n",
      "contents: write",
    ],
    [
      "no job block and no top-level block",
      "",
      "",
      "the default token permissions (no permissions on the job or the workflow)",
    ],
    ["a job-level write-all", "    permissions: write-all\n", undefined, "write-all"],
    ["a job-level null `permissions:`", "    permissions:\n", undefined, "permissions: null"],
    [
      "a job-level `contents: admin`",
      "    permissions:\n      contents: admin\n",
      undefined,
      "contents: admin",
    ],
  ])("fails with %s", (_label, permissions, top, scope) => {
    const [violation, ...rest] = scan(one(job("build", permissions, step.checkout), top), {});
    expect(rest).toEqual([]);
    expect(violation?.code).toBe("ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE");
    expect(violation?.summary).toContain(`job \`build\` holds ${scope} and checks out`);
  });

  it("still finds a checkout behind an `if:`", () => {
    const conditional = `      - if: github.event_name == 'push'\n        uses: ${CHECKOUT}\n`;
    expect(codes(one(job("build", WRITE, conditional)))).toEqual([
      "ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE",
    ]);
  });

  it("reports each trigger of one job in step order", () => {
    const root = one(job("build", WRITE, step.checkout + step.mise + step.run("just test")));
    expect(summaries(root)).toEqual([
      ".github/workflows/w.yml:11: job `build` holds contents: write and checks out the repository (actions/checkout)",
      ".github/workflows/w.yml:14: job `build` holds contents: write and runs jdx/mise-action",
      ".github/workflows/w.yml:15: job `build` holds contents: write and runs `just`",
    ]);
  });
});

describe("workflow-write-scopes: ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE", () => {
  const KEY = `${W}/w.yml build`;
  const allows = (...triggers: Trigger[]) => ({ [KEY]: { allows: triggers, reason: "r" } });

  it("silences only the triggers an exception allows", () => {
    const root = one(job("build", WRITE, step.checkout + step.run("cargo test --locked")));
    expect(scan(root, allows("actions/checkout")).map((v) => v.summary)).toEqual([
      ".github/workflows/w.yml:14: job `build` holds contents: write and runs `cargo`",
    ]);
  });

  it("reports an exception for a job id that does not exist", () => {
    const root = one(job("build", WRITE, step.checkout));
    const violations = scan(root, {
      ...allows("actions/checkout"),
      [`${W}/w.yml missing`]: { allows: ["actions/checkout"], reason: "r" },
    });
    expect(violations.map((v) => [v.code, v.summary])).toEqual([
      [
        "ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE",
        "the exception for `.github/workflows/w.yml missing` names no job in a readable workflow",
      ],
    ]);
  });

  it("reports an exception for a job that holds no write scope", () => {
    const violations = scan(one(job("build", READ, step.checkout)), allows("actions/checkout"));
    expect(violations.map((v) => v.summary)).toEqual([
      "the exception for `.github/workflows/w.yml build` names a job that holds no write scope",
    ]);
  });

  it("reports each allowed trigger the job no longer has, once", () => {
    const root = one(job("build", WRITE, step.checkout));
    const violations = scan(root, allows("actions/checkout", "just", "local action", "just"));
    expect(violations.map((v) => [v.code, v.summary])).toEqual([
      [
        "ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE",
        "the exception for `.github/workflows/w.yml build` allows `just`, which the job no longer has",
      ],
      [
        "ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE",
        "the exception for `.github/workflows/w.yml build` allows `local action`, which the job no longer has",
      ],
    ]);
    expect(violations[0]?.actual).toBe("the job's triggers: actions/checkout");
  });

  it("names `none` when a write job with an exception has no trigger left", () => {
    const violations = scan(one(job("build", WRITE, step.run("echo hi"))), allows("cargo"));
    expect(violations.map((v) => v.actual)).toEqual(["the job's triggers: none"]);
  });

  it("reports an exception whose key has no space", () => {
    const violations = scan(one(job("build", WRITE, "")), {
      "release.yml": { allows: ["cargo"], reason: "r" },
    });
    expect(violations.map((v) => v.summary)).toEqual([
      "the exception for `release.yml` does not split into `<workflow path> <job id>`",
    ]);
  });

  it("reports an exception with an empty `allows`", () => {
    const violations = scan(one(job("build", WRITE, step.checkout)), allows());
    expect(violations.map((v) => [v.code, v.summary])).toEqual([
      [
        "ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE",
        ".github/workflows/w.yml:11: job `build` holds contents: write and checks out the repository (actions/checkout)",
      ],
      [
        "ERR_CHECK_WORKFLOW_WRITE_EXCEPTION_STALE",
        "the exception for `.github/workflows/w.yml build` allows no trigger",
      ],
    ]);
  });
});

describe("workflow-write-scopes: other", () => {
  it("yields no finding for a workflow that is not YAML", () => {
    expect(scan(fixture({ [`${W}/broken.yml`]: "jobs: [\n" }), {})).toEqual([]);
  });

  it("ships exceptions keyed by a workflow path and a job id, each with a reason and a trigger", () => {
    const triggers: readonly string[] = [
      ...REPO_CODE_ACTIONS,
      ...REPO_CODE_COMMANDS,
      "local action",
      "reusable workflow",
    ];
    for (const [key, exception] of Object.entries(EXCEPTIONS)) {
      expect(key).toMatch(/^\.github\/workflows\/[^ ]+\.ya?ml [^ ]+$/);
      expect(exception.reason.trim()).not.toBe("");
      expect(exception.allows.length).toBeGreaterThan(0);
      for (const trigger of exception.allows) expect(triggers).toContain(trigger);
    }
  });

  it("passes on the repository's own workflows, with no stale exception", () => {
    expect(check.run(join(import.meta.dirname, "..", ".."))).toEqual([]);
  });

  it("reads scopes from the job, then the workflow, then the default", () => {
    const root = fixture({
      [`${W}/w.yml`]: workflow(
        `  a:\n    permissions:\n      contents: read\n      checks: none\n      issues: write\n  b:\n    runs-on: x\n`,
        "permissions: 7\n",
      ),
    });
    const [file] = readWorkflows(root).workflows;
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(writeScopes(file, { permissions: { contents: "read", issues: "write" } })).toEqual([
      "issues: write",
    ]);
    expect(writeScopes(file, {})).toEqual(["permissions: 7"]);
    expect(writeScopes(file, { permissions: "read-all" })).toEqual([]);
    expect(writeScopes(file, { permissions: "write" })).toEqual(["permissions: write"]);
    expect(writeScopes(file, { permissions: ["contents"] })).toEqual(['permissions: ["contents"]']);
  });

  const context = (root: string, lines: string[]): ScriptContext => ({
    argv: ["--root", root],
    env: {},
    root: "/nowhere",
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    log: (line) => lines.push(line),
  });

  it("runs as a script and logs a pass on the repository's own workflows", () => {
    const lines: string[] = [];
    main(context(join(import.meta.dirname, "..", ".."), lines));
    expect(lines).toEqual(["check workflow-write-scopes: ok"]);
  });

  it("runs as a script and fails with the violation's code", () => {
    const root = one(job("build", WRITE, step.checkout));
    expect(() => {
      main(context(root, []));
    }).toThrow(/^ERR_CHECK_WORKFLOW_WRITE_RUNS_CODE: /);
  });
});
