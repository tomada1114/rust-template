import { describe, expect, it } from "vitest";

import { gitEnv, stagedGuardEnv } from "./git-env.ts";

describe("gitEnv", () => {
  it("drops every GIT_* variable and keeps the rest", () => {
    const env = { PATH: "/bin", GIT_DIR: "/elsewhere", GIT_INDEX_FILE: "/tmp/index", HOME: "/h" };
    expect(gitEnv(env)).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("stagedGuardEnv", () => {
  it("keeps GIT_INDEX_FILE, which a hook needs to read the index being committed", () => {
    const env = { PATH: "/bin", GIT_DIR: "/elsewhere", GIT_INDEX_FILE: "/tmp/index" };
    expect(stagedGuardEnv(env)).toEqual({ PATH: "/bin", GIT_INDEX_FILE: "/tmp/index" });
  });

  it("adds nothing when git set no index file", () => {
    expect(stagedGuardEnv({ PATH: "/bin", GIT_WORK_TREE: "/w" })).toEqual({ PATH: "/bin" });
  });
});
