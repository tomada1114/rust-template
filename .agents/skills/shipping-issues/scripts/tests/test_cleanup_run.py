#!/usr/bin/env python3
"""Tests for cleanup_run.sh. Stdlib-only (unittest).

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _fakegh import FakeGh

SCRIPT = Path(__file__).resolve().parent.parent / "cleanup_run.sh"


def git(repo, *args):
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        text=True,
        capture_output=True,
    )


def make_repo(path, *, origin=False):
    git(path, "init", "-q")
    git(path, "config", "user.email", "tests@example.invalid")
    git(path, "config", "user.name", "shipping-issues tests")
    (path / "README.md").write_text("fixture\n", encoding="utf-8")
    git(path, "add", "README.md")
    git(path, "commit", "-qm", "fixture")
    git(path, "branch", "-M", "main")
    if origin:
        git(path, "remote", "add", "origin", "https://example.invalid/acme/widgets.git")


def add_local_origin(repo, parent):
    origin = parent / "origin.git"
    git(parent, "init", "--bare", "-q", str(origin))
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")


def branch_tip(repo, name):
    """The commit `name` points at: the local branch, else origin's, else
    nothing — which is what a merged PR's headRefOid is compared against."""
    local = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{name}"],
        cwd=repo,
        text=True,
        capture_output=True,
    )
    if local.returncode == 0:
        return local.stdout.strip()
    remote = subprocess.run(
        ["git", "ls-remote", "origin", f"refs/heads/{name}"],
        cwd=repo,
        text=True,
        capture_output=True,
    )
    return remote.stdout.split("\t")[0].strip() if remote.returncode == 0 else ""


def with_merged_tips(repo, responses):
    """A merged-PR list written as bare branch names gets each name's current
    tip as its headRefOid — "this branch is exactly what merged". A line that
    already carries a TAB states its own headRefOid."""
    out = {}
    for prefix, stdout in responses.items():
        if prefix[:4] == ("pr", "list", "--state", "merged") and stdout:
            stdout = "\n".join(
                line
                if "\t" in line or not line
                else f"{line}\t{branch_tip(repo, line)}"
                for line in stdout.split("\n")
            )
        out[prefix] = stdout
    return out


def run_script(args, repo, responses, *, exits=None, stderrs=None, env=None):
    responses = with_merged_tips(repo, responses)
    with FakeGh(responses, exits=exits, stderrs=stderrs) as fake:
        proc = subprocess.run(
            ["bash", str(SCRIPT), *args],
            cwd=repo,
            env={**fake.env, **(env or {})},
            text=True,
            capture_output=True,
        )
        calls = list(fake.calls)
    return proc, calls


MERGED_LIST = (
    "pr",
    "list",
    "--state",
    "merged",
    "--limit",
    "5001",
    "--json",
    "headRefName,headRefOid",
    "-q",
    ".[] | [.headRefName, .headRefOid] | @tsv",
)
OPEN_LIST = (
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "5001",
    "--json",
    "headRefName",
    "-q",
    ".[].headRefName",
)


