/**
 * Prepares a release in one checked step: sets the version at its three
 * sites — `version` under [workspace.package] in Cargo.toml, `version` in
 * src-tauri/tauri.conf.json, and `version` in package.json — refreshes Cargo.lock, and
 * rolls CHANGELOG.md's [Unreleased] entries into a dated section, leaving an empty
 * [Unreleased] above it.
 *
 *   node scripts/release-prep.ts [--dry-run] <version>
 *
 * The release workflow refuses a tag that does not match these sites, but only after
 * the tag is pushed; this checks the same agreement beforehand. It creates no commit,
 * tag, or push — those stay human acts — so the result is a reviewable diff. Each site
 * is read with a real parser (smol-toml, JSON.parse); the edit itself is a one-line
 * textual replacement, so formatting and comments survive, and the edited text is parsed
 * again to confirm it holds the new version before anything is written. --dry-run runs
 * every check and prints the plan without writing.
 *
 * <version> is MAJOR.MINOR.PATCH with no leading zeros and no pre-release or build
 * suffix, and must be greater than the current version, compared as numbers — or equal
 * to it for an app's first release (no v* tag, and no CHANGELOG.md section for it yet),
 * since the bootstrap leaves the version at 0.1.0.
 *
 * Errors: ERR_RELEASE_USAGE, ERR_RELEASE_VERSION_INVALID, ERR_RELEASE_NOT_A_REPO,
 * ERR_RELEASE_DIRTY, ERR_RELEASE_VERSIONS_DIFFER, ERR_RELEASE_VERSION_NOT_NEWER,
 * ERR_RELEASE_CHANGELOG_MISSING, ERR_RELEASE_CHANGELOG_EMPTY, ERR_RELEASE_REWRITE,
 * ERR_RELEASE_LOCKFILE.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

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
  /** The version a text of this file declares, read with a parser. */
  readonly read: (text: string) => string | undefined;
  readonly rewrite: (text: string, next: string) => string;
}

/** `value[keys[0]][keys[1]]…` when every step is an object and the end is a string. */
function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
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

/** The `version = "..."` line inside Cargo.toml's [workspace.package] table: the edit. */
const CARGO_VERSION = /^(\[workspace\.package\][^[]*?^version\s*=\s*")([^"]*)(")/m;

function readCargoVersion(text: string): string | undefined {
  try {
    return stringAt(parseToml(text), ["workspace", "package", "version"]);
  } catch {
    return undefined;
  }
}

function cargoSite(root: string): Site {
  const path = join(root, "Cargo.toml");
  return {
    path,
    version: readCargoVersion(readText(path) ?? ""),
    read: readCargoVersion,
    rewrite: (text, next) => text.replace(CARGO_VERSION, `$1${next}$3`),
  };
}

function readJsonVersion(text: string): string | undefined {
  try {
    return stringAt(JSON.parse(text), ["version"]);
  } catch {
    return undefined;
  }
}

/** A JSON file's top-level "version", rewritten in place rather than re-serialized. */
function jsonSite(path: string): Site {
  return {
    path,
    version: readJsonVersion(readText(path) ?? ""),
    read: readJsonVersion,
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

/**
 * Why the current version cannot be prepared again, or undefined when this is an app's
 * first release: no `v*` tag (the glob the release workflow triggers on) and no
 * CHANGELOG.md section for the version yet. A failing tag listing refuses.
 */
function firstReleaseRefusal(
  context: ScriptContext,
  version: string,
  changelogPath: string,
): string | undefined {
  const tags = context.run("git", ["tag", "--list", "v*"], {
    cwd: context.root,
    env: gitEnv(context.env),
  });
  if (tags.status !== 0) {
    return `git tag --list 'v*' exited ${String(tags.status)}: ${tags.stderr.trim()}`;
  }
  const listed = tags.stdout.trim();
  if (listed !== "") {
    const [first = ""] = listed.split("\n");
    const more = listed.includes("\n") ? " and more" : "";
    return `${version}, the current version; git tag --list 'v*' printed ${first}${more}`;
  }
  const heading = new RegExp(`^##\\s*\\[${version.replaceAll(".", "\\.")}\\](\\s.*)?$`);
  if ((readText(changelogPath) ?? "").split("\n").some((line) => heading.test(line))) {
    return `${version}, the current version; CHANGELOG.md already has a ## [${version}] section, so it was prepared but not tagged`;
  }
  return undefined;
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
  const changelogPath = join(root, "CHANGELOG.md");
  const refusal =
    version === current ? firstReleaseRefusal(context, version, changelogPath) : undefined;
  const firstRelease = version === current && refusal === undefined;
  if (!RELEASE_VERSION.test(current) || (!isGreater(version, current) && !firstRelease)) {
    throw new ScriptError(
      refusal === undefined
        ? {
            code: "ERR_RELEASE_VERSION_NOT_NEWER",
            summary: `${version} is not greater than the current version ${current}`,
            expected: `a version above ${current}, compared component by component`,
            actual:
              version === current ? `${version}, the current version` : `${version}, below it`,
            next: "pick a higher version, or check whether it was already prepared (`git log -1 package.json`)",
          }
        : {
            code: "ERR_RELEASE_VERSION_NOT_NEWER",
            summary: `${version} is the current version, and this is not the first release`,
            expected: `a version above ${current}, or ${current} itself only for the first release`,
            actual: refusal,
            next: "pick a higher version; the current version is accepted only for the first release, while `git tag --list 'v*'` prints nothing and CHANGELOG.md has no section for it. A prepared but untagged version is tagged, not prepared again",
          },
    );
  }
  const changelog = rollChangelog(changelogPath, version, today);

  log(`release-prep: plan for ${version}`);
  if (firstRelease) {
    log(
      `release-prep: no v* tag exists, so this is the first release, at the current version ${version}`,
    );
  }
  for (const site of sites) {
    const path = site.path.slice(root.length + 1);
    log(firstRelease ? `  ${path}: ${version} (unchanged)` : `  ${path}: ${current} -> ${version}`);
  }
  log("  Cargo.lock: refreshed with `cargo update --workspace --offline`");
  log(`  CHANGELOG.md: the [Unreleased] entries -> "## [${version}] - ${today}"`);
  if (dryRun) {
    log("release-prep: --dry-run, nothing was written. Re-run without --dry-run to apply.");
    return;
  }

  const edits = sites.map((site) => ({
    site,
    text: site.rewrite(readFileSync(site.path, "utf8"), version),
  }));
  const missed = edits.filter(({ site, text }) => site.read(text) !== version);
  if (missed.length > 0) {
    throw new ScriptError({
      code: "ERR_RELEASE_REWRITE",
      summary: "a version site could not be edited in place; nothing was written",
      expected: `each site to declare ${version} after its one-line edit`,
      actual: missed.map(({ site }) => site.path.slice(root.length + 1)).join(", "),
      next: 'write the version as a plain double-quoted string (version = "x.y.z"), then re-run',
    });
  }
  for (const { site, text } of edits) writeFileSync(site.path, text);
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
