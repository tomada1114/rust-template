import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError } from "./lib/fail.ts";
import { gitEnv } from "./lib/git-env.ts";
import { runCommand, type RunResult, type ScriptContext } from "./lib/script.ts";
import { main, prepare } from "./release-prep.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CARGO = `[workspace]
members = ["core"]

[workspace.package]
version = "0.1.0" # one of the three version sites (design D18)
edition = "2024"

[workspace.dependencies]
serde = { version = "1.0.0" }
`;

const TAURI = `{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "app",
  "version": "0.1.0",
  "identifier": "com.example.app"
}
`;

const PACKAGE = `{
  "name": "app",
  "version": "0.1.0",
  "private": true,
  "dependencies": { "react": "19.0.0" }
}
`;

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- The template.

## [0.0.1] - 2026-01-01

- Earlier.
`;

interface Files {
  cargo?: string | undefined;
  tauri?: string | undefined;
  pkg?: string | undefined;
  changelog?: string | undefined;
}

const git = (dir: string, args: string[]): RunResult =>
  runCommand("git", args, { cwd: dir, env: gitEnv(process.env) });

/** A committed checkout holding the three version sites and a changelog. */
function repo(files: Files = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "release-prep-"));
  dirs.push(dir);
  git(dir, ["init", "-q"]);
  const write = (path: string, content: string | undefined): void => {
    if (content !== undefined) writeFileSync(join(dir, path), content);
  };
  write("Cargo.toml", "cargo" in files ? files.cargo : CARGO);
  mkdirSync(join(dir, "src-tauri"));
  write(join("src-tauri", "tauri.conf.json"), "tauri" in files ? files.tauri : TAURI);
  write("package.json", "pkg" in files ? files.pkg : PACKAGE);
  write("CHANGELOG.md", "changelog" in files ? files.changelog : CHANGELOG);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"]);
  return dir;
}

function setup(
  root: string,
  argv: string[],
  cargo: RunResult = { status: 0, stdout: "", stderr: "" },
) {
  const lines: string[] = [];
  const calls: string[][] = [];
  const context: ScriptContext = {
    argv,
    env: { ...process.env, GIT_DIR: "/nonexistent" },
    root,
    run: (command, args, options) => {
      calls.push([command, ...args]);
      return command === "cargo" ? cargo : runCommand(command, args, options);
    },
    log: (line) => lines.push(line),
  };
  return { context, lines, calls };
}

