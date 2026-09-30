#!/usr/bin/env python3
"""apply_priority_labels.py -- Write the `priority: P0..P3` labels this skill ranks by.

The tier label is the backlog's persisted priority. Once every open issue
carries one, `issue_digest.py` orders the backlog by reading labels, and no
model has to re-read issue prose to re-derive priority on the next run.

Two ways to write them, both cheap for the caller:

  --backfill        every open issue without a tier label gets one: the tier
                    its ship contract declares, or the digest's suggested
                    one. Pure heuristic, no model involved, one summary line out.
  --set N=P0 ...    explicit assignments, for the handful the research pass in
                    references/priority-rubric.md judged differently. Run by the
                    triage sub-agent that did the judging, not by the parent.

Applying a tier removes any other tier label the issue carries, including
legacy spellings like `critical` or `priority/high`, so an issue always ends
with exactly one.

This script applies labels and never creates a label definition: creating one
is `just labels`' write, outside the remote writes invoking shipping-issues
authorizes. Every label a call would apply is checked before the first write;
a missing one stops the call with nothing written (exit 4).

Usage:
    apply_priority_labels.py --backfill [--quiet] [--dry-run] [--json]
    apply_priority_labels.py --set 12=P0 [--set 9=P2 ...] [--quiet] [--dry-run]
    apply_priority_labels.py --set-design 12 [--set-design 9 ...] [--dry-run]
    apply_priority_labels.py --clear-design 12 [--dry-run]
    apply_priority_labels.py --clear-dependency 12 [--clear-dependency 9 ...] [--dry-run]
    apply_priority_labels.py --check-labels

`--set-design`/`--clear-design` mark or clear the soft "design not settled"
block that excludes an issue from automatic selection -- see
references/dependency-triage.md. The block has two forms, and issue_digest.py
honors either: the label (`blocked: design` or a recognized equivalent) and a
`design=open` field in the body's `<!-- ship: ... -->` contract.
`--set-design` writes only the label; `--clear-design` clears both, rewriting
`design=open` to `design=settled` and leaving the rest of the body as it was.
Independent of the tier machinery above; tier and design-readiness are
orthogonal.

`--clear-dependency` removes a dependency-block label (`blocked: dependency`
or a recognized equivalent) once issue_digest.py reports every dependency the
issue records as closed -- see its `stale_dependency_labels` field and
references/dependency-triage.md. Readiness never reads this label; clearing it
only corrects what a human reading the backlog sees. It may be combined with
--set-design/--clear-design in one call, but not with --backfill/--set/
--check-labels.

`--check-labels` only reports whether the four tier labels exist.

Exit codes:
    0 = labels applied (possibly zero changes)
    1 = gh invocation failed
    2 = no write access to this repo -- labels cannot be used here; rank from the
        digest's suggested tiers instead and do not retry
    3 = invalid argument (unknown tier, unparsable --set)
    4 = a label this call would apply is not defined in the repo -- nothing was
        written; next: `just labels` (a remote write a human signs off), then
        re-run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# Run from the .claude/skills mirror, a sibling import would leave __pycache__/
# there, which `just agents-check` reports as drift.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from issue_digest import (CONTRACT_FIELD_RE, DEPENDENCY_BLOCK_LABELS, DESIGN_BLOCK_LABELS,
                          SHIP_CONTRACT_RE, TIER_ALIASES, TIER_LABELS, TIER_ORDER,
                          normalize_label, parse_ship_contract, resolve_design_label)

DIGEST = Path(__file__).resolve().parent / "issue_digest.py"

# gh prints these when the token lacks push access; the caller must stop asking
# for labels rather than retry.
PERMISSION_MARKERS = ("HTTP 403", "Resource not accessible", "must have admin",
                      "does not have permission", "HTTP 404: Not Found")


def gh(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
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


def load_digest() -> dict[str, Any]:
    """Open issues with their tiers and suggestions -- bodies deliberately omitted."""
    proc = subprocess.run(
        [sys.executable, str(DIGEST), "--json", "--body-chars", "0"],
        capture_output=True, text=True, timeout=180,
    )
    if proc.returncode != 0:
        print(f"error: issue_digest.py failed:\n{proc.stderr}", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(proc.stdout)


MISSING_LABEL_EXIT = 4


def missing_tier_labels(tiers: list[str]) -> list[str]:
    """The canonical tier labels among `tiers` this repo does not define.
    GitHub matches label names without regard to case, and so does this."""
    existing = {name.lower() for name in repo_labels()}
    return [TIER_LABELS[t][0] for t in dict.fromkeys(tiers)
            if TIER_LABELS[t][0].lower() not in existing]


def stop_on_missing(missing: list[str]) -> None:
    """Exit 4, naming `just labels` as the next step, when `missing` is not empty."""
    if not missing:
        return
    print(f"verdict: MISSING_LABELS\nerror: not defined in this repo: "
          f"{', '.join(missing)} -- nothing was written\n"
          "next: `just labels` creates the labels .github/labels.yml declares; it "
          "is a remote write a human signs off (AGENTS.md > Security and human "
          "approval). Report this and re-run once it has run.", file=sys.stderr)
    raise SystemExit(MISSING_LABEL_EXIT)


def parse_sets(pairs: list[str]) -> dict[int, str]:
    out: dict[int, str] = {}
    for pair in pairs:
        num, _, tier = pair.partition("=")
        tier = tier.strip().upper()
        if not num.strip().lstrip("#").isdigit() or tier not in TIER_ORDER:
            print(f"error: --set expects N=P0|P1|P2|P3, got {pair!r}", file=sys.stderr)
            raise SystemExit(3)
        out[int(num.strip().lstrip("#"))] = tier
    return out


def repo_labels() -> list[str]:
    raw = gh(["label", "list", "--limit", "500", "--json", "name"]).stdout or "[]"
    return [lbl["name"] for lbl in json.loads(raw)]


def issue_labels(number: int) -> list[str]:
    raw = gh(["issue", "view", str(number), "--json", "labels"]).stdout or "{}"
    return [lbl["name"] for lbl in json.loads(raw).get("labels", [])]


def design_label() -> str:
    """The design-not-settled label this repo defines (or an equivalent);
    exits 4 when it has neither."""
    name, absent = resolve_design_label(repo_labels())
    stop_on_missing([name] if absent else [])
    return name


def set_design(number: int, name: str, dry_run: bool) -> str:
    """Add the design-not-settled label `name` (from design_label()) to an
    issue. Returns the label name used. Idempotent: re-applying to an issue that
    already carries it is a no-op add.
    """
    if not dry_run:
        gh(["issue", "edit", str(number), "--add-label", name])
    return name


def clear_labels_in(number: int, label_set: set[str], dry_run: bool) -> list[str]:
    """Remove whichever label(s) in `label_set` (normalize_label() keys) the
    issue actually carries. Returns the label names removed -- empty when the
    issue carried none, which is success, not an error."""
    carried = [lbl for lbl in issue_labels(number)
              if normalize_label(lbl) in label_set]
    if carried and not dry_run:
        args = ["issue", "edit", str(number)]
        for lbl in carried:
            args += ["--remove-label", lbl]
        gh(args)
    return carried


# How issue_digest.py names a contract's `design=open` among an issue's
# design_labels, so a caller reads one vocabulary for both forms of the block.
CONTRACT_DESIGN_MARKER = "ship:design=open"


def settle_contract_design(body: str) -> str | None:
    """`body` with its ship contract's `design=open` rewritten to
    `design=settled`, or None when there is nothing to settle: no contract, no
    `design=` field, or one parse_ship_contract() already reads as settled.

    Only the value of a `design=open` field inside a `<!-- ship: ... -->` block
    changes; the key's spelling, the spacing, every other field, and the prose
    around the block are kept byte for byte. Every such field is rewritten, not
    only the one the parser's last-block-wins rule reads, so no stale `open`
    is left for a human to misread."""
    contract = parse_ship_contract(body)
    if not contract or contract["design"] != "open":
        return None

    def settle_field(field: re.Match[str]) -> str:
        if field.group(1).lower() != "design" or field.group(2).lower() != "open":
            return field.group(0)
        return field.group(0)[: field.start(2) - field.start(0)] + "settled"

    def settle_block(block: re.Match[str]) -> str:
        inner = CONTRACT_FIELD_RE.sub(settle_field, block.group(1))
        return (block.group(0)[: block.start(1) - block.start(0)] + inner
                + block.group(0)[block.end(1) - block.start(0):])

    return SHIP_CONTRACT_RE.sub(settle_block, body)


def clear_design(number: int, dry_run: bool) -> list[str]:
    """Clear both forms of the design block: remove whichever design-block
    label(s) the issue carries, and settle a `design=open` field in its ship
    contract (see settle_contract_design), in one `gh issue edit`.

    Returns what was cleared: the label names, plus CONTRACT_DESIGN_MARKER when
    the contract was rewritten. Empty when the issue carried neither, which is
    success, not an error (this is the routine call after a design is decided,
    and the issue may have been taken on with --include-design instead of ever
    being labeled).

    `design=settled` never clears a label (issue_digest.py's invariant): the
    label goes because this call was made, not because of what the body says.
    The body is read and written back whole, so an edit made to it between the
    two is overwritten; the window is one gh round trip."""
    raw = gh(["issue", "view", str(number), "--json", "labels,body"]).stdout or "{}"
    issue = json.loads(raw)
    carried = [lbl["name"] for lbl in issue.get("labels", [])
               if normalize_label(lbl["name"]) in DESIGN_BLOCK_LABELS]
    settled = settle_contract_design(issue.get("body") or "")
    cleared = carried + ([CONTRACT_DESIGN_MARKER] if settled is not None else [])
    if not cleared or dry_run:
        return cleared
    args = ["issue", "edit", str(number)]
    for lbl in carried:
        args += ["--remove-label", lbl]
    if settled is None:
        gh(args)
        return cleared
    # gh reads the body from a file so no shell quoting can mangle it, and
    # newline="" keeps a web-edited body's CRLF line endings as they were.
    fd, path = tempfile.mkstemp(prefix=f"clear-design-{number}-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(settled)
        gh([*args, "--body-file", path])
    finally:
        Path(path).unlink(missing_ok=True)
    return cleared


def clear_dependency(number: int, dry_run: bool) -> list[str]:
    """Remove whichever dependency-block label(s) the issue actually carries.
    Returns the label names removed -- empty when the issue carried none, which
    is success, not an error (this is the routine call after issue_digest.py
    has reported the issue's dependencies as all closed, via its
    `stale_dependency_labels` field)."""
    return clear_labels_in(number, DEPENDENCY_BLOCK_LABELS, dry_run)


def apply(number: int, tier: str, current_labels: list[str], dry_run: bool) -> bool:
    """Add the tier label to an issue and strip any other tier it carries.

    Returns False when the issue already carries exactly that label.
    """
    target = TIER_LABELS[tier][0]
    stale = [lbl for lbl in current_labels
             if normalize_label(lbl) in TIER_ALIASES and lbl != target]
    if target in current_labels and not stale:
        return False
    args = ["issue", "edit", str(number), "--add-label", target]
    for lbl in stale:
        args += ["--remove-label", lbl]
    if not dry_run:
        gh(args)
    return True


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--backfill", action="store_true",
                   help="label every open issue that has no tier yet")
    p.add_argument("--set", action="append", default=[], metavar="N=TIER",
                   help="assign a tier explicitly, e.g. --set 12=P0")
    p.add_argument("--set-design", action="append", default=[], type=int,
                   metavar="N",
                   help="mark an issue design-not-settled (repeatable); "
                        "excludes it from automatic selection until cleared")
    p.add_argument("--clear-design", action="append", default=[], type=int,
                   metavar="N",
                   help="clear the design-not-settled block once the design "
                        "is decided (repeatable): remove the label and settle "
                        "the ship contract's design=open; a no-op if neither "
                        "is present")
    p.add_argument("--clear-dependency", action="append", default=[], type=int,
                   metavar="N",
                   help="remove the dependency-block label once every "
                        "dependency has closed (repeatable); a no-op if not "
                        "present")
    p.add_argument("--check-labels", action="store_true",
                   help="only report whether the four tier labels exist "
                        "(exit 4 when one is missing)")
    p.add_argument("--dry-run", action="store_true",
                   help="print the plan without touching GitHub")
    p.add_argument("--quiet", action="store_true",
                   help="print only the summary line, not one line per issue")
    p.add_argument("--json", action="store_true", dest="as_json")
    args = p.parse_args()

    if not (args.backfill or args.set or args.set_design or args.clear_design
            or args.clear_dependency or args.check_labels):
        p.error("one of --backfill, --set, --set-design, --clear-design, "
                "--clear-dependency, or --check-labels is required")
    if (args.set_design or args.clear_design or args.clear_dependency) and \
            (args.backfill or args.set or args.check_labels):
        p.error("--set-design/--clear-design/--clear-dependency run standalone "
                "-- combine with --backfill, --set, or --check-labels in "
                "separate calls")
    if not shutil.which("gh"):
        print("error: gh CLI not found", file=sys.stderr)
        return 1

    # Design-block and dependency-block state are independent of the tier
    # machinery below -- no digest fetch needed.
    if args.set_design or args.clear_design or args.clear_dependency:
        name = design_label() if args.set_design else ""
        design_set = [(n, set_design(n, name, args.dry_run))
                      for n in dict.fromkeys(args.set_design)]
        design_cleared = [(n, clear_design(n, args.dry_run))
                          for n in dict.fromkeys(args.clear_design)]
        dependency_cleared = [(n, clear_dependency(n, args.dry_run))
                              for n in dict.fromkeys(args.clear_dependency)]
        if args.as_json:
            json.dump({"verdict": "OK", "dry_run": args.dry_run,
                      "design_set": [{"number": n, "label": lbl} for n, lbl in design_set],
                      "design_cleared": [{"number": n, "removed": removed}
                                         for n, removed in design_cleared],
                      "dependency_cleared": [{"number": n, "removed": removed}
                                             for n, removed in dependency_cleared]},
                      sys.stdout, ensure_ascii=False, indent=2)
            print()
        else:
            verb = "would set" if args.dry_run else "set"
            for n, lbl in design_set:
                print(f"#{n}: needs-design -> {lbl}")
            for n, removed in design_cleared:
                print(f"#{n}: needs-design cleared ({', '.join(removed)})" if removed
                      else f"#{n}: needs-design already clear")
            for n, removed in dependency_cleared:
                print(f"#{n}: dependency-block cleared" if removed
                      else f"#{n}: dependency-block already clear")
            print(f"verdict: OK\ndesign-{verb}: {len(design_set)} | "
                  f"design-cleared: {len(design_cleared)} | "
                  f"dependency-cleared: {len(dependency_cleared)}")
        return 0

    if args.check_labels and not (args.backfill or args.set):
        stop_on_missing(missing_tier_labels(TIER_ORDER))
        print("verdict: OK\nmissing-labels: none (all four exist)")
        return 0

    payload = load_digest()
    issues = {r["number"]: r for r in payload["issues"]}

    plan: list[tuple[int, str, str]] = []  # number, tier, why
    if args.backfill:
        for rec in payload["issues"]:
            if rec["priority_tier"]:
                continue
            # A tier the author declared in the issue's ship contract is a
            # settled decision, and writing the heuristic guess over it would
            # replace a human's answer with a score -- the one thing a backfill
            # must never do. The label still gets written, so the tier ends up
            # where every later run reads it; it is just the author's tier.
            if rec.get("contract_tier"):
                plan.append((rec["number"], rec["contract_tier"], "ship contract"))
            else:
                plan.append((rec["number"], rec["suggested_tier"], rec["suggested_reason"]))
    for number, tier in parse_sets(args.set).items():
        plan = [row for row in plan if row[0] != number]
        plan.append((number, tier, "explicit"))

    # Checked before the first write, so a missing label never leaves the
    # backlog half-labeled.
    if plan:
        stop_on_missing(missing_tier_labels([tier for _, tier, _ in plan]))

    changed, unchanged, missing = [], [], []
    for number, tier, why in sorted(plan):
        rec = issues.get(number)
        if rec is None:
            # Not in the open-issue digest: closed, or filtered out. Still label
            # it -- an explicit --set on a just-closed issue is not an error.
            missing.append(number)
            if apply(number, tier, [], args.dry_run):
                changed.append((number, tier, why, "not-open"))
            continue
        if apply(number, tier, rec["labels"], args.dry_run):
            changed.append((number, tier, why, rec["priority_tier"] or "none"))
        else:
            unchanged.append(number)

    verb = "would set" if args.dry_run else "set"
    breakdown = " ".join(
        f"{t}={sum(1 for _, tier, _, _ in changed if tier == t)}"
        for t in TIER_ORDER if any(tier == t for _, tier, _, _ in changed)
    )
    if args.as_json:
        json.dump({"verdict": "OK", "dry_run": args.dry_run,
                   "changed": [{"number": n, "tier": t, "why": w, "was": was}
                               for n, t, w, was in changed],
                   "unchanged": unchanged, "not_open": missing},
                  sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    if not args.quiet:
        for number, tier, why, was in changed:
            print(f"#{number}: {was} -> {TIER_LABELS[tier][0]}  ({why})")

    coverage = payload["label_coverage"]
    # Only issues that had no tier at all move the coverage number; a re-tier of
    # an already-labeled issue does not, and a closed one is not counted here.
    after = coverage["labeled"] + sum(1 for _, _, _, was in changed if was == "none")
    print(f"verdict: OK\n"
          f"{verb}: {len(changed)}{f' ({breakdown})' if breakdown else ''} | "
          f"already-correct: {len(unchanged)} | "
          f"coverage: {min(after, coverage['total'])}/{coverage['total']} open issues labeled")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
