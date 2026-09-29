/**
 * Prepares a release in one checked step (design D18): sets the version at its three
 * sites — `version` under [workspace.package] in Cargo.toml, `version` in
 * src-tauri/tauri.conf.json, and `version` in package.json — refreshes Cargo.lock, and
 * rolls CHANGELOG.md's [Unreleased] entries into a dated section, leaving an empty
 * [Unreleased] above it.
 *
 *   node scripts/release-prep.ts [--dry-run] <version>
 *
 * The release workflow refuses a tag that does not match these sites, but only after
 * the tag is pushed; this checks the same agreement beforehand. It creates no commit,
 * tag, or push — those stay human acts — so the result is a reviewable diff. Every
 * edit is textual, so formatting and comments survive. --dry-run runs every check
 * and prints the plan without writing.
 *
 * <version> is MAJOR.MINOR.PATCH with no leading zeros and no pre-release or build
 * suffix, and must be greater than the current version, compared as numbers.
 *
 * Errors: ERR_RELEASE_USAGE, ERR_RELEASE_VERSION_INVALID, ERR_RELEASE_NOT_A_REPO,
 * ERR_RELEASE_DIRTY, ERR_RELEASE_VERSIONS_DIFFER, ERR_RELEASE_VERSION_NOT_NEWER,
 * ERR_RELEASE_CHANGELOG_MISSING, ERR_RELEASE_CHANGELOG_EMPTY, ERR_RELEASE_LOCKFILE.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { gitEnv } from "./lib/git-env.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

const USAGE = "usage: node scripts/release-prep.ts [--dry-run] <version>";
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UNRELEASED = /^##\s*\[Unreleased\]\s*$/;

/** One version site: where it is, the version it holds, and how to rewrite it. */
interface Site {
  readonly path: string;
  readonly version: string | undefined;
  readonly rewrite: (text: string, next: string) => string;
}

function usage(summary: string, actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_RELEASE_USAGE",
    summary,
    expected: "an optional --dry-run and exactly one version, e.g. 0.2.0",
    actual,
    next: USAGE,
  });
}

function parseArgs(argv: readonly string[]): { dryRun: boolean; version: string } {
  let dryRun = false;
  const versions: string[] = [];
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("-")) throw usage(`unknown argument '${arg}'`, `argument '${arg}'`);
    else versions.push(arg);
  }
  const [version] = versions;
  if (version === undefined || versions.length > 1) {
    throw usage(
      "exactly one version is needed",
      versions.length === 0 ? "no version argument" : `versions ${versions.join(", ")}`,
    );
  }
  if (!RELEASE_VERSION.test(version)) {
    throw new ScriptError({
      code: "ERR_RELEASE_VERSION_INVALID",
      summary: `'${version}' is not a release version`,
      expected:
        "MAJOR.MINOR.PATCH, each a run of digits with no leading zero and no pre-release or build suffix",
      actual: `'${version}'`,
      next: "re-run with a plain MAJOR.MINOR.PATCH version",
    });
  }
  return { dryRun, version };
}

function checkCleanTree(context: ScriptContext): void {
  const status = context.run("git", ["status", "--porcelain"], {
    cwd: context.root,
    env: gitEnv(context.env),
  });
  if (status.status !== 0) {
    throw new ScriptError({
      code: "ERR_RELEASE_NOT_A_REPO",
      summary: `${context.root} is not inside a git work tree`,
      expected: "a git checkout, whose work tree must be clean before a release is prepared",
      actual: status.stderr.trim(),
      next: "run this from a git checkout of this repository",
    });
  }
  const changes = status.stdout.split("\n").filter((line) => line !== "");
  if (changes.length > 0) {
    const shown = changes.slice(0, 3).map((line) => line.slice(3));
    throw new ScriptError({
      code: "ERR_RELEASE_DIRTY",
      summary: "the work tree has uncommitted changes",
      expected: "a clean work tree, so the release edits are the whole of the next diff",
      actual: `${String(changes.length)} uncommitted change(s): ${shown.join(" ")}${changes.length > 3 ? " (and more)" : ""}`,
      next: "commit or stash them (`git status`), then re-run",
    });
  }
}

const readText = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined;

/** The `version = "..."` line inside Cargo.toml's [workspace.package] table. */
const CARGO_VERSION = /^(\[workspace\.package\][^[]*?^version\s*=\s*")([^"]*)(")/m;

function cargoSite(root: string): Site {
  const path = join(root, "Cargo.toml");
  const match = CARGO_VERSION.exec(readText(path) ?? "");
  return {
    path,
    version: match?.[2],
    rewrite: (text, next) => text.replace(CARGO_VERSION, `$1${next}$3`),
  };
}

/** A JSON file's top-level "version", rewritten in place rather than re-serialized. */
function jsonSite(path: string): Site {
  const text = readText(path);
  let version: string | undefined;
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    const value = (parsed as Record<string, unknown>)["version"];
    version = typeof value === "string" ? value : undefined;
  } catch {
    version = undefined;
  }
  return {
    path,
    version,
    rewrite: (source, next) =>
      source.replace(/("version"\s*:\s*")[^"]*(")/, (_all, head: string, tail: string) => {
        return `${head}${next}${tail}`;
      }),
  };
}