function caught(action: () => void): ScriptError {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

const read = (dir: string, path: string): string => readFileSync(join(dir, path), "utf8");

describe("release-prep", () => {
  it("rewrites the three version sites, refreshes the lockfile, and rolls the changelog", () => {
    const dir = repo();
    const { context, lines, calls } = setup(dir, ["0.2.0"]);
    prepare(context, "2026-09-28");

    expect(read(dir, "Cargo.toml")).toBe(
      CARGO.replace('version = "0.1.0" #', 'version = "0.2.0" #'),
    );
    expect(read(dir, "src-tauri/tauri.conf.json")).toBe(TAURI.replace("0.1.0", "0.2.0"));
    expect(read(dir, "package.json")).toBe(PACKAGE.replace("0.1.0", "0.2.0"));
    expect(read(dir, "CHANGELOG.md")).toBe(
      CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n## [0.2.0] - 2026-09-28\n"),
    );
    expect(calls).toContainEqual(["cargo", "update", "--workspace", "--offline"]);
    const log = lines.join("\n");
    expect(log).toContain("0.1.0 -> 0.2.0");
    expect(log).toContain("chore: release v0.2.0");
    expect(log).toContain("git tag v0.2.0");
  });

  it("compares versions component by component", () => {
    const at = (version: string): Files => ({
      cargo: CARGO.replace('"0.1.0"', `"${version}"`),
      tauri: TAURI.replace("0.1.0", version),
      pkg: PACKAGE.replace("0.1.0", version),
    });
    const dir = repo(at("1.9.0"));
    prepare(setup(dir, ["1.10.0"]).context, "2026-09-28");
    expect(read(dir, "package.json")).toContain('"version": "1.10.0"');
  });

  it("writes nothing on --dry-run", () => {
    const dir = repo();
    const { context, lines, calls } = setup(dir, ["--dry-run", "0.2.0"]);
    prepare(context, "2026-09-28");
    expect(git(dir, ["status", "--porcelain"]).stdout).toBe("");
    expect(calls.some((call) => call[0] === "cargo")).toBe(false);
    expect(lines.join("\n")).toContain("--dry-run");
  });

  it("main uses today's UTC date", () => {
    const dir = repo();
    main(setup(dir, ["0.2.0"]).context);
    const today = new Date().toISOString().slice(0, 10);
    expect(read(dir, "CHANGELOG.md")).toContain(`## [0.2.0] - ${today}`);
  });

  it.each([
    ["no version", []],
    ["two versions", ["0.2.0", "0.3.0"]],
    ["an unknown flag", ["--force", "0.2.0"]],
  ])("fails with usage for %s", (_label, argv) => {
    expect(
      caught(() => {
        prepare(setup(repo(), argv).context, "2026-09-28");
      }).details.code,
    ).toBe("ERR_RELEASE_USAGE");
  });

  it.each(["1.0", "v1.0.0", "1.0.0-rc.1", "01.0.0", "1.0.0+4"])(
    "rejects the version %j",
    (version) => {
      expect(
        caught(() => {
          prepare(setup(repo(), [version]).context, "2026-09-28");
        }).details.code,
      ).toBe("ERR_RELEASE_VERSION_INVALID");
    },
  );

  it("fails outside a git work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-prep-bare-"));
    dirs.push(dir);
    expect(
      caught(() => {
        prepare(setup(dir, ["0.2.0"]).context, "2026-09-28");
      }).details.code,
    ).toBe("ERR_RELEASE_NOT_A_REPO");
  });

  it("fails on a dirty work tree", () => {
    const dir = repo();
    writeFileSync(join(dir, "stray.txt"), "x");
    const error = caught(() => {
      prepare(setup(dir, ["0.2.0"]).context, "2026-09-28");
    });
    expect(error.details.code).toBe("ERR_RELEASE_DIRTY");
    expect(error.details.actual).toContain("stray.txt");
  });

  it.each<[string, Files]>([
    ["Cargo.toml disagrees", { cargo: CARGO.replace('"0.1.0"', '"0.1.1"') }],
    ["tauri.conf.json disagrees", { tauri: TAURI.replace("0.1.0", "0.0.9") }],
    ["package.json has no version", { pkg: '{ "name": "app" }\n' }],
    ["Cargo.toml has no [workspace.package] version", { cargo: "[workspace]\n" }],
    ["tauri.conf.json is missing", { tauri: undefined }],
  ])("fails when %s", (_label, files) => {
    const error = caught(() => {
      prepare(setup(repo(files), ["0.2.0"]).context, "2026-09-28");
    });
    expect(error.details.code).toBe("ERR_RELEASE_VERSIONS_DIFFER");
  });

  it.each(["0.1.0", "0.0.9"])("fails when %s is not newer than 0.1.0", (version) => {
    expect(
      caught(() => {
        prepare(setup(repo(), [version]).context, "2026-09-28");
      }).details.code,
    ).toBe("ERR_RELEASE_VERSION_NOT_NEWER");
  });

  it.each<[string, string | undefined]>([
    ["missing", undefined],
    ["without an Unreleased heading", "# Changelog\n\n## [0.0.1] - 2026-01-01\n"],
  ])("fails when CHANGELOG.md is %s", (_label, changelog) => {
    expect(
      caught(() => {
        prepare(setup(repo({ changelog }), ["0.2.0"]).context, "2026-09-28");
      }).details.code,
    ).toBe("ERR_RELEASE_CHANGELOG_MISSING");
  });

  it.each([
    ["followed by a release", "# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [0.0.1]\n"],
    ["at the end of the file", "# Changelog\n\n## [Unreleased]\n\n"],
  ])("fails when the Unreleased section is empty, %s", (_label, changelog) => {
    expect(
      caught(() => {
        prepare(setup(repo({ changelog }), ["0.2.0"]).context, "2026-09-28");
      }).details.code,
    ).toBe("ERR_RELEASE_CHANGELOG_EMPTY");
  });

  it("fails when cargo cannot refresh the lockfile", () => {
    const { context } = setup(repo(), ["0.2.0"], {
      status: 101,
      stdout: "",
      stderr: "error: no matching package\n",
    });
    const error = caught(() => {
      prepare(context, "2026-09-28");
    });
    expect(error.details.code).toBe("ERR_RELEASE_LOCKFILE");
    expect(error.details.actual).toContain("no matching package");
  });

  it("reports a cargo that never started", () => {
    const { context } = setup(repo(), ["0.2.0"], { status: null, stdout: "", stderr: "" });
    expect(
      caught(() => {
        prepare(context, "2026-09-28");
      }).details.actual,
    ).toContain("exit null");
  });
});
