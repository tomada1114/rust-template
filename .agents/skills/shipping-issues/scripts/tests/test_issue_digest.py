#!/usr/bin/env python3
"""Tests for issue_digest.py. Stdlib-only (unittest).

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
"""

from __future__ import annotations

import datetime as _dt
import io
import json
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import issue_digest as idg
import issue_records
from _fakegh import FakeGh


def gh_issue(
    number,
    title="issue",
    labels=None,
    *,
    body="",
    updated=None,
    created=None,
    milestone=None,
    assignees=None,
):
    updated = updated or "2026-01-01T00:00:00Z"
    created = created or updated
    return {
        "number": number,
        "title": title,
        "labels": [{"name": n} for n in (labels or [])],
        "assignees": [{"login": a} for a in (assignees or [])],
        "milestone": {"title": milestone} if milestone else None,
        "body": body,
        "createdAt": created,
        "updatedAt": updated,
        "url": f"https://github.com/acme/widgets/issues/{number}",
    }


def gh_pr(number, title="pr", body="", head="feature", draft=False):
    return {
        "number": number,
        "title": title,
        "body": body,
        "headRefName": head,
        "isDraft": draft,
        "url": f"https://github.com/acme/widgets/pull/{number}",
    }


class NormalizeLabelTest(unittest.TestCase):
    def test_collapses_separators_and_case(self):
        self.assertEqual(idg.normalize_label("Priority: P0"), "priority:p0")
        self.assertEqual(idg.normalize_label("priority/P0"), "priority:p0")
        self.assertEqual(idg.normalize_label(" p0 "), "p0")


class SqueezeTest(unittest.TestCase):
    def test_zero_limit_returns_empty(self):
        self.assertEqual(idg.squeeze("hello world", 0), "")

    def test_none_text_returns_empty(self):
        self.assertEqual(idg.squeeze(None, 100), "")

    def test_strips_html_comments_and_images(self):
        text = "before <!-- hidden --> ![alt](x.png) after"
        self.assertEqual(idg.squeeze(text, 100), "before after")

    def test_collapses_code_blocks(self):
        text = "see\n```\ndef f(): pass\n```\ndone"
        self.assertIn("[code block]", idg.squeeze(text, 200))

    def test_demotes_headings(self):
        text = "# Title\nbody"
        self.assertTrue(idg.squeeze(text, 200).startswith("▸ Title"))

    def test_truncates_over_limit(self):
        text = "x" * 50
        out = idg.squeeze(text, 10)
        self.assertTrue(out.endswith("…[truncated]"))
        self.assertLessEqual(len(out) - len(" …[truncated]"), 10)


class ExtractDepsTest(unittest.TestCase):
    def test_depends_on_pattern(self):
        deps = idg.extract_deps("blocked by #5", "t", self_number=1)
        self.assertEqual(deps["depends_on"], [5])

    def test_comma_separated_list_yields_every_number(self):
        deps = idg.extract_deps("Depends on: #1, #2", "t", self_number=9)
        self.assertEqual(deps["depends_on"], [1, 2])

    def test_and_separated_list_yields_every_number(self):
        deps = idg.extract_deps("Depends on: #1 and #2", "t", self_number=9)
        self.assertEqual(deps["depends_on"], [1, 2])

    def test_mixed_list_after_blocked_by_and_requires(self):
        deps = idg.extract_deps(
            "Blocked by: #3, #4, and #5\nRequires: #6 and #7", "t", self_number=9
        )
        self.assertEqual(deps["depends_on"], [3, 4, 5, 6, 7])

    def test_blocks_pattern(self):
        deps = idg.extract_deps("this blocks #9", "t", self_number=1)
        self.assertEqual(deps["blocks"], [9])

    def test_self_reference_excluded(self):
        deps = idg.extract_deps("depends on #1", "t", self_number=1)
        self.assertEqual(deps["depends_on"], [])

    def test_bare_reference_becomes_mention(self):
        deps = idg.extract_deps("see #7 for context", "t", self_number=1)
        self.assertEqual(deps["mentions"], [7])
        self.assertEqual(deps["depends_on"], [])

    def test_bare_reference_not_double_counted_with_explicit(self):
        deps = idg.extract_deps("depends on #5, see also #5", "t", self_number=1)
        self.assertEqual(deps["depends_on"], [5])
        self.assertEqual(deps["mentions"], [])

    def test_japanese_dependency_phrasing(self):
        deps = idg.extract_deps("#5 に依存", "t", self_number=1)
        self.assertEqual(deps["depends_on"], [5])

    def test_japanese_after_phrasings_still_parse(self):
        deps = idg.extract_deps("#5 の後、#6 完了後", "t", self_number=1)
        self.assertEqual(deps["depends_on"], [5, 6])

    def test_bare_after_in_prose_is_only_a_mention(self):
        # Issue #25's scope note: "after #19" there was chronology, not an edge.
        sentence = "a Claude Code cloud session gets Node.js 24 through #40, after #19"
        deps = idg.extract_deps(sentence, "t", self_number=25)
        self.assertEqual(deps["depends_on"], [])
        self.assertEqual(deps["mentions"], [19, 40])


class StructuredDependencySourcesTest(unittest.TestCase):
    def _record(self, issues, number):
        payload = idg.build_records(issues, [], body_chars=0)
        return next(r for r in payload["issues"] if r["number"] == number)

    def test_issue_25_contract_edges_win_over_prose(self):
        body = (
            "Scope: a Claude Code cloud session gets Node.js 24 through #40, after #19.\n"
            "Blocked by #19 in spirit only.\n\n"
            "<!-- ship: tier=P1 blocked-by=#7,#8 touches=* -->"
        )
        issues = [gh_issue(25, body=body), gh_issue(19), gh_issue(7), gh_issue(8)]
        rec = self._record(issues, 25)
        self.assertEqual(rec["depends_on"], [7, 8])
        self.assertIn(19, rec["mentions"])
        self.assertNotIn(19, rec["depends_on_open"])

    def test_contract_blocked_by_none_drops_prose_edges(self):
        body = "requires #3 to be reviewed\n<!-- ship: tier=P2 blocked-by=none touches=* -->"
        rec = self._record([gh_issue(1, body=body), gh_issue(3)], 1)
        self.assertEqual(rec["depends_on"], [])

    def test_depends_on_lines_win_over_prose(self):
        body = "Blocked by #3 in prose.\n\n## Dependencies\n\n- Depends on: #4\nDepends on: #5"
        issues = [gh_issue(1, body=body)] + [gh_issue(n) for n in (3, 4, 5)]
        rec = self._record(issues, 1)
        self.assertEqual(rec["depends_on"], [4, 5])
        self.assertIn(3, rec["mentions"])

    def test_depends_on_line_in_code_does_not_override_prose(self):
        for example in (
            "```\nDepends on: #99\n```",
            "    Depends on: #99",
            "`Depends on: #99`",
            "<!--\nDepends on: #99\n-->",
            "<!-- Depends on: #99 -->",
        ):
            with self.subTest(example=example):
                body = f"Blocked by #3.\n\nExample:\n\n{example}\n"
                issues = [gh_issue(1, body=body), gh_issue(3), gh_issue(99)]
                rec = self._record(issues, 1)
                # The quoted line is no stated source, so the prose blocker
                # stays an edge (prose reading itself does not skip code).
                self.assertIn(3, rec["depends_on"])
                self.assertIn(3, rec["depends_on_open"])

    def test_comment_opener_in_code_does_not_hide_a_stated_line(self):
        body = "Use `<!--` to begin a comment. Blocked by #3.\n\nDepends on: #4\n"
        issues = [gh_issue(1, body=body), gh_issue(3), gh_issue(4)]
        rec = self._record(issues, 1)
        self.assertEqual(rec["depends_on"], [4])

    def test_real_comment_after_a_quoted_opener_still_hides_its_line(self):
        body = (
            "Use `<!--` to begin a comment. Blocked by #3.\n\n"
            "<!--\nDepends on: #99\n-->\n"
        )
        issues = [gh_issue(1, body=body), gh_issue(3), gh_issue(99)]
        rec = self._record(issues, 1)
        self.assertIn(3, rec["depends_on_open"])

    def test_ordered_and_task_list_depends_on_lines_are_stated(self):
        for line in (
            "1. Depends on: #4",
            "2) Depends on: #4",
            "- [ ] Depends on: #4",
            "* [x] Depends on: #4",
        ):
            with self.subTest(line=line):
                body = f"Blocked by #3.\n\n{line}\n"
                issues = [gh_issue(1, body=body), gh_issue(3), gh_issue(4)]
                rec = self._record(issues, 1)
                self.assertEqual(rec["depends_on"], [4])

    def test_contract_without_blocked_by_keeps_prose_edges(self):
        body = "depends on #3\n<!-- ship: tier=P2 touches=* -->"
        rec = self._record([gh_issue(1, body=body), gh_issue(3)], 1)
        self.assertEqual(rec["depends_on"], [3])


