/**
 * Turns this template into a new app, once (design D19; `just bootstrap`). It asks for,
 * or takes as flags, the display name, the slug used for crate and binary names, the
 * bundle identifier, the GitHub owner/repo, the author, and the copyright holder, then:
 *
 * - rewrites an explicit list of placeholder sites — each a file and the spellings it
 *   carries (`MyApp`; the slug as `myapp` / `myapp-core`, `myapp_core` / `myapp_lib`, and
 *   `MYAPP_SMOKE`; `com.example.myapp`; the template's owner/repo) — never a global replace;
 * - renames `crates/myapp-*` to `crates/<slug>-*`, after `cargo fetch --locked`, and updates
 *   Cargo.lock offline (`cargo update --workspace --offline`);
 * - removes the `<!-- template-only -->` … `<!-- /template-only -->` blocks, `docs/template/`,
 *   the `Template Bootstrap Smoke` CI job and its required context, the `bootstrap` recipe
 *   and every mention of it, and the skill reference that only describes this script;
 * - resets CHANGELOG.md to an empty [Unreleased] and the three version sites to 0.1.0,
 *   writes the author into package.json and the copyright line into LICENSE;
 * - formats what it rewrote (`cargo fmt --all`, Prettier), deletes itself and
 *   scripts/verify-bootstrap.ts, and prints the next steps.
 *
 *   node scripts/bootstrap.ts [--name N] [--slug S] [--bundle-id ID] [--repo OWNER/REPO]
 *                             [--author A] [--copyright C] [--yes]
 *
 * A missing value is asked for on the terminal; with --yes, or when standard input is not
 * a terminal, a missing value takes its default (slug from the name, copyright holder from
 * the author) or fails. Every edit is computed and checked in memory before the first
 * write, so a drifted site list fails with nothing changed. In a git work tree it refuses
 * uncommitted or untracked changes, so the rewrite is the only change to review. Outside
 * one it still runs; only that check and the closing scan for placeholders outside the
 * site list are skipped.
 *
 * Errors: ERR_BOOTSTRAP_USAGE, ERR_BOOTSTRAP_MISSING_VALUE, ERR_BOOTSTRAP_INVALID_NAME,
 * ERR_BOOTSTRAP_INVALID_SLUG, ERR_BOOTSTRAP_INVALID_BUNDLE_ID, ERR_BOOTSTRAP_INVALID_REPO,
 * ERR_BOOTSTRAP_INVALID_AUTHOR, ERR_BOOTSTRAP_INVALID_COPYRIGHT, ERR_BOOTSTRAP_ABORTED,
 * ERR_BOOTSTRAP_NO_DEPS, ERR_BOOTSTRAP_NOT_TEMPLATE, ERR_BOOTSTRAP_DIRTY, ERR_BOOTSTRAP_SITE_MISSING, ERR_BOOTSTRAP_SITE_INCOMPLETE,
 * ERR_BOOTSTRAP_MARKER, ERR_BOOTSTRAP_REWRITE, ERR_BOOTSTRAP_FETCH, ERR_BOOTSTRAP_LOCKFILE,
 * ERR_BOOTSTRAP_FORMAT.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { ScriptError } from "./lib/fail.ts";
import { gitEnv } from "./lib/git-env.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

export interface Answers {
  readonly name: string;
  readonly slug: string;
  readonly bundleId: string;
  readonly repo: string;
  readonly author: string;
  readonly copyright: string;
}

export type Field = keyof Answers;

/** Where interactive answers come from; a test passes a fake. */
export interface Terminal {
  readonly interactive: boolean;
  /** The answer, or undefined when input has ended. */
  readonly ask: (question: string) => Promise<string | undefined>;
  readonly close?: () => void;
}

export interface ParsedArgs {
  readonly values: Partial<Answers>;
  readonly yes: boolean;
  readonly help: boolean;
}

/** The slug in each spelling a site needs, and the owner/repo halves. */
export interface Names {
  readonly slug: string;
  readonly slugSnake: string;
  readonly slugUpper: string;
  readonly owner: string;
  readonly repoName: string;
}

/** A spelling of a placeholder, as a site carries it. */
export type Form =
  "bundleId" | "repo" | "repoName" | "owner" | "name" | "slugSnake" | "slug" | "slugUpper";

/** A file and the placeholder spellings it carries. */
export interface Site {
  readonly file: string;
  readonly forms: readonly Form[];
}

/** An exact passage that reads wrongly in an app, and what replaces it. */
export interface TextEdit {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

/** The TOML and YAML parsers, imported on first use so a missing install fails as ERR_BOOTSTRAP_NO_DEPS. */
interface Parsers {
  readonly toml: (text: string) => unknown;
  readonly yaml: (text: string) => unknown;
}

let parsers: Parsers | undefined;

function noDeps(actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_BOOTSTRAP_NO_DEPS",
    summary: "the bootstrap's dependencies are not installed",
    expected: "smol-toml and yaml in node_modules",
    actual,
    next: "run `just install`, then the bootstrap again",
  });
}

