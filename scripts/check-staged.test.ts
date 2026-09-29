import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "./check-staged.ts";
import { ScriptError } from "./lib/fail.ts";
import { gitEnv } from "./lib/git-env.ts";
import { runCommand, type Run, type ScriptContext } from "./lib/script.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Assembled at runtime: this file must never hold a credential-shaped literal.
const AWS_KEY_ID = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");

function git(repo: string, ...args: string[]): string {
  const result = runCommand("git", args, { cwd: repo, env: gitEnv(process.env) });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-staged-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function context(
  root: string,
  env: Record<string, string | undefined> = gitEnv(process.env),
  run: Run = runCommand,
): ScriptContext {
  return { argv: [], env, root, run, log: () => undefined };
}

function failure(fn: () => void): ScriptError {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

describe("check-staged", () => {
  it("passes a clean staged change", () => {
    const dir = repo();
    writeFileSync(join(dir, "notes.txt"), "nothing secret\n");
    git(dir, "add", "notes.txt");
    expect(() => {
      main(context(dir));
    }).not.toThrow();
  });

  it("refuses a secret-shaped path by name, without reading it", () => {
    const dir = repo();
    writeFileSync(join(dir, ".env"), "harmless\n");
    git(dir, "add", ".env");
    const error = failure(() => {
      main(context(dir));
    });
    expect(error.details.code).toBe("ERR_STAGED_BLOCKED_PATH");
    expect(error.details.actual).toContain(".env — an environment file");
  });

  it("refuses credential-shaped content and never prints it", () => {
    const dir = repo();
    writeFileSync(join(dir, "config.txt"), `key = ${AWS_KEY_ID}\n`);
    git(dir, "add", "config.txt");
    const error = failure(() => {
      main(context(dir));
    });
    expect(error.details.code).toBe("ERR_STAGED_CREDENTIAL_SHAPED");
    expect(error.details.actual).toContain(
      "config.txt — content matches the aws-access-key-id pattern",
    );
    expect(JSON.stringify(error.details)).not.toContain(AWS_KEY_ID);
  });

  it("names every finding in one run", () => {
    const dir = repo();
    writeFileSync(join(dir, ".env"), "x\n");
    writeFileSync(join(dir, "a.txt"), `${AWS_KEY_ID}\n`);
    git(dir, "add", ".env", "a.txt");
    const error = failure(() => {
      main(context(dir));
    });
    expect(error.details.actual).toContain(".env");
    expect(error.details.actual).toContain("a.txt");
    expect(error.details.summary).toContain("2");
  });

  it("judges the staged blob, not the worktree", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "clean\n");
    git(dir, "add", "a.txt");
    writeFileSync(join(dir, "a.txt"), `${AWS_KEY_ID}\n`); // unstaged edit
    expect(() => {
      main(context(dir));
    }).not.toThrow();

    writeFileSync(join(dir, "b.txt"), `${AWS_KEY_ID}\n`);
    git(dir, "add", "b.txt");
    writeFileSync(join(dir, "b.txt"), "clean now\n"); // the index still holds the secret
    expect(
      failure(() => {
        main(context(dir));
      }).details.code,
    ).toBe("ERR_STAGED_CREDENTIAL_SHAPED");
  });

  it("judges a staged blob larger than Node's 1 MiB spawn buffer", () => {
    const dir = repo();
    const large = `${"a".repeat(1023)}\n`.repeat(2 * 1024); // 2 MiB
    writeFileSync(join(dir, "large.txt"), large);
    git(dir, "add", "large.txt");
    expect(() => {
      main(context(dir));
    }).not.toThrow();

    // The secret sits past the first MiB, so a truncated read would miss it.
    writeFileSync(join(dir, "large-leak.txt"), `${large}${AWS_KEY_ID}\n`);
    git(dir, "add", "large-leak.txt");
    const error = failure(() => {
      main(context(dir));
    });
    expect(error.details.code).toBe("ERR_STAGED_CREDENTIAL_SHAPED");
    expect(error.details.actual).toContain("large-leak.txt");
    expect(error.details.actual).not.toContain("large.txt —");
  });

  it("lets a commit delete a file that held a secret", () => {
    const dir = repo();
    writeFileSync(join(dir, "leak.txt"), `${AWS_KEY_ID}\n`);
    git(dir, "add", "leak.txt");
    git(dir, "commit", "-q", "--no-verify", "-m", "leak");
    git(dir, "rm", "-q", "leak.txt");
    expect(() => {
      main(context(dir));
    }).not.toThrow();
  });

  it("refuses a rename onto a blocked name", () => {
    const dir = repo();
    git(dir, "mv", "README.md", "secrets.json");
    expect(
      failure(() => {
        main(context(dir));
      }).details.actual,
    ).toContain("secrets.json");
  });

  it("reads the index GIT_INDEX_FILE names, as in `git commit -- <path>`", () => {
    const dir = repo();
    const index = join(dir, ".git", "alt-index");
    writeFileSync(join(dir, "a.txt"), `${AWS_KEY_ID}\n`);
    runCommand("git", ["read-tree", "HEAD"], {
      cwd: dir,
      env: { ...gitEnv(process.env), GIT_INDEX_FILE: index },
    });
    runCommand("git", ["add", "a.txt"], {
      cwd: dir,
      env: { ...gitEnv(process.env), GIT_INDEX_FILE: index },
    });
    expect(() => {
      main(context(dir));
    }).not.toThrow();
    expect(
      failure(() => {
        main(context(dir, { ...gitEnv(process.env), GIT_INDEX_FILE: index }));
      }).details.code,
    ).toBe("ERR_STAGED_CREDENTIAL_SHAPED");
  });

  it("refuses to run outside a git work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    dirs.push(dir);
    expect(
      failure(() => {
        main(context(dir));
      }).details.code,
    ).toBe("ERR_STAGED_NOT_A_REPO");
  });

  it("fails closed when the staged list cannot be read", () => {
    const run: Run = (_command, args) =>
      args[0] === "rev-parse"
        ? { status: 0, stdout: "true\n", stderr: "" }
        : { status: 128, stdout: "", stderr: "boom" };
    expect(
      failure(() => {
        main(context("/nowhere", {}, run));
      }).details.code,
    ).toBe("ERR_STAGED_READ_FAILED");
  });

  it("fails closed when a staged blob cannot be read", () => {
    const blob = "a".repeat(40);
    const run: Run = (_command, args) => {
      if (args[0] === "rev-parse") return { status: 0, stdout: "true\n", stderr: "" };
      if (args[0] === "diff")
        return {
          status: 0,
          stdout: `:000000 100644 ${"0".repeat(40)} ${blob} A\0a.txt\0`,
          stderr: "",
        };
      return { status: 128, stdout: "", stderr: "bad object" };
    };
    expect(
      failure(() => {
        main(context("/nowhere", {}, run));
      }).details.code,
    ).toBe("ERR_STAGED_READ_FAILED");
  });

  it("skips a submodule entry, which has no blob to scan", () => {
    const commit = "b".repeat(40);
    const calls: string[] = [];
    const run: Run = (_command, args) => {
      calls.push(args[0] ?? "");
      if (args[0] === "rev-parse") return { status: 0, stdout: "true\n", stderr: "" };
      return {
        status: 0,
        stdout: `:000000 160000 ${"0".repeat(40)} ${commit} A\0vendor/lib\0`,
        stderr: "",
      };
    };
    main(context("/nowhere", {}, run));
    expect(calls).toEqual(["rev-parse", "diff"]);
  });
});
