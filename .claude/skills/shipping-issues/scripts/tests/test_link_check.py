#!/usr/bin/env python3
"""Tests for link_check.sh. Stdlib-only (unittest).

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
"""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _fakegh import FakeGh

SCRIPT = Path(__file__).resolve().parent.parent / "link_check.sh"


def run_script(args, responses, *, exits=None, stderrs=None):
    with FakeGh(responses, exits=exits, stderrs=stderrs) as fake:
        proc = subprocess.run(
            ["bash", str(SCRIPT), *args],
            env=fake.env,
            text=True,
            capture_output=True,
        )
        calls = list(fake.calls)
    return proc, calls


def run_script_with_broken_mktemp(args, responses, *, exits=None, stderrs=None):
    """Like run_script, but shadows `mktemp` on PATH with a stub that always
    fails, so the script's own `mktemp … || { …; exit 3; }` guard fires
    deterministically without touching the real filesystem's temp handling."""
    with FakeGh(responses, exits=exits, stderrs=stderrs) as fake:
        with tempfile.TemporaryDirectory() as td:
            stub_dir = Path(td)
            stub = stub_dir / "mktemp"
            stub.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
            stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
            env = dict(fake.env)
            env["PATH"] = f"{stub_dir}{os.pathsep}{env['PATH']}"
            proc = subprocess.run(
                ["bash", str(SCRIPT), *args],
                env=env,
                text=True,
                capture_output=True,
            )
        calls = list(fake.calls)
    return proc, calls


class Run:
    """What one run_resave call observed: the process, every gh argv, every
    `--body-file` edit with its exit code, every `sleep` argument, and the
    files the script left in its TMPDIR (read before that dir is removed)."""

    def __init__(self, proc, calls, *, body_edits, saved_bodies, sleeps, leftovers):
        self.proc = proc
        self.calls = calls
        self.body_edits = body_edits
        self.saved_bodies = saved_bodies
        self.sleeps = sleeps
        self.leftovers = leftovers


def run_resave(args, responses, *, sequences=None, exits=None, sleep_body=None):
    """Run the script with `sleep` stubbed on PATH — it logs its argument and
    returns at once, so a re-save's waits are counted without being waited —
    and with TMPDIR pointed at a directory the test can inspect. The fake adds
    the newline `gh -q` prints after a value, so responses are bare values and
    a saved body equal to the response proves that newline was not written back."""
    with (
        FakeGh(responses, exits=exits, sequences=sequences, jq_newline=True) as fake,
        tempfile.TemporaryDirectory() as stub_td,
        tempfile.TemporaryDirectory() as tmp_td,
    ):
        stub_dir = Path(stub_td)
        sleep_log = stub_dir / "sleeps.log"
        stub = stub_dir / "sleep"
        stub.write_text(
            sleep_body or f'#!/usr/bin/env bash\necho "$1" >> "{sleep_log}"\n',
            encoding="utf-8",
        )
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        env = dict(fake.env)
        env["PATH"] = f"{stub_dir}{os.pathsep}{env['PATH']}"
        env["TMPDIR"] = tmp_td
        env["SLEEP_LOG"] = str(sleep_log)
        proc = subprocess.run(
            ["bash", str(SCRIPT), *args],
            env=env,
            text=True,
            capture_output=True,
        )
        sleeps = (
            sleep_log.read_text(encoding="utf-8").split() if sleep_log.exists() else []
        )
        leftovers = {
            f.name: f.read_text(encoding="utf-8") for f in Path(tmp_td).iterdir()
        }
        return Run(
            proc,
            list(fake.calls),
            body_edits=fake.body_edits,
            saved_bodies=fake.saved_bodies,
            sleeps=sleeps,
            leftovers=leftovers,
        )


def base_prefix(pr):
    return ("pr", "view", pr, "--json", "baseRefName")


def closing_prefix(pr):
    return ("pr", "view", pr, "--json", "closingIssuesReferences")


