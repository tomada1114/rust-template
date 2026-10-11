"""Issue parsing, fetching and ranking shared by the shipping CLIs."""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, cast
from urllib.parse import urlsplit

if TYPE_CHECKING:
    from issue_types import DigestPayload, IssueRecord, RawIssue, RawPr, ShipContract

# Dependency phrasings seen in real issue bodies, EN + JA. Group 1 of a leading
# phrase is a list ("#1, #2 and #3"); every number in it is read.
_REF_LIST = r"(#\d+(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)#\d+)*)"
DEP_PATTERNS = [
    (
        # No bare "after": "through #40, after #19" (#25) is chronology, not
        # an edge. Japanese の後 / 完了後 stay: they attach to the number.
        r"(?:depends?\s+on|blocked\s+by|requires?)\s*:?\s*" + _REF_LIST,
        "depends_on",
    ),
    (r"(?:blocks|blocking)\s*:?\s*" + _REF_LIST, "blocks"),
    (r"#(\d+)\s*(?:に依存|の後|完了後|がマージされてから|の続き)", "depends_on"),
    (r"(?:前提|依存|ブロッカー|先行)\s*:?\s*#(\d+)", "depends_on"),
    (r"#(\d+)\s*(?:をブロック|の前提)", "blocks"),
]

# A `Depends on: #N` line (file_followup.py writes one per blocker under
# `## Dependencies`), optionally a list item. With the contract's `blocked-by=`
# it is a structured source: when either is present, it alone sets depends_on.
DEPENDS_ON_LINE_RE = re.compile(
    r"^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?"
    r"depends[ \t]+on[ \t]*:[ \t]*" + _REF_LIST,
    re.IGNORECASE | re.MULTILINE,
)


def stated_depends_on(body: str, contract: ShipContract | None) -> set[int] | None:
    """depends_on from the structured sources, or None when the body has none.

    The sources are the ship contract's `blocked-by=` field (`none` counts as
    stated) and `Depends on: #N` lines. Prose phrasings are not read here, and
    neither is a `Depends on:` line inside a code block or span or an HTML
    comment: a quoted example or a template's hidden placeholder states nothing.
    """
    code = _code_spans(body)
    spans = list(code)
    pos = body.find("<!--")
    while pos != -1:
        if any(start <= pos < end for start, end in code):
            pos = body.find("<!--", pos + 4)
            continue
        close = body.find("-->", pos + 4)
        end = len(body) if close == -1 else close + 3
        spans.append((pos, end))
        pos = body.find("<!--", end)
    lines = [
        m
        for m in DEPENDS_ON_LINE_RE.finditer(body)
        if not any(start <= m.start(1) < end for start, end in spans)
    ]
    has_field = contract is not None and "blocked-by" in contract["fields"]
    if not lines and not has_field:
        return None
    stated = set(contract["depends_on"]) if contract and has_field else set()
    for m in lines:
        stated.update(int(n) for n in re.findall(r"\d+", m.group(1)))
    return stated


# owner/repo as preflight.sh's repo_slug block accepts it, and the URL schemes
# it reads one from; parse_repo_slug() below is that block's twin.
SLUG_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
NETWORK_SCHEMES = ("https", "http", "ssh", "git", "git+ssh", "ssh+git")

# --- ship contract ---------------------------------------------------------
# A machine-readable block the issue author (or file_followup.py) leaves in the
# body, so the facts this skill would otherwise re-derive from prose on every
# run are simply read instead:
#
#   <!-- ship: tier=P1 area=test-infra blocked-by=#12 blocks=#98
#        touches=tests/,Cargo.toml design=settled -->
#
# Every field is optional and unknown fields are ignored, so the block can grow
# without breaking older readers. Two of them carry their weight immediately:
#
#   * `tier` is a *confirmed* tier, not a suggestion — someone chose it when
#     filing — so it prints as `P1`, not `~P1`, and a backlog whose issues all
#     carry one needs no research pass even before the labels are written.
#   * `touches` is what turns the parallel-grouping decision from a guess about
#     which issues might collide into a set intersection.
SHIP_CONTRACT_RE = re.compile(r"<!--\s*ship\s*:(.*?)-->", re.DOTALL | re.IGNORECASE)
# Fields are `key=value`, whitespace-separated, values never contain spaces.
# An empty value (`blocked-by= blocks=#9`) leaves group 2 unmatched: a value
# may never itself start like a `key=` token, or the empty field would swallow
# the next one and turn a `blocks` edge into a `blocked-by` edge. The price is
# that a value such as `touches=a=b.py` no longer parses; `key = value` with
# spaces still does, so `key= value` reads `value` too.
_CONTRACT_KEY = r"[A-Za-z][\w-]*"
CONTRACT_FIELD_RE = re.compile(
    rf"({_CONTRACT_KEY})\s*=(?:\s*(?!{_CONTRACT_KEY}\s*=)(\S+))?"
)
CONTRACT_KNOWN_FIELDS = ("tier", "area", "blocked-by", "blocks", "touches", "design")
# A contract is "complete enough to plan from" when it settles the three things
# the startup would otherwise have to derive: the tier, what it waits on, and
# what it touches. `blocked-by=none` and `touches=*` are how an author says
# "nothing" and "unknown/everything" explicitly rather than by omission.
CONTRACT_REQUIRED_FIELDS = ("tier", "blocked-by", "touches")


# A fence opener: up to three spaces, then three or more backticks or tildes; a
# backtick fence's info string may not contain a backtick (CommonMark).
_FENCE_OPEN_RE = re.compile(r"^ {0,3}(`{3,}(?=[^`]*$)|~{3,})")
_BACKTICK_RUN_RE = re.compile(r"`+")


# An HTML comment block (CommonMark HTML block type 2): a line that starts,
# after up to three spaces, with `<!--`. It runs to the line holding `-->`.
_HTML_COMMENT_OPEN_RE = re.compile(r"^ {0,3}<!--")
# A list item's first line: a bullet or an ordered marker, then a space or tab.
_LIST_ITEM_RE = re.compile(r"^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)")


def _indent_width(line: str) -> int:
    """Leading whitespace in columns, a tab advancing to the next multiple of 4."""
    width = 0
    for char in line:
        if char == " ":
            width += 1
        elif char == "\t":
            width += 4 - width % 4
        else:
            break
    return width


