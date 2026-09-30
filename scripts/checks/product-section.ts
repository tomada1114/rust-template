/**
 * `AGENTS.md`'s `## Product` section matches which repository this is.
 * It is the one part of that file about the app rather than the harness — what it is, for
 * whom, and what it deliberately is not. In the template it is a `TODO:` skeleton; in an
 * app the bootstrap has produced, a surviving marker means an agent has no in-repo
 * answer to "is this in scope?". The bootstrap smoke relies on this check failing, with
 * ERR_CHECK_PRODUCT_SECTION, on a freshly bootstrapped app whose section is unfilled.
 *
 *   node scripts/checks/product-section.ts [--root DIR]
 *
 * The section is the lines after a line that is exactly `## Product`, up to the next `## `
 * heading. The repository is the template while `src-tauri/tauri.conf.json`'s
 * `identifier` is still the template's placeholder bundle identifier, and an app once
 * the bootstrap has replaced it. In either, the section exists and names its
 * `Non-goals`; in the template it holds at least one `TODO:` (so filling it in here cannot
 * make the app-side rule vacuous for every app cut later); in an app it holds none. The
 * marker is `TODO:` with its colon, so prose about a to-do list is not mistaken for one.
 * No git work tree needed.
 *
 * Errors: ERR_CHECK_USAGE, ERR_CHECK_INPUT_MISSING (no AGENTS.md or tauri.conf.json),
 * ERR_CHECK_INPUT_UNREADABLE (tauri.conf.json is not JSON with a string `identifier`),
 * ERR_CHECK_PRODUCT_SECTION.
 */
import type { FailureDetails } from "../lib/fail.ts";
import { runScript } from "../lib/script.ts";
import { checkMain, readRepoFile, type Check } from "./lib.ts";

const CONF = "src-tauri/tauri.conf.json";
// Split so the bootstrap's leftover-placeholder scan never finds the literal here: its
// absence from tauri.conf.json is what tells this check the bootstrap has run.
const PLACEHOLDER_IDENTIFIER = ["com", "example", "my" + "app"].join(".");
const MARKER = "TODO:";
const FILL_IT =
  "write AGENTS.md's `## Product` section for this app (what it is and for whom, the core interaction, its non-goals, where those decisions are recorded) and delete every `TODO:` (the `starting-an-app` skill walks through it)";

function productViolation(
  summary: string,
  mode: string,
  actual: string,
  next = FILL_IT,
): FailureDetails {
  return {
    code: "ERR_CHECK_PRODUCT_SECTION",
    summary,
    expected: `a \`## Product\` section naming its Non-goals, ${mode === "template" ? "left as a `TODO:` skeleton in the template" : "holding no `TODO:` once the bootstrap has made this an app"}`,
    actual,
    next,
  };
}

function identifier(root: string): string | FailureDetails {
  const text = readRepoFile(root, CONF);
  if (text === undefined) {
    return {
      code: "ERR_CHECK_INPUT_MISSING",
      summary: `${CONF} does not exist`,
      expected: `${CONF}, whose identifier tells the template from an app`,
      actual: "no such file",
      next: "run the check against the repository root (--root DIR)",
    };
  }
  let conf: unknown;
  try {
    conf = JSON.parse(text);
  } catch {
    conf = undefined;
  }
  const value =
    typeof conf === "object" && conf !== null && "identifier" in conf ? conf.identifier : undefined;
  if (typeof value === "string") return value;
  return {
    code: "ERR_CHECK_INPUT_UNREADABLE",
    summary: `${CONF} has no readable identifier`,
    expected: `${CONF} to be JSON with a string \`identifier\``,
    actual: conf === undefined ? "the file is not JSON" : "no string `identifier` key",
    next: `fix ${CONF}`,
  };
}

function run(root: string): FailureDetails[] {
  const agents = readRepoFile(root, "AGENTS.md");
  if (agents === undefined) {
    return [
      {
        code: "ERR_CHECK_INPUT_MISSING",
        summary: "AGENTS.md does not exist",
        expected: "AGENTS.md at the root, with a `## Product` section",
        actual: "no such file",
        next: "run the check against the repository root (--root DIR)",
      },
    ];
  }
  const id = identifier(root);
  if (typeof id !== "string") return [id];
  const mode = id === PLACEHOLDER_IDENTIFIER ? "template" : "app";

  const lines = agents.split("\n");
  const start = lines.indexOf("## Product");
  if (start === -1) {
    return [
      productViolation(
        "AGENTS.md has no `## Product` section",
        mode,
        "no `## Product` heading (it must be exactly that line)",
      ),
    ];
  }
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => line.startsWith("## "));
  const section = (end === -1 ? after : after.slice(0, end)).map((text, index) => ({
    text,
    line: start + index + 2,
  }));

  const violations: FailureDetails[] = [];
  if (!section.some(({ text }) => text.includes("Non-goals"))) {
    violations.push(
      productViolation(
        "AGENTS.md's `## Product` section does not name its Non-goals",
        mode,
        "no `Non-goals` entry in the section",
      ),
    );
  }
  const markers = section.filter(({ text }) => text.includes(MARKER));
  if (mode === "template" && markers.length === 0) {
    violations.push(
      productViolation(
        "AGENTS.md's `## Product` section is filled in while the template's placeholders remain",
        mode,
        `no \`${MARKER}\` marker, but ${CONF}'s identifier is still the template's placeholder`,
        "restore the `TODO:` skeleton in the template: each app fills it in after the bootstrap, and this check then insists it does",
      ),
    );
  }
  if (mode === "app") {
    for (const { text, line } of markers) {
      violations.push(
        productViolation(
          `AGENTS.md:${String(line)} still holds a \`${MARKER}\` marker after the bootstrap`,
          mode,
          text.trim(),
        ),
      );
    }
  }
  return violations;
}

export const check: Check = { name: "product-section", run };
export const main = checkMain(check);

if (import.meta.main) await runScript(main);