/** Import the parsers (idempotent); fails with ERR_BOOTSTRAP_NO_DEPS before `just install`. */
export async function loadParsers(): Promise<void> {
  if (parsers !== undefined) return;
  try {
    const [toml, yaml] = await Promise.all([import("smol-toml"), import("yaml")]);
    parsers = { toml: (text) => toml.parse(text), yaml: (text) => yaml.parse(text) as unknown };
  } catch (error: unknown) {
    if ((error as { code?: unknown } | null)?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw noDeps(error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
  }
}

function loaded(): Parsers {
  if (parsers === undefined) throw noDeps("the parsers were never loaded (call loadParsers first)");
  return parsers;
}

const parseToml = (text: string): unknown => loaded().toml(text);
const parseYaml = (text: string): unknown => loaded().yaml(text);

/** The template's own values: what each placeholder site holds before the bootstrap. */
export const TEMPLATE_VALUES: Answers = {
  name: "MyApp",
  slug: "myapp",
  bundleId: "com.example.myapp",
  repo: "tomada1114/tauri-template",
  author: "tomada1114",
  copyright: "tomada1114",
};

/**
 * Each form's pattern, applied in this order (the bundle identifier and the owner/repo
 * contain shorter placeholders, so they go first). A pattern matches the placeholder as
 * a whole token only, so a longer word that merely contains it is never touched.
 */
const FORMS: readonly (readonly [Form, RegExp, (answers: Answers, names: Names) => string])[] = [
  ["bundleId", /(?<![A-Za-z0-9.-])com\.example\.myapp(?![A-Za-z0-9-])/g, (a) => a.bundleId],
  ["repo", /(?<![A-Za-z0-9-])tomada1114\/tauri-template(?![A-Za-z0-9_-])/g, (a) => a.repo],
  ["repoName", /(?<![A-Za-z0-9_/.-])tauri-template(?![A-Za-z0-9_-])/g, (_a, n) => n.repoName],
  ["owner", /(?<![A-Za-z0-9-])tomada1114(?![A-Za-z0-9/-])/g, (_a, n) => n.owner],
  ["name", /(?<![A-Za-z0-9])MyApp(?![A-Za-z0-9])/g, (a) => a.name],
  ["slugSnake", /(?<![A-Za-z0-9])myapp(?=_)/g, (_a, n) => n.slugSnake],
  ["slug", /(?<![A-Za-z0-9.])myapp(?![A-Za-z0-9_])/g, (_a, n) => n.slug],
  ["slugUpper", /(?<![A-Za-z0-9])MYAPP(?![A-Za-z0-9])/g, (_a, n) => n.slugUpper],
];

/** The skill files carrying a placeholder; each is listed for both skill trees. */
const SKILL_SITES: readonly (readonly [string, readonly Form[]])[] = [
  ["building-react-screens/SKILL.md", ["slug"]],
  ["changing-gates/SKILL.md", ["slug"]],
  ["changing-gates/references/gate-files.md", ["slug"]],
  ["changing-gates/references/weakening.md", ["slug"]],
  ["create-pr/SKILL.md", ["slug"]],
  ["designing-core-logic/SKILL.md", ["slug"]],
  ["designing-errors/SKILL.md", ["slug"]],
  ["designing-ipc/SKILL.md", ["slug"]],
  ["designing-ipc/references/adding-a-command.md", ["slugSnake", "slug"]],
  ["integrating-system-apis/SKILL.md", ["slug"]],
  ["integrating-system-apis/references/unsafe-and-ffi.md", ["slug"]],
  ["managing-dependencies/SKILL.md", ["slug"]],
  ["placing-tests/SKILL.md", ["slug"]],
  ["recording-architecture-decisions/SKILL.md", ["slug"]],
  ["running-the-app/SKILL.md", ["bundleId", "name", "slugSnake", "slug", "slugUpper"]],
  ["shipping-issues/references/agent-implementation.md", ["slug"]],
  ["shipping-issues/references/closing-out.md", ["slug"]],
  ["shipping-issues/references/cost-discipline.md", ["slug"]],
  ["shipping-issues/references/dependency-triage.md", ["slug"]],
  ["shipping-issues/references/pr-ci-merge.md", ["slug"]],
  ["shipping-issues/references/priority-rubric.md", ["slug"]],
  ["shipping-issues/references/ship-contract.md", ["slug"]],
  ["starting-an-app/references/app-shapes.md", ["slug"]],
  ["tdd/SKILL.md", ["slug"]],
  ["triaging-issues/SKILL.md", ["slug"]],
  ["updating-docs/SKILL.md", ["slug"]],
  ["writing-rust/SKILL.md", ["slug"]],
  ["writing-rust/references/compiler-errors.md", ["slugSnake", "slug"]],
  ["writing-tests/SKILL.md", ["slug"]],
  ["writing-tests/references/patterns.md", ["slug"]],
];

const bothSkillTrees = (path: string): string[] => [
  `.agents/skills/${path}`,
  `.claude/skills/${path}`,
];

/**
 * Every placeholder site outside the skills. Keep this list explicit: a new file that
 * names the app is added here, and `node scripts/verify-bootstrap.ts` (which CI's
 * Template Bootstrap Smoke runs) fails on a placeholder in a file this list does not name.
 */
const REPOSITORY_SITES: readonly Site[] = [
  { file: ".claude/rules/project.md", forms: ["slug"] },
  { file: ".claude/rules/rust.md", forms: ["slugSnake", "slug"] },
  { file: ".claude/rules/testing.md", forms: ["slug"] },
  { file: ".gitattributes", forms: ["slug"] },
  { file: ".github/ISSUE_TEMPLATE/bug_report.yml", forms: ["bundleId"] },
  { file: ".github/ISSUE_TEMPLATE/config.yml", forms: ["repo"] },
  { file: ".github/PULL_REQUEST_TEMPLATE.md", forms: ["slug"] },
  { file: ".github/workflows/ci.yml", forms: ["slug"] },
  { file: ".github/workflows/release.yml", forms: ["name"] },
  { file: "AGENTS.md", forms: ["bundleId", "slugSnake", "slug", "slugUpper"] },
  { file: "CODE_OF_CONDUCT.md", forms: ["owner"] },
  { file: "CONTRIBUTING.md", forms: ["slug"] },
  { file: "Cargo.toml", forms: ["slug"] },
  { file: "README.md", forms: ["bundleId", "repo", "repoName", "name", "slug", "slugUpper"] },
  { file: "SECURITY.md", forms: ["repo"] },
  { file: "clippy.toml", forms: ["slug"] },
  { file: "crates/myapp-cli/Cargo.toml", forms: ["slug"] },
  { file: "crates/myapp-cli/src/main.rs", forms: ["slugSnake", "slug"] },
  { file: "crates/myapp-cli/tests/cli.rs", forms: ["bundleId", "slug"] },
  { file: "crates/myapp-core/Cargo.toml", forms: ["name", "slug"] },
  { file: "crates/myapp-core/src/counter/mod.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-core/src/lib.rs", forms: ["slug"] },
  { file: "crates/myapp-core/src/log.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-core/tests/contracts.rs", forms: ["slugSnake", "slug"] },
  { file: "crates/myapp-core/tests/counter_service.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-core/tests/serialization.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-platform/Cargo.toml", forms: ["slug"] },
  { file: "crates/myapp-platform/src/clock.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-platform/src/counter_store.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-platform/src/lib.rs", forms: ["slug"] },
  { file: "crates/myapp-platform/src/paths.rs", forms: ["bundleId"] },
  { file: "crates/myapp-platform/tests/contracts.rs", forms: ["slugSnake", "slug"] },
  { file: "crates/myapp-platform/tests/json_file_counter_store.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-platform/tests/logging.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-test-support/Cargo.toml", forms: ["slug"] },
  { file: "crates/myapp-test-support/src/clock.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-test-support/src/counter_store.rs", forms: ["slugSnake"] },
  { file: "crates/myapp-test-support/src/lib.rs", forms: ["slug"] },
  { file: "deny.toml", forms: ["slug"] },
  { file: "docs/architecture.md", forms: ["bundleId", "name", "slugSnake", "slug", "slugUpper"] },
  { file: "docs/distribution.md", forms: ["repo", "name", "slug"] },
  { file: "docs/getting-started.md", forms: ["bundleId", "slug"] },
  { file: "justfile", forms: ["bundleId", "name", "slug"] },
  { file: "package.json", forms: ["name", "slug"] },
  { file: "scripts/bindings.ts", forms: ["slug"] },
  { file: "scripts/build-sidecar.test.ts", forms: ["slug"] },
  { file: "scripts/build-sidecar.ts", forms: ["slug"] },
  { file: "scripts/checks/bundle-identifier.test.ts", forms: ["bundleId", "name", "slug"] },
  { file: "scripts/checks/bundle-identifier.ts", forms: ["slug"] },
  { file: "scripts/checks/core-boundary.test.ts", forms: ["slug"] },
  { file: "scripts/checks/core-boundary.ts", forms: ["slug"] },
  { file: "scripts/checks/fixtures/core-boundary/pass/deny.toml", forms: ["slug"] },
  {
    file: "scripts/checks/fixtures/core-boundary/pass/metadata.json",
    forms: ["slugSnake", "slug"],
  },
  { file: "scripts/checks/just-check-matches-ci.ts", forms: ["slug"] },
  { file: "scripts/checks/tauri-versions.test.ts", forms: ["slug"] },
  { file: "scripts/checks/version-sites.test.ts", forms: ["name", "slug"] },
  { file: "scripts/smoke.test.ts", forms: ["bundleId", "name", "slugSnake", "slug", "slugUpper"] },
  { file: "scripts/smoke.ts", forms: ["bundleId", "name", "slug", "slugUpper"] },
  { file: "src-tauri/Cargo.toml", forms: ["slugSnake", "slug"] },
  { file: "src-tauri/src/commands.rs", forms: ["slugSnake"] },
  { file: "src-tauri/src/lib.rs", forms: ["slugSnake", "slug", "slugUpper"] },
  { file: "src-tauri/src/main.rs", forms: ["slugSnake"] },
  { file: "src-tauri/src/startup.rs", forms: ["slugUpper"] },
  { file: "src-tauri/tauri.conf.json", forms: ["bundleId", "name", "slug"] },
  { file: "src-tauri/tests/commands.rs", forms: ["slugSnake"] },
  { file: "src-tauri/tests/startup.rs", forms: ["slugSnake"] },
  { file: "ui/index.html", forms: ["name"] },
];

export const SITES: readonly Site[] = [
  ...REPOSITORY_SITES,
  ...SKILL_SITES.flatMap(([path, forms]) =>
    bothSkillTrees(path).map((file): Site => ({ file, forms })),
  ),
].sort((a, b) => a.file.localeCompare(b.file));

const STARTING_AN_APP_DESCRIPTION = `description: >
  Covers turning this template into a new app and its first decisions: just bootstrap
  (scripts/bootstrap.ts), its prompts or flags (display name, slug, bundle identifier,
  owner/repo, author, copyright holder), the placeholders it rewrites (MyApp, myapp,
  myapp-core, MYAPP_SMOKE, com.example.myapp), scripts/verify-bootstrap.ts and the
  Template Bootstrap Smoke job; AGENTS.md's Product section and the roadmap; the design
  system first (design-lock ADR, ui/src/design/tokens.css); the app shape, a window or
  a menu-bar agent (ActivationPolicy::Accessory, tray-icon, no Dock icon); the sandbox
  posture; the first ADRs; removing the sample counter; just labels, just ruleset, the
  GitHub security settings, and private-repository steps. Use when starting an app from
  this repository, running or changing the bootstrap, a placeholder survived the
  rename, just check-harness fails on the Product section, or setting up a repository
  created from the template.
`;

const STARTING_AN_APP_DESCRIPTION_IN_AN_APP = `description: >
  Covers the first decisions of this app, cut from the template by its bootstrap:
  AGENTS.md's Product section and the roadmap; the design system first (design-lock
  ADR, ui/src/design/tokens.css); the app shape, a window or a menu-bar agent
  (ActivationPolicy::Accessory, tray-icon, no Dock icon); the sandbox posture; the
  first ADRs; removing the sample counter; just labels, just ruleset, the GitHub
  security settings, and private-repository steps. Use when starting the app's first
  feature, a name the rename missed turns up, just check-harness fails on the Product
  section, or setting up the repository on GitHub.
`;

const STARTING_AN_APP_RENAME_STEP = `2. **Rename.** \`just bootstrap\` rewrites the repository, so it is a human's step (an
   agent runs it only when asked). It prompts for, or takes as flags, the display name
   (\`MyApp\`), the slug used for crate and binary names (\`myapp\`), the bundle identifier
   (\`com.example.myapp\`), the GitHub \`owner/repo\`, the author, and the copyright holder.
   **REQUIRED:** [references/bootstrap.md](references/bootstrap.md) before running it
   again, changing it, or chasing a leftover placeholder.
`;

const STARTING_AN_APP_RENAME_DONE = `2. **Rename.** Done: the bootstrap rewrote the template's placeholders to this app's
   names, removed the template-only material, and deleted itself. A name it missed is
   fixed by hand, in every spelling (hyphenated, underscored, upper-case).
`;

/**
 * Passages that name this script, its recipe, or `docs/template/`, and so would dangle
 * in an app. Each `find` must occur exactly once, in the template's spelling; the form
 * rewrite runs after these edits.
 */
export const TEXT_EDITS: readonly TextEdit[] = [
  {
    file: "AGENTS.md",
    find: `Fill in every \`TODO:\` below right after the rename
(\`README.md\`'s "Using This Template") — once \`scripts/bootstrap.ts\` has run,
\`just check-harness\` fails while one is left.`,
    replace: `Fill in every \`TODO:\` below now: the bootstrap has run,
so \`just check-harness\` fails while one is left.`,
  },
  {
    file: "AGENTS.md",
    find: "just bootstrap  # Turn the template into a new app (renames, removes template-only files)\n",
    replace: "",
  },
  {
    file: "AGENTS.md",
    find: "(`com.example.myapp` until the bootstrap renames it)",
    replace: "(`com.example.myapp`)",
  },
  {
    file: "AGENTS.md",
    find: "stays a `TODO:` skeleton in the template and holds no `TODO:` once `scripts/bootstrap.ts` has run |",
    replace: "holds no `TODO:` |",
  },
  { file: "AGENTS.md", find: "`release-prep`, `bootstrap`)", replace: "`release-prep`)" },
  ...bothSkillTrees("starting-an-app/SKILL.md").flatMap((file): TextEdit[] => [
    {
      file,
      find: STARTING_AN_APP_DESCRIPTION,
      replace: STARTING_AN_APP_DESCRIPTION_IN_AN_APP,
    },
    { file, find: STARTING_AN_APP_RENAME_STEP, replace: STARTING_AN_APP_RENAME_DONE },
  ]),
  ...bothSkillTrees("authoring-skills/SKILL.md").flatMap((file): TextEdit[] => [
    {
      file,
      find: "names an owner or credits a source stays bare. Never point at `docs/template/`: the\nbootstrap deletes it.\n",
      replace: "names an owner or credits a source stays bare.\n",
    },
    {
      file,
      find: "or test depends on a skill's code block. Write placeholder names exactly (`myapp-core`,\n`MyApp`, `com.example.myapp`, `MYAPP_SMOKE`) so the bootstrap's rename finds them.\n",
      replace: "or test depends on a skill's code block.\n",
    },
  ]),
  ...bothSkillTrees("authoring-skills/references/convention-examples.md").map((file): TextEdit => ({
    file,
    find: "at a glance); a link to\n`docs/template/` (gone after the bootstrap).",
    replace: "at a glance).",
  })),
  ...bothSkillTrees("updating-docs/SKILL.md").map((file): TextEdit => ({
    file,
    find: "rejects, how the\ntemplate becomes an app (`just bootstrap`), how a release is built and signed, and",
    replace: "rejects, how a\nrelease is built and signed, and",
  })),
  {
    file: "osv-scanner.toml",
    find: "# Every entry expires after 90 days and is recorded in docs/template/implementation-notes.md.\n",
    replace: "# Every entry expires after 90 days.\n",
  },
  {
    file: "pnpm-workspace.yaml",
    find: "# Recorded in docs/template/implementation-notes.md.\n",
    replace: "",
  },
];

/** Files carrying `<!-- template-only -->` … `<!-- /template-only -->` blocks. */
export const MARKER_FILES: readonly string[] = ["README.md"];

/** Removed from the app: the template's design notes, and this script and its verifier. */
export const REMOVED_PATHS: readonly string[] = [
  "docs/template",
  ...bothSkillTrees("starting-an-app/references/bootstrap.md"),
  "scripts/verify-bootstrap.test.ts",
  "scripts/verify-bootstrap.ts",
  "scripts/bootstrap.test.ts",
  "scripts/bootstrap.ts",
];

/** The crate directories named after the slug; each becomes `crates/<slug>-<suffix>`. */
export const CRATE_DIRS: readonly string[] = [
  "crates/myapp-cli",
  "crates/myapp-core",
  "crates/myapp-platform",
  "crates/myapp-test-support",
];

/**
 * Mentions of the template repository an app keeps on purpose: an upstream issue that
 * tracks an advisory ignored in osv-scanner.toml.
 */
export const UPSTREAM_REFERENCES: readonly (readonly [string, string])[] = [
  ["osv-scanner.toml", "https://github.com/tomada1114/tauri-template/issues/"],
];

const CI_FILE = ".github/workflows/ci.yml";
const RELEASE_FILE = ".github/workflows/release.yml";
const CI_JOB_KEY = "  bootstrap-smoke:";
const RULESET_FILE = ".github/rulesets/main.json";
export const SMOKE_JOB_NAME = "Template Bootstrap Smoke";
const RULESET_ENTRY =
  /^[ \t]*\{ "context": "Template Bootstrap Smoke", "integration_id": \d+ \},?[ \t]*\n/gm;
const JUSTFILE_RECIPE = `
# Turn the template into a new app: rename its placeholders and remove the template-only material (a human's step, run once)
[positional-arguments]
bootstrap *args:
    node scripts/bootstrap.ts "$@"
`;
const CARGO_VERSION = /^(\[workspace\.package\][^[]*?^version\s*=\s*")([^"]*)(")/m;
const JSON_VERSION = /("version"\s*:\s*")[^"]*(")/;
const LICENSE_LINE = /^Copyright \(c\) \d{4} tomada1114$/gm;
const PACKAGE_AUTHOR = /"author": "tomada1114"/g;
const UNRELEASED = /^##\s*\[Unreleased\]\s*$/;
const START_MARKER = "<!-- template-only -->";
const END_MARKER = "<!-- /template-only -->";
const FIRST_VERSION = "0.1.0";

const LEFTOVER_TOKENS = ["myapp", "tomada1114", "tauri-template"] as const;

interface FieldSpec {
  readonly field: Field;
  readonly flag: string;
  readonly label: string;
}

const FIELDS: readonly FieldSpec[] = [
  { field: "name", flag: "--name", label: "Display name (e.g. Tide Pool)" },
  { field: "slug", flag: "--slug", label: "Slug for crate and binary names" },
  {
    field: "bundleId",
    flag: "--bundle-id",
    label: "Bundle identifier (e.g. com.example.tide-pool)",
  },
  { field: "repo", flag: "--repo", label: "GitHub owner/repo" },
  { field: "author", flag: "--author", label: "Author" },
  { field: "copyright", flag: "--copyright", label: "Copyright holder" },
];

const USAGE = `usage: node scripts/bootstrap.ts [--name NAME] [--slug SLUG] [--bundle-id ID]
                                [--repo OWNER/REPO] [--author AUTHOR]
                                [--copyright HOLDER] [--yes]

Turns this template into a new app, once. A missing value is asked for on a terminal;
with --yes (or without a terminal) the slug defaults to the name and the copyright
holder to the author, and any other missing value is an error. Quote a value with
spaces, through just or node alike.`;

function usageError(summary: string, actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_BOOTSTRAP_USAGE",
    summary,
    expected: "only the flags in the usage line, each value flag followed by its value",
    actual,
    next: "run `node scripts/bootstrap.ts --help`; quote a value with spaces",
  });
}

/** The flags on the command line; values are validated later, in {@link collectAnswers}. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values: Partial<Record<Field, string>> = {};
  let yes = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const [flag = "", inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg];
    const spec = FIELDS.find((candidate) => candidate.flag === flag);
    if (spec === undefined) {
      if (arg.startsWith("-")) throw usageError(`unknown flag '${flag}'`, `argument '${arg}'`);
      throw usageError(
        `unexpected argument '${arg}'`,
        `'${arg}' follows no flag (an unquoted value with spaces splits into words)`,
      );
    }
    let value = inline;
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usageError(`${flag} needs a value`, `${flag} with no value`);
      }
      i += 1;
    }
    if (values[spec.field] !== undefined) {
      throw usageError(`${flag} is given twice`, `${flag} repeated`);
    }
    values[spec.field] = value;
  }
  return { values, yes, help };
}

function invalid(field: Field, value: string, expected: string, next?: string): ScriptError {
  const spec = FIELDS.find((candidate) => candidate.field === field);
  const code = `ERR_BOOTSTRAP_INVALID_${field === "bundleId" ? "BUNDLE_ID" : field.toUpperCase()}`;
  return new ScriptError({
    code,
    summary: `${JSON.stringify(value)} is not a valid ${spec?.label.replace(/ \(e\.g\..*\)$/, "").toLowerCase() ?? field}`,
    expected,
    actual: JSON.stringify(value),
    next: next ?? `pass ${spec?.flag ?? field} again with a value that fits`,
  });
}

/**
 * Rust keywords and names Cargo refuses as a package or binary name: the built-in
 * crates, the directories Cargo keeps in target/ (`build`, `deps`, `examples`,
 * `incremental`), and Windows' reserved file names.
 */
const RESERVED_SLUGS = new Set(
  "abstract alloc as async await become box break const continue core crate do dyn else enum extern false final fn for gen if impl in let loop macro match mod move mut override priv proc-macro pub ref return self static std struct super test trait true try type typeof union unsafe unsized use virtual where while yield build deps examples incremental con prn aux nul com1 com2 com3 com4 com5 com6 com7 com8 com9 lpt1 lpt2 lpt3 lpt4 lpt5 lpt6 lpt7 lpt8 lpt9".split(
    " ",
  ),
);

/** Placeholder tokens an answer may not contain: the leftover scan would stop looking for them. */
const FORBIDDEN_TOKENS = ["myapp", "tauri-template"] as const;

/** True when the value holds a control character (a newline, a tab, a bell…). */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The value, trimmed, when it is valid for `field`; otherwise an ERR_BOOTSTRAP_INVALID_* error. */
export function validateField(field: Field, raw: string): string {
  const value = raw.trim();
  switch (field) {
    case "name":
      if (
        !/^[\p{L}\p{N}](?:[\p{L}\p{N} .-]*[\p{L}\p{N}])?$/u.test(value) ||
        value.includes("  ") ||
        value.length > 50
      ) {
        throw invalid(
          field,
          value,
          "1-50 letters, digits, spaces, hyphens, or periods, starting and ending with a letter or digit (it becomes the .app name and the window title)",
        );
      }
      return withoutPlaceholder(field, value);
    case "slug":
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) || value.length > 40) {
        throw invalid(
          field,
          value,
          "lower-case words of letters and digits joined by single hyphens, starting with a letter, at most 40 characters (e.g. tide-pool)",
        );
      }
      if (RESERVED_SLUGS.has(value)) {
        throw invalid(
          field,
          value,
          "a name that is not a Rust keyword, a built-in crate, or a name Cargo reserves",
        );
      }
      return withoutPlaceholder(field, value);
    case "bundleId":
      if (
        !/^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
          value,
        ) ||
        value.length > 155
      ) {
        throw invalid(
          field,
          value,
          "reverse-DNS: two or more dot-separated parts of letters, digits, and hyphens, the first starting with a letter and no part starting or ending with a hyphen (e.g. com.example.tide-pool)",
        );
      }
      if (/^com\.apple\./i.test(value)) {
        throw invalid(field, value, "an identifier outside Apple's com.apple namespace");
      }
      if (value.toLowerCase().endsWith(".app")) {
        throw invalid(
          field,
          value,
          "an identifier that does not end in .app (it clashes with the bundle extension)",
        );
      }
      return withoutPlaceholder(field, value);
    case "repo": {
      const match =
        /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/.exec(value);
      if (match === null || match[2] === "." || match[2] === ".." || value.endsWith(".git")) {
        throw invalid(field, value, "OWNER/REPO as GitHub spells it (e.g. ada/tide-pool)");
      }
      return withoutPlaceholder(field, value);
    }
    case "author":
    case "copyright":
      if (value === "" || value.length > 100 || hasControl(value)) {
        throw invalid(field, value, "1-100 printable characters on one line");
      }
      return withoutPlaceholder(field, value);
  }
}

