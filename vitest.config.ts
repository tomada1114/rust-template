import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Cleanup is the runner's job: a stub that outlives its test makes a later
    // failure a mystery in another file.
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // A focused test silently shrinks the suite; fail on it everywhere.
    allowOnly: false,
    projects: [
      {
        extends: true,
        test: {
          name: "scripts",
          environment: "node",
          // A skill's bundled TypeScript scripts are repository scripts too.
          include: ["scripts/**/*.test.ts", ".agents/skills/*/scripts/**/*.test.ts"],
          exclude: ["**/fixtures/**"],
          testTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov"],
      // Every source file counts, tested or not, so an untested module shows as 0%.
      // Every extension the toolchain accepts as source (lefthook lints them all; tsconfig allows JS).
      include: [
        "scripts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
        ".agents/skills/*/scripts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      ],
      exclude: [
        "**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
        "**/fixtures/**",
        // Type declarations only.
        "**/*.d.{ts,mts,cts}",
      ],
      // Per-glob floors, never one combined number, so one tree cannot subsidise
      // another (typescript-template's pattern).
      thresholds: {
        // Every repository script; scripts/lib/guard/** also counts here.
        "scripts/**": { lines: 85, functions: 90 },
        // A skill's bundled TypeScript scripts, at the same floor as scripts/**.
        ".agents/skills/*/scripts/**": { lines: 85, functions: 90 },
        // The credential and path rules of the staged guard: the most security-critical
        // code in the repository, so a higher floor.
        "scripts/lib/guard/**": { lines: 90, functions: 100 },
      },
    },
  },
});
