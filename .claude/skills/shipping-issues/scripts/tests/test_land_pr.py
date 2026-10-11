#!/usr/bin/env python3
"""Tests for land_pr.sh. Stdlib-only (unittest).

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _fakegh import FakeGh

SCRIPT = Path(__file__).resolve().parent.parent / "land_pr.sh"


SHA = "0123456789abcdef0123456789abcdef01234567"


def with_head(args, responses):
    """`responses` plus the PR's head commit, which every merge pins to."""
    if args and not args[0].startswith("-"):
        return {head_prefix(args[0]): SHA + "\n", **responses}
    return responses


def run_script(args, responses, *, exits=None, stderrs=None, sequences=None):
    responses = with_head(args, responses)
    with FakeGh(responses, exits=exits, stderrs=stderrs, sequences=sequences) as fake:
        proc = subprocess.run(
            ["bash", str(SCRIPT), *args],
            env=fake.env,
            text=True,
            capture_output=True,
        )
        calls = list(fake.calls)
    return proc, calls


def run_script_with_sleep_stub(args, responses, *, sequences=None):
    """Like run_script, with `sleep` stubbed on PATH: it logs its argument and
    returns at once, so the merge-state retry is counted without being waited."""
    responses = with_head(args, responses)
    with (
        FakeGh(responses, sequences=sequences) as fake,
        tempfile.TemporaryDirectory() as td,
    ):
        stub_dir = Path(td)
        log = stub_dir / "sleeps"
        stub = stub_dir / "sleep"
        stub.write_text(f'#!/bin/sh\necho "$1" >> "{log}"\n', encoding="utf-8")
        stub.chmod(0o755)
        env = dict(fake.env)
        env["PATH"] = f"{stub_dir}{os.pathsep}{env['PATH']}"
        proc = subprocess.run(
            ["bash", str(SCRIPT), *args],
            env=env,
            text=True,
            capture_output=True,
        )
        calls = list(fake.calls)
        sleeps = log.read_text(encoding="utf-8").split() if log.exists() else []
    return proc, calls, sleeps


def state_prefix(pr):
    return ("pr", "view", pr, "--json", "state")


def draft_prefix(pr):
    return ("pr", "view", pr, "--json", "isDraft")


def inspect_prefix(pr):
    return ("pr", "view", pr, "--json", "mergeable,mergeStateStatus,reviewDecision")


def merge_state_prefix(pr):
    return ("pr", "view", pr, "--json", "mergeStateStatus")


def head_prefix(pr):
    return ("pr", "view", pr, "--json", "headRefOid")


def issue_view_prefix(issue):
    return ("issue", "view", issue, "--json", "state")