function withoutPlaceholder(field: Field, value: string): string {
  const token = FORBIDDEN_TOKENS.find((candidate) => value.toLowerCase().includes(candidate));
  if (token !== undefined) {
    throw invalid(
      field,
      value,
      `a value that does not contain the template's placeholder "${token}" (the scan for leftover placeholders looks for it)`,
    );
  }
  return value;
}

/** The slug in every spelling a site needs, and the two halves of owner/repo. */
export function deriveNames(answers: Answers): Names {
  const [owner = "", repoName = ""] = answers.repo.split("/");
  return {
    slug: answers.slug,
    slugSnake: answers.slug.replaceAll("-", "_"),
    slugUpper: answers.slug.replaceAll("-", "_").toUpperCase(),
    owner,
    repoName,
  };
}

/** The slug a display name suggests: "Tide Pool" -> "tide-pool". */
function slugFrom(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function defaultFor(field: Field, values: Partial<Record<Field, string>>): string | undefined {
  if (field === "slug" && values.name !== undefined) {
    const slug = slugFrom(values.name);
    return /^[a-z]/.test(slug) ? slug : undefined;
  }
  if (field === "copyright") return values.author;
  return undefined;
}

const ATTEMPTS = 3;

function aborted(actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_BOOTSTRAP_ABORTED",
    summary: "the bootstrap was stopped before it changed anything",
    expected: "an answer to every question and a yes to the confirmation",
    actual,
    next: "run `just bootstrap` again, or pass every value as a flag with --yes",
  });
}

