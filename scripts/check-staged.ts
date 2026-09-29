/**
 * The staged guard (design D11): refuse a commit that would put a secret into history,
 * judged from the git index alone. The pre-commit hook runs it (lefthook.yml).
 *
 * Two phases per staged path: the path (scripts/lib/guard/paths.ts), then — only if the
 * path passes — the staged blob (scripts/lib/guard/credentials.ts), read by blob id from
 * the index, so a partially staged file is judged as it will be committed. Every finding
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
import { runScript, type ScriptContext } from "./lib/script.ts";

const GITLINK_MODE = "160000";
/**
 * spawnSync's 1 MiB default would refuse any larger staged file (ENOBUFS). GitHub
 * rejects a file over 100 MiB, so a blob past this cap cannot be pushed anyway, and
 * the guard fails closed on it rather than skipping it.
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

export function main(context: ScriptContext): void {
  const env = stagedGuardEnv(context.env);
  const git = (...args: string[]) =>
    context.run("git", args, { cwd: context.root, env, maxBuffer: READ_MAX_BUFFER });

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

  const findings: { code: string; line: string }[] = [];
  for (const { mode, blob, path } of parseRaw(listed.stdout)) {
    const reason = blockedPathReason(path);
    if (reason !== null) {
      findings.push({ code: "ERR_STAGED_BLOCKED_PATH", line: `${path} — ${reason}` });
      continue;
    }
    if (mode === GITLINK_MODE) continue; // a submodule names a commit elsewhere; no blob here
    const content = git("cat-file", "blob", blob);
    if (content.status !== 0) {
      throw readFailed(
        `could not read the staged content of ${path}`,
        "`git cat-file blob` to print every staged blob (each at most 256 MiB)",
        content.stderr.trim(),
      );
    }
    const category = credentialCategory(content.stdout);
    if (category !== null) {
      findings.push({
        code: "ERR_STAGED_CREDENTIAL_SHAPED",
        line: `${path} — content matches the ${category} pattern`,
      });
    }
  }

  const [first] = findings;
  if (first !== undefined) {
    throw new ScriptError({
      code: first.code,
      summary: `${String(findings.length)} staged path(s) refused (the matched text is never printed)`,
      expected:
        "no staged path matching scripts/lib/guard/paths.ts and no staged content matching scripts/lib/guard/credentials.ts",
      actual: findings.map((finding) => `${finding.code}: ${finding.line}`).join("\n"),
      next: "unstage each file with `git restore --staged <path>`; keep the value in the keychain or a CI secret and reference it; if the file must be committed, remove the secret first",
    });
  }
}

if (import.meta.main) await runScript(main);
