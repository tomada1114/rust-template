"""JSON boundary and review-watch state records."""

from __future__ import annotations

from typing import TypedDict


class BotAccount(TypedDict, total=False):
    login: str
    type: str


class GitHubItem(TypedDict, total=False):
    id: int
    user: BotAccount
    body: str | None
    state: str
    commit_id: str | None
    original_commit_id: str | None
    submitted_at: str | None
    updated_at: str | None
    in_reply_to_id: int | None
    pull_request_review_id: int | None
    line: int | None
    original_line: int | None
    path: str | None
    html_url: str | None
    content: str


class PrState(TypedDict):
    headRefOid: str
    createdAt: str | None
    isDraft: bool
    state: str


class ReviewRound(TypedDict, total=False):
    kind: str
    status: str
    at: str
    sha: str
    trigger: str


class PushWait(TypedDict, total=False):
    sha: str
    since: float | str | None
    base: list[str]
    outcome: str
    stale: list[str]


class Finding(TypedDict, total=False):
    id: str
    priority: str
    where: str
    title: str
    commit: str
    url: str
    body: str
    n: str
    round: int


class PollState(TypedDict, total=False):
    head: str
    age: int | None
    summary: ReviewRound | None
    findings: list[Finding]
    verdict: str | None
    detail: str
    thumbs_up: bool
    round: int | None
    rounds: int
    reviewed_is_head: bool | None
    later: ReviewRound | None
    push_age: int | None
