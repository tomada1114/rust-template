/**
 * workflow-hygiene and just-check-matches-ci against the fixture trees under
 * `fixtures/workflows/`. `pass.yml` is a manifest of files (a justfile, ci.yml, and a
 * composite action) that both checks pass; each `fail/<mode>.yml` names one way a
 * workflow or the justfile stops failing closed, as `edits` (a `from` that must occur in
 * the pass file, replaced by `to`) and whole `files`, with the codes each check must
 * report. The test writes the tree to a temp root and runs each check's `main` with
 * `--root`, so a fixture that trips no tool in the checkout (no committed workflow,
 * action.yml, or justfile) still proves the check against real files.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { compare, type Exceptions } from "./just-check-matches-ci.ts";
import { main as hygieneMain } from "./workflow-hygiene.ts";
import { isRecord } from "./shared/workflows.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "workflows");
const NO_EXCEPTIONS: Exceptions = {
  localOnly: {},
  ciOnlyRecipes: {},
  ciOnlyCommands: {},
  ciOnlyJobs: {},
};

interface Fixture {
  readonly name: string;
  readonly files: Record<string, string>;
  readonly expect: { readonly hygiene: string[]; readonly justCi: string[] };
}

function stringMap(value: unknown, where: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${where} is not a mapping`);
  return Object.fromEntries(
    Object.entries(value).map(([key, text]) => {
      if (typeof text !== "string") throw new Error(`${where}.${key} is not a string`);
      return [key, text];
    }),
  );
}

function codeList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((code) => typeof code === "string")) {
    throw new Error(`${where} is not a list of codes`);
  }
  return value;
}

function readManifest(path: string): Record<string, unknown> {
  const data: unknown = parse(readFileSync(path, "utf8"));
  if (!isRecord(data)) throw new Error(`${path} is not a mapping`);
  return data;
}

const PASS_FILES = stringMap(readManifest(join(FIXTURES, "pass.yml"))["files"], "pass.files");

function loadFailure(name: string): Fixture {
  const data = readManifest(join(FIXTURES, "fail", name));
  const files = { ...PASS_FILES };
  const edits: unknown = data["edits"] ?? [];
  if (!Array.isArray(edits)) throw new Error(`${name}: edits is not a list`);
  for (const edit of edits) {
    if (!isRecord(edit)) throw new Error(`${name}: an edit is not a mapping`);
    const { file, from, to } = edit;
    if (typeof file !== "string" || typeof from !== "string" || typeof to !== "string") {
      throw new Error(`${name}: an edit needs string file, from, and to`);
    }
    const before = files[file];
    if (before?.includes(from) !== true) {
      throw new Error(`${name}: ${file} has no ${JSON.stringify(from)}`);
    }
    files[file] = before.replace(from, to);
  }
  Object.assign(files, stringMap(data["files"], `${name}.files`));
  const expected = data["expect"];
  if (!isRecord(expected)) throw new Error(`${name}: no expect mapping`);
  return {
    name,
    files,
    expect: {
      hygiene: codeList(expected["workflow-hygiene"], `${name}.expect.workflow-hygiene`),
      justCi: codeList(expected["just-check-matches-ci"], `${name}.expect.just-check-matches-ci`),
    },
  };
}

const FAILURES = readdirSync(join(FIXTURES, "fail"))
  .filter((name) => name.endsWith(".yml"))
  .sort()
  .map(loadFailure);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-fixture-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** workflow-hygiene's codes over `root`, run through `main` with `--root` from elsewhere. */
function hygieneCodes(root: string): string[] {
  const lines: string[] = [];
  const context: ScriptContext = {
    argv: ["--root", root],
    env: {},
    root: tmpdir(),
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    log: (line) => lines.push(line),
  };
  try {
    hygieneMain(context);
  } catch (error: unknown) {
    const first = error instanceof Error ? /^(ERR_[A-Z_]+)/.exec(error.message)?.[1] : undefined;
    const rest = lines.flatMap((line) => /^(ERR_[A-Z_]+):/.exec(line)?.[1] ?? []);
    return [...(first === undefined ? [] : [first]), ...rest];
  }
  expect(lines).toEqual(["check workflow-hygiene: ok"]);
  return [];
}

describe("workflow fixtures", () => {
  it("passes the pass tree in both checks", () => {
    const root = write(PASS_FILES);
    expect(hygieneCodes(root)).toEqual([]);
    expect(compare(root, NO_EXCEPTIONS)).toEqual([]);
  });

  it("has a fixture for every failure mode", () => {
    expect(FAILURES.length).toBeGreaterThanOrEqual(20);
  });

  describe.each(FAILURES)("fail/$name", (fixture) => {
    it("is reported by workflow-hygiene with the listed codes", () => {
      expect(hygieneCodes(write(fixture.files)).sort()).toEqual([...fixture.expect.hygiene].sort());
    });

    it("is reported by just-check-matches-ci with the listed codes", () => {
      const found = compare(write(fixture.files), NO_EXCEPTIONS).map((v) => v.code);
      expect(found).toEqual(fixture.expect.justCi);
    });
  });
});