def _code_spans(body: str) -> list[tuple[int, int]]:
    """The [start, end) offsets of `body`'s fenced and indented code blocks and inline code spans, so a quoted ship-contract example or closing keyword is not read as real.

    A fence closes on a line of the same character at least as long as the
    opener (an unclosed fence runs to the end). An inline span is a backtick
    run closed by the next run of the same length within one paragraph: a
    blank line, a fence, or an HTML comment block ends the paragraph, so a
    stray backtick before a contract block cannot pair with one after it (an
    unmatched run is literal text).

    An indented code block starts on a line indented four or more columns (a
    tab counts to the next multiple of 4) that does not continue a paragraph:
    an indented line straight after paragraph text is a lazy continuation of
    it. It runs across blank lines until a non-blank line indented less. Once
    a list item has been seen, indented lines are read as its continuation
    rather than code until a blank line is followed by an unindented,
    non-list line. Code nested inside list items, other HTML blocks, and
    backslash-escaped backticks are not modelled.
    """
    spans: list[tuple[int, int]] = []
    paragraphs: list[tuple[int, int]] = []
    pos = 0
    fence: tuple[str, int, int] | None = None  # (char, length, start)
    in_comment = False
    para_start: int | None = None
    indented: tuple[int, int] | None = None  # (start, end of last non-blank line)
    in_list = False
    after_blank = True

    def end_paragraph(at: int) -> None:
        nonlocal para_start
        if para_start is not None:
            paragraphs.append((para_start, at))
            para_start = None

    for line in body.splitlines(keepends=True):
        stripped = line.rstrip("\r\n")
        blank = not stripped.strip()
        indent = _indent_width(stripped)
        if indented is not None:
            if blank or indent >= 4:
                if not blank:
                    indented = (indented[0], pos + len(line))
                after_blank = blank
                pos += len(line)
                continue
            spans.append(indented)
            indented = None
        if fence is None and not in_comment and not blank:
            if _LIST_ITEM_RE.match(stripped):
                in_list = True
            elif after_blank and indent == 0:
                in_list = False
        if fence is not None:
            char, length, start = fence
            close = re.fullmatch(
                rf" {{0,3}}({re.escape(char)}{{{length},}})\s*", stripped
            )
            if close:
                spans.append((start, pos + len(line)))
                fence = None
        elif in_comment:
            in_comment = "-->" not in stripped
        elif m := _FENCE_OPEN_RE.match(stripped):
            end_paragraph(pos)
            fence = (m.group(1)[0], len(m.group(1)), pos)
        elif _HTML_COMMENT_OPEN_RE.match(stripped):
            end_paragraph(pos)
            in_comment = "-->" not in stripped[stripped.index("<!--") + 4 :]
        elif blank:
            end_paragraph(pos)
        elif indent >= 4 and para_start is None and not in_list:
            indented = (pos, pos + len(line))
        elif para_start is None:
            para_start = pos
        after_blank = blank
        pos += len(line)
    if fence is not None:
        spans.append((fence[2], len(body)))
    if indented is not None:
        spans.append(indented)
    end_paragraph(len(body))
    for start, end in paragraphs:
        runs = list(_BACKTICK_RUN_RE.finditer(body, start, end))
        i = 0
        while i < len(runs):
            width = len(runs[i].group(0))
            closer = next(
                (j for j in range(i + 1, len(runs)) if len(runs[j].group(0)) == width),
                None,
            )
            if closer is None:
                i += 1
                continue
            spans.append((runs[i].start(), runs[closer].end()))
            i = closer + 1
    return spans


def unclosed_fence(body: str) -> str | None:
    """The fence line that would close a code block `body` leaves open at its end, or None when every fence is closed. Text appended after an open fence is code, so a ship contract written there would never be read."""
    fence: tuple[str, int] | None = None
    for line in (body or "").splitlines():
        if fence is None:
            m = _FENCE_OPEN_RE.match(line)
            if m:
                fence = (m.group(1)[0], len(m.group(1)))
        elif re.fullmatch(rf" {{0,3}}({re.escape(fence[0])}{{{fence[1]},}})\s*", line):
            fence = None
    return fence[0] * fence[1] if fence else None


def find_ship_contracts(body: str) -> list[re.Match[str]]:
    """Every real `<!-- ship: ... -->` block in `body`, in order: a block that starts inside a fenced code block or inline code is a quoted example, not the contract. parse_ship_contract() and apply_priority_labels.py's settle_contract_design() both read the contract through this one helper, so they always agree on which block it is."""
    body = body or ""
    spans = _code_spans(body)
    return [
        m
        for m in SHIP_CONTRACT_RE.finditer(body)
        if not any(s <= m.start() < e for s, e in spans)
    ]


def parse_ship_contract(body: str) -> ShipContract | None:
    """The `<!-- ship: ... -->` block's fields, or None if the body has none.

    Blocks quoted inside code are ignored (find_ship_contracts). The last
    real block wins: an issue edited to correct its contract usually gains a
    second block rather than losing the first.
    """
    blocks = [m.group(1) for m in find_ship_contracts(body)]
    if not blocks:
        return None
    raw: dict[str, str] = {}
    for block in blocks:
        for key, value in CONTRACT_FIELD_RE.findall(block):
            raw[key.strip().lower()] = value.strip()

    def numbers(key: str) -> list[int]:
        value = raw.get(key, "")
        if value.lower() in ("", "none", "-"):
            return []
        return sorted({int(n) for n in re.findall(r"\d+", value)})

    tier = raw.get("tier", "").upper()
    design = raw.get("design", "").lower()
    touches_raw = raw.get("touches", "")
    return {
        "fields": sorted(raw),
        "unknown_fields": sorted(k for k in raw if k not in CONTRACT_KNOWN_FIELDS),
        # An empty `blocked-by=` is a natural "none"; an empty `tier=` or
        # `touches=` settles nothing, so it still counts as missing.
        "missing_fields": [
            k
            for k in CONTRACT_REQUIRED_FIELDS
            if k not in raw or (not raw[k] and k != "blocked-by")
        ],
        "tier": tier if tier in TIER_ORDER else None,
        "area": raw.get("area"),
        "depends_on": numbers("blocked-by"),
        "blocks": numbers("blocks"),
        # `*` means "assume it collides with everything" — an honest unknown is
        # worth more here than an omission, which reads as "touches nothing".
        "touches": [t for t in touches_raw.split(",") if t] if touches_raw else [],
        "design": design if design in ("settled", "open") else None,
    }