/**
 * Every answer: from its flag, else (on a terminal without --yes) from a question, else
 * from its default. On a terminal it shows the values and asks before anything changes.
 */
export async function collectAnswers(
  parsed: ParsedArgs,
  terminal: Terminal,
  log: (line: string) => void,
): Promise<Answers> {
  const interactive = terminal.interactive && !parsed.yes;
  const values: Partial<Record<Field, string>> = {};
  const missing: string[] = [];
  for (const { field, flag, label } of FIELDS) {
    const given = parsed.values[field];
    const fallback = defaultFor(field, values);
    if (given !== undefined) {
      values[field] = validateField(field, given);
    } else if (!interactive) {
      if (fallback === undefined) missing.push(flag);
      else values[field] = validateField(field, fallback);
    } else {
      values[field] = await ask(terminal, field, label, fallback, log);
    }
  }
  if (missing.length > 0) {
    throw new ScriptError({
      code: "ERR_BOOTSTRAP_MISSING_VALUE",
      summary: `no value for ${missing.join(", ")}`,
      expected: "every value as a flag when the bootstrap cannot ask (--yes, or no terminal)",
      actual: `missing: ${missing.join(", ")}`,
      next: "pass the missing flags, or run `just bootstrap` on a terminal to be asked",
    });
  }
  const answers: Answers = {
    name: values.name ?? "",
    slug: values.slug ?? "",
    bundleId: values.bundleId ?? "",
    repo: values.repo ?? "",
    author: values.author ?? "",
    copyright: values.copyright ?? "",
  };
  if (interactive) {
    log("");
    for (const { field, label } of FIELDS)
      log(`  ${label.replace(/ \(e\.g\..*\)$/, "")}: ${answers[field]}`);
    const confirm = await terminal.ask("Rewrite this checkout with these values? [y/N] ");
    if (confirm === undefined || !/^y(es)?$/i.test(confirm.trim())) {
      throw aborted(
        confirm === undefined ? "input ended" : `the answer ${JSON.stringify(confirm)}`,
      );
    }
  }
  return answers;
}

