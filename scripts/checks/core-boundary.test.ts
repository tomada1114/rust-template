/**
 * core-boundary against a fixture tree: `fixtures/core-boundary/pass` holds a minimal
 * `cargo metadata` document (`metadata.json`) and deny.toml's wrapper entries, and each
 * test root adds AGENTS.md's boundary sentence (below; written at run time so no agent
 * ever loads a fixture AGENTS.md as instructions). All three agree. Each failing case copies it to a temp
 * root and breaks one thing. The metadata comes from the file instead of cargo, through
 * `makeCheck`'s loader; `loadCargoMetadata` is tested with a stubbed `run`.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FailureDetails } from "../lib/fail.ts";
import type { Run, RunResult } from "../lib/script.ts";
import {
  check,
  FORBIDDEN_IN_CORE,
  loadCargoMetadata,
  makeCheck,
  parseCargoMetadata,
} from "./core-boundary.ts";

const PASS = join(import.meta.dirname, "fixtures", "core-boundary", "pass");
const REG = "registry+https://github.com/rust-lang/crates.io-index";
const AGENTS_MD = [
  "## Architecture",
  "",
  "- The core boundary is enforced three times, so removing one layer leaves the others:",
  "  core's `Cargo.toml` lists no tauri, OS, or platform crate; `deny.toml`'s `[bans]`",
  "  `wrappers` let only `myapp` depend on `tauri`; and a harness check fails when core's",
  "  normal dependency closure reaches `tauri*`, `wry`, `tao`, `objc2*`, `core-foundation*`,",
  "  `security-framework*`, or `myapp-platform`. Those lists change together.",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyPass(): string {
  const dir = mkdtempSync(join(tmpdir(), "core-boundary-"));
  dirs.push(dir);
  cpSync(PASS, dir, { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), AGENTS_MD);
  return dir;
}

const fixtureCheck = makeCheck((root) =>
  parseCargoMetadata(readFileSync(join(root, "metadata.json"), "utf8"), "metadata.json"),
);

const codes = (violations: readonly FailureDetails[]): string[] => violations.map((v) => v.code);
const text = (violations: readonly FailureDetails[]): string =>
  violations.map((v) => [v.summary, v.expected, v.actual, v.next].join("\n")).join("\n\n");

interface Dep {
  name: string;
  kind: string | null;
  optional?: boolean;
}
interface Pkg {
  name: string;
  id: string;
  dependencies: Dep[];
}
interface Metadata {
  packages: Pkg[];
  workspace_members: string[];
  resolve: {
    nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[];
  } | null;
}

function editMetadata(root: string, edit: (metadata: Metadata) => void): void {
  const path = join(root, "metadata.json");
  const metadata = JSON.parse(readFileSync(path, "utf8")) as Metadata;
  edit(metadata);
  writeFileSync(path, JSON.stringify(metadata));
}

function idOf(metadata: Metadata, name: string): string {
  const found = metadata.packages.find((p) => p.name === name);
  if (found === undefined) throw new Error(`no package ${name}`);
  return found.id;
}

/** Add a registry package (when new) and an edge `from -> to` of `kind`. */
function addEdge(
  metadata: Metadata,
  from: string,
  to: string,
  kind: string | null,
  optional = false,
): void {
  if (!metadata.packages.some((p) => p.name === to)) {
    const id = `${REG}#${to}@1.0.0`;
    metadata.packages.push({ name: to, id, dependencies: [] });
    metadata.resolve?.nodes.push({ id, deps: [] });
  }
  const fromId = idOf(metadata, from);
  const toId = idOf(metadata, to);
  metadata.packages.find((p) => p.id === fromId)?.dependencies.push({ name: to, kind, optional });
  if (optional) return;
  metadata.resolve?.nodes
    .find((n) => n.id === fromId)
    ?.deps.push({ pkg: toId, dep_kinds: [{ kind }] });
}