# `(?<![\w-])` rather than `\b`: a hyphenated word such as `hot-fix #1` or
# `pre-fixes #1` is not a closing keyword, though its suffix would be.
CLOSING_RE = re.compile(
    r"(?<![\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*"
    r"(?:(?P<url>https?://[^/\s]+/(?P<url_repo>[\w.-]+/[\w.-]+)/issues/)"
    r"|(?:(?P<repo>[\w.-]+/[\w.-]+))?#)(?P<number>\d+)\b",
    re.IGNORECASE,
)
BARE_REF_RE = re.compile(r"(?<![\w/])#(\d+)")


def repository_from_url(url: str) -> tuple[str, str] | None:
    """Keep the host as well as owner/repo when comparing issue ownership."""
    parsed = urlsplit(url)
    match = re.fullmatch(r"/([\w.-]+/[\w.-]+)/(?:issues|pull)/\d+/?", parsed.path)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or not match:
        return None
    return parsed.netloc.lower(), match.group(1).lower()


def closing_text(text: str) -> str:
    """Mask examples without joining words across an ignored Markdown region."""
    for start, end in sorted(_code_spans(text), reverse=True):
        text = text[:start] + " " * (end - start) + text[end:]
    return re.sub(r"<!--(?:.*?-->|.*\Z)", " ", text, flags=re.DOTALL)


def pr_issue_references(pr: RawPr, repository: tuple[str, str] | None) -> set[int]:
    """Union GitHub's links with local prose and established branch ownership."""
    refs = {
        ref["number"]
        for ref in pr.get("closingIssuesReferences", [])
        if repository is not None
        and repository_from_url(ref.get("url", "")) == repository
    }
    for field in ("title", "body"):
        for match in CLOSING_RE.finditer(
            closing_text(
                pr.get("title") or "" if field == "title" else pr.get("body") or ""
            )
        ):
            qualified = match.group("repo") or match.group("url_repo")
            if qualified:
                if repository is None or qualified.lower() != repository[1]:
                    continue
                if (
                    match.group("url")
                    and urlsplit(match.group("url")).netloc.lower() != repository[0]
                ):
                    continue
            refs.add(int(match.group("number")))
    # A bare digit anywhere is not enough: bump-foo-2-3-4 must not claim #2.
    branch = pr.get("headRefName", "")
    refs |= {int(n) for n in re.findall(r"(?:^|/)(\d{1,6})-", branch)}
    refs |= {int(n) for n in re.findall(r"(?i)issues?[-_/](\d{1,6})", branch)}
    return refs


def normalize_label(name: str) -> str:
    """`Priority: P0`, `priority/P0` and ` p0 ` all collapse to one lookup key."""
    return re.sub(r"\s*[:/]\s*", ":", name.strip().lower())


READY_NEGATIVE_LABELS = {
    "blocked",
    # An action only the repository's owner can take (an account, a purchase, a
    # signing identity): never implementable from a checkout, so a hard block.
    "blocked:external",
    "on hold",
    "on-hold",
    "wontfix",
    "duplicate",
    "question",
    "discussion",
    "needs discussion",
    "needs-discussion",
    "wip",
    "draft",
}

# The design-not-settled label is a *soft* block, unlike READY_NEGATIVE_LABELS:
# it is excluded from automatic selection by default, but an explicit issue
# number or --include-design can still take it on (deciding the design is then
# part of the run — see SKILL.md step 2b). Kept separate from
# READY_NEGATIVE_LABELS so the two states never collapse into one meaning.
# All members are normalize_label() output, so "Blocked: Design", "blocked/design"
# and "needs-design" resolve to the same key on lookup.
# Name, color and description as .github/labels.yml declares them, which the
# two must not disagree on. Only the name is read: `just labels` creates
# the set (a human's step), and no script of this skill ever does.
DESIGN_LABEL = (
    "blocked: design",
    "e99695",
    "The approach is not settled; needs a human decision first.",
)
DESIGN_BLOCK_LABELS = {
    normalize_label(n)
    for n in (
        "blocked: design",
        "needs design",
        "needs-design",
        "needs:design",
        "design-needed",
    )
}

# Labels that assert "this issue is blocked on a dependency". Readiness never
# reads these — it is computed from the dependency edges themselves
# (depends_on_open) — so this set exists only to detect when the label has
# gone stale: the edges have all closed but the label is still sitting on the
# issue, misleading a human skimming the backlog. Kept small and literal
# (normalize_label() output) on purpose: bare "blocked" is deliberately
# excluded, since it is ambiguous with READY_NEGATIVE_LABELS's general block.
DEPENDENCY_BLOCK_LABELS = {
    normalize_label(n)
    for n in (
        "blocked: dependency",
        "blocked-by-dependency",
        "blocked: dependencies",
        "waiting on dependency",
    )
}

# A tracking issue is a checklist of sub-issues, never work in itself. Unlike
# READY_NEGATIVE_LABELS (which still ranks and tiers the issue, only holds it),
# an issue carrying one of these is dropped from the records entirely: it is
# never ranked, never selected, and never offered a priority tier to backfill.
TRACKING_LABELS = {normalize_label(n) for n in ("tracking", "epic")}


def resolve_design_label(existing: list[str]) -> tuple[str, bool]:
    """Return (label name this repo uses for the design-not-settled state, whether the repo lacks it). Prefers the canonical name, then any existing alias meaning the same thing (shortest wins); with neither, the canonical name and True, which the caller reports — a human's `just labels` creates it, never this skill."""
    canonical = DESIGN_LABEL[0]
    by_norm = {normalize_label(name): name for name in existing}
    if normalize_label(canonical) in by_norm:
        return by_norm[normalize_label(canonical)], False
    aliases = [name for norm, name in by_norm.items() if norm in DESIGN_BLOCK_LABELS]
    if aliases:
        return min(aliases, key=lambda n: (len(n), n)), False
    return canonical, True


# Explicit priority signals, by normalized label name (see normalize_label:
# `Priority: P0`, `priority/p0` and `p0 ` all arrive here as one key).
PRIORITY_LABEL_WEIGHTS = {
    "sev1": 8,
    "severity:1": 8,
    "security": 8,
    "incident": 8,
    "regression": 5,
    "important": 4,
    "broken": 4,
    "bug": 3,
    "defect": 3,
    "enhancement": 0,
    "feature": 0,
    "documentation": -1,
    "docs": -1,
    "chore": -1,
    "p4": -2,
}