async function ask(
  terminal: Terminal,
  field: Field,
  label: string,
  fallback: string | undefined,
  log: (line: string) => void,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const answer = await terminal.ask(
      `${label}${fallback === undefined ? "" : ` [${fallback}]`}: `,
    );
    if (answer === undefined) throw aborted("input ended");
    const value = answer.trim() === "" && fallback !== undefined ? fallback : answer;
    try {
      return validateField(field, value);
    } catch (error: unknown) {
      if (!(error instanceof ScriptError)) throw error;
      log(`${error.message} — expected ${error.details.expected}`);
      lastError = error;
    }
  }
  throw lastError;
}

function leftoverPattern(tokens: readonly string[]): RegExp | undefined {
  return tokens.length === 0 ? undefined : new RegExp(tokens.join("|"), "i");
}

function leftoverLines(file: string, text: string, pattern: RegExp): string[] {
  const upstream = UPSTREAM_REFERENCES.filter(([path]) => path === file).map(([, url]) => url);
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    const scrubbed = upstream.reduce((rest, url) => rest.replaceAll(url, ""), line);
    if (pattern.test(scrubbed)) found.push(`${file}:${String(index + 1)}: ${line.trim()}`);
  });
  return found;
}

/** The tokens that still mean "placeholder" for these answers (a user may legitimately be the template's owner). */
function tokensFor(answers: Answers | undefined): string[] {
  if (answers === undefined) return [...LEFTOVER_TOKENS];
  const given = Object.values(answers).join("\n").toLowerCase();
  return LEFTOVER_TOKENS.filter((token) => !given.includes(token));
}

/**
 * Every line of `files` (paths under `root`) that still names a template placeholder in
 * any spelling, as `path:line: text`. Missing and binary files are skipped, and so is an
 * upstream reference an app keeps on purpose ({@link UPSTREAM_REFERENCES}).
 */
export function findLeftovers(root: string, files: readonly string[], answers?: Answers): string[] {
  const pattern = leftoverPattern(tokensFor(answers));
  if (pattern === undefined) return [];
  const found: string[] = [];
  for (const file of files) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue; // a directory, or unreadable: nothing to scan
    }
    if (text.includes("\0")) continue;
    found.push(...leftoverLines(file, text, pattern));
  }
  return found;
}

