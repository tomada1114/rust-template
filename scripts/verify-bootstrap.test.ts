/**
 * Tests for scripts/verify-bootstrap.ts. The generated-tree checks run against a small
 * hand-built app under os.tmpdir(); `main` clones a throwaway git repository for real and
 * stubs only the bootstrap run, which writes that app into the clone.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitEnv } from "./lib/git-env.ts";
import { runCommand, type RunOptions, type RunResult, type ScriptContext } from "./lib/script.ts";
import { assertGenerated, fillProductBullets, main, VERIFY_ANSWERS } from "./verify-bootstrap.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** An app as the bootstrap should leave it, for VERIFY_ANSWERS. */
const GENERATED: Record<string, string> = {
  "Cargo.toml": `[workspace]
members = ["crates/*", "src-tauri"]

[workspace.package]
version = "0.1.0"

[workspace.dependencies]
tide-pool-core = { path = "crates/tide-pool-core" }
tide-pool-platform = { path = "crates/tide-pool-platform" }
tide-pool-test-support = { path = "crates/tide-pool-test-support" }
`,
  "crates/tide-pool-cli/Cargo.toml": '[package]\nname = "tide-pool-cli"\n',
  "crates/tide-pool-core/Cargo.toml": '[package]\nname = "tide-pool-core"\n',
  "crates/tide-pool-platform/Cargo.toml": '[package]\nname = "tide-pool-platform"\n',
  "crates/tide-pool-test-support/Cargo.toml": '[package]\nname = "tide-pool-test-support"\n',
  "crates/tide-pool-platform/src/paths.rs":
    'pub const BUNDLE_IDENTIFIER: &str = "com.example.tide-pool";\n',
  "src-tauri/Cargo.toml": '[package]\nname = "tide-pool"\n\n[lib]\nname = "tide_pool_lib"\n',
  "src-tauri/src/startup.rs": 'pub const SMOKE_ENV: &str = "TIDE_POOL_SMOKE";\n',
  "src-tauri/src/lib.rs": 'pub const LOG_FILE_PREFIX: &str = "tide-pool";\n',
  "src-tauri/tauri.conf.json": `{
  "productName": "Tide Pool",
  "version": "0.1.0",
  "identifier": "com.example.tide-pool",
  "app": { "windows": [{ "title": "Tide Pool" }] },
  "bundle": { "externalBin": ["binaries/tide-pool-cli"] }
}
`,
  "Cargo.lock": `version = 4

[[package]]
name = "tide-pool"
version = "0.1.0"

[[package]]
name = "tide-pool-cli"
version = "0.1.0"

[[package]]
name = "tide-pool-core"
version = "0.1.0"

[[package]]
name = "tide-pool-platform"
version = "0.1.0"

[[package]]
name = "tide-pool-test-support"
version = "0.1.0"
`,
  "package.json":
    '{ "name": "tide-pool", "version": "0.1.0", "author": "Ada Lovelace", "license": "MIT" }\n',
  justfile: `bundle_id := "com.example.tide-pool"
app_name := "Tide Pool"
set shell := ["bash", "-c"]

# Everything
check: lint
    echo ok

lint:
    cargo clippy

release-prep version *flags:
    node scripts/release-prep.ts {{ flags }} {{ version }}
`,
  "scripts/smoke.ts": `const BUNDLE_IDENTIFIER = "com.example.tide-pool";
const APP_NAME = "Tide Pool";
const EXECUTABLE = "tide-pool";
const HELPER = "tide-pool-cli";
const SMOKE_ENV = "TIDE_POOL_SMOKE";
const LOG_PREFIX = "tide-pool";
`,
  LICENSE: "MIT License\n\nCopyright (c) 2031 Ada Lovelace\n",
  "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n",
  "README.md":
    "# Tide Pool\n\nSee [the guide](docs/guide.md#start) and [the site](https://example.com).\n",
  "docs/guide.md": "Run `just check`, then `just release-prep 0.2.0`.\n",
  ".agents/skills/example/SKILL.md":
    "---\nname: example\n---\n\nRead [the reference](references/more.md).\n\n```bash\njust lint\n```\n",
  ".agents/skills/example/references/more.md": "More.\n",
  ".github/workflows/ci.yml": "jobs:\n  lint:\n    name: Lint\n",
  ".github/workflows/release.yml":
    'jobs:\n  release:\n    env:\n      APP_NAME: "Tide Pool"\n    steps:\n      - run: echo "$APP_NAME.app"\n',
  ".github/rulesets/main.json": '{ "rules": [{ "context": "Lint" }] }\n',
  "osv-scanner.toml": "# Tracking issue: https://github.com/tomada1114/tauri-template/issues/3\n",
  "AGENTS.md": `# Project Guide

## Product

The owner writes each bullet (the \`starting-an-app\` skill says how).

- **What it is, and who it is for** — TODO: one paragraph. The problem it solves,
  and whose problem that is.
- **Non-goals** — TODO: what this app deliberately does not do.

## Quick Reference
`,
  ".agents/skills/starting-an-app/SKILL.md": "---\nname: starting-an-app\n---\n\nSteps.\n",
};