class DaysSinceTest(unittest.TestCase):
    def test_recent_date_is_zero_or_more(self):
        today = _dt.date.today().isoformat()
        self.assertEqual(idg.days_since(today), 0)

    def test_invalid_date_returns_none(self):
        self.assertIsNone(idg.days_since("not-a-date"))

    def test_none_returns_none(self):
        self.assertIsNone(idg.days_since(None))


class CanonicalTierTest(unittest.TestCase):
    def test_no_label_returns_none(self):
        self.assertIsNone(idg.canonical_tier(["bug"]))

    def test_recognizes_canonical_and_alias(self):
        self.assertEqual(idg.canonical_tier(["priority: P1"]), "P1")
        self.assertEqual(idg.canonical_tier(["critical"]), "P0")

    def test_highest_tier_wins_when_both_present(self):
        self.assertEqual(idg.canonical_tier(["priority: P2", "critical"]), "P0")


class SuggestTierTest(unittest.TestCase):
    def _rec(self, unblocks_open=()):
        return {"unblocks_open": list(unblocks_open)}

    def test_unblocking_others_is_p0(self):
        tier, reason = idg.suggest_tier(self._rec(unblocks_open=[3]), set(), 0)
        self.assertEqual(tier, "P0")
        self.assertIn("unblocks", reason)

    def test_urgent_leverage_is_p0(self):
        tier, reason = idg.suggest_tier(self._rec(), {"security"}, 0)
        self.assertEqual(tier, "P0")
        self.assertEqual(reason, "security")

    def test_high_score_alone_is_p0(self):
        tier, reason = idg.suggest_tier(self._rec(), set(), idg.SUGGEST_P0_SCORE)
        self.assertEqual(tier, "P0")

    def test_foundation_leverage_is_p1(self):
        tier, reason = idg.suggest_tier(self._rec(), {"schema"}, 0)
        self.assertEqual(tier, "P1")

    def test_mid_score_is_p1(self):
        tier, _ = idg.suggest_tier(self._rec(), set(), idg.SUGGEST_P1_SCORE)
        self.assertEqual(tier, "P1")

    def test_low_positive_score_is_p2(self):
        tier, _ = idg.suggest_tier(self._rec(), set(), idg.SUGGEST_P2_SCORE)
        self.assertEqual(tier, "P2")

    def test_zero_score_is_p3(self):
        tier, _ = idg.suggest_tier(self._rec(), set(), 0)
        self.assertEqual(tier, "P3")


class ScoreIssueTest(unittest.TestCase):
    def _base_rec(self, **over):
        # Neither stale (>= STALE_DAYS) nor fresh (<= FRESH_DAYS): a neutral
        # age so the staleness/freshness bonus never perturbs the assertions
        # below, which are about the *other* scoring inputs.
        neutral = (_dt.date.today() - _dt.timedelta(days=90)).isoformat()
        rec = {
            "unblocks_open": [],
            "referenced_by_open": [],
            "labels": [],
            "title": "t",
            "milestone": None,
            "updated_at": neutral,
        }
        rec.update(over)
        return rec

    def test_unblocks_scored_and_capped(self):
        rec = self._base_rec(unblocks_open=[1, 2, 3])
        score, parts, hits = idg.score_issue(rec, "")
        self.assertEqual(score, idg.UNBLOCK_POINTS * 3)
        self.assertTrue(any("unblocks" in p for p in parts))

    def test_unblocks_capped_at_ceiling(self):
        rec = self._base_rec(unblocks_open=list(range(10)))
        score, _, _ = idg.score_issue(rec, "")
        self.assertEqual(score, idg.UNBLOCK_CAP)

    def test_tier_label_does_not_add_score(self):
        rec = self._base_rec(labels=["priority: P0"])
        score, parts, _ = idg.score_issue(rec, "")
        self.assertEqual(score, 0)
        self.assertEqual(parts, [])

    def test_weighted_label_adds_score(self):
        rec = self._base_rec(labels=["bug"])
        score, parts, _ = idg.score_issue(rec, "")
        self.assertEqual(score, idg.PRIORITY_LABEL_WEIGHTS["bug"])

    def test_leverage_keyword_detected_and_capped(self):
        rec = self._base_rec(title="fix CVE-2026-1 injection vulnerability")
        score, parts, hits = idg.score_issue(rec, "")
        self.assertIn("security", hits)
        self.assertLessEqual(score, idg.LEVERAGE_CAP)

    def test_milestone_adds_two(self):
        rec = self._base_rec(milestone="v1")
        score, parts, _ = idg.score_issue(rec, "")
        self.assertEqual(score, 2)

    def test_stale_issue_penalized(self):
        old = (_dt.date.today() - _dt.timedelta(days=idg.STALE_DAYS + 1)).isoformat()
        rec = self._base_rec(updated_at=old)
        score, parts, _ = idg.score_issue(rec, "")
        self.assertEqual(score, -1)

    def test_fresh_issue_rewarded(self):
        recent = (_dt.date.today() - _dt.timedelta(days=1)).isoformat()
        rec = self._base_rec(updated_at=recent)
        score, parts, _ = idg.score_issue(rec, "")
        self.assertEqual(score, 1)


class TierCellTest(unittest.TestCase):
    def test_no_label_shows_suggestion_only(self):
        rec = {"priority_tier": None, "suggested_tier": "P1"}
        self.assertEqual(idg.tier_cell(rec), "~P1")

    def test_matching_label_shown_plain(self):
        rec = {"priority_tier": "P1", "suggested_tier": "P1"}
        self.assertEqual(idg.tier_cell(rec), "P1")

    def test_label_lower_than_suggestion_shows_both(self):
        rec = {"priority_tier": "P2", "suggested_tier": "P0"}
        self.assertEqual(idg.tier_cell(rec), "P2(~P0)")

    def test_label_higher_than_suggestion_shown_plain(self):
        rec = {"priority_tier": "P0", "suggested_tier": "P2"}
        self.assertEqual(idg.tier_cell(rec), "P0")


class ReadinessTest(unittest.TestCase):
    def test_blocked_by_wins_over_everything(self):
        rec = {
            "depends_on_open": [3],
            "not_ready_labels": ["blocked"],
            "design_labels": [],
            "open_pr": {"number": 1},
        }
        self.assertEqual(idg.readiness(rec), "BLOCKED-BY:#3")

    def test_not_ready_label_next(self):
        rec = {
            "depends_on_open": [],
            "not_ready_labels": ["question"],
            "design_labels": [],
            "open_pr": {"number": 1},
        }
        self.assertEqual(idg.readiness(rec), "LABEL:question")

    def test_open_pr_next(self):
        rec = {
            "depends_on_open": [],
            "not_ready_labels": [],
            "design_labels": [],
            "open_pr": {"number": 7},
        }
        self.assertEqual(idg.readiness(rec), "HAS-PR:#7")

    def test_ready_when_nothing_blocks(self):
        rec = {
            "depends_on_open": [],
            "not_ready_labels": [],
            "design_labels": [],
            "open_pr": None,
        }
        self.assertEqual(idg.readiness(rec), "READY")

    def test_design_label_blocks_by_default(self):
        rec = {
            "depends_on_open": [],
            "not_ready_labels": [],
            "design_labels": ["blocked: design"],
            "open_pr": None,
        }
        self.assertEqual(idg.readiness(rec), "DESIGN:blocked: design")

    def test_design_label_wins_over_open_pr(self):
        rec = {
            "depends_on_open": [],
            "not_ready_labels": [],
            "design_labels": ["needs-design"],
            "open_pr": {"number": 7},
        }
        self.assertEqual(idg.readiness(rec), "DESIGN:needs-design")

    def test_not_ready_label_wins_over_design_label(self):
        rec = {
            "depends_on_open": [],
            "not_ready_labels": ["blocked"],
            "design_labels": ["blocked: design"],
            "open_pr": None,
        }
        self.assertEqual(idg.readiness(rec), "LABEL:blocked")

    def test_allow_design_treats_design_label_as_ready(self):
        rec = {
            "depends_on_open": [],
            "not_ready_labels": [],
            "design_labels": ["blocked: design"],
            "open_pr": None,
        }
        self.assertEqual(idg.readiness(rec, allow_design=True), "READY")

    def test_allow_design_still_respects_open_pr(self):
        rec = {
            "depends_on_open": [],
            "not_ready_labels": [],
            "design_labels": ["blocked: design"],
            "open_pr": {"number": 7},
        }
        self.assertEqual(idg.readiness(rec, allow_design=True), "HAS-PR:#7")


class DesignBlockLabelsTest(unittest.TestCase):
    def test_normalized_equivalents_all_recognized(self):
        for name in (
            "blocked: design",
            "Blocked: Design",
            "blocked/design",
            "needs design",
            "needs-design",
            "needs:design",
            "design-needed",
        ):
            self.assertIn(
                idg.normalize_label(name),
                idg.DESIGN_BLOCK_LABELS,
                f"{name!r} should be a recognized design-block label",
            )

    def test_unrelated_label_not_recognized(self):
        self.assertNotIn(idg.normalize_label("bug"), idg.DESIGN_BLOCK_LABELS)


