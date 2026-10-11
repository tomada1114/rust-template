"""Render a typed issue digest in its existing CLI output modes."""

from __future__ import annotations

import json
import sys
from typing import TYPE_CHECKING, Protocol

from issue_records import rank_records, tier_cell

if TYPE_CHECKING:
    from issue_types import DigestPayload, IssueRecord


class RenderOptions(Protocol):
    """Output flags accepted by the CLI's argparse namespace."""

    as_json: bool
    audit: bool
    select: int | None
    no_rank: bool
    rank_only: bool
    with_rank: bool
    detail_top: int
    detail: list[int]
    body_chars: int


def print_rank_table(ranked: list[IssueRecord]) -> None:
    """Print the ranked issue table."""
    print("## Priority ranking (label tier first, score breaks ties)\n")
    print("| issue | priority | score | readiness | signals |")
    print("|---|---|---|---|---|")
    for r in ranked:
        title = r["title"].replace("|", "\\|")
        if len(title) > 60:
            title = title[:59] + "…"
        reasons = " · ".join(r["score_reasons"]) or "—"
        print(
            f"| #{r['number']} {title} | {tier_cell(r)} | {r['priority_score']} | "
            f"{r['readiness']} | {reasons} |"
        )
    print()


def print_details(rows: list[IssueRecord], body_chars: int) -> None:
    """Print issue details in the established Markdown format."""
    for r in rows:
        flags = []
        if r["not_ready_labels"]:
            flags.append(f"NOT-READY-LABEL:{','.join(r['not_ready_labels'])}")
        if r["design_labels"]:
            flags.append(f"NEEDS-DESIGN:{','.join(r['design_labels'])}")
        if r["open_pr"]:
            flags.append(
                f"HAS-OPEN-PR:#{r['open_pr']['number']}"
                + ("(draft)" if r["open_pr"]["draft"] else "")
            )
        if r["depends_on_open"]:
            flags.append(
                "BLOCKED-BY:" + ",".join(f"#{n}" for n in r["depends_on_open"])
            )
        if r["unblocks_open"]:
            flags.append("UNBLOCKS:" + ",".join(f"#{n}" for n in r["unblocks_open"]))
        head = f"## #{r['number']} {r['title']}"
        if flags:
            head += "  ⟨" + " | ".join(flags) + "⟩"
        print(head)
        meta = [
            f"priority={tier_cell(r)}",
            f"score={r['priority_score']}",
            f"labels={r['labels'] or '-'}",
            f"updated={r['updated_at']}",
        ]
        if r["assignees"]:
            meta.append(f"assignees={r['assignees']}")
        if r["milestone"]:
            meta.append(f"milestone={r['milestone']}")
        if r["area"]:
            meta.append(f"area={r['area']}")
        if r["touches"]:
            meta.append("touches=" + ",".join(r["touches"]))
        if r["referenced_by_open"]:
            meta.append(
                "referenced-by=" + ",".join(f"#{n}" for n in r["referenced_by_open"])
            )
        if r["mentions"]:
            meta.append("mentions=" + ",".join(f"#{n}" for n in r["mentions"]))
        print("- " + " · ".join(meta))
        print(f"- {r['url']}")
        if r["body"]:
            print(f"\n{r['body']}\n")
        elif body_chars <= 0:
            print()
        else:
            print("\n_(empty body)_\n")


def render_json(payload: DigestPayload) -> int:
    """Write the stable JSON payload."""
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


def render_audit(payload: DigestPayload, coverage_line: str) -> int:
    """Report missing, partial and unknown contract fields."""
    records = payload["issues"]
    ccov = payload["contract_coverage"]
    print(
        f"contract: {ccov['full']}/{ccov['total']} complete · "
        f"{ccov['partial']} partial · {len(ccov['missing'])} missing"
    )
    if ccov["missing"]:
        print("missing: " + ",".join(f"#{n}" for n in ccov["missing"]))
    for num, fields in sorted(ccov["incomplete"].items(), key=lambda kv: int(kv[0])):
        print(f"partial: #{num} — no {','.join(fields)}")
    unknown = {
        r["number"]: r["contract"]["unknown_fields"]
        for r in records
        if r["contract"] and r["contract"]["unknown_fields"]
    }
    for issue_number, fields in sorted(unknown.items()):
        print(f"unknown-fields: #{issue_number} — {','.join(fields)}")
    print(coverage_line)
    return 0