function isGreater(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** The changelog with a dated heading inserted under an emptied [Unreleased]. */
function rollChangelog(path: string, version: string, today: string): string {
  const text = readText(path);
  const lines = text?.split("\n") ?? [];
  const start = lines.findIndex((line) => UNRELEASED.test(line));
  if (text === undefined || start === -1) {
    throw new ScriptError({
      code: "ERR_RELEASE_CHANGELOG_MISSING",
      summary: "CHANGELOG.md has no `## [Unreleased]` section",
      expected: `a Keep a Changelog file at ${path} with a \`## [Unreleased]\` heading`,
      actual: text === undefined ? `no file at ${path}` : "no `## [Unreleased]` heading",
      next: "restore CHANGELOG.md and its [Unreleased] heading, then re-run",
    });
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  const section = end === -1 ? rest : rest.slice(0, end);
  if (!section.some((line) => line.trim() !== "" && !line.startsWith("###"))) {
    throw new ScriptError({
      code: "ERR_RELEASE_CHANGELOG_EMPTY",
      summary: "the [Unreleased] section of CHANGELOG.md has no entries",
      expected: "at least one entry under `## [Unreleased]` to release",
      actual: "the section holds no entry line",
      next: "add the user-facing changes to CHANGELOG.md, then re-run",
    });
  }
  return [...lines.slice(0, start + 1), "", `## [${version}] - ${today}`, ...rest].join("\n");
}

/** Run the release preparation, dating the changelog section `today` (YYYY-MM-DD). */
export function prepare(context: ScriptContext, today: string): void {
  const { root, log } = context;
  const { dryRun, version } = parseArgs(context.argv);
  checkCleanTree(context);

  const sites = [
    cargoSite(root),
    jsonSite(join(root, "src-tauri", "tauri.conf.json")),
    jsonSite(join(root, "package.json")),
  ];
  const [first] = sites;
  const current = first?.version;
  if (current === undefined || sites.some((site) => site.version !== current)) {
    throw new ScriptError({
      code: "ERR_RELEASE_VERSIONS_DIFFER",
      summary: "the three version sites do not agree",
      expected: "one version in Cargo.toml [workspace.package], tauri.conf.json, and package.json",
      actual: sites
        .map((site) => `${site.path.slice(root.length + 1)}: ${site.version ?? "not found"}`)
        .join(", "),
      next: "make the three versions equal in a commit of their own, then re-run",
    });
  }
  if (!RELEASE_VERSION.test(current) || !isGreater(version, current)) {
    throw new ScriptError({
      code: "ERR_RELEASE_VERSION_NOT_NEWER",
      summary: `${version} is not greater than the current version ${current}`,
      expected: `a version above ${current}, compared component by component`,
      actual: version === current ? `${version}, the current version` : `${version}, below it`,
      next: "pick a higher version, or check whether it was already prepared (`git log -1 package.json`)",
    });
  }
  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = rollChangelog(changelogPath, version, today);

  log(`release-prep: plan for ${version}`);
  for (const site of sites) log(`  ${site.path.slice(root.length + 1)}: ${current} -> ${version}`);
  log("  Cargo.lock: refreshed with `cargo update --workspace --offline`");
  log(`  CHANGELOG.md: the [Unreleased] entries -> "## [${version}] - ${today}"`);
  if (dryRun) {
    log("release-prep: --dry-run, nothing was written. Re-run without --dry-run to apply.");
    return;
  }

  for (const site of sites) {
    writeFileSync(site.path, site.rewrite(readFileSync(site.path, "utf8"), version));
  }
  const lock = context.run("cargo", ["update", "--workspace", "--offline"], {
    cwd: root,
    env: context.env,
  });
  if (lock.status !== 0) {
    throw new ScriptError({
      code: "ERR_RELEASE_LOCKFILE",
      summary: "Cargo.lock could not be refreshed",
      expected: "`cargo update --workspace --offline` to exit 0",
      actual: `exit ${String(lock.status)}: ${lock.stderr.trim()}`,
      next: "fix what cargo reports, then `git checkout -- .` and re-run",
    });
  }
  writeFileSync(changelogPath, changelog);

  for (const line of [
    "release-prep: done. No commit, tag, or push was created.",
    "",
    "Next, by hand:",
    "  1. git diff                                   # review the edits",
    `  2. git switch -c release/${version} && git commit -am 'chore: release v${version}'`,
    "  3. open a pull request and merge it into main",
    `  4. a human tags the merge commit: git tag v${version} && git push origin v${version}`,
  ]) {
    log(line);
  }
}

export function main(context: ScriptContext): void {
  prepare(context, new Date().toISOString().slice(0, 10));
}

if (import.meta.main) await runScript(main);