function generatedTree(root: string = tempDir("verify-bootstrap-app-")): string {
  for (const [path, content] of Object.entries(GENERATED)) write(root, path, content);
  return root;
}

const codes = (root: string): string[] =>
  assertGenerated(root, VERIFY_ANSWERS).map((violation) => violation.code);

describe("assertGenerated", () => {
  it("accepts an app with every name in agreement and nothing left of the template", () => {
    expect(assertGenerated(generatedTree(), VERIFY_ANSWERS)).toEqual([]);
  });

  it.each([
    ["the hyphenated slug", "myapp-core"],
    ["the underscored slug", "use myapp_lib::run;"],
    ["the upper-case slug", "MYAPP_SMOKE=1"],
    ["the display name", "MyApp.app"],
    ["the bundle identifier", "com.example.myapp"],
    ["the template repository", "tomada1114/tauri-template"],
  ])("fails on a leftover %s", (_label, text) => {
    const root = generatedTree();
    write(root, "docs/leftover.md", `line one\n${text}\n`);
    const violations = assertGenerated(root, VERIFY_ANSWERS);
    expect(violations.map((v) => v.code)).toEqual(["ERR_VERIFY_BOOTSTRAP_LEFTOVER"]);
    expect(violations[0]?.actual).toContain("docs/leftover.md:2");
  });

  it("ignores build output and dependencies", () => {
    const root = generatedTree();
    write(root, "node_modules/pkg/index.js", "myapp");
    write(root, "target/debug/myapp", "myapp");
    expect(codes(root)).toEqual([]);
  });

  it("fails on a template-only marker line, but not on prose that names the marker", () => {
    const root = generatedTree();
    write(root, "docs/prose.md", "The bootstrap removes every `<!-- template-only -->` block.\n");
    expect(codes(root)).toEqual([]);
    write(root, "docs/block.md", "<!-- template-only -->\nText\n<!-- /template-only -->\n");
    expect(codes(root)).toEqual(["ERR_VERIFY_BOOTSTRAP_MARKER"]);
  });

  it("fails while template-only material remains", () => {
    for (const [path, content] of [
      ["docs/template/design.md", "design\n"],
      ["scripts/bootstrap.ts", "export {};\n"],
      [
        ".github/workflows/ci.yml",
        "jobs:\n  bootstrap-smoke:\n    name: Template Bootstrap Smoke\n",
      ],
      [".github/rulesets/main.json", '{ "context": "Template Bootstrap Smoke" }\n'],
    ] as const) {
      const root = generatedTree();
      write(root, path, content);
      expect(codes(root)).toContain("ERR_VERIFY_BOOTSTRAP_TEMPLATE_FILE");
    }
  });

  it.each([
    ["the design record", "See docs/template/design.md."],
    ["a decision number", "Pinned once (design D9)."],
    ["README's template-only section", 'Follow "Using This Template".'],
    ["the first app", "The first app cut from this template manages launchd jobs."],
  ])("fails on text about the template: %s", (_label, text) => {
    const root = generatedTree();
    write(root, "scripts/lib/notes.ts", `// ok\n// ${text}\n`);
    const violations = assertGenerated(root, VERIFY_ANSWERS);
    expect(violations.map((v) => v.code)).toEqual(["ERR_VERIFY_BOOTSTRAP_TEMPLATE_TEXT"]);
    expect(violations[0]?.actual).toContain("scripts/lib/notes.ts:2");
  });

  it("fails when the Product section passes unfilled", () => {
    const root = generatedTree();
    write(root, "AGENTS.md", "## Product\n\n- **Non-goals** — none.\n");
    const violations = assertGenerated(root, VERIFY_ANSWERS);
    expect(violations.map((v) => v.code)).toEqual(["ERR_VERIFY_BOOTSTRAP_PRODUCT_SECTION"]);
    expect(violations[0]?.actual).toContain("passes on the unfilled section");
  });

  it("fails when filling the bullets alone does not pass the Product section", () => {
    const root = generatedTree();
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    write(root, "AGENTS.md", agents.replace("The owner writes", "TODO: the owner writes"));
    const violations = assertGenerated(root, VERIFY_ANSWERS);
    expect(violations.map((v) => v.code)).toEqual(["ERR_VERIFY_BOOTSTRAP_PRODUCT_SECTION"]);
    expect(violations[0]?.actual).toContain("AGENTS.md:5 still holds");
  });

  it("fails when the Product section's Next line names a skill the app lacks", () => {
    const root = generatedTree();
    rmSync(join(root, ".agents/skills/starting-an-app"), { recursive: true });
    const violations = assertGenerated(root, VERIFY_ANSWERS);
    expect(violations.map((v) => v.code)).toEqual(["ERR_VERIFY_BOOTSTRAP_PRODUCT_SECTION"]);
    expect(violations[0]?.actual).toContain("a skill the app lacks: starting-an-app");
  });

  it("fails on the Product section without AGENTS.md", () => {
    const root = generatedTree();
    rmSync(join(root, "AGENTS.md"));
    expect(codes(root)).toEqual(["ERR_VERIFY_BOOTSTRAP_PRODUCT_SECTION"]);
  });

  it("ignores a link inside code and a placeholder link target", () => {
    const root = generatedTree();
    write(
      root,
      "docs/examples.md",
      "Write `[x](references/nowhere.md)`.\n\n```md\n[y](gone.md)\n```\n\nSee [ADR](NNNN-<title>.md).\n",
    );
    expect(codes(root)).toEqual([]);
  });

  it("fails on a dangling skill reference: a broken link, a deleted file, or a missing recipe", () => {
    for (const text of [
      "Read [the bootstrap](references/bootstrap.md).",
      "It lives in scripts/verify-bootstrap.ts.",
      "Run `just bootstrap --yes` first.",
      "```bash\njust bootstrap\n```",
    ]) {
      const root = generatedTree();
      write(root, ".agents/skills/example/references/extra.md", `${text}\n`);
      const violations = assertGenerated(root, VERIFY_ANSWERS);
      expect(violations.map((v) => v.code)).toEqual(["ERR_VERIFY_BOOTSTRAP_DANGLING_REFERENCE"]);
      expect(violations[0]?.actual).toContain(".agents/skills/example/references/extra.md");
    }
  });

  it.each([
    [
      "src-tauri/tauri.conf.json",
      '"identifier": "com.example.tide-pool"',
      '"identifier": "com.example.other"',
    ],
    ["src-tauri/tauri.conf.json", '"title": "Tide Pool"', '"title": "Tide"'],
    ["src-tauri/tauri.conf.json", "binaries/tide-pool-cli", "binaries/tide_pool-cli"],
    ["src-tauri/tauri.conf.json", '"version": "0.1.0"', '"version": "0.4.0"'],
    ["crates/tide-pool-platform/src/paths.rs", "com.example.tide-pool", "com.example.tidepool"],
    ["justfile", 'app_name := "Tide Pool"', 'app_name := "TidePool"'],
    [".github/workflows/release.yml", 'APP_NAME: "Tide Pool"', 'APP_NAME: "TidePool"'],
    [".github/workflows/release.yml", 'APP_NAME: "Tide Pool"', 'TARGET: "Tide Pool"'],
    [
      ".github/workflows/release.yml",
      "    steps:\n",
      '    steps:\n      - env:\n          APP_NAME: "Other"\n',
    ],
    ["scripts/smoke.ts", '"TIDE_POOL_SMOKE"', '"TIDE-POOL_SMOKE"'],
    ["src-tauri/src/startup.rs", "TIDE_POOL_SMOKE", "TIDEPOOL_SMOKE"],
    ["src-tauri/src/lib.rs", '"tide-pool"', '"tide_pool"'],
    ["src-tauri/Cargo.toml", 'name = "tide_pool_lib"', 'name = "tide-pool_lib"'],
    ["src-tauri/Cargo.toml", 'name = "tide-pool"', 'name = "tidepool"'],
    ["crates/tide-pool-core/Cargo.toml", 'name = "tide-pool-core"', 'name = "tide-core"'],
    ["Cargo.toml", '"crates/tide-pool-core"', '"crates/tide-core"'],
    ["Cargo.toml", 'version = "0.1.0"', 'version = "0.2.0"'],
    ["package.json", '"name": "tide-pool"', '"name": "tidepool"'],
    ["package.json", '"author": "Ada Lovelace"', '"author": "someone"'],
    ["Cargo.lock", 'name = "tide-pool-core"', 'name = "tide-core"'],
    ["LICENSE", "Ada Lovelace", "someone"],
    ["CHANGELOG.md", "## [Unreleased]\n", "## [Unreleased]\n\n## [0.3.0] - 2026-01-01\n"],
  ])("fails when %s disagrees (%s)", (file, from, to) => {
    const root = generatedTree();
    const full = join(root, file);
    const before = readFileSync(full, "utf8");
    expect(before).toContain(from);
    writeFileSync(full, before.replace(from, to));
    expect(codes(root)).toContain("ERR_VERIFY_BOOTSTRAP_NAME_MISMATCH");
  });

  it("fails when a crate directory is missing, extra, or unparsable", () => {
    let root = generatedTree();
    rmSync(join(root, "crates/tide-pool-cli"), { recursive: true });
    expect(codes(root)).toContain("ERR_VERIFY_BOOTSTRAP_NAME_MISMATCH");
    root = generatedTree();
    write(root, "crates/stray/Cargo.toml", '[package]\nname = "stray"\n');
    expect(codes(root)).toContain("ERR_VERIFY_BOOTSTRAP_NAME_MISMATCH");
    root = generatedTree();
    write(root, "src-tauri/tauri.conf.json", "{ not json");
    write(root, "Cargo.toml", "[[[");
    expect(codes(root)).toContain("ERR_VERIFY_BOOTSTRAP_NAME_MISMATCH");
  });
});

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions | undefined;
}

