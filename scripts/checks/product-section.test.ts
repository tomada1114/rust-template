import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, main } from "./product-section.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Split so the bootstrap's placeholder scan never finds the literal in this file.
const PLACEHOLDER = ["com", "example", "my" + "app"].join(".");

const SKELETON = `# Project Guide

## Overview

A template.

## Product

**TODO: in the template this section is a placeholder.**

- **What it is, and who it is for** — TODO: one paragraph.
- **Non-goals** — TODO: what this app deliberately does not do.

## Quick Reference

\`\`\`bash
just check  # TODO: this marker is outside the section
\`\`\`
`;

const FILLED = SKELETON.replace(
  /## Product\n[\s\S]*?\n## Quick Reference/,
  `## Product

A menu-bar TODO list app for people who plan their day in the morning; the reasoning is
in docs/TODO.md.

- **Non-goals** — sync, sharing, and reminders.

### Where these decisions are recorded

docs/architecture/.

## Quick Reference`,
);

const conf = (identifier: string): string =>
  `${JSON.stringify({ productName: "Widget", identifier }, null, 2)}\n`;

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(agents: string | undefined, tauriConf: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "product-section-"));
  dirs.push(root);
  if (agents !== undefined) write(root, "AGENTS.md", agents);
  if (tauriConf !== undefined) write(root, "src-tauri/tauri.conf.json", tauriConf);
  return root;
}

const TEMPLATE = conf(PLACEHOLDER);
const APP = conf("com.acme.widget");
const codes = (root: string): string[] => check.run(root).map((v) => v.code);

describe("product-section", () => {
  it("passes on the skeleton in the template", () => {
    expect(check.run(fixture(SKELETON, TEMPLATE))).toEqual([]);
  });

  it("passes on a filled section in an app, prose saying TODO included", () => {
    expect(check.run(fixture(FILLED, APP))).toEqual([]);
  });

  it("fails on each TODO: left in an app, with its line", () => {
    const violations = check.run(fixture(SKELETON, APP));
    expect(violations.map((v) => v.code)).toEqual([
      "ERR_CHECK_PRODUCT_SECTION",
      "ERR_CHECK_PRODUCT_SECTION",
      "ERR_CHECK_PRODUCT_SECTION",
    ]);
    expect(violations.map((v) => v.summary)).toEqual([
      "AGENTS.md:9 still holds a `TODO:` marker after the bootstrap",
      "AGENTS.md:11 still holds a `TODO:` marker after the bootstrap",
      "AGENTS.md:12 still holds a `TODO:` marker after the bootstrap",
    ]);
  });

  it("fails on a filled section while the template's placeholder remains", () => {
    const violations = check.run(fixture(FILLED, TEMPLATE));
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_PRODUCT_SECTION"]);
    expect(violations[0]?.actual).toContain("no `TODO:` marker");
  });

  it.each([
    ["the template", TEMPLATE],
    ["an app", APP],
  ])("fails in %s when there is no Product section", (_label, tauriConf) => {
    const violations = check.run(
      fixture(FILLED.replace("## Product\n", "## Purpose\n"), tauriConf),
    );
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_PRODUCT_SECTION"]);
    expect(violations[0]?.actual).toContain("no `## Product` heading");
  });

  it("fails when the section does not name its Non-goals", () => {
    const violations = check.run(
      fixture(FILLED.replace("- **Non-goals** — sync, sharing, and reminders.\n", ""), APP),
    );
    expect(violations.map((v) => v.code)).toEqual(["ERR_CHECK_PRODUCT_SECTION"]);
    expect(violations[0]?.actual).toContain("Non-goals");
  });

  it.each([
    ["AGENTS.md", undefined, TEMPLATE],
    ["tauri.conf.json", SKELETON, undefined],
  ])("fails with ERR_CHECK_INPUT_MISSING without %s", (_label, agents, tauriConf) => {
    expect(codes(fixture(agents, tauriConf))).toEqual(["ERR_CHECK_INPUT_MISSING"]);
  });

  it.each([
    ["not JSON", "{ nope"],
    ["without an identifier", '{ "productName": "x" }'],
  ])("fails with ERR_CHECK_INPUT_UNREADABLE on a tauri.conf.json %s", (_label, text) => {
    expect(codes(fixture(SKELETON, text))).toEqual(["ERR_CHECK_INPUT_UNREADABLE"]);
  });

  it("runs as a script and logs a pass", () => {
    const lines: string[] = [];
    const context: ScriptContext = {
      argv: ["--root", fixture(SKELETON, TEMPLATE)],
      env: {},
      root: "/nowhere",
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => lines.push(line),
    };
    main(context);
    expect(lines).toEqual(["check product-section: ok"]);
  });
});
