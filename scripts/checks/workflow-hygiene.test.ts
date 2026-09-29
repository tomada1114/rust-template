import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError } from "../lib/fail.ts";
import type { ScriptContext } from "../lib/script.ts";
import { readWorkflows, triggerNames } from "./shared/workflows.ts";
import { check, main } from "./workflow-hygiene.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: \${{ github.workflow }}-\${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
defaults:
  run:
    shell: bash --noprofile --norc -euo pipefail {0}
jobs:
  build:
    name: Build
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
        with:
          persist-credentials: false
      - uses: ./.github/actions/local
      - run: pnpm install --frozen-lockfile
      - run: |
          cargo test --locked -p core
          cargo clippy --locked --all-targets -- -D warnings
          cargo fmt --all --check
      - run: just test-core
`;

const TITLE = `name: Check PR title
on:
  pull_request:
    types: [opened, edited]
permissions: {}
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  main:
    name: Validate PR title
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      pull-requests: read
    steps:
      - uses: amannn/action-semantic-pull-request@${SHA} # v6.1.1
        with:
          types: |
            feat
            fix
            ci
            deps
`;

const DEPENDABOT = `version: 2
updates:
  - package-ecosystem: cargo
    directory: /
    commit-message:
      prefix: "deps:"
  - package-ecosystem: github-actions
    directory: /
    commit-message:
      prefix: "ci:"
      prefix-development: "deps"
