import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    allowOnly: false,
    projects: [
      {
        extends: true,
        test: {
          name: "scripts",
          environment: "node",
          include: ["scripts/**/*.test.ts"],
          exclude: ["**/fixtures/**"],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
