#!/usr/bin/env python3
"""file_followup.py -- File a follow-up issue found while shipping another one.

A shipping run turns up real defects that are not the issue being shipped:
a sibling of the bug just fixed, a latent gap the diff walked past, a scope
the implementation agent deliberately declined. Fixing them inline silently
widens the PR; dropping them loses them. This files them instead, so the
finding survives the run as a ranked backlog entry.

The tier label is resolved against what the repo *already uses*. A repo whose
convention is `p2` gets `p2`, not a second parallel `priority: P2` vocabulary
that would split its own backlog in two. This script never creates a label
definition: that is `just labels`' write, outside the remote writes invoking
shipping-issues authorizes. Every label the issue needs -- the tier, each
`--label`, `blocked: design`, `blocked: dependency` -- must already exist, or
nothing is filed and the missing names are reported (exit 4).

`--blocked-by` writes the edge where `triaging-issues` asks for it: a
`## Dependencies` section with one `Depends on #N` line per blocker (and a
`Blocks #N` line per `--blocks` number), plus the `blocked: dependency` label.
The ship contract repeats it for the next run's planner.

The target repo is resolved once and echoed on every line of output. This
script writes to GitHub from whatever directory it is invoked in, and a
sub-agent's cwd is not always the repo being shipped -- an unqualified `gh`
would happily file the finding against an unrelated repo that merely happens
to be the working directory. Pass `--repo` when in any doubt.

Usage:
    file_followup.py --title T --body-file F --tier P2 [--label L ...]
                     [--area SLUG] [--touches PATHS] [--blocked-by N,N]
                     [--blocks N,N] [--needs-design] [--found-while N]
                     [--repo OWNER/NAME]
                     [--dry-run] [--json]

`--needs-design` marks the new issue design-not-settled (`blocked: design` or
this repo's existing equivalent) -- use it only when the finding names an open
design question rather than a verified fix. See
references/filing-followups.md. `--tier` is still required even then, so the
issue ranks correctly the moment the design is decided.

Exit codes:
    0 = issue created (or --dry-run resolved cleanly)
    1 = usage/environment error
    2 = no write access to this repo -- report the finding in the run summary
        instead, and do not retry
    3 = invalid argument (unknown tier, missing body file)
    4 = a label the issue needs is not defined in this repo -- nothing was
        filed; next: check the spelling, then `just labels` (a remote write a
        human signs off), then re-run
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# Run from the .claude/skills mirror, a sibling import would leave __pycache__/
# there, which `just agents-check` reports as drift.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from issue_digest import (DEPENDENCY_BLOCK_LABELS, TIER_ALIASES, TIER_LABELS,
                          TIER_ORDER, normalize_label, resolve_design_label)

DEPENDENCY_LABEL = "blocked: dependency"
MISSING_LABEL_EXIT = 4

PERMISSION_MARKERS = ("HTTP 403", "Resource not accessible", "must have admin",
                      "does not have permission", "HTTP 404: Not Found")

# Set once in main(); every gh call is qualified with it so cwd cannot decide
# which repo a finding lands in.
REPO: str | None = None


def gh(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    if REPO:
        args = [*args, "--repo", REPO]
    try:
        return subprocess.run(["gh", *args], capture_output=True, text=True,
                              check=check, timeout=120)
    except FileNotFoundError:
        print("error: gh CLI not found", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.TimeoutExpired:
        print(f"error: gh {' '.join(args)} timed out", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr or ""
        if any(m in stderr for m in PERMISSION_MARKERS):
            print(f"verdict: NO_WRITE_ACCESS\nerror: gh {' '.join(args)}:\n{stderr}",
                  file=sys.stderr)
            raise SystemExit(2)
        print(f"error: gh {' '.join(args)} failed:\n{stderr}", file=sys.stderr)
        raise SystemExit(1)


def repo_labels() -> list[str]:
    raw = gh(["label", "list", "--limit", "500", "--json", "name"]).stdout or "[]"
    return [lbl["name"] for lbl in json.loads(raw)]


def resolve_existing(canonical: str, alias_keys: set[str],
                     existing: list[str]) -> str | None:
    """The name this repo uses for `canonical`, or None when it has neither
    the canonical name nor an alias (`alias_keys` are normalize_label() keys).

    Picking an alias the repo already carries is the whole point --
    `issue_digest.py` ranks by whatever spelling is present, so introducing a
    second one would leave half the backlog ranked by a label nobody else
    writes. Shortest alias wins: `p2` over `priority: medium` when a repo has
    drifted into carrying both, since the shorter form is the one being typed.
    """
    by_norm = {normalize_label(name): name for name in existing}
    if normalize_label(canonical) in by_norm:
        return by_norm[normalize_label(canonical)]
    aliases = [name for norm, name in by_norm.items() if norm in alias_keys]
    return min(aliases, key=lambda n: (len(n), n)) if aliases else None


def resolve_tier_label(tier: str, existing: list[str]) -> str | None:
    """The label name this repo uses for `tier`, or None when it has none."""
    keys = {norm for norm, t in TIER_ALIASES.items() if t == tier}
    return resolve_existing(TIER_LABELS[tier][0], keys, existing)


def dependency_section(args: Any) -> str:
    """The `## Dependencies` section `triaging-issues` defines, or "" when the
    finding has no edge. One `Depends on #N` / `Blocks #N` per line: that is
    the spelling issue_digest.py and the issue forms parse."""
    lines = [f"Depends on #{n}" for n in re.findall(r"\d+", args.blocked_by or "")]
    lines += [f"Blocks #{n}" for n in re.findall(r"\d+", args.blocks or "")]
    return "## Dependencies\n\n" + "\n".join(lines) if lines else ""


def ship_contract(args: Any) -> str:
    """The `<!-- ship: ... -->` block for a newly filed issue.

    Written on every issue this skill files, because the alternative is a later
    run re-deriving these facts from the prose -- which is exactly the cost the
    block exists to remove. `blocked-by` and `touches` are always emitted, even
    as `none` and `*`: an omitted field is indistinguishable from an unconsidered
    one, and `issue_digest.py --audit` has to be able to tell those apart.

    Kept in sync with issue_digest.parse_ship_contract; both sides treat unknown
    fields as ignorable, so adding one here does not break an older reader.
    """
    def numbers(value: str | None) -> str:
        nums = re.findall(r"\d+", value or "")
        return ",".join(f"#{n}" for n in nums) if nums else "none"

    fields = [f"tier={args.tier}"]
    if args.area:
        fields.append(f"area={args.area}")
    fields.append(f"blocked-by={numbers(args.blocked_by)}")
    if args.blocks:
        fields.append(f"blocks={numbers(args.blocks)}")
    touches = ",".join(t.strip() for t in (args.touches or "*").split(",") if t.strip())
    fields.append(f"touches={touches or '*'}")
    fields.append("design=" + ("open" if args.needs_design else "settled"))
    return "<!-- ship: " + " ".join(fields) + " -->"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--title", required=True,
                   help="issue title; follow the repo's commit/title convention")
    p.add_argument("--body-file", required=True, type=Path,
                   help="path to the issue body (write it to a file first)")
    p.add_argument("--tier", required=True, choices=TIER_ORDER,
                   help="priority tier for the finding, per references/priority-rubric.md")
    p.add_argument("--label", action="append", default=[], metavar="NAME",
                   help="extra label, such as the type label (repeatable); it must "
                        "exist in the repo, or nothing is filed (exit 4)")
    p.add_argument("--needs-design", action="store_true",
                   help="mark the new issue design-not-settled (blocked: "
                        "design or this repo's equivalent) -- excludes it "
                        "from automatic selection until the design is decided")
    p.add_argument("--area", metavar="SLUG",
                   help="the part of the codebase this belongs to; goes into "
                        "the issue's ship contract")
    p.add_argument("--touches", metavar="PATHS",
                   help="comma-separated paths the fix will land in, or '*' if "
                        "genuinely unknown. This is what lets a later run group "
                        "this issue for parallel work without judging it -- an "
                        "omitted value reads as 'touches nothing', which is why "
                        "'*' exists to say the honest thing instead")
    p.add_argument("--blocked-by", metavar="NUMBERS",
                   help="comma-separated issue numbers this waits on; writes a "
                        "Depends on #N line each and the blocked: dependency label")
    p.add_argument("--blocks", metavar="NUMBERS",
                   help="comma-separated issue numbers waiting on this")
    p.add_argument("--found-while", type=int, metavar="N",
                   help="issue number this was found while shipping; appends a "
                        "provenance line to the body")
    p.add_argument("--repo", metavar="OWNER/NAME",
                   help="target repo; defaults to the one cwd resolves to. Pass "
                        "it explicitly when cwd may not be the repo being shipped")
    p.add_argument("--dry-run", action="store_true",
                   help="resolve labels and print what would be filed")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    args = p.parse_args()

    # Resolve before any other gh call, and echo it, so cwd can never quietly
    # decide which repo a finding lands in. `gh repo view` takes the repo as a
    # positional, not --repo, so this one call bypasses the gh() wrapper.
    global REPO
    view = ["gh", "repo", "view"] + ([args.repo] if args.repo else [])
    proc = subprocess.run([*view, "--json", "nameWithOwner", "-q", ".nameWithOwner"],
                          capture_output=True, text=True, timeout=120)
    REPO = (proc.stdout or "").strip()
    if proc.returncode != 0 or not REPO:
        target = args.repo or "the current directory"
        print(f"error: cannot resolve {target} -- run inside the repo or pass "
              f"--repo OWNER/NAME\n{(proc.stderr or '').strip()}", file=sys.stderr)
        return 1

    if not args.body_file.is_file():
        print(f"error: --body-file not found: {args.body_file}", file=sys.stderr)
        return 3
    body = args.body_file.read_text(encoding="utf-8").strip()
    if not body:
        print(f"error: --body-file is empty: {args.body_file}", file=sys.stderr)
        return 3
    dependencies = dependency_section(args)
    if dependencies:
        body += "\n\n" + dependencies
    if args.found_while:
        body += f"\n\n---\n\n*Found while shipping #{args.found_while}.*\n"
    contract = ship_contract(args)
    body += "\n" + contract + "\n"

    # Every label is resolved before anything is written, and a missing one
    # stops the filing: an issue filed without its type or blocked: label reads
    # as triaged when it is not, and creating the definition is not ours to do.
    existing = repo_labels()
    labels, missing = [], []

    def need(name: str | None, wanted: str) -> None:
        if name:
            labels.append(name)
        else:
            missing.append(wanted)

    need(resolve_tier_label(args.tier, existing), TIER_LABELS[args.tier][0])
    if args.needs_design:
        design_label, absent = resolve_design_label(existing)
        need(None if absent else design_label, design_label)
    if re.search(r"\d", args.blocked_by or ""):
        need(resolve_existing(DEPENDENCY_LABEL, DEPENDENCY_BLOCK_LABELS, existing),
             DEPENDENCY_LABEL)
    by_norm = {normalize_label(n): n for n in existing}
    for name in args.label:
        need(by_norm.get(normalize_label(name)), name)
    labels = list(dict.fromkeys(labels))

    if missing:
        print(f"error: label(s) not defined in {REPO}: {', '.join(missing)} -- "
              "nothing was filed\n"
              "next: check the spelling against .github/labels.yml; a declared "
              "label missing here needs `just labels`, a remote write a human "
              "signs off (AGENTS.md > Security and human approval). Until then, "
              "report the finding instead of filing it.", file=sys.stderr)
        return MISSING_LABEL_EXIT

    if args.dry_run:
        out = {"dry_run": True, "repo": REPO, "title": args.title,
               "labels": labels, "contract": contract,
               "dependencies": dependencies, "body_chars": len(body)}
        # The contract is shown, not just counted: a dry run exists to be read
        # before the write, and the contract is the half of the body a caller is
        # most likely to have got wrong.
        print(json.dumps(out, ensure_ascii=False) if args.json
              else f"would file in {REPO}: {args.title}\n  labels: {', '.join(labels)}"
                   + f"\n  contract: {contract}"
                   + (f"\n  dependencies: {'; '.join(dependencies.splitlines()[2:])}"
                      if dependencies else ""))
        return 0

    # gh reads the body from a file so no shell quoting can mangle it.
    tmp = args.body_file.with_suffix(args.body_file.suffix + ".filed")
    tmp.write_text(body, encoding="utf-8")
    try:
        cmd = ["issue", "create", "--title", args.title, "--body-file", str(tmp)]
        for name in labels:
            cmd += ["--label", name]
        # gh prints the new issue's URL last; anything else means it changed
        # its output and the caller must not be told a URL that is not there.
        lines = [ln.strip() for ln in (gh(cmd).stdout or "").splitlines() if ln.strip()]
        if not lines:
            print("error: gh issue create produced no output; check the repo "
                  "manually before re-running (it may have been filed)",
                  file=sys.stderr)
            return 1
        url = lines[-1]
    finally:
        tmp.unlink(missing_ok=True)

    if args.json:
        print(json.dumps({"url": url, "repo": REPO, "labels": labels},
                         ensure_ascii=False))
    else:
        print(f"filed: {url}  [{', '.join(labels)}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