class LinkCheckTest(unittest.TestCase):
    def test_missing_pr_is_usage_error(self):
        proc, calls = run_script([], {})

        self.assertEqual(proc.returncode, 3)
        self.assertIn("Usage: link_check.sh <pr-number>", proc.stderr)
        self.assertEqual(calls, [])

    def test_linked_issue_reports_base_closes_and_verdict(self):
        pr = "31"
        proc, calls = run_script(
            [pr, "--issue", "7"],
            {
                base_prefix(pr): "main\n",
                ("repo", "view", "--json", "defaultBranchRef"): "main\n",
                closing_prefix(pr): "7,8\n",
            },
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("base: main (default: main)\n", proc.stdout)
        self.assertIn("closes: 7,8\n", proc.stdout)
        self.assertIn("verdict: LINKED\n", proc.stdout)
        self.assertEqual(sum(call[:5] == list(closing_prefix(pr)) for call in calls), 1)

    def test_non_default_base_is_failure(self):
        pr = "32"
        proc, calls = run_script(
            [pr, "--issue", "7"],
            {
                base_prefix(pr): "release\n",
                ("repo", "view", "--json", "defaultBranchRef"): "main\n",
                closing_prefix(pr): "7\n",
            },
        )

        self.assertEqual(proc.returncode, 2)
        self.assertIn("base: release (default: main)\n", proc.stdout)
        self.assertIn("verdict: WRONG_BASE\n", proc.stdout)
        self.assertEqual(calls.count(["pr", "edit"]), 0)

    def test_help_flag_prints_own_usage_and_never_calls_gh(self):
        for flag in ("-h", "--help"):
            with self.subTest(flag=flag):
                proc, calls = run_script([flag], {})

                self.assertEqual(proc.returncode, 0)
                self.assertIn(
                    "link_check.sh — Verify a PR will auto-close its issue",
                    proc.stdout,
                )
                self.assertIn("Exit codes: 0 = LINKED", proc.stdout)
                self.assertEqual(calls, [])

    def test_fix_dry_run_prints_intended_append_without_mutating_pr(self):
        pr = "33"
        issue = "7"
        proc, calls = run_script(
            [pr, "--issue", issue, "--fix", "--dry-run"],
            {
                base_prefix(pr): "main\n",
                ("repo", "view", "--json", "defaultBranchRef"): "main\n",
                # closes does not yet include the target issue, so the
                # repair block's dry-run branch is what runs.
                closing_prefix(pr): "5\n",
            },
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(
            f"fix: would append 'Closes #{issue}' to PR #{pr} body (dry run — no change made)\n",
            proc.stdout,
        )
        self.assertIn("verdict: LINKED\n", proc.stdout)
        self.assertEqual([call for call in calls if call[:2] == ["pr", "edit"]], [])

    def test_fix_mktemp_failure_reports_error(self):
        pr = "34"
        issue = "7"
        proc, calls = run_script_with_broken_mktemp(
            [pr, "--issue", issue, "--fix"],
            {
                base_prefix(pr): "main\n",
                ("repo", "view", "--json", "defaultBranchRef"): "main\n",
                closing_prefix(pr): "5\n",
            },
        )

        self.assertEqual(proc.returncode, 3)
        self.assertIn("verdict: ERROR\n", proc.stdout)
        self.assertIn("detail: mktemp failed\n", proc.stdout)
        self.assertEqual([call for call in calls if call[:2] == ["pr", "edit"]], [])

    def test_fix_gh_pr_edit_failure_reports_failed_and_stays_not_linked(self):
        pr = "35"
        issue = "7"
        body = ("pr", "view", pr, "--json", "body")
        edit = ("pr", "edit", pr)
        proc, calls = run_script(
            [pr, "--issue", issue, "--fix"],
            {
                base_prefix(pr): "main\n",
                ("repo", "view", "--json", "defaultBranchRef"): "main\n",
                closing_prefix(pr): "5\n",
                body: "original body\n",
                edit: "",
            },
            exits={edit: 1},
        )

        self.assertEqual(proc.returncode, 1)
        self.assertIn("fix: FAILED (could not edit PR body)\n", proc.stdout)
        self.assertIn("verdict: NOT_LINKED\n", proc.stdout)
        self.assertTrue(any(call[:2] == ["pr", "edit"] for call in calls))


BODY_WITH_KEYWORD = (
    "## Summary\n\nCloses #7\n\nA long body.\n\n## Test Plan\n\n- ran it\n"
)


# Bodies whose only closing keyword for #7 is one GitHub does not link: hidden
# in an HTML comment or code, or naming another repository than acme/widgets.
UNLINKED_KEYWORD_BODIES = (
    "## Summary\n\n<!-- Closes #7 -->\n",
    "<!--\nFixes #7\n-->\nBody.\n",
    "Run `closes #7` later.\n",
    "```\nCloses #7\n```\n",
    "~~~md\nResolves #7\n~~~\n",
    "Closes other/repo#7\n",
    "Fixes https://github.com/other/repo/issues/7\n",
)


def resave_responses(pr, body, base="main"):
    return {
        base_prefix(pr): base,
        ("repo", "view", "--json", "defaultBranchRef"): "main",
        ("pr", "view", pr, "--json", "body"): body,
        ("repo", "view", "--json", "nameWithOwner"): "acme/widgets",
    }


class ResaveTest(unittest.TestCase):
    """--fix when GitHub has not linked the issue: append only a missing
    keyword, re-save a body that already has one, and never lose the body."""

    def assert_body_intact(self, run, original):
        # Every body the PR held is the original or the minimal one, it ends
        # as the original, and no body ever carries the keyword twice.
        self.assertEqual(run.saved_bodies[-1], original)
        for body in run.saved_bodies:
            self.assertIn(body, (original, "Closes #7\n"))
            self.assertEqual(body.count("Closes #7"), 1)

    def test_keyword_present_resaves_until_linked_without_appending(self):
        pr = "40"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            # initial read, after re-save 1, after re-save 2 (the last allowed)
            sequences={closing_prefix(pr): ["", "", "7"]},
        )

        self.assertEqual(run.proc.returncode, 0, run.proc.stdout + run.proc.stderr)
        self.assertNotIn("appended", run.proc.stdout)
        self.assertIn("fix: re-save 1/2: not linked yet\n", run.proc.stdout)
        self.assertIn("fix: re-save 2/2: linked\n", run.proc.stdout)
        self.assertIn("verdict: LINKED\n", run.proc.stdout)
        original = BODY_WITH_KEYWORD
        self.assertEqual(
            run.saved_bodies, ["Closes #7\n", original, "Closes #7\n", original]
        )
        self.assert_body_intact(run, original)
        self.assertEqual(run.leftovers, {})

    def test_keyword_present_but_never_linked_reports_keyword_present(self):
        pr = "41"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            sequences={closing_prefix(pr): [""]},
        )

        self.assertEqual(run.proc.returncode, 1)
        self.assertIn("fix: re-save 2/2: not linked yet\n", run.proc.stdout)
        self.assertIn("verdict: NOT_LINKED\n", run.proc.stdout)
        self.assertIn(
            "detail: the PR body has a closing keyword for #7, but GitHub has not "
            "linked it after 2 re-save(s) of the body\n",
            run.proc.stdout,
        )
        self.assertNotIn("no Closes/Fixes/Resolves keyword", run.proc.stdout)
        # Bounded: two minimal saves and two restores, two short waits each.
        self.assertEqual(len(run.body_edits), 4)
        self.assert_body_intact(run, BODY_WITH_KEYWORD)
        self.assertEqual(len(run.sleeps), 4)
        self.assertTrue(all(0 < int(s) <= 5 for s in run.sleeps), run.sleeps)
        self.assertEqual(run.leftovers, {})

    def test_keyword_absent_appends_once_and_does_not_resave_once_linked(self):
        pr = "42"
        body = "## Summary\n\nSee #7 for context.\n"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, body),
            sequences={closing_prefix(pr): ["", "7"]},
        )

        self.assertEqual(run.proc.returncode, 0, run.proc.stdout)
        self.assertIn("fix: appended 'Closes #7' to the PR body\n", run.proc.stdout)
        self.assertNotIn("re-save", run.proc.stdout)
        self.assertEqual(run.saved_bodies, [body + "\n\nCloses #7\n"])
        self.assertEqual(run.sleeps, ["3"])

    def test_keyword_absent_append_not_linked_resaves_the_appended_body(self):
        pr = "43"
        body = "## Summary\n\nNo keyword here.\n"
        appended = body + "\n\nCloses #7\n"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, body),
            # GitHub holds the appended body once the append has saved.
            sequences={
                closing_prefix(pr): [""],
                ("pr", "view", pr, "--json", "body"): [body, appended],
            },
        )

        self.assertEqual(run.proc.returncode, 1)
        self.assertEqual(run.saved_bodies[0], appended)
        self.assert_body_intact(run, appended)
        self.assertEqual(len(run.body_edits), 1 + 4)
        self.assertIn(
            "detail: the PR body has a closing keyword for #7, but GitHub has not linked it",
            run.proc.stdout,
        )

    def test_a_body_edited_during_fix_is_never_overwritten(self):
        pr = "47"
        edited = "## Summary\n\nCloses #7\n\nRewritten by a human meanwhile.\n"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            sequences={
                closing_prefix(pr): [""],
                ("pr", "view", pr, "--json", "body"): [BODY_WITH_KEYWORD, edited],
            },
        )

        self.assertEqual(run.proc.returncode, 1)
        self.assertIn("re-save stopped, nothing restored over it", run.proc.stdout)
        self.assertEqual(run.body_edits, [])
        self.assertIn(
            "detail: the PR body has a closing keyword for #7, but GitHub has not "
            "linked it (re-save stopped: the body changed while --fix ran)\n",
            run.proc.stdout,
        )
        self.assertEqual(run.leftovers, {})

    def test_a_body_edited_between_re_saves_stops_the_next_one(self):
        pr = "48"
        edited = "Closes #7\n\nEdited between the two re-saves.\n"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            sequences={
                closing_prefix(pr): [""],
                ("pr", "view", pr, "--json", "body"): [
                    BODY_WITH_KEYWORD,
                    BODY_WITH_KEYWORD,
                    edited,
                ],
            },
        )

        self.assertEqual(run.proc.returncode, 1)
        self.assertIn("fix: re-save 1/2: not linked yet\n", run.proc.stdout)
        self.assertNotIn("re-save 2/2", run.proc.stdout)
        # One minimal save and its restore, then nothing over the newer body.
        self.assertEqual(run.saved_bodies, ["Closes #7\n", BODY_WITH_KEYWORD])

    def test_the_snapshot_file_is_named_before_any_re_save(self):
        pr = "49"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            sequences={closing_prefix(pr): ["", "7"]},
        )

        out = run.proc.stdout
        self.assertIn("fix: full body snapshot: ", out)
        self.assertIn(f"(restore with: gh pr edit {pr} --body-file ", out)
        self.assertLess(out.index("full body snapshot"), out.index("re-save 1/2"))

    def test_no_keyword_and_edit_fails_reports_no_keyword(self):
        pr = "44"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, "no keyword\n"),
            sequences={closing_prefix(pr): [""], ("pr", "edit", pr): [("", 1)]},
        )

        self.assertEqual(run.proc.returncode, 1)
        self.assertIn("fix: FAILED (could not edit PR body)\n", run.proc.stdout)
        self.assertIn(
            "detail: the PR body has no Closes/Fixes/Resolves keyword\n",
            run.proc.stdout,
        )
        self.assertEqual(run.saved_bodies, [])

    def test_without_fix_detail_distinguishes_keyword_present_from_absent(self):
        pr = "45"
        cases = {
            BODY_WITH_KEYWORD: "detail: the PR body has a closing keyword for #7, but GitHub has "
            "not linked it (--fix re-saves the body)\n",
            "Fixes: #7\n": "detail: the PR body has a closing keyword for #7, but GitHub has "
            "not linked it (--fix re-saves the body)\n",
            "resolved #7.\n": "detail: the PR body has a closing keyword for #7, but GitHub has "
            "not linked it (--fix re-saves the body)\n",
            "Closes acme/widgets#7\n": "detail: the PR body has a closing keyword for #7, but GitHub has "
            "not linked it (--fix re-saves the body)\n",
            "Fixes https://github.com/acme/widgets/issues/7\n": "detail: the PR body has a closing keyword for #7, but GitHub has "
            "not linked it (--fix re-saves the body)\n",
            "Closes #70 and see #7\n": "detail: the PR body has no Closes/Fixes/Resolves keyword\n",
            "Closes #7x\n": "detail: the PR body has no Closes/Fixes/Resolves keyword\n",
            "Closes acme/widgets#70\n": "detail: the PR body has no Closes/Fixes/Resolves keyword\n",
            "Fixes https://github.com/acme/widgets/issues/7x\n": "detail: the PR body has no Closes/Fixes/Resolves keyword\n",
            "Fixes https://github.com/acme/widgets/pull/7\n": "detail: the PR body has no Closes/Fixes/Resolves keyword\n",
            "prefixes #7\n": "detail: the PR body has no Closes/Fixes/Resolves keyword\n",
            "Closes ACME/Widgets#7\n": "detail: the PR body has a closing keyword for #7, but GitHub has "
            "not linked it (--fix re-saves the body)\n",
            **dict.fromkeys(
                UNLINKED_KEYWORD_BODIES,
                "detail: the PR body has no Closes/Fixes/Resolves keyword\n",
            ),
        }
        for body, detail in cases.items():
            with self.subTest(body=body):
                run = run_resave(
                    [pr, "--issue", "7"],
                    resave_responses(pr, body),
                    sequences={closing_prefix(pr): [""]},
                )

                self.assertEqual(run.proc.returncode, 1)
                self.assertIn(detail, run.proc.stdout)
                self.assertEqual(run.body_edits, [])

    def test_keyword_github_does_not_link_gets_a_real_one_appended(self):
        pr = "46"
        for body in UNLINKED_KEYWORD_BODIES:
            with self.subTest(body=body):
                run = run_resave(
                    [pr, "--issue", "7", "--fix"],
                    resave_responses(pr, body),
                    sequences={closing_prefix(pr): ["", "7"]},
                )

                self.assertEqual(run.proc.returncode, 0, run.proc.stdout)
                self.assertIn(
                    "fix: appended 'Closes #7' to the PR body\n", run.proc.stdout
                )
                self.assertNotIn("re-save", run.proc.stdout)
                self.assertEqual(run.saved_bodies, [body + "\n\nCloses #7\n"])
                self.assertIn("verdict: LINKED\n", run.proc.stdout)

    def test_without_issue_detail_reports_unlinked_keyword(self):
        pr = "46"
        run = run_resave(
            [pr],
            resave_responses(pr, "Closes #12\n"),
            sequences={closing_prefix(pr): [""]},
        )

        self.assertEqual(run.proc.returncode, 1)
        self.assertIn(
            "detail: the PR body has a closing keyword for an issue, but GitHub has "
            "not linked it\n",
            run.proc.stdout,
        )

    def test_other_issue_linked_and_keyword_present_says_not_linked_yet(self):
        pr = "47"
        run = run_resave(
            [pr, "--issue", "7"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            sequences={closing_prefix(pr): ["5"]},
        )

        self.assertEqual(run.proc.returncode, 1)
        self.assertIn(
            "detail: the PR body has a closing keyword for #7", run.proc.stdout
        )

    def test_unreadable_body_without_fix_says_so(self):
        pr = "48"
        responses = resave_responses(pr, "")
        run = run_resave(
            [pr, "--issue", "7"],
            responses,
            sequences={closing_prefix(pr): [""]},
            exits={("pr", "view", pr, "--json", "body"): 1},
        )

        self.assertEqual(run.proc.returncode, 1)
        self.assertIn(
            "detail: GitHub has not linked #7, and the PR body could not be read to say why\n",
            run.proc.stdout,
        )

    def test_unreadable_body_with_fix_refuses_to_rewrite(self):
        pr = "49"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, ""),
            sequences={closing_prefix(pr): [""]},
            exits={("pr", "view", pr, "--json", "body"): 1},
        )

        self.assertEqual(run.proc.returncode, 3)
        self.assertIn("verdict: ERROR\n", run.proc.stdout)
        self.assertIn("refusing to rewrite it", run.proc.stdout)
        self.assertEqual([c for c in run.calls if c[:2] == ["pr", "edit"]], [])
        self.assertEqual(run.leftovers, {})

    def test_dry_run_with_keyword_present_previews_resave_without_editing(self):
        pr = "50"
        run = run_resave(
            [pr, "--issue", "7", "--fix", "--dry-run"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            sequences={closing_prefix(pr): [""]},
        )

        self.assertEqual(run.proc.returncode, 0)
        self.assertIn(
            "fix: would re-save PR #50 body, which already has a closing keyword for #7, "
            "up to 2 times (dry run — no change made)\n",
            run.proc.stdout,
        )
        self.assertEqual([c for c in run.calls if c[:2] == ["pr", "edit"]], [])
        self.assertEqual(run.sleeps, [])
        self.assertEqual(run.leftovers, {})

    def test_dry_run_on_wrong_base_previews_no_resave(self):
        pr = "51"
        run = run_resave(
            [pr, "--issue", "7", "--fix", "--dry-run"],
            resave_responses(pr, BODY_WITH_KEYWORD, base="release"),
            sequences={closing_prefix(pr): [""]},
        )

        self.assertEqual(run.proc.returncode, 2)
        self.assertIn("fix: would not re-save PR #51 body", run.proc.stdout)
        self.assertEqual([c for c in run.calls if c[:2] == ["pr", "edit"]], [])

    def test_wrong_base_skips_the_resave(self):
        pr = "52"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, BODY_WITH_KEYWORD, base="release"),
            sequences={closing_prefix(pr): [""]},
        )

        self.assertEqual(run.proc.returncode, 2)
        self.assertIn("fix: re-save skipped — the base is not main\n", run.proc.stdout)
        self.assertIn("verdict: WRONG_BASE\n", run.proc.stdout)
        self.assertEqual(run.body_edits, [])

    def test_minimal_save_failure_still_restores_and_stops(self):
        pr = "53"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            sequences={
                closing_prefix(pr): [""],
                ("pr", "edit", pr): [("", 1), ("", 0)],
            },
        )

        self.assertEqual(run.proc.returncode, 1)
        self.assertIn("fix: FAILED (could not edit PR body)\n", run.proc.stdout)
        self.assertIn("(re-saving the body failed)\n", run.proc.stdout)
        self.assertEqual(run.saved_bodies, [BODY_WITH_KEYWORD])
        self.assertEqual(len(run.body_edits), 2)

    def test_restore_failure_is_error_and_keeps_the_full_body_on_disk(self):
        pr = "54"
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            sequences={
                closing_prefix(pr): [""],
                ("pr", "edit", pr): [("", 0), ("", 1)],
            },
        )

        self.assertEqual(run.proc.returncode, 3)
        self.assertIn("verdict: ERROR\n", run.proc.stdout)
        self.assertIn("could not restore PR #54 body", run.proc.stdout)
        # One minimal save, then every restore try failed.
        self.assertEqual(len(run.body_edits), 1 + 3)
        kept = [name for name in run.leftovers if name.startswith("link_check_body.")]
        self.assertEqual(len(kept), 1, run.leftovers)
        self.assertIn(kept[0], run.proc.stdout)
        self.assertEqual(run.leftovers[kept[0]], BODY_WITH_KEYWORD)

    def test_interrupt_while_the_body_is_minimal_restores_it(self):
        pr = "55"
        # The first wait is the one right after the minimal save: the stub
        # sends the script a TERM there, as a timeout or Ctrl-C would.
        sleep_body = (
            "#!/usr/bin/env bash\n"
            'echo "$1" >> "$SLEEP_LOG"\n'
            'if [[ $(wc -l < "$SLEEP_LOG") -eq 1 ]]; then kill -TERM "$PPID"; fi\n'
        )
        run = run_resave(
            [pr, "--issue", "7", "--fix"],
            resave_responses(pr, BODY_WITH_KEYWORD),
            sequences={closing_prefix(pr): [""]},
            sleep_body=sleep_body,
        )

        self.assertEqual(run.proc.returncode, 3, run.proc.stdout)
        self.assertIn(
            "fix: interrupted during a re-save — restoring the full body\n",
            run.proc.stdout,
        )
        self.assertEqual(run.saved_bodies, ["Closes #7\n", BODY_WITH_KEYWORD])
        self.assertEqual(run.leftovers, {})

    def test_non_numeric_issue_is_usage_error(self):
        proc, calls = run_script(["60", "--issue", "7.*"], {})

        self.assertEqual(proc.returncode, 3)
        self.assertIn("--issue needs an issue number", proc.stderr)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