const GIT_IDENTITY = [
  "-c",
  "user.name=Verify Test",
  "-c",
  "user.email=verify@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

function git(dir: string, args: string[]): RunResult {
  return runCommand("git", args, { cwd: dir, env: gitEnv(process.env) });
}

/** A committed template checkout with installed dependencies and uncommitted work. */
function sourceRepo(): string {
  const root = tempDir("verify-bootstrap-src-");
  git(root, ["init", "-q"]);
  write(root, ".gitignore", "node_modules/\n");
  write(root, "kept.md", "committed\n");
  write(root, "gone.md", "deleted in the work tree\n");
  write(root, "staged.md", "committed\n");
  git(root, ["add", "-A"]);
  git(root, [...GIT_IDENTITY, "commit", "-q", "-m", "template"]);
  write(root, "kept.md", "edited, not committed\n");
  write(root, "staged.md", "staged, not committed\n");
  git(root, ["add", "staged.md"]);
  write(root, "new.md", "untracked\n");
  rmSync(join(root, "gone.md"));
  write(root, "node_modules/prettier/index.js", "");
  return root;
}

function context(
  root: string,
  argv: string[],
  bootstrap: (cwd: string) => Partial<RunResult>,
): { context: ScriptContext; calls: Call[]; lines: string[] } {
  const calls: Call[] = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    context: {
      argv,
      env: process.env,
      root,
      run: (command, args, options) => {
        calls.push({ command, args, options });
        if (command === "git") return runCommand(command, args, options);
        return { status: 0, stdout: "", stderr: "", ...bootstrap(options?.cwd ?? "") };
      },
      log: (line) => lines.push(line),
    },
  };
}

