#!/usr/bin/env python3
"""review_watch.py — Wait for a PR's Codex reviews and report the latest one.

The pull request's review is the Codex GitHub integration's, posted by the
bot account `chatgpt-codex-connector[bot]`. About 15 s after a PR opens, the bot
posts one issue comment carrying the marker
`<!-- codex-pull-request-review-summary -->` and edits it in place: its table
row holds the review's status (`🔄 **Running**`, then `✅ **Completed**`, each
with a `<relative-time datetime=...>`), the 7-character short commit it
reviewed, and its trigger ("PR opened"). Running to Completed took about
2.5 minutes on uv-template PRs 170 and 171 (observed 2026-10-07). Findings arrive as a
COMMENTED review from the bot (`commit_id` = the reviewed commit) with inline
comments, each starting with a priority badge (`![P1 Badge]`, P0, P2, ...) and
a bold title. A clean review leaves no review and no inline comment; the bot
reacts 👍 on the PR, which this script reports as corroboration only.

Codex may review the PR again after a push: uv-template PRs 184 and 190 ended on a row
naming a fix-push head (observed 2026-10-08). The summary keeps one row,
rewritten for the latest review (a `Manual request` row replaced the opening
one on uv-template PRs 154 and 156), so each review is a round: every completed row
this script sees is remembered in <runstate>/review/<pr>-rounds.json (an older
<pr>-opening.json is still read), and every COMMENTED bot review, posted only
once its review completes, is a round too. Rounds are numbered in the order
they completed and identified by the commit they reviewed, never by trigger
text. Finding numbers follow the reviews' order, so a new round's findings are
appended and earlier numbers never move.

With --after-push SHA, the head just pushed, the call waits --start-grace
seconds, counted from the first call for that SHA, for a review that is not
one of the rounds settled before it to start. One that starts is waited for
and reported as the next round; none starting is NO_NEW_REVIEW, and the latest
settled review stands. Once 3 rounds had settled before the push
(`cap_reached: yes`), it waits for nothing and reports the latest round.

This script only reads. It never asks for a review: no `@codex review`
comment, no close/reopen, no reply to or resolution of a thread.

Usage:
    review_watch.py <pr-number> [--after-push SHA] [--start-grace SECONDS]
                    [--timeout SECONDS] [--grace SECONDS] [--bot LOGIN]
                    [--interval SECONDS] [--findings-file PATH]

  --after-push   the commit just pushed to the PR (7-40 hex). Without it the
             call reports the latest settled round, waiting only while none
             has settled yet (the opening review).
  --start-grace  how long after the first --after-push call for that SHA no
             new review starting means none is coming (default 300).
  --timeout  how long this call waits, in bounded polls (default 900). Run it
             in the background where the host reports completion, or in
             foreground slices under the host's command timeout; each slice
             re-reads the PR from scratch.
  --grace    how long after the PR opened silence from the bot means it is
             not coming (default 900): NO_REVIEW. Measured from the PR's own
             creation time, so slices add up without the caller counting.
  --bot      the trusted reviewer login (default chatgpt-codex-connector[bot]).
             Only a comment, review or reaction by exactly this login counts
             (a login without `[bot]` must also have account type Bot); a
             display name, or a person quoting the marker, never does.
  --interval seconds between polls (default 30).
  --findings-file  where finding bodies are written (default
             <runstate>/review/<pr>-findings.md, outside any checkout).

Prints:
  verdict: CLEAN | FINDINGS | NO_NEW_REVIEW | PENDING_TIMEOUT | NO_REVIEW | ERROR
  pr: <number>
  bot: <login>
  after_push: <SHA> | none
  round: <k> | none   (the round the next six lines describe: the latest
                    settled one, or none while no review has settled)
  rounds: <n>         (reviews settled so far)
  cap_reached: yes | no   (yes once 3 rounds settled: wait for no further one)
  review_status: <the round's status, e.g. Completed> | none
  trigger: <its review trigger> | none
  reviewed_sha: <the commit it read> | none
  head_sha: <the PR's head now> | none
  reviewed_is_head: yes | no   (no after a push no settled review has read)
  completed_at: <its completion time> | none   (compare it with the merge
                    time: a review that completed after the merge is a step
                    10 line)
  thumbs_up: yes | no
  later_review: <status> (<trigger>) for <sha> | none   (a review the summary
                    shows that is not a settled round: running, or failed)
  pr_age_seconds / push_age_seconds (since the first call for --after-push) /
  waited_seconds
  findings: <n> (every round's), round_findings: <n> (this round's), then one
  line per finding:
    - F<n> [P<k>] <path>:<line> id=<comment id> round=<r> — <title>
  findings_file: <path>   (when findings > 0; bodies stay out of this output)
  detail: <why>           (whenever there is one to give)

  CLEAN     the latest round's summary says Completed for a commit of this
            PR and that review left no finding (`thumbs_up:` corroborates;
            neither its presence nor its absence decides the verdict).
  FINDINGS  the latest round left findings; triage every one of that round.
  NO_NEW_REVIEW  --after-push only: no review started on the push within
            --start-grace, or the one that started failed. The latest settled
            round stands, and the PR can land on current-head CI.
  PENDING_TIMEOUT  this call's wait ended first: not posted yet, or still
            running. Run it again; `pr_age_seconds` (opening review) or
            `push_age_seconds` (a review after a push) says how long it waited.
  NO_REVIEW no trace of the bot `--grace` seconds after the PR opened.
  ERROR     the opening review failed or was cancelled, a summary names a
            commit that is not on this PR, the PR is a draft (never
            reviewed), or GitHub could not be read. Never a pass.

Exit codes: 0 = CLEAN, 1 = FINDINGS, 2 = PENDING_TIMEOUT, 3 = NO_REVIEW,
            4 = usage/lookup error or ERROR, 5 = NO_NEW_REVIEW
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, cast

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
if TYPE_CHECKING:
    from review_types import (
        Finding,
        GitHubItem,
        PollState,
        PrState,
        PushWait,
        ReviewRound,
    )

DEFAULT_BOT = "chatgpt-codex-connector[bot]"
SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->"
SKILL_STATE_NAME = "shipping-issues"
REVIEW_CAP = 3

EXIT = {
    "CLEAN": 0,
    "FINDINGS": 1,
    "PENDING_TIMEOUT": 2,
    "NO_REVIEW": 3,
    "ERROR": 4,
    "NO_NEW_REVIEW": 5,
}

FAILED_WORDS = ("fail", "error", "cancel", "timed out", "timeout", "skip", "abort")
BADGE_RE = re.compile(r"!\[(P\d) Badge\]")
IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
SHA_CELL_RE = re.compile(r"`([0-9a-fA-F]{7,40})`")
SHA_ARG_RE = re.compile(r"[0-9a-fA-F]{7,40}")
BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
DATETIME_RE = re.compile(r'datetime="([^"]+)"')
REVIEW_STATES = ("COMMENTED", "CHANGES_REQUESTED")


class ReadError(Exception):
    """A gh read failed; the poll that hit it decides nothing."""


class PrUnreadableError(ReadError):
    """The PR itself could not be read."""


def gh(args: list[str]) -> str:
    try:
        proc = subprocess.run(
            ["gh", *args], capture_output=True, text=True, timeout=120
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        msg = f"gh {' '.join(args[:3])}: {exc}"
        raise ReadError(msg)
    if proc.returncode != 0:
        err = " ".join((proc.stderr or "").split())
        msg = f"gh {' '.join(args[:3])} exited {proc.returncode}" + (
            f": {err}" if err else ""
        )
        raise ReadError(msg)
    return proc.stdout or ""


def gh_items(path: str) -> list[GitHubItem]:
    """Every item of a paginated REST list, one JSON object per line."""
    out = gh(["api", path, "--paginate", "-q", ".[] | @json"])
    items: list[GitHubItem] = []
    for raw in out.splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except ValueError:
            msg = f"unreadable JSON from {path}"
            raise ReadError(msg)
        if isinstance(item, dict):
            items.append(cast("GitHubItem", item))
    return items


def read_pr(pr: str) -> PrState:
    """The PR over REST, in the keys `poll` reads (the GraphQL-backed `gh pr view` is refused by the Claude Code cloud GitHub proxy)."""
    try:
        out = gh(["api", f"repos/{{owner}}/{{repo}}/pulls/{pr}"])
        data = json.loads(out)
    except ReadError as exc:
        raise PrUnreadableError(str(exc))
    except ValueError:
        msg = f"unreadable JSON for PR #{pr}"
        raise PrUnreadableError(msg)
    if not isinstance(data, dict):
        msg = f"unreadable JSON for PR #{pr}"
        raise PrUnreadableError(msg)
    head = data.get("head")
    if data.get("state") == "open":
        state = "OPEN"
    elif data.get("merged_at"):
        state = "MERGED"
    else:
        state = "CLOSED"
    return {
        "headRefOid": cast(
            "str", (head.get("sha") if isinstance(head, dict) else None) or ""
        ),
        "createdAt": cast("str | None", data.get("created_at")),
        "isDraft": bool(data.get("draft")),
        "state": state,
    }


def trusted(item: GitHubItem, bot: str) -> bool:
    """Authored by the bot account itself, matched on the exact login.

    A `[bot]` login belongs to a GitHub App alone: a person's login holds only
    letters, digits and hyphens, so it cannot be spoofed. The account type is
    not enough on its own and not always right — the reactions API reports the
    Codex app's 👍 with type "User" (observed on uv-template PR 170, 2026-10-07) — so a
    `[bot]` login is trusted on the login, and any other login needs type Bot.
    """
    user = item.get("user")
    if user is None:
        return False
    if user.get("login") != bot:
        return False
    return bot.endswith("[bot]") or user.get("type") == "Bot"


def parse_summary(body: str) -> ReviewRound | None:
    """The summary table's code-review row: kind, status, sha, trigger."""
    rows: list[ReviewRound] = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 4:
            continue
        status = BOLD_RE.search(cells[1])
        if not status:
            continue  # the header row or the separator row
        sha = SHA_CELL_RE.search(cells[2])
        when = DATETIME_RE.search(cells[1])
        rows.append(
            {
                "kind": cells[0].replace("*", "").strip(),
                "status": status.group(1).strip(),
                "at": when.group(1) if when else "",
                "sha": sha.group(1).lower() if sha else "",
                "trigger": cells[3] or "none",
            }
        )
    if not rows:
        return None
    for row in rows:
        if "code review" in row["kind"].lower():
            return row
    # Another review's row (a Security Review alone) is never the code review:
    # returning None keeps the caller waiting for a Code Review row.
    return None