function siteMissing(file: string, actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_BOOTSTRAP_SITE_MISSING",
    summary: `the site list no longer matches ${file}; nothing was written`,
    expected: `${file} to hold what scripts/bootstrap.ts lists for it`,
    actual,
    next: "update the site in scripts/bootstrap.ts (SITES, TEXT_EDITS, or the structured edits) to match the file, then run `node scripts/verify-bootstrap.ts`",
  });
}

function rewriteFailed(file: string, actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_BOOTSTRAP_REWRITE",
    summary: `${file} did not parse as expected after its edit; nothing was written`,
    expected: `${file} to stay valid and to hold the new values`,
    actual,
    next: "fix the file's shape in the template (or the edit in scripts/bootstrap.ts), then run `node scripts/verify-bootstrap.ts`",
  });
}

/** Replace exactly one match of `pattern` (global) in `text`, or fail as a drifted site. */
function replaceOnce(
  file: string,
  text: string,
  pattern: RegExp,
  replace: (match: string) => string,
  what: string,
): string {
  const count = [...text.matchAll(pattern)].length;
  if (count !== 1) throw siteMissing(file, `${String(count)} occurrence(s) of ${what}`);
  return text.replace(pattern, replace);
}

function removeTemplateOnlyBlocks(file: string, text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let open = -1;
  let blocks = 0;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === START_MARKER) {
      if (open !== -1) throw markerError(file, index, "a second start marker inside an open block");
      open = index;
      return;
    }
    if (trimmed === END_MARKER) {
      if (open === -1) throw markerError(file, index, "an end marker with no open block");
      open = -1;
      blocks += 1;
      // One blank line where the block was, not two.
      const next = lines[index + 1];
      if (kept.at(-1) === "" && (next === "" || next === undefined)) kept.pop();
      return;
    }
    if (open === -1) kept.push(line);
  });
  if (open !== -1) throw markerError(file, open, "a start marker that is never closed");
  if (blocks === 0) throw siteMissing(file, "no template-only block");
  return kept.join("\n");
}

function markerError(file: string, index: number, actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_BOOTSTRAP_MARKER",
    summary: `${file}:${String(index + 1)} has an unbalanced template-only marker; nothing was written`,
    expected: `each "${START_MARKER}" line closed by a later "${END_MARKER}" line`,
    actual,
    next: `balance the markers in ${file}, then run the bootstrap again`,
  });
}

function removeCiJob(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(CI_JOB_KEY);
  if (start === -1) throw siteMissing(CI_FILE, `no \`${CI_JOB_KEY.trim()}\` job`);
  let end = start + 1;
  while (end < lines.length && !/^(?: {2})?\S/.test(lines[end] ?? "")) end += 1;
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  let result = kept.join("\n");
  if (end >= lines.length) result = `${result.trimEnd()}\n`;
  let jobs: unknown;
  try {
    jobs = (parseYaml(result) as { jobs?: unknown } | null)?.jobs;
  } catch (error: unknown) {
    throw rewriteFailed(CI_FILE, error instanceof Error ? error.message : String(error));
  }
  const remaining =
    typeof jobs === "object" && jobs !== null
      ? Object.entries(jobs as Record<string, unknown>)
      : [];
  if (
    remaining.length === 0 ||
    remaining.some(
      ([key, job]) =>
        key === "bootstrap-smoke" ||
        (typeof job === "object" &&
          job !== null &&
          (job as { name?: unknown }).name === SMOKE_JOB_NAME),
    )
  ) {
    throw rewriteFailed(
      CI_FILE,
      `the jobs after the edit: ${remaining.map(([key]) => key).join(", ")}`,
    );
  }
  return result;
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Every value `key` takes in a workflow's `env` maps: the workflow's, each job's, each step's. */
export function workflowEnvValues(workflow: unknown, key: string): unknown[] {
  const jobs = property(workflow, "jobs");
  const scopes = [
    workflow,
    ...(typeof jobs === "object" && jobs !== null ? Object.values(jobs) : []).flatMap(
      (job: unknown) => {
        const steps = property(job, "steps");
        return [job, ...(Array.isArray(steps) ? (steps as unknown[]) : [])];
      },
    ),
  ];
  return scopes
    .map((scope) => property(property(scope, "env"), key))
    .filter((value) => value !== undefined);
}

/**
 * The release workflow finds the built `<name>.app` and its dmg through APP_NAME, so after
 * the rewrite it must read back as the display name itself — a string, not the number or
 * null an unquoted name such as `1.10` or `Null` would become.
 */
function assertReleaseAppName(text: string, name: string): void {
  let workflow: unknown;
  try {
    workflow = parseYaml(text);
  } catch (error: unknown) {
    throw rewriteFailed(RELEASE_FILE, error instanceof Error ? error.message : String(error));
  }
  const values = workflowEnvValues(workflow, "APP_NAME");
  if (values.length === 0 || values.some((value) => value !== name)) {
    throw rewriteFailed(
      RELEASE_FILE,
      `APP_NAME reads as ${JSON.stringify(values)} after the edit, not ${JSON.stringify(name)}; quote the value in the template`,
    );
  }
}

function removeRulesetContext(text: string): string {
  const result = replaceOnce(
    RULESET_FILE,
    text,
    RULESET_ENTRY,
    () => "",
    `the "${SMOKE_JOB_NAME}" context`,
  );
  try {
    JSON.parse(result);
  } catch (error: unknown) {
    throw rewriteFailed(RULESET_FILE, error instanceof Error ? error.message : String(error));
  }
  return result;
}

function removeRecipe(text: string): string {
  const count = text.split(JUSTFILE_RECIPE).length - 1;
  if (count !== 1) throw siteMissing("justfile", `${String(count)} copies of the bootstrap recipe`);
  return text.replace(JUSTFILE_RECIPE, "");
}

function resetChangelog(text: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => UNRELEASED.test(line));
  if (index === -1) throw siteMissing("CHANGELOG.md", "no `## [Unreleased]` heading");
  return `${lines.slice(0, index + 1).join("\n")}\n`;
}

function readCargoVersion(text: string): unknown {
  try {
    const parsed = parseToml(text) as { workspace?: { package?: { version?: unknown } } };
    return parsed.workspace?.package?.version;
  } catch {
    return undefined;
  }
}

function resetCargoVersion(text: string): string {
  if (!CARGO_VERSION.test(text))
    throw siteMissing("Cargo.toml", "no version under [workspace.package]");
  const result = text.replace(
    CARGO_VERSION,
    (_all, head: string, _old: string, tail: string) => `${head}${FIRST_VERSION}${tail}`,
  );
  if (readCargoVersion(result) !== FIRST_VERSION) {
    throw rewriteFailed("Cargo.toml", "[workspace.package] version is not 0.1.0 after the edit");
  }
  return result;
}

function resetJsonVersion(file: string, text: string): string {
  if (!JSON_VERSION.test(text)) throw siteMissing(file, 'no "version" field');
  const result = text.replace(
    JSON_VERSION,
    (_all, head: string, tail: string) => `${head}${FIRST_VERSION}${tail}`,
  );
  let version: unknown;
  try {
    version = (JSON.parse(result) as { version?: unknown }).version;
  } catch (error: unknown) {
    throw rewriteFailed(file, error instanceof Error ? error.message : String(error));
  }
  if (version !== FIRST_VERSION)
    throw rewriteFailed(file, "its top-level version is not 0.1.0 after the edit");
  return result;
}