class DependencyBlockLabelsTest(unittest.TestCase):
    def test_normalized_equivalents_all_recognized(self):
        for name in (
            "blocked: dependency",
            "Blocked: Dependency",
            "blocked/dependency",
            "blocked-by-dependency",
            "blocked: dependencies",
            "waiting on dependency",
        ):
            self.assertIn(
                idg.normalize_label(name),
                idg.DEPENDENCY_BLOCK_LABELS,
                f"{name!r} should be a recognized dependency-block label",
            )

    def test_bare_blocked_not_recognized(self):
        # Deliberately excluded — ambiguous with READY_NEGATIVE_LABELS's
        # general "blocked" and not specific to a dependency edge.
        self.assertNotIn(idg.normalize_label("blocked"), idg.DEPENDENCY_BLOCK_LABELS)

    def test_unrelated_label_not_recognized(self):
        self.assertNotIn(idg.normalize_label("bug"), idg.DEPENDENCY_BLOCK_LABELS)


class ResolveDesignLabelTest(unittest.TestCase):
    def test_canonical_present_is_reused(self):
        name, needs_create = idg.resolve_design_label(["blocked: design", "bug"])
        self.assertEqual(name, "blocked: design")
        self.assertFalse(needs_create)

    def test_alias_present_is_reused_not_duplicated(self):
        name, needs_create = idg.resolve_design_label(["needs-design"])
        self.assertEqual(name, "needs-design")
        self.assertFalse(needs_create)

    def test_shortest_alias_wins_when_repo_carries_several(self):
        name, needs_create = idg.resolve_design_label(
            ["needs design", "needs-design", "design-needed"]
        )
        # "needs design"/"needs-design" tie on length (12); the tie-break is
        # plain string ordering (min()'s documented behavior) rather than a
        # meaningful preference, and a space sorts before a hyphen.
        self.assertEqual(name, "needs design")
        self.assertFalse(needs_create)

    def test_no_equivalent_creates_canonical(self):
        name, needs_create = idg.resolve_design_label(["bug", "priority: P0"])
        self.assertEqual(name, "blocked: design")
        self.assertTrue(needs_create)


# The repository root, five levels above this file in either skill tree
# (.agents/skills/... or its .claude/skills/... mirror).
LABELS_YML = Path(__file__).resolve().parents[5] / ".github" / "labels.yml"


def declared_labels() -> dict[str, tuple[str, str]]:
    """name -> (color, description) from .github/labels.yml, read with a regex
    so the test stays stdlib-only."""
    text = LABELS_YML.read_text(encoding="utf-8")
    entries = re.findall(
        r'^- name: "?([^"\n]+?)"?\n\s+color: "?(\w+)"?\n\s+description: "([^"]*)"',
        text,
        re.MULTILINE,
    )
    return {name: (color, desc) for name, color, desc in entries}


@unittest.skipUnless(LABELS_YML.is_file(), "no .github/labels.yml above this skill")
class LabelDefinitionsMatchLabelsYmlTest(unittest.TestCase):
    """The scripts never create a label, so the constants only name what
    `just labels` defines; they must not drift from it."""

    def test_tracking_label_is_declared_in_labels_yml(self):
        # The digest drops an issue by this name, so the label it reads must be
        # one `just labels` actually creates.
        self.assertIn("tracking", declared_labels())
        self.assertIn(idg.normalize_label("tracking"), idg.TRACKING_LABELS)

    def test_tier_and_design_labels_match_labels_yml(self):
        declared = declared_labels()
        for name, color, desc in [*idg.TIER_LABELS.values(), idg.DESIGN_LABEL]:
            with self.subTest(label=name):
                self.assertEqual(declared.get(name), (color, desc))


class DigestRunner:
    """Runs main() in-process (not via subprocess) against a fake `gh` on
    PATH, so coverage sees the code these tests exercise. Only the external
    `gh` process itself is out of process — issue_digest.py's own code runs
    in this interpreter.

    A mixin rather than a base TestCase: several classes below need `_run`, and
    inheriting it from a TestCase would re-run that class's own tests inside
    each of them."""

    def _run(
        self,
        args,
        issues,
        prs=None,
        *,
        path_override=None,
        state_dir=None,
        cache=False,
        extra=None,
    ):
        """Run main() once. `cache=True` re-enables the digest cache (FakeGh
        disables it by default) and `state_dir` pins where it lives, so a test
        can drive two calls through one cache and count the gh invocations."""
        responses = {
            ("issue", "list"): json.dumps(issues),
            ("pr", "list"): json.dumps(prs or []),
            **(extra or {}),
        }
        with FakeGh(responses) as fake:
            env = dict(fake.env)
            if path_override is not None:
                env["PATH"] = path_override
            if cache:
                env.pop("SHIPPING_ISSUES_NO_CACHE", None)
            if state_dir is not None:
                env["AGENT_SKILL_STATE_DIR"] = str(state_dir)
            self.last_calls = fake
            out, err = io.StringIO(), io.StringIO()
            with (
                patch.dict("os.environ", env, clear=False),
                patch.object(sys, "argv", ["issue_digest.py", *args]),
                redirect_stdout(out),
                redirect_stderr(err),
            ):
                try:
                    rc = idg.main()
                except SystemExit as exc:
                    rc = exc.code
            self.gh_calls = fake.calls
        return rc, out.getvalue(), err.getvalue()


