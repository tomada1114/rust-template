#!/usr/bin/env python3
"""Parity tests: preflight.sh and the Python scripts must derive the same
`<runstate>` from one origin URL and one AGENT_SKILL_STATE_DIR. Stdlib-only.

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import issue_digest as idg
import run_record as rr
from _fakegh import FakeGh

PREFLIGHT = HERE.parent / "preflight.sh"

# (origin URL, expected slug or None when it must not be guessed)
URLS = [
    ("git@github.com:acme/widgets.git", "acme/widgets"),
    ("git@github.com:acme/widgets", "acme/widgets"),
    ("https://github.com/acme/widgets", "acme/widgets"),
    ("https://github.com/acme/widgets.git", "acme/widgets"),
    ("https://github.com/acme/widgets/", "acme/widgets"),
    ("https://github.com/acme/widgets.git/", "acme/widgets"),
    ("http://github.com/acme/widgets", "acme/widgets"),
    ("https://user@github.com/acme/widgets.git", "acme/widgets"),
    ("ssh://git@github.com/acme/widgets.git", "acme/widgets"),
    ("ssh://git@github.com:2222/acme/widgets.git", "acme/widgets"),
    ("ssh://git@github.com:2222/acme/widgets.git/", "acme/widgets"),
    ("github-work:acme/widgets.git", "acme/widgets"),
    ("gh:acme/widgets", "acme/widgets"),
    ("git@github.com:/acme/widgets.git", "acme/widgets"),
    ("git://github.com/acme/widgets.git", "acme/widgets"),
    ("git+ssh://git@github.com/acme/widgets.git", "acme/widgets"),
    ("ssh+git://git@github.com/acme/widgets.git", "acme/widgets"),
    ("file:///acme/widgets", None),
    ("file:///acme/widgets.git", None),
    ("ftp://github.com/acme/widgets", None),
    ("./local:acme/widgets", None),
    ("https://github.com/acme", None),
    ("https://github.com/group/sub/widgets.git", None),
    ("/srv/git/widgets.git", None),
]


def git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def preflight(repo: Path, env: dict[str, str]) -> dict[str, str]:
    with FakeGh({}) as fake:
        full = {**fake.env, **env}
        if "AGENT_SKILL_STATE_DIR" not in env:
            full.pop("AGENT_SKILL_STATE_DIR", None)
        proc = subprocess.run(
            ["bash", str(PREFLIGHT)], cwd=repo, env=full, text=True, capture_output=True
        )
    out = {}
    for line in proc.stdout.splitlines():
        key, sep, value = line.partition(": ")
        if sep and key and " " not in key:
            out.setdefault(key, value)
    return out


class RunstateParityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.home = self.tmp / "home"
        self.home.mkdir()
        git(self.repo, "init", "-q")
        # Only the fixture repository's config: a caller's url.<base>.insteadOf
        # (a cloud session exports one through GIT_CONFIG_*, a parent `git -c`
        # through GIT_CONFIG_PARAMETERS) would rewrite the origin URLs under
        # test before the scripts read them.
        self.env = {
            "HOME": str(self.home),
            "GIT_CONFIG_COUNT": "0",
            "GIT_CONFIG_PARAMETERS": "",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
        }

    def _set_origin(self, url):
        subprocess.run(
            ["git", "remote", "remove", "origin"], cwd=self.repo, capture_output=True
        )
        git(self.repo, "remote", "add", "origin", url)

    def _python(self, env):
        cwd = Path.cwd()
        os.chdir(self.repo)
        try:
            with patch.dict(os.environ, env, clear=False):
                if "AGENT_SKILL_STATE_DIR" not in env:
                    os.environ.pop("AGENT_SKILL_STATE_DIR", None)
                return idg.repo_slug(), idg.runstate_dir(), rr.state_dir()
        finally:
            os.chdir(cwd)

    def test_origin_url_table_same_slug_and_runstate_in_every_script(self):
        state = self.tmp / "state"
        env = {**self.env, "AGENT_SKILL_STATE_DIR": str(state)}
        for url, expected in URLS:
            with self.subTest(url=url):
                self._set_origin(url)
                pre = preflight(self.repo, env)
                slug, runstate, root = self._python(env)
                self.assertEqual(slug, expected)
                self.assertEqual(pre["repo_slug"], expected or "UNKNOWN")
                if expected is None:
                    self.assertIsNone(runstate)
                    continue
                self.assertEqual(Path(pre["runstate"]), runstate)
                self.assertEqual(runstate.parent.parent, root)
                with patch.dict(os.environ, env):
                    self.assertEqual(rr.record_path(expected).parent, runstate)

    def test_tilde_state_dir_resolves_to_one_directory_everywhere(self):
        self._set_origin("git@github.com:acme/widgets.git")
        expected = self.home / "x" / "shipping-issues" / "acme__widgets"
        for raw in ("~/x", "~/x/"):
            with self.subTest(raw=raw):
                env = {**self.env, "AGENT_SKILL_STATE_DIR": raw}
                pre = preflight(self.repo, env)
                _, runstate, root = self._python(env)
                self.assertEqual(Path(pre["runstate"]), expected)
                self.assertEqual(runstate, expected)
                self.assertEqual(root / "shipping-issues" / "acme__widgets", expected)
                with patch.dict(os.environ, env):
                    self.assertEqual(rr.record_path("acme/widgets").parent, expected)

    def test_unset_state_dir_defaults_under_home_everywhere(self):
        self._set_origin("git@github.com:acme/widgets.git")
        env = dict(self.env)
        expected = self.home / ".local/state/agent-skills/shipping-issues/acme__widgets"
        pre = preflight(self.repo, env)
        _, runstate, _ = self._python(env)
        self.assertEqual(Path(pre["runstate"]), expected)
        self.assertEqual(runstate, expected)


if __name__ == "__main__":
    unittest.main()
