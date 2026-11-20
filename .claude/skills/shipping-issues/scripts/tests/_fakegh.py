"""_fakegh.py -- Shared helper: install a fake `gh` on PATH for scripts/ tests.

The script under test shells out to the real `gh` CLI. Tests never touch a real GitHub
repository, so this writes a stand-in `gh` executable that answers from a routing table:
each entry matches an argv *prefix* (the longest matching prefix wins) and returns a
fixed stdout and exit code. An argv no entry matches exits 1, so a test never passes on
a call it did not expect.

    from _fakegh import FakeGh

    with FakeGh({("api", "repos/{owner}/{repo}/pulls/7"): '{"sha": "..."}'}) as fake:
        with patch.dict("os.environ", fake.env, clear=False):
            code = ci_verdict.cli(["7"])
        fake.calls  # list[list[str]] of every argv `gh` was invoked with

`sequences` answers the Nth call to a prefix with the Nth item -- a stdout string, or a
(stdout, exit) pair -- and repeats the last item after that, for a script whose answer
depends on what GitHub says over time. `stderrs` gives a prefix's stderr.
"""
from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
from pathlib import Path

_RUNNER = '''#!/usr/bin/env python3
import json, sys, os
config = json.loads(open(os.environ["FAKE_GH_CONFIG"], encoding="utf-8").read())
argv = sys.argv[1:]
with open(os.environ["FAKE_GH_CALLS"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps(argv) + "\\n")
best = None
best_index = -1
for index, entry in enumerate(config):
    prefix = entry["prefix"]
    if argv[: len(prefix)] == prefix:
        if best is None or len(prefix) > len(best["prefix"]):
            best = entry
            best_index = index
if best is None:
    sys.stderr.write("fake gh: no response registered for %r\\n" % (argv,))
    sys.exit(1)
reply = best
if "sequence" in best:
    counter = "%s.count%d" % (os.environ["FAKE_GH_CONFIG"], best_index)
    seen = int(open(counter, encoding="utf-8").read()) if os.path.exists(counter) else 0
    with open(counter, "w", encoding="utf-8") as fh:
        fh.write(str(seen + 1))
    sequence = best["sequence"]
    reply = dict(best, **sequence[min(seen, len(sequence) - 1)])
sys.stderr.write(reply.get("stderr", ""))
sys.stdout.write(reply.get("stdout", ""))
sys.exit(reply.get("exit", 0))
'''


class FakeGh:
    """Context manager: installs a fake `gh` and exposes `.env` (an environment with PATH
    pointed at the fake) and `.calls` (every argv it was invoked with, in order)."""

    def __init__(self, responses: dict[tuple[str, ...], str] | None = None, *,
                 exits: dict[tuple[str, ...], int] | None = None,
                 stderrs: dict[tuple[str, ...], str] | None = None,
                 sequences: dict[tuple[str, ...], list[str | tuple[str, int]]] | None = None):
        self._responses = responses or {}
        self._exits = exits or {}
        self._stderrs = stderrs or {}
        self._sequences = sequences or {}
        self._tmpdir: tempfile.TemporaryDirectory | None = None
        self.env: dict[str, str] = {}

    def __enter__(self) -> "FakeGh":
        self._tmpdir = tempfile.TemporaryDirectory()
        bin_dir = Path(self._tmpdir.name) / "bin"
        bin_dir.mkdir()
        gh_path = bin_dir / "gh"
        # The fixture needs only stdlib modules: skip ambient site customization.
        runner = _RUNNER.replace("#!/usr/bin/env python3", f"#!{sys.executable} -S", 1)
        gh_path.write_text(runner, encoding="utf-8")
        gh_path.chmod(gh_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        config = [
            {"prefix": list(prefix), "stdout": stdout,
             "exit": self._exits.get(prefix, 0),
             "stderr": self._stderrs.get(prefix, "")}
            for prefix, stdout in self._responses.items()
            if prefix not in self._sequences
        ]
        config += [
            {"prefix": list(prefix),
             "stderr": self._stderrs.get(prefix, ""),
             "sequence": [
                 {"stdout": item, "exit": 0} if isinstance(item, str)
                 else {"stdout": item[0], "exit": item[1]}
                 for item in items
             ]}
            for prefix, items in self._sequences.items()
        ]
        config_path = Path(self._tmpdir.name) / "gh_config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self._calls_path = Path(self._tmpdir.name) / "gh_calls.jsonl"
        self._calls_path.write_text("", encoding="utf-8")
        self.env = dict(os.environ)
        self.env["PATH"] = f"{bin_dir}{os.pathsep}{self.env.get('PATH', '')}"
        self.env["FAKE_GH_CONFIG"] = str(config_path)
        self.env["FAKE_GH_CALLS"] = str(self._calls_path)
        return self

    def __exit__(self, *exc_info) -> None:
        if self._tmpdir is not None:
            self._tmpdir.cleanup()
            self._tmpdir = None

    @property
    def calls(self) -> list[list[str]]:
        lines = self._calls_path.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines if line.strip()]
