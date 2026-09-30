/**
 * The staged guard: refuse a commit that would put a secret into history,
 * judged from the git index alone. The pre-commit hook runs it (lefthook.yml).
 *
 * Two phases per staged path: the path (scripts/lib/guard/paths.ts), then — only if the
 * path passes — the staged blob (scripts/lib/guard/credentials.ts), read by blob id from
 * the index through one `git cat-file --batch` for the whole run, so a partially staged file is judged as it will be committed. Every finding
 * is collected before failing once. Output never contains file content: a finding names
 * the path and the rule, never the matched text.
 *
 * Deletions are never inspected (a deletion cannot add a secret, and refusing it would
 * block the commit that removes one). Spawned git keeps GIT_INDEX_FILE, which
 * `git commit -- <path>` uses for its temporary index, and drops every other GIT_*.
 *
 * Errors: ERR_STAGED_NOT_A_REPO, ERR_STAGED_READ_FAILED, ERR_STAGED_BLOCKED_PATH,
 * ERR_STAGED_CREDENTIAL_SHAPED (the first finding's code when there are several).
 */
import { ScriptError } from "./lib/fail.ts";
import { stagedGuardEnv } from "./lib/git-env.ts";
import { credentialCategory } from "./lib/guard/credentials.ts";
import { blockedPathReason } from "./lib/guard/paths.ts";
import { runScript, type RunOptions, type RunResult, type ScriptContext } from "./lib/script.ts";

const GITLINK_MODE = "160000";
/**
 * spawnSync's 1 MiB default would refuse any larger staged file (ENOBUFS). GitHub
 * rejects a file over 100 MiB, so a blob past this cap cannot be pushed anyway, and
 * the guard fails closed on it rather than skipping it. Every blob is read by one
 * `git cat-file --batch`, so the cap bounds all staged content together.
 */
const READ_MAX_BUFFER = 256 * 1024 * 1024;

interface StagedEntry {
  readonly mode: string;
  readonly blob: string;
  readonly path: string;
}

/** Parse `git diff --cached --raw -z`: a ":<modes> <ids> <status>" field, then the path. */
function parseRaw(output: string): StagedEntry[] {
  const fields = output.split("\0");
  const entries: StagedEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode = "", , blob = ""] = (fields[i] ?? "").split(" ");
    entries.push({ mode, blob, path: fields[i + 1] ?? "" });
  }
  return entries;
}

function readFailed(summary: string, expected: string, actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_STAGED_READ_FAILED",
    summary,
    expected,
    actual,
    next: "check `git status` and the index, then retry the commit",
  });
}

/**
 * Read every blob through one `git cat-file --batch`, whose output is a
 * `<id> blob <size>\n<content>\n` frame per requested id (or `<id> missing\n`). Output
 * is decoded as latin1 so a byte size is a string length; each blob is re-decoded as
 * UTF-8, as `git cat-file blob` output was. Any frame that is not the blob asked for
 * fails closed.
 */
function readBlobs(
  git: (options: RunOptions, ...args: string[]) => RunResult,
  entries: readonly StagedEntry[],
): Map<string, string> {
  const contents = new Map<string, string>();
  if (entries.length === 0) return contents;
  const expected = "`git cat-file --batch` to print every staged blob (at most 256 MiB in total)";
  const batch = git(
    { input: entries.map(({ blob }) => `${blob}\n`).join(""), encoding: "latin1" },
    "cat-file",
    "--batch",
  );
  if (batch.status !== 0) {
    throw readFailed("could not read the staged content", expected, batch.stderr.trim());
  }
  const out = batch.stdout;
  let offset = 0;
  for (const { blob, path } of entries) {
    const headerEnd = out.indexOf("\n", offset);
    const header = headerEnd === -1 ? out.slice(offset) : out.slice(offset, headerEnd);
    const [id, type, sizeText = ""] = header.split(" ");
    const size = Number(sizeText);
    const start = headerEnd + 1;
    if (
      headerEnd === -1 ||
      id !== blob ||
      type !== "blob" ||
      !/^\d+$/.test(sizeText) ||
      out.length < start + size + 1 ||
      out[start + size] !== "\n"
    ) {
      throw readFailed(
        `could not read the staged content of ${path}`,
        expected,
        `\`git cat-file --batch\` answered \`${header.slice(0, 200)}\` for ${blob}`,
      );
    }
    contents.set(path, Buffer.from(out.slice(start, start + size), "latin1").toString("utf8"));
    offset = start + size + 1;
  }
  return contents;
}

export function main(context: ScriptContext): void {
  const env = stagedGuardEnv(context.env);
  const gitWith = (options: RunOptions, ...args: string[]) =>
    context.run("git", args, { ...options, cwd: context.root, env, maxBuffer: READ_MAX_BUFFER });
  const git = (...args: string[]) => gitWith({}, ...args);

  if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") {
    throw new ScriptError({
      code: "ERR_STAGED_NOT_A_REPO",
      summary: "not inside a git work tree",
      expected: "to run from inside the repository whose index is being committed",
      actual: `\`git rev-parse --is-inside-work-tree\` did not print true in ${context.root}`,
      next: "cd into the repository and re-run `node scripts/check-staged.ts`",
    });
  }

  // --no-renames reports a rename as a deletion plus an addition, so the new path is
  // always the only path in an entry.
  const listed = git(
    "diff",
    "--cached",
    "--raw",
    "-z",
    "--no-abbrev",
    "--no-renames",
    "--diff-filter=ACMRT",
  );
  if (listed.status !== 0) {
    throw readFailed(
      "could not list the staged changes",
      "`git diff --cached --raw` to exit 0",
      listed.stderr.trim(),
    );
  }

  const entries = parseRaw(listed.stdout);
  const toRead = entries.filter(
    ({ mode, path }) => blockedPathReason(path) === null && mode !== GITLINK_MODE, // a submodule names a commit elsewhere; no blob here
  );
  const contents = readBlobs(gitWith, toRead);

  const findings: { code: string; line: string }[] = [];
  for (const { path } of entries) {
    const reason = blockedPathReason(path);
    if (reason !== null) {
      findings.push({ code: "ERR_STAGED_BLOCKED_PATH", line: `${path} — ${reason}` });
      continue;
    }
    const content = contents.get(path);
    if (content === undefined) continue;
    const category = credentialCategory(content);
    if (category !== null) {
      findings.push({
        code: "ERR_STAGED_CREDENTIAL_SHAPED",
        line: `${path} — content matches the ${category} pattern`,
      });
    }
  }

  const [first] = findings;
  if (first !== undefined) {
    // `git restore --staged` resets a path to HEAD, which during a merge also throws away
    // the other side's change to it.
    const merging = git("rev-parse", "-q", "--verify", "MERGE_HEAD").status === 0;
    throw new ScriptError({
      code: first.code,
      summary: `${String(findings.length)} staged path(s) refused (the matched text is never printed)`,
      expected:
        "no staged path matching scripts/lib/guard/paths.ts and no staged content matching scripts/lib/guard/credentials.ts",
      actual: findings.map((finding) => `${finding.code}: ${finding.line}`).join("\n"),
      next: merging
        ? "a merge is in progress, so never `git restore --staged` (it would drop the other side's change): remove the secret from each file and `git add` it again, or `git rm --cached <path>` a secret-shaped path; keep the value in the keychain or a CI secret and reference it"
        : "unstage each file with `git restore --staged <path>`; keep the value in the keychain or a CI secret and reference it; if the file must be committed, remove the secret first",
    });
  }
}

if (import.meta.main) await runScript(main);
