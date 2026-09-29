/**
 * Proves the bootstrap on a scratch copy (design D19): clones this checkout into its own
 * temporary directory, lays the work tree's uncommitted changes over the clone (so an
 * edit is verified before it is committed), links the installed node_modules, runs
 * `scripts/bootstrap.ts` non-interactively with a hyphenated multi-word name, and checks
 * the generated app:
 *
 * - no template placeholder is left in any spelling (`MyApp`, `myapp`, `myapp-core`,
 *   `myapp_lib`, `MYAPP_SMOKE`, `com.example.myapp`, the template's owner/repo), outside
 *   the upstream references the bootstrap keeps on purpose;
 * - no template-only marker line, and none of the template-only material (the paths the
 *   bootstrap removes, the Template Bootstrap Smoke job and its required context);
 * - no dangling reference in a Markdown file (a skill included): a relative link to a
 *   missing file, a path the bootstrap removed, or `just <recipe>` for a recipe the
 *   justfile does not define;
 * - the names agree: the bundle identifier, display name, slug spellings, and version in
 *   tauri.conf.json, paths.rs, the justfile, scripts/smoke.ts, startup.rs, lib.rs,
 *   release.yml's APP_NAME, package.json, LICENSE, and CHANGELOG.md; the crate
 *   directories, their package names, the workspace members and dependencies, and
 *   Cargo.lock; every Rust crate and library name a valid identifier.
 *
 *   node scripts/verify-bootstrap.ts [--keep]
 *
 * CI's Template Bootstrap Smoke job runs it, so a leftover fails the pull request that
 * introduced it rather than an app's first release.
 *
 * --keep leaves the scratch copy in place and prints its path. The run needs
 * `just install` first (the bootstrap and Prettier come from node_modules) and cargo's
 * registry (the bootstrap fetches and updates Cargo.lock). Outside a git work tree it
 * refuses: there is no checkout to clone.
 *
 * Errors: ERR_VERIFY_BOOTSTRAP_USAGE, ERR_VERIFY_BOOTSTRAP_NO_DEPS,
 * ERR_VERIFY_BOOTSTRAP_CLONE, ERR_VERIFY_BOOTSTRAP_RUN, and a generated-tree violation:
 * ERR_VERIFY_BOOTSTRAP_LEFTOVER, ERR_VERIFY_BOOTSTRAP_MARKER,
 * ERR_VERIFY_BOOTSTRAP_TEMPLATE_FILE, ERR_VERIFY_BOOTSTRAP_DANGLING_REFERENCE,
 * ERR_VERIFY_BOOTSTRAP_NAME_MISMATCH.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative } from "node:path";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import {
  CRATE_DIRS,
  deriveNames,
  findLeftovers,
  REMOVED_PATHS,
  SMOKE_JOB_NAME,
  workflowEnvValues,
  type Answers,
} from "./bootstrap.ts";
import { formatFailure, ScriptError, type FailureDetails } from "./lib/fail.ts";
import { gitEnv } from "./lib/git-env.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

/** A hyphenated multi-word slug, so the hyphen, underscore, and upper-case forms all differ. */
export const VERIFY_ANSWERS: Answers = {
  name: "Tide Pool",
  slug: "tide-pool",
  bundleId: "com.example.tide-pool",
  repo: "example-owner/tide-pool",
  author: "Ada Lovelace",
  copyright: "Ada Lovelace",
};

/** Directories a scan skips: version control, dependencies, and build output. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", "target", "dist", "coverage"]);
const SKIPPED_PATHS = new Set(["src-tauri/gen", "src-tauri/binaries"]);
const FIRST_VERSION = "0.1.0";
const MARKER_LINE = /^\s*<!--\s*\/?template-only\b/;
const RUST_IDENT = /^[a-z][a-z0-9_]*$/;

/** Every file under `root`, as a path relative to it with forward slashes. */
function listFiles(root: string, dir = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !SKIPPED_PATHS.has(path)) {
        files.push(...listFiles(root, path));
      }
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function readText(root: string, path: string): string | undefined {
  const full = join(root, path);
  if (!existsSync(full) || !lstatSync(full).isFile()) return undefined;
  const text = readFileSync(full, "utf8");
  return text.includes("\0") ? undefined : text;
}

function violation(
  code: string,
  summary: string,
  expected: string,
  actual: string,
  next: string,
): FailureDetails {
  return { code: `ERR_VERIFY_BOOTSTRAP_${code}`, summary, expected, actual, next };
}

const FIX_BOOTSTRAP =
  "fix scripts/bootstrap.ts (SITES, TEXT_EDITS, REMOVED_PATHS) or the template file, then run `node scripts/verify-bootstrap.ts` again";

