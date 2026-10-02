#!/usr/bin/env python3
"""Tests for survey_prs.py. Stdlib-only (unittest).

Run from the repository root:
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
        -s .agents/skills/merging-dependency-prs/scripts/tests \
        -t .agents/skills/merging-dependency-prs/scripts/tests -p 'test_*.py'
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _fakegh import FakeGh  # noqa: E402
import survey_prs as sp  # noqa: E402

SCRIPT = Path(__file__).resolve().parent.parent / "survey_prs.py"

CARGO_LOCK = "\n".join([
    "version = 4",
    "",
    "[[package]]",
    'name = "serde"',
    'version = "1.0.228"',
    "",
    "[[package]]",
    'name = "tauri"',
    'version = "2.11.6"',
    "",
    "[[package]]",
    'name = "tauri-plugin-log"',
    'version = "2.10.0"',
])

PACKAGE_JSON = json.dumps({
    "dependencies": {"@tauri-apps/api": "~2.11.1", "react": "^19.3.0"},
    "devDependencies": {"@tauri-apps/cli": "~2.11.5"},
})


class TempRoots(unittest.TestCase):
    def temp_root(self, files: dict[str, str] | None = None) -> Path:
        tmp = tempfile.TemporaryDirectory(prefix="survey-prs-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for name, text in (files or {}).items():
            (root / name).write_text(text, encoding="utf-8")
        return root


def b(name, from_, to):
    return {"name": name, "from": from_, "to": to}


# ---------------------------------------------------------------- the dispatcher

PULLS = [
    {
        "number": 12,
        "title": "deps: bump the cargo-minor-and-patch group with 1 update",
        "body": "Updates `tauri` from 2.11.6 to 2.12.0",
        "author": {"login": "app/dependabot"},
        "headRefName": "dependabot/cargo/cargo-minor-and-patch-1",
        "mergeStateStatus": "CLEAN",
        "statusCheckRollup": [{"name": "Rust Core", "status": "COMPLETED", "conclusion": "SUCCESS"}],
        "files": [{"path": "Cargo.lock"}],
        "url": "https://example.invalid/pull/12",
    },
    {
        "number": 10,
        "title": "ci: bump actions/checkout from 7.0.1 to 7.1.0",
        "body": "",
        "author": {"login": "app/dependabot"},
        "headRefName": "dependabot/github_actions/actions/checkout-7.1.0",
        "mergeStateStatus": "BEHIND",
        "statusCheckRollup": [{"name": "Repo Lint & Harness", "status": "IN_PROGRESS"}],
        "files": [{"path": ".github/workflows/ci.yml"}],
        "url": "https://example.invalid/pull/10",
    },
    {
        "number": 11,
        "title": "feat: a human's pull request",
        "body": "",
        "author": {"login": "someone"},
        "headRefName": "feat/11-thing",
        "files": [{"path": "Cargo.lock"}],
    },
]


class MainTest(TempRoots):
    def survey(self, argv, stdout=None, root=None, *, exit_=0, stderr=""):
        """Run main against a fake gh; returns (lines, calls)."""
        root = self.temp_root() if root is None else root
        lines: list[str] = []
        responses = {("pr", "list"): json.dumps(PULLS) if stdout is None else stdout}
        with FakeGh(responses, exits={("pr", "list"): exit_},
                    stderrs={("pr", "list"): stderr}) as fake:
            with patch.dict(os.environ, fake.env, clear=False):
                try:
                    sp.main(argv, root=root, log=lines.append)
                finally:
                    self.calls = fake.calls
        return lines

    def caught(self, *args, **kwargs) -> sp.ScriptError:
        with self.assertRaises(sp.ScriptError) as ctx:
            self.survey(*args, **kwargs)
        return ctx.exception

    def test_lists_only_bot_prs_in_number_order_with_the_tauri_check(self):
        root = self.temp_root({"Cargo.lock": CARGO_LOCK, "package.json": PACKAGE_JSON})
        text = "\n".join(self.survey([], root=root))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][:3], ["pr", "list", "--state"])
        self.assertIn("2 open bot PR(s)", text)
        self.assertLess(text.index("#10"), text.index("#12"))
        self.assertNotIn("#11 ", text)
        self.assertIn("checks=PENDING", text)
        self.assertIn("tauri 2.11.6 -> 2.12.0", text)
        self.assertIn("tauri: MISMATCH", text)
        self.assertIn("@tauri-apps/api ~2.11.1", text)

    def test_sets_a_tauri_major_apart_from_the_batch(self):
        major = [{**PULLS[0], "number": 14, "title": "deps: bump tauri from 2.12.0 to 3.0.0",
                  "body": "", "headRefName": "dependabot/cargo/tauri-3.0.0"}]
        lines = self.survey([], json.dumps(major))
        self.assertIn("Tauri major (a migration issue, never part of a batch):", lines)
        self.assertIn("  #14 tauri 2.12.0 -> 3.0.0", lines)

    def test_prints_json_with_the_json_flag(self):
        parsed = json.loads("\n".join(self.survey(["--json"])))
        rows = [{k: r[k] for k in ("number", "ecosystem", "level", "checks")} for r in parsed["rows"]]
        self.assertEqual(rows, [
            {"number": 10, "ecosystem": "github-actions", "level": "minor", "checks": "PENDING"},
            {"number": 12, "ecosystem": "cargo", "level": "minor", "checks": "PASSING"},
        ])
        self.assertEqual(parsed["contested"], {})
        self.assertEqual(len(parsed["tauri"]["pairs"]), 1)
        self.assertEqual(parsed["tauri"]["pairs"][0]["key"], "tauri")
        self.assertIs(parsed["tauri"]["pairs"][0]["split"], False)

    def test_names_the_prs_a_split_tauri_pair_spans(self):
        pair = [
            {**PULLS[0], "number": 16, "title": "deps: bump the npm-tauri group with 2 updates",
             "body": "\n".join(["Updates `@tauri-apps/api` from 2.11.1 to 2.12.0",
                                "Updates `@tauri-apps/cli` from 2.11.5 to 2.12.1"]),
             "headRefName": "dependabot/npm_and_yarn/npm-tauri-1",
             "files": [{"path": "pnpm-lock.yaml"}]},
            {**PULLS[0], "number": 15, "title": "deps: bump the cargo-tauri group with 1 update",
             "headRefName": "dependabot/cargo/cargo-tauri-1"},
        ]
        root = self.temp_root({"Cargo.lock": CARGO_LOCK, "package.json": PACKAGE_JSON})
        self.assertIn("tauri: aligned, split across #15 #16",
                      "\n".join(self.survey([], json.dumps(pair), root)))

    def test_prints_an_aligned_pair_that_is_not_split_without_the_split_marker(self):
        both = [{**PULLS[0], "number": 18,
                 "body": "\n".join(["Updates `tauri` from 2.11.6 to 2.11.7",
                                    "Updates `@tauri-apps/api` from 2.11.1 to 2.11.2"])}]
        root = self.temp_root({"Cargo.lock": CARGO_LOCK, "package.json": PACKAGE_JSON})
        text = "\n".join(self.survey([], json.dumps(both), root))
        self.assertIn("tauri: aligned -- ", text)
        self.assertNotIn(", split across", text)

    def test_marks_each_major_bump_inside_a_grouped_pr(self):
        group = [{**PULLS[0], "number": 17,
                  "title": "deps: bump the cargo-minor-and-patch group with 2 updates",
                  "body": "\n".join(["Updates `toml` from 0.8.2 to 0.9.0",
                                     "Updates `serde` from 1.0.228 to 1.0.229"])}]
        text = "\n".join(self.survey([], json.dumps(group)))
        self.assertIn("toml 0.8.2 -> 0.9.0 (major)", text)
        self.assertIn("serde 1.0.228 -> 1.0.229", text)
        self.assertNotIn("serde 1.0.228 -> 1.0.229 (major)", text)
        self.assertRegex(text, r"#17\s+\[cargo\s*\] major")

    def test_names_the_files_two_bot_prs_contest(self):
        both = [PULLS[0], {**PULLS[0], "number": 13, "headRefName": "dependabot/cargo/serde-1.0.229"}]
        self.assertIn("  Cargo.lock: #12, #13", self.survey([], json.dumps(both)))

    def test_says_so_when_there_is_no_open_bot_pr(self):
        self.assertEqual(self.survey([], "[]"), ["No open Dependabot or Renovate pull requests."])

    def test_fails_with_err_survey_usage_on_an_unknown_argument(self):
        self.assertEqual(self.caught(["--merge"]).code, "ERR_SURVEY_USAGE")
        self.assertEqual(len(self.calls), 0)

    def test_fails_with_err_survey_gh_when_gh_cannot_start(self):
        empty = self.temp_root()
        with patch.dict(os.environ, {"PATH": str(empty)}, clear=False):
            with self.assertRaises(sp.ScriptError) as ctx:
                sp.main([], root=empty, log=lambda line: None)
        self.assertEqual(ctx.exception.code, "ERR_SURVEY_GH")
        self.assertIn("ENOENT", ctx.exception.actual)

    def test_fails_with_err_survey_gh_when_gh_fails_or_prints_something_other_than_a_list(self):
        self.assertIn("HTTP 401", self.caught([], "", exit_=1, stderr="HTTP 401").actual)
        self.assertEqual(self.caught([], '{"not":"a list"}').code, "ERR_SURVEY_GH")
        self.assertEqual(self.caught([], "<html>").code, "ERR_SURVEY_GH")

    def test_cli_prints_the_four_line_report_and_exits_1(self):
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(sp.cli(["--merge"]), 1)
        lines = err.getvalue().splitlines()
        self.assertEqual(lines[0], "ERR_SURVEY_USAGE: unknown argument: --merge")
        self.assertEqual([ln.split(":")[0] for ln in lines[1:]], ["Expected", "Actual", "Next"])
        self.assertIn("python3 .agents/skills/merging-dependency-prs/scripts/survey_prs.py", lines[3])

    def test_runs_as_a_script(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--bogus"], capture_output=True,
                                text=True, check=False,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stderr.startswith("ERR_SURVEY_USAGE: "))


# ---------------------------------------------------------------- the survey logic

class ParseBumpsTest(unittest.TestCase):
    def test_reads_a_single_dependabot_bump_from_the_title(self):
        self.assertEqual(sp.parse_bumps("deps: bump serde from 1.0.228 to 1.0.229", ""),
                         [b("serde", "1.0.228", "1.0.229")])

    def test_reads_every_update_a_grouped_body_lists_not_the_group_title(self):
        body = "\n".join([
            "Bumps the cargo-minor-and-patch group with 2 updates: [tauri](https://example.invalid) and [serde](https://example.invalid).",
            "",
            "Updates `tauri` from 2.11.6 to 2.12.0",
            "- [Release notes](https://example.invalid)",
            "",
            "Updates `serde` from 1.0.228 to 1.0.229",
        ])
        self.assertEqual(
            sp.parse_bumps("deps: bump the cargo-minor-and-patch group with 2 updates", body),
            [b("tauri", "2.11.6", "2.12.0"), b("serde", "1.0.228", "1.0.229")])

    def test_reads_a_grouped_body_with_crlf_line_endings(self):
        body = "\r\n".join([
            "Updates `tauri` from 2.11.6 to 2.12.0",
            "- [Release notes](https://example.invalid)",
            "Updates `serde` from 1.0.228 to 1.0.229.",
            "",
        ])
        self.assertEqual(
            sp.parse_bumps("deps: bump the cargo-minor-and-patch group with 2 updates", body),
            [b("tauri", "2.11.6", "2.12.0"), b("serde", "1.0.228", "1.0.229")])

    def test_reads_a_renovate_table_row_with_either_arrow(self):
        body = "\n".join([
            "| Package | Update | Change |",
            "|---|---|---|",
            "| [just](https://example.invalid) | minor | `1.58.0` -> `1.59.0` |",
            "| rust | patch | `1.98.0` → `1.98.1` |",
        ])
        self.assertEqual(sp.parse_bumps("deps: update just to v1.59.0", body),
                         [b("just", "1.58.0", "1.59.0"), b("rust", "1.98.0", "1.98.1")])

    def test_returns_nothing_for_a_title_and_body_that_name_no_bump(self):
        self.assertEqual(sp.parse_bumps("deps: refresh the lockfile", "No versions here."), [])


class SemverLevelTest(unittest.TestCase):
    def test_classifies_major_minor_and_patch_moves(self):
        self.assertEqual(sp.semver_level("1.2.3", "2.0.0"), "major")
        self.assertEqual(sp.semver_level("1.2.3", "1.3.0"), "minor")
        self.assertEqual(sp.semver_level("1.2.3", "1.2.4"), "patch")
        self.assertEqual(sp.semver_level("v4.1.0", "v4.2.0"), "minor")
        self.assertEqual(sp.semver_level("^10.6", "^10.7"), "minor")

    def test_treats_a_move_below_1_0_0_that_caret_ranges_call_incompatible_as_major(self):
        self.assertEqual(sp.semver_level("0.2.5", "0.3.0"), "major")
        self.assertEqual(sp.semver_level("0.0.3", "0.0.4"), "major")
        self.assertEqual(sp.semver_level("0.2.5", "0.2.6"), "patch")
        self.assertEqual(sp.semver_level("1.2.3", "1.2.3"), "patch")

    def test_is_unknown_when_either_side_is_missing_or_unparsable(self):
        self.assertEqual(sp.semver_level(None, "1.0.0"), "unknown")
        self.assertEqual(sp.semver_level("latest", "1.0.0"), "unknown")


class HighestLevelTest(unittest.TestCase):
    def test_takes_the_highest_known_level_and_ignores_unknown_ones(self):
        self.assertEqual(sp.highest_level(["patch", "unknown", "minor"]), "minor")
        self.assertEqual(sp.highest_level(["minor", "major"]), "major")
        self.assertEqual(sp.highest_level(["unknown"]), "unknown")
        self.assertEqual(sp.highest_level([]), "unknown")


class CheckSummaryTest(unittest.TestCase):
    def test_is_none_when_no_check_reported(self):
        self.assertEqual(sp.check_summary([]), {"state": "NONE", "failing": []})

    def test_passes_only_on_success_neutral_and_skipped(self):
        rollup = [
            {"name": "Rust Core", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"name": "Template Bootstrap Smoke", "status": "COMPLETED", "conclusion": "SKIPPED"},
            {"context": "osv", "state": "SUCCESS"},
            {"name": "Scorecard", "status": "COMPLETED", "conclusion": "NEUTRAL"},
        ]
        self.assertEqual(sp.check_summary(rollup), {"state": "PASSING", "failing": []})

    def test_fails_closed_on_a_failure_an_unrecognised_conclusion_or_none_at_all(self):
        rollup = [
            {"name": "Frontend", "status": "COMPLETED", "conclusion": "FAILURE"},
            {"name": "macOS Build & Smoke", "status": "COMPLETED", "conclusion": "STARTUP_FAILURE"},
            {"name": "Mystery"},
            {"name": "Rust Core", "status": "COMPLETED", "conclusion": "SUCCESS"},
        ]
        self.assertEqual(sp.check_summary(rollup), {
            "state": "FAILING",
            "failing": ["Frontend=FAILURE", "macOS Build & Smoke=STARTUP_FAILURE", "Mystery=UNKNOWN"],
        })

    def test_is_pending_while_a_check_runs_unless_another_already_failed(self):
        running = {"name": "macOS Build & Smoke", "status": "IN_PROGRESS"}
        queued = {"context": "osv", "state": "PENDING"}
        self.assertEqual(sp.check_summary([running, queued])["state"], "PENDING")
        self.assertEqual(
            sp.check_summary([running, {"name": "Frontend", "conclusion": "TIMED_OUT"}])["state"],
            "FAILING")

    def test_ignores_rollup_entries_that_are_not_objects(self):
        self.assertEqual(sp.check_summary([None, "x"]),
                         {"state": "FAILING", "failing": ["?=UNKNOWN", "?=UNKNOWN"]})


class EcosystemOfTest(unittest.TestCase):
    def test_reads_dependabots_ecosystem_from_its_branch_name(self):
        self.assertEqual(sp.ecosystem_of("dependabot/cargo/cargo-minor-and-patch-a1b2", []), "cargo")
        self.assertEqual(sp.ecosystem_of("dependabot/npm_and_yarn/vite-8.4.0", []), "npm")
        self.assertEqual(sp.ecosystem_of("dependabot/github_actions/actions/checkout-7.1.0", []),
                         "github-actions")

    def test_reads_renovates_manager_from_the_file_it_edits(self):
        self.assertEqual(sp.ecosystem_of("renovate/just-1.x", ["mise.toml"]), "mise")
        self.assertEqual(sp.ecosystem_of("renovate/rust-1.x", ["rust-toolchain.toml"]), "rust-toolchain")

    def test_falls_back_to_the_manifests_a_branch_touches_then_to_other(self):
        self.assertEqual(sp.ecosystem_of("somebot/x", ["Cargo.lock"]), "cargo")
        self.assertEqual(sp.ecosystem_of("somebot/x", ["pnpm-lock.yaml"]), "npm")
        self.assertEqual(sp.ecosystem_of("somebot/x", [".github/workflows/ci.yml"]), "github-actions")
        self.assertEqual(sp.ecosystem_of("somebot/x", ["README.md"]), "other")


def row(number, **overrides):
    return {
        "number": number,
        "title": f"deps: bump something {number}",
        "url": "",
        "branch": "",
        "author": "app/dependabot",
        "ecosystem": "cargo",
        "bumps": [],
        "level": "unknown",
        "checks": "PASSING",
        "failingChecks": [],
        "mergeState": "CLEAN",
        "files": [],
        **overrides,
    }


class ContestedFilesTest(unittest.TestCase):
    def test_maps_each_file_two_or_more_prs_touch_to_those_prs_and_nothing_else(self):
        rows = [row(1, files=["Cargo.lock", "Cargo.toml"]), row(2, files=["Cargo.lock"]),
                row(3, files=[".github/workflows/ci.yml"])]
        self.assertEqual(list(sp.contested_files(rows).items()), [("Cargo.lock", [1, 2])])


CURRENT = {"tauri": "2.11.6", "@tauri-apps/api": "2.11.1", "@tauri-apps/cli": "2.11.5"}


class TauriReportTest(unittest.TestCase):
    def test_says_the_family_stays_aligned_when_both_sides_reach_the_same_minor(self):
        rows = [
            row(11, bumps=[b("tauri", "2.11.6", "2.12.0")]),
            row(12, ecosystem="npm", bumps=[b("@tauri-apps/api", "2.11.1", "2.12.0"),
                                            b("@tauri-apps/cli", "2.11.5", "2.12.1")]),
        ]
        report = sp.tauri_report(rows, CURRENT)
        self.assertEqual(report["majors"], [])
        self.assertEqual(report["pairs"], [{
            "key": "tauri", "prs": [11, 12], "aligned": True, "split": True,
            "versions": [
                {"name": "tauri", "version": "2.12.0", "pr": 11},
                {"name": "@tauri-apps/api", "version": "2.12.0", "pr": 12},
                {"name": "@tauri-apps/cli", "version": "2.12.1", "pr": 12},
            ],
        }])

    def test_flags_a_batch_that_would_move_the_crate_without_the_npm_packages(self):
        pair = sp.tauri_report([row(11, bumps=[b("tauri", "2.11.6", "2.12.0")])], CURRENT)["pairs"][0]
        self.assertIs(pair["aligned"], False)
        self.assertIs(pair["split"], False)
        self.assertIn({"name": "@tauri-apps/api", "version": "2.11.1"}, pair["versions"])

    def test_pairs_a_plugin_crate_with_its_npm_package_and_leaves_untouched_pairs_out(self):
        with_plugin = {**CURRENT, "tauri-plugin-log": "2.10.0", "@tauri-apps/plugin-log": "2.10.0"}
        rows = [row(20, ecosystem="npm", bumps=[b("@tauri-apps/plugin-log", "2.10.0", "2.11.0")])]
        self.assertEqual(sp.tauri_report(rows, with_plugin)["pairs"], [{
            "key": "plugin-log", "prs": [20], "aligned": False, "split": False,
            "versions": [
                {"name": "tauri-plugin-log", "version": "2.10.0"},
                {"name": "@tauri-apps/plugin-log", "version": "2.11.0", "pr": 20},
            ],
        }])

    def test_holds_a_plugin_pair_to_one_exact_version_not_one_minor(self):
        with_plugin = {**CURRENT, "tauri-plugin-log": "2.10.0", "@tauri-apps/plugin-log": "~2.10.0"}

        def bump_row(number, name, to):
            return row(number, bumps=[b(name, "2.10.0", to)])

        patch_apart = [bump_row(21, "tauri-plugin-log", "2.10.1")]
        self.assertIs(sp.tauri_report(patch_apart, with_plugin)["pairs"][0]["aligned"], False)
        self.assertIs(sp.tauri_report(patch_apart, with_plugin)["pairs"][0]["split"], False)
        together = [bump_row(21, "tauri-plugin-log", "2.10.1"),
                    bump_row(22, "@tauri-apps/plugin-log", "2.10.1")]
        self.assertIs(sp.tauri_report(together, with_plugin)["pairs"][0]["aligned"], True)
        self.assertIs(sp.tauri_report(together, with_plugin)["pairs"][0]["split"], True)

    def test_does_not_call_a_pair_split_when_each_pr_keeps_it_within_the_current_minor(self):
        rows = [row(11, bumps=[b("tauri", "2.11.6", "2.11.7")]),
                row(12, ecosystem="npm", bumps=[b("@tauri-apps/api", "2.11.1", "2.11.2")])]
        pair = sp.tauri_report(rows, CURRENT)["pairs"][0]
        self.assertEqual((pair["aligned"], pair["split"]), (True, False))

    def test_calls_a_pair_split_when_only_one_of_its_prs_breaks_it_alone(self):
        rows = [
            row(11, bumps=[b("tauri", "2.11.6", "2.12.0")]),
            row(12, ecosystem="npm", bumps=[b("@tauri-apps/api", "2.11.1", "2.11.2")]),
            row(13, ecosystem="npm", bumps=[b("@tauri-apps/api", "2.11.2", "2.12.0"),
                                            b("@tauri-apps/cli", "2.11.5", "2.12.1")]),
        ]
        pair = sp.tauri_report(rows, CURRENT)["pairs"][0]
        self.assertEqual((pair["prs"], pair["aligned"], pair["split"]), ([11, 12, 13], True, True))

    def test_does_not_call_a_pair_split_when_one_pr_moves_both_sides(self):
        rows = [row(11, bumps=[b("tauri", "2.11.6", "2.12.0"), b("@tauri-apps/api", "2.11.1", "2.12.0"),
                               b("@tauri-apps/cli", "2.11.5", "2.12.1")])]
        pair = sp.tauri_report(rows, CURRENT)["pairs"][0]
        self.assertEqual((pair["aligned"], pair["split"]), (True, False))

    def test_lists_a_tauri_major_separately_whatever_else_moves(self):
        rows = [row(30, bumps=[b("tauri-build", "2.7.0", "3.0.0")]),
                row(31, bumps=[b("serde", "1.0.0", "2.0.0")])]
        self.assertEqual(sp.tauri_report(rows, CURRENT)["majors"],
                         [{"pr": 30, "name": "tauri-build", "from": "2.7.0", "to": "3.0.0"}])


class CurrentTauriVersionsTest(TempRoots):
    # Reading Cargo.lock needs tomllib; on Python 3.9-3.10 the fallback test below runs.
    @unittest.skipIf(sp.tomllib is None, "Cargo.lock needs tomllib (Python 3.11+)")
    def test_reads_the_tauri_family_from_cargo_lock_and_package_json(self):
        versions = sp.current_tauri_versions(
            self.temp_root({"Cargo.lock": CARGO_LOCK, "package.json": PACKAGE_JSON}))
        self.assertEqual(list(versions.items()), [
            ("tauri", "2.11.6"),
            ("tauri-plugin-log", "2.10.0"),
            ("@tauri-apps/api", "~2.11.1"),
            ("@tauri-apps/cli", "~2.11.5"),
        ])

    def test_skips_the_cargo_lock_baseline_with_a_notice_when_python_has_no_tomllib(self):
        root = self.temp_root({"Cargo.lock": CARGO_LOCK, "package.json": PACKAGE_JSON})
        err = io.StringIO()
        with patch.object(sp, "tomllib", None), redirect_stderr(err):
            versions = sp.current_tauri_versions(root)
        self.assertEqual(list(versions.items()), [
            ("@tauri-apps/api", "~2.11.1"),
            ("@tauri-apps/cli", "~2.11.5"),
        ])
        self.assertIn("Python 3.11+ (tomllib) is needed to read Cargo.lock", err.getvalue())

    def test_says_nothing_without_tomllib_when_there_is_no_cargo_lock(self):
        err = io.StringIO()
        with patch.object(sp, "tomllib", None), redirect_stderr(err):
            self.assertEqual(len(sp.current_tauri_versions(self.temp_root())), 0)
        self.assertEqual(err.getvalue(), "")

    def test_is_empty_when_neither_file_exists_or_parses(self):
        self.assertEqual(len(sp.current_tauri_versions(self.temp_root())), 0)
        self.assertEqual(len(sp.current_tauri_versions(
            self.temp_root({"Cargo.lock": "not = [toml", "package.json": "{"}))), 0)


COLLECT_PULLS = [
    {
        "number": 12,
        "title": "deps: bump the cargo-minor-and-patch group with 2 updates",
        "body": "Updates `tauri` from 2.11.6 to 2.12.0\nUpdates `toml` from 0.8.2 to 0.9.0",
        "author": {"login": "app/dependabot"},
        "headRefName": "dependabot/cargo/cargo-minor-and-patch-1",
        "mergeStateStatus": "CLEAN",
        "statusCheckRollup": [{"name": "Rust Core", "status": "COMPLETED", "conclusion": "FAILURE"}],
        "files": [{"path": "Cargo.lock"}, {"path": "Cargo.toml"}],
        "url": "https://example.invalid/pull/12",
    },
    {
        "number": 7,
        "title": "deps: update just to v1.59.0",
        "body": "| [just](https://example.invalid) | minor | `1.58.0` -> `1.59.0` |",
        "author": {"login": "renovate[bot]"},
        "headRefName": "renovate/just-1.x",
        "files": [{"path": "mise.toml"}],
    },
    {"number": 9, "title": "feat: a human's pull request", "author": {"login": "someone"}},
]


class CollectTest(unittest.TestCase):
    def test_keeps_only_bot_prs_in_number_order_with_every_field_read(self):
        self.assertEqual(sp.collect(COLLECT_PULLS), [
            {
                "number": 7, "title": "deps: update just to v1.59.0", "url": "",
                "branch": "renovate/just-1.x", "author": "renovate[bot]", "ecosystem": "mise",
                "bumps": [b("just", "1.58.0", "1.59.0")], "level": "minor", "checks": "NONE",
                "failingChecks": [], "mergeState": "?", "files": ["mise.toml"],
            },
            {
                "number": 12,
                "title": "deps: bump the cargo-minor-and-patch group with 2 updates",
                "url": "https://example.invalid/pull/12",
                "branch": "dependabot/cargo/cargo-minor-and-patch-1",
                "author": "app/dependabot", "ecosystem": "cargo",
                "bumps": [b("tauri", "2.11.6", "2.12.0"), b("toml", "0.8.2", "0.9.0")],
                "level": "major", "checks": "FAILING", "failingChecks": ["Rust Core=FAILURE"],
                "mergeState": "CLEAN", "files": ["Cargo.lock", "Cargo.toml"],
            },
        ])

    def test_returns_nothing_for_an_empty_listing_or_one_with_no_bot_pr(self):
        self.assertEqual(sp.collect([]), [])
        self.assertEqual(sp.collect([{"number": 3, "author": {"login": "someone"}}]), [])


class FormatReportTest(unittest.TestCase):
    def test_prints_one_entry_per_row_then_contested_files_tauri_pairs_and_majors(self):
        rows = [
            row(15, title="deps: bump tauri", level="major", checks="FAILING",
                failingChecks=["Rust Core=FAILURE"],
                bumps=[b("tauri", "2.11.6", "3.0.0"), b("serde", "1.0.228", "1.0.229")],
                files=["Cargo.lock"]),
            row(16, ecosystem="npm", level="patch", files=["Cargo.lock"]),
        ]
        lines = sp.format_report(rows, {
            "pairs": [
                {"key": "tauri", "prs": [15, 16], "aligned": True, "split": True, "versions": [
                    {"name": "tauri", "version": "3.0.0", "pr": 15},
                    {"name": "@tauri-apps/api", "version": "~3.0.0", "pr": 16},
                    {"name": "@tauri-apps/cli", "version": "~3.0.1"},
                ]},
                {"key": "plugin-log", "prs": [16], "aligned": False, "split": False, "versions": []},
            ],
            "majors": [{"pr": 15, "name": "tauri", "from": "2.11.6", "to": "3.0.0"}],
        })
        self.assertEqual(lines, [
            "2 open bot PR(s)",
            "",
            "  #15   [cargo         ] major   checks=FAILING  merge=CLEAN",
            "        deps: bump tauri",
            "        tauri 2.11.6 -> 3.0.0 (major)",
            "        serde 1.0.228 -> 1.0.229",
            "        HELD: Rust Core=FAILURE",
            "        files: Cargo.lock",
            "",
            "  #16   [npm           ] patch   checks=PASSING  merge=CLEAN",
            "        deps: bump something 16",
            "        files: Cargo.lock",
            "",
            "Contested files (one combined branch):",
            "  Cargo.lock: #15, #16",
            "",
            "Tauri family (one branch; tauri on its packages' minor, a plugin on its package's version):",
            "  tauri: aligned, split across #15 #16 -- tauri 3.0.0 (#15), @tauri-apps/api ~3.0.0 (#16), @tauri-apps/cli ~3.0.1",
            "  plugin-log: MISMATCH -- ",
            "",
            "Tauri major (a migration issue, never part of a batch):",
            "  #15 tauri 2.11.6 -> 3.0.0",
        ])

    def test_prints_only_the_rows_marking_a_pr_that_touches_no_file(self):
        self.assertEqual(sp.format_report([row(4)], {"pairs": [], "majors": []}), [
            "1 open bot PR(s)",
            "",
            "  #4    [cargo         ] unknown checks=PASSING  merge=CLEAN",
            "        deps: bump something 4",
            "        files: (none)",
        ])


if __name__ == "__main__":
    unittest.main()
