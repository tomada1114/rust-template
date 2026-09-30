/**
 * Writes a release's notes: CHANGELOG.md's `## [<version>]` section and, for an ad-hoc
 * signed build, how to open it the first time. The release workflow's build job runs it
 * and the publish job passes the file to `gh release create --notes-file`, which keeps
 * `--generate-notes` and so appends GitHub's categorized pull-request list below it.
 *
 *   node scripts/release-notes.ts --out <file> [--ad-hoc] [--allow-missing] <version>
 *
 * --ad-hoc appends the "Opening this build" section, naming src-tauri/tauri.conf.json's
 * productName (read only with this flag). --allow-missing writes a placeholder when the
 * version has no section, or an empty one, instead of failing; the workflow passes it
 * only on a run that will not publish. --out is resolved against the repository root;
 * its directories are created and an existing file is overwritten.
 *
 * Runs outside a git work tree too: it reads files under the root and writes the one
 * file --out names, and enumerates or rewrites no tracked file. Nothing is written when
 * it fails.
 *
 * Errors: ERR_RELEASE_NOTES_USAGE, ERR_RELEASE_NOTES_CHANGELOG_MISSING,
 * ERR_RELEASE_NOTES_SECTION_MISSING, ERR_RELEASE_NOTES_SECTION_EMPTY,
 * ERR_RELEASE_NOTES_PRODUCT_NAME.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

const USAGE =
  "usage: node scripts/release-notes.ts --out <file> [--ad-hoc] [--allow-missing] <version>";
// The same shape scripts/release-prep.ts accepts; copied, since the two scripts share no code.
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface Args {
  readonly out: string;
  readonly adHoc: boolean;
  readonly allowMissing: boolean;
  readonly version: string;
}

/** A version's section of the changelog, or the placeholder that stands in for it. */
interface Section {
  readonly body: string;
  readonly placeholder: boolean;
}

function usage(summary: string, actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_RELEASE_NOTES_USAGE",
    summary,
    expected: "--out <file>, optional --ad-hoc and --allow-missing, and exactly one version",
    actual,
    next: USAGE,
  });
}

function parseArgs(argv: readonly string[]): Args {
  let out: string | undefined;
  let adHoc = false;
  let allowMissing = false;
  const versions: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--out") {
      if (out !== undefined) throw usage("--out is given twice", `--out ${out} and --out again`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw usage(
          "--out needs a file",
          value === undefined ? "--out is the last argument" : `--out followed by '${value}'`,
        );
      }
      out = value;
      i += 1;
    } else if (arg === "--ad-hoc") adHoc = true;
    else if (arg === "--allow-missing") allowMissing = true;
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
    throw usage(`'${version}' is not a release version`, `'${version}'`);
  }
  if (out === undefined) throw usage("--out is required", "no --out argument");
  return { out, adHoc, allowMissing, version };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isBlank = (line: string): boolean => line.trim() === "";

function placeholder(version: string): string {
  return `_CHANGELOG.md has no entries for ${version} yet. This placeholder appears only in a dry run; a tagged release fails until \`just release-prep ${version}\` has rolled them._`;
}

/** The body under `## [<version>]`, up to the next `## ` heading, blank edges trimmed. */
function sectionOf(changelog: string, version: string, allowMissing: boolean): Section {
  const lines = changelog.split("\n");
  const heading = new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\](\\s.*)?$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    if (allowMissing) return { body: placeholder(version), placeholder: true };
    throw new ScriptError({
      code: "ERR_RELEASE_NOTES_SECTION_MISSING",
      summary: `CHANGELOG.md has no section for ${version}`,
      expected: `a \`## [${version}]\` heading in CHANGELOG.md, written by just release-prep`,
      actual: `no heading matches [${version}]`,
      next: `run \`just release-prep ${version}\`, merge its pull request, then tag the merge commit`,
    });
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  const section = end === -1 ? rest : rest.slice(0, end);
  if (!section.some((line) => !isBlank(line) && !line.startsWith("###"))) {
    if (allowMissing) return { body: placeholder(version), placeholder: true };
    throw new ScriptError({
      code: "ERR_RELEASE_NOTES_SECTION_EMPTY",
      summary: `CHANGELOG.md's section for ${version} has no entries`,
      expected: `at least one entry under \`## [${version}]\``,
      actual: "the section holds no entry line",
      next: `add the entries under \`## [${version}]\` in CHANGELOG.md`,
    });
  }
  const first = section.findIndex((line) => !isBlank(line));
  const last = section.findLastIndex((line) => !isBlank(line));
  return { body: section.slice(first, last + 1).join("\n"), placeholder: false };
}

