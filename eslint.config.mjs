import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Only ui/src/ipc/ talks to Tauri (design D3). */
const TAURI_ONLY_IN_IPC = {
  group: ["@tauri-apps/*", "@tauri-apps/**"],
  message: "Only ui/src/ipc/ may import @tauri-apps/*. Add a typed wrapper there and import it.",
};

/** Generated bindings are reached through ui/src/ipc/types.ts (design D4). */
const GENERATED_ONLY_IN_IPC = {
  group: ["**/ipc/generated", "**/ipc/generated/**", "./generated/**", "../generated/**"],
  message: "Import IPC types from ui/src/ipc/types.ts; only ui/src/ipc/ reads ./generated/.",
};

export default defineConfig([
  // Generated and build output only; everything hand-written is linted. .claude/skills/
  // is a generated mirror of .agents/skills/ (issue #139), linted at its real path.
  globalIgnores([
    "dist/",
    "coverage/",
    "target/",
    "node_modules/",
    "src-tauri/gen/",
    "src-tauri/binaries/",
    "ui/src/ipc/generated/",
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
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "no-console": "error",
    },
  },
  {
    name: "config-files",
    files: ["*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    name: "ui/react",
    files: ["ui/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": ["error", { patterns: [TAURI_ONLY_IN_IPC, GENERATED_ONLY_IN_IPC] }],
    },
  },
  {
    name: "ui/ipc-boundary",
    files: ["ui/src/ipc/**/*.ts"],
    rules: {
      // The one place that may talk to Tauri and read the generated bindings.
      "no-restricted-imports": "off",
    },
  },
  {
    name: "ui/log-forwarder",
    files: ["ui/src/ipc/log.ts"],
    rules: {
      // When the bridge is down, the WebView console is the last place to say so.
      "no-console": "off",
    },
  },
  {
    name: "scripts",
    files: ["scripts/**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: {
      // Terminal output is what a repository script produces.
      "no-console": "off",
    },
  },
  // Must stay last: turns off stylistic rules that would fight Prettier.
  eslintConfigPrettier,
]);
