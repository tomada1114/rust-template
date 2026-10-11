#!/usr/bin/env python3
"""Tests for preflight.sh. Stdlib-only (unittest).

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _fakegh import FakeGh

SCRIPT = Path(__file__).resolve().parent.parent / "preflight.sh"


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


def run_script(args, repo):
    # preflight.sh makes no `gh` calls at all; FakeGh is installed anyway so a
    # regression that adds one back is caught as an unexpected call instead of
    # silently hitting a real `gh` on the test runner's PATH.
    with FakeGh({}) as fake:
        proc = subprocess.run(
            ["bash", str(SCRIPT), *args],
            cwd=repo,
            env=fake.env,
            text=True,
            capture_output=True,
        )
        calls = list(fake.calls)
    return proc, calls


def run_script_gh(args, repo, *, responses=None, exits=None):
    """Like run_script, but with a caller-supplied FakeGh routing table —
    used only by the --with-github tests, which need `gh auth status` /
    `gh repo view` to answer something other than the default "[]"."""
    with FakeGh(responses or {}, exits=exits or {}) as fake:
        proc = subprocess.run(
            ["bash", str(SCRIPT), *args],
            cwd=repo,
            env=fake.env,
            text=True,
            capture_output=True,
        )
        calls = list(fake.calls)
    return proc, calls


CLOUD_NEXT = (
    "next: in a Claude Code cloud session use the cloud-claude-shipping-issues skill\n"
)


def run_script_host(args, repo, host):
    """Run preflight.sh with CLAUDE_CODE_REMOTE set to `host` (a string), so
    the result never depends on the runner's own environment."""
    with FakeGh({}) as fake:
        env = {**fake.env, "CLAUDE_CODE_REMOTE": host}
        proc = subprocess.run(
            ["bash", str(SCRIPT), *args],
            cwd=repo,
            env=env,
            text=True,
            capture_output=True,
        )
        calls = list(fake.calls)
    return proc, calls


def without_runstate(stdout):
    """Drop the `runstate:` line: FakeGh gives every run its own temp dir."""
    return [ln for ln in stdout.splitlines() if not ln.startswith("runstate:")]