/** The file's text as the app should hold it, before any write. */
interface Plan {
  readonly writes: Map<string, string>;
}

type Edit = (text: string) => string;

function structuredEdits(answers: Answers, year: number): readonly (readonly [string, Edit])[] {
  return [
    ["CHANGELOG.md", resetChangelog],
    ["Cargo.toml", resetCargoVersion],
    ["src-tauri/tauri.conf.json", (text) => resetJsonVersion("src-tauri/tauri.conf.json", text)],
    [
      "package.json",
      (text) =>
        replaceOnce(
          "package.json",
          resetJsonVersion("package.json", text),
          PACKAGE_AUTHOR,
          () => `"author": ${JSON.stringify(answers.author)}`,
          'the template\'s "author" field',
        ),
    ],
    [
      "LICENSE",
      (text) =>
        replaceOnce(
          "LICENSE",
          text,
          LICENSE_LINE,
          () => `Copyright (c) ${String(year)} ${answers.copyright}`,
          "the template's copyright line",
        ),
    ],
    [CI_FILE, removeCiJob],
    [RULESET_FILE, removeRulesetContext],
    ["justfile", removeRecipe],
  ];
}

/** Compute every edit in memory, failing on any drift before anything is written. */
function plan(root: string, answers: Answers, year: number): Plan {
  const writes = new Map<string, string>();
  const text = (file: string): string => {
    const cached = writes.get(file);
    if (cached !== undefined) return cached;
    const full = join(root, file);
    if (!existsSync(full)) throw siteMissing(file, "the file does not exist");
    return readFileSync(full, "utf8");
  };

  for (const edit of TEXT_EDITS) {
    const current = text(edit.file);
    const count = current.split(edit.find).length - 1;
    if (count !== 1) {
      throw siteMissing(
        edit.file,
        `${String(count)} occurrence(s) of the passage starting ${JSON.stringify(edit.find.slice(0, 60))}`,
      );
    }
    writes.set(
      edit.file,
      current.replace(edit.find, () => edit.replace),
    );
  }
  for (const file of MARKER_FILES) writes.set(file, removeTemplateOnlyBlocks(file, text(file)));
  for (const [file, edit] of structuredEdits(answers, year)) writes.set(file, edit(text(file)));

  const names = deriveNames(answers);
  for (const site of SITES) {
    let current = text(site.file);
    for (const [form, pattern, value] of FORMS) {
      if (!site.forms.includes(form)) continue;
      if (current.search(pattern) === -1) {
        throw siteMissing(site.file, `no ${form} placeholder (${pattern.source})`);
      }
      const replacement = value(answers, names);
      current = current.replace(pattern, () => replacement);
    }
    writes.set(site.file, current);
  }
  assertReleaseAppName(text(RELEASE_FILE), answers.name);

  const pattern = leftoverPattern(tokensFor(answers));
  if (pattern !== undefined) {
    const leftovers = [...writes].flatMap(([file, content]) =>
      leftoverLines(file, content, pattern),
    );
    if (leftovers.length > 0) {
      throw new ScriptError({
        code: "ERR_BOOTSTRAP_SITE_INCOMPLETE",
        summary: `${leftovers[0]?.split(":")[0] ?? "a listed file"} would keep a placeholder its site does not list; nothing was written`,
        expected: "no template placeholder in any file the bootstrap rewrites",
        actual:
          leftovers.slice(0, 5).join(" | ") +
          (leftovers.length > 5 ? ` (and ${String(leftovers.length - 5)} more)` : ""),
        next: "add the missing form to that file's entry in scripts/bootstrap.ts SITES, then run `node scripts/verify-bootstrap.ts`",
      });
    }
  }
  return { writes };
}

function assertTemplate(root: string): void {
  const conf = join(root, "src-tauri", "tauri.conf.json");
  let identifier: unknown;
  try {
    identifier = (JSON.parse(readFileSync(conf, "utf8")) as { identifier?: unknown }).identifier;
  } catch {
    identifier = undefined;
  }
  const missingCrates = CRATE_DIRS.filter((dir) => !existsSync(join(root, dir)));
  if (identifier !== TEMPLATE_VALUES.bundleId || missingCrates.length > 0) {
    throw new ScriptError({
      code: "ERR_BOOTSTRAP_NOT_TEMPLATE",
      summary: `${root} is not an un-bootstrapped copy of the template`,
      expected: `identifier "${TEMPLATE_VALUES.bundleId}" in src-tauri/tauri.conf.json and ${CRATE_DIRS.join(", ")}`,
      actual: `identifier ${JSON.stringify(identifier ?? null)}${missingCrates.length > 0 ? `; missing ${missingCrates.join(", ")}` : ""}`,
      next: "the bootstrap runs once, on a fresh clone of a repository created from the template; it has nothing to do here",
    });
  }
}

/** Refuse a work tree with uncommitted or untracked changes; outside git there is nothing to check. */
function assertClean(context: ScriptContext): void {
  const git = (...args: string[]) =>
    context.run("git", args, { cwd: context.root, env: gitEnv(context.env) });
  const inside = git("rev-parse", "--is-inside-work-tree");
  if (inside.status !== 0 || inside.stdout.trim() === "false") return;
  const status = git("status", "--porcelain");
  if (status.status !== 0) {
    // Inside a work tree a failing status (a held index.lock, say) must not fail open.
    throw new ScriptError({
      code: "ERR_BOOTSTRAP_DIRTY",
      summary: `\`git status\` failed in ${context.root}, so its cleanliness is unknown; nothing was written`,
      expected: "`git status --porcelain` to exit 0 inside the work tree",
      actual: `exit ${String(status.status)}: ${status.stderr.trim().split("\n")[0] ?? ""}`,
      next: "run `git status` to see why it fails (a stale .git/index.lock, for example), fix it, then run the bootstrap again",
    });
  }
  const changes = status.stdout.split("\n").filter((line) => line.trim() !== "");
  if (changes.length === 0) return;
  throw new ScriptError({
    code: "ERR_BOOTSTRAP_DIRTY",
    summary: `${context.root} has uncommitted or untracked changes; nothing was written`,
    expected: "a clean work tree, so the rewrite is the only change to review",
    actual:
      changes.slice(0, 5).join(" | ") +
      (changes.length > 5 ? ` (and ${String(changes.length - 5)} more)` : ""),
    next: "commit or stash the changes `git status` lists, then run the bootstrap again",
  });
}