# The four labels this skill writes. The tier IS the persisted ranking: it is
# read on every later run so issue prose never has to be re-analyzed.
TIER_ORDER = ["P0", "P1", "P2", "P3"]
# As .github/labels.yml declares them, for the same reason as DESIGN_LABEL.
TIER_LABELS = {
    "P0": (
        "priority: P0",
        "b60205",
        "Ship now: other issues are blocked on it, or damage is being taken.",
    ),
    "P1": (
        "priority: P1",
        "d93f0b",
        "Do next: leverage work later issues stand on (CI, schema, shared types, config).",
    ),
    "P2": (
        "priority: P2",
        "fbca04",
        "Normal: a real, self-contained change; nothing waits on it.",
    ),
    "P3": ("priority: P3", "c5def5", "Defer: nice-to-have, docs polish, or cosmetics."),
}

# Label vocabularies that already express a tier, recognized on read so a repo
# with its own convention is ranked from its existing labels instead of being
# relabeled. Only names that mean *priority* belong here — a topic label like
# `security` or `bug` stays in PRIORITY_LABEL_WEIGHTS as a score signal.
TIER_ALIASES = {
    "priority:p0": "P0",
    "p0": "P0",
    "priority:critical": "P0",
    "critical": "P0",
    "urgent": "P0",
    "incident": "P0",
    "blocker": "P0",
    "priority:p1": "P1",
    "p1": "P1",
    "priority:high": "P1",
    "high priority": "P1",
    "high-priority": "P1",
    "priority:p2": "P2",
    "p2": "P2",
    "priority:medium": "P2",
    "medium priority": "P2",
    "medium-priority": "P2",
    "priority:p3": "P3",
    "p3": "P3",
    "priority:low": "P3",
    "low priority": "P3",
    "low-priority": "P3",
    "nice to have": "P3",
    "nice-to-have": "P3",
    "someday": "P3",
}


