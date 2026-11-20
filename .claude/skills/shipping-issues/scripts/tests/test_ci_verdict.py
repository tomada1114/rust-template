#!/usr/bin/env python3
"""Tests for ci_verdict.py. Stdlib-only (unittest).

Run from the repository root:
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
        -s .claude/skills/shipping-issues/scripts/tests \
        -t .claude/skills/shipping-issues/scripts/tests -p 'test_*.py'
"""
from __future__ import annotations

import io
import json
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _fakegh import FakeGh  # noqa: E402
import ci_verdict  # noqa: E402

SCRIPT = Path(__file__).resolve().parent.parent / "ci_verdict.py"
HEAD = "a" * 40
NEXT = "b" * 40
PULL = ("api", "repos/{owner}/{repo}/pulls/7")


def checks_key(sha: str = HEAD) -> tuple[str, ...]:
    return ("api", f"repos/{{owner}}/{{repo}}/commits/{sha}/check-runs?per_page=100")


def status_key(sha: str = HEAD) -> tuple[str, ...]:
    return ("api", f"repos/{{owner}}/{{repo}}/commits/{sha}/status")


def head(sha: str = HEAD) -> str:
    return json.dumps({"sha": sha}) + "\n"


def runs(*items: tuple[str, str | None, str]) -> str:
    """Check runs as (status, conclusion, name), one JSON object per line, as `--jq` prints."""
    return "".join(
        json.dumps({"status": status, "conclusion": conclusion, "name": name}) + "\n"
        for status, conclusion, name in items
    )


def combined(state: str = "pending", total: int = 0) -> str:
    return json.dumps({"state": state, "total_count": total}) + "\n"


class Watch(unittest.TestCase):
    """Each test runs the script in-process against a fake `gh`, never sleeping."""

    def watch(self, argv, responses=None, **fake_options):
        table = {PULL: head(), status_key(): combined()}
        table.update(responses or {})
        self.slept: list[float] = []
        out, err = io.StringIO(), io.StringIO()
        with FakeGh(table, **fake_options) as fake:
            with patch.dict("os.environ", fake.env, clear=False), \
                    patch.object(ci_verdict.time, "sleep", self.slept.append), \
                    redirect_stdout(out), redirect_stderr(err):
                code = ci_verdict.cli(argv)
            self.calls = fake.calls
        return code, out.getvalue().splitlines(), err.getvalue().splitlines()

    def cli_with_sleep(self, argv, responses, **fake_options):
        """As `watch`, with `main`'s own sleep and clock replaced: one second per sleep."""
        table = {PULL: head(), status_key(): combined()}
        table.update(responses)
        self.slept = []
        now = [0.0]

        def sleep(seconds: float) -> None:
            self.slept.append(seconds)
            now[0] += seconds

        out = io.StringIO()
        with FakeGh(table, **fake_options) as fake:
            with patch.dict("os.environ", fake.env, clear=False), redirect_stdout(out):
                code = ci_verdict.main(argv, sleep=sleep, clock=lambda: now[0])
            self.calls = fake.calls
        return code, out.getvalue().splitlines()