def sha12(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def profile_value(stdout: str, key: str) -> str:
    prefix = key + ": "
    return next(
        ln[len(prefix) :] for ln in stdout.splitlines() if ln.startswith(prefix)
    )


class PreflightTest(unittest.TestCase):
    def test_help_flag_prints_own_usage_and_never_calls_gh(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            for flag in ("-h", "--help"):
                with self.subTest(flag=flag):
                    proc, calls = run_script([flag], repo)

                    self.assertEqual(proc.returncode, 0)
                    self.assertIn(
                        "preflight.sh — Verify the local repo is in a state",
                        proc.stdout,
                    )
                    self.assertIn("Exit codes:", proc.stdout)
                    self.assertEqual(calls, [])

    def test_ready_repo_reports_ready_verdict(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            proc, calls = run_script([], repo)
            reported_root = git(repo, "rev-parse", "--show-toplevel").stdout.strip()

        self.assertEqual(proc.returncode, 0, proc.stderr)
        expected_lines = [
            "git_repo: ok",
            f"repo_root: {reported_root}",
            "origin: https://example.invalid/acme/widgets.git",
            "current_branch: main",
            "working_tree: clean",
            "verdict: READY",
        ]
        for line in expected_lines:
            self.assertIn(f"{line}\n", proc.stdout)
        self.assertEqual(calls, [])

    def test_missing_origin_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo)
            proc, calls = run_script([], repo)

        self.assertEqual(proc.returncode, 1)
        self.assertIn("origin: MISSING\n", proc.stdout)
        self.assertIn("verdict: BLOCKED\n", proc.stdout)
        self.assertEqual(calls, [])

    def test_not_a_repo_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            proc, calls = run_script([], repo)

        self.assertEqual(proc.returncode, 1)
        self.assertIn("git_repo: NOT_A_REPO\n", proc.stdout)
        self.assertIn("verdict: BLOCKED\n", proc.stdout)
        self.assertEqual(calls, [])

    def test_no_worktree_in_main_checkout(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            proc, calls = run_script([], repo)

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("in_worktree: no\n", proc.stdout)
        self.assertNotIn("existing_worktrees:", proc.stdout)
        self.assertIn("verdict: READY\n", proc.stdout)

    def test_linked_worktree_reports_count_and_in_worktree(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td).resolve()
            repo = td / "repo"
            repo.mkdir()
            make_repo(repo, origin=True)
            wtroot = td / "wtroot"
            wtroot.mkdir()
            wt = wtroot / "1"
            git(repo, "worktree", "add", "-q", str(wt), "-b", "feat/1")

            proc, calls = run_script([], repo)
            proc_wt, calls_wt = run_script([], wt)

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("in_worktree: no\n", proc.stdout)
        self.assertIn("existing_worktrees: 1\n", proc.stdout)
        self.assertIn(str(wt), proc.stdout)
        self.assertIn("verdict: READY\n", proc.stdout)

        self.assertEqual(proc_wt.returncode, 0, proc_wt.stderr)
        self.assertIn("in_worktree: yes\n", proc_wt.stdout)
        self.assertIn("existing_worktrees: 1\n", proc_wt.stdout)
        self.assertIn("verdict: READY\n", proc_wt.stdout)

    def test_dirty_tree_warns_but_is_ready(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "README.md").write_text("changed\n", encoding="utf-8")
            proc, calls = run_script([], repo)

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("working_tree: DIRTY\n", proc.stdout)
        self.assertIn("verdict: READY_WITH_WARNINGS\n", proc.stdout)
        self.assertEqual(calls, [])

    # --- repo profile: pkg_manager / lockfile / verify_command / hooks -----

    def test_profile_keys_with_cargo_lockfile_and_justfile_verify_recipe(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("version = 4\n", encoding="utf-8")
            (repo / "justfile").write_text(
                "check: fmt lint test\n\nverify: lock-check lint test\n",
                encoding="utf-8",
            )
            proc, calls = run_script([], repo)

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("repo_slug: acme/widgets\n", proc.stdout)
        self.assertIn("default_branch: main\n", proc.stdout)
        self.assertIn("runstate: ", proc.stdout)
        self.assertIn("shipping-issues/acme__widgets\n", proc.stdout)
        self.assertIn("pkg_manager: cargo\n", proc.stdout)
        self.assertIn("lockfile: Cargo.lock\n", proc.stdout)
        # `verify` outranks `check` even when `check` comes first in the file:
        # `check` runs `fmt`, so it mutates the tree it is meant to judge.
        self.assertIn("verify_command: just verify\n", proc.stdout)
        self.assertIn("verify_source: justfile:verify\n", proc.stdout)
        self.assertEqual(calls, [])
        # lockfile_hash must be a real hash, not "none", when a lockfile exists
        hash_line = next(
            ln for ln in proc.stdout.splitlines() if ln.startswith("lockfile_hash: ")
        )
        self.assertNotEqual(hash_line, "lockfile_hash: none")
        self.assertEqual(len(hash_line.split(": ", 1)[1]), 12)

    def test_justfile_recipe_outranks_a_makefile_target(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Makefile").write_text("verify:\n\techo hi\n", encoding="utf-8")
            (repo / "justfile").write_text("test:\n    echo hi\n", encoding="utf-8")
            proc, _ = run_script([], repo)

        self.assertIn("verify_command: just test\n", proc.stdout)
        self.assertIn("verify_source: justfile:test\n", proc.stdout)

    def test_this_repos_justfile_shape_selects_just_check(self):
        # This repository's justfile has `check` and `test` but no `verify`.
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("version = 4\n", encoding="utf-8")
            (repo / "justfile").write_text(
                "test: test-core test-xtask\n\ncheck: verify-hooks fmt lint test\n",
                encoding="utf-8",
            )
            proc, _ = run_script([], repo)

        self.assertIn("verify_command: just check\n", proc.stdout)
        self.assertIn("verify_source: justfile:check\n", proc.stdout)

    def test_verify_command_falls_back_to_makefile_over_language_default(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("", encoding="utf-8")
            (repo / "Makefile").write_text("verify:\n\techo hi\n", encoding="utf-8")
            proc, _ = run_script([], repo)

        self.assertIn("verify_command: make verify\n", proc.stdout)
        self.assertIn("verify_source: Makefile:verify\n", proc.stdout)

    def test_verify_command_falls_back_to_language_default_when_no_makefile(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("", encoding="utf-8")
            proc, _ = run_script([], repo)

        self.assertIn("verify_command: cargo test\n", proc.stdout)
        self.assertIn("verify_source: Cargo.lock\n", proc.stdout)

    def test_verify_command_none_when_nothing_detected(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            proc, _ = run_script([], repo)

        self.assertIn("verify_command: NONE\n", proc.stdout)
        self.assertIn("verify_source: none\n", proc.stdout)

    # --- hooks detection -----------------------------------------------------

    def test_unsupported_lockfiles_do_not_select_a_stack(self):
        for lockfile in (
            "uv.lock",
            "pnpm-lock.yaml",
            "poetry.lock",
            "Gemfile.lock",
            "go.sum",
            "requirements.txt",
        ):
            with self.subTest(lockfile=lockfile), tempfile.TemporaryDirectory() as td:
                repo = Path(td)
                make_repo(repo, origin=True)
                (repo / lockfile).write_text("fixture\n", encoding="utf-8")
                (repo / "Rakefile").write_text("fixture\n", encoding="utf-8")
                proc, calls = run_script([], repo)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn("pkg_manager: none\n", proc.stdout)
                self.assertIn("lockfile: none\n", proc.stdout)
                self.assertIn("lockfile_hash: none\n", proc.stdout)
                self.assertIn("verify_command: NONE\n", proc.stdout)
                self.assertNotIn("js_pkg_manager", proc.stdout)
                self.assertEqual(calls, [])

    def test_prior_profile_logic_recalculates_without_losing_viability(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("fixture\n", encoding="utf-8")
            cache = repo / "profile.json"
            run_script(
                ["--profile-cache", str(cache), "--set-worktree-viable", "yes"], repo
            )
            data = json.loads(cache.read_text(encoding="utf-8"))
            data["profile_logic_version"] = "3"
            data["verify_command"] = "make stale"
            cache.write_text(json.dumps(data), encoding="utf-8")
            proc, calls = run_script(["--profile-cache", str(cache)], repo)
            self.assertIn("profile_cache: WRITTEN\n", proc.stdout)
            self.assertIn("verify_command: cargo test\n", proc.stdout)
            self.assertIn("worktree_viable: yes\n", proc.stdout)
            self.assertEqual(calls, [])

    # --- Cargo profile ----------------------------------------------------

    def test_cargo_lockfile_hash_is_the_single_file_hash(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_bytes(b"version = 4\n")
            proc, calls = run_script([], repo)

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("pkg_manager: cargo\n", proc.stdout)
        self.assertIn("lockfile: Cargo.lock\n", proc.stdout)
        self.assertEqual(
            profile_value(proc.stdout, "lockfile_hash"), sha12(b"version = 4\n")
        )
        self.assertEqual(calls, [])

    def test_profile_cache_invalidated_when_a_build_config_file_changes(self):
        for name in (
            "Makefile",
            "justfile",
            ".justfile",
            "Cargo.toml",
            "rust-toolchain.toml",
            "mise.toml",
            "lefthook.yml",
        ):
            with self.subTest(changed=name), tempfile.TemporaryDirectory() as td:
                repo = Path(td)
                make_repo(repo, origin=True)
                (repo / "Cargo.lock").write_text("fixture\n", encoding="utf-8")
                (repo / name).write_text("v1\n", encoding="utf-8")
                cache = repo / ".cache-outside-git" / "cache.json"

                first, _ = run_script(["--profile-cache", str(cache)], repo)
                hit, _ = run_script(["--profile-cache", str(cache)], repo)
                (repo / name).write_text("v2\n", encoding="utf-8")
                after, _ = run_script(["--profile-cache", str(cache)], repo)

                self.assertIn("profile_cache: WRITTEN\n", first.stdout)
                self.assertIn("profile_cache: HIT\n", hit.stdout)
                self.assertIn("profile_cache: WRITTEN\n", after.stdout)

    def test_profile_cache_invalidated_when_a_cargo_lockfile_appears(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            cache = repo / ".cache-outside-git" / "cache.json"

            run_script(["--profile-cache", str(cache)], repo)
            (repo / "Cargo.lock").write_text("fixture\n", encoding="utf-8")
            after, _ = run_script(["--profile-cache", str(cache)], repo)

        self.assertIn("profile_cache: WRITTEN\n", after.stdout)
        self.assertIn("pkg_manager: cargo\n", after.stdout)
        self.assertIn("verify_command: cargo test\n", after.stdout)

    def test_a_logic_version_5_cache_recalculates_without_losing_viability(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("fixture\n", encoding="utf-8")
            cache = repo / ".cache-outside-git" / "cache.json"

            run_script(["--profile-cache", str(cache)], repo)
            run_script(
                ["--profile-cache", str(cache), "--set-worktree-viable", "yes"], repo
            )
            hit, _ = run_script(["--profile-cache", str(cache)], repo)
            blob = json.loads(cache.read_text(encoding="utf-8"))
            blob["logic_version"] = "5"
            blob["verify_command"] = "make stale"
            cache.write_text(json.dumps(blob), encoding="utf-8")
            after, calls = run_script(["--profile-cache", str(cache)], repo)
            rewritten = json.loads(cache.read_text(encoding="utf-8"))

        self.assertIn("profile_cache: HIT\n", hit.stdout)
        self.assertIn("profile_cache: WRITTEN\n", after.stdout)
        self.assertIn("verify_command: cargo test\n", after.stdout)
        self.assertIn("worktree_viable: yes\n", after.stdout)
        self.assertEqual(rewritten["logic_version"], "6")
        self.assertEqual(calls, [])

    def test_a_logic_version_5_cache_with_no_viability_recalculates_as_unknown(
        self,
    ):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("fixture\n", encoding="utf-8")
            cache = repo / ".cache-outside-git" / "cache.json"

            run_script(["--profile-cache", str(cache)], repo)
            run_script(
                ["--profile-cache", str(cache), "--set-worktree-viable", "no"], repo
            )
            blob = json.loads(cache.read_text(encoding="utf-8"))
            blob["logic_version"] = "5"
            cache.write_text(json.dumps(blob), encoding="utf-8")
            after, _ = run_script(["--profile-cache", str(cache)], repo)

        self.assertIn("profile_cache: WRITTEN\n", after.stdout)
        self.assertIn("worktree_viable: unknown\n", after.stdout)

    def test_hooks_lefthook_config(self):
        for name in ("lefthook.yml", "lefthook.yaml", ".lefthook.yml"):
            with self.subTest(config=name), tempfile.TemporaryDirectory() as td:
                repo = Path(td)
                make_repo(repo, origin=True)
                (repo / name).write_text("pre-commit:\n  jobs: []\n", encoding="utf-8")
                proc, _ = run_script([], repo)
                self.assertIn("hooks: lefthook\n", proc.stdout)

    def test_hooks_lefthook_config_wins_over_a_native_hook(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "lefthook.yml").write_text("pre-commit: {}\n", encoding="utf-8")
            (repo / ".git" / "hooks" / "pre-commit").write_text(
                "#!/bin/sh\necho hi\n", encoding="utf-8"
            )
            proc, _ = run_script([], repo)
        self.assertIn("hooks: lefthook\n", proc.stdout)

    def test_hooks_lefthook_installed_hook_without_a_config(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / ".git" / "hooks" / "pre-commit").write_text(
                "#!/bin/sh\ncall_lefthook run \"pre-commit\" \"$@\"\n",
                encoding="utf-8",
            )
            proc, _ = run_script([], repo)
        self.assertIn("hooks: lefthook\n", proc.stdout)

    def test_hooks_lefthook_mentioned_only_in_a_sample_is_not_lefthook(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            for sample in (repo / ".git" / "hooks").glob("*.sample"):
                sample.unlink()
            (repo / ".git" / "hooks" / "pre-commit.sample").write_text(
                "#!/bin/sh\n# lefthook\n", encoding="utf-8"
            )
            proc, _ = run_script([], repo)
        self.assertIn("hooks: none\n", proc.stdout)

    def test_a_pre_commit_framework_config_is_not_detected(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / ".pre-commit-config.yaml").write_text(
                "repos: []\n", encoding="utf-8"
            )
            proc, _ = run_script([], repo)
        self.assertIn("hooks: none\n", proc.stdout)

    def test_hooks_native_git_hook(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            hooks_dir = repo / ".git" / "hooks"
            (hooks_dir / "pre-commit").write_text(
                "#!/bin/sh\necho hi\n", encoding="utf-8"
            )
            proc, _ = run_script([], repo)
        self.assertIn("hooks: native\n", proc.stdout)

    def test_hooks_none_by_default(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            proc, _ = run_script([], repo)
        self.assertIn("hooks: none\n", proc.stdout)

    # --- profile cache ---------------------------------------------------

    def test_profile_cache_miss_then_written_then_hit(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("", encoding="utf-8")
            cache = repo / ".cache-outside-git" / "cache.json"

            first, _ = run_script(["--profile-cache", str(cache)], repo)
            second, _ = run_script(["--profile-cache", str(cache)], repo)
            # Checked inside the temp dir's lifetime: the cache lives under it.
            cache_written = cache.exists()

        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("profile_cache: WRITTEN\n", first.stdout)
        self.assertIn("worktree_viable: unknown\n", first.stdout)
        self.assertTrue(cache_written)

        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("profile_cache: HIT\n", second.stdout)
        self.assertIn("verify_command: cargo test\n", second.stdout)

    def test_changing_the_detection_rules_invalidates_the_cache(self):
        # The cache key covers this script's own logic, not just the repo's
        # files: a cache written by an older verify_command search order must
        # not keep serving the answer that order gave.
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("", encoding="utf-8")
            cache = repo / ".cache-outside-git" / "cache.json"

            run_script(["--profile-cache", str(cache)], repo)
            blob = json.loads(cache.read_text(encoding="utf-8"))
            blob["logic_version"] = "0"
            cache.write_text(json.dumps(blob), encoding="utf-8")
            second, _ = run_script(["--profile-cache", str(cache)], repo)

        self.assertIn("profile_cache: WRITTEN\n", second.stdout)

    def test_recorded_worktree_viability_survives_an_invalidation(self):
        # worktree_viable is measured by running a gate in a real worktree, not
        # derived from a config file, so a lockfile bump must not discard a
        # `yes` — that value cost a whole cold worktree build to learn.
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("v1", encoding="utf-8")
            cache = repo / ".cache-outside-git" / "cache.json"

            run_script(["--profile-cache", str(cache)], repo)
            run_script(
                ["--profile-cache", str(cache), "--set-worktree-viable", "yes"], repo
            )
            (repo / "Cargo.lock").write_text("v2 — different lockfile", encoding="utf-8")
            after, _ = run_script(["--profile-cache", str(cache)], repo)

        self.assertIn("profile_cache: WRITTEN\n", after.stdout)
        self.assertIn("worktree_viable: yes\n", after.stdout)

    def test_a_dependency_input_change_resets_a_recorded_no_to_unknown(self):
        # A `no` may be the very failure the changed input fixes (a toolchain
        # pin bump, a dependency update), and plan.py forces serial on `no`, so
        # carrying it would never re-probe the repo.
        for name in (
            "Cargo.lock",
            "Cargo.toml",
            "rust-toolchain.toml",
            "mise.toml",
            "lefthook.yml",
        ):
            with self.subTest(changed=name), tempfile.TemporaryDirectory() as td:
                repo = Path(td)
                make_repo(repo, origin=True)
                (repo / "Cargo.lock").write_text("v1\n", encoding="utf-8")
                (repo / name).write_text("v1\n", encoding="utf-8")
                cache = repo / ".cache-outside-git" / "cache.json"

                run_script(["--profile-cache", str(cache)], repo)
                run_script(
                    ["--profile-cache", str(cache), "--set-worktree-viable", "no"],
                    repo,
                )
                (repo / name).write_text("v2\n", encoding="utf-8")
                after, _ = run_script(["--profile-cache", str(cache)], repo)
                rewritten = json.loads(cache.read_text(encoding="utf-8"))

                self.assertIn("profile_cache: WRITTEN\n", after.stdout)
                self.assertIn("worktree_viable: unknown\n", after.stdout)
                self.assertEqual(rewritten["worktree_viable"], "unknown")

    def test_a_recorded_no_on_the_current_profile_is_honored(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("v1\n", encoding="utf-8")
            cache = repo / ".cache-outside-git" / "cache.json"

            run_script(["--profile-cache", str(cache)], repo)
            run_script(
                ["--profile-cache", str(cache), "--set-worktree-viable", "no"], repo
            )
            after, _ = run_script(["--profile-cache", str(cache)], repo)

        self.assertIn("profile_cache: HIT\n", after.stdout)
        self.assertIn("worktree_viable: no\n", after.stdout)

    def test_set_worktree_viable_then_read_back_on_a_hit(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("", encoding="utf-8")
            cache = repo / ".cache-outside-git" / "cache.json"

            run_script(["--profile-cache", str(cache)], repo)
            run_script(
                ["--profile-cache", str(cache), "--set-worktree-viable", "yes"], repo
            )
            after, _ = run_script(["--profile-cache", str(cache)], repo)

        self.assertIn("profile_cache: HIT\n", after.stdout)
        self.assertIn("worktree_viable: yes\n", after.stdout)

    def test_profile_cache_invalidated_when_lockfile_changes(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            (repo / "Cargo.lock").write_text("v1", encoding="utf-8")
            cache = repo / ".cache-outside-git" / "cache.json"

            first, _ = run_script(["--profile-cache", str(cache)], repo)
            (repo / "Cargo.lock").write_text(
                "v2 - a completely different lockfile", encoding="utf-8"
            )
            second, _ = run_script(["--profile-cache", str(cache)], repo)

        self.assertIn("profile_cache: WRITTEN\n", first.stdout)
        self.assertIn("profile_cache: WRITTEN\n", second.stdout)

    def test_set_worktree_viable_round_trips_through_cache(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            cache = repo / ".cache-outside-git" / "cache.json"

            run_script(["--profile-cache", str(cache)], repo)  # seed the cache (MISS)
            set_proc, _ = run_script(
                ["--profile-cache", str(cache), "--set-worktree-viable", "yes"], repo
            )
            read_proc, _ = run_script(["--profile-cache", str(cache)], repo)

        self.assertEqual(set_proc.returncode, 0, set_proc.stderr)
        self.assertIn("worktree_viable: yes\n", set_proc.stdout)
        self.assertIn("verdict: READY\n", set_proc.stdout)
        self.assertIn("profile_cache: HIT\n", read_proc.stdout)
        self.assertIn("worktree_viable: yes\n", read_proc.stdout)

    def test_set_worktree_viable_without_profile_cache_exits_2(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            proc, _ = run_script(["--set-worktree-viable", "yes"], repo)

        self.assertEqual(proc.returncode, 2)

    # --- --with-github --------------------------------------------------

    def test_without_with_github_flag_no_gh_keys_and_no_gh_calls(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            proc, calls = run_script([], repo)

        self.assertNotIn("gh_auth:", proc.stdout)
        self.assertNotIn("gh_write:", proc.stdout)
        self.assertEqual(calls, [])

    def test_with_github_ok_and_write_access(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            proc, calls = run_script_gh(
                ["--with-github"],
                repo,
                responses={("repo", "view"): "WRITE\n"},
                exits={},
            )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("gh_auth: ok\n", proc.stdout)
        self.assertIn("gh_write: yes\n", proc.stdout)
        self.assertIn("verdict: READY\n", proc.stdout)
        self.assertTrue(any(c[:2] == ["auth", "status"] for c in calls))
        self.assertTrue(any(c[:2] == ["repo", "view"] for c in calls))

    def test_with_github_not_logged_in_and_read_only_warns(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            proc, _ = run_script_gh(
                ["--with-github"],
                repo,
                responses={("auth", "status"): "", ("repo", "view"): "READ\n"},
                exits={("auth", "status"): 1},
            )

        self.assertIn("gh_auth: NOT_LOGGED_IN\n", proc.stdout)
        self.assertIn("gh_write: no\n", proc.stdout)
        self.assertIn("verdict: READY_WITH_WARNINGS\n", proc.stdout)
        # gh_auth/gh_write are never a hard blocker
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_cloud_host_stops_with_the_cloud_skill_named_and_runs_nothing(self):
        for args in ([], ["--with-github"]):
            with self.subTest(args=args), tempfile.TemporaryDirectory() as td:
                repo = Path(td)  # not even a git repo: nothing may run first
                proc, calls = run_script_host(args, repo, "true")

                self.assertEqual(proc.returncode, 1, proc.stderr)
                self.assertEqual(
                    proc.stdout,
                    "host: cloud\n" + CLOUD_NEXT + "verdict: BLOCKED\n",
                )
                self.assertEqual(calls, [])

    def test_a_host_value_other_than_true_behaves_as_local(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            baseline, _ = run_script_host([], repo, "")
            for value in ("false", "TRUE", "1", "True", "yes"):
                with self.subTest(value=value):
                    proc, _ = run_script_host([], repo, value)

                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    self.assertNotIn("host:", proc.stdout)
                    self.assertEqual(
                        without_runstate(proc.stdout),
                        without_runstate(baseline.stdout),
                    )

    def test_an_unset_host_variable_behaves_as_local(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            make_repo(repo, origin=True)
            proc, _ = run_script([], repo)

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("host:", proc.stdout)


if __name__ == "__main__":
    unittest.main()
