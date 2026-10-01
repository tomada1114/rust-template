/**
 * Tests for scripts/bootstrap.ts. Each run works on a throwaway tree under os.tmpdir()
 * that is synthesized from the script's own site list, so no test reads or writes this
 * checkout; cargo and pnpm are stubbed through the context's run function. The whole
 * tree is proven by `node scripts/verify-bootstrap.ts` and CI's Template Bootstrap Smoke.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { PassThrough } from "node:stream";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  collectAnswers,
  CRATE_DIRS,
  dependencyNames,
  deriveNames,
  findLeftovers,
  loadParsers,
  main,
  MARKER_FILES,
  parseArgs,
  processTerminal,
  REMOVED_PATHS,
  runBootstrap,
  SITES,
  TEMPLATE_VALUES,
  TEXT_EDITS,
  validateField,
  type Answers,
  type Terminal,
} from "./bootstrap.ts";
import type { RunOptions, RunResult, ScriptContext } from "./lib/script.ts";

const dirs: string[] = [];
beforeAll(async () => {
  await loadParsers();
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ANSWERS: Answers = {
  name: "Tide Pool",
  slug: "tide-pool",
  bundleId: "com.example.tide-pool",
  repo: "ada/tide-pool",
  author: "Ada Lovelace",
  copyright: "Ada Lovelace and contributors",
};

const YEAR = 2031;

// One spelling of each placeholder form, as a site in the template carries it.
const FORM_SAMPLES: Record<string, string> = {
  name: "Welcome to MyApp.",
  slug: "cargo test -p myapp-core && pkill -x myapp",
  slugSnake: "use myapp_core::Counter; myapp_lib::run();",
  slugUpper: "MYAPP_SMOKE=1",
  bundleId: "~/Library/Logs/com.example.myapp/",
  repo: "https://github.com/tomada1114/tauri-template/security",
  repoName: "cd tauri-template",
  owner: "[@tomada1114](https://github.com/tomada1114)",
};

const PACKAGE_JSON = `{
  "name": "myapp",
  "version": "0.4.2",
  "description": "MyApp: a desktop app.",
  "author": "tomada1114",
  "license": "MIT"
}
`;

const CARGO_TOML = `[workspace]
members = ["crates/*"]

[workspace.package]
version = "0.4.2" # one of the two version sites
edition = "2024"

[workspace.dependencies]
myapp-core = { path = "crates/myapp-core" }
`;

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- The template.

## [0.4.2] - 2026-01-01

- Earlier.
`;

const LICENSE = `MIT License

Copyright (c) 2026 tomada1114

Permission is hereby granted.
`;

const CI_YML = `name: CI

on:
  pull_request:

jobs:
  rust-core:
    name: Rust Core
    runs-on: ubuntu-24.04
    steps:
      - run: cargo clippy --workspace

  bootstrap-smoke:
    # Template-only.
    name: Template Bootstrap Smoke
    runs-on: macos-26
    steps:
      - run: node scripts/bootstrap.ts --yes

  zizmor:
    name: Workflow Security Lint
    runs-on: ubuntu-24.04
    steps:
      - run: zizmor .
`;

const RULESET = `{
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "required_status_checks": [
          { "context": "Rust Core", "integration_id": 15368 },
          { "context": "Template Bootstrap Smoke", "integration_id": 15368 },
          { "context": "Workflow Security Lint", "integration_id": 15368 }
        ]
      }
    }
  ]
}
`;

const JUSTFILE = `bundle_id := "com.example.myapp"
log_prefix := "myapp"

# Build
build:
    cargo build -p myapp-cli

# Turn the template into a new app: rename its placeholders and remove the template-only material (a human's step, run once)
[positional-arguments]
bootstrap *args:
    node scripts/bootstrap.ts "$@"

# Bootstrap a scratch clone in a temp directory and fail on any placeholder, template-only text, or dangling reference left behind (\`--keep\` keeps the clone)
verify-bootstrap *args:
    node scripts/verify-bootstrap.ts {{ args }}
`;

const README = `# MyApp

Intro for MyApp.

<!-- template-only -->
**Starting from the template?** See below.
<!-- /template-only -->

## Quickstart

\`\`\`bash
git clone https://github.com/tomada1114/tauri-template.git
cd tauri-template
\`\`\`

The data lives in ~/Library/Application Support/com.example.myapp/, MYAPP_SMOKE=1 runs
myapp-core's smoke.

<!-- template-only -->
## Using This Template

Everything about \`just bootstrap\`.
<!-- /template-only -->

## License
`;

/** Files whose content matters to a structured edit, and so is written in full. */
const OVERRIDES: Record<string, string> = {
  "package.json": PACKAGE_JSON,
  "Cargo.toml": CARGO_TOML,
  "CHANGELOG.md": CHANGELOG,
  LICENSE,
  ".github/workflows/ci.yml": CI_YML,
  ".github/rulesets/main.json": RULESET,
  justfile: JUSTFILE,
  "README.md": README,
};

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * A template tree holding every site the script lists: each listed form, each text
 * edit's anchor, the marker files, the files it removes, and the crate directories.
 */
