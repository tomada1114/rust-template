import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, main } from "./skills.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const skill = (frontmatter: string, body = "# Title\n\nBody.\n"): string =>
  `---\n${frontmatter}\n---\n\n${body}`;

const ALPHA = skill("name: alpha\ndescription: >\n  Covers alpha. Use when alpha\n  happens.");
const BETA = skill('name: "beta"\ndescription: "Beta: quoted, with a colon."');

const index = (rows: readonly string[]): string => `# Guide

## Skills

Skills live under \`.agents/skills/\`.

| Skill | Load it for |
|---|---|
${rows.map((row) => `| ${row} | Something |`).join("\n")}

### Rules

| Rule | Loads when you touch |
|---|---|
| \`.claude/rules/rust.md\` | Rust |

## Next section
`;

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(overrides: Record<string, string | undefined> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  dirs.push(root);
  const files: Record<string, string | undefined> = {
    "AGENTS.md": index(["`alpha`", "`beta`"]),
    ".agents/skills/alpha/SKILL.md": ALPHA,
    ".agents/skills/beta/SKILL.md": BETA,
    ".agents/skills/beta/references/notes.md": "# Notes\n",
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content !== undefined) write(root, path, content);
  }
  return root;
}

const codes = (root: string): string[] => check.run(root).map((v) => v.code);
const actuals = (root: string): string[] => check.run(root).map((v) => v.actual);

