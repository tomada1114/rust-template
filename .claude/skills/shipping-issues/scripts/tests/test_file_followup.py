#!/usr/bin/env python3
"""Tests for file_followup.py. Stdlib-only (unittest).

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
"""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _fakegh import FakeGh, label_writes  # noqa: E402
import file_followup as ff  # noqa: E402
import issue_digest as idg  # noqa: E402


class ResolveTierLabelTest(unittest.TestCase):
    def test_prefers_canonical_when_present(self):
        label = ff.resolve_tier_label("P2", ["priority: P2", "bug"])
        self.assertEqual(label, "priority: P2")

    def test_reuses_repo_alias_instead_of_the_canonical_name(self):
        # A repo that already spells the tier as "p2" must not also gain a
        # parallel "priority: P2" -- that would split its own backlog in two.
        label = ff.resolve_tier_label("P2", ["p2", "bug"])
        self.assertEqual(label, "p2")

    def test_shortest_alias_wins_when_repo_carries_several(self):
        label = ff.resolve_tier_label("P2", ["p2", "priority: medium"])
        self.assertEqual(label, "p2")

    def test_missing_tier_label_resolves_to_none_and_creates_nothing(self):
        with patch("file_followup.gh") as mock_gh:
            label = ff.resolve_tier_label("P1", ["bug"])
        self.assertIsNone(label)
        mock_gh.assert_not_called()