function leftovers(root: string, files: readonly string[]): FailureDetails[] {
  const byFile = new Map<string, string[]>();
  for (const line of findLeftovers(root, files)) {
    const file = line.slice(0, line.indexOf(":"));
    byFile.set(file, [...(byFile.get(file) ?? []), line]);
  }
  return [...byFile].map(([file, lines]) =>
    violation(
      "LEFTOVER",
      `${file} still names the template`,
      "no template placeholder in any spelling in the generated app",
      lines.slice(0, 5).join(" | ") +
        (lines.length > 5 ? ` (and ${String(lines.length - 5)} more)` : ""),
      `add ${file} and its spellings to SITES in scripts/bootstrap.ts, then run \`node scripts/verify-bootstrap.ts\` again`,
    ),
  );
}

function markers(root: string, files: readonly string[]): FailureDetails[] {
  const found: string[] = [];
  for (const file of files) {
    const text = readText(root, file);
    if (text === undefined) continue;
    text.split("\n").forEach((line, index) => {
      if (MARKER_LINE.test(line)) found.push(`${file}:${String(index + 1)}`);
    });
  }
  return found.length === 0
    ? []
    : [
        violation(
          "MARKER",
          "a template-only marker line survived the bootstrap",
          "no `<!-- template-only -->` or `<!-- /template-only -->` line in the generated app",
          found.join(", "),
          "add the file to MARKER_FILES in scripts/bootstrap.ts, then run `node scripts/verify-bootstrap.ts` again",
        ),
      ];
}

function templateMaterial(root: string): FailureDetails[] {
  const found = REMOVED_PATHS.filter((path) => existsSync(join(root, path)));
  const ci = readText(root, ".github/workflows/ci.yml") ?? "";
  if (/^ {2}bootstrap-smoke:/m.test(ci) || ci.includes(SMOKE_JOB_NAME)) {
    found.push(".github/workflows/ci.yml (the bootstrap-smoke job)");
  }
  if ((readText(root, ".github/rulesets/main.json") ?? "").includes(SMOKE_JOB_NAME)) {
    found.push(`.github/rulesets/main.json (the "${SMOKE_JOB_NAME}" context)`);
  }
  return found.length === 0
    ? []
    : [
        violation(
          "TEMPLATE_FILE",
          "template-only material survived the bootstrap",
          "the bootstrap's removed paths, CI job, and required context all gone",
          found.join(", "),
          FIX_BOOTSTRAP,
        ),
      ];
}

/** The recipe names the justfile defines. */
function recipes(justfile: string): Set<string> {
  const names = new Set<string>();
  for (const line of justfile.split("\n")) {
    const match = /^@?([A-Za-z][A-Za-z0-9_-]*)\b[^:=]*:(?!=)/.exec(line);
    if (match?.[1] !== undefined && match[1] !== "set") names.add(match[1]);
  }
  return names;
}

/** `just <recipe>` in inline code and at the start of fenced code lines. */
function recipeMentions(text: string): string[] {
  const names: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      const match = /^\s*just ([a-z][a-z0-9-]*)/.exec(line);
      if (match?.[1] !== undefined) names.push(match[1]);
      continue;
    }
    for (const match of line.matchAll(/`just ([a-z][a-z0-9-]*)[^`]*`/g)) {
      if (match[1] !== undefined) names.push(match[1]);
    }
  }
  return names;
}

function danglingReferences(root: string, files: readonly string[]): FailureDetails[] {
  const defined = recipes(readText(root, "justfile") ?? "");
  const found: string[] = [];
  for (const file of files.filter((path) => path.endsWith(".md"))) {
    const text = readText(root, file);
    if (text === undefined) continue;
    // A link inside code is an example, not a link; a target with <…> is a placeholder
    // the reader fills in (the ADR template's NNNN-<kebab-case-title>.md).
    const prose = text.replace(/^\s*```[\s\S]*?^\s*```/gm, "").replace(/`[^`\n]*`/g, "");
    for (const match of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = (match[1] ?? "").split("#")[0] ?? "";
      if (target === "" || target.includes("<") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = normalize(join(dirname(file), target));
      if (resolved.startsWith("..") || !existsSync(join(root, resolved))) {
        found.push(`${file}: link to ${target}`);
      }
    }
    for (const path of REMOVED_PATHS) {
      if (text.includes(path)) found.push(`${file}: names the removed ${path}`);
    }
    for (const name of recipeMentions(text)) {
      if (!defined.has(name)) found.push(`${file}: \`just ${name}\` (no such recipe)`);
    }
  }
  return found.length === 0
    ? []
    : [
        violation(
          "DANGLING_REFERENCE",
          `${String(found.length)} reference(s) in the Markdown point at something the app does not have`,
          "every relative link, named path, and `just` recipe in a skill or document to exist after the bootstrap",
          found.join(" | "),
          "remove or rewrite the passage through TEXT_EDITS or REMOVED_PATHS in scripts/bootstrap.ts, then run `node scripts/verify-bootstrap.ts` again",
        ),
      ];
}