class Verdicts(Watch):
    def test_pass_names_the_head_commit_it_verified(self):
        code, out, err = self.watch(["7"], {
            checks_key(): runs(("completed", "success", "Rust Core"),
                               ("completed", "success", "macOS")),
        })
        self.assertEqual(code, 0)
        self.assertEqual(out, ["verdict: PASS", f"head_sha: {HEAD}",
                               "checks: 2 check runs, 0 statuses"])
        self.assertEqual(err, [])
        self.assertEqual(self.slept, [])

    def test_green_completions_other_than_success_still_pass(self):
        code, out, _ = self.watch(["7"], {
            checks_key(): runs(("completed", "neutral", "a"), ("completed", "skipped", "b"),
                               ("completed", "success", "c")),
        })
        self.assertEqual((code, out[0]), (0, "verdict: PASS"))

    def test_successful_commit_status_passes_without_a_check_run(self):
        code, out, _ = self.watch(["7"], {checks_key(): "", status_key(): combined("success", 1)})
        self.assertEqual((code, out[0]), (0, "verdict: PASS"))
        self.assertEqual(out[2], "checks: 0 check runs, 1 statuses")

    def test_failed_check_reports_its_name_and_conclusion(self):
        code, out, _ = self.watch(["7"], {
            checks_key(): runs(("completed", "success", "Rust Core"),
                               ("completed", "failure", "macOS")),
        })
        self.assertEqual(code, 2)
        self.assertEqual(out[0], "verdict: FAIL")
        self.assertIn("failed_check: macOS (failure)", out)
        self.assertNotIn("failed_check: Rust Core (success)", out)

    def test_a_failure_beside_a_pending_check_is_a_fail(self):
        code, out, _ = self.watch(["7", "--timeout", "3600"], {
            checks_key(): runs(("in_progress", None, "Rust Core"),
                               ("completed", "timed_out", "macOS")),
        })
        self.assertEqual((code, out[0]), (2, "verdict: FAIL"))
        self.assertEqual(self.slept, [])

    def test_every_other_conclusion_fails_rather_than_waits(self):
        for conclusion in ("cancelled", "action_required", "startup_failure", "stale",
                           "one_added_later", None):
            with self.subTest(conclusion=conclusion):
                code, out, _ = self.watch(["7"], {
                    checks_key(): runs(("completed", conclusion, "job")),
                })
                self.assertEqual((code, out[0]), (2, "verdict: FAIL"))

    def test_failing_commit_status_fails_without_a_check_run(self):
        code, out, _ = self.watch(["7"], {checks_key(): "", status_key(): combined("failure", 2)})
        self.assertEqual((code, out[0]), (2, "verdict: FAIL"))
        self.assertIn("failed_status: the combined commit status is failure", out)

    def test_no_checks_at_all_is_empty_never_a_pass(self):
        code, out, _ = self.watch(["7", "--timeout", "0"], {checks_key(): ""})
        self.assertEqual(code, 4)
        self.assertEqual(out, ["verdict: EMPTY", f"head_sha: {HEAD}",
                               "checks: 0 check runs, 0 statuses"])

    def test_a_watch_that_ends_with_a_check_pending_is_never_a_pass(self):
        code, out, _ = self.watch(["7", "--timeout", "0"], {
            checks_key(): runs(("completed", "success", "Rust Core"), ("queued", None, "macOS")),
        })
        self.assertEqual((code, out[0]), (3, "verdict: PENDING"))

    def test_a_pending_commit_status_also_holds_the_verdict(self):
        code, out, _ = self.watch(["7", "--timeout", "0"], {
            checks_key(): runs(("completed", "success", "Rust Core")),
            status_key(): combined("pending", 1),
        })
        self.assertEqual((code, out[0]), (3, "verdict: PENDING"))


class Waiting(Watch):
    def test_waits_through_empty_and_pending_to_the_pass(self):
        code, out = self.cli_with_sleep(["7", "--timeout", "600", "--interval", "30"], {}, sequences={
            checks_key(): ["", runs(("in_progress", None, "Rust Core")),
                           runs(("completed", "success", "Rust Core"))],
        })
        self.assertEqual((code, out[0]), (0, "verdict: PASS"))
        self.assertEqual(self.slept, [30, 30])

    def test_stops_at_the_timeout_with_the_last_verdict(self):
        code, out = self.cli_with_sleep(["7", "--timeout", "100", "--interval", "30"], {
            checks_key(): runs(("queued", None, "Rust Core")),
        })
        self.assertEqual((code, out[0]), (3, "verdict: PENDING"))
        # Reads at 0, 30, 60, and 90 s; a fifth would start past the timeout.
        self.assertEqual(self.slept, [30, 30, 30])

    def test_a_head_that_moves_during_the_watch_is_never_a_pass(self):
        code, out = self.cli_with_sleep(["7", "--timeout", "600"], {
            checks_key(): runs(("queued", None, "Rust Core")),
            checks_key(NEXT): runs(("completed", "success", "Rust Core")),
            status_key(NEXT): combined(),
        }, sequences={PULL: [head(), head(NEXT)]})
        self.assertEqual(code, 5)
        self.assertEqual(out, ["verdict: MOVED", f"head_sha: {NEXT}", f"watched_sha: {HEAD}"])

    def test_a_head_other_than_the_pinned_sha_is_moved_before_any_check_is_read(self):
        code, out, _ = self.watch(["7", "--sha", NEXT], {
            checks_key(): runs(("completed", "success", "Rust Core")),
        })
        self.assertEqual((code, out[0]), (5, "verdict: MOVED"))
        self.assertEqual(len(self.calls), 1)

    def test_the_pinned_sha_passes_when_it_is_still_the_head(self):
        code, out, _ = self.watch(["7", "--sha", HEAD], {
            checks_key(): runs(("completed", "success", "Rust Core")),
        })
        self.assertEqual((code, out[0]), (0, "verdict: PASS"))