class MainEndToEndTest(unittest.TestCase):
    """Runs main() in-process against a fake `gh` on PATH, so coverage sees
    file_followup.py's own code (the `gh repo view` resolution call bypasses
    the gh() wrapper and is patched in the same way, via PATH)."""

    def _run(self, args, responses, exits=None, stderrs=None):
        with FakeGh(responses, exits=exits, stderrs=stderrs) as fake:
            out, err = io.StringIO(), io.StringIO()
            with patch.dict("os.environ", fake.env, clear=False), \
                    patch.object(sys, "argv", ["file_followup.py", *args]), \
                    redirect_stdout(out), redirect_stderr(err):
                try:
                    rc = ff.main()
                except SystemExit as exc:
                    rc = exc.code
            return rc, out.getvalue(), err.getvalue(), fake

    def _run_capturing_calls(self, args, responses):
        """Like _run, but reads fake.calls (and the filed body) while the
        FakeGh block is still open -- see the analogous note in
        test_apply_priority_labels.py's test_set_design_via_main_never_calls_the_digest."""
        filed = {}
        real_gh = ff.gh

        def capture(gh_args, check=True):
            if gh_args[:2] == ["issue", "create"]:
                path = gh_args[gh_args.index("--body-file") + 1]
                filed["body"] = Path(path).read_text(encoding="utf-8")
            return real_gh(gh_args, check=check)

        with FakeGh(responses) as fake, patch("file_followup.gh", side_effect=capture):
            out, err = io.StringIO(), io.StringIO()
            with patch.dict("os.environ", fake.env, clear=False), \
                    patch.object(sys, "argv", ["file_followup.py", *args]), \
                    redirect_stdout(out), redirect_stderr(err):
                try:
                    rc = ff.main()
                except SystemExit as exc:
                    rc = exc.code
            calls = fake.calls
        return rc, out.getvalue(), err.getvalue(), calls, filed.get("body")

    def test_files_issue_with_resolved_tier_and_type_label(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("Observed defect at foo.py:12.")
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--label", "Bug", "--repo", "acme/widgets", "--json"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P2"},
                                                    {"name": "bug"}]),
                    ("issue", "create"): "https://github.com/acme/widgets/issues/99\n",
                },
            )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["url"], "https://github.com/acme/widgets/issues/99")
        self.assertEqual(payload["labels"], ["priority: P2", "bug"])

    def test_unknown_type_label_fails_and_files_nothing(self):
        # A typo'd type label used to be skipped silently, filing an issue with
        # no type at all.
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("Observed defect at foo.py:12.")
            rc, out, err, calls, filed = self._run_capturing_calls(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--label", "bgu", "--repo", "acme/widgets"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P2"},
                                                    {"name": "bug"}]),
                    ("issue", "create"): "https://github.com/acme/widgets/issues/99\n",
                },
            )
        self.assertEqual(rc, ff.MISSING_LABEL_EXIT, err)
        self.assertIn("bgu", err)
        self.assertIn("just labels", err)
        self.assertIsNone(filed)
        self.assertFalse(any(c[:2] == ["issue", "create"] for c in calls))
        self.assertEqual(label_writes(calls), [])

    def test_missing_tier_label_is_reported_never_created(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("x")
            rc, out, err, calls, filed = self._run_capturing_calls(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--repo", "acme/widgets"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "bug"}]),
                },
            )
        self.assertEqual(rc, ff.MISSING_LABEL_EXIT, err)
        self.assertIn("priority: P2", err)
        self.assertIn("just labels", err)
        self.assertFalse(any(c[:2] == ["issue", "create"] for c in calls))
        self.assertEqual(label_writes(calls), [])

    def test_blocked_by_writes_depends_on_lines_and_the_dependency_label(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("Observed defect at foo.py:12.")
            rc, out, err, calls, filed = self._run_capturing_calls(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--label", "bug", "--blocked-by", "12,#13", "--blocks", "98",
                 "--repo", "acme/widgets"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps(
                        [{"name": n} for n in ("priority: P2", "bug",
                                               "blocked: dependency")]),
                    ("issue", "create"): "https://github.com/acme/widgets/issues/99\n",
                },
            )
        self.assertEqual(rc, 0, err)
        self.assertIn("## Dependencies\n\nDepends on #12\nDepends on #13\nBlocks #98",
                      filed)
        creates = [c for c in calls if c[:2] == ["issue", "create"]]
        self.assertEqual(len(creates), 1)
        applied = [creates[0][i + 1] for i, a in enumerate(creates[0]) if a == "--label"]
        self.assertEqual(applied, ["priority: P2", "blocked: dependency", "bug"])
        # The ship contract carries the same edges for the next run's planner.
        self.assertEqual(idg.parse_ship_contract(filed)["depends_on"], [12, 13])

    def test_blocked_by_without_a_dependency_label_fails(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("x")
            rc, out, err, calls, filed = self._run_capturing_calls(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--blocked-by", "12", "--repo", "acme/widgets"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P2"}]),
                },
            )
        self.assertEqual(rc, ff.MISSING_LABEL_EXIT, err)
        self.assertIn("blocked: dependency", err)
        self.assertIsNone(filed)

    def test_no_blocked_by_writes_no_dependencies_section(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("x")
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--repo", "acme/widgets", "--dry-run", "--json"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P2"}]),
                },
            )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["dependencies"], "")
        self.assertEqual(payload["labels"], ["priority: P2"])

    def test_missing_tier_is_a_usage_error(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("x")
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(body), "--repo", "acme/widgets"],
                {("repo", "view"): "acme/widgets\n"},
            )
        self.assertNotEqual(rc, 0)
        self.assertIn("--tier", err)

    def test_no_write_access_exits_2(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("x")
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--repo", "acme/widgets"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P2"}]),
                    ("issue", "create"): "",
                },
                exits={("issue", "create"): 1},
                stderrs={("issue", "create"): "HTTP 403: Resource not accessible"},
            )
        self.assertEqual(rc, 2, err)

    def test_empty_body_file_exits_3(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("   \n")
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--repo", "acme/widgets"],
                {("repo", "view"): "acme/widgets\n"},
            )
        self.assertEqual(rc, 3, err)

    def test_missing_body_file_exits_3(self):
        with tempfile.TemporaryDirectory() as td:
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(Path(td) / "missing.txt"),
                 "--tier", "P2", "--repo", "acme/widgets"],
                {("repo", "view"): "acme/widgets\n"},
            )
        self.assertEqual(rc, 3, err)

    def test_found_while_appends_provenance_line(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("Observed defect.")
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(body), "--tier", "P3",
                 "--found-while", "42", "--repo", "acme/widgets", "--dry-run",
                 "--json"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P3"}]),
                },
            )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertTrue(payload["dry_run"])
        self.assertEqual(payload["repo"], "acme/widgets")

    def test_found_while_provenance_line_is_english_only(self):
        # The filed body is read back from the temp file gh is handed, before
        # file_followup.py removes it.
        filed = {}
        real_gh = ff.gh

        def capture(args, check=True):
            if args[:2] == ["issue", "create"]:
                path = args[args.index("--body-file") + 1]
                filed["body"] = Path(path).read_text(encoding="utf-8")
            return real_gh(args, check=check)

        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("Observed defect.")
            with patch("file_followup.gh", side_effect=capture):
                rc, out, err, fake = self._run(
                    ["--title", "t", "--body-file", str(body), "--tier", "P3",
                     "--found-while", "42", "--repo", "acme/widgets", "--json"],
                    {
                        ("repo", "view"): "acme/widgets\n",
                        ("label", "list"): json.dumps([{"name": "priority: P3"}]),
                        ("issue", "create"): "https://github.com/acme/widgets/issues/99\n",
                    },
                )
        self.assertEqual(rc, 0, err)
        self.assertIn("\n\n---\n\n*Found while shipping #42.*\n", filed["body"])
        self.assertTrue(filed["body"].isascii(), filed["body"])

    def test_needs_design_adds_resolved_label_dry_run(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("Observed defect, but the fix approach is undecided.")
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--needs-design", "--repo", "acme/widgets", "--dry-run", "--json"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P2"},
                                                    {"name": "blocked: design"}]),
                },
            )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["labels"], ["priority: P2", "blocked: design"])

    def test_needs_design_reuses_existing_alias_instead_of_creating(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("Observed defect, approach undecided.")
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--needs-design", "--repo", "acme/widgets", "--dry-run", "--json"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P2"},
                                                    {"name": "needs-design"}]),
                },
            )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["labels"], ["priority: P2", "needs-design"])

    def test_omitting_needs_design_never_adds_the_label(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("Observed defect with a clear, verified fix.")
            rc, out, err, fake = self._run(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--repo", "acme/widgets", "--dry-run", "--json"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P2"}]),
                },
            )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["labels"], ["priority: P2"])

    def test_needs_design_without_the_label_fails_and_creates_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            body = Path(td) / "body.txt"
            body.write_text("Observed defect, approach undecided.")
            rc, out, err, calls, filed = self._run_capturing_calls(
                ["--title", "t", "--body-file", str(body), "--tier", "P2",
                 "--needs-design", "--repo", "acme/widgets"],
                {
                    ("repo", "view"): "acme/widgets\n",
                    ("label", "list"): json.dumps([{"name": "priority: P2"}]),
                },
            )
        self.assertEqual(rc, ff.MISSING_LABEL_EXIT, err)
        self.assertIn("blocked: design", err)
        self.assertFalse(any(c[:2] == ["issue", "create"] for c in calls))
        self.assertEqual(label_writes(calls), [])

    def test_unresolvable_repo_exits_1(self):
        rc, out, err, fake = self._run(
            ["--title", "t", "--body-file", "/dev/null", "--tier", "P2"],
            {("repo", "view"): ""},
            exits={("repo", "view"): 1},
        )
        self.assertEqual(rc, 1, err)