function failure(action: () => unknown): string {
  try {
    action();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
}

describe("main", () => {
  it("clones the checkout with its uncommitted work, bootstraps it, checks it, and cleans up", () => {
    const root = sourceRepo();
    let seen: Record<string, string | boolean> = {};
    const run = context(root, [], (cwd) => {
      seen = {
        kept: readFileSync(join(cwd, "kept.md"), "utf8"),
        staged: readFileSync(join(cwd, "staged.md"), "utf8"),
        untracked: existsSync(join(cwd, "new.md")),
        deleted: existsSync(join(cwd, "gone.md")),
        deps: existsSync(join(cwd, "node_modules/prettier/index.js")),
        git: existsSync(join(cwd, ".git")),
      };
      generatedTree(cwd);
      return {};
    });
    main(run.context);
    expect(seen).toEqual({
      kept: "edited, not committed\n",
      staged: "staged, not committed\n",
      untracked: true,
      deleted: false,
      deps: true,
      git: true,
    });
    const bootstrap = run.calls.find((call) => call.command === "node");
    expect(bootstrap?.args).toEqual([
      "scripts/bootstrap.ts",
      "--yes",
      "--name",
      "Tide Pool",
      "--slug",
      "tide-pool",
      "--bundle-id",
      "com.example.tide-pool",
      "--repo",
      "example-owner/tide-pool",
      "--author",
      "Ada Lovelace",
      "--copyright",
      "Ada Lovelace",
    ]);
    const clone = bootstrap?.options?.cwd ?? "";
    expect(clone).not.toBe(root);
    expect(existsSync(clone)).toBe(false);
    expect(run.lines.at(-1)).toMatch(/^verify-bootstrap: ok/);
  });

  it("keeps the scratch copy with --keep", () => {
    const root = sourceRepo();
    const run = context(root, ["--keep"], (cwd) => {
      generatedTree(cwd);
      return {};
    });
    main(run.context);
    const clone = run.calls.find((call) => call.command === "node")?.options?.cwd ?? "";
    dirs.push(dirname(clone));
    expect(existsSync(join(clone, "LICENSE"))).toBe(true);
  });

  it("fails with the first violation and lists the rest", () => {
    const root = sourceRepo();
    const run = context(root, [], (cwd) => {
      generatedTree(cwd);
      write(cwd, "a.md", "MyApp\n");
      write(cwd, "docs/template/design.md", "left\n");
      return {};
    });
    expect(
      failure(() => {
        main(run.context);
      }),
    ).toMatch(/^ERR_VERIFY_BOOTSTRAP_\w+: .*\(1 of 2\)/);
    expect(run.lines.join("\n")).toMatch(/ERR_VERIFY_BOOTSTRAP_/);
  });

  it("fails when the bootstrap fails", () => {
    const run = context(sourceRepo(), [], () => ({ status: 1, stderr: "boom" }));
    expect(
      failure(() => {
        main(run.context);
      }),
    ).toMatch(/^ERR_VERIFY_BOOTSTRAP_RUN/);
  });

  it("fails when the checkout cannot be cloned or has no dependencies", () => {
    const notARepo = tempDir("verify-bootstrap-plain-");
    write(notARepo, "node_modules/x/index.js", "");
    expect(
      failure(() => {
        main(context(notARepo, [], () => ({})).context);
      }),
    ).toMatch(/^ERR_VERIFY_BOOTSTRAP_CLONE/);
    const root = sourceRepo();
    rmSync(join(root, "node_modules"), { recursive: true });
    expect(
      failure(() => {
        main(context(root, [], () => ({})).context);
      }),
    ).toMatch(/^ERR_VERIFY_BOOTSTRAP_NO_DEPS/);
  });

  it("refuses an unknown argument", () => {
    expect(
      failure(() => {
        main(context(sourceRepo(), ["--fast"], () => ({})).context);
      }),
    ).toMatch(/^ERR_VERIFY_BOOTSTRAP_USAGE/);
  });
});

describe("fillProductBullets", () => {
  it("fills each Product bullet and drops its continuation lines, leaving every other line", () => {
    const agents = [
      "# Guide",
      "",
      "- **Elsewhere** — TODO: not in the section.",
      "## Product",
      "",
      "Intro line.",
      "",
      "- **What it is** — TODO: one paragraph,",
      "  continued here.",
      "- **Non-goals** — TODO: none.",
      "- no bold label",
      "  kept, since it follows no filled bullet.",
      "",
      "## Next",
      "- **Other** — TODO: after the section.",
    ].join("\n");
    expect(fillProductBullets(agents)).toBe(
      [
        "# Guide",
        "",
        "- **Elsewhere** — TODO: not in the section.",
        "## Product",
        "",
        "Intro line.",
        "",
        "- **What it is** — a stand-in answer.",
        "- **Non-goals** — a stand-in answer.",
        "- no bold label",
        "  kept, since it follows no filled bullet.",
        "",
        "## Next",
        "- **Other** — TODO: after the section.",
      ].join("\n"),
    );
  });
});
