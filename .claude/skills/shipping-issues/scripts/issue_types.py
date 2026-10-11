"""Typed records at the digest's JSON boundary and between its stages."""

from __future__ import annotations

from typing import TypedDict


class Label(TypedDict):
    name: str


class Account(TypedDict):
    login: str


class Milestone(TypedDict):
    title: str


class ClosingReference(TypedDict):
    number: int
    url: str


class RawIssue(TypedDict, total=False):
    number: int
    title: str
    url: str
    body: str | None
    labels: list[Label]
    assignees: list[Account]
    milestone: Milestone | None
    createdAt: str
    updatedAt: str


class RawPr(TypedDict, total=False):
    number: int
    title: str
    body: str | None
    url: str
    headRefName: str
    isDraft: bool
    closingIssuesReferences: list[ClosingReference]


class ShipContract(TypedDict):
    fields: list[str]
    unknown_fields: list[str]
    missing_fields: list[str]
    tier: str | None
    area: str | None
    depends_on: list[int]
    blocks: list[int]
    touches: list[str]
    design: str | None


class OpenPr(TypedDict):
    number: int
    url: str
    draft: bool


class IssueRecord(TypedDict, total=False):
    number: int
    title: str
    url: str
    labels: list[str]
    assignees: list[str]
    milestone: str | None
    created_at: str
    updated_at: str
    depends_on: list[int]
    blocks: list[int]
    mentions: list[int]
    depends_on_open: list[int]
    unblocks_open: list[int]
    referenced_by_open: list[int]
    not_ready_labels: list[str]
    design_labels: list[str]
    stale_dependency_labels: list[str]
    open_pr: OpenPr | None
    body: str
    contract: ShipContract | None
    contract_tier: str | None
    area: str | None
    touches: list[str]
    priority_score: int
    score_reasons: list[str]
    priority_tier: str | None
    suggested_tier: str
    suggested_reason: str
    confirmed_tier: str | None
    effective_tier: str
    readiness: str


class RankingRow(TypedDict):
    number: int
    title: str
    score: int
    tier: str | None
    contract_tier: str | None
    confirmed_tier: str | None
    suggested_tier: str
    effective_tier: str
    readiness: str
    reasons: list[str]
    touches: list[str]
    area: str | None
    depends_on_open: list[int]
    unblocks_open: list[int]


class LabelCoverage(TypedDict):
    labeled: int
    contract_ranked: int
    total: int
    complete: bool
    unlabeled: list[int]
    unranked: list[int]


class ContractCoverage(TypedDict):
    full: int
    partial: int
    total: int
    missing: list[int]
    incomplete: dict[str, list[str]]


class DigestPayload(TypedDict):
    open_issue_count: int
    tracking_issues: list[int]
    open_pr_count: int
    cache: str
    label_coverage: LabelCoverage
    contract_coverage: ContractCoverage
    needs_design: list[int]
    stale_dependency_labels: list[int]
    ranking: list[RankingRow]
    issues: list[IssueRecord]


class PlanPayload(TypedDict):
    preflight: dict[str, str]
    mode: str
    plan_mode: str
    grouping: str
    undeclared_touches: list[int]
    max_parallel: int
    batches: list[list[int]]
    branches: dict[int, str]
    select: int | None
    select_hold: str | None
    next_command: str
    label_coverage: LabelCoverage
    contract_coverage: ContractCoverage
    needs_design: list[int]
    tracking_issues: list[int]
    stale_dependency_labels: list[int]
    cache: str | None
    open_issue_count: int
    open_pr_count: int
    profile_cache: str
