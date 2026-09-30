/**
 * The tools that read the tree agree on skipping `.claude/skills/` and on reading
 * `.agents/skills/`. The mirror is a generated, byte-identical copy
 * (`just agents-sync`): checking it reports every finding twice, at a path nobody may
 * edit, and a formatter rewriting the copy alone is drift the mirror check must undo.
 * The opposite ignore is worse — a skill's real files checked nowhere, with CI green.
 *
 *   node scripts/checks/ignore-lists-agree.ts [--root DIR]
 *
 * Read (all required but package.json):
 *   - `.prettierignore`: its lines in order, a later `!` line re-including what an
 *     earlier one excluded;
 *   - `eslint.config.mjs`: the string literals of each `globalIgnores([...])` call and of
 *     each `ignores: [...]` list (the source text, as the config is code);
 *   - `typos.toml`: `[files] extend-exclude` (a real TOML parser);
 *   - `vitest.config.ts`: the globs of its `include: [...]` and `exclude: [...]` lists,
 *     split into the `coverage: { ... }` object's and the rest (the test projects'), plus
 *     any `--coverage.include` in `package.json`'s scripts. Vitest skips the mirror when
 *     no test include reaches a test file in it and no coverage include reaches a source
 *     file in it, or an exclude of the same kind removes that file; a `**` is taken to
 *     reach dot-directories, the cautious reading. It skips the source when an exclude
 *     names `.agents/skills/` or a directory containing it.
 * An entry excludes a directory when, with a leading `/`, `./`, or `**` + `/` and a trailing
 * `/`, `/*`, or `/**` removed, it names that directory or one containing it
 * (`.claude/skills/**` and `.claude/` both exclude `.claude/skills/`). No git work tree needed.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_INPUT_MISSING, ERR_CHECK_INPUT_UNREADABLE (typos.toml or
 * package.json does not parse), ERR_CHECK_IGNORE_MIRROR (a tool reads the mirror),
 * ERR_CHECK_IGNORE_SOURCE (a tool skips the real skills).
 */
import { matchesGlob } from "node:path";

import { parse as parseToml } from "smol-toml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const MIRROR = ".claude/skills";
const SOURCE = ".agents/skills";
const FILES = [".prettierignore", "eslint.config.mjs", "typos.toml", "vitest.config.ts"] as const;

/** The directory an ignore entry names, with anchors and trailing globs removed. */
function entryDir(entry: string): string {
  return entry
    .trim()
    .replace(/^(?:\.\/|\/|\*\*\/)+/, "")
    .replace(/(?:\/\*\*|\/\*)+$/, "")
    .replace(/\/+$/, "");
}

function covers(entry: string, dir: string): boolean {
  const named = entryDir(entry);
  return named !== "" && (dir === named || dir.startsWith(`${named}/`));
}

/** Whether a gitignore-style list, read in order, leaves `dir` excluded. */
function listExcludes(lines: readonly string[], dir: string): boolean {
  let excluded = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      const named = entryDir(line.slice(1));
      if (named === dir || named.startsWith(`${dir}/`) || dir.startsWith(`${named}/`))
        excluded = false;
    } else if (covers(line, dir)) {
      excluded = true;
    }
  }
  return excluded;
}