def status_class(status: str) -> str:
    lowered = status.lower()
    if "complete" in lowered:
        return "completed"
    if any(word in lowered for word in FAILED_WORDS):
        return "failed"
    return "running"


def finding_title(body: str) -> str:
    first = next((ln for ln in body.splitlines() if ln.strip()), "")
    title = IMAGE_RE.sub("", first)
    title = re.sub(r"</?sub>", "", title).replace("**", "")
    title = " ".join(title.split())
    return (title[:117] + "...") if len(title) > 120 else (title or "(untitled)")


def stamp_seconds(text: str | None) -> float | None:
    """A GitHub timestamp, with or without fractional seconds, as epoch seconds."""
    core = (text or "").strip().removesuffix("Z")
    core, _, fraction = core.partition(".")
    try:
        # strptime rather than fromisoformat: the system python3 may predate
        # 3.11, whose fromisoformat is the first to accept a trailing "Z".
        moment = datetime.strptime(core, "%Y-%m-%dT%H:%M:%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None
    extra = float("0." + fraction) if fraction.isdigit() else 0.0
    return moment.timestamp() + extra


def pr_age_seconds(created_at: str | None) -> int | None:
    opened = stamp_seconds(created_at)
    if opened is None:
        return None
    return max(0, int(time.time() - opened))


def same_commit(one: str | None, other: str | None) -> bool:
    """Two spellings of one commit: a short sha is a prefix of the full one."""
    one, other = (one or "").lower(), (other or "").lower()
    if len(one) < 7 or len(other) < 7:
        return False
    return one.startswith(other) or other.startswith(one)


def collect_findings(
    reviews: list[GitHubItem], inline: list[GitHubItem]
) -> list[Finding]:
    """The bot's top-level inline comments, plus any bot review that carries no inline comment at all (its body is then the finding), ordered by review and then by comment: a later review's findings are always appended."""
    reviewed = {review.get("id"): review.get("commit_id") or "" for review in reviews}
    keyed: list[tuple[tuple[int, int], Finding]] = []
    seen_reviews = set()
    for comment in inline:
        if comment.get("in_reply_to_id"):
            continue
        body = comment.get("body") or ""
        badge = BADGE_RE.search(body)
        line = comment.get("line") or comment.get("original_line") or "?"
        review_id = comment.get("pull_request_review_id")
        seen_reviews.add(review_id)
        keyed.append(
            (
                (review_id or 0, comment.get("id") or 0),
                {
                    "id": str(comment.get("id")),
                    "priority": badge.group(1) if badge else "P?",
                    "where": f"{comment.get('path') or '?'}:{line}",
                    "title": finding_title(body),
                    "commit": (
                        reviewed.get(review_id)
                        or comment.get("original_commit_id")
                        or comment.get("commit_id")
                        or ""
                    ),
                    "url": comment.get("html_url") or "",
                    "body": body,
                },
            )
        )
    for review in reviews:
        if review.get("id") in seen_reviews or review.get("state") not in REVIEW_STATES:
            continue
        keyed.append(
            (
                (review.get("id") or 0, 0),
                {
                    "id": f"review-{review.get('id')}",
                    "priority": "P?",
                    "where": "-",
                    "title": "a review with no inline comment; read its body",
                    "commit": review.get("commit_id") or "",
                    "url": review.get("html_url") or "",
                    "body": review.get("body") or "",
                },
            )
        )
    findings = [finding for _, finding in sorted(keyed, key=lambda pair: pair[0])]
    for number, finding in enumerate(findings, start=1):
        finding["n"] = f"F{number}"
    return findings


_RUNSTATE: list[Path | None] = []


def review_dir() -> Path | None:
    """<runstate>/review for the current repo, resolved once; None if unknown."""
    if not _RUNSTATE:
        try:
            repo = gh(["api", "repos/{owner}/{repo}", "-q", ".full_name"]).strip()
        except ReadError:
            repo = ""
        _RUNSTATE.append(
            state_dir() / SKILL_STATE_NAME / repo.replace("/", "__") / "review"
            if re.fullmatch(r"[^/\s]+/[^/\s]+", repo)
            else None
        )
    return _RUNSTATE[0]


def opening_trigger(trigger: str) -> bool:
    """The automatic review: a PR opened, or a draft marked ready."""
    lowered = trigger.lower()
    return "opened" in lowered or "ready" in lowered


def settled_row(row: object) -> bool:
    return (
        isinstance(row, dict)
        and bool(row.get("sha"))
        and status_class(str(row.get("status") or "")) == "completed"
    )


def read_json(path: Path | None) -> object:
    if path is None:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


class Memory:
    """What earlier calls for this PR saw: its settled rounds, oldest first, and the push the current --after-push wait is about. Kept in <runstate>/review/<pr>-rounds.json when the repo resolves, else for this call only."""

    def __init__(self, pr: str) -> None:
        self.pr = pr
        self.rounds: list[ReviewRound] = []
        self.wait: PushWait | None = None
        self._loaded = False
        self._saved = ""

    def _path(self, name: str) -> Path | None:
        folder = review_dir()
        return None if folder is None else folder / f"{self.pr}-{name}.json"

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        data = read_json(self._path("rounds"))
        if isinstance(data, dict):
            self.rounds = [
                cast("ReviewRound", dict(row))
                for row in data.get("rounds") or []
                if settled_row(row)
            ]
            wait = data.get("await")
            if isinstance(wait, dict) and wait.get("sha"):
                self.wait = cast("PushWait", wait)
        else:
            legacy = read_json(self._path("opening"))
            if isinstance(legacy, dict) and settled_row(legacy):
                self.rounds = [cast("ReviewRound", dict(legacy))]
        self._saved = self._dump()

    def _dump(self) -> str:
        return json.dumps({"rounds": self.rounds, "await": self.wait})

    def save(self) -> None:
        text = self._dump()
        path = self._path("rounds")
        if path is None or text == self._saved:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            self._saved = text
        except OSError:
            pass  # memory is a convenience; the verdict stands without it

    def find(self, sha: str) -> ReviewRound | None:
        return next(
            (row for row in self.rounds if same_commit(row.get("sha"), sha)), None
        )

    def add(self, row: ReviewRound) -> None:
        self.rounds.append(
            {
                "sha": row.get("sha") or "",
                "status": row.get("status") or "",
                "trigger": row.get("trigger") or "",
                "at": row.get("at") or "",
            }
        )

    def order(self) -> None:
        def key(row: ReviewRound) -> tuple[int, float]:
            moment = stamp_seconds(row.get("at"))
            return (0, moment) if moment is not None else (1, 0.0)

        self.rounds.sort(key=key)


def on_pr(pr: str, head: str, sha: str) -> bool:
    """The reviewed commit is the head, or one of the PR's own commits."""
    if same_commit(head, sha):
        return True
    commits = gh(
        [
            "api",
            f"repos/{{owner}}/{{repo}}/pulls/{pr}/commits",
            "--paginate",
            "-q",
            ".[].sha",
        ]
    ).split()
    return any(same_commit(commit, sha) for commit in commits)


def settle_rounds(
    pr: str,
    head: str,
    row: ReviewRound | None,
    reviews: list[GitHubItem],
    memory: Memory,
) -> str:
    """Fold what GitHub shows now into the memory's rounds; returns an ERROR detail, or "" when every completed review is a commit of this PR."""
    kind = status_class(row["status"]) if row else ""
    if row and kind == "completed":
        known = memory.find(row["sha"]) if row["sha"] else None
        if not row["sha"]:
            return "the completed review summary names no reviewed commit"
        if known is None:
            if not on_pr(pr, head, row["sha"]):
                return f"the summary's reviewed commit {row['sha']} is not a commit of PR #{pr}"
            memory.add(row)
        elif known.get("trigger") in ("", "none"):
            known.update(
                {"status": row["status"], "trigger": row["trigger"], "at": row["at"]}
            )
    for review in sorted(reviews, key=lambda r: r.get("id") or 0):
        sha = review.get("commit_id") or ""
        if review.get("state") not in REVIEW_STATES or not sha:
            continue
        if row and kind == "running" and same_commit(row["sha"], sha):
            continue  # its row has not caught up yet: still in progress
        if memory.find(sha) is None:
            memory.add(
                {
                    "sha": sha,
                    "status": "Completed",
                    "trigger": "none",
                    "at": review.get("submitted_at") or "",
                }
            )
    memory.order()
    return ""


def after_push_verdict(
    state: PollState, memory: Memory, after_push: str, start_grace: int, verdict: str
) -> None:
    """Decide an --after-push call once at least one round has settled."""
    rounds = memory.rounds
    later = state["later"]
    later_kind = status_class(later["status"]) if later else ""
    wait = memory.wait
    if not wait or not same_commit(str(wait.get("sha") or ""), after_push):
        # A failed row already showing when the wait begins is not a review
        # of this push: it never ends the grace early.
        stale = [later["sha"], later["at"]] if later and later_kind == "failed" else []
        wait = {
            "sha": after_push,
            "since": time.time(),
            "base": [row["sha"] for row in rounds],
            "outcome": "",
            "stale": stale,
        }
        memory.wait = wait
    if later and [later["sha"], later["at"]] == wait.get("stale"):
        later, later_kind = None, ""
    base = [str(sha) for sha in wait.get("base") or []]
    try:
        since = float(wait.get("since") or 0) or time.time()
    except (TypeError, ValueError):
        since = time.time()
    elapsed = max(0, int(time.time() - since))
    state["push_age"] = elapsed
    pushed = after_push[:7]
    if any(same_commit(row["sha"], after_push) for row in rounds) or any(
        not any(same_commit(row["sha"], sha) for sha in base) for row in rounds
    ):
        state["verdict"] = verdict
    elif len(base) >= REVIEW_CAP:
        state["verdict"] = verdict
        state["detail"] = (
            f"{len(base)} reviews had settled before {pushed} was pushed; "
            f"the cap is {REVIEW_CAP}, so no further review is waited for"
        )
    elif wait.get("outcome") == "none":
        state["verdict"] = "NO_NEW_REVIEW"
        state["detail"] = (
            f"no review started on {pushed} within the start grace "
            "(decided by an earlier call); the latest settled review stands"
        )
    elif later and later_kind == "running":
        state["detail"] = (
            f"a review of {later['sha']} ({later['trigger']}) started "
            f"after the push and is {later['status']!r}"
        )
    elif later and later_kind == "failed":
        wait["outcome"] = "none"
        state["verdict"] = "NO_NEW_REVIEW"
        state["detail"] = (
            f"the review of {later['sha']} ended {later['status']!r}; "
            "the latest settled review stands"
        )
    elif elapsed >= start_grace:
        wait["outcome"] = "none"
        state["verdict"] = "NO_NEW_REVIEW"
        state["detail"] = (
            f"no review started on {pushed} within the {start_grace}s "
            "start grace; the latest settled review stands"
        )
    else:
        state["detail"] = (
            f"no review has started on {pushed} yet ({elapsed}s of the "
            f"{start_grace}s start grace)"
        )


def poll(args: argparse.Namespace, memory: Memory) -> PollState:
    """One full read of the PR's review state. Raises ReadError."""
    pr, bot, grace = args.pr, args.bot, args.grace
    data = read_pr(pr)
    head = data.get("headRefOid") or ""
    age = pr_age_seconds(data.get("createdAt"))
    state: PollState = {
        "head": head,
        "age": age,
        "summary": None,
        "findings": [],
        "verdict": None,
        "detail": "",
        "thumbs_up": False,
        "round": None,
        "rounds": 0,
        "reviewed_is_head": None,
        "later": None,
        "push_age": None,
    }
    if data.get("isDraft"):
        state["verdict"] = "ERROR"
        state["detail"] = (
            f"PR #{pr} is a draft: Codex reviews a PR when it opens "
            "ready or is marked ready, never a draft"
        )
        return state

    base = "repos/{owner}/{repo}"
    comments = [c for c in gh_items(f"{base}/issues/{pr}/comments") if trusted(c, bot)]
    reviews = [r for r in gh_items(f"{base}/pulls/{pr}/reviews") if trusted(r, bot)]
    inline = [c for c in gh_items(f"{base}/pulls/{pr}/comments") if trusted(c, bot)]
    reactions = [
        r for r in gh_items(f"{base}/issues/{pr}/reactions") if trusted(r, bot)
    ]

    summaries = [c for c in comments if SUMMARY_MARKER in (c.get("body") or "")]
    summary = max(
        summaries,
        key=lambda c: (c.get("updated_at") or "", c.get("id") or 0),
        default=None,
    )
    row = parse_summary(summary.get("body") or "") if summary else None
    bot_seen = bool(summaries or reviews or inline or reactions)
    state["thumbs_up"] = any(r.get("content") == "+1" for r in reactions)

    memory.load()
    error = settle_rounds(pr, head, row, reviews, memory)
    memory.save()
    rounds = memory.rounds
    state["rounds"] = len(rounds)
    findings = collect_findings(reviews, inline)
    for finding in findings:
        finding["round"] = next(
            (
                k
                for k, settled in enumerate(rounds, start=1)
                if same_commit(settled["sha"], finding["commit"])
            ),
            len(rounds) + 1,
        )
    state["findings"] = findings
    if row and not any(same_commit(settled["sha"], row["sha"]) for settled in rounds):
        state["later"] = row
    if error:
        state["summary"] = row
        state["verdict"] = "ERROR"
        state["detail"] = error
        return state

    if not rounds:
        state["summary"] = row
        if summary is None:
            if not bot_seen and age is not None and age >= grace:
                state["verdict"] = "NO_REVIEW"
                state["detail"] = (
                    f"no comment, review or reaction from {bot} "
                    f"{age}s after PR #{pr} opened (grace {grace}s)"
                )
            else:
                state["detail"] = "the review summary is not posted yet"
        elif row is None:
            state["detail"] = "the review summary has no Code Review row yet"
        elif status_class(row["status"]) == "failed":
            state["verdict"] = "ERROR"
            state["detail"] = f"the Codex review reported {row['status']!r}"
        elif not opening_trigger(row["trigger"]):
            state["detail"] = (
                f"a later review ({row['trigger']}) is "
                f"{row['status']!r} and this watch never saw an earlier "
                "review complete, so it waits for that one"
            )
        else:
            state["detail"] = f"the Codex review is {row['status']!r}"
        return state

    latest = rounds[-1]
    state["round"] = len(rounds)
    state["summary"] = latest
    state["reviewed_is_head"] = same_commit(head, latest["sha"])
    verdict = (
        "FINDINGS" if any(f["round"] == len(rounds) for f in findings) else "CLEAN"
    )
    if args.after_push:
        after_push_verdict(state, memory, args.after_push, args.start_grace, verdict)
        memory.save()
    else:
        state["verdict"] = verdict
    return state


def state_dir() -> Path:
    env = os.environ.get("AGENT_SKILL_STATE_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".local" / "state" / "agent-skills"


def default_findings_file(pr: str) -> Path:
    folder = review_dir()
    if folder is not None:
        return folder / f"{pr}-findings.md"
    fd, name = tempfile.mkstemp(prefix=f"review-{pr}-", suffix=".md")
    os.close(fd)
    return Path(name)


def write_findings(path: Path, pr: str, findings: list[Finding]) -> None:
    parts = [f"# Review findings for PR #{pr}\n"]
    parts.extend(
        f"## {finding['n']} [{finding['priority']}] {finding['where']} "
        f"id={finding['id']} round={finding['round']}\n\n"
        f"- title: {finding['title']}\n"
        f"- commit: {finding['commit'] or 'unknown'}\n"
        f"- url: {finding['url'] or 'unknown'}\n\n"
        f"{finding['body'].rstrip()}\n"
        for finding in findings
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(parts), encoding="utf-8")


def report(
    verdict: str,
    args: argparse.Namespace,
    state: PollState | None,
    waited: int,
    detail: str,
) -> int:
    state = state or {}
    row = state.get("summary") or {}
    findings = state.get("findings") or []
    age = state.get("age")
    findings_line = ""
    if findings:
        path = (
            Path(args.findings_file)
            if args.findings_file
            else default_findings_file(args.pr)
        )
        try:
            write_findings(path, args.pr, findings)
            findings_line = f"findings_file: {path}"
        except OSError as exc:
            findings_line = f"findings_file: unwritten ({exc})"
            if verdict in ("FINDINGS", "NO_NEW_REVIEW"):
                verdict = "ERROR"
                detail = f"could not write the findings file {path}"
    rounds = state.get("rounds") or 0
    this_round = state.get("round")
    print(f"verdict: {verdict}")
    print(f"pr: {args.pr}")
    print(f"bot: {args.bot}")
    print(f"after_push: {args.after_push or 'none'}")
    print(f"round: {this_round or 'none'}")
    print(f"rounds: {rounds}")
    print(f"cap_reached: {'yes' if rounds >= REVIEW_CAP else 'no'}")
    print(f"review_status: {row.get('status') or 'none'}")
    print(f"trigger: {row.get('trigger') or 'none'}")
    print(f"reviewed_sha: {row.get('sha') or 'none'}")
    print(f"head_sha: {state.get('head') or 'none'}")
    is_head = state.get("reviewed_is_head")
    print(
        f"reviewed_is_head: {'none' if is_head is None else ('yes' if is_head else 'no')}"
    )
    completed = (
        row.get("at") if status_class(row.get("status") or "") == "completed" else ""
    )
    print(f"completed_at: {completed or 'none'}")
    print(f"thumbs_up: {'yes' if state.get('thumbs_up') else 'no'}")
    later = state.get("later")
    print(
        "later_review: "
        + (
            f"{later['status']} ({later['trigger']}) for {later['sha'] or '?'}"
            if later
            else "none"
        )
    )
    print(f"pr_age_seconds: {age if age is not None else 'unknown'}")
    push_age = state.get("push_age")
    print(f"push_age_seconds: {push_age if push_age is not None else 'none'}")
    print(f"waited_seconds: {waited}")
    print(f"findings: {len(findings)}")
    print(f"round_findings: {sum(1 for f in findings if f['round'] == this_round)}")
    for finding in findings:
        print(
            f"  - {finding['n']} [{finding['priority']}] {finding['where']} "
            f"id={finding['id']} round={finding['round']} — {finding['title']}"
        )
    if findings_line:
        print(findings_line)
    if detail:
        print(f"detail: {detail}")
    return EXIT[verdict]


def parse_args(argv: list[str]) -> argparse.Namespace | None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("pr", nargs="?")
    parser.add_argument("--after-push", default="")
    parser.add_argument("--start-grace", default="300")
    parser.add_argument("--timeout", default="900")
    parser.add_argument("--grace", default="900")
    parser.add_argument("--interval", default="30")
    parser.add_argument("--bot", default=DEFAULT_BOT)
    parser.add_argument("--findings-file", default="")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        print(f"Unknown argument: {unknown[0]}", file=sys.stderr)
        return None
    if not args.pr or not args.pr.lstrip("#").isdigit():
        print(
            "Usage: review_watch.py <pr-number> [--after-push SHA] [--timeout SECONDS] "
            "[--bot LOGIN]",
            file=sys.stderr,
        )
        return None
    args.pr = args.pr.lstrip("#")
    if args.after_push and not SHA_ARG_RE.fullmatch(args.after_push):
        print(
            f"--after-push needs a commit SHA (7-40 hex digits), got: {args.after_push}",
            file=sys.stderr,
        )
        return None
    for name in ("timeout", "grace", "interval", "start_grace"):
        value = getattr(args, name)
        if not str(value).isdigit():
            print(
                f"--{name.replace('_', '-')} needs a whole number of seconds, "
                f"got: {value}",
                file=sys.stderr,
            )
            return None
        setattr(args, name, int(value))
    if not args.bot.strip():
        print("--bot needs a login", file=sys.stderr)
        return None
    return args


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] in (["-h"], ["--help"]):
        print(__doc__)
        return 0
    args = parse_args(argv)
    if args is None:
        return 4

    memory = Memory(args.pr)
    start = time.monotonic()
    deadline = start + args.timeout
    state: PollState | None = None
    last_error = ""
    first = True
    while True:
        try:
            state = poll(args, memory)
            last_error = ""
        except ReadError as exc:
            last_error = str(exc)
            # A PR that cannot be read on the first poll is a wrong number or
            # a lost token, not a slow reviewer: say so now, not at the end.
            if first and isinstance(exc, PrUnreadableError):
                return report(
                    "ERROR",
                    args,
                    state,
                    0,
                    f"could not read PR #{args.pr}: {last_error}",
                )
        first = False
        waited = int(time.monotonic() - start)
        if state and state["verdict"] and not last_error:
            return report(state["verdict"], args, state, waited, state["detail"])
        if time.monotonic() >= deadline:
            if last_error:
                return report(
                    "ERROR", args, state, waited, f"the last read failed: {last_error}"
                )
            return report(
                "PENDING_TIMEOUT",
                args,
                state,
                waited,
                (state or {}).get("detail") or "still waiting",
            )
        time.sleep(max(0.0, min(args.interval, deadline - time.monotonic())))


if __name__ == "__main__":
    sys.exit(main())
