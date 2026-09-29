import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ScriptError } from "./fail.ts";
import { parseLabelManifest } from "./labels.ts";
import { REPO_ROOT } from "./script.ts";

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof ScriptError) return error.details.code;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

describe("parseLabelManifest", () => {
  it("reads name, color, and description of each label", () => {
    const text = [
      "- name: bug",
      "  color: d73a4a",
      '  description: "Broken."',
      '- name: "priority: P0"',
      "  color: b60205",
      "  description: Now.",
    ].join("\n");
    expect(parseLabelManifest(text)).toEqual([
      { name: "bug", color: "d73a4a", description: "Broken." },
      { name: "priority: P0", color: "b60205", description: "Now." },
    ]);
  });

  it("accepts the committed manifest: 16 labels, names unique", () => {
    const labels = parseLabelManifest(readFileSync(join(REPO_ROOT, ".github/labels.yml"), "utf8"));
    expect(labels).toHaveLength(16);
    expect(labels.map((label) => label.name)).toEqual(
      expect.arrayContaining(["blocked: external", "tracking", "dependencies", "ci"]),
    );
  });

  it.each([
    ["not YAML", "- name: [unclosed"],
    ["not a list", "name: bug"],
    ["an entry that is not a mapping", "- bug"],
    ["a missing name", "- color: d73a4a\n  description: x"],
    ["an empty name", '- name: ""\n  color: d73a4a\n  description: x'],
    ["an upper-case color", "- name: bug\n  color: D73A4A\n  description: x"],
    ["a color with #", '- name: bug\n  color: "#d73a4a"\n  description: x'],
    ["a missing description", "- name: bug\n  color: d73a4a"],
    [
      "a description over 100 characters",
      `- name: bug\n  color: d73a4a\n  description: ${"x".repeat(101)}`,
    ],
    [
      "a duplicate name",
      "- name: bug\n  color: d73a4a\n  description: x\n- name: bug\n  color: d73a4a\n  description: y",
    ],
  ])("rejects %s with ERR_LABELS_MANIFEST", (_label, text) => {
    expect(codeOf(() => parseLabelManifest(text))).toBe("ERR_LABELS_MANIFEST");
  });
});