if __name__ == "__main__":
    unittest.main()


class ShipContractTest(unittest.TestCase):
    """Every issue this skill files states its own facts, so the next run reads
    them instead of re-deriving them."""

    class _Args:
        def __init__(self, **kw):
            self.tier = "P2"
            self.area = None
            self.touches = None
            self.blocked_by = None
            self.blocks = None
            self.needs_design = False
            self.__dict__.update(kw)

    def test_defaults_state_the_unknowns_explicitly(self):
        block = ff.ship_contract(self._Args())
        self.assertEqual(block,
                         "<!-- ship: tier=P2 blocked-by=none touches=* design=settled -->")

    def test_every_field_round_trips_through_the_digest_parser(self):
        block = ff.ship_contract(self._Args(
            tier="P1", area="test-infra", touches="tests/,vitest.config.ts",
            blocked_by="12,#13", blocks="98"))
        parsed = idg.parse_ship_contract(block)
        self.assertEqual(parsed["tier"], "P1")
        self.assertEqual(parsed["area"], "test-infra")
        self.assertEqual(parsed["touches"], ["tests/", "vitest.config.ts"])
        self.assertEqual(parsed["depends_on"], [12, 13])
        self.assertEqual(parsed["blocks"], [98])
        self.assertEqual(parsed["design"], "settled")
        self.assertEqual(parsed["missing_fields"], [])

    def test_needs_design_marks_the_design_open(self):
        parsed = idg.parse_ship_contract(ff.ship_contract(self._Args(needs_design=True)))
        self.assertEqual(parsed["design"], "open")

    def test_empty_touches_falls_back_to_star_not_to_nothing(self):
        parsed = idg.parse_ship_contract(ff.ship_contract(self._Args(touches=" , ")))
        self.assertEqual(parsed["touches"], ["*"])

    def test_the_block_lands_in_the_created_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            body_file = Path(tmp) / "body.md"
            body_file.write_text("The finding.", encoding="utf-8")
            with FakeGh({("label", "list"): json.dumps([{"name": "priority: P2"}])}) as fake:
                out, err = io.StringIO(), io.StringIO()
                with patch.dict("os.environ", fake.env, clear=False), \
                        patch.object(sys, "argv", [
                            "file_followup.py", "--title", "t",
                            "--body-file", str(body_file), "--tier", "P2",
                            "--touches", "src/api/", "--area", "api",
                            "--dry-run"]), \
                        redirect_stdout(out), redirect_stderr(err):
                    rc = ff.main()
        self.assertEqual(rc, 0, err.getvalue())
        self.assertIn("touches=src/api/", out.getvalue())
        self.assertIn("area=api", out.getvalue())
