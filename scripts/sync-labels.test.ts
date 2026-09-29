import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptError } from "./lib/fail.ts";
import type { LabelDeclaration } from "./lib/labels.ts";
import type { RunResult, ScriptContext } from "./lib/script.ts";
import { diffLabels, main } from "./sync-labels.ts";

const bug: LabelDeclaration = { name: "bug", color: "d73a4a", description: "Broken." };
const ci: LabelDeclaration = { name: "ci", color: "006b75", description: "CI only." };

describe("diffLabels", () => {
  it("creates a missing label, updates a changed one, and leaves the rest alone", () => {
    const remote = [
      { name: "bug", color: "D73A4A", description: "Old words." },
      { name: "wontfix", color: "ffffff", description: "" },
    ];
    expect(diffLabels([bug, ci], remote)).toEqual([
      { kind: "update", label: bug },
      { kind: "create", label: ci },
    ]);
  });

  it("does nothing when the repository already matches, whatever the color's case", () => {
    expect(diffLabels([bug], [{ ...bug, color: "D73A4A" }])).toEqual([]);
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoWithManifest(text: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "sync-labels-"));
  roots.push(root);
  if (text !== undefined) {
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github", "labels.yml"), text);
  }
  return root;
}

const MANIFEST = [
  "- name: bug",
  "  color: d73a4a",
  "  description: Broken.",
  "- name: ci",
  "  color: 006b75",
  "  description: CI only.",
].join("\n");

type Responder = (args: readonly string[]) => Partial<RunResult> | undefined;

function harness(root: string, respond: Responder) {
  const calls: (readonly string[])[] = [];
  const lines: string[] = [];
  const context: ScriptContext = {
    argv: [],
    env: {},
    root,
    run: (command, args) => {
      expect(command).toBe("gh");
      calls.push(args);
      return { status: 0, stdout: "", stderr: "", ...respond(args) };
    },
    log: (line) => lines.push(line),
  };
  return { context, calls, lines };
}

const liveRepo: Responder = (args) => {
  if (args[0] === "repo") return { stdout: "owner/repo\n" };
  if (args[0] === "label" && args[1] === "list") {
    return { stdout: JSON.stringify([{ name: "bug", color: "d73a4a", description: "Old." }]) };
  }
  return undefined;
};

function caught(action: () => void): ScriptError {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

describe("main", () => {
  it("updates and creates labels on the repository gh points at", () => {
    const { context, calls, lines } = harness(repoWithManifest(MANIFEST), liveRepo);
    main(context);
    expect(calls).toEqual([
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      [
        "label",
        "list",
        "--repo",
        "owner/repo",
        "--limit",
        "200",
        "--json",
        "name,color,description",
      ],
      [
        "label",
        "edit",
        "bug",
        "--repo",
        "owner/repo",
        "--color",
        "d73a4a",
        "--description",
        "Broken.",
      ],
      [
        "label",
        "create",
        "ci",
        "--repo",
        "owner/repo",
        "--color",
        "006b75",
        "--description",
        "CI only.",
      ],
    ]);
    expect(lines).toEqual([
      "labels: updated bug",
      "labels: created ci",
      "labels: owner/repo matches .github/labels.yml (1 created, 1 updated)",
    ]);
  });

  it("changes nothing when the repository already matches", () => {
    const { context, calls, lines } = harness(repoWithManifest(MANIFEST), (args) =>
      args[0] === "label"
        ? {
            stdout: JSON.stringify([
              { name: "bug", color: "d73a4a", description: "Broken." },
              { name: "ci", color: "006b75", description: "CI only." },
            ]),
          }
        : liveRepo(args),
    );
    main(context);
    expect(calls).toHaveLength(2);
    expect(lines).toEqual(["labels: owner/repo matches .github/labels.yml (0 created, 0 updated)"]);
  });

  it("fails with ERR_LABELS_MANIFEST when .github/labels.yml is missing", () => {
    const { context } = harness(repoWithManifest(undefined), liveRepo);
    expect(
      caught(() => {
        main(context);
      }).details.code,
    ).toBe("ERR_LABELS_MANIFEST");
  });

  it("fails with ERR_LABELS_GH when gh cannot start", () => {
    const { context } = harness(repoWithManifest(MANIFEST), () => ({
      status: null,
      stderr: "spawn gh ENOENT",
    }));
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_LABELS_GH");
    expect(error.details.actual).toContain("ENOENT");
  });

  it("fails with ERR_LABELS_GH when a gh call fails, naming the call", () => {
    const { context } = harness(repoWithManifest(MANIFEST), (args) =>
      args[1] === "create" ? { status: 1, stderr: "HTTP 403" } : liveRepo(args),
    );
    const error = caught(() => {
      main(context);
    });
    expect(error.details.code).toBe("ERR_LABELS_GH");
    expect(error.details.summary).toContain("gh label create ci");
    expect(error.details.actual).toContain("HTTP 403");
  });

  it("fails with ERR_LABELS_GH when gh lists something that is not a label list", () => {
    const { context } = harness(repoWithManifest(MANIFEST), (args) =>
      args[0] === "label" ? { stdout: '{"not":"a list"}' } : liveRepo(args),
    );
    expect(
      caught(() => {
        main(context);
      }).details.code,
    ).toBe("ERR_LABELS_GH");
  });
});
