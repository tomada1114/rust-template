/**
 * formatter-glob against a temp root holding a lefthook.yml whose prettier job's glob
 * names exactly the extensions the hook's PRETTIER_EXTENSIONS lists, and the hook's Rust
 * source. Each failing case changes one input; the files are written at run time, so
 * lefthook never reads one as a config.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FailureDetails } from "../lib/fail.ts";
import type { ScriptContext } from "../lib/script.ts";
import { check, hookExtensions, main } from "./formatter-glob.ts";

const GLOB = '"*.{ts,tsx,mts,cts,js,mjs,cjs,json,css,html,yml,yaml}"';

const lefthook = (glob: string): string => `pre-commit:
  jobs:
    - name: rustfmt
      glob: "*.rs"
      run: rustfmt --check {staged_files}
    - name: prettier
      glob: ${glob}
      run: pnpm exec prettier --check {staged_files}
`;

const HOOK = "xtask/src/format_edited_file.rs";
const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".html",
  ".yml",
  ".yaml",
];
const hook = (extensions: readonly string[] = EXTENSIONS): string =>
  `/// Formatted with Prettier.\npub(crate) const PRETTIER_EXTENSIONS: &[&str] = &[\n    ${extensions.map((e) => JSON.stringify(e)).join(", ")},\n];\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A root with `text` as lefthook.yml and `source` as the hook (`null`: absent). */
function root(text: string | undefined, source: string | null = hook()): string {
  const dir = mkdtempSync(join(tmpdir(), "formatter-glob-"));
  dirs.push(dir);
  if (text !== undefined) writeFileSync(join(dir, "lefthook.yml"), text);
  if (source !== null) {
    mkdirSync(join(dir, "xtask", "src"), { recursive: true });
    writeFileSync(join(dir, HOOK), source);
  }
  return dir;
}

const codes = (violations: readonly FailureDetails[]): string[] => violations.map((v) => v.code);

function context(dir: string, lines: string[]): ScriptContext {
  return {
    argv: ["--root", dir],
    env: {},
    root: dir,
    run: () => {
      throw new Error("formatter-glob spawns nothing");
    },
    log: (line) => lines.push(line),
  };
}

describe("formatter-glob", () => {
  it("passes when the prettier glob names exactly PRETTIER_EXTENSIONS", () => {
    expect(check.run(root(lefthook(GLOB)))).toEqual([]);
  });

  it("passes when the glob lists the same extensions in another order", () => {
    expect(
      check.run(root(lefthook('"*.{yaml,yml,html,css,json,cjs,mjs,js,cts,mts,tsx,ts}"'))),
    ).toEqual([]);
  });

  it("fails when the glob drops an extension the hook formats", () => {
    const violations = check.run(
      root(lefthook('"*.{ts,tsx,mts,cts,js,mjs,cjs,json,css,html,yml}"')),
    );
    expect(codes(violations)).toEqual(["ERR_CHECK_FORMATTER_GLOB_DIVERGED"]);
    expect(violations[0]?.actual).toBe(
      "only in lefthook.yml: none; only in PRETTIER_EXTENSIONS: .yaml",
    );
  });

  it("fails when the glob adds an extension the hook does not format", () => {
    const violations = check.run(
      root(lefthook('"*.{ts,tsx,mts,cts,js,mjs,cjs,json,css,html,yml,yaml,md}"')),
    );
    expect(codes(violations)).toEqual(["ERR_CHECK_FORMATTER_GLOB_DIVERGED"]);
    expect(violations[0]?.actual).toBe(
      "only in lefthook.yml: .md; only in PRETTIER_EXTENSIONS: none",
    );
  });

  it("fails when lefthook.yml is absent", () => {
    expect(codes(check.run(root(undefined)))).toEqual(["ERR_CHECK_INPUT_MISSING"]);
  });

  it("fails when the hook's source is absent", () => {
    const violations = check.run(root(lefthook(GLOB), null));
    expect(codes(violations)).toEqual(["ERR_CHECK_INPUT_MISSING"]);
    expect(violations[0]?.summary).toBe(`${HOOK} does not exist`);
  });

  it("fails when the hook declares no PRETTIER_EXTENSIONS list", () => {
    const violations = check.run(root(lefthook(GLOB), "const OTHER: &[&str] = &[];\n"));
    expect(codes(violations)).toEqual(["ERR_CHECK_FORMATTER_GLOB_UNPARSED"]);
    expect(violations[0]?.summary).toBe(`${HOOK} declares no PRETTIER_EXTENSIONS list`);
  });

  it("fails when the hook drops an extension the glob checks", () => {
    const violations = check.run(root(lefthook(GLOB), hook(EXTENSIONS.slice(1))));
    expect(codes(violations)).toEqual(["ERR_CHECK_FORMATTER_GLOB_DIVERGED"]);
    expect(violations[0]?.actual).toBe(
      "only in lefthook.yml: .ts; only in PRETTIER_EXTENSIONS: none",
    );
  });

  it("reads every string literal of a list rustfmt spread over several lines", () => {
    expect(hookExtensions(hook().replace(", ", ",\n    "))).toEqual(EXTENSIONS);
  });

  it("fails when lefthook.yml is not YAML", () => {
    const violations = check.run(root("pre-commit: [\n"));
    expect(codes(violations)).toEqual(["ERR_CHECK_FORMATTER_GLOB_UNPARSED"]);
    expect(violations[0]?.summary).toBe("lefthook.yml could not be parsed");
  });

  it.each([
    ["no pre-commit section", "pre-push:\n  jobs: []\n"],
    ["jobs that are not a list", "pre-commit:\n  jobs: prettier\n"],
    ["no prettier job", 'pre-commit:\n  jobs:\n    - name: eslint\n      glob: "*.ts"\n'],
  ])("fails with %s", (_, text) => {
    expect(codes(check.run(root(text)))).toEqual(["ERR_CHECK_FORMATTER_GLOB_MISSING"]);
  });

  it.each([
    ["has no glob", "pre-commit:\n  jobs:\n    - name: prettier\n      run: x\n"],
    ["has a glob list", "pre-commit:\n  jobs:\n    - name: prettier\n      glob: [a, b]\n"],
  ])("fails when the prettier job %s", (_, text) => {
    const violations = check.run(root(text));
    expect(codes(violations)).toEqual(["ERR_CHECK_FORMATTER_GLOB_UNPARSED"]);
    expect(violations[0]?.summary).toBe("lefthook.yml's prettier job has no string glob");
  });

  it("fails when the glob is not the *.{…} form", () => {
    const violations = check.run(root(lefthook('"**/*.ts"')));
    expect(codes(violations)).toEqual(["ERR_CHECK_FORMATTER_GLOB_UNPARSED"]);
    expect(violations[0]?.summary).toBe("lefthook.yml's prettier glob is not `*.{…}`");
  });

  describe("main", () => {
    it("logs ok for a passing root", () => {
      const lines: string[] = [];
      main(context(root(lefthook(GLOB)), lines));
      expect(lines).toEqual(["check formatter-glob: ok"]);
    });

    it("throws the violation for a failing root", () => {
      expect(() => {
        main(context(root(lefthook('"*.{ts}"')), []));
      }).toThrow("prettier glob name different extensions (1 of 1)");
    });
  });
});
