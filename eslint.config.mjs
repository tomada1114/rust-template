import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// Each boundary is enforced twice: `group` feeds no-restricted-imports (import and export
// declarations), `specifier` feeds no-restricted-syntax, since that rule never sees a
// dynamic `import()`. An `import("…")` type is already refused everywhere by
// consistent-type-imports.

/** Only ui/src/ipc/ talks to Tauri (design D3). */
const TAURI_ONLY_IN_IPC = {
  group: ["@tauri-apps/*", "@tauri-apps/**"],
  specifier: /^@tauri-apps\//,
  message: "Only ui/src/ipc/ may import @tauri-apps/*. Add a typed wrapper there and import it.",
};

/** Generated bindings are reached through ui/src/ipc/types.ts (design D4). */
const GENERATED_ONLY_IN_IPC = {
  group: ["**/ipc/generated", "**/ipc/generated/**", "./generated/**", "../generated/**"],
  specifier: /(^|\/)ipc\/generated(\/|$)|^\.\.?\/generated\//,
  message: "Import IPC types from ui/src/ipc/types.ts; only ui/src/ipc/ reads ./generated/.",
};

const TESTING_MESSAGE =
  "ui/src/ipc/testing.ts mocks the Rust side; only tests and ui/src/test/ may import it.";

/** The IPC mocks never reach production code, seen from outside ui/src/ipc/. */
const TESTING_ONLY_IN_TESTS = {
  group: ["**/ipc/testing", "**/ipc/testing.ts"],
  specifier: /(^|\/)ipc\/testing(\.ts)?$/,
  message: TESTING_MESSAGE,
};

/** The same, seen from a sibling inside ui/src/ipc/. */
const TESTING_ONLY_IN_TESTS_FROM_IPC = {
  group: ["**/ipc/testing", "**/ipc/testing.ts", "./testing", "./testing.ts"],
  specifier: /(^|\/)ipc\/testing(\.ts)?$|^\.\/testing(\.ts)?$/,
  message: TESTING_MESSAGE,
};

/** Inside ui/src/ipc/, Tauri's IPC mocks are reached only through ./testing, which tests import. */
const API_MOCKS_ONLY_IN_TESTING = {
  group: ["@tauri-apps/api/mocks", "@tauri-apps/api/mocks.*"],
  specifier: /^@tauri-apps\/api\/mocks(\.[cm]?js)?$/,
  message:
    "Only ui/src/ipc/testing.ts and tests may import @tauri-apps/api/mocks; production code never mocks IPC.",
};

/** A computed `import()` specifier would slip past every boundary above. */
const LITERAL_DYNAMIC_IMPORT = {
  selector: "ImportExpression:not([source.type='Literal'])",
  message: "Name a dynamic import() with a string literal, so the IPC boundary rules can see it.",
};

/** @typedef {{ group: string[], specifier: RegExp, message: string }} ImportBoundary */

/**
 * One boundary set as options for both rules. A later block that sets either rule
 * replaces these options rather than merging them, so every ui/ block restates its set.
 *
 * @param {...ImportBoundary} boundaries
 */
function importBoundaries(...boundaries) {
  return {
    "no-restricted-imports": [
      "error",
      { patterns: boundaries.map(({ group, message }) => ({ group, message })) },
    ],
    "no-restricted-syntax": [
      "error",
      LITERAL_DYNAMIC_IMPORT,
      ...boundaries.map(({ specifier, message }) => ({
        selector: `ImportExpression[source.value=${String(specifier)}]`,
        message,
      })),
    ],
  };
}

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
          message: "Use console only where no-console allows it (ui/src/ipc/log.ts, scripts/).",
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
    name: "ui/react",
    files: ["ui/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...importBoundaries(TAURI_ONLY_IN_IPC, GENERATED_ONLY_IN_IPC, TESTING_ONLY_IN_TESTS),
    },
  },
  {
    name: "ui/ipc-boundary",
    files: ["ui/src/ipc/**/*.ts"],
    // The one place that may talk to Tauri and read the generated bindings.
    rules: importBoundaries(TESTING_ONLY_IN_TESTS_FROM_IPC, API_MOCKS_ONLY_IN_TESTING),
  },
  {
    name: "ui/ipc-testing",
    files: ["ui/src/ipc/testing.ts"],
    // The test helpers wrap Tauri's IPC mocks; tests reach them only through this file.
    rules: importBoundaries(TESTING_ONLY_IN_TESTS_FROM_IPC),
  },
  {
    name: "ui/tests",
    files: ["ui/src/**/*.test.{ts,tsx}", "ui/src/test/**/*.{ts,tsx}"],
    // Tests mock the Rust side through ui/src/ipc/testing.ts, and still reach Tauri only
    // through ui/src/ipc/.
    rules: importBoundaries(TAURI_ONLY_IN_IPC, GENERATED_ONLY_IN_IPC),
  },
  {
    name: "ui/ipc-tests",
    files: ["ui/src/ipc/**/*.test.ts"],
    rules: importBoundaries(),
  },
  {
    name: "ui/log-forwarder",
    files: ["ui/src/ipc/log.ts"],
    rules: {
      // When the bridge is down, the WebView console is the last place to say so.
      "no-console": "off",
      "no-restricted-properties": "off",
    },
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