function templateTree(): string {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-"));
  dirs.push(root);
  const contents = new Map<string, string>(Object.entries(OVERRIDES));
  for (const site of SITES) {
    if (OVERRIDES[site.file] !== undefined) continue;
    const lines = site.forms.map((form) => FORM_SAMPLES[form] ?? `unknown form ${form}`);
    contents.set(site.file, `${contents.get(site.file) ?? ""}${lines.join("\n")}\n`);
  }
  for (const edit of TEXT_EDITS) {
    contents.set(edit.file, `${contents.get(edit.file) ?? ""}\n${edit.find}\n`);
  }
  for (const [path, content] of contents) write(root, path, content);
  for (const removed of REMOVED_PATHS) {
    if (!existsSync(join(root, removed))) write(root, join(removed, "notes.md"), "template\n");
  }
  for (const dir of CRATE_DIRS) {
    if (!existsSync(join(root, dir))) write(root, join(dir, "Cargo.toml"), "[package]\n");
  }
  return root;
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions | undefined;
}

function context(
  root: string,
  answer: (call: Call) => Partial<RunResult> = () => ({}),
): { context: ScriptContext; calls: Call[]; lines: string[] } {
  const calls: Call[] = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    context: {
      argv: [],
      env: {},
      root,
      run: (command, args, options) => {
        const call = { command, args, options };
        calls.push(call);
        return { status: 0, stdout: "", stderr: "", ...answer(call) };
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

async function asyncFailure(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
}

const read = (root: string, path: string): string => readFileSync(join(root, path), "utf8");

/** A terminal that answers from a queue and records every question. */
function terminal(answers: (string | undefined)[], interactive = true) {
  const questions: string[] = [];
  const fake: Terminal = {
    interactive,
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(answers.shift());
    },
  };
  return { fake, questions };
}

describe("parseArgs", () => {
  it("reads every value flag, in both spellings, and --yes", () => {
    expect(
      parseArgs([
        "--name",
        "Tide Pool",
        "--slug=tide-pool",
        "--bundle-id",
        "com.example.tide-pool",
        "--repo",
        "ada/tide-pool",
        "--author",
        "Ada",
        "--copyright",
        "Ada",
        "--yes",
      ]),
    ).toEqual({
      values: {
        name: "Tide Pool",
        slug: "tide-pool",
        bundleId: "com.example.tide-pool",
        repo: "ada/tide-pool",
        author: "Ada",
        copyright: "Ada",
      },
      yes: true,
      help: false,
    });
  });

  it("accepts -y and --help", () => {
    expect(parseArgs(["-y", "--help"])).toEqual({ values: {}, yes: true, help: true });
  });

  it("refuses an unknown flag, a flag without a value, and a repeated flag", () => {
    expect(failure(() => parseArgs(["--colour", "red"]))).toMatch(/^ERR_BOOTSTRAP_USAGE/);
    expect(failure(() => parseArgs(["--name"]))).toMatch(/^ERR_BOOTSTRAP_USAGE/);
    expect(failure(() => parseArgs(["--name", "--yes"]))).toMatch(/^ERR_BOOTSTRAP_USAGE/);
    expect(failure(() => parseArgs(["--slug", "a", "--slug", "b"]))).toMatch(
      /^ERR_BOOTSTRAP_USAGE/,
    );
  });

  it("refuses a stray word, which is what an unquoted multi-word value becomes", () => {
    expect(failure(() => parseArgs(["--name", "Tide", "Pool"]))).toMatch(
      /^ERR_BOOTSTRAP_USAGE: unexpected argument 'Pool'/,
    );
  });
});

describe("validateField", () => {
  it("accepts a display name with spaces and trims it", () => {
    expect(validateField("name", "  Tide Pool ")).toBe("Tide Pool");
    expect(validateField("name", "Café 2")).toBe("Café 2");
  });

  it.each([
    ["name", ""],
    ["name", "MyApp"],
    ["name", 'Say "hi"'],
    ["name", "a/b"],
    ["name", "Tide  Pool"],
    ["name", "x".repeat(51)],
    ["slug", "myapp"],
    ["slug", "Tide"],
    ["slug", "tide_pool"],
    ["slug", "-tide"],
    ["slug", "tide--pool"],
    ["slug", "2tide"],
    ["slug", "core"],
    ["slug", "test"],
    ["slug", "fn"],
    ["bundleId", "com.example.myapp"],
    ["bundleId", "tidepool"],
    ["bundleId", "com.example.tide_pool"],
    ["bundleId", "com..tide"],
    ["bundleId", "com.example.tide.app"],
    ["repo", "tomada1114/tauri-template"],
    ["repo", "ada"],
    ["repo", "ada/tide/pool"],
    ["repo", "-ada/tide"],
    ["repo", "ada/.."],
    ["author", ""],
    ["author", "Ada\u0007"],
    ["copyright", " "],
  ] as const)("refuses %s = %j", (field, value) => {
    const code = `ERR_BOOTSTRAP_INVALID_${field === "bundleId" ? "BUNDLE_ID" : field.toUpperCase()}`;
    expect(failure(() => validateField(field, value))).toMatch(new RegExp(`^${code}`));
  });

  it("accepts the values the smoke uses", () => {
    expect(validateField("slug", "tide-pool")).toBe("tide-pool");
    expect(validateField("bundleId", "com.example.tide-pool")).toBe("com.example.tide-pool");
    expect(validateField("repo", "ada-l/tide.pool")).toBe("ada-l/tide.pool");
    expect(validateField("author", " Ada Lovelace ")).toBe("Ada Lovelace");
  });
});

describe("deriveNames", () => {
  it("spells the slug for crates, Rust identifiers, and environment variables", () => {
    expect(deriveNames(ANSWERS)).toEqual({
      slug: "tide-pool",
      slugSnake: "tide_pool",
      slugUpper: "TIDE_POOL",
      owner: "ada",
      repoName: "tide-pool",
    });
  });
});

describe("collectAnswers", () => {
  const log = (): void => undefined;

  it("takes every value from the flags without asking when --yes is given", async () => {
    const { fake, questions } = terminal([]);
    const parsed = parseArgs([
      "--yes",
      "--name",
      "Tide Pool",
      "--slug",
      "tide-pool",
      "--bundle-id",
      "com.example.tide-pool",
      "--repo",
      "ada/tide-pool",
      "--author",
      "Ada Lovelace",
      "--copyright",
      "Ada Lovelace and contributors",
    ]);
    expect(await collectAnswers(parsed, fake, log)).toEqual(ANSWERS);
    expect(questions).toEqual([]);
  });

  it("fills the slug and copyright holder from their defaults when not interactive", async () => {
    const { fake } = terminal([], false);
    const parsed = parseArgs([
      "--name",
      "Tide Pool",
      "--bundle-id",
      "com.example.tide-pool",
      "--repo",
      "ada/tide-pool",
      "--author",
      "Ada Lovelace",
    ]);
    expect(await collectAnswers(parsed, fake, log)).toEqual({
      ...ANSWERS,
      copyright: "Ada Lovelace",
    });
  });

  it("names every missing flag when it cannot ask", async () => {
    const { fake } = terminal([], false);
    const error = await asyncFailure(() =>
      collectAnswers(parseArgs(["--name", "Tide Pool"]), fake, log),
    );
    expect(error).toMatch(/^ERR_BOOTSTRAP_MISSING_VALUE/);
    expect(error).toContain("--bundle-id, --repo, --author");
  });

  it("refuses an invalid flag value without asking", async () => {
    const { fake } = terminal([], false);
    expect(
      await asyncFailure(() => collectAnswers(parseArgs(["--slug", "Bad"]), fake, log)),
    ).toMatch(/^ERR_BOOTSTRAP_INVALID_SLUG/);
  });

  it("asks only for the missing values, offers defaults, re-asks after an invalid answer, and confirms", async () => {
    const lines: string[] = [];
    const { fake, questions } = terminal([
      "", // slug: take the default
      "not a bundle id",
      "com.example.tide-pool",
      "ada/tide-pool",
      "Ada Lovelace",
      "Ada Lovelace and contributors",
      "y",
    ]);
    const answers = await collectAnswers(parseArgs(["--name", "Tide Pool"]), fake, (line) =>
      lines.push(line),
    );
    expect(answers).toEqual(ANSWERS);
    expect(questions[0]).toContain("[tide-pool]");
    expect(questions.filter((q) => q.startsWith("Bundle identifier"))).toHaveLength(2);
    expect(lines.join("\n")).toMatch(/ERR_BOOTSTRAP_INVALID_BUNDLE_ID/);
    expect(questions.at(-1)).toMatch(/Rewrite this checkout/);
  });

  it("stops when the confirmation is declined or input ends", async () => {
    const all = [
      "--name",
      "Tide Pool",
      "--slug",
      "tide-pool",
      "--bundle-id",
      "com.example.tide-pool",
      "--repo",
      "ada/tide-pool",
      "--author",
      "Ada",
      "--copyright",
      "Ada",
    ];
    expect(
      await asyncFailure(() => collectAnswers(parseArgs(all), terminal(["n"]).fake, log)),
    ).toMatch(/^ERR_BOOTSTRAP_ABORTED/);
    expect(
      await asyncFailure(() =>
        collectAnswers(parseArgs(["--name", "Tide Pool"]), terminal([undefined]).fake, log),
      ),
    ).toMatch(/^ERR_BOOTSTRAP_ABORTED/);
  });

  it("gives up after three invalid answers", async () => {
    const { fake } = terminal(["Bad", "Bad", "Bad"]);
    expect(
      await asyncFailure(() => collectAnswers(parseArgs(["--name", "Tide Pool"]), fake, log)),
    ).toMatch(/^ERR_BOOTSTRAP_INVALID_SLUG/);
  });
});

describe("the site list", () => {
  it("names each file once, with known forms only", () => {
    const files = SITES.map((site) => site.file);
    expect(new Set(files).size).toBe(files.length);
    for (const site of SITES) {
      expect(site.forms.length).toBeGreaterThan(0);
      for (const form of site.forms) expect(Object.keys(FORM_SAMPLES)).toContain(form);
    }
  });

  it("keeps the two skill trees in step", () => {
    const agents = SITES.filter((s) => s.file.startsWith(".agents/skills/"));
    for (const site of agents) {
      const mirror = SITES.find((s) => s.file === site.file.replace(".agents/", ".claude/"));
      expect(mirror?.forms).toEqual(site.forms);
    }
  });

  it("removes itself, its verifier, and the template's design notes", () => {
    expect(REMOVED_PATHS).toEqual(
      expect.arrayContaining([
        "scripts/bootstrap.ts",
        "scripts/bootstrap.test.ts",
        "scripts/verify-bootstrap.ts",
        "scripts/verify-bootstrap.test.ts",
        "docs/template",
      ]),
    );
    expect(MARKER_FILES).toContain("README.md");
  });
});

describe("runBootstrap", () => {
  it("rewrites every site, renames the crates, and resets the history", () => {
    const root = templateTree();
    const { context: ctx, calls, lines } = context(root);
    runBootstrap(ctx, ANSWERS, { year: YEAR });

    expect(JSON.parse(read(root, "package.json"))).toEqual({
      name: "tide-pool",
      version: "0.1.0",
      description: "Tide Pool: a desktop app.",
      author: "Ada Lovelace",
      license: "MIT",
    });
    expect(read(root, "Cargo.toml")).toContain('version = "0.1.0" # one of the two');
    expect(read(root, "Cargo.toml")).toContain(
      'tide-pool-core = { path = "crates/tide-pool-core" }',
    );
    expect(read(root, "LICENSE")).toContain(
      `Copyright (c) ${String(YEAR)} Ada Lovelace and contributors\n`,
    );
    expect(read(root, "CHANGELOG.md")).toBe(
      "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n## [Unreleased]\n",
    );

    // Every slug spelling, where it occurs.
    const agents = read(root, "AGENTS.md");
    expect(agents).toContain("cargo test -p tide-pool-core && pkill -x tide-pool");
    expect(agents).toContain("use tide_pool_core::Counter; tide_pool_lib::run();");
    expect(agents).toContain("~/Library/Logs/com.example.tide-pool/");
    expect(read(root, "docs/architecture.md")).toContain("TIDE_POOL_SMOKE=1");
    // The Product section's introduction holds no marker of its own in an app.
    expect(agents).not.toContain("**TODO:");
    expect(agents).toContain("fails while one still holds its `TODO` marker");

    const readme = read(root, "README.md");
    expect(readme).not.toContain("template-only");
    expect(readme).not.toContain("just bootstrap");
    expect(readme).toContain("# Tide Pool\n\nIntro for Tide Pool.\n\n## Quickstart");
    expect(readme).toContain("git clone https://github.com/ada/tide-pool.git\ncd tide-pool\n");
    expect(readme).toContain("\n\n## License\n");
    expect(readme).not.toMatch(/\n\n\n/);

    const ci = read(root, ".github/workflows/ci.yml");
    expect(ci).not.toContain("bootstrap");
    expect(ci).toContain("cargo clippy --workspace\n\n  zizmor:\n");
    const ruleset = read(root, ".github/rulesets/main.json");
    expect(ruleset).not.toContain("Template Bootstrap Smoke");
    expect(() => JSON.parse(ruleset) as unknown).not.toThrow();
    const justfile = read(root, "justfile");
    expect(justfile).not.toContain("bootstrap");
    expect(justfile).toBe(
      'bundle_id := "com.example.tide-pool"\nlog_prefix := "tide-pool"\n\n# Build\nbuild:\n    cargo build -p tide-pool-cli\n',
    );

    for (const dir of CRATE_DIRS) {
      expect(existsSync(join(root, dir))).toBe(false);
      expect(existsSync(join(root, dir.replace("myapp", "tide-pool")))).toBe(true);
    }
    for (const removed of REMOVED_PATHS) expect(existsSync(join(root, removed))).toBe(false);
    for (const edit of TEXT_EDITS) {
      const file = edit.file.replace(/crates\/myapp-/, "crates/tide-pool-");
      if (existsSync(join(root, file))) expect(read(root, file)).not.toContain(edit.find);
    }

    // cargo fetch before anything is written, then the offline lockfile update and fmt.
    expect(calls.map((call) => [call.command, ...call.args].join(" "))).toEqual([
      "git rev-parse --is-inside-work-tree",
      "git status --porcelain",
      "cargo fetch --locked",
      "cargo update --workspace --offline",
      "cargo fmt --all",
      expect.stringMatching(/\/node_modules\/\.bin\/prettier --write --ignore-unknown /),
      "git ls-files -z --cached --others --exclude-standard",
    ]);
    expect(calls[5]?.command).toBe(join(root, "node_modules", ".bin", "prettier"));
    const prettier = calls[5]?.args ?? [];
    expect(prettier.slice(0, 2)).toEqual(["--write", "--ignore-unknown"]);
    expect(prettier).toContain("package.json");
    expect(prettier).not.toContain("README.md");
    for (const call of calls) expect(call.options?.cwd).toBe(root);

    const output = lines.join("\n");
    for (const step of [
      "AGENTS.md",
      "docs/architecture/roadmap.md",
      "steering-the-roadmap",
      "just install",
      "just labels",
      "add `dependencies` by hand",
      "just ruleset",
      "secret scanning",
      "Renovate",
      "push both commits to",
    ]) {
      expect(output).toContain(step);
    }
  });

  it("writes nothing when the tree is not the template", () => {
    const root = templateTree();
    writeFileSync(join(root, "justfile"), 'bundle_id := "com.acme.app"\n');
    const { context: ctx, calls } = context(root);
    expect(
      failure(() => {
        runBootstrap(ctx, ANSWERS, { year: YEAR });
      }),
    ).toMatch(/^ERR_BOOTSTRAP_NOT_TEMPLATE/);
    expect(calls).toEqual([]);
  });

  it("writes nothing when a listed site lost its placeholder", () => {
    const root = templateTree();
    writeFileSync(join(root, "AGENTS.md"), "no placeholders here\n");
    const before = read(root, "README.md");
    const { context: ctx, calls } = context(root);
    const error = failure(() => {
      runBootstrap(ctx, ANSWERS, { year: YEAR });
    });
    expect(error).toMatch(/^ERR_BOOTSTRAP_SITE_MISSING/);
    expect(error).toContain("AGENTS.md");
    expect(read(root, "README.md")).toBe(before);
    expect(calls).toEqual([]);
  });

  it("writes nothing when a text edit's anchor is gone", () => {
    const root = templateTree();
    const edit = TEXT_EDITS[0];
    if (edit === undefined) throw new Error("the plan has no text edits");
    writeFileSync(join(root, edit.file), read(root, edit.file).replace(edit.find, "changed"));
    const { context: ctx, calls } = context(root);
    expect(
      failure(() => {
        runBootstrap(ctx, ANSWERS, { year: YEAR });
      }),
    ).toMatch(/^ERR_BOOTSTRAP_SITE_MISSING/);
    expect(calls).toEqual([]);
  });

  it("writes nothing when a listed file holds a spelling its site does not list", () => {
    const root = templateTree();
    const site = SITES.find((s) => !s.forms.includes("slugUpper") && s.file.endsWith(".md"));
    if (site === undefined) throw new Error("no site without the upper-case form");
    writeFileSync(join(root, site.file), `${read(root, site.file)}MYAPP_LOG=1\n`);
    const { context: ctx } = context(root);
    const error = failure(() => {
      runBootstrap(ctx, ANSWERS, { year: YEAR });
    });
    expect(error).toMatch(/^ERR_BOOTSTRAP_SITE_INCOMPLETE/);
    expect(error).toContain(site.file);
  });

  it("writes nothing when a template-only block is left open", () => {
    const root = templateTree();
    writeFileSync(
      join(root, "README.md"),
      read(root, "README.md").replace("<!-- /template-only -->\n\n## Q", "\n## Q"),
    );
    const { context: ctx, calls } = context(root);
    expect(
      failure(() => {
        runBootstrap(ctx, ANSWERS, { year: YEAR });
      }),
    ).toMatch(/^ERR_BOOTSTRAP_MARKER/);
    expect(calls).toEqual([]);
  });

  it("writes nothing when the template-only CI job or its context is missing", () => {
    for (const [file, from] of [
      [".github/workflows/ci.yml", "  bootstrap-smoke:"],
      [".github/rulesets/main.json", '"Template Bootstrap Smoke"'],
      ["justfile", "bootstrap *args:"],
      ["justfile", "verify-bootstrap *args:"],
    ] as const) {
      const root = templateTree();
      writeFileSync(join(root, file), read(root, file).replace(from, "renamed"));
      const { context: ctx, calls } = context(root);
      expect(
        failure(() => {
          runBootstrap(ctx, ANSWERS, { year: YEAR });
        }),
      ).toMatch(/^ERR_BOOTSTRAP_SITE_MISSING/);
      expect(calls).toEqual([]);
    }
  });

  it("names the recipe the justfile lacks or repeats, and removes neither", () => {
    for (const [edit, actual] of [
      [
        (text: string) => text.replace("verify-bootstrap *args:", "renamed"),
        "0 copies of the verify-bootstrap recipe",
      ],
      [
        (text: string) => `${text}${text.slice(text.indexOf("\n# Turn the template"))}`,
        "2 copies of the bootstrap recipe",
      ],
    ] as const) {
      const root = templateTree();
      const before = edit(read(root, "justfile"));
      writeFileSync(join(root, "justfile"), before);
      const { context: ctx } = context(root);
      let caught: unknown;
      try {
        runBootstrap(ctx, ANSWERS, { year: YEAR });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toMatchObject({
        details: { code: "ERR_BOOTSTRAP_SITE_MISSING", actual },
      });
      expect(read(root, "justfile")).toBe(before);
    }
  });

  it("writes nothing when cargo cannot fetch the locked dependencies", () => {
    const root = templateTree();
    const before = read(root, "AGENTS.md");
    const { context: ctx } = context(root, (call) =>
      call.args[0] === "fetch" ? { status: 101, stderr: "network down" } : {},
    );
    expect(
      failure(() => {
        runBootstrap(ctx, ANSWERS, { year: YEAR });
      }),
    ).toMatch(/^ERR_BOOTSTRAP_FETCH/);
    expect(read(root, "AGENTS.md")).toBe(before);
  });

  it("reports a failed lockfile update and a failed format", () => {
    let root = templateTree();
    let run = context(root, (call) => (call.args[0] === "update" ? { status: 101 } : {}));
    expect(
      failure(() => {
        runBootstrap(run.context, ANSWERS, { year: YEAR });
      }),
    ).toMatch(/^ERR_BOOTSTRAP_LOCKFILE/);
    root = templateTree();
    run = context(root, (call) => (call.command.endsWith("prettier") ? { status: 2 } : {}));
    expect(
      failure(() => {
        runBootstrap(run.context, ANSWERS, { year: YEAR });
      }),
    ).toMatch(/^ERR_BOOTSTRAP_FORMAT/);
  });

  it("warns about a placeholder in a file the site list does not name", () => {
    const root = templateTree();
    write(root, "docs/new-page.md", "Run MyApp.\n");
    const { context: ctx, lines } = context(root, (call) =>
      call.args[0] === "ls-files" ? { stdout: "docs/new-page.md\0AGENTS.md\0" } : {},
    );
    runBootstrap(ctx, ANSWERS, { year: YEAR });
    expect(lines.join("\n")).toContain("docs/new-page.md:1: Run MyApp.");
  });
});

describe("findLeftovers", () => {
  it("finds every placeholder form and skips the upstream tracking link", () => {
    const root = mkdtempSync(join(tmpdir(), "leftovers-"));
    dirs.push(root);
    write(root, "a.md", "MyApp\nfine\nmyapp_core\nMYAPP_SMOKE\ncom.example.myapp\n");
    write(root, "b.md", "https://github.com/tomada1114/tauri-template\n");
    write(
      root,
      "osv-scanner.toml",
      "# Tracking issue: https://github.com/tomada1114/tauri-template/issues/3\n",
    );
    write(root, "bin.png", "\0myapp");
    expect(findLeftovers(root, ["a.md", "b.md", "osv-scanner.toml", "bin.png", "gone.md"])).toEqual(
      [
        "a.md:1: MyApp",
        "a.md:3: myapp_core",
        "a.md:4: MYAPP_SMOKE",
        "a.md:5: com.example.myapp",
        "b.md:1: https://github.com/tomada1114/tauri-template",
      ],
    );
  });
});

describe("main", () => {
  it("prints the usage for --help and changes nothing", async () => {
    const root = templateTree();
    const run = context(root);
    await main({ ...run.context, argv: ["--help"] }, terminal([], false).fake, { year: YEAR });
    expect(run.lines.join("\n")).toMatch(/^usage: node scripts\/bootstrap\.ts/);
    expect(run.calls).toEqual([]);
  });

  it("bootstraps from flags without a terminal", async () => {
    const root = templateTree();
    const run = context(root);
    await main(
      {
        ...run.context,
        argv: [
          "--yes",
          "--name",
          "Tide Pool",
          "--slug",
          "tide-pool",
          "--bundle-id",
          "com.example.tide-pool",
          "--repo",
          "ada/tide-pool",
          "--author",
          "Ada Lovelace",
          "--copyright",
          "Ada Lovelace and contributors",
        ],
      },
      terminal([], false).fake,
      { year: YEAR },
    );
    expect(read(root, "LICENSE")).toContain("Ada Lovelace and contributors");
  });

  it("keeps the template values in one place", () => {
    expect(TEMPLATE_VALUES.slug).toBe("myapp");
  });
});

describe("inputs refused before any write", () => {
  const CARGO_LOCK = `version = 4

[[package]]
name = "myapp-core"
version = "0.4.2"

[[package]]
name = "tauri"
version = "2.0.0"

[[package]]
name = "serde_json"
version = "1.0.0"

[[package]]
name = "serde"
version = "1.0.0"

[[package]]
name = "clap"
version = "4.0.0"
`;

  /** Run the bootstrap on a fresh template tree and return its first error line, the calls, and whether a file changed. */
  function refused(
    answers: Answers,
    answer?: (call: Call) => Partial<RunResult>,
  ): { error: string; commands: string[]; unchanged: boolean } {
    const root = templateTree();
    write(root, "Cargo.lock", CARGO_LOCK);
    // tracing is only in [workspace.dependencies], so that source is exercised too.
    write(
      root,
      "Cargo.toml",
      CARGO_TOML.replace(
        "\n\n[workspace.dependencies]\n",
        '\n\n[workspace.dependencies]\ntracing = "0.1"\n',
      ),
    );
    const before = read(root, "README.md");
    const run = context(root, answer);
    const error = failure(() => {
      runBootstrap(run.context, answers, { year: YEAR });
    });
    return {
      error: error.split("\n")[0] ?? "",
      commands: run.calls.map((call) => [call.command, ...call.args].join(" ")),
      unchanged:
        read(root, "README.md") === before &&
        CRATE_DIRS.every((dir) => existsSync(join(root, dir))),
    };
  }

  it("refuses a slug Cargo reserves, through the flags", () => {
    for (const slug of ["build", "deps", "examples", "incremental", "con"]) {
      expect(failure(() => validateField("slug", slug))).toMatch(/^ERR_BOOTSTRAP_INVALID_SLUG/);
    }
  });

  it("refuses a slug that names a dependency, or whose crates would, with nothing written", () => {
    for (const slug of ["tauri", "serde", "clap", "tracing", "serde-json"]) {
      const result = refused({ ...ANSWERS, slug });
      expect(result.error, slug).toMatch(/^ERR_BOOTSTRAP_INVALID_SLUG: /);
      expect(result.commands, slug).toEqual([]);
      expect(result.unchanged, slug).toBe(true);
    }
  });

  it("reads the dependency names from Cargo.lock and [workspace.dependencies], minus the template's crates", () => {
    const root = templateTree();
    write(root, "Cargo.lock", CARGO_LOCK);
    const names = dependencyNames(root);
    expect(names.has("tauri")).toBe(true);
    expect(names.has("serde-json")).toBe(true);
    expect(names.has("myapp-core")).toBe(false);
    expect(names.has("tide-pool")).toBe(false);
  });

  it("refuses a dirty work tree with ERR_BOOTSTRAP_DIRTY, before cargo runs or a file is written", () => {
    const result = refused(ANSWERS, (call) =>
      call.args[0] === "status" ? { stdout: " M README.md\n?? notes.txt\n" } : {},
    );
    expect(result.error).toMatch(/^ERR_BOOTSTRAP_DIRTY: /);
    expect(result.error).toContain("nothing was written");
    expect(result.commands).toEqual([
      "git rev-parse --is-inside-work-tree",
      "git status --porcelain",
    ]);
    expect(result.unchanged).toBe(true);
  });

  it("refuses when git status fails inside a work tree, instead of failing open", () => {
    const result = refused(ANSWERS, (call) =>
      call.args[0] === "status"
        ? { status: 128, stderr: "fatal: Unable to create '.git/index.lock': File exists.\n" }
        : {},
    );
    expect(result.error).toMatch(/^ERR_BOOTSTRAP_DIRTY: /);
    expect(result.error).toContain("cleanliness is unknown");
    expect(result.commands).toEqual([
      "git rev-parse --is-inside-work-tree",
      "git status --porcelain",
    ]);
    expect(result.unchanged).toBe(true);
  });

  it("runs outside a git work tree, where there is no status to check", () => {
    const root = templateTree();
    const run = context(root, (call) => (call.command === "git" ? { status: 128 } : {}));
    runBootstrap(run.context, ANSWERS, { year: YEAR });
    expect(run.lines.join("\n")).toContain("not a git work tree");
  });

  it("refuses a malformed bundle identifier, and one in Apple's namespace", () => {
    for (const id of ["-dev.example.x", "dev.example.x-", "1.2", "dev.-x.y", "com.apple.tide"]) {
      expect(
        failure(() => validateField("bundleId", id)),
        id,
      ).toMatch(/^ERR_BOOTSTRAP_INVALID_BUNDLE_ID/);
    }
    expect(validateField("bundleId", "dev.example.x1")).toBe("dev.example.x1");
  });

  it("refuses an answer containing a placeholder token, so the leftover scan keeps looking for it", () => {
    const cases: [Parameters<typeof validateField>[0], string, string][] = [
      ["slug", "x-myapp", "SLUG"],
      ["bundleId", "dev.example.myapp", "BUNDLE_ID"],
      ["repo", "someone/tauri-template", "REPO"],
      ["name", "MyApp Pro", "NAME"],
      ["author", "the myapp team", "AUTHOR"],
      ["copyright", "Tauri-Template Inc.", "COPYRIGHT"],
    ];
    for (const [field, value, code] of cases) {
      expect(
        failure(() => validateField(field, value)),
        value,
      ).toMatch(new RegExp(`^ERR_BOOTSTRAP_INVALID_${code}: `));
    }
    expect(validateField("author", "tomada1114")).toBe("tomada1114");
  });

  it("names just install on --help when the dependencies are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-nodeps-"));
    dirs.push(dir);
    cpSync(join(import.meta.dirname, "bootstrap.ts"), join(dir, "scripts", "bootstrap.ts"));
    cpSync(join(import.meta.dirname, "lib"), join(dir, "scripts", "lib"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
    const result = spawnSync(process.execPath, [join(dir, "scripts", "bootstrap.ts"), "--help"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    const [first = "", ...rest] = result.stderr.split("\n");
    expect(first).toMatch(/^ERR_BOOTSTRAP_NO_DEPS: /);
    expect(rest.join("\n")).toContain("just install");
  });
});

describe("processTerminal", () => {
  it("returns answers still queued after the input closes, without prompting a closed interface", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const term = processTerminal(input, output);
    input.write("Tide Pool\ntide-pool\n");
    input.end();
    expect(await term.ask("Name: ")).toBe("Tide Pool");
    expect(await term.ask("Slug: ")).toBe("tide-pool");
    expect(await term.ask("Bundle: ")).toBeUndefined();
    term.close?.();
  });

  it("consumes every answer when several arrive in one chunk, then reports the end of input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const shown: string[] = [];
    output.on("data", (chunk: Buffer) => shown.push(chunk.toString()));
    const term = processTerminal(input, output);
    expect(term.interactive).toBe(false);
    input.write("Tide Pool\ntide-pool\n");
    expect(await term.ask("Name: ")).toBe("Tide Pool");
    expect(await term.ask("Slug: ")).toBe("tide-pool");
    const pending = term.ask("Bundle: ");
    input.write("com.example.tide-pool\n");
    expect(await pending).toBe("com.example.tide-pool");
    const ended = term.ask("Repo: ");
    input.end();
    expect(await ended).toBeUndefined();
    expect(await term.ask("Author: ")).toBeUndefined();
    term.close?.();
    expect(shown.join("")).toContain("Name: ");
  });
});