/** The string literals of every `<key>: [...]` list, or `globalIgnores([...])` call. */
function literalLists(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/(["'`])((?:(?!\1).)*)\1/g)].map((literal) => literal[2] ?? ""),
  );
}

/** `path` with the leading dot of each segment dropped, so `**` reaches dot-directories. */
const undotted = (path: string): string => path.replace(/(^|\/)\.(?=[^/.*])/g, "$1");

/** Whether `file` is reached by an include glob and not removed by an exclude glob. */
function reached(
  file: string,
  globs: { include: readonly string[]; exclude: readonly string[] },
): boolean {
  const matches = (list: readonly string[]): boolean =>
    list.some((glob) => matchesGlob(undotted(file), undotted(glob)));
  return matches(globs.include) && !matches(globs.exclude);
}

/** The text of the `coverage: { ... }` object in a Vitest config, and the rest. */
function splitCoverage(source: string): { coverage: string; rest: string } {
  const open = /\bcoverage\s*:\s*\{/.exec(source);
  if (open === null) return { coverage: "", rest: source };
  const start = open.index + open[0].length;
  let depth = 1;
  let end = start;
  while (end < source.length && depth > 0) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") depth -= 1;
    end += 1;
  }
  return {
    coverage: source.slice(start, end),
    rest: source.slice(0, open.index) + source.slice(end),
  };
}

function mirrorViolation(path: string): FailureDetails {
  return {
    code: "ERR_CHECK_IGNORE_MIRROR",
    summary: `${path} does not exclude ${MIRROR}/`,
    expected: `Prettier, ESLint, typos, and Vitest all to skip ${MIRROR}/, the generated mirror of ${SOURCE}/ (\`just agents-sync\`)`,
    actual: `${path} lets its tool read ${MIRROR}/`,
    next: `add \`${MIRROR}/\` to ${path}'s ignore list (a gate change: the changing-gates skill)`,
  };
}

function sourceViolation(path: string): FailureDetails {
  return {
    code: "ERR_CHECK_IGNORE_SOURCE",
    summary: `${path} excludes ${SOURCE}/, the skills' real files`,
    expected: `every tool to read ${SOURCE}/, where the skills are authored, and skip only the mirror`,
    actual: `${path} skips ${SOURCE}/`,
    next: `remove the entry that covers ${SOURCE}/ from ${path}; exclude ${MIRROR}/ instead`,
  };
}

function unreadable(path: string, error: unknown): FailureDetails {
  return {
    code: "ERR_CHECK_INPUT_UNREADABLE",
    summary: `${path} does not parse`,
    expected: `${path} to parse, so its ignore list can be read`,
    actual: (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "",
    next: `fix ${path}`,
  };
}

function run(root: string): FailureDetails[] {
  const texts = FILES.map((path) => readRepoFile(root, path));
  const [prettier, eslint, typos, vitest] = texts;
  if (
    prettier === undefined ||
    eslint === undefined ||
    typos === undefined ||
    vitest === undefined
  ) {
    const missing = FILES.filter((_, index) => texts[index] === undefined);
    return [
      {
        code: "ERR_CHECK_INPUT_MISSING",
        summary: `${missing.join(", ")} does not exist`,
        expected: `${FILES.join(", ")} at the root`,
        actual: `missing: ${missing.join(", ")}`,
        next: "run the check against the repository root (--root DIR)",
      },
    ];
  }

  let typosExcludes: string[];
  try {
    const files: unknown = parseToml(typos)["files"];
    const list =
      typeof files === "object" && files !== null && "extend-exclude" in files
        ? files["extend-exclude"]
        : [];
    typosExcludes = Array.isArray(list)
      ? list.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch (error: unknown) {
    return [unreadable("typos.toml", error)];
  }

  let coverageIncludes: string[] = [];
  const pkg = readRepoFile(root, "package.json");
  if (pkg !== undefined) {
    try {
      const scripts: unknown = (JSON.parse(pkg) as { scripts?: unknown }).scripts;
      const commands =
        typeof scripts === "object" && scripts !== null ? Object.values(scripts) : [];
      coverageIncludes = commands
        .filter((command): command is string => typeof command === "string")
        .flatMap((command) =>
          [...command.matchAll(/--coverage\.include[= ](?:'([^']*)'|"([^"]*)"|(\S+))/g)].map(
            (match) => match[1] ?? match[2] ?? match[3] ?? "",
          ),
        );
    } catch (error: unknown) {
      return [unreadable("package.json", error)];
    }
  }

  const prettierLines = prettier.split("\n");
  const eslintIgnores = literalLists(
    eslint,
    /(?:globalIgnores\(\s*|\bignores\s*:\s*)\[([^\]]*)\]/g,
  );
  const { coverage, rest } = splitCoverage(vitest);
  const lists = (source: string): { include: string[]; exclude: string[] } => ({
    include: literalLists(source, /\binclude\s*:\s*\[([^\]]*)\]/g),
    exclude: literalLists(source, /\bexclude\s*:\s*\[([^\]]*)\]/g),
  });
  const tests = lists(rest);
  const covered = lists(coverage);
  // A test file Vitest would collect, and a source file its coverage would measure.
  const vitestReads = (dir: string): boolean =>
    reached(`${dir}/probe/scripts/probe.test.ts`, tests) ||
    reached(`${dir}/probe/scripts/probe.ts`, covered);

  const violations: FailureDetails[] = [];
  const mirror: [string, boolean][] = [
    [".prettierignore", listExcludes(prettierLines, MIRROR)],
    ["eslint.config.mjs", eslintIgnores.some((entry) => covers(entry, MIRROR))],
    ["typos.toml", typosExcludes.some((entry) => covers(entry, MIRROR))],
    ["vitest.config.ts", !vitestReads(MIRROR)],
    [
      "package.json",
      !reached(`${MIRROR}/probe/scripts/probe.ts`, {
        include: coverageIncludes,
        exclude: covered.exclude,
      }),
    ],
  ];
  for (const [path, excluded] of mirror) {
    if (!excluded) violations.push(mirrorViolation(path));
  }
  const source: [string, boolean][] = [
    [".prettierignore", listExcludes(prettierLines, SOURCE)],
    ["eslint.config.mjs", eslintIgnores.some((entry) => covers(entry, SOURCE))],
    ["typos.toml", typosExcludes.some((entry) => covers(entry, SOURCE))],
    [
      "vitest.config.ts",
      [...tests.exclude, ...covered.exclude].some((entry) => covers(entry, SOURCE)),
    ],
  ];
  for (const [path, excluded] of source) {
    if (excluded) violations.push(sourceViolation(path));
  }
  return violations;
}

export const check: Check = { name: "ignore-lists-agree", run };
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