/** `value[keys[0]][keys[1]]…`, or undefined when a step is missing. */
function at(value: unknown, keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function parsed(text: string | undefined, parse: (text: string) => unknown): unknown {
  if (text === undefined) return undefined;
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

const quoted = (text: string | undefined, pattern: RegExp): string | undefined =>
  text === undefined ? undefined : pattern.exec(text)?.[1];

function nameMismatches(root: string, answers: Answers): FailureDetails[] {
  const names = deriveNames(answers);
  const text = (path: string): string | undefined => readText(root, path);
  const tauri = parsed(text("src-tauri/tauri.conf.json"), JSON.parse);
  const pkg = parsed(text("package.json"), JSON.parse);
  const cargo = parsed(text("Cargo.toml"), parseToml);
  const shell = parsed(text("src-tauri/Cargo.toml"), parseToml);
  const lock = parsed(text("Cargo.lock"), parseToml);
  const crateDirs = CRATE_DIRS.map((dir) =>
    dir.replace(/^crates\/myapp-/, `crates/${names.slug}-`),
  );
  const smoke = text("scripts/smoke.ts");
  const justfile = text("justfile");
  const releaseNames = workflowEnvValues(
    parsed(text(".github/workflows/release.yml"), parseYaml),
    "APP_NAME",
  );

  const expectations: (readonly [string, unknown, unknown])[] = [
    ["tauri.conf.json productName", at(tauri, ["productName"]), answers.name],
    ["tauri.conf.json identifier", at(tauri, ["identifier"]), answers.bundleId],
    ["tauri.conf.json version", at(tauri, ["version"]), FIRST_VERSION],
    ["tauri.conf.json main window title", at(tauri, ["app", "windows", 0, "title"]), answers.name],
    [
      "tauri.conf.json externalBin",
      at(tauri, ["bundle", "externalBin", 0]),
      `binaries/${names.slug}-cli`,
    ],
    [
      "paths.rs BUNDLE_IDENTIFIER",
      quoted(text(`${crateDirs[2] ?? ""}/src/paths.rs`), /BUNDLE_IDENTIFIER: &str = "([^"]*)"/),
      answers.bundleId,
    ],
    ["justfile bundle_id", quoted(justfile, /^bundle_id := "([^"]*)"/m), answers.bundleId],
    ["justfile app_name", quoted(justfile, /^app_name := "([^"]*)"/m), answers.name],
    [
      "smoke.ts BUNDLE_IDENTIFIER",
      quoted(smoke, /BUNDLE_IDENTIFIER = "([^"]*)"/),
      answers.bundleId,
    ],
    ["smoke.ts APP_NAME", quoted(smoke, /APP_NAME = "([^"]*)"/), answers.name],
    ...(releaseNames.length === 0 ? [undefined] : releaseNames).map(
      (value) => ["release.yml APP_NAME", value, answers.name] as const,
    ),
    ["smoke.ts EXECUTABLE", quoted(smoke, /EXECUTABLE = "([^"]*)"/), names.slug],
    ["smoke.ts HELPER", quoted(smoke, /HELPER = "([^"]*)"/), `${names.slug}-cli`],
    ["smoke.ts SMOKE_ENV", quoted(smoke, /SMOKE_ENV = "([^"]*)"/), `${names.slugUpper}_SMOKE`],
    ["smoke.ts LOG_PREFIX", quoted(smoke, /LOG_PREFIX = "([^"]*)"/), names.slug],
    [
      "startup.rs SMOKE_ENV",
      quoted(text("src-tauri/src/startup.rs"), /SMOKE_ENV: &str = "([^"]*)"/),
      `${names.slugUpper}_SMOKE`,
    ],
    [
      "lib.rs LOG_FILE_PREFIX",
      quoted(text("src-tauri/src/lib.rs"), /LOG_FILE_PREFIX: &str = "([^"]*)"/),
      names.slug,
    ],
    ["src-tauri package name", at(shell, ["package", "name"]), names.slug],
    ["src-tauri lib name", at(shell, ["lib", "name"]), `${names.slugSnake}_lib`],
    [
      "Cargo.toml [workspace.package] version",
      at(cargo, ["workspace", "package", "version"]),
      FIRST_VERSION,
    ],
    ["package.json name", at(pkg, ["name"]), names.slug],
    ["package.json version", at(pkg, ["version"]), FIRST_VERSION],
    ["package.json author", at(pkg, ["author"]), answers.author],
    [
      "LICENSE copyright line",
      quoted(text("LICENSE"), /^Copyright \(c\) \d{4} (.*)$/m),
      answers.copyright,
    ],
    [
      "CHANGELOG.md release headings",
      (text("CHANGELOG.md") ?? "").match(/^## \[/gm)?.length ?? 0,
      1,
    ],
  ];
  const found = expectations
    .filter(([, actual, expected]) => actual !== expected)
    .map(
      ([label, actual, expected]) =>
        `${label}: ${JSON.stringify(actual ?? null)} (expected ${JSON.stringify(expected)})`,
    );

  // The crates: directories, package names, members, dependencies, and the lockfile agree.
  const present = existsSync(join(root, "crates"))
    ? readdirSync(join(root, "crates"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `crates/${entry.name}`)
    : [];
  for (const dir of crateDirs) if (!present.includes(dir)) found.push(`${dir}: missing`);
  for (const dir of present)
    if (!crateDirs.includes(dir)) found.push(`${dir}: not a renamed template crate`);
  const members = at(cargo, ["workspace", "members"]);
  if (!Array.isArray(members) || !members.includes("crates/*") || !members.includes("src-tauri")) {
    found.push(
      `Cargo.toml workspace.members: ${JSON.stringify(members ?? null)} (expected crates/* and src-tauri)`,
    );
  }
  const packages = new Set(
    (Array.isArray(at(lock, ["package"])) ? (at(lock, ["package"]) as unknown[]) : []).map(
      (entry) => at(entry, ["name"]),
    ),
  );
  const crateNames = [names.slug, ...crateDirs.map((dir) => dir.slice("crates/".length))];
  for (const dir of crateDirs) {
    const name = at(parsed(text(`${dir}/Cargo.toml`), parseToml), ["package", "name"]);
    if (name !== dir.slice("crates/".length)) {
      found.push(`${dir}/Cargo.toml package name: ${JSON.stringify(name ?? null)}`);
    }
  }
  for (const name of crateNames) {
    if (!RUST_IDENT.test(name.replaceAll("-", "_")))
      found.push(`${name}: not a valid Rust crate name`);
    if (!packages.has(name)) found.push(`Cargo.lock: no package ${name}`);
  }
  if (!RUST_IDENT.test(`${names.slugSnake}_lib`))
    found.push(`${names.slugSnake}_lib: not a valid Rust identifier`);
  const dependencies = at(cargo, ["workspace", "dependencies"]);
  for (const [key, spec] of Object.entries(
    typeof dependencies === "object" && dependencies !== null ? dependencies : {},
  )) {
    const path = at(spec, ["path"]);
    if (typeof path !== "string") continue;
    if (path !== `crates/${key}` || !crateDirs.includes(path)) {
      found.push(`Cargo.toml [workspace.dependencies] ${key}: path ${path}`);
    }
  }

  return found.length === 0
    ? []
    : [
        violation(
          "NAME_MISMATCH",
          `${String(found.length)} name(s) in the generated app disagree`,
          `every site to spell ${answers.name} / ${names.slug} / ${answers.bundleId} the way it needs`,
          found.join(" | "),
          FIX_BOOTSTRAP,
        ),
      ];
}