def resolve_existing(
    canonical: str, alias_keys: set[str], existing: list[str]
) -> str | None:
    """The name this repo uses for `canonical`, or None when it has neither the canonical name nor an alias (`alias_keys` are normalize_label() keys).

    Picking an alias the repo already carries is the whole point —
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


# Leverage: work whose value spills over onto other issues. Matched against
# title + body. Contributions are summed then capped by LEVERAGE_CAP, so an
# issue that name-drops every keyword cannot outrank a genuine blocker.
LEVERAGE_RULES = [
    (
        "security",
        5,
        (
            r"(?i)\b(security|vulnerab\w*|cve-|injection|xss|csrf|auth bypass|secret leak|credential leak)\b"
            r"|脆弱性|セキュリティ|情報漏[洩え]"
        ),
    ),
    (
        "breakage",
        4,
        (
            r"(?i)\b(crash\w*|data loss|corrupt\w*|outage|broken build|is broken|regression|blocker)\b"
            r"|クラッシュ|デグレ|データ破損|落ちる|壊れて|動かない|止まって"
        ),
    ),
    (
        "infra",
        4,
        (
            r"(?i)\b(ci|cd|github actions?|workflow|pipeline|build system|toolchain|lint(?:er|ing)? setup|pre-commit)\b"
            r"|CI/CD|ワークフロー|ビルド基盤|パイプライン|開発基盤"
        ),
    ),
    (
        "schema",
        4,
        (
            r"(?i)\b(schema|migration|data model|new column|new field|new table|db model)\b"
            r"|スキーマ|マイグレーション|データモデル|テーブル定義"
        ),
    ),
    (
        "interface",
        3,
        (
            r"(?i)\b(interface|protocol|type definition|typing|api contract|abstract base|base class|public api)\b"
            r"|型定義|インタ[ーー]?フェ[ーー]?ス|共通化|抽象化"
        ),
    ),
    (
        "foundation",
        3,
        (
            r"(?i)\b(shared|common|core|foundation|scaffold\w*|extract\w* (?:into|to) a? ?(?:module|helper|util))\b"
            r"|共通処理|基盤|土台|全体に影響"
        ),
    ),
    (
        "test-harness",
        3,
        (
            r"(?i)\b(test harness|test infra\w*|flaky|test fixture|coverage setup|e2e setup)\b"
            r"|テスト基盤|テスト環境|フレーキ"
        ),
    ),
    (
        "config",
        2,
        (
            r"(?i)\b(config\w*|settings|env(?:ironment)? var\w*|feature flag)\b"
            r"|設定値|環境変数|フィーチャーフラグ"
        ),
    ),
]
LEVERAGE_CAP = 8

UNBLOCK_POINTS = 4
UNBLOCK_CAP = 12
REFERENCE_CAP = 3
STALE_DAYS = 180
FRESH_DAYS = 30

# Score thresholds for suggesting a tier on an unlabeled issue. They mirror the
# rubric's axes: unblocking others or active damage is P0 outright; the leverage
# keywords that improve shared ground are P1; the rest falls out of the score.
# 14 is roughly "unblocks nothing but carries two leverage hits and a priority
# label"; 8 is one strong leverage hit; 3 is any positive signal at all.
SUGGEST_P0_SCORE = 14
SUGGEST_P1_SCORE = 8
SUGGEST_P2_SCORE = 3
URGENT_LEVERAGE = {"security", "breakage"}
FOUNDATION_LEVERAGE = {"infra", "schema", "interface", "foundation", "test-harness"}


def run_gh(args: list[str]) -> object:
    try:
        out = subprocess.run(
            ["gh", *args], capture_output=True, text=True, check=True, timeout=120
        ).stdout
    except FileNotFoundError:
        print("error: gh CLI not found", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.TimeoutExpired:
        print(f"error: gh {' '.join(args)} timed out", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.CalledProcessError as exc:
        print(f"error: gh {' '.join(args)} failed:\n{exc.stderr}", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(out or "[]")


def parse_repo_slug(url: str) -> str | None:
    """`owner/repo` from an origin URL, or None when it is not exactly that.

    The Python twin of preflight.sh's repo_slug block: git's scp-style
    `[user@]host:[/]owner/repo` (a bare ssh host alias included) and the
    NETWORK_SCHEMES as `scheme://[user@]host[:port]/owner/repo`, each with an
    optional ".git" and trailing "/". Any other scheme (file:// included) is
    None. tests/test_runstate_parity.py holds the two equal.
    """
    slug = url.rstrip("/")
    slug = slug.removesuffix(".git")
    if "://" in slug:
        scheme, _, rest = slug.partition("://")
        if scheme not in NETWORK_SCHEMES:
            return None
        slug = rest.partition("/")[2]
    elif ":" in slug:
        host, _, path = slug.partition(":")
        if "/" in host:
            return None
        slug = path.removeprefix("/")
    else:
        return None
    return slug if SLUG_RE.match(slug) else None


def repo_slug() -> str | None:
    """`owner/repo` from the origin remote, or None when it cannot be read.

    Derived locally from git rather than from `gh repo view`: this is only used
    to name a cache directory, and paying a network round-trip to decide where
    to cache would undo the point.
    """
    try:
        url = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_repo_slug(url)


def state_root() -> Path:
    """`${AGENT_SKILL_STATE_DIR:-$HOME/.local/state/agent-skills}`, with a leading `~` expanded — the same root preflight.sh and run_record.py use.

    A twin of run_record.state_dir(); keep the two in step.
    """
    env = os.environ.get("AGENT_SKILL_STATE_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".local" / "state" / "agent-skills"


def runstate_dir() -> Path | None:
    """This repo's run-state directory — the same path SKILL.md calls `<runstate>`."""
    slug = repo_slug()
    if not slug:
        return None
    owner, name = slug.split("/", 1)
    return state_root() / "shipping-issues" / f"{owner}__{name}"


def _cache_key(issue_args: list[str]) -> str:
    """What makes two fetches interchangeable.

    Only the arguments that change what `gh` returns belong here. `--issue`,
    `--body-chars` and every output flag filter or format data already fetched,
    so a run that asks for one issue's detail reuses the whole-backlog fetch a
    `--select` took seconds earlier — which is the entire point of the cache.
    """
    return hashlib.sha256(
        "\x00".join(["closing-references-v1", *issue_args]).encode()
    ).hexdigest()[:16]


# The most open pull requests read. One more is asked for, so a list that hit
# the cap is told apart from one that fits it.
PR_LIMIT = 1000


def _over_cap(
    issues: list[RawIssue], prs: list[RawPr], issue_limit: int | None
) -> str | None:
    """The error to stop on when a fetch reached its cap, else None.

    A truncated list is never ranked: a dependency on an issue past the cap
    would read as closed, and an issue whose PR is past the cap would lose its
    HAS-OPEN-PR flag and could be shipped twice.
    """
    if issue_limit is not None and len(issues) > issue_limit:
        return (
            f"error: more than {issue_limit} open issues; ranking only the first "
            "ones would read a dependency on any of the rest as closed. Re-run "
            f"with a larger --limit (more than {issue_limit})."
        )
    if len(prs) > PR_LIMIT:
        return (
            f"error: more than {PR_LIMIT} open pull requests; marking HAS-OPEN-PR "
            "from only the first ones would let an issue whose PR is past the cap "
            "be shipped twice. Close or merge open PRs, or raise PR_LIMIT in "
            "issue_records.py."
        )
    return None


def fetch_issues_and_prs(
    issue_args: list[str],
    ttl: int,
    refresh: bool,
    filter_args: list[str] | None = None,
    *,
    issue_limit: int | None = None,
) -> tuple[list[RawIssue], list[int] | None, list[RawPr], str]:
    """(issues, filtered_numbers, prs, cache_status) — from the run-state cache
    when it is warm.

    `issues` is every open issue, unfiltered, because dependency edges and
    "is the blocker still open" have to be judged against all of them.
    `filter_args`, when given, is a second, numbers-only fetch that carries the
    caller's `--label`/`--assignee`/`--milestone`, and `filtered_numbers` is its
    answer (None without one): gh applies the filters, so their meaning stays
    gh's own rather than a local re-implementation.

    `issue_args` should ask for one more issue than `issue_limit`; when more than
    `issue_limit` come back, or more than PR_LIMIT open PRs, this prints an
    error and exits 1 instead of returning a truncated backlog.

    A run's startup asks the same question several times in a row (rank, then
    select, then read the picked issues' bodies), and each `gh` pair costs two
    round-trips over data that cannot have changed in between. The cache is
    short-lived on purpose: anything that *does* change the backlog — a merge,
    a label write, a filed follow-up — is this session's own action, and the
    steps that follow one pass --refresh.
    """
    state = runstate_dir()
    path = state / "digest-cache.json" if state else None
    key = _cache_key([*issue_args, "\x01", *(filter_args or [])])
    disabled = ttl <= 0 or os.environ.get("SHIPPING_ISSUES_NO_CACHE") == "1"

    if path and not refresh and not disabled:
        try:
            blob = json.loads(path.read_text(encoding="utf-8"))
            if blob.get("key") == key and time.time() - blob["fetched_at"] <= ttl:
                issues = cast("list[RawIssue]", blob["issues"])
                filtered = cast("list[int] | None", blob["filtered"])
                prs = cast("list[RawPr]", blob["prs"])
                error = _over_cap(issues, prs, issue_limit)
                if error is None:
                    return issues, filtered, prs, "HIT"
        except (OSError, ValueError, KeyError, TypeError):
            pass  # a missing, unreadable or malformed cache is a miss, not an error

    issues = cast("list[RawIssue]", run_gh(issue_args))
    filtered = (
        [it["number"] for it in cast("list[RawIssue]", run_gh(filter_args))]
        if filter_args is not None
        else None
    )
    prs = cast(
        "list[RawPr]",
        run_gh(
            [
                "pr",
                "list",
                "--state",
                "open",
                "--limit",
                str(PR_LIMIT + 1),
                "--json",
                "number,title,body,headRefName,isDraft,url,closingIssuesReferences",
            ]
        ),
    )
    error = _over_cap(issues, prs, issue_limit)
    if error is not None:
        print(error, file=sys.stderr)
        raise SystemExit(1)
    status = "MISS"
    if path and not disabled:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(
                    {
                        "key": key,
                        "fetched_at": time.time(),
                        "issues": issues,
                        "filtered": filtered,
                        "prs": prs,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            status = "WRITTEN"
        except OSError:
            pass  # an unwritable state dir costs a re-fetch next time, nothing more
    return issues, filtered, prs, status


def _rest_items(path: str, label: str) -> list[dict[str, object]]:
    """The objects in a REST JSON file: an array, or `--slurp` pages (arrays of arrays).

    Exits 1 with `error: <path>: <reason>` for a file that is missing,
    unreadable, not JSON, or not one of those two shapes.
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        print(f"error: {path}: {exc.strerror or exc}", file=sys.stderr)
        raise SystemExit(1)
    except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError
        print(f"error: {path}: not valid JSON ({exc})", file=sys.stderr)
        raise SystemExit(1)
    shape = f"expected a JSON array of {label} objects or an array of such arrays"
    if not isinstance(data, list):
        print(f"error: {path}: {shape}", file=sys.stderr)
        raise SystemExit(1)
    items: list[object] = []
    for entry in data:
        if isinstance(entry, list):
            items.extend(entry)
        else:
            items.append(entry)
    if not all(isinstance(item, dict) for item in items):
        print(f"error: {path}: {shape}", file=sys.stderr)
        raise SystemExit(1)
    return cast("list[dict[str, object]]", items)


def _rest_issue(item: dict[str, object]) -> RawIssue:
    """A REST issue as the dict `gh issue list --json` produces."""
    return cast(
        "RawIssue",
        {
            **item,
            "labels": item.get("labels") or [],
            "assignees": item.get("assignees") or [],
            "createdAt": item.get("created_at") or "",
            "updatedAt": item.get("updated_at") or "",
            "url": item.get("html_url") or "",
        },
    )


def _rest_pr(item: dict[str, object]) -> RawPr:
    """A REST pull request as the dict `gh pr list --json` produces.

    REST has no closing references; the body, title and branch still claim issues.
    """
    return cast(
        "RawPr",
        {
            **item,
            "headRefName": cast("dict[str, object]", item.get("head") or {}).get("ref")
            or "",
            "isDraft": bool(item.get("draft")),
            "url": item.get("html_url") or "",
            "closingIssuesReferences": [],
        },
    )


def read_rest_files(
    issues_file: str, prs_file: str, limit: int
) -> tuple[list[RawIssue], list[RawPr]]:
    """(issues, prs) from REST JSON files, shaped like the `gh` path's."""
    issues = [
        _rest_issue(i)
        for i in _rest_items(issues_file, "issue")
        if "pull_request" not in i
    ]
    prs = [_rest_pr(p) for p in _rest_items(prs_file, "pull request")]
    return issues[: max(limit, 0)], prs


def squeeze(text: str | None, limit: int) -> str:
    """Collapse whitespace, drop HTML comments and images, then truncate.

    A limit of 0 omits the body entirely — used for the index-only pass that
    keeps issue prose out of the orchestrating context.
    """
    if not text or limit <= 0:
        return ""
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.DOTALL)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"```.*?```", " [code block] ", text, flags=re.DOTALL)
    # Demote body headings so they cannot collide with the digest's own ## rows.
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "▸ ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + " …[truncated]"
    return text


def extract_deps(body: str, title: str, self_number: int) -> dict[str, list[int]]:
    haystack = f"{title}\n{body or ''}"
    deps: dict[str, set[int]] = {
        "depends_on": set(),
        "blocks": set(),
        "mentions": set(),
    }
    for pattern, kind in DEP_PATTERNS:
        for m in re.finditer(pattern, haystack, re.IGNORECASE):
            for ref in re.findall(r"\d+", m.group(1)):
                n = int(ref)
                if n != self_number:
                    deps[kind].add(n)
    for m in BARE_REF_RE.finditer(haystack):
        n = int(m.group(1))
        if n != self_number and n not in deps["depends_on"] and n not in deps["blocks"]:
            deps["mentions"].add(n)
    return {k: sorted(v) for k, v in deps.items()}


def days_since(iso_date: str | None) -> int | None:
    try:
        d = _dt.date.fromisoformat((iso_date or "")[:10])
    except (ValueError, TypeError):
        return None
    return (_dt.date.today() - d).days


def canonical_tier(labels: list[str]) -> str | None:
    """The issue's priority tier from its labels, or None if it carries none.

    Highest tier wins when an issue somehow carries two (a repo migrating from
    `critical` to `priority: P1` can briefly have both).
    """
    tiers = {TIER_ALIASES[n] for n in map(normalize_label, labels) if n in TIER_ALIASES}
    return min(tiers, key=TIER_ORDER.index) if tiers else None


def suggest_tier(rec: IssueRecord, hits: set[str], score: int) -> tuple[str, str]:
    """Tier to write on an issue that has none, plus the one-line reason.

    Deliberately mechanical: this runs over the whole backlog for free, and the
    rubric's research pass only has to correct the handful it gets wrong.
    """
    if rec["unblocks_open"]:
        return "P0", "unblocks " + ",".join(f"#{n}" for n in rec["unblocks_open"])
    urgent = sorted(hits & URGENT_LEVERAGE)
    if urgent:
        return "P0", "+".join(urgent)
    if score >= SUGGEST_P0_SCORE:
        return "P0", f"score {score}"
    foundation = sorted(hits & FOUNDATION_LEVERAGE)
    if foundation:
        return "P1", "+".join(foundation)
    if score >= SUGGEST_P1_SCORE:
        return "P1", f"score {score}"
    if score >= SUGGEST_P2_SCORE:
        return "P2", f"score {score}"
    return "P3", f"score {score}"


def score_issue(rec: IssueRecord, raw_body: str) -> tuple[int, list[str], set[str]]:
    """Heuristic priority score, a readable breakdown, and the leverage hits.

    Weighted toward *impact on other work*: unblocking other open issues and
    touching shared foundations outrank a self-contained nice-to-have. Labels
    that are themselves a tier are skipped — the tier is applied as a sort key,
    so counting it here too would drown the signals that break within-tier ties.
    """
    score = 0
    parts: list[str] = []

    n_unblocks = len(rec["unblocks_open"])
    if n_unblocks:
        pts = min(UNBLOCK_POINTS * n_unblocks, UNBLOCK_CAP)
        score += pts
        parts.append(f"unblocks×{n_unblocks}(+{pts})")

    n_ref = len(rec["referenced_by_open"])
    if n_ref:
        pts = min(n_ref, REFERENCE_CAP)
        score += pts
        parts.append(f"referenced×{n_ref}(+{pts})")

    for lbl in rec["labels"]:
        key = normalize_label(lbl)
        if key in TIER_ALIASES:
            continue
        w = PRIORITY_LABEL_WEIGHTS.get(key)
        if w:
            score += w
            parts.append(f"label:{lbl}({w:+d})")

    haystack = f"{rec['title']}\n{raw_body or ''}"
    leverage = 0
    hits: list[str] = []
    for name, pts, pattern in LEVERAGE_RULES:
        if re.search(pattern, haystack):
            leverage += pts
            hits.append(name)
    if leverage:
        capped = min(leverage, LEVERAGE_CAP)
        score += capped
        parts.append(f"{'+'.join(hits)}(+{capped})")

    if rec["milestone"]:
        score += 2
        parts.append("milestone(+2)")

    age = days_since(rec["updated_at"])
    if age is not None:
        if age >= STALE_DAYS:
            score -= 1
            parts.append(f"stale {age}d(-1)")
        elif age <= FRESH_DAYS:
            score += 1
            parts.append("fresh(+1)")

    return score, parts, set(hits)


def tier_cell(rec: IssueRecord) -> str:
    """`P1` for a tier a human settled, `~P1` for one this script is guessing.

    "Settled" is either the written label or the filing contract's `tier=` — both
    were chosen by a person, so neither needs a research pass to be trusted.

    `P2(~P0)` means the written label is *lower* than the signals now justify —
    usually a label written before the issue started blocking something. The
    label still ranks; the marker is the prompt to re-label it.
    """
    tier = rec["priority_tier"] or rec.get("contract_tier")
    sugg = rec["suggested_tier"]
    if not tier:
        return f"~{sugg}"
    if TIER_ORDER.index(sugg) < TIER_ORDER.index(tier):
        return f"{tier}(~{sugg})"
    return tier


def readiness(rec: IssueRecord, allow_design: bool = False) -> str:
    if rec["depends_on_open"]:
        return "BLOCKED-BY:" + ",".join(f"#{n}" for n in rec["depends_on_open"])
    if rec["not_ready_labels"]:
        return "LABEL:" + ",".join(rec["not_ready_labels"])
    if rec["design_labels"] and not allow_design:
        return "DESIGN:" + ",".join(rec["design_labels"])
    if rec["open_pr"]:
        return f"HAS-PR:#{rec['open_pr']['number']}"
    return "READY"


def rank_records(records: list[IssueRecord]) -> list[IssueRecord]:
    """Order ready records by settled tier, leverage and issue number."""
    return sorted(
        records,
        key=lambda r: (
            r["readiness"] != "READY",
            TIER_ORDER.index(r["effective_tier"]),
            r["confirmed_tier"] is None,  # a settled tier outranks a guess
            -r["priority_score"],
            r["number"],
        ),
    )


def build_records(
    issues: list[RawIssue],
    prs: list[RawPr],
    *,
    body_chars: int = 1200,
    wanted: list[int] | None = None,
    include_design: bool = False,
    in_filter: list[int] | None = None,
) -> DigestPayload:
    """Build the digest from already fetched records without subprocesses.

    `issues` is the whole open backlog; `in_filter`, when given, is the subset a
    `--label`/`--assignee`/`--milestone` filter kept. Only that subset is ranked,
    but dependency edges and whether a blocker is still open are judged against
    every open issue.
    """
    # Map issue number -> open PR that claims to close it.
    claimed: dict[int, RawPr] = {}
    repository = next(
        (
            repo
            for issue in issues
            if (repo := repository_from_url(issue.get("url", ""))) is not None
        ),
        None,
    )
    for pr in prs:
        for n in pr_issue_references(pr, repository):
            claimed.setdefault(n, pr)

    # Dependency edges are read from every open issue, not just the filtered
    # subset: an issue excluded by --issue/--label can still be what makes the
    # selected one high-leverage, or the blocker that keeps it waiting.
    all_deps: dict[int, dict[str, list[int]]] = {}
    contracts: dict[int, ShipContract | None] = {}
    for it in issues:
        num = it["number"]
        body = it.get("body") or ""
        deps = extract_deps(body, it.get("title", ""), num)
        contract = parse_ship_contract(body)
        contracts[num] = contract
        stated = stated_depends_on(body, contract)
        if contract or stated is not None:
            prose_depends = set(deps["depends_on"])
            # A stated edge (`blocked-by=`, `Depends on: #N`) is a fact; the
            # regex scrape is an inference from prose. When a body states its
            # dependencies, they alone count: prose such as "after #19" in a
            # scope note made #25 look blocked by the issue it blocks.
            if stated is not None:
                deps["depends_on"] = sorted(n for n in stated if n != num)
            # `blocks` has no structured line form: union the contract's
            # edges with the scrape, as before.
            if contract:
                merged = set(deps["blocks"]) | set(contract["blocks"])
                deps["blocks"] = sorted(n for n in merged if n != num)
            # A dropped prose edge is still a reference; a declared edge is not
            # a bare mention.
            declared = set(deps["depends_on"]) | set(deps["blocks"])
            mentions = set(deps["mentions"]) | (prose_depends - {num})
            deps["mentions"] = sorted(mentions - declared)
        all_deps[num] = deps
    open_numbers = set(all_deps)

    # Reverse edges: who is waiting on whom.
    unblocks: dict[int, set[int]] = {n: set() for n in open_numbers}
    referenced_by: dict[int, set[int]] = {n: set() for n in open_numbers}
    for num, deps in all_deps.items():
        # "#M depends on me" — the edge is declared by the waiting issue.
        for target in deps["depends_on"]:
            if target in unblocks:
                unblocks[target].add(num)
        # "I block #M" — the edge is declared by this issue itself.
        for target in deps["blocks"]:
            if target in open_numbers:
                unblocks[num].add(target)
        for target in deps["mentions"]:
            if target in referenced_by:
                referenced_by[target].add(num)

    wanted_numbers = set(wanted or [])
    filter_numbers = set(in_filter) if in_filter is not None else None
    records: list[IssueRecord] = []
    tracking = []
    for it in issues:
        num = it["number"]
        if wanted_numbers and num not in wanted_numbers:
            continue
        if filter_numbers is not None and num not in filter_numbers:
            continue
        labels = [lbl["name"] for lbl in it.get("labels", [])]
        if any(normalize_label(lbl) in TRACKING_LABELS for lbl in labels):
            tracking.append(num)
            continue
        body = it.get("body") or ""
        deps = all_deps[num]
        blockers = [
            lbl for lbl in labels if normalize_label(lbl) in READY_NEGATIVE_LABELS
        ]
        design_labels = [
            lbl for lbl in labels if normalize_label(lbl) in DESIGN_BLOCK_LABELS
        ]
        depends_on_open = [n for n in deps["depends_on"] if n in open_numbers]
        # Stale only when there IS a recorded dependency and every one of them
        # has closed. An issue carrying the label with no recorded dependency
        # is left alone — the edge may be expressed somewhere the regex/contract
        # scrape misses, and this script has no way to tell "no edge" from
        # "edge it couldn't see".
        stale_dependency_labels = (
            [lbl for lbl in labels if normalize_label(lbl) in DEPENDENCY_BLOCK_LABELS]
            if deps["depends_on"] and not depends_on_open
            else []
        )
        claiming_pr = claimed.get(num)
        milestone = it.get("milestone")
        rec: IssueRecord = {
            "number": num,
            "title": it.get("title", ""),
            "url": it.get("url", ""),
            "labels": labels,
            "assignees": [a["login"] for a in it.get("assignees", [])],
            "milestone": milestone["title"] if milestone else None,
            "created_at": it.get("createdAt", "")[:10],
            "updated_at": it.get("updatedAt", "")[:10],
            "depends_on": deps["depends_on"],
            "blocks": deps["blocks"],
            "mentions": deps["mentions"],
            "depends_on_open": depends_on_open,
            "unblocks_open": sorted(unblocks.get(num, set())),
            "referenced_by_open": sorted(referenced_by.get(num, set())),
            "not_ready_labels": blockers,
            "design_labels": design_labels,
            "stale_dependency_labels": stale_dependency_labels,
            "open_pr": {
                "number": claiming_pr["number"],
                "url": claiming_pr["url"],
                "draft": claiming_pr["isDraft"],
            }
            if claiming_pr
            else None,
            "body": squeeze(body, body_chars),
        }
        contract = contracts.get(num)
        rec["contract"] = contract
        rec["contract_tier"] = contract["tier"] if contract else None
        rec["area"] = contract["area"] if contract else None
        rec["touches"] = contract["touches"] if contract else []
        # `design=open` in the contract is the label's equal — an author who
        # writes it has said the approach is not settled, and the run should
        # hold the issue for step 8b whether or not the label was ever applied.
        # `design=settled` does NOT clear a label: the label is what this skill
        # writes and clears, and a stale contract must not override it.
        if contract and contract["design"] == "open" and not design_labels:
            design_labels = rec["design_labels"] = ["ship:design=open"]
        rec["priority_score"], rec["score_reasons"], hits = score_issue(rec, body)
        rec["priority_tier"] = canonical_tier(labels)
        rec["suggested_tier"], rec["suggested_reason"] = suggest_tier(
            rec, hits, rec["priority_score"]
        )
        # Two kinds of tier a human settled — the written label and the filing
        # contract — and one this script guessed. Only the first two rank
        # without a research pass.
        rec["confirmed_tier"] = rec["priority_tier"] or rec["contract_tier"]
        # What the ordering actually uses: a settled tier when there is one, the
        # suggestion otherwise, so a half-labeled backlog still ranks sanely.
        rec["effective_tier"] = rec["confirmed_tier"] or rec["suggested_tier"]
        # An explicit --issue N is itself the override: naming an issue means
        # taking it on deliberately, same as --include-design.
        rec["readiness"] = readiness(
            rec, allow_design=include_design or bool(wanted_numbers)
        )
        records.append(rec)

    ranked = rank_records(records)

    labeled = [r for r in records if r["priority_tier"]]
    unlabeled = [r for r in records if not r["priority_tier"]]
    contract_ranked = [
        r for r in records if not r["priority_tier"] and r["contract_tier"]
    ]
    unranked = [r for r in records if not r["confirmed_tier"]]
    with_contract = [r for r in records if r["contract"]]
    full_contract = [
        r
        for r in with_contract
        if r["contract"] and not r["contract"]["missing_fields"]
    ]
    needs_design = [r for r in records if r["design_labels"]]
    stale_dependency = [r for r in records if r["stale_dependency_labels"]]
    payload: DigestPayload = {
        "open_issue_count": len(records),
        "tracking_issues": sorted(tracking),
        "open_pr_count": len(prs),
        "cache": "MISS",
        "label_coverage": {
            "labeled": len(labeled),
            "contract_ranked": len(contract_ranked),
            "total": len(records),
            # COMPLETE means "every issue has a tier a human settled", which is
            # the condition that makes the research pass unnecessary — the label
            # is still what gets written back, so `unlabeled` stays reported.
            "complete": not unranked,
            "unlabeled": [r["number"] for r in unlabeled],
            "unranked": [r["number"] for r in unranked],
        },
        "contract_coverage": {
            "full": len(full_contract),
            "partial": len(with_contract) - len(full_contract),
            "total": len(records),
            "missing": [r["number"] for r in records if not r["contract"]],
            "incomplete": {
                str(r["number"]): r["contract"]["missing_fields"]
                for r in with_contract
                if r["contract"] and r["contract"]["missing_fields"]
            },
        },
        "needs_design": [r["number"] for r in needs_design],
        "stale_dependency_labels": [r["number"] for r in stale_dependency],
        "ranking": [
            {
                "number": r["number"],
                "title": r["title"],
                "score": r["priority_score"],
                "tier": r["priority_tier"],
                "contract_tier": r["contract_tier"],
                "confirmed_tier": r["confirmed_tier"],
                "suggested_tier": r["suggested_tier"],
                "effective_tier": r["effective_tier"],
                "readiness": r["readiness"],
                "reasons": r["score_reasons"],
                "touches": r["touches"],
                "area": r["area"],
                "depends_on_open": r["depends_on_open"],
                "unblocks_open": r["unblocks_open"],
            }
            for r in ranked
        ],
        "issues": sorted(records, key=lambda r: r["number"]),
    }

    return payload
