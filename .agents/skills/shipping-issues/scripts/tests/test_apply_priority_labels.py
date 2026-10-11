#!/usr/bin/env python3
"""Tests for apply_priority_labels.py. Stdlib-only (unittest).

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import apply_priority_labels as apl
from _fakegh import FakeGh, label_writes


def issue(number, labels, updated="2026-01-01T00:00:00Z", title=None, body=""):
    # `labels` mirrors issue_digest.py's *output* shape (plain name strings);
    # the raw `gh issue list --json labels` shape it consumes wraps each in
    # {"name": …}, so that wrapping happens here.
    return {
        "number": number,
        "title": title or f"issue {number}",
        "labels": [{"name": n} for n in labels],
        "assignees": [],
        "milestone": None,
        "body": body,
        "createdAt": updated,
        "updatedAt": updated,
        "url": f"https://x/{number}",
    }


# The four tier labels and the blocked: labels, as a repo that ran `just labels`
# defines them.
ALL_LABELS = json.dumps(
    [
        {"name": n}
        for n in (
            "priority: P0",
            "priority: P1",
            "priority: P2",
            "priority: P3",
            "blocked: design",
            "blocked: dependency",
        )
    ]
)


class ParseSetsTest(unittest.TestCase):
    def test_valid_pairs(self):
        self.assertEqual(apl.parse_sets(["12=P0", "9=p2"]), {12: "P0", 9: "P2"})

    def test_leading_hash_stripped(self):
        self.assertEqual(apl.parse_sets(["#12=P0"]), {12: "P0"})

    def test_unknown_tier_exits_3(self):
        with self.assertRaises(SystemExit) as cm:
            apl.parse_sets(["12=P9"])
        self.assertEqual(cm.exception.code, 3)

    def test_non_numeric_issue_exits_3(self):
        with self.assertRaises(SystemExit) as cm:
            apl.parse_sets(["abc=P0"])
        self.assertEqual(cm.exception.code, 3)


class ApplyTest(unittest.TestCase):
    def test_adds_target_when_absent(self):
        with patch("apply_priority_labels.gh") as mock_gh:
            changed = apl.apply(12, "P0", [], dry_run=False)
        self.assertTrue(changed)
        mock_gh.assert_called_once_with(
            ["issue", "edit", "12", "--add-label", "priority: P0"]
        )

    def test_no_op_when_already_exact_label(self):
        with patch("apply_priority_labels.gh") as mock_gh:
            changed = apl.apply(12, "P0", ["priority: P0"], dry_run=False)
        self.assertFalse(changed)
        mock_gh.assert_not_called()

    def test_strips_stale_tier_labels(self):
        with patch("apply_priority_labels.gh") as mock_gh:
            changed = apl.apply(12, "P0", ["priority: P2", "bug"], dry_run=False)
        self.assertTrue(changed)
        args = mock_gh.call_args[0][0]
        self.assertIn("--add-label", args)
        self.assertIn("priority: P0", args)
        self.assertIn("--remove-label", args)
        self.assertIn("priority: P2", args)
        self.assertNotIn("bug", args)

    def test_dry_run_never_calls_gh(self):
        with patch("apply_priority_labels.gh") as mock_gh:
            changed = apl.apply(12, "P0", [], dry_run=True)
        self.assertTrue(changed)
        mock_gh.assert_not_called()

    def test_alias_label_is_treated_as_stale(self):
        # "critical" normalizes to the P0 alias set; re-applying P0 with an
        # alias present must still fire so the legacy spelling gets removed.
        with patch("apply_priority_labels.gh") as mock_gh:
            changed = apl.apply(12, "P0", ["critical"], dry_run=False)
        self.assertTrue(changed)
        args = mock_gh.call_args[0][0]
        self.assertIn("--remove-label", args)
        self.assertIn("critical", args)

    def test_case_variant_of_the_target_is_not_removed(self):
        # GitHub matches label names without regard to case, so removing
        # "Priority: P2" while adding "priority: P2" would strip the tier.
        with patch("apply_priority_labels.gh") as mock_gh:
            changed = apl.apply(
                12, "P2", ["Priority: P2"], dry_run=False, target="Priority: P2"
            )
        self.assertFalse(changed)
        mock_gh.assert_not_called()

    def test_writes_the_repos_own_spelling(self):
        with patch("apply_priority_labels.gh") as mock_gh:
            apl.apply(12, "P2", ["P3"], dry_run=False, target="p2")
        mock_gh.assert_called_once_with(
            ["issue", "edit", "12", "--add-label", "p2", "--remove-label", "P3"]
        )


class MissingTierLabelsTest(unittest.TestCase):
    """missing_tier_labels() shells out to the real `gh` on PATH — route PATH
    at a fake one instead of mocking subprocess, so the real subprocess.run
    stays untouched (mocking it here would recurse into gh()'s own call)."""

    def test_names_only_the_missing_labels_and_creates_none(self):
        existing = json.dumps([{"name": "priority: P0"}, {"name": "Priority: p1"}])
        with FakeGh({("label", "list"): existing}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                missing = apl.missing_tier_labels(apl.TIER_ORDER)
            writes = label_writes(fake.calls)
        self.assertEqual(missing, ["priority: P2", "priority: P3"])
        self.assertEqual(writes, [])

    def test_only_the_tiers_asked_about_are_checked(self):
        with FakeGh(
            {("label", "list"): json.dumps([{"name": "priority: P2"}])}
        ) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                missing = apl.missing_tier_labels(["P2", "P2"])
        self.assertEqual(missing, [])

    def test_alias_only_repo_is_not_missing_its_tiers(self):
        aliases = json.dumps([{"name": n} for n in ("p0", "p1", "p2", "p3")])
        with FakeGh({("label", "list"): aliases}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                missing = apl.missing_tier_labels(apl.TIER_ORDER)
        self.assertEqual(missing, [])


class SetClearDesignTest(unittest.TestCase):
    """set_design()/clear_design() shell out to the real `gh` on PATH — route
    PATH at a fake one instead of mocking subprocess, same as MissingTierLabelsTest."""

    def test_design_label_missing_exits_4_and_creates_nothing(self):
        with FakeGh({("label", "list"): "[]"}) as fake:
            err = io.StringIO()
            with patch.dict("os.environ", fake.env, clear=False), redirect_stderr(err):
                with self.assertRaises(SystemExit) as cm:
                    apl.design_label()
            writes = label_writes(fake.calls)
        self.assertEqual(cm.exception.code, apl.MISSING_LABEL_EXIT)
        self.assertIn("blocked: design", err.getvalue())
        self.assertIn("just labels", err.getvalue())
        self.assertEqual(writes, [])

    def test_design_label_reuses_existing_alias(self):
        existing = json.dumps([{"name": "needs-design"}])
        with FakeGh({("label", "list"): existing}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                name = apl.design_label()
        self.assertEqual(name, "needs-design")

    def test_set_design_adds_the_label(self):
        with FakeGh({("issue", "edit"): ""}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                name = apl.set_design(12, "blocked: design", dry_run=False)
            edits = [c for c in fake.calls if c[:2] == ["issue", "edit"]]
        self.assertEqual(name, "blocked: design")
        self.assertEqual(
            edits, [["issue", "edit", "12", "--add-label", "blocked: design"]]
        )

    def test_set_design_dry_run_makes_no_gh_mutations(self):
        with FakeGh({}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                name = apl.set_design(12, "blocked: design", dry_run=True)
            calls = list(fake.calls)
        self.assertEqual(name, "blocked: design")
        self.assertEqual(calls, [])

    def test_clear_design_removes_carried_alias(self):
        view = json.dumps(
            {"labels": [{"name": "needs-design"}, {"name": "priority: P1"}]}
        )
        with FakeGh({("issue", "view"): view, ("issue", "edit"): ""}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                removed = apl.clear_design(12, dry_run=False)
            edits = [c for c in fake.calls if c[:2] == ["issue", "edit"]]
        self.assertEqual(removed, ["needs-design"])
        self.assertEqual(
            edits, [["issue", "edit", "12", "--remove-label", "needs-design"]]
        )

    def test_clear_design_is_a_noop_when_not_present(self):
        view = json.dumps({"labels": [{"name": "priority: P1"}]})
        with FakeGh({("issue", "view"): view}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                removed = apl.clear_design(12, dry_run=False)
            edited = any(c[:2] == ["issue", "edit"] for c in fake.calls)
        self.assertEqual(removed, [])
        self.assertFalse(edited)

    def test_clear_design_dry_run_makes_no_gh_mutations(self):
        view = json.dumps({"labels": [{"name": "blocked: design"}]})
        with FakeGh({("issue", "view"): view}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                removed = apl.clear_design(12, dry_run=True)
            edited = any(c[:2] == ["issue", "edit"] for c in fake.calls)
        self.assertEqual(removed, ["blocked: design"])
        self.assertFalse(edited)


OPEN_BODY = (
    "Prose that mentions design=open outside the block stays as written.\n"
    "<!-- ship: tier=P2 area=skills blocked-by=none\n"
    "     touches=scripts/ design=open -->\n"
    "Trailing prose.\n"
)
SETTLED_BODY = OPEN_BODY.replace(
    "touches=scripts/ design=open", "touches=scripts/ design=settled"
)


class SettleContractDesignTest(unittest.TestCase):
    """settle_contract_design() rewrites one field's value and nothing else."""

    def test_rewrites_only_the_contract_field(self):
        self.assertEqual(apl.settle_contract_design(OPEN_BODY), SETTLED_BODY)

    def test_an_empty_field_beside_design_open_is_kept_byte_for_byte(self):
        body = "<!-- ship: tier=P2 blocked-by= blocks=#4 design=open -->"
        self.assertEqual(
            apl.settle_contract_design(body),
            "<!-- ship: tier=P2 blocked-by= blocks=#4 design=settled -->",
        )

    def test_an_empty_design_field_beside_an_open_one_does_not_crash(self):
        body = "<!-- ship: design= blocks=#3 design=open -->"
        self.assertEqual(
            apl.settle_contract_design(body),
            "<!-- ship: design= blocks=#3 design=settled -->",
        )

    def test_an_empty_design_field_is_not_settled(self):
        self.assertIsNone(apl.settle_contract_design("<!-- ship: tier=P2 design= -->"))

    def test_keeps_the_keys_spelling_and_spacing(self):
        body = "<!-- SHIP: Design = OPEN tier=P1 -->"
        self.assertEqual(
            apl.settle_contract_design(body), "<!-- SHIP: Design = settled tier=P1 -->"
        )

    def test_the_rewritten_body_parses_as_settled(self):
        settled = apl.settle_contract_design(OPEN_BODY)
        self.assertEqual(apl.parse_ship_contract(settled)["design"], "settled")

    def test_every_open_field_is_settled_when_the_last_one_is_open(self):
        body = "<!-- ship: design=open -->\nx\n<!-- ship: tier=P1 design=open -->"
        self.assertEqual(
            apl.settle_contract_design(body),
            "<!-- ship: design=settled -->\nx\n<!-- ship: tier=P1 design=settled -->",
        )

    def test_design_open_inside_another_fields_value_is_not_a_design_field(self):
        # Values never contain spaces, so `touches=a,design=open` is one
        # touches= value; issue_digest.py reads no design= field here, and
        # neither does the rewrite — the two must keep agreeing.
        body = "<!-- ship: tier=P1 touches=a,design=open -->"
        self.assertIsNone(apl.parse_ship_contract(body)["design"])
        self.assertIsNone(apl.settle_contract_design(body))

    def test_examples_quoted_in_code_are_left_byte_identical(self):
        body = (
            "Example:\n\n```\n<!-- ship: design=open -->\n```\n"
            "~~~\n<!-- ship: design=open -->\n~~~\n"
            "Inline `<!-- ship: design=open -->` too.\n\n"
            "<!-- ship: tier=P1 design=open -->\n"
        )
        self.assertEqual(
            apl.settle_contract_design(body),
            body.replace("tier=P1 design=open", "tier=P1 design=settled"),
        )

    def test_rewrites_the_block_the_digest_locates(self):
        # The invariant: the parser and the rewrite agree on the contract.
        body = (
            "```\n<!-- ship: design=open -->\n```\n<!-- ship: tier=P1 design=open -->"
        )
        (real,) = apl.find_ship_contracts(body)
        settled = apl.settle_contract_design(body)
        self.assertEqual(settled[: real.start()], body[: real.start()])
        self.assertEqual(
            settled[real.start() :], "<!-- ship: tier=P1 design=settled -->"
        )

    def test_none_when_only_a_quoted_example_is_open(self):
        body = "```\n<!-- ship: design=open -->\n```\n<!-- ship: tier=P1 -->"
        self.assertIsNone(apl.settle_contract_design(body))

    def test_none_when_there_is_nothing_to_settle(self):
        for body in (
            "",
            "no contract, design=open in prose only",
            "<!-- ship: tier=P1 -->",
            SETTLED_BODY,
            # The parser reads the last block, so this is settled.
            "<!-- ship: design=open -->\n<!-- ship: design=settled -->",
        ):
            with self.subTest(body=body):
                self.assertIsNone(apl.settle_contract_design(body))


class ClearDesignBothFormsTest(unittest.TestCase):
    """clear_design() clears the label and the contract's design=open — the
    two forms issue_digest.py reads as one block — in one `gh issue edit`."""

    def _clear(self, labels, body, dry_run=False):
        view = json.dumps({"labels": [{"name": n} for n in labels], "body": body})
        written = {}
        real_gh = apl.gh

        def capture(args, check=True):
            if args[:2] == ["issue", "edit"] and "--body-file" in args:
                path = args[args.index("--body-file") + 1]
                # Bytes, not read_text(): universal newlines would hide a CRLF.
                written["body"] = Path(path).read_bytes().decode("utf-8")
            return real_gh(args, check=check)

        with (
            FakeGh({("issue", "view"): view, ("issue", "edit"): ""}) as fake,
            patch("apply_priority_labels.gh", side_effect=capture),
        ):
            with patch.dict("os.environ", fake.env, clear=False):
                cleared = apl.clear_design(12, dry_run=dry_run)
            views = [c for c in fake.calls if c[:2] == ["issue", "view"]]
            edits = [c for c in fake.calls if c[:2] == ["issue", "edit"]]
        # The fake answers whatever is asked, so without this a view that
        # dropped `body` would read as "no contract" and every test would pass.
        self.assertEqual(len(views), 1)
        fields = views[0][views[0].index("--json") + 1].split(",")
        self.assertIn("body", fields)
        self.assertIn("labels", fields)
        return cleared, edits, written.get("body")

    def test_label_only(self):
        cleared, edits, body = self._clear(
            ["blocked: design", "priority: P2"], "no contract here"
        )
        self.assertEqual(cleared, ["blocked: design"])
        self.assertEqual(
            edits, [["issue", "edit", "12", "--remove-label", "blocked: design"]]
        )
        self.assertIsNone(body)

    def test_marker_only(self):
        cleared, edits, body = self._clear(["priority: P2"], OPEN_BODY)
        self.assertEqual(cleared, [apl.CONTRACT_DESIGN_MARKER])
        self.assertEqual(len(edits), 1)
        self.assertEqual(edits[0][:3], ["issue", "edit", "12"])
        self.assertNotIn("--remove-label", edits[0])
        self.assertEqual(body, SETTLED_BODY)

    def test_both(self):
        cleared, edits, body = self._clear(["needs-design"], OPEN_BODY)
        self.assertEqual(cleared, ["needs-design", apl.CONTRACT_DESIGN_MARKER])
        self.assertEqual(len(edits), 1)
        self.assertEqual(
            edits[0][:5], ["issue", "edit", "12", "--remove-label", "needs-design"]
        )
        self.assertIn("--body-file", edits[0])
        self.assertEqual(body, SETTLED_BODY)

    def test_crlf_line_endings_survive_the_rewrite(self):
        crlf = OPEN_BODY.replace("\n", "\r\n")
        _, _, body = self._clear([], crlf)
        self.assertEqual(body, SETTLED_BODY.replace("\n", "\r\n"))

    def test_fenced_example_survives_clear_design(self):
        issue_body = (
            "```\n<!-- ship: design=open -->\n```\n\n"
            "<!-- ship: tier=P1 design=open -->\n"
        )
        _, _, body = self._clear([], issue_body)
        self.assertEqual(
            body, issue_body.replace("tier=P1 design=open", "tier=P1 design=settled")
        )

    def test_neither(self):
        for issue_body in ("no contract here", SETTLED_BODY):
            with self.subTest(body=issue_body):
                cleared, edits, body = self._clear(["priority: P2"], issue_body)
                self.assertEqual(cleared, [])
                self.assertEqual(edits, [])
                self.assertIsNone(body)

    def test_a_settled_contract_leaves_the_label_to_this_call(self):
        # design=settled never clears a label by itself; the label goes because
        # --clear-design was run, and the already-settled body is not rewritten.
        cleared, edits, body = self._clear(["blocked: design"], SETTLED_BODY)
        self.assertEqual(cleared, ["blocked: design"])
        self.assertEqual(
            edits, [["issue", "edit", "12", "--remove-label", "blocked: design"]]
        )
        self.assertIsNone(body)

    def test_dry_run_reports_both_and_writes_nothing(self):
        cleared, edits, body = self._clear(["blocked: design"], OPEN_BODY, dry_run=True)
        self.assertEqual(cleared, ["blocked: design", apl.CONTRACT_DESIGN_MARKER])
        self.assertEqual(edits, [])
        self.assertIsNone(body)

    def test_a_failed_edit_exits_non_zero_and_removes_the_temp_file(self):
        view = json.dumps({"labels": [], "body": OPEN_BODY})
        paths = []
        real_gh = apl.gh

        def capture(args, check=True):
            if args[:2] == ["issue", "edit"]:
                paths.append(Path(args[args.index("--body-file") + 1]))
                self.assertTrue(paths[-1].exists())
            return real_gh(args, check=check)

        with (
            FakeGh(
                {("issue", "view"): view, ("issue", "edit"): ""},
                exits={("issue", "edit"): 1},
                stderrs={("issue", "edit"): "boom"},
            ) as fake,
            patch("apply_priority_labels.gh", side_effect=capture),
        ):
            err = io.StringIO()
            with (
                patch.dict("os.environ", fake.env, clear=False),
                redirect_stderr(err),
                self.assertRaises(SystemExit) as cm,
            ):
                apl.clear_design(12, dry_run=False)
        self.assertNotEqual(cm.exception.code, 0)
        self.assertIn("boom", err.getvalue())
        self.assertEqual(len(paths), 1)
        self.assertFalse(paths[0].exists())

    def test_the_digest_no_longer_holds_the_issue_afterwards(self):
        import issue_digest as idg

        _, _, body = self._clear(["blocked: design"], OPEN_BODY)

        def select(labels, issue_body):
            responses = {
                ("issue", "list"): json.dumps([issue(12, labels, body=issue_body)]),
                ("pr", "list"): "[]",
            }
            with FakeGh(responses) as fake:
                out = io.StringIO()
                with (
                    patch.dict("os.environ", fake.env, clear=False),
                    patch.object(sys, "argv", ["issue_digest.py", "--select"]),
                    redirect_stdout(out),
                ):
                    self.assertEqual(idg.main(), 0)
            return out.getvalue()

        self.assertIn("needs-design: #12", select(["priority: P2"], OPEN_BODY))
        self.assertNotIn("needs-design", select(["priority: P2"], body))


class ClearDependencyTest(unittest.TestCase):
    """clear_dependency() shells out to the real `gh` on PATH — route PATH at
    a fake one instead of mocking subprocess, same as SetClearDesignTest."""

    def test_removes_carried_label(self):
        view = json.dumps(
            {"labels": [{"name": "blocked: dependency"}, {"name": "priority: P1"}]}
        )
        with FakeGh({("issue", "view"): view, ("issue", "edit"): ""}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                removed = apl.clear_dependency(12, dry_run=False)
            edits = [c for c in fake.calls if c[:2] == ["issue", "edit"]]
        self.assertEqual(removed, ["blocked: dependency"])
        self.assertEqual(
            edits, [["issue", "edit", "12", "--remove-label", "blocked: dependency"]]
        )

    def test_noop_when_not_present(self):
        view = json.dumps({"labels": [{"name": "priority: P1"}]})
        with FakeGh({("issue", "view"): view}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                removed = apl.clear_dependency(12, dry_run=False)
            edited = any(c[:2] == ["issue", "edit"] for c in fake.calls)
        self.assertEqual(removed, [])
        self.assertFalse(edited)

    def test_dry_run_makes_no_gh_mutations(self):
        view = json.dumps({"labels": [{"name": "blocked: dependency"}]})
        with FakeGh({("issue", "view"): view}) as fake:
            with patch.dict("os.environ", fake.env, clear=False):
                removed = apl.clear_dependency(12, dry_run=True)
            edited = any(c[:2] == ["issue", "edit"] for c in fake.calls)
        self.assertEqual(removed, ["blocked: dependency"])
        self.assertFalse(edited)


class MainEndToEndTest(unittest.TestCase):
    """Run the label CLI in-process, with only GitHub calls routed to FakeGh."""

    def test_backfill_uses_the_ranking_library_without_a_child_python(self):
        real_run = subprocess.run
        with patch("subprocess.run", wraps=real_run) as invoked:
            rc, out, err, calls = self._run(
                ["--backfill", "--json"],
                {
                    ("label", "list"): ALL_LABELS,
                    ("issue", "list"): json.dumps([issue(12, [])]),
                    ("pr", "list"): "[]",
                    ("issue", "edit"): "",
                },
            )
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["changed"][0]["number"], 12)
        self.assertTrue(any(call[:2] == ["issue", "edit"] for call in calls))
        self.assertFalse(
            any(
                str(call.args[0][0]) == sys.executable
                for call in invoked.call_args_list
            )
        )

    def _run(self, args, responses, path_override=None):
        with FakeGh(responses) as fake:
            env = dict(fake.env)
            if path_override is not None:
                env["PATH"] = path_override
            out, err = io.StringIO(), io.StringIO()
            with (
                patch.dict("os.environ", env, clear=False),
                patch.object(sys, "argv", ["apply_priority_labels.py", *args]),
                redirect_stdout(out),
                redirect_stderr(err),
            ):
                try:
                    rc = apl.main()
                except SystemExit as exc:
                    rc = exc.code
            # Copied inside the block: leaving it deletes the fake's call log.
            calls = list(fake.calls)
        return rc, out.getvalue(), err.getvalue(), calls

    def test_backfill_labels_unlabeled_open_issue(self):
        issues = json.dumps([issue(12, [])])
        rc, out, err, calls = self._run(
            ["--backfill", "--json"],
            {
                ("label", "list"): ALL_LABELS,
                ("issue", "list"): issues,
                ("pr", "list"): "[]",
                ("issue", "edit"): "",
            },
        )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["verdict"], "OK")
        self.assertEqual(len(payload["changed"]), 1)
        self.assertEqual(payload["changed"][0]["number"], 12)
        # #12 had no leverage signal, an empty body and no unblocks, so the
        # heuristic suggestion is the lowest tier.
        self.assertEqual(payload["changed"][0]["tier"], "P3")
        edits = [c for c in calls if c[:2] == ["issue", "edit"]]
        self.assertEqual(len(edits), 1)
        self.assertIn("12", edits[0])

    def test_set_overrides_backfill_suggestion(self):
        issues = json.dumps([issue(9, [])])
        rc, out, err, calls = self._run(
            ["--set", "9=P0", "--json"],
            {
                ("label", "list"): ALL_LABELS,
                ("issue", "list"): issues,
                ("pr", "list"): "[]",
                ("issue", "edit"): "",
            },
        )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["changed"][0]["tier"], "P0")
        self.assertEqual(payload["changed"][0]["why"], "explicit")

    def test_quiet_suppresses_per_issue_lines(self):
        issues = json.dumps([issue(12, [])])
        rc, out, err, calls = self._run(
            ["--backfill", "--quiet"],
            {
                ("label", "list"): ALL_LABELS,
                ("issue", "list"): issues,
                ("pr", "list"): "[]",
                ("issue", "edit"): "",
            },
        )
        self.assertEqual(rc, 0, err)
        self.assertNotIn("#12:", out)
        self.assertIn("verdict: OK", out)

    def test_dry_run_makes_no_gh_mutations(self):
        issues = json.dumps([issue(12, [])])
        rc, out, err, calls = self._run(
            ["--backfill", "--dry-run"],
            {
                ("label", "list"): ALL_LABELS,
                ("issue", "list"): issues,
                ("pr", "list"): "[]",
            },
        )
        self.assertEqual(rc, 0, err)
        # The label read proves the log was captured, so the empty check bites.
        self.assertIn(["label", "list"], [c[:2] for c in calls])
        mutating = [c for c in calls if c[:2] == ["issue", "edit"]]
        self.assertEqual(mutating + label_writes(calls), [])

    def test_backfill_on_an_alias_only_repo_writes_the_alias(self):
        aliases = json.dumps([{"name": n} for n in ("p0", "p1", "p2", "p3")])
        rc, out, err, calls = self._run(
            ["--backfill", "--json"],
            {
                ("label", "list"): aliases,
                ("issue", "list"): json.dumps([issue(12, [])]),
                ("pr", "list"): "[]",
                ("issue", "edit"): "",
            },
        )
        self.assertEqual(rc, 0, err)
        edits = [c for c in calls if c[:2] == ["issue", "edit"]]
        self.assertEqual(edits, [["issue", "edit", "12", "--add-label", "p3"]])

    def test_backfill_on_a_case_variant_label_keeps_the_label_it_adds(self):
        variant = json.dumps([{"name": "Priority: P2"}])
        body = "<!-- ship: tier=P2 -->"
        rc, out, err, calls = self._run(
            ["--backfill", "--json"],
            {
                ("label", "list"): variant,
                ("issue", "list"): json.dumps([issue(12, [], body=body)]),
                ("pr", "list"): "[]",
                ("issue", "edit"): "",
            },
        )
        self.assertEqual(rc, 0, err)
        edits = [c for c in calls if c[:2] == ["issue", "edit"]]
        self.assertEqual(
            edits, [["issue", "edit", "12", "--add-label", "Priority: P2"]]
        )

    def test_set_on_an_issue_carrying_a_case_variant_is_a_no_op(self):
        variant = json.dumps([{"name": "Priority: P2"}])
        rc, out, err, calls = self._run(
            ["--set", "12=P2", "--json"],
            {
                ("label", "list"): variant,
                ("issue", "list"): json.dumps([issue(12, ["Priority: P2"])]),
                ("pr", "list"): "[]",
                ("issue", "edit"): "",
            },
        )
        self.assertEqual(rc, 0, err)
        self.assertEqual([c for c in calls if c[:2] == ["issue", "edit"]], [])
        self.assertEqual(json.loads(out)["unchanged"], [12])

    def test_no_arguments_is_a_usage_error(self):
        rc, out, err, calls = self._run([], {})
        self.assertNotEqual(rc, 0)

    def test_set_design_combined_with_backfill_is_a_usage_error(self):
        rc, out, err, calls = self._run(["--set-design", "12", "--backfill"], {})
        self.assertNotEqual(rc, 0)
        self.assertIn("standalone", err)

    def test_gh_not_found_reports_error(self):
        rc, out, err, calls = self._run(
            ["--backfill"], {}, path_override="/nonexistent-only"
        )
        self.assertEqual(rc, 1)
        self.assertIn("gh CLI not found", err)

    def test_check_labels_only_skips_the_digest(self):
        rc, out, err, calls = self._run(
            ["--check-labels"], {("label", "list"): ALL_LABELS}
        )
        self.assertEqual(rc, 0, err)
        self.assertIn("verdict: OK", out)
        # No issue/pr calls means load_digest() (and thus issue_digest.py)
        # never ran — --check-labels alone must not touch the backlog.
        self.assertFalse(any(c[:2] == ["issue", "list"] for c in calls))

    def test_check_labels_reports_missing_with_repo_labels_as_next_step(self):
        rc, out, err, calls = self._run(
            ["--check-labels"],
            {("label", "list"): json.dumps([{"name": "priority: P0"}])},
        )
        self.assertEqual(rc, apl.MISSING_LABEL_EXIT)
        self.assertIn("priority: P1", err)
        self.assertIn("just labels", err)
        self.assertEqual(label_writes(calls), [])

    def test_backfill_with_a_missing_tier_label_writes_nothing(self):
        issues = json.dumps([issue(12, [])])
        rc, out, err, calls = self._run(
            ["--backfill"],
            {
                ("label", "list"): "[]",
                ("issue", "list"): issues,
                ("pr", "list"): "[]",
                ("issue", "edit"): "",
            },
        )
        self.assertEqual(rc, apl.MISSING_LABEL_EXIT, err)
        self.assertIn("just labels", err)
        self.assertFalse(any(c[:2] == ["issue", "edit"] for c in calls))
        self.assertEqual(label_writes(calls), [])

    def test_set_design_with_no_design_label_writes_nothing(self):
        rc, out, err, calls = self._run(
            ["--set-design", "12"], {("label", "list"): "[]", ("issue", "edit"): ""}
        )
        self.assertEqual(rc, apl.MISSING_LABEL_EXIT, err)
        self.assertFalse(any(c[:2] == ["issue", "edit"] for c in calls))
        self.assertEqual(label_writes(calls), [])

    def test_set_on_issue_not_in_open_digest_still_labels_it(self):
        # #99 is a valid --set target that the digest does not return (closed,
        # or filtered out) — it must still get labeled, not treated as an error.
        issues = json.dumps([issue(12, [])])
        rc, out, err, calls = self._run(
            ["--set", "99=P1", "--json"],
            {
                ("label", "list"): ALL_LABELS,
                ("issue", "list"): issues,
                ("pr", "list"): "[]",
                ("issue", "edit"): "",
            },
        )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["not_open"], [99])
        self.assertEqual(payload["changed"][0]["was"], "not-open")

    def test_set_design_via_main_never_calls_the_digest(self):
        # --set-design alone must not shell out to issue_digest.py — it needs
        # only the repo's label list and the one issue, not the whole backlog.
        rc, out, err, calls = self._run(
            ["--set-design", "12"],
            {("label", "list"): ALL_LABELS, ("issue", "edit"): ""},
        )
        self.assertEqual(rc, 0, err)
        self.assertIn("verdict: OK", out)
        self.assertFalse(any(c[:2] == ["issue", "list"] for c in calls))

    def test_clear_design_via_main_reports_cleared(self):
        view = json.dumps({"labels": [{"name": "blocked: design"}]})
        rc, out, err, calls = self._run(
            ["--clear-design", "12"],
            {("issue", "view"): view, ("issue", "edit"): ""},
        )
        self.assertEqual(rc, 0, err)
        self.assertIn("#12: needs-design cleared", out)

    def test_clear_design_via_main_names_the_settled_contract(self):
        view = json.dumps({"labels": [], "body": OPEN_BODY})
        rc, out, err, calls = self._run(
            ["--clear-design", "12"],
            {("issue", "view"): view, ("issue", "edit"): ""},
        )
        self.assertEqual(rc, 0, err)
        self.assertIn("#12: needs-design cleared (ship:design=open)", out)
        edits = [c for c in calls if c[:2] == ["issue", "edit"]]
        self.assertEqual(len(edits), 1)
        self.assertIn("--body-file", edits[0])

    def test_clear_design_dry_run_text_says_would_clear(self):
        view = json.dumps({"labels": [{"name": "blocked: design"}], "body": OPEN_BODY})
        rc, out, err, calls = self._run(
            ["--clear-design", "12", "--dry-run"],
            {("issue", "view"): view},
        )
        self.assertEqual(rc, 0, err)
        self.assertIn(
            "#12: needs-design would clear (blocked: design, ship:design=open)", out
        )
        self.assertNotIn("needs-design cleared", out)
        self.assertFalse(any(c[:2] == ["issue", "edit"] for c in calls))

    def test_clear_design_dry_run_via_main_makes_no_gh_mutations(self):
        view = json.dumps({"labels": [{"name": "blocked: design"}], "body": OPEN_BODY})
        rc, out, err, calls = self._run(
            ["--clear-design", "12", "--dry-run", "--json"],
            {("issue", "view"): view},
        )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(
            payload["design_cleared"],
            [{"number": 12, "removed": ["blocked: design", "ship:design=open"]}],
        )
        self.assertFalse(any(c[:2] == ["issue", "edit"] for c in calls))

    def test_clear_design_via_main_json_output(self):
        view = json.dumps({"labels": []})
        rc, out, err, calls = self._run(
            ["--clear-design", "12", "--json"],
            {("issue", "view"): view},
        )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["design_cleared"], [{"number": 12, "removed": []}])

    def test_clear_dependency_via_main_reports_cleared(self):
        view = json.dumps({"labels": [{"name": "blocked: dependency"}]})
        rc, out, err, calls = self._run(
            ["--clear-dependency", "12"],
            {("issue", "view"): view, ("issue", "edit"): ""},
        )
        self.assertEqual(rc, 0, err)
        self.assertIn("#12: dependency-block cleared", out)

    def test_clear_dependency_via_main_is_noop_when_absent(self):
        view = json.dumps({"labels": []})
        rc, out, err, calls = self._run(
            ["--clear-dependency", "12"],
            {("issue", "view"): view},
        )
        self.assertEqual(rc, 0, err)
        self.assertIn("#12: dependency-block already clear", out)
        self.assertIn(["issue", "view"], [c[:2] for c in calls])
        self.assertFalse(any(c[:2] == ["issue", "edit"] for c in calls))

    def test_clear_dependency_dry_run_makes_no_gh_mutations(self):
        view = json.dumps({"labels": [{"name": "blocked: dependency"}]})
        rc, out, err, calls = self._run(
            ["--clear-dependency", "12", "--dry-run"],
            {("issue", "view"): view},
        )
        self.assertEqual(rc, 0, err)
        self.assertIn(["issue", "view"], [c[:2] for c in calls])
        self.assertFalse(any(c[:2] == ["issue", "edit"] for c in calls))

    def test_clear_dependency_via_main_json_output(self):
        view = json.dumps({"labels": []})
        rc, out, err, calls = self._run(
            ["--clear-dependency", "12", "--json"],
            {("issue", "view"): view},
        )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["dependency_cleared"], [{"number": 12, "removed": []}])

    def test_clear_dependency_combines_with_clear_design_in_one_call(self):
        view = json.dumps(
            {"labels": [{"name": "blocked: dependency"}, {"name": "blocked: design"}]}
        )
        rc, out, err, calls = self._run(
            ["--clear-dependency", "12", "--clear-design", "12", "--json"],
            {("issue", "view"): view, ("issue", "edit"): ""},
        )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(
            payload["dependency_cleared"],
            [{"number": 12, "removed": ["blocked: dependency"]}],
        )
        self.assertEqual(
            payload["design_cleared"], [{"number": 12, "removed": ["blocked: design"]}]
        )

    def test_clear_dependency_combined_with_backfill_is_a_usage_error(self):
        rc, out, err, calls = self._run(["--clear-dependency", "12", "--backfill"], {})
        self.assertNotEqual(rc, 0)
        self.assertIn("standalone", err)

    def test_set_on_already_correct_label_is_unchanged(self):
        issues = json.dumps([issue(12, ["priority: P0"])])
        rc, out, err, calls = self._run(
            ["--set", "12=P0", "--json"],
            {
                ("label", "list"): ALL_LABELS,
                ("issue", "list"): issues,
                ("pr", "list"): "[]",
            },
        )
        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["changed"], [])
        self.assertEqual(payload["unchanged"], [12])


class GhErrorBranchesTest(unittest.TestCase):
    """The direct-exec error paths in gh() and load_digest() — narrow enough
    that unit-level mocks are clearer than routing another fake gh."""

    def test_gh_missing_binary_exits_1(self):
        with patch(
            "apply_priority_labels.subprocess.run", side_effect=FileNotFoundError()
        ):
            with self.assertRaises(SystemExit) as cm:
                apl.gh(["label", "list"])
        self.assertEqual(cm.exception.code, 1)

    def test_gh_timeout_exits_1(self):
        with patch(
            "apply_priority_labels.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="gh", timeout=120),
        ):
            with self.assertRaises(SystemExit) as cm:
                apl.gh(["label", "list"])
        self.assertEqual(cm.exception.code, 1)

    def test_gh_generic_failure_exits_1(self):
        with patch("apply_priority_labels.subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.CalledProcessError(
                1, ["gh"], output="", stderr="some other gh error"
            )
            with self.assertRaises(SystemExit) as cm:
                apl.gh(["label", "list"])
        self.assertEqual(cm.exception.code, 1)

    def test_load_digest_nonzero_exit_raises_1(self):
        with patch(
            "issue_records.subprocess.run",
            side_effect=subprocess.CalledProcessError(1, ["gh"], stderr="boom"),
        ):
            with self.assertRaises(SystemExit) as cm:
                apl.load_digest()
        self.assertEqual(cm.exception.code, 1)

    def test_no_write_access_exits_2(self):
        # The gh() wrapper is what maps a 403 to exit 2 — covered directly
        # rather than via a full subprocess round-trip.
        with patch("apply_priority_labels.subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.CalledProcessError(
                1, ["gh"], output="", stderr="HTTP 403: Resource not accessible"
            )
            with self.assertRaises(SystemExit) as cm:
                apl.gh(["issue", "edit", "12", "--add-label", "x"])
            self.assertEqual(cm.exception.code, 2)


class BackfillHonoursTheContractTest(unittest.TestCase):
    """A declared tier is a decision; the heuristic must never overwrite it."""

    def _run(self, issues, argv):
        responses = {
            ("issue", "list"): json.dumps(issues),
            ("pr", "list"): "[]",
            ("label", "list"): json.dumps(
                [
                    {"name": n}
                    for n in (
                        "priority: P0",
                        "priority: P1",
                        "priority: P2",
                        "priority: P3",
                    )
                ]
            ),
        }
        with FakeGh(responses) as fake:
            out, err = io.StringIO(), io.StringIO()
            with (
                patch.dict("os.environ", fake.env, clear=False),
                patch.object(sys, "argv", ["apply_priority_labels.py", *argv]),
                redirect_stdout(out),
                redirect_stderr(err),
            ):
                try:
                    rc = apl.main()
                except SystemExit as exc:
                    rc = exc.code
        return rc, out.getvalue(), err.getvalue()

    def test_declared_tier_is_written_not_the_score(self):
        issues = [
            issue(1, [], title="a small doc tweak", body="<!-- ship: tier=P0 -->")
        ]
        rc, out, err = self._run(issues, ["--backfill", "--dry-run", "--json"])
        self.assertEqual(rc, 0, err)
        rows = json.loads(out)["changed"]
        self.assertEqual(rows[0]["tier"], "P0")
        self.assertEqual(rows[0]["why"], "ship contract")

    def test_no_contract_still_falls_back_to_the_suggestion(self):
        rc, out, err = self._run(
            [issue(1, [], title="a small doc tweak")],
            ["--backfill", "--dry-run", "--json"],
        )
        rows = json.loads(out)["changed"]
        self.assertNotEqual(rows[0]["why"], "ship contract")

    def test_explicit_set_still_overrides_the_contract(self):
        issues = [issue(1, [], body="<!-- ship: tier=P0 -->")]
        rc, out, err = self._run(
            issues, ["--backfill", "--set", "1=P3", "--dry-run", "--json"]
        )
        rows = json.loads(out)["changed"]
        self.assertEqual(rows[0]["tier"], "P3")
        self.assertEqual(rows[0]["why"], "explicit")


class NoBytecodeTest(unittest.TestCase):
    """Run from the .claude/skills mirror, a sibling import would leave
    __pycache__/ beside the scripts, which `just agents-check` reports as
    drift and shipping-issues itself treats as a dirty tree."""

    def test_scripts_with_a_sibling_import_write_no_bytecode(self):
        import os
        import shutil
        import tempfile

        scripts = Path(__file__).resolve().parent.parent
        env = {k: v for k, v in os.environ.items() if k != "PYTHONDONTWRITEBYTECODE"}
        for name in ("apply_priority_labels.py", "file_followup.py"):
            with self.subTest(script=name), tempfile.TemporaryDirectory() as td:
                for f in scripts.glob("*.py"):
                    shutil.copy(f, td)
                subprocess.run(
                    [sys.executable, str(Path(td) / name), "--help"],
                    env=env,
                    capture_output=True,
                    check=True,
                )
                self.assertEqual(list(Path(td).rglob("__pycache__")), [])


if __name__ == "__main__":
    unittest.main()