/** Every way the tree at `root` falls short of an app bootstrapped with `answers`. */
export function assertGenerated(root: string, answers: Answers): FailureDetails[] {
  const files = listFiles(root);
  return [
    ...leftovers(root, files),
    ...markers(root, files),
    ...templateMaterial(root),
    ...danglingReferences(root, files),
    ...nameMismatches(root, answers),
  ];
}

function git(context: ScriptContext, args: readonly string[], cwd: string): string {
  const result = context.run("git", args, { cwd, env: gitEnv(context.env) });
  if (result.status !== 0) {
    throw new ScriptError({
      code: "ERR_VERIFY_BOOTSTRAP_CLONE",
      summary: `could not copy ${context.root} into a scratch clone`,
      expected: `\`git ${args.join(" ")}\` to exit 0 in a git checkout`,
      actual: `exit ${String(result.status)}: ${result.stderr.trim()}`,
      next: "run this from a git checkout of the template",
    });
  }
  return result.stdout;
}

/** Copy the work tree's uncommitted and untracked changes over the clone. */
function overlay(context: ScriptContext, clone: string): void {
  const split = (out: string): string[] => out.split("\0").filter((path) => path !== "");
  const changed = [
    ...split(git(context, ["diff", "--name-only", "-z", "HEAD"], context.root)),
    ...split(git(context, ["ls-files", "-z", "--others", "--exclude-standard"], context.root)),
  ];
  for (const path of changed) {
    const source = join(context.root, path);
    const target = join(clone, path);
    if (existsSync(source) && lstatSync(source).isFile()) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    } else if (!existsSync(source)) {
      rmSync(target, { force: true });
    }
  }
}

