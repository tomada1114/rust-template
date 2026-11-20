#!/usr/bin/env python3
"""Tests for survey_prs.py. Stdlib-only (unittest).

Run from the repository root:
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
        -s .claude/skills/merging-dependency-prs/scripts/tests \
        -t .claude/skills/merging-dependency-prs/scripts/tests -p 'test_*.py'
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

class TempRoots(unittest.TestCase):
    def temp_root(self) -> Path:
        tmp = tempfile.TemporaryDirectory(prefix="survey-prs-")
        self.addCleanup(tmp.cleanup)
        return Path(tmp.name)


def b(name, from_, to):
    return {"name": name, "from": from_, "to": to}


# ---------------------------------------------------------------- the dispatcher

PULLS_PATH = "repos/{owner}/{repo}/pulls"
SHA = {10: "a" * 40, 12: "c" * 40}

# One element per open pull request, as the REST listing gives it.
PULLS = [
    {
        "number": 12,
        "title": "deps: bump the cargo-minor-and-patch group with 1 update",
        "body": "Updates `clap` from 4.6.0 to 4.7.0",
        "user": {"login": "dependabot[bot]"},
        "head": {"ref": "dependabot/cargo/cargo-minor-and-patch-1", "sha": SHA[12]},
        "html_url": "https://example.invalid/pull/12",
    },
    {
        "number": 10,
        "title": "ci: bump actions/checkout from 7.0.1 to 7.1.0",
        "body": None,
        "user": {"login": "dependabot[bot]"},
        "head": {"ref": "dependabot/github_actions/actions/checkout-7.1.0", "sha": SHA[10]},
        "html_url": "https://example.invalid/pull/10",
    },
    {
        "number": 11,
        "title": "feat: a human's pull request",
        "body": "",
        "user": {"login": "someone"},
        "head": {"ref": "feat/11-thing", "sha": "b" * 40},
        "html_url": "https://example.invalid/pull/11",
    },
]

# What the reads of one pull request answer, by number: its merge state, its files (one
# array per page, as the script asks for them), and its head's check runs and statuses.
DETAILS = {
    12: {
        "mergeable_state": "clean",
        "files": ["Cargo.lock"],
        "check_runs": [{"name": "Rust Core", "status": "completed", "conclusion": "success"}],
        "statuses": [],
    },
    10: {
        "mergeable_state": "behind",
        "files": [".github/workflows/ci.yml"],
        "check_runs": [{"name": "Repo Lint & Harness", "status": "in_progress", "conclusion": None}],
        "statuses": [],
    },
}


def stream(values) -> str:
    """Values as `gh api --jq` prints them: one JSON value per line."""
    return "".join(json.dumps(value) + "\n" for value in values)


def responses(pulls, details):
    """The fake gh's routing table for a listing and each bot PR's reads."""
    table = {("api", f"{PULLS_PATH}?state=open&per_page=100"): stream(pulls)}
    for pull in pulls:
        detail = details.get(pull["number"])
        if detail is None:
            continue
        number, sha = pull["number"], pull["head"]["sha"]
        table.update({
            ("api", f"{PULLS_PATH}/{number}"):
                stream([{"mergeable_state": detail["mergeable_state"]}]),
            ("api", f"{PULLS_PATH}/{number}/files?per_page=100"): stream([detail["files"]]),
            ("api", f"repos/{{owner}}/{{repo}}/commits/{sha}/check-runs?per_page=100"):
                stream(detail["check_runs"]),
            ("api", f"repos/{{owner}}/{{repo}}/commits/{sha}/status?per_page=100"):
                stream(detail["statuses"]),
        })
    return table


def variant(number, **overrides):
    """PULLS[0] under another number, with its reads."""
    pull = {**PULLS[0], "number": number, **overrides}
    return [pull], {number: DETAILS[12]}


class MainTest(TempRoots):
    def survey(self, argv, pulls=PULLS, details=DETAILS, *, table=None, exits=None,
               stderrs=None, sequences=None):
        """Run main against a fake gh; returns the lines it logged."""
        lines: list[str] = []
        self.slept: list[float] = []
        table = responses(pulls, details) if table is None else table
        with FakeGh(table, exits=exits, stderrs=stderrs, sequences=sequences) as fake:
            with patch.dict(os.environ, fake.env, clear=False):
                try:
                    sp.main(argv, root=self.temp_root(), log=lines.append,
                            sleep=self.slept.append)
                finally:
                    self.calls = fake.calls
        return lines

    def caught(self, *args, **kwargs) -> sp.ScriptError:
        with self.assertRaises(sp.ScriptError) as ctx:
            self.survey(*args, **kwargs)
        return ctx.exception

    def paths(self) -> list[str]:
        return [call[1] for call in self.calls]

    def test_lists_only_bot_prs_in_number_order(self):
        text = "\n".join(self.survey([]))
        self.assertIn("2 open bot PR(s)", text)
        self.assertLess(text.index("#10"), text.index("#12"))
        self.assertNotIn("#11 ", text)
        self.assertIn("checks=PENDING  merge=BEHIND", text)
        self.assertIn("checks=PASSING  merge=CLEAN", text)
        self.assertIn("clap 4.6.0 -> 4.7.0", text)
        self.assertNotIn("(major)", text)

    def test_lists_open_prs_through_the_rest_api(self):
        self.survey([])
        self.assertEqual(self.calls[0][:2], ["api", "repos/{owner}/{repo}/pulls?state=open&per_page=100"])
        self.assertEqual(sorted(self.paths()[1:]), sorted([
            f"{PULLS_PATH}/{number}{suffix}" for number in (10, 12)
            for suffix in ("", "/files?per_page=100")
        ] + [
            f"repos/{{owner}}/{{repo}}/commits/{SHA[number]}/{what}?per_page=100"
            for number in (10, 12) for what in ("check-runs", "status")
        ]))

    def test_only_reads_and_never_a_human_pr(self):
        self.survey([])
        for call in self.calls:
            self.assertEqual(call[0], "api")
            self.assertEqual(call[2], "--jq")
            # Any of these would turn `gh api` from a GET into a write.
            self.assertFalse({"-X", "--method", "-f", "-F", "--field", "--raw-field",
                              "--input"} & set(call), call)
            self.assertNotIn("/11", call[1])

    def test_folds_a_commit_status_into_the_check_verdict(self):
        pulls, details = variant(18)
        details[18] = {**DETAILS[12], "statuses": [{"context": "osv", "state": "failure"}]}
        text = "\n".join(self.survey([], pulls, details))
        self.assertIn("checks=FAILING", text)
        self.assertIn("HELD: osv=FAILURE", text)

    def test_reads_every_page_of_a_prs_files(self):
        pulls, details = variant(20)
        table = responses(pulls, details)
        table[("api", f"{PULLS_PATH}/20/files?per_page=100")] = stream([["Cargo.lock"], ["Cargo.toml"]])
        self.assertIn("files: Cargo.lock, Cargo.toml", "\n".join(self.survey([], table=table)))

    def test_reads_a_merge_state_github_is_still_computing_again(self):
        pulls, details = variant(19)
        one = ("api", f"{PULLS_PATH}/19")
        unknown, clean = (stream([{"mergeable_state": state}]) for state in ("unknown", "clean"))
        text = "\n".join(self.survey([], pulls, details, sequences={one: [unknown, clean]}))
        self.assertIn("merge=CLEAN", text)
        self.assertEqual(self.slept, [2])
        self.assertEqual(self.paths().count(one[1]), 2)

    def test_shows_a_merge_state_github_never_computed_as_unknown(self):
        pulls, details = variant(19)
        details[19] = {**DETAILS[12], "mergeable_state": "unknown"}
        self.assertIn("merge=UNKNOWN", "\n".join(self.survey([], pulls, details)))
        self.assertEqual(self.slept, [2, 2])
        table = responses(pulls, details)
        table[("api", f"{PULLS_PATH}/19")] = stream([{"mergeable_state": None}])
        self.assertIn("merge=?", "\n".join(self.survey([], table=table)))

    def test_marks_a_lone_major_pr_as_major(self):
        pulls, details = variant(14, title="deps: bump clap from 4.7.0 to 5.0.0", body="")
        text = "\n".join(self.survey([], pulls, details))
        self.assertRegex(text, r"#14\s+\[cargo\s*\] major")
        self.assertIn("clap 4.7.0 -> 5.0.0 (major)", text)

    def test_prints_json_with_the_json_flag(self):
        parsed = json.loads("\n".join(self.survey(["--json"])))
        rows = [{k: r[k] for k in ("number", "ecosystem", "level", "checks")} for r in parsed["rows"]]
        self.assertEqual(rows, [
            {"number": 10, "ecosystem": "github-actions", "level": "minor", "checks": "PENDING"},
            {"number": 12, "ecosystem": "cargo", "level": "minor", "checks": "PASSING"},
        ])
        self.assertEqual(parsed["contested"], {})
        self.assertEqual(sorted(parsed), ["contested", "rows"])

    def test_marks_a_0x_minor_inside_a_grouped_pr_as_major(self):
        pulls, details = variant(
            17, title="deps: bump the cargo-minor-and-patch group with 2 updates",
            body="\n".join(["Updates `ratatui` from 0.30.0 to 0.31.0",
                            "Updates `serde` from 1.0.228 to 1.0.229"]))
        text = "\n".join(self.survey([], pulls, details))
        self.assertIn("ratatui 0.30.0 -> 0.31.0 (major)", text)
        self.assertIn("serde 1.0.228 -> 1.0.229", text)
        self.assertNotIn("serde 1.0.228 -> 1.0.229 (major)", text)
        self.assertRegex(text, r"#17\s+\[cargo\s*\] major")

    def test_names_the_files_two_bot_prs_contest(self):
        both = [PULLS[0], {**PULLS[0], "number": 13}]
        details = {12: DETAILS[12], 13: DETAILS[12]}
        self.assertIn("  Cargo.lock: #12, #13", self.survey([], both, details))

    def test_says_so_when_there_is_no_open_bot_pr(self):
        self.assertEqual(self.survey([], [], {}), ["No open Dependabot or Renovate pull requests."])
        self.assertEqual(self.survey([], [PULLS[2]], {}),
                         ["No open Dependabot or Renovate pull requests."])
        self.assertEqual(len(self.calls), 1)

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
        listing = ("api", f"{PULLS_PATH}?state=open&per_page=100")
        refused = self.caught([], table={listing: ""}, exits={listing: 1},
                              stderrs={listing: "gh: Forbidden (HTTP 403)\nmore"})
        self.assertEqual(refused.code, "ERR_SURVEY_GH")
        self.assertEqual(refused.actual, "gh: Forbidden (HTTP 403)")
        self.assertIn("pulls?state=open", refused.summary)
        self.assertEqual(self.caught([], table={listing: '{"not":"a pull"}'}).code, "ERR_SURVEY_GH")
        self.assertEqual(self.caught([], table={listing: "<html>"}).code, "ERR_SURVEY_GH")

    def test_fails_with_err_survey_gh_when_a_read_of_one_pr_fails(self):
        for missing in (f"{PULLS_PATH}/12", f"{PULLS_PATH}/12/files?per_page=100",
                        f"repos/{{owner}}/{{repo}}/commits/{SHA[12]}/check-runs?per_page=100",
                        f"repos/{{owner}}/{{repo}}/commits/{SHA[12]}/status?per_page=100"):
            table = responses(PULLS, DETAILS)
            del table[("api", missing)]
            error = self.caught([], table=table)
            self.assertEqual(error.code, "ERR_SURVEY_GH", missing)
            self.assertIn(missing, error.summary)

    def test_fails_with_err_survey_gh_on_a_bot_pr_with_no_head_sha(self):
        pulls = [{**PULLS[0], "head": {"ref": "dependabot/cargo/x", "sha": None}}]
        error = self.caught([], pulls, {})
        self.assertEqual(error.code, "ERR_SURVEY_GH")
        self.assertEqual(len(self.calls), 1)

    def test_cli_prints_the_four_line_report_and_exits_1(self):
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(sp.cli(["--merge"]), 1)
        lines = err.getvalue().splitlines()
        self.assertEqual(lines[0], "ERR_SURVEY_USAGE: unknown argument: --merge")
        self.assertEqual([ln.split(":")[0] for ln in lines[1:]], ["Expected", "Actual", "Next"])
        self.assertIn("python3 .claude/skills/merging-dependency-prs/scripts/survey_prs.py", lines[3])

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
            "Bumps the cargo-minor-and-patch group with 2 updates: [clap](https://example.invalid) and [serde](https://example.invalid).",
            "",
            "Updates `clap` from 4.6.0 to 4.7.0",
            "- [Release notes](https://example.invalid)",
            "",
            "Updates `serde` from 1.0.228 to 1.0.229",
        ])
        self.assertEqual(
            sp.parse_bumps("deps: bump the cargo-minor-and-patch group with 2 updates", body),
            [b("clap", "4.6.0", "4.7.0"), b("serde", "1.0.228", "1.0.229")])

    def test_reads_a_grouped_body_with_crlf_line_endings(self):
        body = "\r\n".join([
            "Updates `clap` from 4.6.0 to 4.7.0",
            "- [Release notes](https://example.invalid)",
            "Updates `serde` from 1.0.228 to 1.0.229.",
            "",
        ])
        self.assertEqual(
            sp.parse_bumps("deps: bump the cargo-minor-and-patch group with 2 updates", body),
            [b("clap", "4.6.0", "4.7.0"), b("serde", "1.0.228", "1.0.229")])

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
            {"name": "Rust Core", "status": "completed", "conclusion": "success"},
            {"name": "Template Bootstrap Smoke", "status": "completed", "conclusion": "skipped"},
            {"context": "osv", "state": "success"},
            {"name": "Scorecard", "status": "completed", "conclusion": "neutral"},
        ]
        self.assertEqual(sp.check_summary(rollup), {"state": "PASSING", "failing": []})

    def test_fails_closed_on_a_failure_an_unrecognised_conclusion_or_none_at_all(self):
        rollup = [
            {"name": "Repo Lint & Harness", "status": "completed", "conclusion": "failure"},
            {"name": "macOS", "status": "completed", "conclusion": "startup_failure"},
            {"name": "Mystery"},
            {"name": "Rust Core", "status": "completed", "conclusion": "success"},
        ]
        self.assertEqual(sp.check_summary(rollup), {
            "state": "FAILING",
            "failing": ["Repo Lint & Harness=FAILURE", "macOS=STARTUP_FAILURE", "Mystery=UNKNOWN"],
        })

    def test_is_pending_while_a_check_runs_unless_another_already_failed(self):
        running = {"name": "macOS", "status": "in_progress", "conclusion": None}
        queued = {"context": "osv", "state": "pending"}
        self.assertEqual(sp.check_summary([running, queued])["state"], "PENDING")
        self.assertEqual(
            sp.check_summary([running, {"name": "Rust Core", "conclusion": "timed_out"}])["state"],
            "FAILING")

    def test_ignores_rollup_entries_that_are_not_objects(self):
        self.assertEqual(sp.check_summary([None, "x"]),
                         {"state": "FAILING", "failing": ["?=UNKNOWN", "?=UNKNOWN"]})


class EcosystemOfTest(unittest.TestCase):
    def test_reads_dependabots_ecosystem_from_its_branch_name(self):
        self.assertEqual(sp.ecosystem_of("dependabot/cargo/cargo-minor-and-patch-a1b2", []), "cargo")
        self.assertEqual(sp.ecosystem_of("dependabot/github_actions/actions/checkout-7.1.0", []),
                         "github-actions")

    def test_reads_renovates_manager_from_the_file_it_edits(self):
        self.assertEqual(sp.ecosystem_of("renovate/just-1.x", ["mise.toml"]), "mise")
        self.assertEqual(sp.ecosystem_of("renovate/rust-1.x", ["rust-toolchain.toml"]), "rust-toolchain")

    def test_falls_back_to_the_manifests_a_branch_touches_then_to_other(self):
        self.assertEqual(sp.ecosystem_of("somebot/x", ["Cargo.lock"]), "cargo")
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


COLLECT_PULLS = [
    {
        "number": 12,
        "title": "deps: bump the cargo-minor-and-patch group with 2 updates",
        "body": "Updates `clap` from 4.6.0 to 4.7.0\nUpdates `ratatui` from 0.30.0 to 0.31.0",
        "user": {"login": "dependabot[bot]"},
        "head": {"ref": "dependabot/cargo/cargo-minor-and-patch-1", "sha": "c" * 40},
        "mergeable_state": "clean",
        "check_runs": [{"name": "Rust Core", "status": "completed", "conclusion": "failure"}],
        "statuses": [{"context": "osv", "state": "success"}],
        "files": ["Cargo.lock", "Cargo.toml"],
        "html_url": "https://example.invalid/pull/12",
    },
    {
        "number": 7,
        "title": "deps: update just to v1.59.0",
        "body": "| [just](https://example.invalid) | minor | `1.58.0` -> `1.59.0` |",
        "user": {"login": "renovate[bot]"},
        "head": {"ref": "renovate/just-1.x"},
        "files": ["mise.toml"],
    },
    {"number": 9, "title": "feat: a human's pull request", "user": {"login": "someone"}},
]


class CollectTest(unittest.TestCase):
    def test_keeps_only_bot_prs_in_number_order_with_every_field_read(self):
        self.assertEqual(sp.collect(COLLECT_PULLS), [
            {
                "number": 7, "title": "deps: update just to v1.59.0", "url": "",
                "branch": "renovate/just-1.x", "author": "app/renovate", "ecosystem": "mise",
                "bumps": [b("just", "1.58.0", "1.59.0")], "level": "minor", "checks": "NONE",
                "failingChecks": [], "mergeState": "?", "files": ["mise.toml"],
            },
            {
                "number": 12,
                "title": "deps: bump the cargo-minor-and-patch group with 2 updates",
                "url": "https://example.invalid/pull/12",
                "branch": "dependabot/cargo/cargo-minor-and-patch-1",
                "author": "app/dependabot", "ecosystem": "cargo",
                "bumps": [b("clap", "4.6.0", "4.7.0"), b("ratatui", "0.30.0", "0.31.0")],
                "level": "major", "checks": "FAILING", "failingChecks": ["Rust Core=FAILURE"],
                "mergeState": "CLEAN", "files": ["Cargo.lock", "Cargo.toml"],
            },
        ])

    def test_returns_nothing_for_an_empty_listing_or_one_with_no_bot_pr(self):
        self.assertEqual(sp.collect([]), [])
        self.assertEqual(sp.collect([{"number": 3, "user": {"login": "someone"}}]), [])


class FormatReportTest(unittest.TestCase):
    def test_prints_one_entry_per_row_then_the_contested_files(self):
        rows = [
            row(15, title="deps: bump clap", level="major", checks="FAILING",
                failingChecks=["Rust Core=FAILURE"],
                bumps=[b("clap", "4.7.0", "5.0.0"), b("serde", "1.0.228", "1.0.229")],
                files=["Cargo.lock"]),
            row(16, ecosystem="mise", level="patch", files=["Cargo.lock"]),
        ]
        self.assertEqual(sp.format_report(rows), [
            "2 open bot PR(s)",
            "",
            "  #15   [cargo         ] major   checks=FAILING  merge=CLEAN",
            "        deps: bump clap",
            "        clap 4.7.0 -> 5.0.0 (major)",
            "        serde 1.0.228 -> 1.0.229",
            "        HELD: Rust Core=FAILURE",
            "        files: Cargo.lock",
            "",
            "  #16   [mise          ] patch   checks=PASSING  merge=CLEAN",
            "        deps: bump something 16",
            "        files: Cargo.lock",
            "",
            "Contested files (one combined branch):",
            "  Cargo.lock: #15, #16",
        ])

    def test_prints_only_the_rows_marking_a_pr_that_touches_no_file(self):
        self.assertEqual(sp.format_report([row(4)]), [
            "1 open bot PR(s)",
            "",
            "  #4    [cargo         ] unknown checks=PASSING  merge=CLEAN",
            "        deps: bump something 4",
            "        files: (none)",
        ])


if __name__ == "__main__":
    unittest.main()
