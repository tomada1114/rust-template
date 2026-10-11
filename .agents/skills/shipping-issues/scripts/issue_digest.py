#!/usr/bin/env python3
"""issue_digest.py — Priority- and dependency-annotated digest of open GitHub issues.

Fetches open issues (and open PRs, to detect work already in flight) via the
`gh` CLI and prints a token-lean digest. Raw `gh --json` output never has to
enter a context window.

Beyond the mechanical readiness flags (BLOCKED-BY / HAS-OPEN-PR /
NOT-READY-LABEL) it computes three things the ordering decision needs:

  * reverse dependency edges — how many *other* open issues this one unblocks,
    which is the single strongest "do this first" signal;
  * a heuristic priority score built from unblock count, priority labels,
    leverage keywords (CI, schema, interface, security, breakage…), milestone,
    and staleness;
  * a priority *tier* — the `priority: P0`…`P3` label if the issue already
    carries one (or a recognized equivalent), otherwise a suggested tier derived
    from the score, printed as `~P1`.

**The label is the persisted ranking.** A labeled backlog is ranked by reading
labels alone — no issue prose has to be re-analyzed on every run. Suggested
tiers exist to be written back by `apply_priority_labels.py`, after which they
become confirmed ones. The score survives as the within-tier tie-breaker and as
the input to those suggestions; it is a *ranking hint*, not a verdict, and is
computed from raw issue bodies even when `--body-chars 0` keeps that prose out
of the caller's context. Confirm suggested tiers against
references/priority-rubric.md before acting on them.

An issue can also state these facts outright instead of leaving them to be
inferred, in a `<!-- ship: ... -->` block (see parse_ship_contract): the tier,
what it waits on, what it blocks, and which paths it touches. A declared tier
is settled, not suggested; declared paths are what make the parallel-grouping
decision a set intersection rather than a guess.

Usage:
    issue_digest.py [--label L]... [--assignee A] [--milestone M]
                    [--issue N]... [--limit N] [--body-chars N]
                    [--rank-only] [--select N] [--with-rank]
                    [--detail N]... [--detail-top K] [--no-rank]
                    [--audit] [--cache-ttl S] [--refresh] [--json]
    issue_digest.py --issues-file PATH --prs-file PATH [the flags above, except
                    --label/--assignee/--milestone]

Output (default: markdown). `--json` emits the same data as a JSON object for
programmatic consumers.

`--select` composes: `--with-rank` appends the ranking table and
`--detail`/`--detail-top` append issue bodies, so a run's whole startup question
is one call. `--issue` narrows what is ranked; `--detail` does not.

The `gh` fetch can be cached under the repo's run-state directory, keyed on the
arguments that change what `gh` returns — but `--cache-ttl` defaults to 0, so it
is off unless a caller asks for it. `plan.py` asks for 300 seconds because a
startup's calls are seconds apart; anything reading the backlog after this run
has changed it should not. That is the safe default: a stale digest can re-select
an issue this run already merged, and nothing downstream would notice.

An issue labelled `tracking` (or `epic`) is a checklist of sub-issues, not work:
it is dropped before ranking, never tiered, and listed on a `tracking:` line
(`tracking_issues` in --json) so the caller ships its sub-issues instead.

`--limit` caps how many open issues are read, and a backlog larger than it is
an error rather than a silently truncated ranking: a dependency on an issue past
the cap would read as closed. Open PRs are read up to PR_LIMIT (1000) the same
way. `--label`, `--assignee` and `--milestone` narrow what is ranked, never the
set of open issues dependency edges and blocker state are read from.

`--issues-file` and `--prs-file` (always together) rank REST JSON the caller
fetched itself — `gh api --paginate --slurp` output of the open-issues and
open-pulls endpoints, an array or an array of page arrays — instead of calling
the GraphQL-backed `gh issue list` / `gh pr list`, which a Claude Code cloud
session's GitHub proxy refuses. File mode starts no `gh` process, does not need
`gh` on PATH, skips the fetch cache, drops issues-file items carrying
`pull_request`, and applies `--limit` to the first N issues in file order. The
server-side filters `--label`/`--assignee`/`--milestone` do not apply to it.

Exit codes:
    0 = digest printed (may contain zero issues)
    1 = gh invocation failed, the open backlog is larger than --limit, there
        are more open PRs than PR_LIMIT, or an --issues-file/--prs-file could
        not be read (`error: <path>: <reason>`)
    2 = flag misuse (only one of --issues-file/--prs-file, or either combined
        with --label/--assignee/--milestone; --limit below 1 without them)
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from issue_records import (
    _BACKTICK_RUN_RE,
    _CONTRACT_KEY,
    _FENCE_OPEN_RE,
    _HTML_COMMENT_OPEN_RE,
    _LIST_ITEM_RE,
    _REF_LIST,
    BARE_REF_RE,
    CLOSING_RE,
    CONTRACT_FIELD_RE,
    CONTRACT_KNOWN_FIELDS,
    CONTRACT_REQUIRED_FIELDS,
    DEP_PATTERNS,
    DEPENDENCY_BLOCK_LABELS,
    DESIGN_BLOCK_LABELS,
    DESIGN_LABEL,
    FOUNDATION_LEVERAGE,
    FRESH_DAYS,
    LEVERAGE_CAP,
    LEVERAGE_RULES,
    NETWORK_SCHEMES,
    PR_LIMIT,
    PRIORITY_LABEL_WEIGHTS,
    READY_NEGATIVE_LABELS,
    REFERENCE_CAP,
    SHIP_CONTRACT_RE,
    SLUG_RE,
    STALE_DAYS,
    SUGGEST_P0_SCORE,
    SUGGEST_P1_SCORE,
    SUGGEST_P2_SCORE,
    TIER_ALIASES,
    TIER_LABELS,
    TIER_ORDER,
    TRACKING_LABELS,
    UNBLOCK_CAP,
    UNBLOCK_POINTS,
    URGENT_LEVERAGE,
    _cache_key,
    _code_spans,
    _indent_width,
    _rest_issue,
    _rest_items,
    _rest_pr,
    build_records,
    canonical_tier,
    closing_text,
    days_since,
    extract_deps,
    fetch_issues_and_prs,
    find_ship_contracts,
    normalize_label,
    parse_repo_slug,
    parse_ship_contract,
    pr_issue_references,
    rank_records,
    read_rest_files,
    readiness,
    repo_slug,
    repository_from_url,
    resolve_design_label,
    resolve_existing,
    resolve_tier_label,
    run_gh,
    runstate_dir,
    score_issue,
    squeeze,
    state_root,
    suggest_tier,
    tier_cell,
    unclosed_fence,
)
from issue_renderers import render_digest

__all__ = [
    "BARE_REF_RE",
    "CLOSING_RE",
    "CONTRACT_FIELD_RE",
    "CONTRACT_KNOWN_FIELDS",
    "CONTRACT_REQUIRED_FIELDS",
    "DEPENDENCY_BLOCK_LABELS",
    "DEP_PATTERNS",
    "DESIGN_BLOCK_LABELS",
    "DESIGN_LABEL",
    "FOUNDATION_LEVERAGE",
    "FRESH_DAYS",
    "LEVERAGE_CAP",
    "LEVERAGE_RULES",
    "NETWORK_SCHEMES",
    "PRIORITY_LABEL_WEIGHTS",
    "PR_LIMIT",
    "READY_NEGATIVE_LABELS",
    "REFERENCE_CAP",
    "SHIP_CONTRACT_RE",
    "SLUG_RE",
    "STALE_DAYS",
    "SUGGEST_P0_SCORE",
    "SUGGEST_P1_SCORE",
    "SUGGEST_P2_SCORE",
    "TIER_ALIASES",
    "TIER_LABELS",
    "TIER_ORDER",
    "TRACKING_LABELS",
    "UNBLOCK_CAP",
    "UNBLOCK_POINTS",
    "URGENT_LEVERAGE",
    "_BACKTICK_RUN_RE",
    "_CONTRACT_KEY",
    "_FENCE_OPEN_RE",
    "_HTML_COMMENT_OPEN_RE",
    "_LIST_ITEM_RE",
    "_REF_LIST",
    "_cache_key",
    "_code_spans",
    "_indent_width",
    "_rest_issue",
    "_rest_items",
    "_rest_pr",
    "build_records",
    "canonical_tier",
    "closing_text",
    "days_since",
    "extract_deps",
    "fetch_issues_and_prs",
    "find_ship_contracts",
    "normalize_label",
    "parse_repo_slug",
    "parse_ship_contract",
    "pr_issue_references",
    "rank_records",
    "read_rest_files",
    "readiness",
    "repo_slug",
    "repository_from_url",
    "resolve_design_label",
    "resolve_existing",
    "resolve_tier_label",
    "run_gh",
    "runstate_dir",
    "score_issue",
    "squeeze",
    "state_root",
    "suggest_tier",
    "tier_cell",
    "unclosed_fence",
]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--label", action="append", default=[])
    p.add_argument("--assignee")
    p.add_argument("--milestone")
    p.add_argument(
        "--issue",
        action="append",
        type=int,
        default=[],
        help="restrict the digest to these issue numbers",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=200,
        help="the most open issues to read; a larger backlog is an error, "
        "never a silently partial ranking (file mode: the first N in file order)",
    )
    p.add_argument(
        "--body-chars",
        type=int,
        default=1200,
        help="truncate issue bodies to this many chars; 0 omits them",
    )
    p.add_argument(
        "--rank-only", action="store_true", help="print only the priority ranking table"
    )
    p.add_argument(
        "--select",
        nargs="?",
        type=int,
        const=1,
        default=None,
        metavar="N",
        help="print only the top N READY issues (default 1) plus label "
        "coverage — the cheapest way to get the pick",
    )
    p.add_argument(
        "--no-rank", action="store_true", help="omit the priority ranking table"
    )
    p.add_argument(
        "--include-design",
        action="store_true",
        help="treat design-not-settled issues (blocked: design and "
        "equivalents) as selectable — use only when deciding "
        "the design is itself part of this run",
    )
    p.add_argument(
        "--with-rank",
        action="store_true",
        help="print the ranking table alongside --select instead of "
        "instead of it (one call where two were needed)",
    )
    p.add_argument(
        "--detail",
        action="append",
        type=int,
        default=[],
        metavar="N",
        help="print full detail for these issues WITHOUT restricting "
        "the ranking to them (unlike --issue)",
    )
    p.add_argument(
        "--detail-top",
        type=int,
        default=0,
        metavar="K",
        help="print full detail for the top K READY issues — replaces "
        "hand-listing the numbers a --select just printed",
    )
    p.add_argument(
        "--audit",
        action="store_true",
        help="report which issues carry a usable ship: contract and "
        "what the rest are missing, then exit",
    )
    p.add_argument(
        "--cache-ttl",
        type=int,
        default=0,
        metavar="SECONDS",
        help="reuse a run-state cache of the gh fetch this many "
        "seconds. OFF by default: a cache that is on unless "
        "someone remembers --refresh can serve a backlog from "
        "before this run's own merge. plan.py opts in for the "
        "startup, where the calls are seconds apart. Env "
        "SHIPPING_ISSUES_NO_CACHE=1 forces it off.",
    )
    p.add_argument(
        "--refresh",
        action="store_true",
        help="ignore the cache for this call and re-fetch — required "
        "after anything this run did changes the backlog",
    )
    p.add_argument(
        "--issues-file",
        metavar="PATH",
        help="rank open issues read from this REST JSON file "
        "(gh api --paginate --slurp) instead of calling gh; "
        "needs --prs-file",
    )
    p.add_argument(
        "--prs-file",
        metavar="PATH",
        help="open pull requests from this REST JSON file; needs --issues-file",
    )
    p.add_argument("--json", action="store_true", dest="as_json")
    args = p.parse_args()

    file_mode = args.issues_file is not None or args.prs_file is not None
    if file_mode:
        if args.issues_file is None or args.prs_file is None:
            p.error("--issues-file and --prs-file must be given together")
        if args.label or args.assignee or args.milestone:
            p.error(
                "--issues-file/--prs-file cannot be combined with "
                "--label, --assignee, or --milestone"
            )
    elif args.limit < 1:
        p.error("--limit must be at least 1")
    elif not shutil.which("gh"):
        print("error: gh CLI not found", file=sys.stderr)
        return 1

    # One more than the limit is asked for, so a backlog of exactly --limit
    # issues is told apart from a truncated one.
    fetch_limit = str(args.limit + 1)
    issue_args = [
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        fetch_limit,
        "--json",
        "number,title,labels,assignees,milestone,body,createdAt,updatedAt,url",
    ]
    filter_flags: list[str] = []
    for label in args.label:
        filter_flags += ["--label", label]
    if args.assignee:
        filter_flags += ["--assignee", args.assignee]
    if args.milestone:
        filter_flags += ["--milestone", args.milestone]
    filter_args = (
        [
            "issue",
            "list",
            *filter_flags,
            "--state",
            "open",
            "--limit",
            fetch_limit,
            "--json",
            "number",
        ]
        if filter_flags
        else None
    )

    filtered_numbers: list[int] | None = None
    if file_mode:
        issues, prs = read_rest_files(args.issues_file, args.prs_file, args.limit)
        cache_status = "MISS"  # the cache is neither read nor written
    else:
        issues, filtered_numbers, prs, cache_status = fetch_issues_and_prs(
            issue_args,
            args.cache_ttl,
            args.refresh,
            filter_args,
            issue_limit=args.limit,
        )

    payload = build_records(
        issues,
        prs,
        body_chars=args.body_chars,
        wanted=args.issue,
        include_design=args.include_design,
        in_filter=filtered_numbers,
    )
    payload["cache"] = cache_status
    return render_digest(payload, args)


if __name__ == "__main__":
    raise SystemExit(main())
