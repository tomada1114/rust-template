/**
 * Creates or updates this repository's GitHub labels from `.github/labels.yml` (`just
 * labels`). It never deletes a label the manifest does not mention, so a
 * repository-local label survives running it. Needs `gh`, authenticated against the
 * repository it resolves (`gh repo view`); a human's step, never run by CI or a hook.
 *
 * Errors: ERR_LABELS_MANIFEST (see scripts/lib/labels.ts), ERR_LABELS_GH.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ScriptError } from "./lib/fail.ts";
import { parseLabelManifest, type LabelDeclaration } from "./lib/labels.ts";
import { runScript, type ScriptContext } from "./lib/script.ts";

const MANIFEST = ".github/labels.yml";

export interface LabelAction {
  readonly kind: "create" | "update";
  readonly label: LabelDeclaration;
}

/** What it takes to make the repository match the manifest, in manifest order. */
export function diffLabels(
  manifest: readonly LabelDeclaration[],
  remote: readonly LabelDeclaration[],
): LabelAction[] {
  const byName = new Map(remote.map((label) => [label.name, label]));
  return manifest.flatMap((label): LabelAction[] => {
    const existing = byName.get(label.name);
    if (existing === undefined) return [{ kind: "create", label }];
    const same =
      existing.color.toLowerCase() === label.color && existing.description === label.description;
    return same ? [] : [{ kind: "update", label }];
  });
}

function gh(context: ScriptContext, args: readonly string[]): string {
  const result = context.run("gh", args, { cwd: context.root });
  if (result.status !== 0) {
    throw new ScriptError({
      code: "ERR_LABELS_GH",
      summary: `\`gh ${args.slice(0, 3).join(" ")}\` failed`,
      expected: "the GitHub CLI on PATH, authenticated with write access to this repository",
      actual: result.stderr.trim() || `exit status ${String(result.status)}`,
      next: "run `gh auth status` and confirm this checkout has a GitHub remote",
    });
  }
  return result.stdout;
}

function remoteLabels(context: ScriptContext, repo: string): LabelDeclaration[] {
  const args = [
    "label",
    "list",
    "--repo",
    repo,
    "--limit",
    "200",
    "--json",
    "name,color,description",
  ];
  const rows: unknown = JSON.parse(gh(context, args));
  if (!Array.isArray(rows)) {
    throw new ScriptError({
      code: "ERR_LABELS_GH",
      summary: "`gh label list` did not return a list",
      expected: "a JSON array of labels",
      actual: JSON.stringify(rows).slice(0, 200),
      next: "update the GitHub CLI, then run `just labels` again",
    });
  }
  return rows.map((row: Partial<Record<keyof LabelDeclaration, string>>) => ({
    name: row.name ?? "",
    color: row.color ?? "",
    description: row.description ?? "",
  }));
}

export function main(context: ScriptContext): void {
  let text: string;
  try {
    text = readFileSync(join(context.root, MANIFEST), "utf8");
  } catch {
    throw new ScriptError({
      code: "ERR_LABELS_MANIFEST",
      summary: `${MANIFEST} cannot be read`,
      expected: `a committed ${MANIFEST}`,
      actual: "no such file",
      next: `restore ${MANIFEST} from version control`,
    });
  }
  const manifest = parseLabelManifest(text);
  const repo = gh(context, [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).trim();
  const actions = diffLabels(manifest, remoteLabels(context, repo));

  for (const { kind, label } of actions) {
    const verb = kind === "create" ? "create" : "edit";
    gh(context, [
      "label",
      verb,
      label.name,
      "--repo",
      repo,
      "--color",
      label.color,
      "--description",
      label.description,
    ]);
    context.log(`labels: ${kind === "create" ? "created" : "updated"} ${label.name}`);
  }
  const created = actions.filter((action) => action.kind === "create").length;
  context.log(
    `labels: ${repo} matches ${MANIFEST} (${String(created)} created, ${String(actions.length - created)} updated)`,
  );
}

if (import.meta.main) await runScript(main);
