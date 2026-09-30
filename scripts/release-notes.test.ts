import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError } from "./lib/fail.ts";
import type { ScriptContext } from "./lib/script.ts";
import { main, renderNotes } from "./release-notes.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Something not yet released.

## [0.2.0] - 2026-09-28

### Added

- A tide chart.

### Fixed

- The chart no longer flickers.

## [0.1.0] - 2026-01-02

### Added

- The first screen.
`;

const SECTION_0_2_0 = `### Added

- A tide chart.

### Fixed

- The chart no longer flickers.
`;

const OPENING = `## Opening this build

This build is ad-hoc signed and not notarized, so macOS refuses to open it the first time. Either:

- try to open Tide Pool once, then go to **System Settings › Privacy & Security**, find the message about Tide Pool under **Security**, click **Open Anyway**, and confirm with your login password. The button is offered for about an hour after the blocked attempt; or
- after copying Tide Pool to Applications, remove the quarantine attribute in Terminal:

  \`\`\`bash
  xattr -dr com.apple.quarantine "/Applications/Tide Pool.app"
  \`\`\`
`;

const PLACEHOLDER_0_3_0 =
  "_CHANGELOG.md has no entries for 0.3.0 yet. This placeholder appears only in a dry run; a tagged release fails until `just release-prep 0.3.0` has rolled them._\n";

const TAURI = `{ "productName": "Tide Pool", "version": "0.2.0" }\n`;

interface Files {
  changelog?: string | undefined;
  tauri?: string | undefined;
}

/** A root holding a changelog and a tauri.conf.json; `undefined` leaves a file out. */
function root(files: Files = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  dirs.push(dir);
  const changelog = "changelog" in files ? files.changelog : CHANGELOG;
  const tauri = "tauri" in files ? files.tauri : TAURI;
  if (changelog !== undefined) writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  if (tauri !== undefined) {
    mkdirSync(join(dir, "src-tauri"));
    writeFileSync(join(dir, "src-tauri", "tauri.conf.json"), tauri);
  }
  return dir;
}