function parseArgs(argv: readonly string[]): { keep: boolean } {
  let keep = false;
  for (const arg of argv) {
    if (arg === "--keep") keep = true;
    else {
      throw new ScriptError({
        code: "ERR_VERIFY_BOOTSTRAP_USAGE",
        summary: `unknown argument '${arg}'`,
        expected: "no arguments, or --keep",
        actual: arg,
        next: "node scripts/verify-bootstrap.ts [--keep]",
      });
    }
  }
  return { keep };
}

export function main(context: ScriptContext): void {
  const { keep } = parseArgs(context.argv);
  const modules = join(context.root, "node_modules");
  if (!existsSync(modules)) {
    throw new ScriptError({
      code: "ERR_VERIFY_BOOTSTRAP_NO_DEPS",
      summary: "node_modules is missing",
      expected: `installed dependencies at ${modules} (the bootstrap imports its parsers and runs Prettier)`,
      actual: "no node_modules directory",
      next: "run `just install`, then this again",
    });
  }

  const workspace = mkdtempSync(join(tmpdir(), "verify-bootstrap-"));
  const clone = join(workspace, "app");
  let violations: FailureDetails[];
  try {
    git(context, ["clone", "--quiet", "--no-hardlinks", context.root, clone], workspace);
    overlay(context, clone);
    symlinkSync(modules, join(clone, "node_modules"), "dir");
    // The bootstrap refuses a dirty tree: commit the overlay, and keep the symlink (which
    // the `node_modules/` pattern does not match) out of git's view.
    appendFileSync(join(clone, ".git", "info", "exclude"), "\n/node_modules\n");
    git(context, ["add", "-A"], clone);
    git(
      context,
      [
        "-c",
        "user.name=verify-bootstrap",
        "-c",
        "user.email=verify-bootstrap@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "verify-bootstrap: the work tree's changes",
      ],
      clone,
    );

    const args = [
      "scripts/bootstrap.ts",
      "--yes",
      "--name",
      VERIFY_ANSWERS.name,
      "--slug",
      VERIFY_ANSWERS.slug,
      "--bundle-id",
      VERIFY_ANSWERS.bundleId,
      "--repo",
      VERIFY_ANSWERS.repo,
      "--author",
      VERIFY_ANSWERS.author,
      "--copyright",
      VERIFY_ANSWERS.copyright,
    ];
    context.log(`verify-bootstrap: bootstrapping a clone at ${clone}`);
    const result = context.run("node", args, {
      cwd: clone,
      env: gitEnv(context.env),
      inherit: true,
    });
    if (result.status !== 0) {
      throw new ScriptError({
        code: "ERR_VERIFY_BOOTSTRAP_RUN",
        summary: "the bootstrap failed on a fresh clone",
        expected: "`node scripts/bootstrap.ts --yes …` to exit 0",
        actual: `exit ${String(result.status)}${result.stderr.trim() === "" ? " (its output is above)" : `: ${result.stderr.trim()}`}`,
        next: "fix what the bootstrap reports (its ERR_BOOTSTRAP_* code), then run this again",
      });
    }
    violations = assertGenerated(clone, VERIFY_ANSWERS);
  } finally {
    if (keep) context.log(`verify-bootstrap: kept the scratch copy at ${clone}`);
    else rmSync(workspace, { recursive: true, force: true });
  }

  const [first] = violations;
  if (first !== undefined) {
    for (const other of violations.slice(1)) context.log(formatFailure(other));
    throw new ScriptError({
      ...first,
      summary: `${first.summary} (1 of ${String(violations.length)})`,
    });
  }
  const shown = relative(context.root, clone).startsWith("..") ? "a scratch clone" : clone;
  context.log(
    `verify-bootstrap: ok — ${shown} bootstrapped as "${VERIFY_ANSWERS.name}" (${VERIFY_ANSWERS.slug}, ${VERIFY_ANSWERS.bundleId}) with no leftover placeholder, marker, dangling reference, or name mismatch`,
  );
}

if (import.meta.main) await runScript(main);