function editFile(root: string, path: string, from: string, to: string): void {
  const full = join(root, path);
  const before = readFileSync(full, "utf8");
  if (!before.includes(from)) throw new Error(`${path} has no ${from}`);
  writeFileSync(full, before.replace(from, to));
}

describe("core-boundary", () => {
  it("passes on the fixture where every list agrees", () => {
    expect(fixtureCheck.run(copyPass())).toEqual([]);
  });

  it("is named after its file", () => {
    expect(check.name).toBe("core-boundary");
  });

  it("forbids the crates design D3 names", () => {
    expect([...FORBIDDEN_IN_CORE].sort()).toEqual(
      [
        "core-foundation*",
        "myapp-platform",
        "objc2*",
        "security-framework*",
        "tao",
        "tauri*",
        "wry",
      ].sort(),
    );
  });

  describe("core's normal and build dependency closure", () => {
    it.each([
      ["tauri-utils"],
      ["tauri"],
      ["wry"],
      ["tao"],
      ["objc2-foundation"],
      ["core-foundation-sys"],
      ["security-framework"],
      ["myapp-platform"],
    ])("fails when it reaches %s", (crate) => {
      const root = copyPass();
      editMetadata(root, (m) => {
        addEdge(m, "myapp-core", "bridge", null);
        addEdge(m, "bridge", crate, null);
      });
      const violations = fixtureCheck.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_CORE_BOUNDARY_CLOSURE"]);
      expect(text(violations)).toContain(`myapp-core -> bridge -> ${crate}`);
    });

    it("reports each forbidden crate core reaches first, and nothing behind it", () => {
      const root = copyPass();
      editMetadata(root, (m) => {
        addEdge(m, "myapp-core", "tauri", null);
        addEdge(m, "myapp-core", "wry", null);
      });
      const violations = fixtureCheck.run(root);
      // The walk stops at a forbidden crate, so wry/tao/objc2 behind tauri add nothing.
      expect(codes(violations)).toEqual(Array(2).fill("ERR_CHECK_CORE_BOUNDARY_CLOSURE"));
      expect(text(violations)).toContain("myapp-core -> wry");
    });

    it("ignores a dev-dependency of core", () => {
      const root = copyPass();
      editMetadata(root, (m) => {
        addEdge(m, "myapp-core", "tauri", "dev");
      });
      expect(fixtureCheck.run(root)).toEqual([]);
    });

    it.each([["tauri"], ["tauri-build"], ["objc2"]])(
      "fails on a build-dependency edge from core to %s",
      (crate) => {
        const root = copyPass();
        editMetadata(root, (m) => {
          addEdge(m, "myapp-core", crate, "build");
        });
        const violations = fixtureCheck.run(root);
        expect(codes(violations)).toEqual(["ERR_CHECK_CORE_BOUNDARY_CLOSURE"]);
        expect(text(violations)).toContain(`myapp-core -(build)-> ${crate}`);
      },
    );

    it("follows a build edge further down the closure", () => {
      const root = copyPass();
      editMetadata(root, (m) => {
        addEdge(m, "serde", "helper", "build");
        addEdge(m, "helper", "core-foundation-sys", null);
      });
      const violations = fixtureCheck.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_CORE_BOUNDARY_CLOSURE"]);
      expect(text(violations)).toContain(
        "myapp-core -> serde -(build)-> helper -> core-foundation-sys",
      );
    });

    it("follows no dev edge past core's direct dependencies", () => {
      const root = copyPass();
      editMetadata(root, (m) => {
        addEdge(m, "serde", "tauri", "dev");
      });
      expect(fixtureCheck.run(root)).toEqual([]);
    });

    it("fails when the workspace has no myapp-core", () => {
      const root = copyPass();
      editMetadata(root, (m) => {
        m.workspace_members = m.workspace_members.filter((id) => !id.includes("myapp-core"));
      });
      expect(codes(fixtureCheck.run(root))).toContain("ERR_CHECK_CORE_BOUNDARY_METADATA");
    });

    it("fails when the metadata has no resolved graph (--no-deps)", () => {
      const root = copyPass();
      editMetadata(root, (m) => {
        m.resolve = null;
      });
      expect(codes(fixtureCheck.run(root))).toContain("ERR_CHECK_CORE_BOUNDARY_METADATA");
    });
  });

  describe("myapp-test-support stays a dev-dependency", () => {
    it.each([
      ["a normal dependency", null, false],
      ["an optional normal dependency", null, true],
      ["a build-dependency", "build", false],
    ])("fails when a workspace crate takes it as %s", (_label, kind, optional) => {
      const root = copyPass();
      editMetadata(root, (m) => {
        addEdge(m, "myapp-platform", "myapp-test-support", kind, optional);
      });
      const violations = fixtureCheck.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_TEST_SUPPORT_NOT_DEV"]);
      expect(text(violations)).toContain("myapp-platform");
    });
  });

  describe("AGENTS.md's list", () => {
    it("fails when AGENTS.md names a crate the check does not forbid", () => {
      const root = copyPass();
      editFile(root, "AGENTS.md", "`tao`, ", "`tao`, `libc`, ");
      const violations = fixtureCheck.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_CORE_BOUNDARY_DIVERGED"]);
      expect(text(violations)).toContain("`libc`");
    });

    it("fails when AGENTS.md leaves out a crate the check forbids", () => {
      const root = copyPass();
      editFile(root, "AGENTS.md", "`wry`, ", "");
      const violations = fixtureCheck.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_CORE_BOUNDARY_DIVERGED"]);
      expect(text(violations)).toContain("`wry`");
    });

    it("fails when the list sentence cannot be found", () => {
      const root = copyPass();
      editFile(root, "AGENTS.md", "dependency closure", "dependency set");
      expect(codes(fixtureCheck.run(root))).toEqual(["ERR_CHECK_CORE_BOUNDARY_UNPARSED"]);
    });

    it("fails when AGENTS.md is missing", () => {
      const root = copyPass();
      rmSync(join(root, "AGENTS.md"));
      expect(codes(fixtureCheck.run(root))).toEqual(["ERR_CHECK_INPUT_MISSING"]);
    });
  });

  describe("deny.toml's wrapper entries", () => {
    it("fails when tauri may be a direct dependency of another crate", () => {
      const root = copyPass();
      editFile(
        root,
        "deny.toml",
        '{ crate = "tauri", wrappers = ["myapp"] }',
        '{ crate = "tauri", wrappers = ["myapp", "myapp-core"] }',
      );
      const violations = fixtureCheck.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]);
      expect(text(violations)).toContain("myapp-core");
    });

    it("fails when myapp-platform's entry loses myapp-cli", () => {
      const root = copyPass();
      editFile(root, "deny.toml", '["myapp-cli", "myapp"]', '["myapp"]');
      expect(codes(fixtureCheck.run(root))).toEqual(["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]);
    });

    it("fails when the tauri entry is missing or has no wrappers", () => {
      const root = copyPass();
      editFile(root, "deny.toml", '{ crate = "tauri", wrappers = ["myapp"] },', '"tauri",');
      expect(codes(fixtureCheck.run(root))).toEqual(["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]);
      editFile(root, "deny.toml", '"tauri",', "");
      expect(codes(fixtureCheck.run(root))).toEqual(["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]);
    });

    it("fails when a tauri-plugin crate the workspace uses has no entry", () => {
      const root = copyPass();
      editFile(root, "deny.toml", '{ crate = "tauri-plugin-log@2", wrappers = ["myapp"] },', "");
      const violations = fixtureCheck.run(root);
      expect(codes(violations)).toEqual(["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]);
      expect(text(violations)).toContain("tauri-plugin-log");
    });

    it("fails when a tauri-plugin entry lets another crate depend on it", () => {
      const root = copyPass();
      editFile(
        root,
        "deny.toml",
        'crate = "tauri-plugin-log@2", wrappers = ["myapp"]',
        'name = "tauri-plugin-log", wrappers = ["myapp-cli"]',
      );
      expect(codes(fixtureCheck.run(root))).toEqual(["ERR_CHECK_CORE_BOUNDARY_WRAPPERS"]);
    });

    it("fails when deny.toml is not TOML or has no [bans] deny list", () => {
      const root = copyPass();
      writeFileSync(join(root, "deny.toml"), "bans = = 1\n");
      expect(codes(fixtureCheck.run(root))).toEqual(["ERR_CHECK_CORE_BOUNDARY_UNPARSED"]);
      writeFileSync(join(root, "deny.toml"), "[bans]\nwildcards = 'deny'\n");
      expect(codes(fixtureCheck.run(root))).toEqual(["ERR_CHECK_CORE_BOUNDARY_UNPARSED"]);
    });

    it("fails when deny.toml is missing", () => {
      const root = copyPass();
      rmSync(join(root, "deny.toml"));
      expect(codes(fixtureCheck.run(root))).toEqual(["ERR_CHECK_INPUT_MISSING"]);
    });
  });
});

describe("parseCargoMetadata", () => {
  it("rejects text that is not JSON", () => {
    const result = parseCargoMetadata("{", "cargo metadata");
    expect("violation" in result && result.violation.code).toBe("ERR_CHECK_CORE_BOUNDARY_METADATA");
  });

  it.each([
    ["an array", "[]"],
    ["no packages", '{"workspace_members":[],"resolve":{"nodes":[]}}'],
    [
      "a package without a name",
      '{"packages":[{"id":"x","dependencies":[]}],"workspace_members":[],"resolve":null}',
    ],
    [
      "a malformed dependency",
      '{"packages":[{"id":"x","name":"x","dependencies":[1]}],"workspace_members":[],"resolve":null}',
    ],
    [
      "a malformed node",
      '{"packages":[],"workspace_members":[],"resolve":{"nodes":[{"id":"x","deps":[{"pkg":"y"}]}]}}',
    ],
  ])("rejects JSON of the wrong shape: %s", (_label, json) => {
    const result = parseCargoMetadata(json, "cargo metadata");
    expect("violation" in result && result.violation.code).toBe("ERR_CHECK_CORE_BOUNDARY_METADATA");
  });
});

describe("loadCargoMetadata", () => {
  const answer =
    (result: RunResult, calls: unknown[][]): Run =>
    (command, args, options) => {
      calls.push([command, args, options?.cwd]);
      return result;
    };

  it("runs cargo metadata locked and offline in the root", () => {
    const calls: unknown[][] = [];
    const json = readFileSync(join(PASS, "metadata.json"), "utf8");
    const result = loadCargoMetadata(
      "/repo",
      answer({ status: 0, stdout: json, stderr: "" }, calls),
    );
    expect("metadata" in result).toBe(true);
    expect(calls).toEqual([
      ["cargo", ["metadata", "--format-version", "1", "--locked", "--offline"], "/repo"],
    ]);
  });

  it("reports a failed cargo run as a violation, never a skip", () => {
    const result = loadCargoMetadata(
      "/repo",
      answer({ status: 101, stdout: "", stderr: "error: failed to download\nmore" }, []),
    );
    expect("violation" in result && result.violation.code).toBe("ERR_CHECK_CORE_BOUNDARY_METADATA");
    expect("violation" in result && result.violation.actual).toContain("failed to download");
  });

  it("reports cargo missing from PATH", () => {
    const result = loadCargoMetadata(
      "/repo",
      answer({ status: null, stdout: "", stderr: "spawnSync cargo ENOENT" }, []),
    );
    expect("violation" in result && result.violation.actual).toContain("ENOENT");
  });

  it("feeds a failed load through the check as its only violation", () => {
    const failing = makeCheck(() =>
      loadCargoMetadata("/repo", answer({ status: 1, stdout: "", stderr: "" }, [])),
    );
    const violations = failing.run(copyPass());
    expect(codes(violations)).toEqual(["ERR_CHECK_CORE_BOUNDARY_METADATA"]);
  });
});