`;

const RENOVATE = JSON.stringify({ commitMessagePrefix: "deps:" });

type Files = Record<string, string | undefined>;

const BASE: Files = {
  ".github/workflows/ci.yml": CI,
  ".github/workflows/check-pr-title.yml": TITLE,
  ".github/dependabot.yml": DEPENDABOT,
  ".github/renovate.json": RENOVATE,
};

function root(overrides: Files = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-hygiene-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries({ ...BASE, ...overrides })) {
    if (content === undefined) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** The base ci.yml with `from` replaced by `to` (which must change it). */
function ci(from: string, to: string): Files {
  const changed = CI.replace(from, to);
  if (changed === CI) throw new Error(`the base ci.yml has no ${JSON.stringify(from)}`);
  return { ".github/workflows/ci.yml": changed };
}

function codes(overrides: Files = {}): string[] {
  return check.run(root(overrides)).map((violation) => violation.code);
}

function summaries(overrides: Files = {}): string[] {
  return check.run(root(overrides)).map((violation) => violation.summary);
}

describe("workflow-hygiene", () => {
  it("passes a workflow set that satisfies every rule", () => {
    expect(check.run(root())).toEqual([]);
  });

  it("passes when there is no workflow directory at all", () => {
    expect(
      check.run(
        root({
          ".github/workflows/ci.yml": undefined,
          ".github/workflows/check-pr-title.yml": undefined,
          ".github/dependabot.yml": undefined,
          ".github/renovate.json": undefined,
        }),
      ),
    ).toEqual([]);
  });

  describe("readability", () => {
    it("reports a workflow that is not valid YAML", () => {
      expect(codes({ ".github/workflows/bad.yml": "jobs: [\n" })).toEqual([
        "ERR_CHECK_WORKFLOW_UNREADABLE",
      ]);
    });

    it("reports a workflow with no jobs mapping", () => {
      expect(codes({ ".github/workflows/bad.yaml": "name: x\non: push\n" })).toEqual([
        "ERR_CHECK_WORKFLOW_UNREADABLE",
      ]);
    });

    it("reports a workflow that is not a mapping", () => {
      expect(codes({ ".github/workflows/bad.yml": "- a\n" })).toEqual([
        "ERR_CHECK_WORKFLOW_UNREADABLE",
      ]);
    });
  });

  describe("pins", () => {
    it("rejects a tag ref", () => {
      expect(codes(ci(`actions/checkout@${SHA} # v7.0.1`, "actions/checkout@v7 # v7.0.1"))).toEqual(
        ["ERR_CHECK_WORKFLOW_UNPINNED"],
      );
    });

    it("rejects a short SHA", () => {
      expect(codes(ci(`actions/checkout@${SHA}`, `actions/checkout@${SHA.slice(0, 12)}`))).toEqual([
        "ERR_CHECK_WORKFLOW_UNPINNED",
      ]);
    });

    it("rejects a docker ref", () => {
      expect(codes(ci("uses: ./.github/actions/local", "uses: docker://alpine:3"))).toEqual([
        "ERR_CHECK_WORKFLOW_UNPINNED",
      ]);
    });

    it("rejects a pin with no version comment, naming the line", () => {
      const found = check.run(root(ci(" # v7.0.1", "")));
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_WORKFLOW_PIN_COMMENT"]);
      expect(found[0]?.summary).toContain(".github/workflows/ci.yml:22");
    });

    it("rejects a comment that is not vX.Y.Z", () => {
      expect(codes(ci("# v7.0.1", "# v7"))).toEqual(["ERR_CHECK_WORKFLOW_PIN_COMMENT"]);
    });

    it("checks a reusable-workflow call on a job", () => {
      const job = `  reuse:
    uses: org/repo/.github/workflows/x.yml@main
    permissions:
      contents: read
`;
      expect(codes({ ".github/workflows/ci.yml": `${CI}${job}` })).toEqual([
        "ERR_CHECK_WORKFLOW_UNPINNED",
      ]);
    });

    it("accepts a pinned reusable-workflow call without a timeout", () => {
      const job = `  reuse:
    uses: org/repo/.github/workflows/x.yml@${SHA} # v1.2.3
    permissions:
      contents: read
`;
      expect(codes({ ".github/workflows/ci.yml": `${CI}${job}` })).toEqual([]);
    });
  });

  it("rejects a job with no timeout-minutes", () => {
    expect(codes(ci("    timeout-minutes: 10\n", ""))).toEqual(["ERR_CHECK_WORKFLOW_TIMEOUT"]);
  });

  describe("permissions", () => {
    it("rejects a workflow with no top-level permissions", () => {
      expect(codes(ci("permissions:\n  contents: read\nconcurrency", "concurrency"))).toEqual([
        "ERR_CHECK_WORKFLOW_PERMISSIONS",
      ]);
    });

    it("rejects a top-level write scope", () => {
      expect(
        codes(ci("permissions:\n  contents: read\n", "permissions:\n  contents: write\n")),
      ).toEqual(["ERR_CHECK_WORKFLOW_PERMISSIONS"]);
    });

    it("rejects a top-level scope other than contents", () => {
      expect(
        codes(
          ci(
            "permissions:\n  contents: read\n",
            "permissions:\n  contents: read\n  issues: read\n",
          ),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_PERMISSIONS"]);
    });

    it("rejects a top-level read-all shorthand", () => {
      expect(codes(ci("permissions:\n  contents: read\n", "permissions: read-all\n"))).toEqual([
        "ERR_CHECK_WORKFLOW_PERMISSIONS",
      ]);
    });

    it("accepts an empty top-level permissions mapping", () => {
      expect(codes(ci("permissions:\n  contents: read\n", "permissions: {}\n"))).toEqual([]);
    });

    it("rejects a job with no permissions of its own", () => {
      expect(codes(ci("    permissions:\n      contents: read\n    steps", "    steps"))).toEqual([
        "ERR_CHECK_WORKFLOW_JOB_PERMISSIONS",
      ]);
    });

    it("rejects a job that uses a write-all shorthand", () => {
      expect(
        codes(
          ci(
            "    permissions:\n      contents: read\n    steps",
            "    permissions: write-all\n    steps",
          ),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_JOB_PERMISSIONS"]);
    });
  });

  describe("checkout credentials", () => {
    it("rejects a checkout with no with: block", () => {
      expect(codes(ci("        with:\n          persist-credentials: false\n", ""))).toEqual([
        "ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS",
      ]);
    });

    it("rejects persist-credentials: true", () => {
      expect(codes(ci("persist-credentials: false", "persist-credentials: true"))).toEqual([
        "ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS",
      ]);
    });

    it('accepts the string "false"', () => {
      expect(codes(ci("persist-credentials: false", 'persist-credentials: "false"'))).toEqual([]);
    });
  });

  describe("concurrency", () => {
    it("rejects a pull_request workflow with no concurrency", () => {
      const without = CI.replace(/^concurrency:\n(?: {2}.*\n)+/m, "");
      expect(codes({ ".github/workflows/ci.yml": without })).toEqual([
        "ERR_CHECK_WORKFLOW_CONCURRENCY",
      ]);
    });

    it("rejects a concurrency with no group", () => {
      const noGroup = TITLE.replace("  group: ${{ github.workflow }}-${{ github.ref }}\n", "");
      expect(codes({ ".github/workflows/check-pr-title.yml": noGroup })).toEqual([
        "ERR_CHECK_WORKFLOW_CONCURRENCY",
      ]);
    });

    it("rejects a group that does not name the workflow", () => {
      const group = TITLE.replace("${{ github.workflow }}-${{ github.ref }}", "${{ github.ref }}");
      expect(codes({ ".github/workflows/check-pr-title.yml": group })).toEqual([
        "ERR_CHECK_WORKFLOW_CONCURRENCY",
      ]);
    });

    it("accepts a one-line concurrency group string on a PR-only workflow", () => {
      const inline = TITLE.replace(
        /^concurrency:\n(?: {2}.*\n)+/m,
        "concurrency: ${{ github.workflow }}-${{ github.ref }}\n",
      );
      expect(codes({ ".github/workflows/check-pr-title.yml": inline })).toEqual([]);
    });

    it("rejects cancel-in-progress: true on a workflow that also runs on push", () => {
      expect(
        codes(
          ci(
            "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
            "cancel-in-progress: true",
          ),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_CONCURRENCY"]);
    });

    it("rejects a cancel expression not limited to pull requests", () => {
      expect(
        codes(
          ci(
            "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
            "cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
          ),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_CONCURRENCY"]);
    });

    it("accepts a cancel expression that excludes push", () => {
      expect(
        codes(
          ci(
            "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
            "cancel-in-progress: ${{ github.event_name != 'push' }}",
          ),
        ),
      ).toEqual([]);
    });

    it("rejects a push workflow whose group is shared by every push run", () => {
      expect(
        codes(
          ci(
            "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
            "group: ${{ github.workflow }}-${{ github.ref }}",
          ),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_CONCURRENCY"]);
    });

    it("does not require concurrency on a scheduled workflow", () => {
      const scheduled = `name: Weekly
on:
  schedule:
    - cron: "0 0 * * 1"
permissions:
  contents: read
jobs:
  scan:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - run: |
          # comment first
          set -euo pipefail
          echo ok | cat
`;
      expect(codes({ ".github/workflows/weekly.yml": scheduled })).toEqual([]);
    });
  });

  describe("triggers", () => {
    it("rejects pull_request_target as a mapping key", () => {
      expect(codes(ci("  pull_request:\n", "  pull_request:\n  pull_request_target:\n"))).toEqual([
        "ERR_CHECK_WORKFLOW_PULL_REQUEST_TARGET",
      ]);
    });

    it("rejects pull_request_target in a flow sequence", () => {
      const title = TITLE.replace(
        "on:\n  pull_request:\n    types: [opened, edited]\n",
        "on: [pull_request, pull_request_target]\n",
      );
      expect(codes({ ".github/workflows/check-pr-title.yml": title })).toEqual([
        "ERR_CHECK_WORKFLOW_PULL_REQUEST_TARGET",
      ]);
    });

    it("reads every shape of on:", () => {
      const parse = (on: string): string[] => {
        const dir = root({ ".github/workflows/x.yml": `on: ${on}\njobs: {}\n` });
        const [workflow] = readWorkflows(dir).workflows.filter((w) => w.path.endsWith("x.yml"));
        return workflow === undefined ? [] : triggerNames(workflow.data);
      };
      expect(parse("push")).toEqual(["push"]);
      expect(parse("[push, pull_request]")).toEqual(["push", "pull_request"]);
      expect(parse("{ pull_request: {} }")).toEqual(["pull_request"]);
      expect(parse("42")).toEqual([]);
    });
  });

  describe("fail-closed shells", () => {
    const noDefaults = (text: string): string =>
      text.replace("defaults:\n  run:\n    shell: bash --noprofile --norc -euo pipefail {0}\n", "");

    it("rejects run steps with no fail-closed default and no set line", () => {
      expect(codes({ ".github/workflows/ci.yml": noDefaults(CI) })).toEqual([
        "ERR_CHECK_WORKFLOW_SHELL",
        "ERR_CHECK_WORKFLOW_SHELL",
        "ERR_CHECK_WORKFLOW_SHELL",
      ]);
    });

    it("accepts set -euo pipefail as the first command of each run", () => {
      const withSet = noDefaults(CI)
        .replace("run: pnpm install", "run: set -euo pipefail; pnpm install")
        .replace("run: |\n", "run: |\n          set -euo pipefail\n")
        .replace(
          "run: just test-core",
          "run: |\n          set -Eeuo pipefail\n          just test-core",
        );
      expect(codes({ ".github/workflows/ci.yml": withSet })).toEqual([]);
    });

    it("rejects a default shell that leaves -u off", () => {
      expect(codes(ci("-euo pipefail {0}", "-eo pipefail {0}"))).toEqual([
        "ERR_CHECK_WORKFLOW_SHELL",
        "ERR_CHECK_WORKFLOW_SHELL",
        "ERR_CHECK_WORKFLOW_SHELL",
      ]);
    });

    it("rejects a step whose own shell overrides the fail-closed default", () => {
      expect(
        codes(
          ci("      - run: just test-core\n", "      - run: just test-core\n        shell: bash\n"),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_SHELL"]);
    });

    it("rejects a job default that overrides the workflow default", () => {
      expect(
        codes(
          ci(
            "    timeout-minutes: 10\n",
            "    timeout-minutes: 10\n    defaults:\n      run:\n        shell: sh\n",
          ),
        ),
      ).toEqual([
        "ERR_CHECK_WORKFLOW_SHELL",
        "ERR_CHECK_WORKFLOW_SHELL",
        "ERR_CHECK_WORKFLOW_SHELL",
      ]);
    });

    it("leaves a step whose own shell is not sh-family to that shell", () => {
      const pwsh = noDefaults(CI)
        .replace(
          "run: pnpm install --frozen-lockfile",
          "run: pnpm install --frozen-lockfile\n        shell: pwsh",
        )
        .replace("run: just test-core", "run: just test-core\n        shell: python")
        .replace("run: |\n", "run: |\n          set -euo pipefail\n");
      expect(codes({ ".github/workflows/ci.yml": pwsh })).toEqual([]);
    });

    it("accepts a job-level fail-closed default", () => {
      const jobDefault = noDefaults(CI).replace(
        "    timeout-minutes: 10\n",
        "    timeout-minutes: 10\n    defaults:\n      run:\n        shell: bash --noprofile --norc -euo pipefail {0}\n",
      );
      expect(codes({ ".github/workflows/ci.yml": jobDefault })).toEqual([]);
    });
  });

  describe("locked installs and builds", () => {
    it("rejects pnpm install without --frozen-lockfile", () => {
      expect(codes(ci("pnpm install --frozen-lockfile", "pnpm install"))).toEqual([
        "ERR_CHECK_WORKFLOW_UNLOCKED",
      ]);
    });

    it("rejects pnpm i as well", () => {
      expect(codes(ci("pnpm install --frozen-lockfile", "pnpm i --prod"))).toEqual([
        "ERR_CHECK_WORKFLOW_UNLOCKED",
      ]);
    });

    it("rejects a cargo build command without --locked, naming its line", () => {
      const found = check.run(root(ci("cargo test --locked -p core", "cargo test -p core")));
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_WORKFLOW_UNLOCKED"]);
      expect(found[0]?.summary).toContain("ci.yml:28");
    });

    it("does not count a --locked after the -- separator", () => {
      expect(
        codes(
          ci(
            "cargo clippy --locked --all-targets -- -D warnings",
            "cargo clippy --all-targets -- --locked",
          ),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_UNLOCKED"]);
    });

    it("reads each command of a chained line and a continued line", () => {
      expect(
        codes(
          ci(
            "cargo fmt --all --check",
            "cargo fmt --all --check && cargo +nightly llvm-cov \\\n            nextest",
          ),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_UNLOCKED"]);
    });

    it("accepts --frozen and ignores cargo tools that do not resolve the lockfile", () => {
      expect(
        codes(ci("cargo fmt --all --check", "cargo run --frozen -p x\n          cargo deny check")),
      ).toEqual([]);
    });
  });

  describe("bot commit prefixes", () => {
    it("rejects a Dependabot prefix whose type the title check does not list", () => {
      expect(
        codes({
          ".github/dependabot.yml": DEPENDABOT.replace('prefix: "ci:"', 'prefix: "build(deps):"'),
        }),
      ).toEqual(["ERR_CHECK_WORKFLOW_BOT_PREFIX"]);
    });

    it("rejects a Dependabot entry with no prefix", () => {
      expect(
        codes({
          ".github/dependabot.yml": DEPENDABOT.replace(
            '    commit-message:\n      prefix: "deps:"\n',
            "",
          ),
        }),
      ).toEqual(["ERR_CHECK_WORKFLOW_BOT_PREFIX"]);
    });

    it("rejects a prefix-development whose type is not listed", () => {
      expect(
        codes({
          ".github/dependabot.yml": DEPENDABOT.replace(
            'prefix-development: "deps"',
            'prefix-development: "[dev]"',
          ),
        }),
      ).toEqual(["ERR_CHECK_WORKFLOW_BOT_PREFIX"]);
    });

    it("rejects a Renovate config with no commitMessagePrefix", () => {
      expect(codes({ ".github/renovate.json": "{}" })).toEqual(["ERR_CHECK_WORKFLOW_BOT_PREFIX"]);
    });

    it("rejects a Renovate packageRules prefix whose type is not listed", () => {
      const renovate = JSON.stringify({
        commitMessagePrefix: "deps:",
        packageRules: [{ commitMessagePrefix: "chore:" }, { matchManagers: ["mise"] }],
      });
      expect(codes({ "renovate.json": renovate, ".github/renovate.json": undefined })).toEqual([
        "ERR_CHECK_WORKFLOW_BOT_PREFIX",
      ]);
    });

    it("reports a Renovate config that is not JSON", () => {
      expect(codes({ ".github/renovate.json": "{ // json5\n}" })).toEqual([
        "ERR_CHECK_WORKFLOW_BOT_PREFIX",
      ]);
    });

    it("reports a Dependabot config that is not YAML", () => {
      expect(codes({ ".github/dependabot.yml": "updates: [\n" })).toEqual([
        "ERR_CHECK_WORKFLOW_BOT_PREFIX",
      ]);
    });

    it("rejects bot prefixes when no workflow runs the PR-title check", () => {
      expect(summaries({ ".github/workflows/check-pr-title.yml": undefined })).toEqual([
        expect.stringContaining("no workflow step uses amannn/action-semantic-pull-request"),
      ]);
    });

    it("uses the action's default types when the types input is absent", () => {
      const defaults = TITLE.replace(/ {8}with:\n(?: {10}.*\n)+/, "");
      // `deps` is not a default type; `ci` is.
      expect(codes({ ".github/workflows/check-pr-title.yml": defaults })).toEqual([
        "ERR_CHECK_WORKFLOW_BOT_PREFIX",
        "ERR_CHECK_WORKFLOW_BOT_PREFIX",
        "ERR_CHECK_WORKFLOW_BOT_PREFIX",
      ]);
    });

    it("skips the rule when neither bot is configured", () => {
      expect(
        codes({
          ".github/dependabot.yml": undefined,
          ".github/renovate.json": undefined,
          ".github/workflows/check-pr-title.yml": undefined,
        }),
      ).toEqual([]);
    });
  });

  describe("main", () => {
    function context(root: string): { ctx: ScriptContext; lines: string[] } {
      const lines: string[] = [];
      return {
        lines,
        ctx: {
          argv: [],
          env: {},
          root,
          run: () => ({ status: 0, stdout: "", stderr: "" }),
          log: (line) => lines.push(line),
        },
      };
    }

    it("logs ok for a clean root", () => {
      const { ctx, lines } = context(root());
      main(ctx);
      expect(lines).toEqual(["check workflow-hygiene: ok"]);
    });

    it("throws the first violation's code", () => {
      const { ctx } = context(root(ci("    timeout-minutes: 10\n", "")));
      expect(() => {
        main(ctx);
      }).toThrow(ScriptError);
      expect(() => {
        main(ctx);
      }).toThrow(/^ERR_CHECK_WORKFLOW_TIMEOUT/);
    });
  });
});
