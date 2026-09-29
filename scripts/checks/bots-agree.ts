/**
 * The three supply-chain cooldowns wait the same number of days (design D8, D14):
 * Dependabot's `cooldown`, Renovate's `minimumReleaseAge`, and pnpm's
 * `minimumReleaseAge`. A bot that waits less than pnpm opens a PR whose install pnpm
 * refuses; one that waits more holds back a release the other bot already pulled.
 * Ported from macos-app-template's dependency-bots-agree.sh (its prefix half lives in
 * workflow-hygiene.ts), reading YAML with `yaml` and JSON with JSON.parse.
 *
 *   node scripts/checks/bots-agree.ts [--root DIR]
 *
 * Files, each optional (an absent one is not compared):
 *   - .github/dependabot.yml|.yaml: every `updates[]` entry's `cooldown.default-days`,
 *     a whole number of days. The per-semver `semver-*-days` are not read.
 *   - the first JSON Renovate config found (workflow-hygiene.ts's RENOVATE_FILES):
 *     the top-level `minimumReleaseAge` (required) and any in `packageRules`, each a
 *     duration read by toDays (`7 days`, `1 week`, `168 hours`, `10080 minutes`).
 *   - pnpm-workspace.yaml: `minimumReleaseAge`, in minutes (10080 = 7 days).
 * Every stated value must be a whole number of days, and all of them the same number.
 *
 * Git work tree: not required; the check reads files under --root.
 *
 * Errors (FailureDetails; the runner prints them all):
 *   ERR_CHECK_USAGE                   bad arguments (scripts/checks/lib.ts)
 *   ERR_CHECK_BOTS_UNREADABLE         a config does not parse
 *   ERR_CHECK_BOTS_COOLDOWN_MISSING   a present config states no cooldown, or one that is not whole days
 *   ERR_CHECK_BOTS_COOLDOWN_DISAGREE  the stated cooldowns are not all the same number of days
 */
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";
import { DEPENDABOT_FILES, isRecord, readYaml, RENOVATE_FILES } from "./shared/workflows.ts";

const PNPM_WORKSPACE = "pnpm-workspace.yaml";
const MINUTES_PER_DAY = 24 * 60;
const UNIT_MINUTES: Record<string, number> = {
  m: 1,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hour: 60,
  hours: 60,
  d: MINUTES_PER_DAY,
  day: MINUTES_PER_DAY,
  days: MINUTES_PER_DAY,
  w: 7 * MINUTES_PER_DAY,
  week: 7 * MINUTES_PER_DAY,
  weeks: 7 * MINUTES_PER_DAY,
};

/** A Renovate duration (`7 days`, `1 week`, `168 hours`) as whole days, else undefined. */
export function toDays(value: string): number | undefined {
  const match = /^(\d+)\s*([a-z]+)$/i.exec(value.trim());
  if (match === null) return undefined;
  const [, count, unit] = match;
  const perUnit = UNIT_MINUTES[(unit ?? "").toLowerCase()];
  if (perUnit === undefined) return undefined;
  return wholeDays(Number(count) * perUnit);
}

function wholeDays(minutes: number): number | undefined {
  return Number.isInteger(minutes) && minutes > 0 && minutes % MINUTES_PER_DAY === 0
    ? minutes / MINUTES_PER_DAY
    : undefined;
}

interface Cooldown {
  /** `path:line` or `path`. */
  readonly where: string;
  readonly setting: string;
  readonly value: unknown;
  /** The value in whole days, or undefined when it is absent or not whole days. */
  readonly days: number | undefined;
}

interface Reading {
  readonly cooldowns: Cooldown[];
  readonly unreadable: string[];
}

const EMPTY: Reading = { cooldowns: [], unreadable: [] };

function dependabot(root: string): Reading {
  const path = DEPENDABOT_FILES.find((candidate) => readRepoFile(root, candidate) !== undefined);
  if (path === undefined) return EMPTY;
  const file = readYaml(root, path);
  if (typeof file !== "object") return { cooldowns: [], unreadable: [String(file)] };
  const updates = isRecord(file.data) ? file.data["updates"] : undefined;
  const cooldowns: Cooldown[] = [];
  (Array.isArray(updates) ? updates : []).forEach((entry: unknown, index) => {
    if (!isRecord(entry)) return;
    const ecosystem = entry["package-ecosystem"];
    const cooldown = entry["cooldown"];
    const value = isRecord(cooldown) ? cooldown["default-days"] : undefined;
    const keys = ["updates", index, "cooldown", "default-days"];
    cooldowns.push({
      where: `${path}:${String(file.locate(keys).line)}`,
      setting: `Dependabot \`${typeof ecosystem === "string" ? ecosystem : `updates[${String(index)}]`}\` cooldown.default-days`,
      value,
      days: typeof value === "number" ? wholeDays(value * MINUTES_PER_DAY) : undefined,
    });
  });
  return { cooldowns, unreadable: [] };
}

