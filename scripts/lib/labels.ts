/**
 * `.github/labels.yml`, the one declaration of this repository's labels:
 * a list of `{ name, color, description }`. Parsing validates what GitHub itself would
 * reject, so `just labels` fails before its first API call instead of halfway through.
 */
import { parse } from "yaml";

import { ScriptError } from "./fail.ts";

export interface LabelDeclaration {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/** GitHub's limit on a label description. */
const MAX_DESCRIPTION = 100;

function invalid(actual: string): ScriptError {
  return new ScriptError({
    code: "ERR_LABELS_MANIFEST",
    summary: ".github/labels.yml is not a valid label list",
    expected: `a YAML list of { name, color: six lowercase hex digits, description: ≤ ${String(MAX_DESCRIPTION)} characters }, names unique`,
    actual,
    next: "fix .github/labels.yml",
  });
}

function field(entry: object, key: string): unknown {
  return (entry as Record<string, unknown>)[key];
}

export function parseLabelManifest(text: string): LabelDeclaration[] {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error: unknown) {
    throw invalid(error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
  }
  if (!Array.isArray(parsed)) throw invalid("the top level is not a list");

  const seen = new Set<string>();
  return parsed.map((entry: unknown, index): LabelDeclaration => {
    const where = `entry ${String(index + 1)}`;
    if (typeof entry !== "object" || entry === null) throw invalid(`${where} is not a mapping`);
    const name = field(entry, "name");
    const color = field(entry, "color");
    const description = field(entry, "description");
    if (typeof name !== "string" || name === "") throw invalid(`${where} has no name`);
    if (typeof color !== "string" || !/^[0-9a-f]{6}$/.test(color)) {
      throw invalid(`${name}: color ${JSON.stringify(color)}`);
    }
    if (typeof description !== "string" || description.length > MAX_DESCRIPTION) {
      throw invalid(
        `${name}: a missing description, or one over ${String(MAX_DESCRIPTION)} characters`,
      );
    }
    if (seen.has(name)) throw invalid(`${name} is declared twice`);
    seen.add(name);
    return { name, color, description };
  });
}