function tableKeys(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

/**
 * Every package name the workspace resolves (Cargo.lock's packages, and the
 * `[workspace.dependencies]` keys), spelled with hyphens, minus the template's own crates.
 */
export function dependencyNames(root: string): Set<string> {
  const names: string[] = tableKeys(
    property(
      property(parseToml(readFileSync(join(root, "Cargo.toml"), "utf8")), "workspace"),
      "dependencies",
    ),
  );
  const lock = join(root, "Cargo.lock");
  if (existsSync(lock)) {
    const packages = property(parseToml(readFileSync(lock, "utf8")), "package");
    if (Array.isArray(packages)) {
      for (const entry of packages as unknown[]) {
        const name = property(entry, "name");
        if (typeof name === "string") names.push(name);
      }
    }
  }
  const own = new Set([
    TEMPLATE_VALUES.slug,
    ...CRATE_DIRS.map((dir) => dir.slice("crates/".length)),
  ]);
  return new Set(
    names.map((name) => name.toLowerCase().replaceAll("_", "-")).filter((name) => !own.has(name)),
  );
}

/** Refuse a slug whose shell or crate package name would collide with a dependency. */
function assertSlugFree(root: string, slug: string): void {
  const taken = dependencyNames(root);
  const packages = [slug, ...CRATE_DIRS.map((dir) => renamed(dir, slug).slice("crates/".length))];
  const clash = packages.find((name) => taken.has(name));
  if (clash === undefined) return;
  throw new ScriptError({
    code: "ERR_BOOTSTRAP_INVALID_SLUG",
    summary: `${JSON.stringify(slug)} would name the package ${clash}, which a dependency already uses; nothing was written`,
    expected: `a slug whose packages (${packages.join(", ")}) match no package in Cargo.lock or [workspace.dependencies]`,
    actual: `${clash} is already a dependency`,
    next: "pass --slug again with a name no dependency uses",
  });
}

function renamed(path: string, slug: string): string {
  return path.replace(/^crates\/myapp-/, `crates/${slug}-`);
}

function runStep(
  context: ScriptContext,
  args: readonly [string, ...string[]],
  code: string,
  summary: string,
  next: string,
): void {
  const [command, ...rest] = args;
  const result = context.run(command, rest, { cwd: context.root, env: context.env });
  if (result.status !== 0) {
    throw new ScriptError({
      code,
      summary,
      expected: `\`${args.join(" ")}\` to exit 0`,
      actual: `exit ${String(result.status)}: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`,
      next,
    });
  }
}

/** Rewrite `context.root` from the template into the app `answers` describe. */
export function runBootstrap(
  context: ScriptContext,
  answers: Answers,
  options: { readonly year: number },
): void {
  const { root, log } = context;
  assertTemplate(root);
  assertSlugFree(root, answers.slug);
  const { writes } = plan(root, answers, options.year);
  assertClean(context);

  runStep(
    context,
    ["cargo", "fetch", "--locked"],
    "ERR_BOOTSTRAP_FETCH",
    "cargo could not fetch the locked dependencies; nothing was written",
    "check the network and `cargo fetch --locked`, then run the bootstrap again",
  );

  for (const [file, content] of writes) writeFileSync(join(root, file), content);
  for (const dir of CRATE_DIRS) renameSync(join(root, dir), join(root, renamed(dir, answers.slug)));
  log(
    `bootstrap: rewrote ${String(writes.size)} files and renamed ${String(CRATE_DIRS.length)} crates`,
  );

  const partial =
    "the clone is half-rewritten: `git status` shows what changed; discard it and bootstrap a fresh clone after fixing the cause";
  runStep(
    context,
    ["cargo", "update", "--workspace", "--offline"],
    "ERR_BOOTSTRAP_LOCKFILE",
    "Cargo.lock could not be updated offline for the renamed crates",
    partial,
  );
  const formattable = [...writes.keys()]
    .filter((file) => !file.endsWith(".md") && !file.endsWith(".rs"))
    .map((file) => renamed(file, answers.slug));
  runStep(
    context,
    ["cargo", "fmt", "--all"],
    "ERR_BOOTSTRAP_FORMAT",
    "rustfmt failed on the renamed crates",
    partial,
  );
  runStep(
    context,
    // Prettier's own bin, not `pnpm exec`: pnpm refuses to run anything once the rename has
    // changed package.json's name, until the next `pnpm install`.
    [join(root, "node_modules", ".bin", "prettier"), "--write", "--ignore-unknown", ...formattable],
    "ERR_BOOTSTRAP_FORMAT",
    "Prettier failed on the rewritten files",
    `${partial} (Prettier comes from \`just install\`)`,
  );

  for (const path of REMOVED_PATHS) rmSync(join(root, path), { recursive: true, force: true });

  const listed = context.run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      env: gitEnv(context.env),
    },
  );
  if (listed.status === 0) {
    const files = listed.stdout.split("\0").filter((file) => file !== "");
    const leftovers = findLeftovers(root, files, answers);
    if (leftovers.length > 0) {
      log("");
      log("bootstrap: WARNING: these lines outside the site list still name the template:");
      for (const line of leftovers) log(`  ${line}`);
      log("  Rename them by hand, and add each site to scripts/bootstrap.ts in the template.");
    }
  } else {
    log(
      "bootstrap: not a git work tree, so the scan for placeholders outside the site list was skipped",
    );
  }

  for (const line of [
    "",
    `bootstrap: done. This checkout is now ${answers.name} (${answers.slug}, ${answers.bundleId}).`,
    "The bootstrap script and its verifier deleted themselves.",
    "",
    "Next steps:",
    "  1. Fill in AGENTS.md's `## Product` section — what the app is and who it is for, the core",
    "     interaction, the non-goals — and delete every `TODO:` there. `just check-harness`",
    "     (and so `just check`) fails until you do.",
    "  2. Fill in docs/architecture/roadmap.md (Now / Next / Later) with the steering-the-roadmap skill.",
    "  3. just install, then just check.",
    "  4. Review the rewrite (`git status`, `git diff`) and commit it as one commit.",
    "  5. just labels — create the label set from .github/labels.yml on the new repository.",
    "  6. Turn on the GitHub security settings: secret scanning and push protection, private",
    "     vulnerability reporting, Dependabot alerts and security updates.",
    "  7. Once the bootstrap commit is on main: just ruleset (a repository admin's step).",
  ]) {
    log(line);
  }
}

type Stream<T> = T & { readonly isTTY?: boolean };

/**
 * A terminal on standard input, asked only when it is interactive. Lines are queued as
 * they arrive, so several answers pasted in one write are each consumed by a question.
 */
export function processTerminal(
  input: Stream<Readable> = process.stdin,
  output: Stream<Writable> = process.stdout,
): Terminal {
  let readline: Interface | undefined;
  let closed = false;
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  const open = (): Interface => {
    if (readline !== undefined) return readline;
    const created = createInterface({ input, output });
    created.on("line", (line) => {
      const next = waiting.shift();
      if (next === undefined) lines.push(line);
      else next(line);
    });
    created.on("close", () => {
      closed = true;
      for (const next of waiting.splice(0)) next(undefined);
    });
    readline = created;
    return created;
  };
  return {
    interactive: input.isTTY === true && output.isTTY === true,
    ask: (question) => {
      const created = open();
      if (closed && lines.length === 0) return Promise.resolve(undefined);
      if (!closed) {
        created.setPrompt(question);
        created.prompt();
      }
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => readline?.close(),
  };
}

export async function main(
  context: ScriptContext,
  terminal: Terminal = processTerminal(),
  options: { readonly year: number } = { year: new Date().getUTCFullYear() },
): Promise<void> {
  try {
    await loadParsers();
    const parsed = parseArgs(context.argv);
    if (parsed.help) {
      context.log(USAGE);
      return;
    }
    const answers = await collectAnswers(parsed, terminal, context.log);
    runBootstrap(context, answers, options);
  } finally {
    terminal.close?.();
  }
}

if (import.meta.main) await runScript(main);