describe("skills", () => {
  it("passes on well-formed skills indexed exactly once", () => {
    expect(check.run(fixture())).toEqual([]);
  });

  describe("frontmatter", () => {
    it.each([
      [
        "a third key",
        skill("name: alpha\ndescription: x\npaths: src/**"),
        "unexpected key `paths`",
      ],
      [
        "a name that differs from the directory",
        skill("name: alfa\ndescription: x"),
        "`name` is `alfa`",
      ],
      ["no name", skill("description: x"), "no `name`"],
      ["no description", skill("name: alpha"), "no `description`"],
      ["an empty description", skill('name: alpha\ndescription: ""'), "`description` is empty"],
      [
        "a description that is not a string",
        skill("name: alpha\ndescription: 42"),
        "`description` is not a string",
      ],
      [
        "a name that is not a string",
        skill("name: [alpha]\ndescription: x"),
        "`name` is not a string",
      ],
      ["no opening --- line", "# Alpha\n", "does not start with a `---` line"],
      ["an unclosed block", "---\nname: alpha\ndescription: x\n", "never closed"],
      [
        "a value that is not YAML",
        skill("name: alpha\ndescription: Use when: this"),
        "does not parse as YAML",
      ],
      [
        "a duplicate key",
        skill("name: alpha\nname: alpha\ndescription: x"),
        "does not parse as YAML",
      ],
      ["a block that is not a mapping", skill("- alpha"), "not a mapping"],
    ])("fails on %s", (_label, content, actual) => {
      const root = fixture({ ".agents/skills/alpha/SKILL.md": content });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_FRONTMATTER"]);
      expect(actuals(root)[0]).toContain(actual);
    });

    it("fails on a name that is not lowercase-hyphenated", () => {
      const root = fixture({
        "AGENTS.md": index(["`alpha`", "`beta`", "`Gamma_Skill`"]),
        ".agents/skills/Gamma_Skill/SKILL.md": skill("name: Gamma_Skill\ndescription: x"),
      });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_FRONTMATTER"]);
      expect(actuals(root)[0]).toContain("lowercase letters, digits, and single hyphens");
    });

    it("fails on a directory with no SKILL.md", () => {
      const root = fixture({
        "AGENTS.md": index(["`alpha`", "`beta`", "`empty`"]),
        ".agents/skills/empty/references/x.md": "x\n",
      });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_FRONTMATTER"]);
      expect(actuals(root)[0]).toContain("no SKILL.md");
    });
  });

  describe("description", () => {
    it("fails on a non-ASCII character", () => {
      const root = fixture({
        ".agents/skills/alpha/SKILL.md": skill(
          "name: alpha\ndescription: Covers alpha — and more.",
        ),
      });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_DESCRIPTION"]);
    });

    it("fails past 1,024 characters and passes at exactly 1,024", () => {
      const at = fixture({
        ".agents/skills/alpha/SKILL.md": skill(
          `name: alpha\ndescription: >\n  ${"a".repeat(1024)}`,
        ),
      });
      expect(check.run(at)).toEqual([]);
      const over = fixture({
        ".agents/skills/alpha/SKILL.md": skill(
          `name: alpha\ndescription: >\n  ${"a".repeat(1025)}`,
        ),
      });
      expect(codes(over)).toEqual(["ERR_CHECK_SKILL_DESCRIPTION"]);
      expect(actuals(over)[0]).toContain("1025 characters");
    });

    it.each([
      ["description", skill("name: alpha\ndescription: Use it #now to see")],
      ["name", skill("name: alpha # the name\ndescription: x")],
    ])("fails when a comment silently truncates the %s", (_label, content) => {
      const root = fixture({ ".agents/skills/alpha/SKILL.md": content });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_DESCRIPTION"]);
      expect(actuals(root)[0]).toContain("comment");
    });
  });

  it("fails on a SKILL.md below a skill's top directory", () => {
    const root = fixture({ ".agents/skills/beta/references/SKILL.md": ALPHA });
    expect(codes(root)).toEqual(["ERR_CHECK_SKILL_NESTED"]);
    expect(check.run(root)[0]?.summary).toContain(".agents/skills/beta/references/SKILL.md");
  });

  it("fails past 200 body lines and passes at exactly 200", () => {
    const body = (lines: number): string =>
      `${Array.from({ length: lines }, (_, i) => `line ${String(i)}`).join("\n")}\n`;
    const at = fixture({
      ".agents/skills/alpha/SKILL.md": `---\nname: alpha\ndescription: x\n---\n${body(200)}`,
    });
    expect(check.run(at)).toEqual([]);
    const over = fixture({
      ".agents/skills/alpha/SKILL.md": `---\nname: alpha\ndescription: x\n---\n${body(201)}`,
    });
    expect(codes(over)).toEqual(["ERR_CHECK_SKILL_BODY"]);
    expect(actuals(over)[0]).toContain("201 lines");
  });

  it("fails on a symlinked file inside a skill", () => {
    const root = fixture();
    symlinkSync(
      join(root, ".agents/skills/beta/references/notes.md"),
      join(root, ".agents/skills/alpha/link.md"),
    );
    expect(codes(root)).toEqual(["ERR_CHECK_SKILL_SYMLINK"]);
    expect(check.run(root)[0]?.summary).toContain(".agents/skills/alpha/link.md");
  });

  it("fails on a symlinked skill directory without following it", () => {
    const root = fixture({ "AGENTS.md": index(["`alpha`", "`beta`", "`gamma`"]) });
    symlinkSync(join(root, ".agents/skills/alpha"), join(root, ".agents/skills/gamma"));
    expect(codes(root)).toEqual(["ERR_CHECK_SKILL_SYMLINK"]);
  });

  describe("the Skills table in AGENTS.md", () => {
    it("fails on a directory with no row", () => {
      const root = fixture({ "AGENTS.md": index(["`alpha`"]) });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_INDEX"]);
      expect(check.run(root)[0]?.summary).toContain("`beta`");
    });

    it("fails on a row with no directory", () => {
      const agents = index(["`alpha`", "`beta`", "`ghost`"]);
      const root = fixture({ "AGENTS.md": agents });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_INDEX"]);
      const line = agents.split("\n").findIndex((l) => l.includes("ghost")) + 1;
      expect(check.run(root)[0]?.summary).toContain(`AGENTS.md:${String(line)}`);
    });

    it("fails on a second row for one skill", () => {
      const root = fixture({ "AGENTS.md": index(["`alpha`", "`beta`", "alpha"]) });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_INDEX"]);
      expect(actuals(root)[0]).toContain("second row");
    });

    it("fails on a row whose first cell is empty", () => {
      const root = fixture({ "AGENTS.md": index(["`alpha`", "`beta`", " "]) });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_INDEX"]);
    });

    it("fails when there is no Skills table", () => {
      const root = fixture({
        "AGENTS.md":
          "# Guide\n\n## Skills\n\nNone yet.\n\n## Rules\n\n| a | b |\n|---|---|\n| `alpha` | x |\n",
      });
      expect(codes(root)).toEqual(["ERR_CHECK_SKILL_INDEX"]);
      expect(actuals(root)[0]).toContain("no table");
    });

    it("ignores a heading-like line inside a code block in the section", () => {
      const agents = index(["`alpha`", "`beta`"]).replace(
        "Skills live under",
        "```bash\n# a comment, not a heading\n```\n\nSkills live under",
      );
      expect(check.run(fixture({ "AGENTS.md": agents }))).toEqual([]);
    });
  });

  it.each([["AGENTS.md"], [".agents/skills/alpha/SKILL.md"]])(
    "fails with ERR_CHECK_INPUT_MISSING when %s's tree is absent",
    (path) => {
      const root = fixture();
      rmSync(join(root, path === "AGENTS.md" ? "AGENTS.md" : ".agents"), { recursive: true });
      expect(codes(root)).toEqual(["ERR_CHECK_INPUT_MISSING"]);
    },
  );

  it("runs as a script and logs a pass", () => {
    const lines: string[] = [];
    const context: ScriptContext = {
      argv: ["--root", fixture()],
      env: {},
      root: "/nowhere",
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => lines.push(line),
    };
    main(context);
    expect(lines).toEqual(["check skills: ok"]);
  });
});