function run(dir: string, argv: string[]): string[] {
  const lines: string[] = [];
  const context: ScriptContext = {
    argv,
    env: {},
    root: dir,
    run: () => {
      throw new Error("release-notes spawns nothing");
    },
    log: (line) => lines.push(line),
  };
  main(context);
  return lines;
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

const notes = (dir: string, path = "notes.md"): string => readFileSync(join(dir, path), "utf8");

describe("release-notes", () => {
  it("writes exactly the version's section", () => {
    const dir = root();
    const lines = run(dir, ["--out", "notes.md", "0.2.0"]);
    expect(notes(dir)).toBe(SECTION_0_2_0);
    expect(lines).toEqual(["release-notes: wrote notes.md from CHANGELOG.md's [0.2.0] section"]);
  });

  it("appends how to open an ad-hoc build, naming the product", () => {
    const dir = root();
    const lines = run(dir, ["0.2.0", "--ad-hoc", "--out", "notes.md"]);
    expect(notes(dir)).toBe(`${SECTION_0_2_0}\n${OPENING}`);
    expect(lines.join("\n")).toContain(", plus the ad-hoc opening steps");
  });

  it("reads the last section to the end of the file", () => {
    const dir = root();
    run(dir, ["--out", "notes.md", "0.1.0"]);
    expect(notes(dir)).toBe("### Added\n\n- The first screen.\n");
  });

  it("matches an undated heading and never a longer version", () => {
    const changelog =
      "## [10.2.0]\n\n- Wrong.\n\n## [0.2.01]\n\n- Wrong too.\n\n## [0.2.0]\n\n- Right.\n";
    expect(
      renderNotes({ changelog, version: "0.2.0", productName: undefined, allowMissing: false }),
    ).toEqual({ text: "- Right.\n", placeholder: false });
  });

  it("fails, writing nothing, when the version has no section", () => {
    const dir = root();
    const error = caught(() => run(dir, ["--out", "notes.md", "0.3.0"]));
    expect(error.details.code).toBe("ERR_RELEASE_NOTES_SECTION_MISSING");
    expect(error.details.next).toContain("just release-prep 0.3.0");
    expect(existsSync(join(dir, "notes.md"))).toBe(false);
  });

  it("fails, writing nothing, when the section holds only headings", () => {
    const dir = root({
      changelog: "## [0.3.0] - 2026-10-01\n\n### Added\n\n### Fixed\n\n## [0.2.0]\n\n- Old.\n",
    });
    const error = caught(() => run(dir, ["--out", "notes.md", "0.3.0"]));
    expect(error.details.code).toBe("ERR_RELEASE_NOTES_SECTION_EMPTY");
    expect(existsSync(join(dir, "notes.md"))).toBe(false);
  });

  it("writes a placeholder for a missing section with --allow-missing", () => {
    const dir = root();
    const lines = run(dir, ["--allow-missing", "--out", "notes.md", "0.3.0"]);
    expect(notes(dir)).toBe(PLACEHOLDER_0_3_0);
    expect(lines).toEqual([
      "release-notes: WARNING: CHANGELOG.md has no entries for 0.3.0; wrote a placeholder (--allow-missing)",
      "release-notes: wrote notes.md as a placeholder",
    ]);
  });

  it("follows the placeholder with the ad-hoc steps", () => {
    const dir = root();
    run(dir, ["--allow-missing", "--ad-hoc", "--out", "notes.md", "0.3.0"]);
    expect(notes(dir)).toBe(`${PLACEHOLDER_0_3_0}\n${OPENING}`);
  });

  it("writes a placeholder for an empty section with --allow-missing", () => {
    expect(
      renderNotes({
        changelog: "## [0.3.0]\n\n### Added\n\n",
        version: "0.3.0",
        productName: undefined,
        allowMissing: true,
      }),
    ).toEqual({ text: PLACEHOLDER_0_3_0, placeholder: true });
  });

  it.each([[[] as string[]], [["--allow-missing"]]])(
    "fails when CHANGELOG.md is missing (extra flags %j)",
    (flags) => {
      const dir = root({ changelog: undefined });
      const error = caught(() => run(dir, [...flags, "--out", "notes.md", "0.2.0"]));
      expect(error.details.code).toBe("ERR_RELEASE_NOTES_CHANGELOG_MISSING");
      expect(existsSync(join(dir, "notes.md"))).toBe(false);
    },
  );

  it.each<[string, string | undefined]>([
    ["tauri.conf.json is missing", undefined],
    ["tauri.conf.json is not JSON", "{ not json"],
    ["productName is absent", '{ "version": "0.2.0" }'],
    ["productName is empty", '{ "productName": "" }'],
    ["productName is a number", '{ "productName": 42 }'],
    ["the file is not an object", "[]"],
  ])("fails with --ad-hoc when %s", (_label, tauri) => {
    const dir = root({ tauri });
    const error = caught(() => run(dir, ["--ad-hoc", "--out", "notes.md", "0.2.0"]));
    expect(error.details.code).toBe("ERR_RELEASE_NOTES_PRODUCT_NAME");
    expect(existsSync(join(dir, "notes.md"))).toBe(false);
  });

  it("needs no tauri.conf.json without --ad-hoc", () => {
    const dir = root({ tauri: undefined });
    run(dir, ["--out", "notes.md", "0.2.0"]);
    expect(notes(dir)).toBe(SECTION_0_2_0);
  });

  it("reports a missing section before a bad productName", () => {
    const dir = root({ tauri: undefined });
    expect(caught(() => run(dir, ["--ad-hoc", "--out", "notes.md", "0.3.0"])).details.code).toBe(
      "ERR_RELEASE_NOTES_SECTION_MISSING",
    );
  });

  it.each<[string, string[]]>([
    ["no version", ["--out", "notes.md"]],
    ["two versions", ["--out", "notes.md", "0.2.0", "0.3.0"]],
    ["an unknown flag", ["--force", "--out", "notes.md", "0.2.0"]],
    ["--out=<file>", ["--out=notes.md", "0.2.0"]],
    ["--out last with no value", ["0.2.0", "--out"]],
    ["--out twice", ["--out", "a.md", "--out", "b.md", "0.2.0"]],
    ["--out followed by a flag", ["--out", "--ad-hoc", "0.2.0"]],
    ["no --out", ["0.2.0"]],
    ["a v-prefixed version", ["--out", "notes.md", "v0.2.0"]],
    ["a two-part version", ["--out", "notes.md", "0.2"]],
    ["a pre-release version", ["--out", "notes.md", "0.2.0-rc.1"]],
  ])("fails with usage for %s", (_label, argv) => {
    const dir = root();
    const error = caught(() => run(dir, argv));
    expect(error.details.code).toBe("ERR_RELEASE_NOTES_USAGE");
    expect(error.details.next).toContain("--out <file>");
  });

  it("creates --out's directories and overwrites an existing file", () => {
    const dir = root();
    run(dir, ["--out", "nested/dir/release-notes.md", "0.2.0"]);
    expect(notes(dir, "nested/dir/release-notes.md")).toBe(SECTION_0_2_0);
    run(dir, ["--out", "nested/dir/release-notes.md", "0.1.0"]);
    expect(notes(dir, "nested/dir/release-notes.md")).toBe("### Added\n\n- The first screen.\n");
  });

  it("keeps an absolute --out as given", () => {
    const dir = root();
    const out = join(dir, "abs", "notes.md");
    run(dir, ["--out", out, "0.2.0"]);
    expect(readFileSync(out, "utf8")).toBe(SECTION_0_2_0);
  });
});