class Errors(Watch):
    def assert_error(self, result, code_name):
        code, out, err = result
        self.assertEqual(code, 1)
        self.assertEqual(out, ["verdict: ERROR"])
        self.assertTrue(err[0].startswith(code_name + ": "), err)
        self.assertEqual([line.split(":")[0] for line in err[1:]], ["Expected", "Actual", "Next"])
        return err

    def test_error_when_the_pr_cannot_be_read(self):
        err = self.assert_error(
            self.watch(["7"], exits={PULL: 1}, stderrs={PULL: "gh: Not Found (HTTP 404)\nmore\n"}),
            "ERR_CI_GH")
        self.assertEqual(err[2], "Actual: gh: Not Found (HTTP 404)")

    def test_error_when_the_check_runs_cannot_be_read(self):
        key = checks_key()
        err = self.assert_error(
            self.watch(["7"], {key: ""}, exits={key: 1},
                       stderrs={key: "gh: Resource not accessible (HTTP 403)\n"}),
            "ERR_CI_GH")
        self.assertIn("HTTP 403", err[2])

    def test_error_when_the_combined_status_cannot_be_read(self):
        key = status_key()
        self.assert_error(
            self.watch(["7"], {checks_key(): runs(("completed", "success", "a")), key: ""},
                       exits={key: 1}),
            "ERR_CI_GH")

    def test_a_reply_that_is_not_the_json_asked_for_is_an_error_not_a_verdict(self):
        self.assert_error(self.watch(["7"], {PULL: "<html>rate limited</html>"}), "ERR_CI_GH")
        self.assert_error(self.watch(["7"], {PULL: json.dumps({"sha": None})}), "ERR_CI_GH")
        self.assert_error(
            self.watch(["7"], {checks_key(): "", status_key(): json.dumps({"state": "success"})}),
            "ERR_CI_GH")

    def test_error_when_gh_is_not_installed(self):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict("os.environ", {"PATH": ""}, clear=False), \
                redirect_stdout(out), redirect_stderr(err):
            code = ci_verdict.cli(["7"])
        self.assertEqual((code, out.getvalue()), (1, "verdict: ERROR\n"))
        self.assertTrue(err.getvalue().startswith("ERR_CI_GH: "), err.getvalue())

    def test_usage_errors_never_call_gh(self):
        for argv in ([], ["--timeout", "60"], ["7", "8"], ["seven"], ["7", "--timeout"],
                     ["7", "--timeout", "soon"], ["7", "--sha", "abc123"], ["7", "--log"]):
            with self.subTest(argv=argv):
                self.assert_error(self.watch(argv), "ERR_CI_USAGE")
                self.assertEqual(self.calls, [])

    def test_an_unexpected_exception_still_reports_a_named_code(self):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(ci_verdict, "parse_args", side_effect=RuntimeError("boom")), \
                redirect_stdout(out), redirect_stderr(err):
            code = ci_verdict.cli(["7"])
        self.assertEqual(code, 1)
        self.assertTrue(err.getvalue().startswith("ERR_INTERNAL_UNEXPECTED: boom"))


class Calls(Watch):
    def test_reads_only_rest_paths_by_head_sha(self):
        self.watch(["7"], {checks_key(): runs(("completed", "success", "a"))})
        self.assertEqual([call[:2] for call in self.calls],
                         [list(PULL), list(checks_key()), list(status_key())])
        self.assertIn("--paginate", self.calls[1])
        self.assertTrue(all("--jq" in call for call in self.calls))

    def test_runs_as_a_command_with_the_verdicts_exit_code(self):
        table = {PULL: head(), status_key(): combined(),
                 checks_key(): runs(("completed", "failure", "macOS"))}
        with FakeGh(table) as fake:
            done = subprocess.run([sys.executable, str(SCRIPT), "7"], env=fake.env,
                                  capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 2)
        self.assertTrue(done.stdout.startswith("verdict: FAIL\n"), done.stdout)


if __name__ == "__main__":
    unittest.main()