/** How to open an ad-hoc signed download: docs/distribution.md's steps, for a downloader. */
function openingSection(productName: string): string {
  return [
    "## Opening this build",
    "",
    "This build is ad-hoc signed and not notarized, so macOS refuses to open it the first time. Either:",
    "",
    `- try to open ${productName} once, then go to **System Settings › Privacy & Security**, find the message about ${productName} under **Security**, click **Open Anyway**, and confirm with your login password. The button is offered for about an hour after the blocked attempt; or`,
    `- after copying ${productName} to Applications, remove the quarantine attribute in Terminal:`,
    "",
    "  ```bash",
    `  xattr -dr com.apple.quarantine "/Applications/${productName}.app"`,
    "  ```",
  ].join("\n");
}

function compose(section: Section, productName: string | undefined): string {
  const parts = [section.body];
  if (productName !== undefined) parts.push(openingSection(productName));
  return `${parts.join("\n\n")}\n`;
}

/**
 * The notes for `version`: its changelog section (or, with `allowMissing`, a placeholder
 * when it is missing or empty), then the ad-hoc opening steps when `productName` is set.
 */
export function renderNotes(input: {
  readonly changelog: string;
  readonly version: string;
  readonly productName: string | undefined;
  readonly allowMissing: boolean;
}): { text: string; placeholder: boolean } {
  const section = sectionOf(input.changelog, input.version, input.allowMissing);
  return { text: compose(section, input.productName), placeholder: section.placeholder };
}

function readProductName(root: string): string {
  const path = join(root, "src-tauri", "tauri.conf.json");
  const fail = (actual: string): ScriptError =>
    new ScriptError({
      code: "ERR_RELEASE_NOTES_PRODUCT_NAME",
      summary: "the ad-hoc opening steps need the app's productName",
      expected: `a non-empty string \`productName\` in ${path}`,
      actual,
      next: "fix `productName` in src-tauri/tauri.conf.json, then re-run",
    });
  if (!existsSync(path)) throw fail(`no file at ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    throw fail(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const name: unknown =
    typeof parsed === "object" && parsed !== null && "productName" in parsed
      ? parsed.productName
      : undefined;
  if (typeof name !== "string" || name === "") {
    throw fail(`productName is ${name === undefined ? "missing" : JSON.stringify(name)}`);
  }
  return name;
}

export function main(context: ScriptContext): void {
  const { root, log } = context;
  const args = parseArgs(context.argv);
  const changelogPath = join(root, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    throw new ScriptError({
      code: "ERR_RELEASE_NOTES_CHANGELOG_MISSING",
      summary: "CHANGELOG.md is missing",
      expected: `a Keep a Changelog file at ${changelogPath}`,
      actual: `no file at ${changelogPath}`,
      next: "restore CHANGELOG.md, then re-run",
    });
  }
  // The section is judged before the product name is read: the documented check order.
  const section = sectionOf(readFileSync(changelogPath, "utf8"), args.version, args.allowMissing);
  const productName = args.adHoc ? readProductName(root) : undefined;

  const target = resolve(root, args.out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, compose(section, productName));

  if (section.placeholder) {
    log(
      `release-notes: WARNING: CHANGELOG.md has no entries for ${args.version}; wrote a placeholder (--allow-missing)`,
    );
  }
  const source = section.placeholder
    ? "as a placeholder"
    : `from CHANGELOG.md's [${args.version}] section`;
  log(
    `release-notes: wrote ${args.out} ${source}${args.adHoc ? ", plus the ad-hoc opening steps" : ""}`,
  );
}

if (import.meta.main) await runScript(main);