class MainEndToEndTest(DigestRunner, unittest.TestCase):
    def test_library_ranks_fetched_records_without_a_subprocess(self):
        issues = [
            gh_issue(1, title="small task", labels=["priority: P2"]),
            gh_issue(2, title="blocking task", body="Blocks: #1"),
        ]
        rc, out, err = self._run(["--json", "--body-chars", "0"], issues)
        self.assertEqual(rc, 0, err)
        with patch("subprocess.run", side_effect=AssertionError("unexpected fetch")):
            payload = idg.build_records(issues, [], body_chars=0)
        self.assertEqual(payload, json.loads(out))

    def test_select_reports_top_ready_issue(self):
        issues = [
            gh_issue(1, title="unlabeled small thing"),
            gh_issue(2, title="ship now", labels=["priority: P0"]),
        ]
        rc, out, err = self._run(["--select", "--json"], issues)
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["ranking"][0]["number"], 2)
        self.assertEqual(payload["ranking"][0]["tier"], "P0")

    def test_tracking_issue_is_never_ranked_selected_or_offered_a_tier(self):
        issues = [
            gh_issue(
                96,
                title="back-port harness (tracking)",
                labels=["tracking"],
                body="- [ ] #97\n- [ ] #98",
            ),
            gh_issue(95, title="old umbrella", labels=["Epic", "priority: P0"]),
            gh_issue(97, title="the work", labels=["priority: P2"]),
            gh_issue(98, title="untiered work"),
        ]
        rc, out, err = self._run(["--select", "--json"], issues)
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["tracking_issues"], [95, 96])
        self.assertEqual(payload["open_issue_count"], 2)
        for key in ("ranking", "issues"):
            self.assertNotIn(96, [r["number"] for r in payload[key]])
            self.assertNotIn(95, [r["number"] for r in payload[key]])
        self.assertEqual(payload["label_coverage"]["unlabeled"], [98])

        rc, out, err = self._run(["--select"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #97", out)
        self.assertIn("tracking: #95, #96", out)

        rc, out, err = self._run([], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("tracking: #95, #96", out)
        self.assertNotIn("back-port harness", out)

    def test_on_hold_issue_keeps_its_tier_unlike_a_tracking_issue(self):
        issues = [gh_issue(5, title="parked work", labels=["on hold", "priority: P1"])]
        rc, out, err = self._run(["--json"], issues)
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["tracking_issues"], [])
        row = payload["ranking"][0]
        self.assertEqual(
            (row["number"], row["tier"], row["readiness"]), (5, "P1", "LABEL:on hold")
        )

    def test_select_text_output_names_the_pick(self):
        issues = [gh_issue(2, title="ship now", labels=["priority: P0"])]
        rc, out, err = self._run(["--select"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #2", out)

    def test_blocked_issue_is_never_selected(self):
        issues = [
            gh_issue(
                1, title="blocked one", labels=["priority: P0"], body="depends on #2"
            ),
            gh_issue(2, title="the blocker", labels=["priority: P3"]),
        ]
        rc, out, err = self._run(["--select"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #2", out)
        self.assertNotIn("select: #1", out)

    def test_design_labeled_issue_excluded_from_select_by_default(self):
        issues = [
            gh_issue(
                3,
                title="needs a design call",
                labels=["priority: P0", "blocked: design"],
            ),
            gh_issue(4, title="ready to go", labels=["priority: P2"]),
        ]
        rc, out, err = self._run(["--select"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #4", out)
        self.assertNotIn("select: #3", out)
        self.assertIn("needs-design: #3", out)
        self.assertIn(
            "held until the design is settled (take one on by number or "
            "with --include-design)",
            out,
        )
        # Not duplicated into `held:` alongside genuinely blocked issues.
        self.assertNotIn("held:", out)

    def test_include_design_makes_it_selectable(self):
        issues = [
            gh_issue(
                3,
                title="needs a design call",
                labels=["priority: P0", "blocked: design"],
            )
        ]
        rc, out, err = self._run(["--select", "--include-design"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #3", out)
        self.assertNotIn("needs-design:", out)

    def test_explicit_issue_number_also_bypasses_design_block(self):
        issues = [
            gh_issue(
                3,
                title="needs a design call",
                labels=["priority: P0", "blocked: design"],
            )
        ]
        rc, out, err = self._run(["--select", "--issue", "3"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #3", out)

    def test_design_label_recognized_via_alias_and_normalization(self):
        issues = [
            gh_issue(
                3,
                title="needs a design call",
                labels=["priority: P0", "Blocked: Design"],
            )
        ]
        rc, out, err = self._run(["--select"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("needs-design: #3", out)

    def test_needs_design_flag_and_payload_field(self):
        issues = [
            gh_issue(
                3,
                title="needs a design call",
                labels=["priority: P0", "blocked: design"],
            )
        ]
        rc, out, err = self._run(["--json"], issues)
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["needs_design"], [3])
        rec = payload["issues"][0]
        self.assertEqual(rec["design_labels"], ["blocked: design"])
        self.assertEqual(rec["readiness"], "DESIGN:blocked: design")

    def test_needs_design_flag_shown_in_markdown_output(self):
        issues = [
            gh_issue(
                3,
                title="needs a design call",
                labels=["priority: P0", "blocked: design"],
            )
        ]
        rc, out, err = self._run([], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("NEEDS-DESIGN:blocked: design", out)

    def test_stale_dependency_label_detected_when_all_deps_closed(self):
        # #2 is not in the open-issue list at all, i.e. closed — so #1's only
        # recorded dependency has closed and its label is stale.
        issues = [
            gh_issue(
                1,
                title="stale label",
                labels=["priority: P1", "blocked: dependency"],
                body="depends on #2",
            )
        ]
        rc, out, err = self._run(["--json"], issues)
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["stale_dependency_labels"], [1])
        rec = payload["issues"][0]
        self.assertEqual(rec["stale_dependency_labels"], ["blocked: dependency"])

    def test_not_stale_when_a_dependency_is_still_open(self):
        issues = [
            gh_issue(
                1,
                title="still blocked",
                labels=["priority: P1", "blocked: dependency"],
                body="depends on #2",
            ),
            gh_issue(2, title="the blocker", labels=["priority: P3"]),
        ]
        rc, out, err = self._run(["--json"], issues)
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["stale_dependency_labels"], [])
        rec = next(r for r in payload["issues"] if r["number"] == 1)
        self.assertEqual(rec["stale_dependency_labels"], [])

    def test_not_stale_when_no_dependency_recorded(self):
        # The label is present but no edge was ever declared or scraped — the
        # edge may be expressed somewhere the regex/contract scrape misses,
        # so this is deliberately left alone rather than flagged.
        issues = [
            gh_issue(
                1,
                title="no recorded dep",
                labels=["priority: P1", "blocked: dependency"],
            )
        ]
        rc, out, err = self._run(["--json"], issues)
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["stale_dependency_labels"], [])
        rec = payload["issues"][0]
        self.assertEqual(rec["stale_dependency_labels"], [])

    def test_issue_filter_restricts_output_but_not_dependency_graph(self):
        issues = [
            gh_issue(1, title="alone", body="blocks #2"),
            gh_issue(2, title="other"),
        ]
        rc, out, err = self._run(["--issue", "1", "--json"], issues)
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual([r["number"] for r in payload["issues"]], [1])
        # #1 still gets credit for unblocking #2 even though #2 is filtered out.
        self.assertEqual(payload["issues"][0]["unblocks_open"], [2])

    def test_label_filter_keeps_a_blocker_outside_the_filter_open(self):
        # #2 is open but carries no `area: ui`: the filter must narrow what is
        # ranked, not the set of open issues the dependency edge is read from.
        issues = [
            gh_issue(
                1,
                title="ui work",
                labels=["area: ui", "priority: P1", "blocked: dependency"],
                body="Depends on #2",
            ),
            gh_issue(2, title="core work", labels=["area: core"]),
        ]
        rc, out, err = self._run(
            ["--label", "area: ui", "--json"],
            issues,
            extra={("issue", "list", "--label", "area: ui"): json.dumps([{"number": 1}])},
        )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual([r["number"] for r in payload["issues"]], [1])
        self.assertEqual(payload["ranking"][0]["readiness"], "BLOCKED-BY:#2")
        self.assertEqual(payload["stale_dependency_labels"], [])
        self.assertEqual(payload["issues"][0]["stale_dependency_labels"], [])
        # #2 still counts #1 as waiting on it, though only #1 is ranked.
        self.assertEqual(payload["issues"][0]["depends_on_open"], [2])

    def test_label_filter_is_applied_by_gh_not_by_the_graph_fetch(self):
        issues = [gh_issue(1), gh_issue(2)]
        rc, out, err = self._run(
            ["--label", "area: ui", "--assignee", "@me", "--milestone", "v1", "--json"],
            issues,
            extra={("issue", "list", "--label", "area: ui"): json.dumps([{"number": 2}])},
        )
        self.assertEqual(rc, 0, err)
        self.assertEqual([r["number"] for r in json.loads(out)["issues"]], [2])
        lists = [c for c in self.gh_calls if c[:2] == ["issue", "list"]]
        self.assertEqual(len(lists), 2)
        self.assertNotIn("--label", lists[0])
        self.assertEqual(
            lists[1][:8],
            ["issue", "list", "--label", "area: ui", "--assignee", "@me",
             "--milestone", "v1"],
        )

    def test_a_backlog_larger_than_the_limit_fails_loudly(self):
        issues = [gh_issue(n, labels=["priority: P2"]) for n in (1, 2, 3)]
        rc, out, err = self._run(["--limit", "2", "--select"], issues)
        self.assertEqual(rc, 1)
        self.assertIn("more than 2 open issues", err)
        self.assertIn("--limit", err)
        self.assertNotIn("select:", out)
        # One more than the limit is asked for, so a full page is detectable.
        issue_list = next(c for c in self.gh_calls if c[:2] == ["issue", "list"])
        self.assertEqual(issue_list[issue_list.index("--limit") + 1], "3")

    def test_a_backlog_of_exactly_the_limit_is_ranked(self):
        issues = [gh_issue(n, labels=["priority: P2"]) for n in (1, 2)]
        rc, out, err = self._run(["--limit", "2", "--select"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #1", out)

    def test_more_open_prs_than_the_cap_fails_loudly(self):
        issues = [gh_issue(n, labels=["priority: P2"]) for n in (1, 2)]
        prs = [gh_pr(10 + n, head=f"x{n}") for n in range(3)]
        with patch.object(issue_records, "PR_LIMIT", 2):
            rc, out, err = self._run(["--select"], issues, prs=prs)
        self.assertEqual(rc, 1)
        self.assertIn("more than 2 open pull requests", err)
        self.assertNotIn("select:", out)
        pr_list = next(c for c in self.gh_calls if c[:2] == ["pr", "list"])
        self.assertEqual(pr_list[pr_list.index("--limit") + 1], "3")

    def test_open_prs_exactly_at_the_cap_are_used(self):
        issues = [gh_issue(n, labels=["priority: P2"]) for n in (1, 2)]
        prs = [gh_pr(10, body="Closes #1"), gh_pr(11, head="x")]
        with patch.object(issue_records, "PR_LIMIT", 2):
            rc, out, err = self._run(["--select"], issues, prs=prs)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #2", out)

    def test_a_limit_below_one_is_a_usage_error(self):
        rc, out, err = self._run(["--limit", "0"], [gh_issue(1)])
        self.assertEqual(rc, 2)
        self.assertIn("--limit must be at least 1", err)

    def test_label_coverage_complete_when_all_labeled(self):
        issues = [gh_issue(1, labels=["priority: P1"])]
        rc, out, err = self._run(["--select"], issues)
        self.assertIn("COMPLETE", out)

    def test_open_pr_marks_has_open_pr_flag(self):
        issues = [gh_issue(5, title="claimed")]
        prs = [gh_pr(10, body="Closes #5")]
        rc, out, err = self._run(["--json"], issues, prs)
        payload = json.loads(out)
        rec = payload["issues"][0]
        self.assertIsNotNone(rec["open_pr"])
        self.assertEqual(rec["open_pr"]["number"], 10)

    def test_pr_template_body_does_not_claim_example_issue(self):
        body = """## Summary

<!-- What does this PR do? Link related issues with "Closes #123". -->
<!-- Title should follow Conventional Commits, e.g. "fix: handle empty input". -->

## Test Plan

<!-- How was this tested? What commands did you run? -->

## Checklist

- [ ] Full local verification passes on the committed tree (`just check`)
- [ ] Docs updated, if a user-facing behavior, command, or setting changed
- [ ] Breaking changes called out in the Summary
"""
        rc, out, err = self._run(["--json"], [gh_issue(123)], [gh_pr(10, body=body)])
        self.assertEqual(rc, 0, err)
        self.assertIsNone(json.loads(out)["issues"][0]["open_pr"])

    def test_pr_examples_and_partial_keywords_do_not_claim_issues(self):
        bodies = [
            "<!-- Closes #123 -->",
            "Before <!-- Closes #123 --> after",
            "<!-- Closes #123",  # An unfinished template comment stays hidden.
            "```text\nCloses #123\n```",
            "~~~\nCloses #123\n~~~",
            "```text\nCloses #123",
            "````\n```\nCloses #123\n````",
            "Example `Closes #123` only",
            "Example ``Closes #123`` only",
            "hotfix #123",
            "encloses #123",
            "Closes #123suffix",
        ]
        for body in bodies:
            with self.subTest(body=body):
                rc, out, err = self._run(
                    ["--json"], [gh_issue(123)], [gh_pr(10, body=body)]
                )
                self.assertEqual(rc, 0, err)
                self.assertIsNone(json.loads(out)["issues"][0]["open_pr"])

    def test_pr_indented_code_block_does_not_claim_issue(self):
        bodies = [
            "    Closes #123",
            "\tCloses #123",
            "  \tCloses #123",
            "Summary.\n\n    Closes #123\n",
            "Summary.\n\n    Example:\n\n    Closes #123\n\nMore prose.",
            "```\nx\n```\n    Closes #123",
            "<!-- note -->\n    Closes #123",
        ]
        for body in bodies:
            with self.subTest(body=body):
                rc, out, err = self._run(
                    ["--json"], [gh_issue(123)], [gh_pr(10, body=body)]
                )
                self.assertEqual(rc, 0, err)
                self.assertIsNone(json.loads(out)["issues"][0]["open_pr"])

    def test_pr_indented_line_outside_a_code_block_still_claims_issue(self):
        bodies = [
            # An indented code block cannot interrupt a paragraph.
            "Summary line\n    Closes #123",
            # List-item continuation, not code.
            "- Summary\n\n    Closes #123",
            "1. Summary\n\n    Closes #123",
            "   Closes #123",
            "    Example\nFixes #123",
        ]
        for body in bodies:
            with self.subTest(body=body):
                rc, out, err = self._run(
                    ["--json"], [gh_issue(123)], [gh_pr(10, body=body)]
                )
                self.assertEqual(rc, 0, err)
                self.assertIsNotNone(json.loads(out)["issues"][0]["open_pr"])

    def test_pr_hyphenated_word_ending_in_a_keyword_does_not_claim_issue(self):
        for body in (
            "hot-fix #123",
            "pre-fixes #123",
            "un-closed #123",
            "re-resolves #123",
        ):
            with self.subTest(body=body):
                rc, out, err = self._run(
                    ["--json"], [gh_issue(123)], [gh_pr(10, body=body)]
                )
                self.assertEqual(rc, 0, err)
                self.assertIsNone(json.loads(out)["issues"][0]["open_pr"])

    def test_pr_keyword_after_punctuation_or_at_line_start_claims_issue(self):
        for body in (
            "Fixes #123",
            "(fixes #123)",
            "Summary.\nCloses #123",
            "- Resolves #123",
            "Done; fixed #123.",
        ):
            with self.subTest(body=body):
                rc, out, err = self._run(
                    ["--json"], [gh_issue(123)], [gh_pr(10, body=body)]
                )
                self.assertEqual(rc, 0, err)
                self.assertIsNotNone(json.loads(out)["issues"][0]["open_pr"])

    def test_pr_closing_references_claim_only_current_repository(self):
        cases = [
            ("Closes acme/widgets#7", True),
            ("Fixes ACME/Widgets#7", True),
            ("Resolves https://github.com/acme/widgets/issues/7", True),
            ("Closes other/widgets#7", False),
            ("Closes https://github.com/other/widgets/issues/7", False),
            ("Closes https://example.com/acme/widgets/issues/7", False),
            ("Fixes: #7", True),
            ("fixed #7", True),
            ("Resolved #7", True),
        ]
        for body, claimed in cases:
            with self.subTest(body=body):
                rc, out, err = self._run(
                    ["--json"], [gh_issue(7)], [gh_pr(10, body=body)]
                )
                self.assertEqual(rc, 0, err)
                self.assertEqual(
                    json.loads(out)["issues"][0]["open_pr"] is not None, claimed
                )

    def test_pr_api_references_union_with_prose_and_branch_ownership(self):
        pr = gh_pr(10, body="Fixes #8", head="codex/9-feature")
        pr["closingIssuesReferences"] = [
            {"number": 7, "url": "https://github.com/acme/widgets/issues/7"},
            {"number": 10, "url": "https://github.com/other/widgets/issues/10"},
        ]
        rc, out, err = self._run(["--json"], [gh_issue(n) for n in (7, 8, 9, 10)], [pr])
        self.assertEqual(rc, 0, err)
        self.assertEqual(
            {
                r["number"]
                for r in json.loads(out)["issues"]
                if r["open_pr"] is not None
            },
            {7, 8, 9},
        )
        fields = next(c for c in self.gh_calls if c[:2] == ["pr", "list"])
        self.assertIn("closingIssuesReferences", fields[fields.index("--json") + 1])

    def test_pr_api_foreign_repository_same_number_does_not_claim_local_issue(self):
        for url in (
            "https://github.com/other/widgets/issues/7",
            "https://example.com/acme/widgets/issues/7",
        ):
            with self.subTest(url=url):
                pr = gh_pr(10)
                pr["closingIssuesReferences"] = [{"number": 7, "url": url}]
                rc, out, err = self._run(["--json"], [gh_issue(7)], [pr])
                self.assertEqual(rc, 0, err)
                self.assertIsNone(json.loads(out)["issues"][0]["open_pr"])

    def test_pr_visible_keyword_after_ignored_examples_claims_issue(self):
        pr = gh_pr(
            10,
            title="Example `Closes #6`",
            body=("<!-- Closes #6 -->\n```\nCloses #6\n```\nFixes #7"),
        )
        rc, out, err = self._run(["--json"], [gh_issue(6), gh_issue(7)], [pr])
        self.assertEqual(rc, 0, err)
        self.assertEqual(
            {
                r["number"]
                for r in json.loads(out)["issues"]
                if r["open_pr"] is not None
            },
            {7},
        )

    def test_pr_branch_conventions_preserve_issue_ownership(self):
        cases = [
            ("7-feature", True),
            ("feat/7-feature", True),
            ("issue-7", True),
            ("issues/7", True),
            ("bump-foo-7-2-3", False),
            ("hotfix-7", False),
        ]
        for head, claimed in cases:
            with self.subTest(head=head):
                rc, out, err = self._run(
                    ["--json"], [gh_issue(7)], [gh_pr(10, head=head)]
                )
                self.assertEqual(rc, 0, err)
                self.assertEqual(
                    json.loads(out)["issues"][0]["open_pr"] is not None, claimed
                )

    def test_pr_draft_flag_surfaces_in_markdown(self):
        issues = [gh_issue(5, title="claimed")]
        prs = [gh_pr(10, body="Closes #5", draft=True)]
        rc, out, err = self._run([], issues, prs)
        self.assertIn("(draft)", out)

    def test_no_issues_matches_filter_gracefully(self):
        rc, out, err = self._run(["--label", "nonexistent"], [])
        self.assertEqual(rc, 0, err)
        self.assertIn("No open issues match the filter", out)

    def test_rank_only_stops_after_the_table(self):
        issues = [gh_issue(1, labels=["priority: P2"])]
        rc, out, err = self._run(["--rank-only"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("Priority ranking", out)
        self.assertNotIn("## #1", out)

    def test_no_rank_omits_the_table(self):
        issues = [gh_issue(1, labels=["priority: P2"])]
        rc, out, err = self._run(["--no-rank"], issues)
        self.assertEqual(rc, 0, err)
        self.assertNotIn("Priority ranking", out)
        self.assertIn("## #1", out)

    def test_body_chars_zero_omits_body_text(self):
        issues = [gh_issue(1, body="secret detail", labels=["priority: P2"])]
        rc, out, err = self._run(["--body-chars", "0"], issues)
        self.assertEqual(rc, 0, err)
        self.assertNotIn("secret detail", out)

    def test_gh_not_found_reports_error(self):
        rc, out, err = self._run([], [], path_override="/nonexistent-only")
        self.assertEqual(rc, 1)
        self.assertIn("gh CLI not found", err)


class RestFilesTest(DigestRunner, unittest.TestCase):
    """--issues-file / --prs-file: rank REST JSON the caller fetched itself."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    @staticmethod
    def rest_issue(
        number, labels=(), *, body="", milestone=None, assignees=(), extra=None
    ):
        item = {
            "number": number,
            "title": "issue",
            "labels": [{"name": n} for n in labels],
            "assignees": [{"login": a} for a in assignees],
            "milestone": {"title": milestone} if milestone else None,
            "body": body,
            "created_at": "2026-10-01T00:00:00Z",
            "updated_at": "2026-10-02T00:00:00Z",
            "html_url": f"https://github.com/acme/widgets/issues/{number}",
        }
        return {**item, **(extra or {})}

    @staticmethod
    def rest_pr(number, *, body="", head="feature", draft=False, title="pr"):
        return {
            "number": number,
            "title": title,
            "body": body,
            "head": {"ref": head},
            "draft": draft,
            "html_url": f"https://github.com/acme/widgets/pull/{number}",
        }

    def write(self, name, payload):
        path = self.dir / name
        path.write_text(
            payload if isinstance(payload, str) else json.dumps(payload),
            encoding="utf-8",
        )
        return str(path)

    def _run_files(self, issues, prs, args=("--select", "--json"), **kw):
        files = [
            "--issues-file",
            self.write("issues.json", issues),
            "--prs-file",
            self.write("prs.json", prs),
        ]
        return self._run([*files, *args], [], **kw)

    def test_example_selects_issue_with_no_gh_process(self):
        rc, out, err = self._run_files([[self.rest_issue(12, ["priority: P1"])]], [[]])
        self.assertEqual(rc, 0, err)
        top = json.loads(out)["ranking"][0]
        self.assertEqual((top["number"], top["tier"]), (12, "P1"))
        self.assertEqual(self.last_calls.calls, [])

    def test_output_equals_the_gh_path_for_the_same_data(self):
        gh_issues = [
            gh_issue(
                1,
                labels=["priority: P1"],
                milestone="m1",
                assignees=["bo"],
                body="Depends on #2",
                created="2026-10-01T00:00:00Z",
                updated="2026-10-02T00:00:00Z",
            ),
            gh_issue(
                2,
                labels=["priority: P0"],
                created="2026-10-01T00:00:00Z",
                updated="2026-10-02T00:00:00Z",
            ),
            gh_issue(3, created="2026-10-01T00:00:00Z", updated="2026-10-02T00:00:00Z"),
        ]
        gh_prs = [gh_pr(40, body="Closes #3", head="claude/x")]
        gh_prs[0]["closingIssuesReferences"] = []
        rest_issues = [
            self.rest_issue(
                1,
                ["priority: P1"],
                milestone="m1",
                assignees=["bo"],
                body="Depends on #2",
            ),
            self.rest_issue(2, ["priority: P0"]),
            self.rest_issue(3),
        ]
        rest_prs = [self.rest_pr(40, body="Closes #3", head="claude/x")]
        for args in (["--json"], ["--with-rank", "--select"], ["--audit"]):
            with self.subTest(args=args):
                want = self._run(args, gh_issues, gh_prs)
                got = self._run_files(rest_issues, rest_prs, args)
                self.assertEqual(want[0], 0, want[2])
                self.assertEqual(got, want)

    def test_open_pr_body_claims_the_issue(self):
        pr = self.rest_pr(40, body="Closes #12", head="claude/x")
        rc, out, err = self._run_files(
            [self.rest_issue(12, ["priority: P1"])], [pr], ["--json"]
        )
        self.assertEqual(rc, 0, err)
        rec = next(r for r in json.loads(out)["issues"] if r["number"] == 12)
        self.assertEqual(rec["readiness"], "HAS-PR:#40")
        self.assertEqual(rec["open_pr"]["number"], 40)

    def test_draft_flag_and_branch_come_from_rest_fields(self):
        pr = self.rest_pr(41, head="issue-12-fix", draft=True)
        rc, out, err = self._run_files([self.rest_issue(12)], [pr], ["--json"])
        self.assertEqual(rc, 0, err)
        rec = json.loads(out)["issues"][0]
        self.assertEqual(
            rec["open_pr"], {"number": 41, "url": pr["html_url"], "draft": True}
        )

    def test_cache_is_neither_read_nor_written(self):
        state = self.dir / "state"
        for extra in (["--cache-ttl", "300"], ["--cache-ttl", "300", "--refresh"]):
            rc, out, err = self._run_files(
                [self.rest_issue(1)],
                [],
                ["--select", *extra],
                state_dir=state,
                cache=True,
            )
            self.assertEqual(rc, 0, err)
        self.assertEqual(list(state.glob("**/digest-cache.json")), [])

    def test_gh_not_on_path_is_fine(self):
        empty = self.dir / "empty-bin"
        empty.mkdir()
        rc, out, err = self._run_files(
            [self.rest_issue(1, ["priority: P0"])], [], path_override=str(empty)
        )
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["ranking"][0]["number"], 1)

    def test_one_flag_alone_exits_2(self):
        issues = self.write("issues.json", [])
        prs = self.write("prs.json", [])
        for flag, path in (("--issues-file", issues), ("--prs-file", prs)):
            with self.subTest(flag=flag):
                rc, out, err = self._run([flag, path], [])
                self.assertEqual(rc, 2)
                self.assertIn("error:", err)

    def test_combined_with_a_server_side_filter_exits_2(self):
        for extra in (["--label", "bug"], ["--assignee", "bo"], ["--milestone", "m1"]):
            with self.subTest(extra=extra):
                rc, out, err = self._run(
                    [
                        "--issues-file",
                        self.write("i.json", []),
                        "--prs-file",
                        self.write("p.json", []),
                        *extra,
                    ],
                    [],
                )
                self.assertEqual(rc, 2)
                self.assertIn("error:", err)

    def test_flag_misuse_starts_no_gh_process(self):
        self._run(["--issues-file", self.write("i.json", []), "--label", "x"], [])
        self.assertEqual(self.last_calls.calls, [])

    def test_bad_file_exits_1_naming_the_path(self):
        good = self.write("good.json", [])
        missing = str(self.dir / "missing.json")
        cases = {
            "missing": missing,
            "not json": self.write("bad.json", "{not json"),
            "object": self.write("obj.json", {"number": 1}),
            "scalar items": self.write("scalars.json", [1, 2]),
            "mixed items": self.write("mixed.json", [[{"number": 1}], "x"]),
        }
        for name, path in cases.items():
            for flag_pair in (
                ("--issues-file", path, "--prs-file", good),
                ("--issues-file", good, "--prs-file", path),
            ):
                with self.subTest(case=name, flags=flag_pair):
                    rc, out, err = self._run(list(flag_pair), [])
                    self.assertEqual(rc, 1)
                    self.assertTrue(err.startswith(f"error: {path}: "), err)
                    self.assertEqual(out, "")

    def test_directory_as_file_exits_1(self):
        rc, out, err = self._run(
            ["--issues-file", str(self.dir), "--prs-file", self.write("p.json", [])], []
        )
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith(f"error: {self.dir}: "), err)

    def test_plain_and_slurped_shapes_both_flatten(self):
        issues = [self.rest_issue(1), self.rest_issue(2), self.rest_issue(3)]
        for shape in (issues, [issues[:2], issues[2:]]):
            rc, out, err = self._run_files(shape, [], ["--json"])
            self.assertEqual(rc, 0, err)
            self.assertEqual(json.loads(out)["open_issue_count"], 3)

    def test_empty_files_print_an_empty_digest(self):
        for payload in ([], [[]]):
            with self.subTest(payload=payload):
                rc, out, err = self._run_files(payload, payload, ["--json"])
                self.assertEqual(rc, 0, err)
                self.assertEqual(json.loads(out)["open_issue_count"], 0)

    def test_empty_files_match_the_gh_path_for_an_empty_backlog(self):
        self.assertEqual(self._run_files([], []), self._run(["--select", "--json"], []))

    def test_pull_requests_in_the_issues_file_are_dropped(self):
        pr_item = self.rest_issue(5, extra={"pull_request": {"url": "u"}})
        rc, out, err = self._run_files([[pr_item]], [], ["--json"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["open_issue_count"], 0)
        rc, out, err = self._run_files([[self.rest_issue(1), pr_item]], [], ["--json"])
        self.assertEqual([r["number"] for r in json.loads(out)["issues"]], [1])

    def test_null_fields_behave_like_missing_ones(self):
        item = self.rest_issue(
            7,
            extra={
                "body": None,
                "milestone": None,
                "assignees": None,
                "labels": None,
                "created_at": None,
                "updated_at": None,
            },
        )
        rc, out, err = self._run_files([item], [self.rest_pr(9, head="x")], ["--json"])
        self.assertEqual(rc, 0, err)
        rec = json.loads(out)["issues"][0]
        self.assertEqual(
            (rec["milestone"], rec["assignees"], rec["labels"]), (None, [], [])
        )

    def test_pr_with_null_head_is_tolerated(self):
        pr = self.rest_pr(9)
        pr["head"] = None
        rc, out, err = self._run_files([self.rest_issue(7)], [pr], ["--json"])
        self.assertEqual(rc, 0, err)

    def test_limit_keeps_the_first_n_issues_in_file_order(self):
        issues = [self.rest_issue(n) for n in (30, 10, 20)]
        rc, out, err = self._run_files(issues, [], ["--json", "--limit", "2"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(
            sorted(r["number"] for r in json.loads(out)["issues"]), [10, 30]
        )

    def test_limit_counts_issues_after_pull_requests_are_dropped(self):
        items = [
            self.rest_issue(1, extra={"pull_request": {}}),
            self.rest_issue(2),
            self.rest_issue(3),
        ]
        rc, out, err = self._run_files(items, [], ["--json", "--limit", "1"])
        self.assertEqual([r["number"] for r in json.loads(out)["issues"]], [2])


if __name__ == "__main__":
    unittest.main()


CONTRACT = (
    "<!-- ship: tier=P1 area=test-infra blocked-by=none "
    "blocks=#98 touches=tests/,Cargo.toml design=settled -->"
)


class ShipContractTest(unittest.TestCase):
    """The `<!-- ship: ... -->` block: the half of the ranking decision that is
    supposed to be read rather than re-derived."""

    def test_parses_every_known_field(self):
        c = idg.parse_ship_contract(f"Some prose.\n\n{CONTRACT}\n\nMore prose.")
        self.assertEqual(c["tier"], "P1")
        self.assertEqual(c["area"], "test-infra")
        self.assertEqual(c["depends_on"], [])
        self.assertEqual(c["blocks"], [98])
        self.assertEqual(c["touches"], ["tests/", "Cargo.toml"])
        self.assertEqual(c["design"], "settled")
        self.assertEqual(c["missing_fields"], [])
        self.assertEqual(c["unknown_fields"], [])

    def test_absent_block_is_none(self):
        self.assertIsNone(idg.parse_ship_contract("no contract here #12"))
        self.assertIsNone(idg.parse_ship_contract(""))
        self.assertIsNone(idg.parse_ship_contract(None))

    def test_later_block_wins_field_by_field(self):
        body = "<!-- ship: tier=P3 touches=a/ -->\n<!-- ship: tier=P0 blocked-by=#7 -->"
        c = idg.parse_ship_contract(body)
        self.assertEqual(c["tier"], "P0")
        self.assertEqual(c["depends_on"], [7])
        # A field only the first block set survives — the blocks are merged,
        # not swapped, so correcting one field does not silently drop the rest.
        self.assertEqual(c["touches"], ["a/"])

    def test_missing_required_fields_are_reported(self):
        c = idg.parse_ship_contract("<!-- ship: area=api -->")
        self.assertEqual(c["missing_fields"], ["tier", "blocked-by", "touches"])

    def test_unknown_fields_are_kept_but_flagged(self):
        c = idg.parse_ship_contract("<!-- ship: tier=P1 owner=someone -->")
        self.assertEqual(c["tier"], "P1")
        self.assertEqual(c["unknown_fields"], ["owner"])

    def test_garbage_tier_and_design_are_dropped_not_trusted(self):
        c = idg.parse_ship_contract("<!-- ship: tier=URGENT design=maybe -->")
        self.assertIsNone(c["tier"])
        self.assertIsNone(c["design"])

    def test_numbers_parse_with_or_without_hash(self):
        c = idg.parse_ship_contract("<!-- ship: blocked-by=12,#13 -->")
        self.assertEqual(c["depends_on"], [12, 13])

    def test_an_empty_field_does_not_swallow_the_next_field(self):
        c = idg.parse_ship_contract(
            "<!-- ship: tier=P0 blocked-by= blocks=#93,#94 touches=* -->"
        )
        self.assertEqual(c["depends_on"], [])
        self.assertEqual(c["blocks"], [93, 94])
        self.assertEqual(c["missing_fields"], [])

    def test_an_empty_last_field_parses_as_empty(self):
        c = idg.parse_ship_contract("<!-- ship: tier=P2 blocks=#5 blocked-by= -->")
        self.assertEqual(c["depends_on"], [])
        self.assertEqual(c["blocks"], [5])
        self.assertIn("blocked-by", c["fields"])

    def test_an_empty_tier_or_touches_still_counts_as_missing(self):
        c = idg.parse_ship_contract("<!-- ship: tier= blocked-by=none touches= -->")
        self.assertEqual(c["missing_fields"], ["tier", "touches"])

    def test_a_space_only_after_the_equals_sign_still_reads_the_value(self):
        c = idg.parse_ship_contract("<!-- ship: blocked-by= #12 blocks=#4 -->")
        self.assertEqual(c["depends_on"], [12])
        self.assertEqual(c["blocks"], [4])

    def test_spaces_around_the_equals_sign_still_parse(self):
        c = idg.parse_ship_contract("<!-- ship: tier = P1 blocked-by = #7 -->")
        self.assertEqual(c["tier"], "P1")
        self.assertEqual(c["depends_on"], [7])


class ShipContractInCodeTest(unittest.TestCase):
    """A ship block quoted inside a fenced code block or inline code is an
    example, not the contract."""

    EXAMPLE = "<!-- ship: tier=P0 blocked-by=#1 touches=* design=open -->"

    def test_fenced_example_before_the_real_contract_is_ignored(self):
        for fence in ("```", "~~~", "````"):
            with self.subTest(fence=fence):
                body = (
                    f"Quoted:\n\n{fence}\n{self.EXAMPLE}\n{fence}\n\n"
                    f"Prose.\n\n{CONTRACT}\n"
                )
                c = idg.parse_ship_contract(body)
                self.assertEqual(c["tier"], "P1")
                self.assertEqual(c["design"], "settled")
                self.assertEqual(len(idg.find_ship_contracts(body)), 1)

    def test_fenced_example_after_the_real_contract_is_ignored(self):
        # Last-real-block-wins: a later quoted example must not win.
        body = f"{CONTRACT}\n\n~~~md\n{self.EXAMPLE}\n~~~\n"
        self.assertEqual(idg.parse_ship_contract(body)["tier"], "P1")

    def test_a_shorter_fence_line_does_not_close_the_block(self):
        body = f"{CONTRACT}\n````\n```\n{self.EXAMPLE}\n````\n"
        self.assertEqual(idg.parse_ship_contract(body)["tier"], "P1")

    def test_inline_code_example_is_ignored(self):
        for tick in ("`", "``"):
            with self.subTest(tick=tick):
                body = f"{CONTRACT}\n\nWrite {tick}{self.EXAMPLE}{tick} like so."
                self.assertEqual(idg.parse_ship_contract(body)["tier"], "P1")

    def test_indented_code_example_is_ignored(self):
        for indent in ("    ", "\t"):
            with self.subTest(indent=repr(indent)):
                body = f"Quoted:\n\n{indent}{self.EXAMPLE}\n\n{CONTRACT}\n"
                self.assertEqual(idg.parse_ship_contract(body)["tier"], "P1")
                self.assertEqual(len(idg.find_ship_contracts(body)), 1)

    def test_contract_in_a_list_item_continuation_is_read(self):
        body = f"- Item\n\n    {CONTRACT}\n"
        self.assertEqual(idg.parse_ship_contract(body)["tier"], "P1")

    def test_only_a_fenced_example_means_no_contract(self):
        self.assertIsNone(idg.parse_ship_contract(f"```\n{self.EXAMPLE}\n```\n"))
        self.assertIsNone(idg.parse_ship_contract(f"~~~\n{self.EXAMPLE}\n"))

    def test_backticks_never_pair_across_a_contract_paragraph(self):
        # A lone backtick before the contract and an inline span after it are
        # in different paragraphs; pairing them hid the real contract.
        body = (
            "Press the ` key.\n\n"
            "<!-- ship: tier=P1 blocked-by=#5 touches=src/a.py design=open -->\n\n"
            "Then run `just test`.\n"
        )
        c = idg.parse_ship_contract(body)
        self.assertIsNotNone(c)
        self.assertEqual(c["tier"], "P1")
        self.assertEqual(c["depends_on"], [5])

    def test_a_contract_comment_block_ends_the_paragraph_without_blank_lines(self):
        body = (
            "Press the ` key.\n"
            "<!-- ship: tier=P2 blocked-by=none touches=* -->\n"
            "Then run `just test`.\n"
        )
        self.assertEqual(idg.parse_ship_contract(body)["tier"], "P2")

    def test_an_unmatched_backtick_does_not_hide_the_contract(self):
        body = f"A stray ` backtick.\n\n{CONTRACT}"
        self.assertEqual(idg.parse_ship_contract(body)["tier"], "P1")


class ContractIntegrationTest(DigestRunner, unittest.TestCase):
    """The contract as it changes ranking, readiness and grouping input."""

    def test_contract_tier_ranks_without_a_label(self):
        issues = [
            gh_issue(1, title="guessed", body="small tweak"),
            gh_issue(2, title="declared", body="<!-- ship: tier=P0 -->"),
        ]
        rc, out, err = self._run(["--select"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #2", out)
        # Settled, so it prints plain — not as the `~P0` a score guess gets.
        self.assertIn("[P0]", out)
        self.assertNotIn("[~P0]", out)

    def test_written_label_outranks_a_stale_contract_tier(self):
        issues = [gh_issue(1, labels=["priority: P3"], body="<!-- ship: tier=P0 -->")]
        rc, out, err = self._run(["--select", "--json"], issues)
        row = json.loads(out)["ranking"][0]
        self.assertEqual(row["tier"], "P3")
        self.assertEqual(row["contract_tier"], "P0")
        self.assertEqual(row["confirmed_tier"], "P3")

    def test_coverage_reads_complete_when_contracts_cover_the_gap(self):
        issues = [
            gh_issue(1, labels=["priority: P1"]),
            gh_issue(2, body="<!-- ship: tier=P2 -->"),
        ]
        rc, out, err = self._run(["--select"], issues)
        self.assertIn("COMPLETE", out)
        self.assertIn("contract: 1/2", out)
        # The label is still owed even though the tier is settled.
        self.assertIn("still need the label written", out)

    def test_contract_edges_block_and_unblock(self):
        issues = [
            gh_issue(1, labels=["priority: P0"], body="<!-- ship: blocked-by=#2 -->"),
            gh_issue(2, labels=["priority: P3"]),
        ]
        rc, out, err = self._run(["--select"], issues)
        self.assertIn("select: #2", out)
        self.assertIn("#1[P0] BLOCKED-BY:#2", out)

    def test_design_open_holds_the_issue_without_a_label(self):
        issues = [
            gh_issue(1, labels=["priority: P0"], body="<!-- ship: design=open -->")
        ]
        rc, out, err = self._run(["--select"], issues)
        self.assertIn("select: none", out)
        self.assertIn("needs-design: #1", out)

    def test_touches_and_area_reach_the_json_ranking(self):
        issues = [gh_issue(1, body="<!-- ship: tier=P1 area=api touches=src/api/ -->")]
        rc, out, err = self._run(["--select", "--json"], issues)
        row = json.loads(out)["ranking"][0]
        self.assertEqual(row["touches"], ["src/api/"])
        self.assertEqual(row["area"], "api")

    def test_audit_names_what_each_issue_is_missing(self):
        issues = [
            gh_issue(1, body=CONTRACT),
            gh_issue(2, body="<!-- ship: tier=P1 -->"),
            gh_issue(3, body="nothing"),
        ]
        rc, out, err = self._run(["--audit"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("contract: 1/3 complete · 1 partial · 1 missing", out)
        self.assertIn("missing: #3", out)
        self.assertIn("partial: #2 — no blocked-by,touches", out)


class ComposableOutputTest(DigestRunner, unittest.TestCase):
    """--select composing with --with-rank/--detail is what collapses a
    startup's three digest calls into one."""

    def test_with_rank_appends_the_table_to_select(self):
        issues = [
            gh_issue(1, labels=["priority: P0"]),
            gh_issue(2, labels=["priority: P2"]),
        ]
        rc, out, err = self._run(["--select", "--with-rank"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #1", out)
        self.assertIn("## Priority ranking", out)
        self.assertLess(out.index("select: #1"), out.index("## Priority ranking"))

    def test_detail_top_prints_bodies_without_narrowing_the_rank(self):
        issues = [
            gh_issue(1, labels=["priority: P0"], body="the P0 body"),
            gh_issue(2, labels=["priority: P1"], body="the P1 body"),
            gh_issue(3, labels=["priority: P2"], body="the P2 body"),
        ]
        rc, out, err = self._run(["--select", "3", "--detail-top", "2"], issues)
        self.assertEqual(rc, 0, err)
        self.assertIn("the P0 body", out)
        self.assertIn("the P1 body", out)
        self.assertNotIn("the P2 body", out)
        # All three still ranked — unlike --issue, --detail-top does not filter.
        self.assertIn("next  : #3", out)

    def test_detail_takes_explicit_numbers_too(self):
        issues = [
            gh_issue(1, labels=["priority: P0"], body="first body"),
            gh_issue(9, labels=["priority: P3"], body="ninth body"),
        ]
        rc, out, err = self._run(["--select", "--detail", "9"], issues)
        self.assertIn("ninth body", out)
        self.assertNotIn("first body", out)

    def test_detail_for_an_issue_outside_the_digest_says_so(self):
        rc, out, err = self._run(
            ["--select", "--detail", "404"], [gh_issue(1, labels=["priority: P0"])]
        )
        self.assertIn("not-in-digest: #404", out)

    def test_plain_select_is_unchanged(self):
        rc, out, err = self._run(["--select"], [gh_issue(1, labels=["priority: P0"])])
        self.assertNotIn("## Priority ranking", out)
        self.assertNotIn("## #1", out)


class DigestCacheTest(DigestRunner, unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state = Path(self._tmp.name)
        # The cache fixture must work without a Git checkout or origin remote.
        repo = patch("issue_records.repo_slug", return_value="acme/widgets")
        repo.start()
        self.addCleanup(repo.stop)

    def _gh_fetches(self):
        return [
            c for c in self.gh_calls if c[:2] in (["issue", "list"], ["pr", "list"])
        ]

    def _warm_cache(self, issues):
        """Prove this setup can hit the cache before testing a bypass."""
        self._run(
            ["--select", "--cache-ttl", "300"], issues, state_dir=self.state, cache=True
        )
        self.assertEqual(len(self._gh_fetches()), 2)
        rc, out, err = self._run(
            ["--select", "--cache-ttl", "300"], issues, state_dir=self.state, cache=True
        )
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._gh_fetches(), [])

    def test_second_call_serves_from_cache(self):
        issues = [gh_issue(1, labels=["priority: P0"], body="cached body")]
        self._run(
            ["--select", "--cache-ttl", "300"], issues, state_dir=self.state, cache=True
        )
        self.assertEqual(len(self._gh_fetches()), 2)
        # A second, differently-shaped call within the TTL: no gh at all, and
        # the detail comes out of the same fetch the --select paid for.
        rc, out, err = self._run(
            ["--select", "--detail", "1", "--cache-ttl", "300"],
            issues,
            state_dir=self.state,
            cache=True,
        )
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._gh_fetches(), [])
        self.assertIn("cached body", out)

    def test_refresh_bypasses_a_warm_cache(self):
        issues = [gh_issue(1, labels=["priority: P0"])]
        self._warm_cache(issues)
        self._run(
            ["--select", "--refresh", "--cache-ttl", "300"],
            issues,
            state_dir=self.state,
            cache=True,
        )
        self.assertEqual(len(self._gh_fetches()), 2)

    def test_zero_ttl_disables_the_cache(self):
        issues = [gh_issue(1, labels=["priority: P0"])]
        self._warm_cache(issues)
        self._run(
            ["--select", "--cache-ttl", "0"], issues, state_dir=self.state, cache=True
        )
        self.assertEqual(len(self._gh_fetches()), 2)

    def test_a_different_filter_is_a_different_cache_entry(self):
        issues = [gh_issue(1, labels=["priority: P0", "bug"])]
        self._run(
            ["--select", "--cache-ttl", "300"], issues, state_dir=self.state, cache=True
        )
        self._run(
            ["--select", "--label", "bug", "--cache-ttl", "300"],
            issues,
            state_dir=self.state,
            cache=True,
        )
        # A miss, and a filtered call costs three fetches: the whole open
        # backlog (the dependency graph), the filter's numbers, and the PRs.
        fetches = self._gh_fetches()
        self.assertEqual(len(fetches), 3)
        self.assertEqual(fetches[1][:4], ["issue", "list", "--label", "bug"])

    def test_expired_cache_refetches(self):
        issues = [gh_issue(1, labels=["priority: P0"])]
        self._run(
            ["--select", "--cache-ttl", "300"], issues, state_dir=self.state, cache=True
        )
        self._run(
            ["--select", "--cache-ttl", "1"], issues, state_dir=self.state, cache=True
        )
        cache_file = next(self.state.glob("shipping-issues/*/digest-cache.json"))
        blob = json.loads(cache_file.read_text())
        blob["fetched_at"] -= 3600
        cache_file.write_text(json.dumps(blob))
        self._run(
            ["--select", "--cache-ttl", "300"], issues, state_dir=self.state, cache=True
        )
        self.assertEqual(len(self._gh_fetches()), 2)

    def test_malformed_cache_is_a_miss_not_an_error(self):
        issues = [gh_issue(1, labels=["priority: P0"])]
        self._run(
            ["--select", "--cache-ttl", "300"], issues, state_dir=self.state, cache=True
        )
        cache_file = next(self.state.glob("shipping-issues/*/digest-cache.json"))
        cache_file.write_text("{ not json")
        rc, out, err = self._run(
            ["--select", "--cache-ttl", "300"], issues, state_dir=self.state, cache=True
        )
        self.assertEqual(rc, 0, err)
        self.assertIn("select: #1", out)
        self.assertEqual(len(self._gh_fetches()), 2)

    def test_env_kill_switch_disables_the_cache(self):
        issues = [gh_issue(1, labels=["priority: P0"])]
        self._warm_cache(issues)
        # Positive TTL isolates the kill switch from the default-off behavior.
        # cache=False leaves FakeGh's SHIPPING_ISSUES_NO_CACHE=1 in place.
        self._run(["--select", "--cache-ttl", "300"], issues, state_dir=self.state)
        self.assertEqual(len(self._gh_fetches()), 2)

    def test_the_cache_is_off_unless_a_caller_asks_for_it(self):
        # The dangerous default is on-by-default: a digest served from before
        # this run's own merge can re-select an issue that is already closed,
        # and nothing downstream would notice. Opting in is the caller's job.
        issues = [gh_issue(1, labels=["priority: P0"])]
        self._warm_cache(issues)
        self._run(["--select"], issues, state_dir=self.state, cache=True)
        self._run(["--select"], issues, state_dir=self.state, cache=True)
        self.assertEqual(len(self._gh_fetches()), 2)
