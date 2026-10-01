import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  // Generated and build output only; everything hand-written is linted. .claude/skills/
  // is a generated mirror of .agents/skills/, linted at its real path.
  globalIgnores([
    "coverage/",
    "target/",
    "node_modules/",
    ".claude/skills/",
    ".claude/worktrees/",
    "**/fixtures/",
  ]),
  {
    linterOptions: {
      // A disable directive that suppresses nothing hides the next real violation.
      reportUnusedDisableDirectives: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", minimumDescriptionLength: 10 },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // A switch over a union names every member and has no `default`: a `default` would
      // silently answer for a member added later, which is what the check exists to catch.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { allowDefaultCaseForExhaustiveSwitch: false, considerDefaultExhaustiveForUnions: false },
      ],
      "no-console": "error",
      // no-console sees only the bare global; these are the same console by another name.
      "no-restricted-properties": [
        "error",
        ...["window", "globalThis", "self"].map((object) => ({
          object,
          property: "console",
          message: "Use console only where no-console allows it (scripts/).",
        })),
      ],
    },
  },
  {
    name: "config-files",
    files: ["*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    name: "scripts",
    files: ["scripts/**/*.ts", ".agents/skills/*/scripts/**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: {
      // Terminal output is what a repository script produces.
      "no-console": "off",
      "no-restricted-properties": "off",
    },
  },
  // Must stay last: turns off stylistic rules that would fight Prettier.
  eslintConfigPrettier,
]);