def render_selection(
    payload: DigestPayload, args: RenderOptions, coverage_line: str, tracking_line: str
) -> int:
    """Show the selected issues and any requested ranking or details."""
    records = payload["issues"]
    ranked = rank_records(records)
    print(coverage_line)
    picks = [r for r in ranked if r["readiness"] == "READY"][: args.select]
    for i, r in enumerate(picks):
        print(
            f"{'select' if i == 0 else 'next  '}: #{r['number']} "
            f"[{tier_cell(r)}] {r['title']} "
            f"(score {r['priority_score']} · {' · '.join(r['score_reasons']) or '—'})"
        )
    if not picks:
        print("select: none — no READY issue matches the filter")
    if tracking_line:
        print(tracking_line)
    # Design-not-settled issues get their own line, not buried in `held:`
    # with dependency/label blocks — the reason to unblock them is
    # different (decide the design, not wait on something else).
    needs_design = [r for r in ranked if r["readiness"].startswith("DESIGN:")]
    if needs_design:
        print(
            "needs-design: "
            + ", ".join(f"#{r['number']}[{tier_cell(r)}]" for r in needs_design)
            + " — held until the design is settled (take one on by number or "
            "with --include-design)"
        )
    # Held issues explain why the pick is what it is; the top of that list
    # is where a merge will free something up, so 10 is plenty.
    held = [
        r
        for r in ranked
        if r["readiness"] != "READY" and not r["readiness"].startswith("DESIGN:")
    ]
    if held:
        more = f" (+{len(held) - 10} more)" if len(held) > 10 else ""
        print(
            "held: "
            + ", ".join(
                f"#{r['number']}[{tier_cell(r)}] {r['readiness']}" for r in held[:10]
            )
            + more
        )
    if args.with_rank:
        print()
        print_rank_table(ranked)
    detail_numbers = list(
        dict.fromkeys(
            [r["number"] for r in ranked if r["readiness"] == "READY"][
                : args.detail_top
            ]
            + args.detail
        )
    )
    if detail_numbers:
        by_number = {r["number"]: r for r in records}
        rows = [by_number[n] for n in detail_numbers if n in by_number]
        missing = [n for n in detail_numbers if n not in by_number]
        print()
        print_details(rows, args.body_chars)
        if missing:
            print("not-in-digest: " + ",".join(f"#{n}" for n in missing))
    return 0


def render_markdown(
    payload: DigestPayload, args: RenderOptions, coverage_line: str, tracking_line: str
) -> int:
    """Show the backlog table and full issue details."""
    records = payload["issues"]
    ranked = rank_records(records)

    print(f"# Open issues ({len(records)}) · open PRs ({payload['open_pr_count']})\n")
    if tracking_line:
        print(tracking_line + "\n")
    if not records:
        print("_No open issues match the filter._")
        return 0
    print(coverage_line + "\n")

    if not args.no_rank:
        print_rank_table(ranked)
        if args.rank_only:
            return 0

    print_details(payload["issues"], args.body_chars)
    return 0


def render_digest(payload: DigestPayload, args: RenderOptions) -> int:
    """Dispatch one output mode without fetching or changing records."""
    if args.as_json:
        return render_json(payload)
    records = payload["issues"]
    tracking = payload["tracking_issues"]

    cov = payload["label_coverage"]
    # `contract: N` only earns a slot on the line when some issue actually has
    # one — a repo that has not adopted the block should not read a running
    # complaint about it on every call.
    contract_part = (
        f" · contract: {cov['contract_ranked']}/{cov['total']}"
        if cov["contract_ranked"]
        else ""
    )
    if not records:
        coverage_line = "labels: 0/0 — no open issue matches the filter"
    elif cov["complete"]:
        tail = (
            "rank by label; no research pass needed"
            if not cov["unlabeled"]
            else "every tier is settled; "
            f"{len(cov['unlabeled'])} still need the label written "
            "(apply_priority_labels.py --backfill)"
        )
        coverage_line = (
            f"labels: {cov['labeled']}/{cov['total']}{contract_part} COMPLETE — {tail}"
        )
    else:
        shown = ",".join(f"#{n}" for n in cov["unranked"][:15])
        more = "…" if len(cov["unranked"]) > 15 else ""
        coverage_line = (
            f"labels: {cov['labeled']}/{cov['total']}{contract_part} — no tier: "
            f"{shown}{more} "
            "(~P<n> = suggested; write them with apply_priority_labels.py --backfill)"
        )

    tracking_line = (
        "tracking: "
        + ", ".join(f"#{n}" for n in sorted(tracking))
        + " — tracking issues, never ranked; ship their sub-issues"
        if tracking
        else ""
    )

    if args.audit:
        return render_audit(payload, coverage_line)
    if args.select is not None:
        return render_selection(payload, args, coverage_line, tracking_line)
    return render_markdown(payload, args, coverage_line, tracking_line)
