/**
 * OSV-Scanner and Dependency Review skip the same GitHub advisories. Both run on every
 * pull request, so a GHSA advisory ignored in one but not the other fails a required
 * check (or passes one unseen) for a reason the other tool already decided.
 *
 *   node scripts/checks/advisory-ignores-agree.ts [--root DIR]
 *
 * Read:
 *   - `osv-scanner.toml` (optional; absent means no ignores): the `id` of every
 *     `[[IgnoredVulns]]` entry that starts with `GHSA-` (a RUSTSEC id has no
 *     Dependency Review counterpart);
 *   - `.github/workflows/dependency-review.yml` (optional; absent means nothing to
 *     compare): the `allow-ghsas` input, comma- or whitespace-separated, of every step
 *     that uses `actions/dependency-review-action`.
 * Every such step's `allow-ghsas` must hold exactly the OSV GHSA ids, compared
 * case-insensitively.
 *
 * Git work tree: not required; the check reads files under --root.
 *
 * Errors (FailureDetails; the runner prints them all):
 *   ERR_CHECK_USAGE                bad arguments (scripts/checks/lib.ts)
 *   ERR_CHECK_ADVISORY_UNREADABLE  osv-scanner.toml or the workflow does not parse
 *   ERR_CHECK_ADVISORY_DISAGREE    a step's allow-ghsas differs from the OSV GHSA ignores
 */
import { parse as parseToml } from "smol-toml";

import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import { isRecord, readYaml } from "./shared/workflows.ts";

const OSV = "osv-scanner.toml";
const WORKFLOW = ".github/workflows/dependency-review.yml";
const ACTION = "actions/dependency-review-action";

function unreadable(path: string, message: string): FailureDetails {
  return {
    code: "ERR_CHECK_ADVISORY_UNREADABLE",
    summary: `${path} does not parse`,
    expected: `${path} to parse, so its advisory exceptions can be read`,
    actual: message.split("\n")[0] ?? "",
    next: `fix ${path}`,
  };
}

/** The GHSA ids osv-scanner.toml ignores, upper-cased; a string is the parse error. */
function osvGhsas(root: string): string[] | string {
  const text = readRepoFile(root, OSV);
  if (text === undefined) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  const entries = parsed["IgnoredVulns"];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry: unknown) => (isRecord(entry) ? entry["id"] : undefined))
    .filter((id): id is string => typeof id === "string" && /^ghsa-/i.test(id))
    .map((id) => id.toUpperCase());
}

/** The `allow-ghsas` of each dependency-review-action step, by step label. */
function reviewSteps(data: unknown): [string, string[]][] {
  const jobs = isRecord(data) ? data["jobs"] : undefined;
  if (!isRecord(jobs)) return [];
  const found: [string, string[]][] = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = isRecord(job) ? job["steps"] : undefined;
    if (!Array.isArray(steps)) continue;
    steps.forEach((step: unknown, index) => {
      if (!isRecord(step)) return;
      const uses = step["uses"];
      if (typeof uses !== "string" || !uses.startsWith(`${ACTION}@`)) return;
      const inputs = step["with"];
      const raw = isRecord(inputs) ? inputs["allow-ghsas"] : undefined;
      const ids =
        typeof raw === "string"
          ? raw
              .split(/[\s,]+/)
              .filter((id) => id !== "")
              .map((id) => id.toUpperCase())
          : [];
      found.push([`jobs.${jobId}.steps[${String(index)}]`, ids]);
    });
  }
  return found;
}

const listed = (ids: readonly string[]): string =>
  ids.length === 0 ? "none" : [...ids].sort().join(", ");

function run(root: string): FailureDetails[] {
  const osv = osvGhsas(root);
  if (typeof osv === "string") return [unreadable(OSV, osv)];
  const workflow = readYaml(root, WORKFLOW);
  if (workflow === undefined) return [];
  if (typeof workflow === "string") return [unreadable(WORKFLOW, workflow)];

  const expected = new Set(osv);
  const violations: FailureDetails[] = [];
  for (const [label, ids] of reviewSteps(workflow.data)) {
    const actual = new Set(ids);
    const missing = [...expected].filter((id) => !actual.has(id));
    const extra = [...actual].filter((id) => !expected.has(id));
    if (missing.length === 0 && extra.length === 0) continue;
    violations.push({
      code: "ERR_CHECK_ADVISORY_DISAGREE",
      summary: `${WORKFLOW} ${label} allow-ghsas differs from ${OSV}'s GHSA ignores`,
      expected: `allow-ghsas to list exactly ${OSV}'s GHSA ids: ${listed([...expected])}`,
      actual: `missing: ${listed(missing)}; not ignored by OSV: ${listed(extra)}`,
      next: `make ${WORKFLOW}'s allow-ghsas and ${OSV}'s GHSA [[IgnoredVulns]] list the same ids, each with its reason and expiry (a gate change: the changing-gates skill)`,
    });
  }
  return violations;
}

export const check: Check = { name: "advisory-ignores-agree", run };
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
