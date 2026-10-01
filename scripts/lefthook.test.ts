// lefthook.yml's pre-commit hook: the commit that concludes a conflicted merge, or one
// made at a conflicted rebase stop, carries a resolution no hook has seen, so the staged
// guard and the skills mirror must never be skipped for it. This reads the config only;
// xtask/tests/lefthook.rs runs the real hook through real merge and rebase commits.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { isRecord } from "./checks/shared/workflows.ts";

const ROOT = join(import.meta.dirname, "..");

describe("lefthook.yml", () => {
  it("never skips the staged guard or the skills mirror during a merge or a rebase", () => {
    const config: unknown = parse(readFileSync(join(ROOT, "lefthook.yml"), "utf8"));
    const hook = isRecord(config) ? config["pre-commit"] : undefined;
    if (!isRecord(hook) || !Array.isArray(hook["jobs"])) {
      throw new Error("lefthook.yml has no pre-commit block with a jobs list");
    }
    expect(hook["skip"]).toBeUndefined();
    expect(hook["only"]).toBeUndefined();
    const jobs: unknown[] = hook["jobs"];
    for (const name of ["staged guard", "skills mirror"]) {
      const job = jobs.find((candidate) => isRecord(candidate) && candidate["name"] === name);
      if (!isRecord(job)) throw new Error(`lefthook.yml has no "${name}" job`);
      expect(job["skip"], name).toBeUndefined();
      expect(job["only"], name).toBeUndefined();
    }
  });
});
