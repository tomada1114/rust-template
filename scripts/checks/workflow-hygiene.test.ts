import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError } from "../lib/fail.ts";
import type { ScriptContext } from "../lib/script.ts";
import { readWorkflows, triggerNames } from "./shared/workflows.ts";
import { check, failOpenLine, main, unlockedCommand } from "./workflow-hygiene.ts";

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
        codes(
          ci(
            "cargo fmt --all --check",
            "cargo fmt --all --check\n          cargo run --frozen -p x\n          cargo deny --locked check",
          ),
        ),
      ).toEqual([]);
    });
  });

  describe("job-level concurrency and push groups", () => {
    const jobConcurrency = (block: string): Files =>
      ci("    timeout-minutes: 10\n", `    timeout-minutes: 10\n${block}`);

    it("accepts a job concurrency keyed per push run that never cancels a push", () => {
      expect(
        codes(
          jobConcurrency(
            "    concurrency:\n      group: deploy-${{ github.sha }}\n      cancel-in-progress: false\n",
          ),
        ),
      ).toEqual([]);
    });

    it("rejects a job concurrency with no group on a push workflow", () => {
      expect(
        summaries(jobConcurrency("    concurrency:\n      cancel-in-progress: false\n")),
      ).toEqual([expect.stringContaining("no group")]);
    });

    it("reads a job concurrency given as a bare group string", () => {
      expect(codes(jobConcurrency("    concurrency: deploy\n"))).toEqual([
        "ERR_CHECK_WORKFLOW_CONCURRENCY",
      ]);
    });

    it("ignores a job concurrency on a workflow that never runs on push", () => {
      const job = TITLE.replace(
        "    timeout-minutes: 10\n",
        "    timeout-minutes: 10\n    concurrency:\n      group: probe\n      cancel-in-progress: true\n",
      );
      expect(codes({ ".github/workflows/check-pr-title.yml": job })).toEqual([]);
    });

    it("rejects a group expression it cannot evaluate for a push", () => {
      expect(
        summaries(
          ci(
            "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
            "group: ${{ github.workflow }}-${{ format('{0}', github.sha) }}",
          ),
        ),
      ).toEqual([expect.stringContaining("cannot be evaluated for a push run")]);
    });

    it("rejects a cancel that is an expression inside other text", () => {
      expect(
        codes(
          ci(
            "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
            "cancel-in-progress: x-${{ false }}",
          ),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_CONCURRENCY"]);
    });
  });

  describe("continue-on-error", () => {
    it("accepts an explicit false", () => {
      expect(
        codes(
          ci(
            "      - run: just test-core\n",
            "      - run: just test-core\n        continue-on-error: false\n",
          ),
        ),
      ).toEqual([]);
    });

    it("rejects an expression", () => {
      expect(
        codes(
          ci(
            "      - run: just test-core\n",
            "      - run: just test-core\n        continue-on-error: ${{ matrix.experimental }}\n",
          ),
        ),
      ).toEqual(["ERR_CHECK_WORKFLOW_CONTINUE_ON_ERROR"]);
    });
  });

  describe("fail-open commands", () => {
    it("flags each swallowing fallback and errexit switch", () => {
      for (const line of [
        "just test-ui || true",
        "just test-ui || :",
        "just test-ui || exit 0",
        "just test-ui || echo skipped",
        "just test-ui || printf 'x'",
        'x="$(just test-ui || true)"',
        "just a || true; just b",
        "set +e",
        "set -x +u",
        "set +o pipefail",
        "if x; then set +e; fi",
      ]) {
        expect(failOpenLine(line), line).toBeDefined();
      }
    });

    it("leaves a fail-closed fallback, a quoted one, and a comment alone", () => {
      for (const line of [
        "just test-ui || { echo failed; exit 1; }",
        "echo 'run a || true'",
        "just test-ui # not || true",
        "set +x",
        "set -euo pipefail",
        '[[ -n "$a" || -n "$b" ]]',
        "just test-ui || truer",
      ]) {
        expect(failOpenLine(line), line).toBeUndefined();
      }
    });

    it("joins a line that ends in || with the next one", () => {
      expect(
        codes(ci("cargo fmt --all --check\n", "cargo fmt --all --check ||\n            true\n")),
      ).toEqual(["ERR_CHECK_WORKFLOW_FAIL_OPEN"]);
    });
  });

  describe("unlockedCommand", () => {
    it("reads pnpm, npm, tauri, and cargo spellings", () => {
      expect(unlockedCommand("pnpm -r install")).toBeDefined();
      expect(unlockedCommand("pnpm --dir=ui i")).toBeDefined();
      expect(unlockedCommand("pnpm --frozen-lockfile install")).toBeUndefined();
      expect(unlockedCommand("pnpm --silent lint")).toBeUndefined();
      expect(unlockedCommand("npm ci")).toBeUndefined();
      expect(unlockedCommand("npm --prefix ui add left-pad")).toBeDefined();
      expect(unlockedCommand("cargo tauri build -- --locked")).toBeUndefined();
      expect(unlockedCommand("pnpm tauri dev -- --frozen -- --app-arg")).toBeUndefined();
      expect(unlockedCommand("pnpm tauri dev -- --app -- --locked")).toBeDefined();
      expect(unlockedCommand("pnpm tauri info")).toBeUndefined();
      expect(unlockedCommand("pnpm tauri")).toBeUndefined();
      expect(unlockedCommand("cargo shear --locked")).toBeUndefined();
      expect(unlockedCommand("cargo deny --locked check")).toBeUndefined();
      expect(unlockedCommand("cargo")).toBeUndefined();
      expect(unlockedCommand("cargo -q build")).toBeDefined();
      expect(unlockedCommand("cargo -Zfoo build")).toBeDefined();
      expect(unlockedCommand("cargo --color always build")).toBeDefined();
      expect(unlockedCommand("cargo +nightly -q test")).toBeDefined();
      expect(unlockedCommand("cargo --locked build")).toBeUndefined();
      expect(unlockedCommand("cargo -q --frozen build")).toBeUndefined();
      expect(unlockedCommand("cargo --color always build --locked")).toBeUndefined();
    });
  });

  describe("the justfile", () => {
    it("reads recipe lines with continuations and prefixes, and skips comments", () => {
      const justfile = [
        'set shell := ["bash", "-c"]',
        "",
        "build:",
        "    # cargo build",
        "    @cargo build \\",
        "      --release",
        "    -cargo test --locked",
        "",
      ].join("\n");
      const found = check.run(root({ justfile }));
      expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_WORKFLOW_UNLOCKED"]);
      expect(found[0]?.summary).toContain("justfile:5");
    });
  });

  describe("composite actions", () => {
    const ACTION = `name: Setup
description: x
runs:
  using: composite
  steps:
    - uses: actions/checkout@v4
    - run: pnpm install
      shell: bash
`;

    it("applies the step rules to an action under .github/actions/", () => {
      expect(codes({ ".github/actions/setup/action.yml": ACTION })).toEqual([
        "ERR_CHECK_WORKFLOW_UNPINNED",
        "ERR_CHECK_WORKFLOW_CHECKOUT_CREDENTIALS",
        "ERR_CHECK_WORKFLOW_SHELL",
        "ERR_CHECK_WORKFLOW_UNLOCKED",
      ]);
    });

    it("follows a workflow's uses: ./ to an action outside .github/actions/", () => {
      const found = check.run(
        root({
          ...ci("uses: ./.github/actions/local", "uses: ./tools/setup/"),
          "tools/setup/action.yaml": ACTION,
        }),
      );
      expect(found[0]?.summary).toContain("tools/setup/action.yaml");
      expect(found).toHaveLength(4);
    });

    it("ignores a uses: ./ that leaves the root or names no action", () => {
      expect(codes(ci("uses: ./.github/actions/local", "uses: ./../elsewhere"))).toEqual([]);
      expect(codes(ci("uses: ./.github/actions/local", "uses: ./"))).toEqual([]);
    });

    it("has no steps to check in a JavaScript or Docker action", () => {
      expect(
        codes({
          ".github/actions/node/action.yml": "name: n\nruns:\n  using: node24\n  main: index.js\n",
        }),
      ).toEqual([]);
    });

    it("reports an action that cannot be read", () => {
      expect(codes({ ".github/actions/a/action.yml": "runs: [\n" })).toEqual([
        "ERR_CHECK_WORKFLOW_UNREADABLE",
      ]);
      expect(codes({ ".github/actions/b/action.yaml": "- x\n" })).toEqual([
        "ERR_CHECK_WORKFLOW_UNREADABLE",
      ]);
      expect(codes({ ".github/actions/c/action.yml": "name: c\n" })).toEqual([
        "ERR_CHECK_WORKFLOW_UNREADABLE",
      ]);
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

    it.each(["renovate.json5", ".github/renovate.json5", ".renovaterc.json5"])(
      "reports a JSON5 Renovate config at %s as unread, never skipping it",
      (path) => {
        const found = check.run(root({ ".github/renovate.json": undefined, [path]: "{}\n" }));
        expect(found.map((v) => v.code)).toEqual(["ERR_CHECK_WORKFLOW_BOT_PREFIX"]);
        expect(found[0]?.actual).toContain(path);
      },
    );

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