function renovate(root: string): Reading {
  const path = RENOVATE_FILES.find((candidate) => readRepoFile(root, candidate) !== undefined);
  if (path === undefined) return EMPTY;
  let config: unknown;
  try {
    config = JSON.parse(readRepoFile(root, path) ?? "");
  } catch (error: unknown) {
    return {
      cooldowns: [],
      unreadable: [`${path}: not JSON (${error instanceof Error ? error.message : String(error)})`],
    };
  }
  const top = isRecord(config) ? config : {};
  const entries: [string, unknown][] = [["minimumReleaseAge", top["minimumReleaseAge"]]];
  const rules = top["packageRules"];
  (Array.isArray(rules) ? rules : []).forEach((rule: unknown, index) => {
    if (isRecord(rule) && rule["minimumReleaseAge"] !== undefined) {
      entries.push([`packageRules[${String(index)}].minimumReleaseAge`, rule["minimumReleaseAge"]]);
    }
  });
  return {
    cooldowns: entries.map(([setting, value]) => ({
      where: path,
      setting: `Renovate ${setting}`,
      value,
      days: typeof value === "string" ? toDays(value) : undefined,
    })),
    unreadable: [],
  };
}

function pnpm(root: string): Reading {
  const file = readYaml(root, PNPM_WORKSPACE);
  if (file === undefined) return EMPTY;
  if (typeof file === "string") return { cooldowns: [], unreadable: [file] };
  const value = isRecord(file.data) ? file.data["minimumReleaseAge"] : undefined;
  return {
    cooldowns: [
      {
        where: `${PNPM_WORKSPACE}:${String(file.locate(["minimumReleaseAge"]).line)}`,
        setting: "pnpm minimumReleaseAge",
        value,
        days: typeof value === "number" ? wholeDays(value) : undefined,
      },
    ],
    unreadable: [],
  };
}

const NEXT =
  'set every value named above to the one cooldown the policy states (7 days: `default-days: 7`, `"minimumReleaseAge": "7 days"`, pnpm `minimumReleaseAge: 10080`), all in one change';

export const check: Check = {
  name: "bots-agree",
  run: (root) => {
    const readings = [dependabot(root), renovate(root), pnpm(root)];
    const found: FailureDetails[] = readings.flatMap((reading) =>
      reading.unreadable.map((problem) => ({
        code: "ERR_CHECK_BOTS_UNREADABLE",
        summary: "a dependency-cooldown config cannot be parsed",
        expected: "dependabot.yml and pnpm-workspace.yaml to be YAML, and the Renovate config JSON",
        actual: problem,
        next: "fix the file's syntax (a JSON5 Renovate config is not read: rename it to renovate.json)",
      })),
    );
    const cooldowns = readings.flatMap((reading) => reading.cooldowns);
    for (const cooldown of cooldowns.filter((entry) => entry.days === undefined)) {
      found.push({
        code: "ERR_CHECK_BOTS_COOLDOWN_MISSING",
        summary: `${cooldown.where}: ${cooldown.setting} is ${cooldown.value === undefined ? "not set" : "not a whole number of days"}`,
        expected:
          "every Dependabot entry's cooldown.default-days, Renovate's minimumReleaseAge, and pnpm's minimumReleaseAge (minutes) set to a whole number of days",
        actual: cooldown.value === undefined ? "absent" : JSON.stringify(cooldown.value),
        next: NEXT,
      });
    }
    const stated = cooldowns.filter((entry) => entry.days !== undefined);
    if (new Set(stated.map((entry) => entry.days)).size > 1) {
      found.push({
        code: "ERR_CHECK_BOTS_COOLDOWN_DISAGREE",
        summary: "the supply-chain cooldowns are not the same number of days",
        expected:
          "Dependabot's cooldown, Renovate's minimumReleaseAge, and pnpm's minimumReleaseAge equal",
        actual: stated
          .map((entry) => `${entry.where}: ${entry.setting} = ${String(entry.days)} day(s)`)
          .join("; "),
        next: NEXT,
      });
    }
    return found;
  },
};

export const main = checkMain(check);

if (import.meta.main) await runScript(main);