class LandPrTest(unittest.TestCase):
    def test_missing_pr_is_usage_error(self):
        proc, calls = run_script([], {})

        self.assertEqual(proc.returncode, 2)
        self.assertIn("Usage: land_pr.sh <pr-number>", proc.stderr)
        self.assertEqual(calls, [])

    def test_help_flag_prints_own_usage_and_never_calls_gh(self):
        for flag in ("-h", "--help"):
            with self.subTest(flag=flag):
                proc, calls = run_script([flag], {})

                self.assertEqual(proc.returncode, 0)
                self.assertIn("land_pr.sh — Merge a green PR", proc.stdout)
                self.assertIn("Exit codes: 0 = merged", proc.stdout)
                self.assertNotIn("gh:", proc.stdout)
                self.assertEqual(calls, [])

    def test_already_merged_without_issue_reports_result_only(self):
        pr = "50"
        proc, calls = run_script([pr], {state_prefix(pr): "MERGED\n"})

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("result: ALREADY_MERGED\n", proc.stdout)
        self.assertEqual(calls, [list(state_prefix(pr)) + ["-q", ".state"]])

    def test_already_merged_with_issue_confirms_issue_closed(self):
        pr = "51"
        issue = "60"
        proc, calls = run_script(
            [pr, "--issue", issue],
            {
                state_prefix(pr): "MERGED\n",
                issue_view_prefix(issue): "CLOSED\n",
            },
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("result: ALREADY_MERGED\n", proc.stdout)
        self.assertIn(f"issue: CLOSED (#{issue})\n", proc.stdout)
        self.assertEqual(
            [call[:2] for call in calls if call[:2] == ["issue", "close"]], []
        )

    def test_not_open_state_is_reported(self):
        pr = "52"
        proc, calls = run_script([pr], {state_prefix(pr): "CLOSED\n"})

        self.assertEqual(proc.returncode, 1)
        self.assertIn("result: NOT_OPEN\n", proc.stdout)
        self.assertIn("state: CLOSED\n", proc.stdout)
        self.assertEqual(calls, [list(state_prefix(pr)) + ["-q", ".state"]])

    def test_wrong_base_blocks_merge(self):
        pr = "53"
        issue = "61"
        base = ("pr", "view", pr, "--json", "baseRefName")
        default_branch = ("repo", "view", "--json", "defaultBranchRef")
        closing = ("pr", "view", pr, "--json", "closingIssuesReferences")
        proc, calls = run_script(
            [pr, "--issue", issue],
            {
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                base: "release\n",
                default_branch: "main\n",
                closing: f"{issue}\n",
            },
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("result: WRONG_BASE\n", proc.stdout)
        self.assertEqual([call for call in calls if call[:2] == ["pr", "edit"]], [])

    def test_not_linked_blocks_merge_without_editing_the_body(self):
        pr = "54"
        issue = "62"
        base = ("pr", "view", pr, "--json", "baseRefName")
        default_branch = ("repo", "view", "--json", "defaultBranchRef")
        closing = ("pr", "view", pr, "--json", "closingIssuesReferences")
        body = ("pr", "view", pr, "--json", "body")
        proc, calls = run_script(
            [pr, "--issue", issue],
            {
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                base: "main\n",
                default_branch: "main\n",
                closing: "5\n",
                body: "Closes #62\n",
            },
        )

        self.assertEqual(proc.returncode, 1)
        # link_check ran without --fix: it read the body to explain the missing
        # link, and repaired nothing (that is the PR step's job).
        self.assertIn(
            "link| detail: the PR body has a closing keyword for #62, but GitHub has "
            "not linked it (--fix re-saves the body)\n",
            proc.stdout,
        )
        self.assertNotIn("link| fix:", proc.stdout)
        self.assertIn("result: NOT_LINKED\n", proc.stdout)
        # The result's detail is link_check's own, not a blanket "--fix".
        self.assertIn(
            "detail: merging now would leave issue #62 open — the PR body has a "
            "closing keyword for #62, but GitHub has not linked it",
            proc.stdout,
        )
        self.assertNotIn("--fix", [arg for call in calls for arg in call])
        self.assertEqual(
            [call for call in calls if call[:2] in (["pr", "edit"], ["pr", "merge"])],
            [],
        )

    def test_not_linked_without_a_keyword_says_so(self):
        pr = "57"
        issue = "64"
        proc, calls = run_script(
            [pr, "--issue", issue],
            {
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                ("pr", "view", pr, "--json", "baseRefName"): "main\n",
                ("repo", "view", "--json", "defaultBranchRef"): "main\n",
                ("pr", "view", pr, "--json", "closingIssuesReferences"): "\n",
                ("pr", "view", pr, "--json", "body"): "See #64\n",
            },
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("result: NOT_LINKED\n", proc.stdout)
        self.assertIn(
            "detail: merging now would leave issue #64 open — the PR body has no "
            "Closes/Fixes/Resolves keyword\n",
            proc.stdout,
        )
        self.assertEqual(
            [c for c in calls if c[:2] in (["pr", "edit"], ["pr", "merge"])], []
        )

    def test_link_check_error_is_reported_as_error_and_never_merges(self):
        pr = "58"
        issue = "63"
        base = ("pr", "view", pr, "--json", "baseRefName")
        proc, calls = run_script(
            [pr, "--issue", issue],
            {
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                base: "",
            },
            exits={base: 1},
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("link| verdict: ERROR\n", proc.stdout)
        self.assertIn("result: ERROR\n", proc.stdout)
        self.assertIn(
            f"detail: link_check.sh failed — could not read PR #{pr}\n", proc.stdout
        )
        self.assertNotIn("result: NOT_LINKED", proc.stdout)
        self.assertEqual(
            [
                call
                for call in calls
                if call[:2] in (["pr", "edit"], ["pr", "merge"], ["pr", "ready"])
            ],
            [],
        )

    def test_draft_no_ready_reports_draft_result(self):
        pr = "55"
        proc, calls = run_script(
            [pr, "--no-ready", "--no-link-check"],
            {state_prefix(pr): "OPEN\n", draft_prefix(pr): "true\n"},
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("draft: true\n", proc.stdout)
        self.assertIn("result: DRAFT\n", proc.stdout)
        self.assertEqual([call for call in calls if call[:2] == ["pr", "ready"]], [])

    def test_draft_ready_command_fails(self):
        pr = "56"
        ready = ("pr", "ready", pr)
        proc, calls = run_script(
            [pr, "--no-link-check"],
            {state_prefix(pr): "OPEN\n", draft_prefix(pr): "true\n", ready: ""},
            exits={ready: 1},
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("draft: true\n", proc.stdout)
        self.assertIn("result: DRAFT\n", proc.stdout)
        self.assertIn("gh pr ready", proc.stdout)
        self.assertTrue(any(call[:2] == ["pr", "ready"] for call in calls))

    def test_merge_success_but_final_state_not_confirmed_is_merge_unconfirmed(self):
        pr = "57"
        merge = ("pr", "merge", pr, "--squash", "--delete-branch")
        proc, calls = run_script(
            [pr, "--method", "squash", "--no-link-check"],
            {
                # state_prefix is queried both before the merge (must read
                # OPEN to proceed) and again afterward to confirm; the fake
                # always answers the same value for a given prefix, so
                # answering OPEN here naturally reproduces "merge succeeded
                # but gh still reports the PR as not-yet-merged".
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                merge_state_prefix(pr): "CLEAN\n",
                merge: "",
            },
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("result: MERGE_UNCONFIRMED\n", proc.stdout)
        self.assertIn("state: OPEN\n", proc.stdout)
        self.assertTrue(any(call[:2] == ["pr", "merge"] for call in calls))

    def test_auto_is_an_unknown_argument(self):
        # The skill never arms GitHub auto-merge: nothing would confirm the
        # issue closed once it landed, so the flag is gone rather than refused.
        proc, calls = run_script(["27", "--issue", "41", "--auto"], {})

        self.assertEqual(proc.returncode, 2)
        self.assertIn("Unknown argument: --auto", proc.stderr)
        self.assertEqual(proc.stdout, "")
        self.assertEqual(calls, [])

    def test_clean_linked_pr_merges_and_confirms_the_issue(self):
        pr = "27"
        issue = "41"
        merge = ("pr", "merge", pr, "--squash", "--delete-branch")
        proc, calls = run_script(
            [pr, "--issue", issue, "--method", "squash"],
            {
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                ("pr", "view", pr, "--json", "baseRefName"): "main\n",
                ("repo", "view", "--json", "defaultBranchRef"): "main\n",
                ("pr", "view", pr, "--json", "closingIssuesReferences"): f"{issue}\n",
                merge_state_prefix(pr): "CLEAN\n",
                merge: "",
                issue_view_prefix(issue): "CLOSED\n",
            },
            sequences={state_prefix(pr): ["OPEN\n", "MERGED\n"]},
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("link| verdict: LINKED\n", proc.stdout)
        self.assertIn("result: MERGED\n", proc.stdout)
        self.assertIn(f"issue: CLOSED (#{issue})\n", proc.stdout)
        self.assertIn(list(merge) + ["--match-head-commit", SHA], calls)
        self.assertIn(f"head_sha: {SHA}\n", proc.stdout)
        self.assertNotIn("--fix", [arg for call in calls for arg in call])
        self.assertNotIn("--auto", [arg for call in calls for arg in call])
        self.assertEqual([c for c in calls if c[:2] == ["pr", "edit"]], [])

    def test_a_given_head_sha_is_the_commit_merged(self):
        pr = "33"
        given = "fedcba9876543210fedcba9876543210fedcba98"
        merge = ("pr", "merge", pr, "--squash", "--delete-branch")
        proc, calls = run_script(
            [pr, "--method", "squash", "--no-link-check", "--head-sha", given],
            {
                draft_prefix(pr): "false\n",
                merge_state_prefix(pr): "CLEAN\n",
                merge: "",
            },
            sequences={state_prefix(pr): ["OPEN\n", "MERGED\n"]},
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(list(merge) + ["--match-head-commit", given], calls)
        # The caller's SHA is the one CI verified; the live head is not re-read.
        self.assertEqual([c for c in calls if c[:5] == list(head_prefix(pr))], [])

    def test_the_head_is_read_before_the_merge_state(self):
        pr = "34"
        proc, calls = run_script(
            [pr, "--method", "squash", "--no-link-check"],
            {
                draft_prefix(pr): "false\n",
                merge_state_prefix(pr): "CLEAN\n",
                ("pr", "merge", pr): "",
            },
            sequences={state_prefix(pr): ["OPEN\n", "MERGED\n"]},
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        order = [
            c[4]
            for c in calls
            if c[:2] == ["pr", "view"] and c[4] in ("headRefOid", "mergeStateStatus")
        ]
        self.assertEqual(order, ["headRefOid", "mergeStateStatus"])

    def test_an_unreadable_head_is_an_error_and_never_merges(self):
        pr = "35"
        proc, calls = run_script(
            [pr, "--method", "squash", "--no-link-check"],
            {
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                head_prefix(pr): "",
                merge_state_prefix(pr): "CLEAN\n",
            },
            exits={head_prefix(pr): 1},
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("result: ERROR\n", proc.stdout)
        self.assertIn("cannot read the head commit", proc.stdout)
        self.assertEqual([c for c in calls if c[:2] == ["pr", "merge"]], [])

    def test_a_malformed_head_sha_is_a_usage_error(self):
        proc, calls = run_script(["36", "--head-sha", "not-a-sha"], {})

        self.assertEqual(proc.returncode, 2)
        self.assertIn("--head-sha needs a commit SHA", proc.stderr)
        self.assertEqual(calls, [])

    def test_dry_run_on_a_merged_pr_never_closes_the_issue(self):
        pr = "37"
        issue = "65"
        proc, calls = run_script(
            [pr, "--issue", issue, "--dry-run"],
            {state_prefix(pr): "MERGED\n", issue_view_prefix(issue): "OPEN\n"},
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("result: ALREADY_MERGED\n", proc.stdout)
        self.assertIn(f"issue: WOULD_CLOSE (#{issue}", proc.stdout)
        self.assertEqual([c for c in calls if c[:2] == ["issue", "close"]], [])

    def test_a_lazily_computed_merge_state_is_read_once_more(self):
        pr = "32"
        merge = ("pr", "merge", pr, "--squash", "--delete-branch")
        for first, second, merged in (
            ("UNKNOWN", "CLEAN", True),
            ("DRAFT", "BLOCKED", False),
        ):
            with self.subTest(first=first, second=second):
                proc, calls, sleeps = run_script_with_sleep_stub(
                    [pr, "--method", "squash", "--no-link-check"],
                    {
                        draft_prefix(pr): "false\n",
                        merge: "",
                    },
                    sequences={
                        state_prefix(pr): ["OPEN\n", "MERGED\n"],
                        merge_state_prefix(pr): [f"{first}\n", f"{second}\n"],
                    },
                )

                reads = [c for c in calls if c[:5] == list(merge_state_prefix(pr))]
                self.assertEqual(len(reads), 2)
                self.assertEqual(sleeps, ["5"])
                if merged:
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    self.assertIn("result: MERGED\n", proc.stdout)
                else:
                    self.assertEqual(proc.returncode, 1)
                    self.assertIn("result: NOT_CLEAN\n", proc.stdout)
                    self.assertIn(f"merge_state: {second}\n", proc.stdout)
                    self.assertEqual([c for c in calls if c[:2] == ["pr", "merge"]], [])

    def test_refuses_to_merge_unless_the_merge_state_is_clean(self):
        pr = "30"
        merge = ("pr", "merge", pr, "--squash", "--delete-branch")
        for merge_state in ("BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "HAS_HOOKS"):
            with self.subTest(merge_state=merge_state):
                proc, calls = run_script(
                    [pr, "--method", "squash", "--no-link-check"],
                    {
                        state_prefix(pr): "OPEN\n",
                        draft_prefix(pr): "false\n",
                        merge_state_prefix(pr): f"{merge_state}\n",
                        merge: "",
                        inspect_prefix(pr): (
                            f'{{"mergeable":"MERGEABLE","mergeStateStatus":"{merge_state}",'
                            '"reviewDecision":"REVIEW_REQUIRED"}\n'
                        ),
                    },
                )

                self.assertEqual(proc.returncode, 1)
                self.assertIn("result: NOT_CLEAN\n", proc.stdout)
                self.assertIn(f"merge_state: {merge_state}\n", proc.stdout)
                self.assertIn('"reviewDecision":"REVIEW_REQUIRED"', proc.stdout)
                self.assertEqual([c for c in calls if c[:2] == ["pr", "merge"]], [])

    def test_an_unreadable_merge_state_is_not_clean(self):
        pr = "31"
        proc, calls = run_script(
            [pr, "--method", "squash", "--no-link-check"],
            {
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                merge_state_prefix(pr): "",
            },
            exits={merge_state_prefix(pr): 1},
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("result: NOT_CLEAN\n", proc.stdout)
        self.assertIn("merge_state: UNREADABLE\n", proc.stdout)
        self.assertEqual([c for c in calls if c[:2] == ["pr", "merge"]], [])

    def test_merge_refusal_reports_failure(self):
        pr = "28"
        merge = ("pr", "merge", pr, "--squash", "--delete-branch")
        inspect = inspect_prefix(pr)
        proc, calls = run_script(
            [pr, "--method", "squash", "--no-link-check"],
            {
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                merge_state_prefix(pr): "CLEAN\n",
                merge: "",
                inspect: '{"mergeable":"CONFLICTING","mergeStateStatus":"BLOCKED",'
                '"reviewDecision":"CHANGES_REQUESTED"}\n',
            },
            exits={merge: 1},
            stderrs={merge: "merge blocked\n"},
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("result: MERGE_REFUSED\n", proc.stdout)
        self.assertIn("  merge blocked\n", proc.stdout)
        self.assertIn(list(inspect), calls)

    def test_dry_run_never_calls_mutating_gh_commands(self):
        pr = "29"
        issue = "42"
        base = ("pr", "view", pr, "--json", "baseRefName")
        closing = ("pr", "view", pr, "--json", "closingIssuesReferences")
        default_branch = ("repo", "view", "--json", "defaultBranchRef")
        proc, calls = run_script(
            [pr, "--issue", issue, "--method", "squash", "--dry-run"],
            {
                state_prefix(pr): "OPEN\n",
                draft_prefix(pr): "false\n",
                base: "main\n",
                default_branch: "main\n",
                closing: "42\n",
                inspect_prefix(
                    pr
                ): '{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN",'
                '"reviewDecision":"APPROVED"}\n',
            },
        )

        mutating = [
            call
            for call in calls
            if call[:2]
            in (["pr", "merge"], ["pr", "ready"], ["pr", "edit"], ["issue", "close"])
        ]
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("result: DRY_RUN\n", proc.stdout)
        self.assertIn("link| verdict: LINKED\n", proc.stdout)
        self.assertEqual(mutating, [])


class ReviewLogGuardTest(unittest.TestCase):
    """--review-log: an open PR merges only on review_watch.py's CLEAN or
    FINDINGS verdict for this same PR, or its NO_NEW_REVIEW for the head being
    merged."""

    def _land(self, pr, log_text):
        merge = ("pr", "merge", pr, "--squash", "--delete-branch")
        with tempfile.TemporaryDirectory() as td:
            log = Path(td) / "review.log"
            if log_text is not None:
                log.write_text(log_text, encoding="utf-8")
            proc, calls = run_script(
                [pr, "--method", "squash", "--review-log", str(log)],
                {
                    state_prefix(pr): "OPEN\n",
                    draft_prefix(pr): "false\n",
                    merge_state_prefix(pr): "CLEAN\n",
                    merge: "",
                },
                sequences={state_prefix(pr): ["OPEN\n", "MERGED\n"]},
            )
        merges = [call for call in calls if call[:2] == ["pr", "merge"]]
        return proc, merges

    def test_a_clean_review_lets_the_merge_through(self):
        proc, merges = self._land("61", "verdict: CLEAN\npr: 61\nfindings: 0\n")

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("review: CLEAN\n", proc.stdout)
        self.assertIn("result: MERGED\n", proc.stdout)
        self.assertEqual(len(merges), 1)

    def test_a_findings_review_lets_the_merge_through(self):
        proc, merges = self._land("62", "verdict: FINDINGS\npr: 62\nfindings: 2\n")

        self.assertIn("result: MERGED\n", proc.stdout)
        self.assertEqual(len(merges), 1)

    def test_no_new_review_after_the_merged_head_lets_the_merge_through(self):
        proc, merges = self._land(
            "67", f"verdict: NO_NEW_REVIEW\npr: 67\nafter_push: {SHA[:12]}\n"
        )

        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("review: NO_NEW_REVIEW\n", proc.stdout)
        self.assertIn("result: MERGED\n", proc.stdout)
        self.assertEqual(len(merges), 1)

    def test_no_new_review_after_another_push_refuses_the_merge(self):
        # The grace ran out for an earlier push; the head now is a later one.
        for line in ("after_push: 89abcdef0123\n", "after_push: none\n", ""):
            with self.subTest(line=line):
                proc, merges = self._land(
                    "68", f"verdict: NO_NEW_REVIEW\npr: 68\n{line}"
                )

                self.assertEqual(proc.returncode, 1)
                self.assertIn("result: REVIEW_UNSETTLED\n", proc.stdout)
                self.assertIn(f"not the head {SHA}", proc.stdout)
                self.assertEqual(merges, [])

    def test_an_unsettled_review_refuses_the_merge(self):
        for verdict in ("PENDING_TIMEOUT", "NO_REVIEW", "ERROR"):
            with self.subTest(verdict=verdict):
                proc, merges = self._land("63", f"verdict: {verdict}\npr: 63\n")

                self.assertEqual(proc.returncode, 1)
                self.assertIn(f"review: {verdict}\n", proc.stdout)
                self.assertIn("result: REVIEW_UNSETTLED\n", proc.stdout)
                self.assertEqual(merges, [])

    def test_a_missing_log_refuses_the_merge(self):
        proc, merges = self._land("64", None)

        self.assertEqual(proc.returncode, 1)
        self.assertIn("review: UNREADABLE\n", proc.stdout)
        self.assertIn("result: REVIEW_UNSETTLED\n", proc.stdout)
        self.assertEqual(merges, [])

    def test_another_prs_log_refuses_the_merge(self):
        proc, merges = self._land("65", "verdict: CLEAN\npr: 66\n")

        self.assertEqual(proc.returncode, 1)
        self.assertIn("result: REVIEW_UNSETTLED\n", proc.stdout)
        self.assertIn("log for PR #66, not #65", proc.stdout)
        self.assertEqual(merges, [])


if __name__ == "__main__":
    unittest.main()