class CleanupRunTest(unittest.TestCase):
    def test_help_flag_prints_own_usage_and_never_calls_gh(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            for flag in ("-h", "--help"):
                with self.subTest(flag=flag):
                    proc, calls = run_script([flag], repo, {})

                    self.assertEqual(proc.returncode, 0)
                    self.assertIn(
                        "End-of-run cleanup for shipping-issues.", proc.stdout
                    )
                    self.assertIn("Usage: cleanup_run.sh", proc.stdout)
                    self.assertEqual(calls, [])

    def test_unknown_flag_is_usage_error(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            proc, calls = run_script(["--no-such-flag"], repo, {})

        self.assertEqual(proc.returncode, 2)
        self.assertIn("unknown flag: --no-such-flag", proc.stderr)
        self.assertEqual(calls, [])

    def test_more_merged_prs_than_the_cap_fails_loudly(self):
        capped = tuple("4" if a == "5001" else a for a in MERGED_LIST)
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            git(repo, "branch", "feat/1-merged")
            proc, calls = run_script(
                [],
                repo,
                {capped: "a\nb\nc\nfeat/1-merged", OPEN_LIST: ""},
                env={"CLEANUP_PR_LIMIT": "3"},
            )
            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertIn("more than 3 merged pull requests", proc.stderr)
        self.assertNotIn("cleanup: done", proc.stdout)
        self.assertIn("feat/1-merged", branches)

    def test_more_open_prs_than_the_cap_fails_loudly(self):
        capped_open = tuple("3" if a == "5001" else a for a in OPEN_LIST)
        capped_merged = tuple("3" if a == "5001" else a for a in MERGED_LIST)
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            git(repo, "branch", "feat/1-merged")
            proc, _ = run_script(
                [],
                repo,
                {capped_merged: "feat/1-merged", capped_open: "a\nb\nc"},
                env={"CLEANUP_PR_LIMIT": "2"},
            )
            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertIn("more than 2 open pull requests", proc.stderr)
        self.assertIn("feat/1-merged", branches)

    def test_merged_prs_exactly_at_the_cap_are_used(self):
        capped = tuple("3" if a == "5001" else a for a in MERGED_LIST)
        capped_open = tuple("3" if a == "5001" else a for a in OPEN_LIST)
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            git(repo, "branch", "feat/1-merged")
            proc, _ = run_script(
                [],
                repo,
                {capped: "a\nfeat/1-merged", capped_open: ""},
                env={"CLEANUP_PR_LIMIT": "2"},
            )
            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("feat/1-merged", branches)

    def test_a_failed_pr_list_aborts(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            git(repo, "branch", "feat/1-merged")
            proc, _ = run_script([], repo, {MERGED_LIST: ""}, exits={MERGED_LIST: 1})
            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("feat/1-merged", branches)

    def test_runs_when_origin_head_is_unset(self):
        """A repo with an origin remote but no origin/HEAD ref.

        `git clone` sets origin/HEAD; `git remote add` + fetch does not, so
        plenty of real repos lack it. Under `set -e` with `pipefail` the
        failing symbolic-ref used to take the whole command substitution's
        exit status with it and abort before printing a single line.
        """
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            add_local_origin(repo, Path(td))
            git(repo, "symbolic-ref", "-d", "refs/remotes/origin/HEAD")
            git(repo, "branch", "feat/1-merged")

            proc, calls = run_script(
                [], repo, {MERGED_LIST: "feat/1-merged", OPEN_LIST: ""}
            )

            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("cleanup: done\n", proc.stdout)
        self.assertNotIn("feat/1-merged", branches)

    def test_a_merged_branch_with_new_commits_is_kept(self):
        # The PR merged at one commit; the branch name has moved on since.
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            add_local_origin(repo, Path(td))
            git(repo, "branch", "feat/1-reused")
            merged_at = branch_tip(repo, "feat/1-reused")
            git(repo, "switch", "-q", "feat/1-reused")
            git(repo, "commit", "-q", "--allow-empty", "-m", "new work")
            git(repo, "switch", "-q", "main")

            proc, _ = run_script(
                [], repo, {MERGED_LIST: f"feat/1-reused\t{merged_at}", OPEN_LIST: ""}
            )
            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("feat/1-reused", branches)
        self.assertIn("SKIPPED (tip ", proc.stdout)
        self.assertIn("is not the merged PR's head", proc.stdout)
        self.assertNotIn("deleted local branch: feat/1-reused", proc.stdout)

    def test_a_remote_branch_whose_tip_moved_after_the_merge_is_kept(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            origin = td / "origin.git"
            git(td, "init", "--bare", "-q", str(origin))
            git(repo, "remote", "add", "origin", str(origin))
            git(repo, "branch", "feat/3-merged")
            merged_at = branch_tip(repo, "feat/3-merged")
            git(repo, "switch", "-q", "feat/3-merged")
            git(repo, "commit", "-q", "--allow-empty", "-m", "pushed after merge")
            git(repo, "switch", "-q", "main")
            git(repo, "push", "-q", "origin", "main", "feat/3-merged")
            git(repo, "branch", "-D", "feat/3-merged")
            git(
                repo,
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            )

            proc, _ = run_script(
                ["--remote"],
                repo,
                {MERGED_LIST: f"feat/3-merged\t{merged_at}", OPEN_LIST: ""},
            )
            remote_branches = git(origin, "branch", "--list").stdout

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("feat/3-merged", remote_branches)
        self.assertNotIn("deleted remote branch: origin/feat/3-merged", proc.stdout)

    def test_removes_merged_and_internal_branches_keeps_unmerged(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            add_local_origin(repo, Path(td))
            git(repo, "branch", "worktree-agent-one")
            git(repo, "branch", "feat/1-merged")
            git(repo, "branch", "feat/2-open")

            proc, calls = run_script(
                [],
                repo,
                {MERGED_LIST: "feat/1-merged", OPEN_LIST: "feat/2-open"},
            )

            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("cleanup: done\n", proc.stdout)
        self.assertIn("deleted local branch: feat/1-merged\n", proc.stdout)
        self.assertNotIn("worktree-agent-one", branches)
        self.assertNotIn("feat/1-merged", branches)
        self.assertIn("feat/2-open", branches)
        self.assertEqual(calls, [list(MERGED_LIST), list(OPEN_LIST)])

    def test_no_worktree_root_skips_worktree_pass(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            add_local_origin(repo, td)
            wtroot = td / "wtroot"
            wtroot.mkdir()
            git(repo, "worktree", "add", "-q", str(wtroot / "1"), "-b", "feat/1")

            proc, calls = run_script([], repo, {MERGED_LIST: "", OPEN_LIST: ""})

            worktrees = git(repo, "worktree", "list").stdout

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("worktree pass: skipped", proc.stdout)
        self.assertIn(str(wtroot / "1"), worktrees)

    def test_worktree_under_root_is_removed(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            add_local_origin(repo, td)
            wtroot = td / "wtroot"
            wtroot.mkdir()
            wt = wtroot / "1"
            git(repo, "worktree", "add", "-q", str(wt), "-b", "feat/1")

            proc, calls = run_script(
                ["--worktree-root", str(wtroot)],
                repo,
                {MERGED_LIST: "", OPEN_LIST: ""},
            )

            worktrees = git(repo, "worktree", "list").stdout

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(f"removed worktree: {wt}\n", proc.stdout)
        self.assertNotIn(str(wt), worktrees)

    def test_worktree_outside_root_is_never_touched(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            add_local_origin(repo, td)
            wtroot = td / "wtroot"
            wtroot.mkdir()
            outside = td / "outside"
            outside.mkdir()
            inside_wt = wtroot / "1"
            outside_wt = outside / "1"
            git(repo, "worktree", "add", "-q", str(inside_wt), "-b", "feat/inside")
            git(repo, "worktree", "add", "-q", str(outside_wt), "-b", "feat/outside")

            proc, calls = run_script(
                ["--worktree-root", str(wtroot)],
                repo,
                {MERGED_LIST: "", OPEN_LIST: ""},
            )

            worktrees = git(repo, "worktree", "list").stdout

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn(str(inside_wt), worktrees)
        self.assertIn(str(outside_wt), worktrees)

    def test_merged_only_keeps_unmerged_removes_merged(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            add_local_origin(repo, td)
            wtroot = td / "wtroot"
            wtroot.mkdir()
            merged_wt = wtroot / "merged"
            unmerged_wt = wtroot / "unmerged"
            git(repo, "worktree", "add", "-q", str(merged_wt), "-b", "feat/merged")
            git(repo, "worktree", "add", "-q", str(unmerged_wt), "-b", "feat/unmerged")

            proc, calls = run_script(
                ["--worktree-root", str(wtroot), "--merged-only"],
                repo,
                {MERGED_LIST: "feat/merged", OPEN_LIST: ""},
            )

            worktrees = git(repo, "worktree", "list").stdout

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(f"removed worktree: {merged_wt}\n", proc.stdout)
        self.assertIn(
            f"SKIPPED (no merged PR / open PR on feat/unmerged): {unmerged_wt}\n",
            proc.stdout,
        )
        self.assertNotIn(str(merged_wt), worktrees)
        self.assertIn(str(unmerged_wt), worktrees)

    def test_branch_flag_limits_worktree_pass_to_named_branches(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            add_local_origin(repo, td)
            wtroot = td / "wtroot"
            wtroot.mkdir()
            selected_wt = wtroot / "selected"
            other_wt = wtroot / "other"
            git(repo, "worktree", "add", "-q", str(selected_wt), "-b", "feat/selected")
            git(repo, "worktree", "add", "-q", str(other_wt), "-b", "feat/other")

            proc, _calls = run_script(
                [
                    "--worktree-root",
                    str(wtroot),
                    "--merged-only",
                    "--branch",
                    "feat/selected",
                ],
                repo,
                {MERGED_LIST: "feat/selected\nfeat/other", OPEN_LIST: ""},
            )

            worktrees = git(repo, "worktree", "list").stdout
            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn(str(selected_wt), worktrees)
        self.assertIn(str(other_wt), worktrees)
        self.assertIn("feat/selected", proc.stdout)
        self.assertIn("branch not selected with --branch", proc.stdout)
        self.assertNotIn("feat/selected", branches)
        self.assertIn("feat/other", branches)

    def test_dirty_worktree_skipped_then_removed_with_force(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            add_local_origin(repo, td)
            wtroot = td / "wtroot"
            wtroot.mkdir()
            wt = wtroot / "dirty"
            git(repo, "worktree", "add", "-q", str(wt), "-b", "feat/dirty")
            (wt / "scratch.txt").write_text("dirty\n", encoding="utf-8")

            proc, calls = run_script(
                ["--worktree-root", str(wtroot)],
                repo,
                {MERGED_LIST: "", OPEN_LIST: ""},
            )
            worktrees_after_default = git(repo, "worktree", "list").stdout

            proc2, calls2 = run_script(
                ["--worktree-root", str(wtroot), "--force"],
                repo,
                {MERGED_LIST: "", OPEN_LIST: ""},
            )
            worktrees_after_force = git(repo, "worktree", "list").stdout

        self.assertIn(
            f"SKIPPED (dirty — salvage, then rerun with --force): {wt}\n", proc.stdout
        )
        self.assertIn(str(wt), worktrees_after_default)

        self.assertEqual(proc2.returncode, 0, proc2.stderr)
        self.assertIn(f"removed worktree: {wt}\n", proc2.stdout)
        self.assertNotIn(str(wt), worktrees_after_force)

    def test_merged_branch_checked_out_in_surviving_worktree_is_reported(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            add_local_origin(repo, td)
            wtroot = td / "wtroot"
            wtroot.mkdir()
            wt = wtroot / "1"
            git(repo, "worktree", "add", "-q", str(wt), "-b", "feat/1")
            (wt / "scratch.txt").write_text("dirty\n", encoding="utf-8")

            proc, calls = run_script(
                ["--worktree-root", str(wtroot)],
                repo,
                {MERGED_LIST: "feat/1", OPEN_LIST: ""},
            )

            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(f"SKIPPED (checked out in worktree {wt}): feat/1\n", proc.stdout)
        self.assertNotIn("deleted local branch: feat/1", proc.stdout)
        self.assertIn("feat/1", branches)

    def test_dry_run_removes_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            add_local_origin(repo, td)
            wtroot = td / "wtroot"
            wtroot.mkdir()
            wt = wtroot / "1"
            git(repo, "worktree", "add", "-q", str(wt), "-b", "feat/1")
            git(repo, "branch", "feat/2-merged")

            proc, calls = run_script(
                ["--dry-run", "--worktree-root", str(wtroot)],
                repo,
                {MERGED_LIST: "feat/2-merged", OPEN_LIST: ""},
            )

            worktrees = git(repo, "worktree", "list").stdout
            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(str(wt), worktrees)
        self.assertIn("feat/2-merged", branches)

    def test_branch_flag_limits_local_pass_to_named_branches(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            add_local_origin(repo, Path(td))
            git(repo, "branch", "feat/1-merged")
            git(repo, "branch", "feat/2-merged")

            proc, calls = run_script(
                ["--branch", "feat/1-merged"],
                repo,
                {MERGED_LIST: "feat/1-merged\nfeat/2-merged", OPEN_LIST: ""},
            )

            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("deleted local branch: feat/1-merged\n", proc.stdout)
        self.assertNotIn("feat/1-merged", branches)
        # #2 is just as merged, but it was never named — --branch means this
        # run's own branches only.
        self.assertIn("feat/2-merged", branches)

    def test_branch_flag_skips_a_name_already_gone_locally(self):
        # Observed: the merge had already deleted the run's local branch, and a
        # dry run still proposed `branch -D` for it.
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            add_local_origin(repo, Path(td))

            proc, _calls = run_script(
                ["--dry-run", "--branch", "feat/1-merged"],
                repo,
                {MERGED_LIST: "feat/1-merged", OPEN_LIST: ""},
            )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("branch -D feat/1-merged", proc.stdout)
        self.assertNotIn("deleted local branch", proc.stdout)

    def test_without_branch_flag_old_behavior_holds(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            add_local_origin(repo, Path(td))
            git(repo, "branch", "feat/1-merged")
            git(repo, "branch", "feat/2-merged")

            proc, calls = run_script(
                [],
                repo,
                {MERGED_LIST: "feat/1-merged\nfeat/2-merged", OPEN_LIST: ""},
            )

            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("deleted local branch: feat/1-merged\n", proc.stdout)
        self.assertIn("deleted local branch: feat/2-merged\n", proc.stdout)
        self.assertNotIn("feat/1-merged", branches)
        self.assertNotIn("feat/2-merged", branches)

    def test_branch_flag_skips_automatic_worktree_agent_pass(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            add_local_origin(repo, Path(td))
            git(repo, "branch", "worktree-agent-one")

            proc, calls = run_script(
                ["--branch", "worktree-agent-one"],
                repo,
                {MERGED_LIST: "", OPEN_LIST: ""},
            )

            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        # Named explicitly, but it carries no merged PR — with --branch it
        # must clear the same guard as everything else, not the automatic
        # unconditional deletion the unscoped pass gives worktree-agent-*.
        self.assertIn("worktree-agent-one", branches)

    def test_branch_flag_still_honours_merged_pr_guard(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            add_local_origin(repo, Path(td))
            git(repo, "branch", "feat/unmerged")

            proc, calls = run_script(
                ["--branch", "feat/unmerged"],
                repo,
                {MERGED_LIST: "", OPEN_LIST: ""},
            )

            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("feat/unmerged", branches)

    def test_remote_pass_deletes_only_named_branch(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            origin = td / "origin.git"
            git(td, "init", "--bare", "-q", str(origin))
            git(repo, "remote", "add", "origin", str(origin))
            git(repo, "branch", "feat/1-merged")
            git(repo, "branch", "feat/2-merged")
            git(repo, "push", "-q", "origin", "main", "feat/1-merged", "feat/2-merged")
            git(
                repo,
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            )

            proc, calls = run_script(
                ["--remote", "--branch", "feat/1-merged"],
                repo,
                {MERGED_LIST: "feat/1-merged\nfeat/2-merged", OPEN_LIST: ""},
            )

            remote_branches = git(origin, "branch", "--list").stdout

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("deleted remote branch: origin/feat/1-merged\n", proc.stdout)
        self.assertNotIn("feat/1-merged", remote_branches)
        # feat/2-merged is just as merged, but never named.
        self.assertIn("feat/2-merged", remote_branches)

    def test_remote_pass_does_not_list_a_ref_absent_from_ls_remote(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo)
            origin = td / "origin.git"
            git(td, "init", "--bare", "-q", str(origin))
            git(repo, "remote", "add", "origin", str(origin))
            git(repo, "branch", "feat/gone")
            git(repo, "push", "-q", "origin", "main", "feat/gone")
            git(
                repo,
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            )
            git(repo, "fetch", "-q", "origin")
            # Simulate delete-on-merge: the ref is gone on origin, but this
            # checkout never fetched again, so its local remote-tracking ref
            # (refs/remotes/origin/feat/gone) is stale.
            git(origin, "branch", "-D", "feat/gone")

            proc, calls = run_script(
                ["--remote", "--dry-run"],
                repo,
                {MERGED_LIST: "feat/gone", OPEN_LIST: ""},
            )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        # The local pass still deletes its own (real, merged) local branch —
        # only the remote pass's enumeration is under test here: it must never
        # claim a deletion for a ref ls-remote no longer reports.
        self.assertNotIn("push origin --delete feat/gone", proc.stdout)
        self.assertNotIn("deleted remote branch: origin/feat/gone", proc.stdout)

    def test_gh_lookup_failure_stops_cleanup(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            add_local_origin(repo, Path(td))
            git(repo, "branch", "worktree-agent-one")

            proc, calls = run_script(
                [], repo, {MERGED_LIST: "", OPEN_LIST: ""}, exits={MERGED_LIST: 1}
            )

            branches = git(
                repo, "branch", "--format=%(refname:short)"
            ).stdout.splitlines()

        self.assertEqual(proc.returncode, 1)
        self.assertEqual(calls, [list(MERGED_LIST)])
        self.assertNotIn("cleanup: done", proc.stdout)
        self.assertIn("worktree-agent-one", branches)


if __name__ == "__main__":
    unittest.main()
