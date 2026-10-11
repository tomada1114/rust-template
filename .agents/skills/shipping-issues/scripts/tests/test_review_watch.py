#!/usr/bin/env python3
"""Tests for review_watch.py. Stdlib-only (unittest).

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)

The fixtures copy the shapes the Codex GitHub integration actually posted on
uv-template PRs 159, 160, 170 and 171 (read
2026-10-07): the
edited-in-place summary comment (`🔄 **Running** since ...`, then
`✅ **Completed** ...`), a COMMENTED review, its inline comments with a
priority badge, and the 👍 reaction a clean review leaves.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _fakegh import FakeGh

SCRIPT = Path(__file__).resolve().parent.parent / "review_watch.py"

BOT = "chatgpt-codex-connector[bot]"
HEAD = "564ca82e3ae32d38ecb4eae6bb59e6d59cd69e3f"
FIXED = "ba9af56003b69ac1f5f5b7e537e068c5de528f19"
MARKER = "<!-- codex-pull-request-review-summary -->"

# --- argv prefixes the script drives `gh` with --------------------------------


def PR_VIEW(pr):
    return ("api", f"repos/{{owner}}/{{repo}}/pulls/{pr}")


def ISSUE_COMMENTS(pr):
    return ("api", f"repos/{{owner}}/{{repo}}/issues/{pr}/comments")


def REVIEWS(pr):
    return ("api", f"repos/{{owner}}/{{repo}}/pulls/{pr}/reviews")


def INLINE(pr):
    return ("api", f"repos/{{owner}}/{{repo}}/pulls/{pr}/comments")


def REACTIONS(pr):
    return ("api", f"repos/{{owner}}/{{repo}}/issues/{pr}/reactions")


def COMMITS(pr):
    return ("api", f"repos/{{owner}}/{{repo}}/pulls/{pr}/commits")


REPO_VIEW = ("api", "repos/{owner}/{repo}")

# --- payloads -----------------------------------------------------------------


def opened(seconds_ago):
    stamp = datetime.fromtimestamp(time.time() - seconds_ago, tz=timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%SZ")


def pr_json(seconds_ago=60, *, draft=False, head=HEAD, state="open", merged_at=None):
    """The REST "get a pull request" shape (only the fields the script reads)."""
    body = {
        "created_at": opened(seconds_ago),
        "draft": draft,
        "state": state,
        "merged_at": merged_at,
    }
    if head is not None:
        body["head"] = {"sha": head}
    return json.dumps(body)


def lines(*items):
    """What `gh api ... --paginate -q '.[] | @json'` prints: one object a line."""
    return "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in items)


def user(login=BOT, kind="Bot"):
    return {"login": login, "type": kind}


def summary_body(
    status="✅ **Completed**",
    sha="`564ca82`",
    trigger="PR opened",
    at="2026-10-07T19:27:19.028799Z",
):
    return (
        f"{MARKER}\n\n## Codex Review Summary\n\n"
        "This comment shows the latest Codex review activity on this pull request.\n\n"
        "| Review | Status | Commit | Review trigger |\n"
        "| --- | --- | --- | --- |\n"
        f'| 📝 **Code Review** | {status} <relative-time datetime="{at}">'
        f"{at}</relative-time> | {sha} | {trigger} |\n\n"
        "<details> <summary>About Codex in GitHub</summary>\n</details>"
    )


def summary(body=None, *, author=None, cid=6045199702):
    return {
        "id": cid,
        "user": author or user(),
        "body": body or summary_body(),
        "created_at": "2026-10-07T19:24:54Z",
        "updated_at": "2026-10-07T19:27:19Z",
    }


def review(rid=5444206399, commit=HEAD, author=None, at="2026-10-07T19:27:17Z"):
    return {
        "id": rid,
        "user": author or user(),
        "state": "COMMENTED",
        "commit_id": commit,
        "submitted_at": at,
        "body": "\n### 💡 Codex Review\n\nHere are some "
        "automated review suggestions for this pull request.\n",
        "html_url": f"https://github.com/o/r/pull/7#pullrequestreview-{rid}",
    }


def inline(
    cid,
    title,
    *,
    priority="P1",
    path="AGENTS.md",
    line=206,
    review_id=5444206399,
    reply_to=None,
    author=None,
):
    body = (
        f"**<sub><sub>![{priority} Badge](https://img.shields.io/badge/{priority}"
        f"-orange?style=flat)</sub></sub>  {title}**\n\nWhy it matters, in full.\n\n"
        "Useful? React with 👍 / 👎."
    )
    return {
        "id": cid,
        "user": author or user(),
        "pull_request_review_id": review_id,
        "in_reply_to_id": reply_to,
        "path": path,
        "line": line,
        "original_line": line,
        "commit_id": FIXED,
        "original_commit_id": HEAD,
        "html_url": f"https://github.com/o/r/pull/7#discussion_r{cid}",
        "body": body,
    }


def reaction(content="+1", author=None):
    # The reactions API reports the Codex app's reaction with type "User"
    # (observed on uv-template PR 170): the `[bot]` login is what identifies it.
    return {"content": content, "user": author or user(kind="User")}


def run_script(args, responses, *, sequences=None, exits=None, read=None):
    """Run the script against a fake gh; returns (proc, calls, file text).

    `read` names a path relative to the fake's state dir to read back before
    the temp dir goes away (the default findings file lives there)."""
    with FakeGh(responses, sequences=sequences, exits=exits) as fake:
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--interval", "0"],
            env=fake.env,
            text=True,
            capture_output=True,
        )
        calls = list(fake.calls)
        text = None
        if read is not None:
            path = fake.state_dir / read
            text = path.read_text(encoding="utf-8") if path.exists() else None
    return proc, calls, text


def field(stdout, name):
    for line in stdout.splitlines():
        if line.startswith(name + ": "):
            return line[len(name) + 2 :]
    return None


def completed(pr, *, extra=None, commits=(HEAD,)):
    """A PR whose opening review completed for HEAD; `extra` adds responses."""
    responses = {
        PR_VIEW(pr): pr_json(),
        ISSUE_COMMENTS(pr): lines(summary()),
        COMMITS(pr): "".join(sha + "\n" for sha in commits),
        REPO_VIEW: "o/r",
    }
    responses.update(extra or {})
    return responses


class UsageTest(unittest.TestCase):
    def test_missing_pr_is_a_usage_error_and_never_calls_gh(self):
        proc, calls, _ = run_script([], {})

        self.assertEqual(proc.returncode, 4)
        self.assertIn("Usage: review_watch.py <pr-number>", proc.stderr)
        self.assertEqual(calls, [])

    def test_help_flag_prints_own_usage_and_never_calls_gh(self):
        for flag in ("-h", "--help"):
            with self.subTest(flag=flag):
                proc, calls, _ = run_script([flag], {})

                self.assertEqual(proc.returncode, 0)
                self.assertIn(
                    "review_watch.py — Wait for a PR's Codex reviews", proc.stdout
                )
                self.assertIn("Exit codes: 0 = CLEAN", proc.stdout)
                self.assertEqual(calls, [])

    def test_a_non_numeric_timeout_is_a_usage_error(self):
        proc, calls, _ = run_script(["7", "--timeout", "soon"], {})

        self.assertEqual(proc.returncode, 4)
        self.assertIn("--timeout needs a whole number", proc.stderr)
        self.assertEqual(calls, [])

    def test_an_unknown_argument_is_a_usage_error(self):
        proc, calls, _ = run_script(["7", "--request-review"], {})

        self.assertEqual(proc.returncode, 4)
        self.assertIn("Unknown argument: --request-review", proc.stderr)
        self.assertEqual(calls, [])


class VerdictTest(unittest.TestCase):
    def test_an_unreadable_pr_is_an_error_at_once(self):
        pr = "7"
        proc, calls, _ = run_script(
            [pr, "--timeout", "600"], {PR_VIEW(pr): ""}, exits={PR_VIEW(pr): 1}
        )

        self.assertEqual(proc.returncode, 4)
        self.assertEqual(field(proc.stdout, "verdict"), "ERROR")
        self.assertIn("could not read PR #7", field(proc.stdout, "detail"))
        self.assertEqual(len(calls), 1)

    def test_summary_not_posted_yet_on_a_young_pr_is_pending(self):
        pr = "7"
        proc, _, _ = run_script([pr, "--timeout", "0"], {PR_VIEW(pr): pr_json(60)})

        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "PENDING_TIMEOUT")
        self.assertEqual(field(proc.stdout, "review_status"), "none")
        self.assertEqual(field(proc.stdout, "findings"), "0")
        self.assertIn("not posted yet", field(proc.stdout, "detail"))

    def test_no_trace_of_the_bot_past_the_grace_is_no_review(self):
        pr = "7"
        proc, _, _ = run_script([pr, "--timeout", "600"], {PR_VIEW(pr): pr_json(1000)})

        self.assertEqual(proc.returncode, 3, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "NO_REVIEW")
        self.assertIn("grace 900s", field(proc.stdout, "detail"))

    def test_a_shorter_grace_is_honoured(self):
        pr = "7"
        proc, _, _ = run_script(
            [pr, "--timeout", "0", "--grace", "30"], {PR_VIEW(pr): pr_json(60)}
        )

        self.assertEqual(field(proc.stdout, "verdict"), "NO_REVIEW")

    def test_a_completed_security_review_alone_is_pending_not_clean(self):
        pr = "7"
        security_only = summary_body().replace("Code Review", "Security Review")
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            {
                PR_VIEW(pr): pr_json(1000),
                ISSUE_COMMENTS(pr): lines(summary(security_only)),
                REACTIONS(pr): lines(reaction("+1")),
            },
        )

        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "PENDING_TIMEOUT")
        self.assertIn("no Code Review row", field(proc.stdout, "detail"))

    def test_the_code_review_row_is_read_past_a_security_review_row(self):
        pr = "7"
        body = summary_body(status="🔄 **Running** since").replace(
            "| 📝 **Code Review**",
            "| 🔒 **Security Review** | ✅ **Completed** | `564ca82` | PR opened |\n"
            "| 📝 **Code Review**",
        )
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            {PR_VIEW(pr): pr_json(1000), ISSUE_COMMENTS(pr): lines(summary(body))},
        )

        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertEqual(field(proc.stdout, "review_status"), "Running")

    def test_a_running_review_past_the_grace_is_pending_not_no_review(self):
        pr = "7"
        running = summary(summary_body(status="🔄 **Running** since", sha="`564ca82`"))
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            {
                PR_VIEW(pr): pr_json(1000),
                ISSUE_COMMENTS(pr): lines(running),
                REACTIONS(pr): lines(reaction("eyes")),
            },
        )

        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "PENDING_TIMEOUT")
        self.assertEqual(field(proc.stdout, "review_status"), "Running")
        self.assertEqual(field(proc.stdout, "completed_at"), "none")
        self.assertIn("Running", field(proc.stdout, "detail"))

    def test_completed_with_findings_lists_each_and_writes_bodies_to_a_file(self):
        pr = "7"
        human = {"login": "repo-owner", "type": "User"}
        proc, calls, text = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                extra={
                    REVIEWS(pr): lines(review()),
                    INLINE(pr): lines(
                        inline(
                            4208464001,
                            "Second finding",
                            priority="P2",
                            path="src/x.py",
                            line=3,
                        ),
                        inline(4208464000, "Adapt remaining Codex workflows"),
                        inline(
                            4208464002, "a reply in the thread", reply_to=4208464000
                        ),
                        inline(4208464003, "a person's comment", author=human),
                    ),
                },
            ),
            read="shipping-issues/o__r/review/7-findings.md",
        )

        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "FINDINGS")
        self.assertEqual(field(proc.stdout, "reviewed_sha"), "564ca82")
        self.assertEqual(field(proc.stdout, "head_sha"), HEAD)
        self.assertEqual(field(proc.stdout, "trigger"), "PR opened")
        self.assertEqual(field(proc.stdout, "findings"), "2")
        self.assertIn(
            "  - F1 [P1] AGENTS.md:206 id=4208464000 round=1 — "
            "Adapt remaining Codex workflows\n",
            proc.stdout,
        )
        self.assertIn(
            "  - F2 [P2] src/x.py:3 id=4208464001 round=1 — Second finding\n",
            proc.stdout,
        )
        self.assertEqual(field(proc.stdout, "round"), "1")
        self.assertEqual(field(proc.stdout, "rounds"), "1")
        self.assertEqual(field(proc.stdout, "round_findings"), "2")
        self.assertEqual(field(proc.stdout, "cap_reached"), "no")
        self.assertEqual(field(proc.stdout, "after_push"), "none")
        # Bodies go to the file, never into the caller's output.
        self.assertNotIn("Why it matters", proc.stdout)
        self.assertTrue(
            field(proc.stdout, "findings_file").endswith(
                "shipping-issues/o__r/review/7-findings.md"
            )
        )
        self.assertIn("## F1 [P1] AGENTS.md:206 id=4208464000 round=1", text)
        self.assertIn("Why it matters, in full.", text)
        self.assertNotIn("a person's comment", text)
        self.assertNotIn("a reply in the thread", text)
        self.assertIsNone(field(proc.stdout, "detail"))

    def test_an_explicit_findings_file_is_used(self):
        pr = "7"
        with FakeGh(
            completed(
                pr,
                extra={
                    REVIEWS(pr): lines(review()),
                    INLINE(pr): lines(inline(1, "One")),
                },
            )
        ) as fake:
            target = fake.state_dir / "elsewhere" / "f.md"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    pr,
                    "--timeout",
                    "0",
                    "--interval",
                    "0",
                    "--findings-file",
                    str(target),
                ],
                env=fake.env,
                text=True,
                capture_output=True,
            )
            written = target.read_text(encoding="utf-8")

        self.assertEqual(field(proc.stdout, "findings_file"), str(target))
        self.assertIn("## F1 [P1] AGENTS.md:206 id=1", written)

    def test_a_review_without_inline_comments_is_still_a_finding(self):
        pr = "7"
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                extra={
                    REVIEWS(pr): lines(review(rid=99)),
                },
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "FINDINGS")
        self.assertIn("  - F1 [P?] - id=review-99 round=1 — ", proc.stdout)

    def test_completed_with_no_findings_and_the_thumbs_up_is_clean(self):
        pr = "7"
        proc, calls, _ = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                extra={
                    REACTIONS(pr): lines(reaction("+1")),
                },
            ),
        )

        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "CLEAN")
        self.assertEqual(field(proc.stdout, "findings"), "0")
        self.assertEqual(field(proc.stdout, "thumbs_up"), "yes")
        self.assertEqual(field(proc.stdout, "reviewed_is_head"), "yes")
        self.assertEqual(
            field(proc.stdout, "completed_at"), "2026-10-07T19:27:19.028799Z"
        )
        self.assertIsNone(field(proc.stdout, "findings_file"))
        # The reviewed commit is the head: the PR's commit list is never read.
        self.assertNotIn(list(COMMITS(pr)), [c[:2] for c in calls])

    def test_completed_with_no_findings_is_clean_without_the_thumbs_up(self):
        # The 👍 corroborates; its absence alone is neither a wait nor a finding.
        pr = "7"
        proc, _, _ = run_script([pr, "--timeout", "0"], completed(pr))

        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "CLEAN")
        self.assertEqual(field(proc.stdout, "thumbs_up"), "no")

    def test_a_thumbs_up_from_anyone_else_is_not_reported_as_the_bots(self):
        pr = "7"
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                extra={
                    REACTIONS(pr): lines(
                        reaction("+1", author={"login": "repo-owner", "type": "User"})
                    ),
                },
            ),
        )

        self.assertEqual(field(proc.stdout, "thumbs_up"), "no")

    def test_a_thumbs_up_without_a_completed_summary_is_not_clean(self):
        pr = "7"
        running = summary(summary_body(status="🔄 **Running** since", sha="`564ca82`"))
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            {
                PR_VIEW(pr): pr_json(),
                ISSUE_COMMENTS(pr): lines(running),
                REACTIONS(pr): lines(reaction("+1")),
            },
        )

        self.assertEqual(field(proc.stdout, "verdict"), "PENDING_TIMEOUT")

    def test_waits_through_not_posted_and_running_to_completion(self):
        pr = "7"
        running = summary(summary_body(status="🔄 **Running** since", sha="`564ca82`"))
        proc, calls, _ = run_script(
            [pr, "--timeout", "60"],
            completed(pr),
            sequences={
                ISSUE_COMMENTS(pr): ["", lines(running), lines(summary())],
                REACTIONS(pr): [
                    "",
                    lines(reaction("eyes")),
                    lines(reaction("eyes"), reaction("+1")),
                ],
            },
        )

        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "CLEAN")
        summary_reads = [c for c in calls if tuple(c[:2]) == ISSUE_COMMENTS(pr)]
        self.assertEqual(len(summary_reads), 3)

    def test_a_marker_quoted_by_a_person_is_not_the_review(self):
        pr = "7"
        impostor = summary(author={"login": "chatgpt-codex-connector", "type": "User"})
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            {
                PR_VIEW(pr): pr_json(1000),
                ISSUE_COMMENTS(pr): lines(impostor),
            },
        )

        self.assertEqual(field(proc.stdout, "verdict"), "NO_REVIEW")

    def test_a_non_bracket_login_needs_the_bot_account_type(self):
        pr = "7"
        other = "review-app"
        proc, _, _ = run_script(
            [pr, "--timeout", "0", "--bot", other],
            {
                PR_VIEW(pr): pr_json(1000),
                ISSUE_COMMENTS(pr): lines(
                    summary(author={"login": other, "type": "User"})
                ),
            },
        )

        self.assertEqual(field(proc.stdout, "verdict"), "NO_REVIEW")

    def test_the_bot_login_can_be_overridden(self):
        pr = "7"
        other = "another-reviewer[bot]"
        proc, _, _ = run_script(
            [pr, "--timeout", "0", "--bot", other],
            completed(
                pr,
                extra={
                    ISSUE_COMMENTS(pr): lines(summary(author=user(other))),
                    REACTIONS(pr): lines(reaction("+1", author=user(other, "User"))),
                },
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "CLEAN")
        self.assertEqual(field(proc.stdout, "bot"), other)

    def test_a_failed_review_is_an_error(self):
        pr = "7"
        failed = summary(summary_body(status="❌ **Failed**", sha="`564ca82`"))
        proc, _, _ = run_script(
            [pr, "--timeout", "600"],
            {
                PR_VIEW(pr): pr_json(),
                ISSUE_COMMENTS(pr): lines(failed),
            },
        )

        self.assertEqual(proc.returncode, 4, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "ERROR")
        self.assertIn("'Failed'", field(proc.stdout, "detail"))

    def test_a_reviewed_commit_that_is_not_on_the_pr_is_an_error(self):
        pr = "7"
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                commits=(FIXED,),
                extra={
                    PR_VIEW(pr): pr_json(head=FIXED),
                    REACTIONS(pr): lines(reaction("+1")),
                },
            ),
        )

        self.assertEqual(proc.returncode, 4, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "ERROR")
        self.assertIn("564ca82 is not a commit of PR #7", field(proc.stdout, "detail"))

    def test_a_completed_summary_with_no_commit_is_an_error(self):
        pr = "7"
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                extra={
                    ISSUE_COMMENTS(pr): lines(summary(summary_body(sha="—"))),
                },
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "ERROR")
        self.assertIn("names no reviewed commit", field(proc.stdout, "detail"))

    def test_a_review_of_an_earlier_commit_still_counts_after_a_push(self):
        # Fixes were pushed after the opening review and no review of the new
        # head has settled: the head moved on, the reviewed commit is still on
        # the PR, and the opening review is still the latest settled one.
        pr = "7"
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                commits=(HEAD, FIXED),
                extra={
                    PR_VIEW(pr): pr_json(head=FIXED),
                    REVIEWS(pr): lines(review()),
                    INLINE(pr): lines(inline(1, "Fixed already")),
                },
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "FINDINGS")
        self.assertEqual(field(proc.stdout, "reviewed_sha"), "564ca82")
        self.assertEqual(field(proc.stdout, "head_sha"), FIXED)
        self.assertEqual(field(proc.stdout, "reviewed_is_head"), "no")

    def test_a_draft_pr_is_an_error_because_it_is_never_reviewed(self):
        pr = "7"
        proc, _, _ = run_script(
            [pr, "--timeout", "600"], {PR_VIEW(pr): pr_json(draft=True)}
        )

        self.assertEqual(proc.returncode, 4)
        self.assertIn("is a draft", field(proc.stdout, "detail"))

    def test_a_read_failure_when_the_wait_ends_is_an_error_not_a_verdict(self):
        pr = "7"
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            {
                PR_VIEW(pr): pr_json(1000),
                ISSUE_COMMENTS(pr): "",
            },
            exits={ISSUE_COMMENTS(pr): 1},
        )

        self.assertEqual(proc.returncode, 4, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "ERROR")

    def test_a_transient_read_failure_is_retried(self):
        pr = "7"
        proc, _, _ = run_script(
            [pr, "--timeout", "60"],
            completed(
                pr,
                extra={
                    REACTIONS(pr): lines(reaction("+1")),
                },
            ),
            sequences={
                ISSUE_COMMENTS(pr): [("", 1), lines(summary())],
            },
        )

        self.assertEqual(field(proc.stdout, "verdict"), "CLEAN")

    def test_it_only_reads_and_never_asks_for_a_review(self):
        pr = "7"
        _, calls, _ = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                extra={
                    REVIEWS(pr): lines(review()),
                    INLINE(pr): lines(inline(1, "One")),
                },
            ),
        )

        self.assertTrue(calls)
        for call in calls:
            with self.subTest(call=call):
                self.assertEqual(call[0], "api")
                self.assertTrue(call[1].startswith("repos/{owner}/{repo}"))
                self.assertNotIn("-X", call)
                self.assertNotIn("--method", call)
                self.assertNotIn("-f", call)
                self.assertNotIn("--field", call)


class ReadPrTest(unittest.TestCase):
    """read_pr maps the REST pull request onto the keys poll reads."""

    @staticmethod
    def read(out, pr="7"):
        sys.path.insert(0, str(SCRIPT.parent))
        import review_watch

        with mock.patch.object(review_watch, "gh", return_value=out) as gh:
            result = review_watch.read_pr(pr)
        gh.assert_called_once_with(["api", f"repos/{{owner}}/{{repo}}/pulls/{pr}"])
        return result

    def test_an_open_pr_maps_every_field(self):
        got = self.read(pr_json(60))

        self.assertEqual(got["headRefOid"], HEAD)
        self.assertEqual(got["isDraft"], False)
        self.assertEqual(got["state"], "OPEN")
        self.assertRegex(got["createdAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_a_closed_pr_with_merged_at_is_merged(self):
        got = self.read(pr_json(state="closed", merged_at="2026-10-07T02:00:00Z"))

        self.assertEqual(got["state"], "MERGED")

    def test_a_closed_pr_without_merged_at_is_closed(self):
        self.assertEqual(self.read(pr_json(state="closed"))["state"], "CLOSED")

    def test_a_draft_pr_is_a_draft(self):
        self.assertIs(self.read(pr_json(draft=True))["isDraft"], True)

    def test_a_response_without_head_has_an_empty_head_sha(self):
        self.assertEqual(self.read(pr_json(head=None))["headRefOid"], "")

    def test_non_json_and_non_object_responses_are_unreadable(self):
        sys.path.insert(0, str(SCRIPT.parent))
        import review_watch

        for out in ("not json", "[]", "null"):
            with (
                self.subTest(out=out),
                mock.patch.object(review_watch, "gh", return_value=out),
            ):
                with self.assertRaises(review_watch.PrUnreadableError):
                    review_watch.read_pr("7")


class LaterReviewTest(unittest.TestCase):
    """The summary keeps ONE row, rewritten for the latest review: on PRs
    uv-template PR 154 and uv-template PR 156 (read 2026-10-07) a `@codex review` comment left a single
    `Manual request` row. So the watch remembers the opening review it saw
    settle, and a later, unsolicited review cannot replace that verdict."""

    def _two_runs(self, second_comments, *, second_extra=None):
        """Run 1 sees the opening review complete; run 2 sees the row rewritten."""
        pr = "7"
        later = second_comments
        responses = completed(pr, commits=(HEAD, FIXED), extra=second_extra or {})
        sequences = {
            ISSUE_COMMENTS(pr): [lines(summary()), later],
            PR_VIEW(pr): [pr_json(), pr_json(head=FIXED)],
        }
        with FakeGh(responses, sequences=sequences) as fake:
            argv = [
                sys.executable,
                str(SCRIPT),
                pr,
                "--timeout",
                "0",
                "--interval",
                "0",
            ]
            first = subprocess.run(argv, env=fake.env, text=True, capture_output=True)
            second = subprocess.run(argv, env=fake.env, text=True, capture_output=True)
        return first, second

    def test_a_later_running_review_keeps_the_settled_opening_verdict(self):
        later = lines(
            summary(
                summary_body(
                    status="🔄 **Running** since",
                    sha=f"`{FIXED[:7]}`",
                    trigger="Manual request",
                )
            )
        )
        first, second = self._two_runs(later)

        self.assertEqual(field(first.stdout, "verdict"), "CLEAN", first.stdout)
        self.assertEqual(second.returncode, 0, second.stdout)
        self.assertEqual(field(second.stdout, "verdict"), "CLEAN")
        self.assertEqual(field(second.stdout, "trigger"), "PR opened")
        self.assertEqual(field(second.stdout, "reviewed_sha"), "564ca82")
        self.assertEqual(
            field(second.stdout, "later_review"),
            f"Running (Manual request) for {FIXED[:7]}",
        )
        self.assertEqual(field(second.stdout, "round"), "1")

    def test_findings_a_later_review_already_posted_are_still_collected(self):
        pr = "7"
        later = lines(
            summary(
                summary_body(
                    status="🔄 **Running** since",
                    sha=f"`{FIXED[:7]}`",
                    trigger="Manual request",
                )
            )
        )
        first, second = self._two_runs(
            later,
            second_extra={
                REVIEWS(pr): lines(
                    review(rid=77, commit=FIXED, at="2026-10-07T19:40:00Z")
                ),
                INLINE(pr): lines(inline(9, "Found by the later review", review_id=77)),
            },
        )

        # The bot posts a review only when that review completes, so a review
        # of FIXED is a settled round even while the summary row still lags.
        self.assertEqual(field(second.stdout, "verdict"), "FINDINGS", second.stdout)
        self.assertIn("Found by the later review", second.stdout)
        self.assertIn(" round=", second.stdout)

    def test_a_later_running_review_never_seen_settle_before_is_waited_for(self):
        # No memory of the opening review (another machine, a fresh state
        # dir): the only trusted completion left is the later review's own.
        pr = "7"
        later = summary(
            summary_body(
                status="🔄 **Running** since",
                sha=f"`{FIXED[:7]}`",
                trigger="Manual request",
            )
        )
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                extra={
                    ISSUE_COMMENTS(pr): lines(later),
                },
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "PENDING_TIMEOUT", proc.stdout)
        self.assertIn("Manual request", field(proc.stdout, "detail"))

    def test_a_completed_later_review_settles_when_the_opening_was_never_seen(self):
        pr = "7"
        later = summary(summary_body(sha=f"`{FIXED[:7]}`", trigger="Manual request"))
        proc, _, _ = run_script(
            [pr, "--timeout", "0"],
            completed(
                pr,
                commits=(HEAD, FIXED),
                extra={
                    PR_VIEW(pr): pr_json(head=FIXED),
                    ISSUE_COMMENTS(pr): lines(later),
                },
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "CLEAN", proc.stdout)
        self.assertEqual(field(proc.stdout, "trigger"), "Manual request")


# --- rounds: the reviews of fix-push heads -------------------------------------

# Three more commits a fix round can push, each with its own review time.
SECOND = "13e1998d841619c6112ac1a34da689e8d19cfd7b"
THIRD = "c51b6802f1bef9936a62d5bc02c627f9ca3d4976"
FOURTH = "68bcfba0c2a7d3f1e9b8a6c5d4e3f2a1b0c9d8e7"
AT = {
    HEAD: "2026-10-07T19:27:19Z",
    FIXED: "2026-10-07T19:40:00Z",
    SECOND: "2026-10-07T19:55:00Z",
    THIRD: "2026-10-07T20:10:00Z",
    FOURTH: "2026-10-07T20:25:00Z",
}


def row(sha, *, status="✅ **Completed**", trigger="New commits"):
    """The summary comment, rewritten for a review of `sha`."""
    return lines(
        summary(
            summary_body(status=status, sha=f"`{sha[:7]}`", trigger=trigger, at=AT[sha])
        )
    )


def round_review(rid, sha):
    return review(rid=rid, commit=sha, at=AT[sha])


def round_inline(cid, title, rid, sha, *, priority="P2"):
    comment = inline(cid, title, priority=priority, review_id=rid)
    comment["original_commit_id"] = sha
    return comment


class RoundsTest(unittest.TestCase):
    """Codex may review a PR again after a fix push (a `New commits` row on
    uv-template PRs 184 and 190, observed 2026-10-08). Each settled review is a round,
    numbered in the order it completed; finding numbers only ever append."""

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.state = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def run_watch(self, args, responses, *, sequences=None):
        """One call against its own fake gh, sharing this test's state dir."""
        with FakeGh(responses, sequences=sequences) as fake:
            env = dict(fake.env, AGENT_SKILL_STATE_DIR=str(self.state))
            return subprocess.run(
                [sys.executable, str(SCRIPT), *args, "--interval", "0"],
                env=env,
                text=True,
                capture_output=True,
            )

    def memory(self, pr="7"):
        return self.state / "shipping-issues" / "o__r" / "review" / f"{pr}-rounds.json"

    def pr_state(self, head, commits, comments, *, reviews=(), inlines=()):
        responses = {
            PR_VIEW("7"): pr_json(head=head),
            ISSUE_COMMENTS("7"): comments,
            COMMITS("7"): "".join(sha + "\n" for sha in commits),
            REPO_VIEW: "o/r",
        }
        if reviews:
            responses[REVIEWS("7")] = lines(*reviews)
        if inlines:
            responses[INLINE("7")] = lines(*inlines)
        return responses

    def test_a_review_of_a_fix_push_is_round_two_and_numbers_append(self):
        proc = self.run_watch(
            ["7", "--timeout", "0"],
            self.pr_state(
                FIXED,
                (HEAD, FIXED),
                row(FIXED),
                reviews=(round_review(10, HEAD), round_review(20, FIXED)),
                inlines=(
                    round_inline(2, "Second round", 20, FIXED),
                    round_inline(1, "Opening round", 10, HEAD, priority="P1"),
                ),
            ),
        )

        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "FINDINGS")
        self.assertEqual(field(proc.stdout, "round"), "2")
        self.assertEqual(field(proc.stdout, "rounds"), "2")
        self.assertEqual(field(proc.stdout, "round_findings"), "1")
        self.assertEqual(field(proc.stdout, "reviewed_sha"), FIXED[:7])
        self.assertEqual(field(proc.stdout, "trigger"), "New commits")
        self.assertIn(
            "  - F1 [P1] AGENTS.md:206 id=1 round=1 — Opening round\n", proc.stdout
        )
        self.assertIn(
            "  - F2 [P2] AGENTS.md:206 id=2 round=2 — Second round\n", proc.stdout
        )

    def test_a_review_without_inline_comments_keeps_its_place_in_the_numbering(self):
        # Ordered by review first: the opening review's body-only finding stays
        # F1 when the second review adds an inline one.
        proc = self.run_watch(
            ["7", "--timeout", "0"],
            self.pr_state(
                FIXED,
                (HEAD, FIXED),
                row(FIXED),
                reviews=(round_review(10, HEAD), round_review(20, FIXED)),
                inlines=(round_inline(5, "Inline in round two", 20, FIXED),),
            ),
        )

        self.assertIn("  - F1 [P?] - id=review-10 round=1 — ", proc.stdout)
        self.assertIn("  - F2 [P2] AGENTS.md:206 id=5 round=2 — ", proc.stdout)

    def test_a_clean_round_is_remembered_after_the_row_moves_on(self):
        # A clean review leaves no review object, only the summary row; once the
        # row is rewritten for the next review, only the memory still has it.
        first = self.run_watch(
            ["7", "--timeout", "0"],
            self.pr_state(HEAD, (HEAD,), row(HEAD, trigger="PR opened")),
        )
        second = self.run_watch(
            ["7", "--timeout", "0"], self.pr_state(FIXED, (HEAD, FIXED), row(FIXED))
        )

        self.assertEqual(field(first.stdout, "verdict"), "CLEAN", first.stdout)
        self.assertEqual(field(second.stdout, "verdict"), "CLEAN", second.stdout)
        self.assertEqual(field(second.stdout, "round"), "2")
        self.assertEqual(field(second.stdout, "rounds"), "2")
        saved = json.loads(self.memory().read_text(encoding="utf-8"))
        self.assertEqual([r["sha"] for r in saved["rounds"]], [HEAD[:7], FIXED[:7]])

    def test_the_old_opening_memory_file_is_still_read(self):
        folder = self.memory().parent
        folder.mkdir(parents=True)
        (folder / "7-opening.json").write_text(
            json.dumps(
                {
                    "kind": "Code Review",
                    "status": "Completed",
                    "sha": HEAD[:7],
                    "trigger": "PR opened",
                    "at": AT[HEAD],
                }
            ),
            encoding="utf-8",
        )

        proc = self.run_watch(
            ["7", "--timeout", "0"],
            self.pr_state(
                FIXED,
                (HEAD, FIXED),
                row(FIXED, status="🔄 **Running** since", trigger="Manual request"),
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "CLEAN", proc.stdout)
        self.assertEqual(field(proc.stdout, "trigger"), "PR opened")
        self.assertEqual(field(proc.stdout, "round"), "1")

    def test_the_fourth_review_reports_the_cap_reached(self):
        reviews = tuple(
            round_review(10 * k, sha)
            for k, sha in enumerate((HEAD, FIXED, SECOND, FOURTH), start=1)
        )
        proc = self.run_watch(
            ["7", "--timeout", "0"],
            self.pr_state(
                FOURTH,
                (HEAD, FIXED, SECOND, FOURTH),
                row(FOURTH),
                reviews=reviews,
                inlines=(
                    round_inline(
                        4, "A fourth-round finding", 40, FOURTH, priority="P1"
                    ),
                ),
            ),
        )

        self.assertEqual(field(proc.stdout, "rounds"), "4", proc.stdout)
        self.assertEqual(field(proc.stdout, "round"), "4")
        self.assertEqual(field(proc.stdout, "cap_reached"), "yes")
        self.assertIn("id=4 round=4 — A fourth-round finding", proc.stdout)


class AfterPushTest(unittest.TestCase):
    """--after-push SHA: after a fix push, wait --start-grace for a review of
    the new head to start; one that starts is waited for, and none starting
    leaves the latest settled review standing (NO_NEW_REVIEW)."""

    setUp = RoundsTest.setUp
    run_watch = RoundsTest.run_watch
    memory = RoundsTest.memory
    pr_state = RoundsTest.pr_state

    def opening_findings(self, head=FIXED, comments=None, extra=None):
        """The opening review of HEAD left one finding; the head is now `head`."""
        state = self.pr_state(
            head,
            (HEAD, FIXED, SECOND, THIRD),
            comments or row(HEAD, trigger="PR opened"),
            reviews=(round_review(10, HEAD),),
            inlines=(round_inline(1, "Opening", 10, HEAD),),
        )
        state.update(extra or {})
        return state

    def seed_wait(self, sha, *, seconds_ago, base=(HEAD[:7],), outcome=""):
        """A watch for `sha` that started `seconds_ago` (the grace runs from it)."""
        folder = self.memory().parent
        folder.mkdir(parents=True, exist_ok=True)
        rounds = [
            {"sha": s, "status": "Completed", "trigger": "PR opened", "at": AT[HEAD]}
            for s in base
        ]
        self.memory().write_text(
            json.dumps(
                {
                    "rounds": rounds,
                    "await": {
                        "sha": sha,
                        "since": time.time() - seconds_ago,
                        "base": list(base),
                        "outcome": outcome,
                    },
                }
            ),
            encoding="utf-8",
        )

    def test_no_review_starting_within_the_grace_is_no_new_review(self):
        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--start-grace", "0", "--timeout", "0"],
            self.opening_findings(),
        )

        self.assertEqual(proc.returncode, 5, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "NO_NEW_REVIEW")
        self.assertEqual(field(proc.stdout, "after_push"), FIXED)
        self.assertEqual(field(proc.stdout, "round"), "1")
        self.assertEqual(field(proc.stdout, "reviewed_sha"), HEAD[:7])
        self.assertEqual(field(proc.stdout, "cap_reached"), "no")
        self.assertIn("start grace", field(proc.stdout, "detail"))
        self.assertIn("id=1 round=1 — Opening", proc.stdout)

    def test_inside_the_grace_with_nothing_started_it_keeps_waiting(self):
        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--timeout", "0"], self.opening_findings()
        )

        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "PENDING_TIMEOUT")
        self.assertIn("start grace", field(proc.stdout, "detail"))
        saved = json.loads(self.memory().read_text(encoding="utf-8"))
        self.assertEqual(saved["await"]["sha"], FIXED)

    def test_the_default_grace_outlasts_the_slowest_observed_start(self):
        # A push-started review began 2 min 13 s after the push on PR
        # uv-template PR 184;
        # 200 s in, the default 300 s grace is still waiting for one.
        self.seed_wait(FIXED, seconds_ago=200)

        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--timeout", "0"], self.opening_findings()
        )

        self.assertEqual(field(proc.stdout, "verdict"), "PENDING_TIMEOUT", proc.stdout)
        self.assertIn("start grace", field(proc.stdout, "detail"))

    def test_the_grace_runs_from_the_first_call_for_that_push(self):
        # Slices add up without the caller counting: a watch for FIXED began
        # 1000 s ago, so this call is already past the default 300 s grace.
        self.seed_wait(FIXED, seconds_ago=1000)

        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--timeout", "0"], self.opening_findings()
        )

        self.assertEqual(field(proc.stdout, "verdict"), "NO_NEW_REVIEW", proc.stdout)
        self.assertGreaterEqual(int(field(proc.stdout, "push_age_seconds")), 1000)

    def test_a_review_that_started_is_waited_for_past_the_grace(self):
        self.seed_wait(FIXED, seconds_ago=1000)

        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--timeout", "0"],
            self.opening_findings(comments=row(FIXED, status="🔄 **Running** since")),
        )

        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "PENDING_TIMEOUT")
        self.assertIn("Running", field(proc.stdout, "detail"))
        self.assertEqual(
            field(proc.stdout, "later_review"), f"Running (New commits) for {FIXED[:7]}"
        )

    def test_the_started_review_settles_as_the_next_round(self):
        running = row(FIXED, status="🔄 **Running** since")
        responses = self.opening_findings(
            extra={
                REVIEWS("7"): lines(round_review(10, HEAD), round_review(20, FIXED)),
                INLINE("7"): lines(
                    round_inline(1, "Opening", 10, HEAD),
                    round_inline(2, "Round two", 20, FIXED, priority="P3"),
                ),
            }
        )
        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--start-grace", "0", "--timeout", "60"],
            responses,
            sequences={
                ISSUE_COMMENTS("7"): [running, row(FIXED)],
                REVIEWS("7"): [
                    lines(round_review(10, HEAD)),
                    lines(round_review(10, HEAD), round_review(20, FIXED)),
                ],
                INLINE("7"): [
                    lines(round_inline(1, "Opening", 10, HEAD)),
                    responses[INLINE("7")],
                ],
            },
        )

        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "FINDINGS")
        self.assertEqual(field(proc.stdout, "round"), "2")
        self.assertEqual(field(proc.stdout, "round_findings"), "1")
        self.assertIn(
            "  - F2 [P3] AGENTS.md:206 id=2 round=2 — Round two\n", proc.stdout
        )

    def test_a_clean_review_of_the_pushed_head_is_clean(self):
        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--timeout", "0"],
            self.opening_findings(comments=row(FIXED)),
        )

        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertEqual(field(proc.stdout, "verdict"), "CLEAN")
        self.assertEqual(field(proc.stdout, "round"), "2")
        self.assertEqual(field(proc.stdout, "round_findings"), "0")
        self.assertEqual(field(proc.stdout, "findings"), "1")

    def test_a_head_already_reviewed_is_reported_without_waiting(self):
        # The pre-merge re-run on a PR nothing was pushed to since its review:
        # no start grace to wait out, so a zero timeout still settles.
        proc = self.run_watch(
            ["7", "--after-push", HEAD, "--timeout", "0"],
            self.opening_findings(head=HEAD),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "FINDINGS", proc.stdout)

    def test_with_no_settled_review_it_waits_for_the_opening_one(self):
        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--start-grace", "0", "--timeout", "0"],
            self.pr_state(
                FIXED,
                (HEAD, FIXED),
                row(HEAD, status="🔄 **Running** since", trigger="PR opened"),
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "PENDING_TIMEOUT", proc.stdout)

    def test_with_no_trace_of_the_bot_it_is_still_no_review(self):
        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--start-grace", "0", "--timeout", "0"],
            {PR_VIEW("7"): pr_json(1000), REPO_VIEW: "o/r"},
        )

        self.assertEqual(field(proc.stdout, "verdict"), "NO_REVIEW", proc.stdout)

    def test_a_started_review_that_failed_leaves_the_last_one_standing(self):
        before = self.run_watch(
            ["7", "--after-push", FIXED, "--timeout", "0"], self.opening_findings()
        )
        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--timeout", "0"],
            self.opening_findings(comments=row(FIXED, status="❌ **Failed**")),
        )

        self.assertEqual(
            field(before.stdout, "verdict"), "PENDING_TIMEOUT", before.stdout
        )
        self.assertEqual(field(proc.stdout, "verdict"), "NO_NEW_REVIEW", proc.stdout)
        self.assertIn("Failed", field(proc.stdout, "detail"))
        self.assertEqual(field(proc.stdout, "round"), "1")

    def test_a_failed_row_already_there_before_the_push_does_not_end_the_grace(self):
        failed = row(FIXED, status="❌ **Failed**")
        first = self.run_watch(
            ["7", "--after-push", SECOND, "--timeout", "0"],
            self.opening_findings(head=SECOND, comments=failed),
        )
        second = self.run_watch(
            ["7", "--after-push", SECOND, "--timeout", "0"],
            self.opening_findings(head=SECOND, comments=failed),
        )

        for proc in (first, second):
            self.assertEqual(
                field(proc.stdout, "verdict"), "PENDING_TIMEOUT", proc.stdout
            )
            self.assertIn("start grace", field(proc.stdout, "detail"))

    def test_no_new_review_stands_when_a_late_review_starts_afterwards(self):
        self.seed_wait(FIXED, seconds_ago=1000, outcome="none")

        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--timeout", "0"],
            self.opening_findings(comments=row(FIXED, status="🔄 **Running** since")),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "NO_NEW_REVIEW", proc.stdout)
        self.assertEqual(
            field(proc.stdout, "later_review"), f"Running (New commits) for {FIXED[:7]}"
        )

    def test_a_late_review_that_completed_is_reported_as_its_round(self):
        self.seed_wait(FIXED, seconds_ago=1000, outcome="none")

        proc = self.run_watch(
            ["7", "--after-push", FIXED, "--timeout", "0"],
            self.opening_findings(comments=row(FIXED)),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "CLEAN", proc.stdout)
        self.assertEqual(field(proc.stdout, "round"), "2")

    def test_once_three_reviews_settled_it_never_waits_for_a_fourth(self):
        reviews = tuple(
            round_review(10 * k, sha)
            for k, sha in enumerate((HEAD, FIXED, SECOND), start=1)
        )
        proc = self.run_watch(
            ["7", "--after-push", THIRD, "--start-grace", "180", "--timeout", "0"],
            self.pr_state(
                THIRD,
                (HEAD, FIXED, SECOND, THIRD),
                row(SECOND),
                reviews=reviews,
                inlines=(round_inline(3, "Third", 30, SECOND),),
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "FINDINGS", proc.stdout)
        self.assertEqual(field(proc.stdout, "round"), "3")
        self.assertEqual(field(proc.stdout, "cap_reached"), "yes")
        self.assertIn("cap", field(proc.stdout, "detail"))

    def test_a_running_fourth_review_does_not_hold_the_capped_verdict(self):
        reviews = tuple(
            round_review(10 * k, sha)
            for k, sha in enumerate((HEAD, FIXED, SECOND), start=1)
        )
        proc = self.run_watch(
            ["7", "--after-push", THIRD, "--timeout", "0"],
            self.pr_state(
                THIRD,
                (HEAD, FIXED, SECOND, THIRD),
                row(THIRD, status="🔄 **Running** since"),
                reviews=reviews,
            ),
        )

        self.assertEqual(field(proc.stdout, "verdict"), "FINDINGS", proc.stdout)
        self.assertEqual(field(proc.stdout, "round"), "3")
        self.assertEqual(
            field(proc.stdout, "later_review"), f"Running (New commits) for {THIRD[:7]}"
        )

    def test_after_push_needs_a_commit_sha(self):
        proc = self.run_watch(["7", "--after-push", "main"], {})

        self.assertEqual(proc.returncode, 4)
        self.assertIn("--after-push needs a commit SHA", proc.stderr)

    def test_start_grace_needs_whole_seconds(self):
        proc = self.run_watch(["7", "--after-push", FIXED, "--start-grace", "soon"], {})

        self.assertEqual(proc.returncode, 4)
        self.assertIn("--start-grace needs a whole number", proc.stderr)


if __name__ == "__main__":
    unittest.main()
