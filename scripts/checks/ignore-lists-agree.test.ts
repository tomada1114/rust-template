import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ScriptContext } from "../lib/script.ts";
import { check, main } from "./ignore-lists-agree.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PRETTIERIGNORE = "dist/\n# The generated mirror\n.claude/skills/\n*.md\n";

const ESLINT = `import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "dist/",
    ".claude/skills/",
    '**/fixtures/',
  ]),
  { rules: {} },
]);
`;

const TYPOS = `[files]
extend-exclude = [
  "Cargo.lock",
  ".claude/skills/",
]
`;

const VITEST = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "ui", include: ["ui/src/**/*.test.{ts,tsx}"] } },
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.ts", ".agents/skills/*/scripts/**/*.test.ts"],
          exclude: ["**/fixtures/**"],
        },
      },
    ],
    coverage: {
      include: ["ui/src/**/*.{ts,tsx}", "scripts/**/*.ts", ".agents/skills/*/scripts/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}"],
    },
  },
});
`;

const PACKAGE = `${JSON.stringify(
  {
    scripts: {
      "test:scripts":
        "vitest run --project scripts --coverage --coverage.include='scripts/**/*.ts' --coverage.include='.agents/skills/*/scripts/**/*.ts'",
      lint: "eslint .",
    },
  },
  null,
  2,
)}\n`;

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(overrides: Record<string, string | undefined> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ignore-lists-agree-"));
  dirs.push(root);
  const files: Record<string, string | undefined> = {
    ".prettierignore": PRETTIERIGNORE,
    "eslint.config.mjs": ESLINT,
    "typos.toml": TYPOS,
    "vitest.config.ts": VITEST,
    "package.json": PACKAGE,
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content !== undefined) write(root, path, content);
  }
  return root;
}

const codes = (root: string): string[] => check.run(root).map((v) => v.code);
const summaries = (root: string): string[] => check.run(root).map((v) => v.summary);

describe("ignore-lists-agree", () => {
  it("passes when every tool excludes the mirror and none excludes the source", () => {
    expect(check.run(fixture())).toEqual([]);
  });

  it.each([["/.claude/skills"], [".claude/skills/**"], [".claude/"], ["**/.claude/skills/*"]])(
    "accepts the .prettierignore spelling %s",
    (entry) => {
      expect(check.run(fixture({ ".prettierignore": `${entry}\n` }))).toEqual([]);
    },
  );

  it("passes without a package.json", () => {
    expect(check.run(fixture({ "package.json": undefined }))).toEqual([]);
  });

  describe("the mirror", () => {
    it("fails when .prettierignore does not exclude it", () => {
      const root = fixture({ ".prettierignore": "dist/\n.claude/skills-old/\n" });
      expect(summaries(root)).toEqual([".prettierignore does not exclude .claude/skills/"]);
      expect(codes(root)).toEqual(["ERR_CHECK_IGNORE_MIRROR"]);
    });

    it("fails when a later negation re-includes it", () => {
      const root = fixture({ ".prettierignore": ".claude/skills/\n!.claude/skills/demo/\n" });
      expect(codes(root)).toEqual(["ERR_CHECK_IGNORE_MIRROR"]);
    });

    it("fails when ESLint's global ignores do not exclude it", () => {
      const root = fixture({ "eslint.config.mjs": ESLINT.replace('    ".claude/skills/",\n', "") });
      expect(summaries(root)).toEqual(["eslint.config.mjs does not exclude .claude/skills/"]);
    });

    it("fails when eslint.config.mjs has no global ignores at all", () => {
      const root = fixture({ "eslint.config.mjs": "export default [];\n" });
      expect(codes(root)).toEqual(["ERR_CHECK_IGNORE_MIRROR"]);
    });

    it("accepts an ignores-only config object in eslint.config.mjs", () => {
      const root = fixture({
        "eslint.config.mjs": 'export default [{ ignores: [".claude/skills/**"] }];\n',
      });
      expect(check.run(root)).toEqual([]);
    });

    it("fails when typos.toml does not exclude it", () => {
      const root = fixture({ "typos.toml": '[files]\nextend-exclude = ["Cargo.lock"]\n' });
      expect(summaries(root)).toEqual(["typos.toml does not exclude .claude/skills/"]);
    });

    it("fails when typos.toml has no [files] table", () => {
      expect(codes(fixture({ "typos.toml": "[default]\nlocale = 'en'\n" }))).toEqual([
        "ERR_CHECK_IGNORE_MIRROR",
      ]);
    });

    it("fails when a Vitest include reaches the mirror and nothing excludes it", () => {
      const root = fixture({
        "vitest.config.ts": VITEST.replace('"scripts/**/*.test.ts"', '"**/*.test.ts"'),
      });
      expect(summaries(root)).toEqual(["vitest.config.ts does not exclude .claude/skills/"]);
    });

    it("accepts a Vitest include that reaches the mirror when an exclude removes it", () => {
      const root = fixture({
        "vitest.config.ts": VITEST.replace('"scripts/**/*.test.ts"', '"**/*.test.ts"').replace(
          '"**/fixtures/**"',
          '"**/fixtures/**", ".claude/skills/**"',
        ),
      });
      expect(check.run(root)).toEqual([]);
    });

    it("fails when package.json widens Vitest's coverage to the mirror", () => {
      const root = fixture({
        "package.json": PACKAGE.replace(
          "--coverage.include='scripts/**/*.ts'",
          "--coverage.include='**/*.ts'",
        ),
      });
      expect(summaries(root)).toEqual(["package.json does not exclude .claude/skills/"]);
    });
  });

  describe("the source", () => {
    it.each([
      [".prettierignore", `${PRETTIERIGNORE}.agents/skills/\n`],
      ["eslint.config.mjs", ESLINT.replace('"dist/",', '"dist/", ".agents/",')],
      ["typos.toml", TYPOS.replace('"Cargo.lock",', '"Cargo.lock", ".agents/skills/**",')],
      [
        "vitest.config.ts",
        VITEST.replace('exclude: ["**/fixtures/**"]', 'exclude: ["**/fixtures/**", ".agents/**"]'),
      ],
    ])("fails when %s excludes .agents/skills/", (path, content) => {
      const root = fixture({ [path]: content });
      expect(codes(root)).toEqual(["ERR_CHECK_IGNORE_SOURCE"]);
      expect(summaries(root)).toEqual([`${path} excludes .agents/skills/, the skills' real files`]);
    });
  });

  it.each([[".prettierignore"], ["eslint.config.mjs"], ["typos.toml"], ["vitest.config.ts"]])(
    "fails with ERR_CHECK_INPUT_MISSING without %s",
    (path) => {
      expect(codes(fixture({ [path]: undefined }))).toEqual(["ERR_CHECK_INPUT_MISSING"]);
    },
  );

  it.each([
    ["typos.toml", "[files\n"],
    ["package.json", "{"],
  ])("fails with ERR_CHECK_INPUT_UNREADABLE when %s does not parse", (path, content) => {
    expect(codes(fixture({ [path]: content }))).toEqual(["ERR_CHECK_INPUT_UNREADABLE"]);
  });

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
    expect(lines).toEqual(["check ignore-lists-agree: ok"]);
  });
});
