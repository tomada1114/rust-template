"""_fakegh.py — Shared helper: install a fake `gh` on PATH for scripts/ tests.

The scripts under test shell out to the real `gh` CLI. Tests never touch a
real GitHub repo, so this writes a stand-in `gh` executable that answers from
a small routing table instead: each entry matches an argv *prefix* (the
longest matching prefix wins, so "issue list" and "issue list --state open"
can both be registered and the more specific one wins when both apply) and
returns a fixed stdout/exit code.

Usage (inside a test) — prefer running the script's main() in-process, via
`fake.env`, over a real subprocess: coverage instrumentation only sees code
executed in this interpreter, not in a spawned child:

    from _fakegh import FakeGh

    def test_something(self):
        with FakeGh({
            ("issue", "list"): json.dumps([...]),
            ("pr", "list"): "[]",
            ("label", "list"): json.dumps([{"name": "priority: P0"}]),
        }) as fake:
            with patch.dict("os.environ", fake.env, clear=False), \
                    patch.object(sys, "argv", ["script.py", "--json"]):
                rc = some_module.main()
            ...
            fake.calls  # list[list[str]] of every argv `gh` was invoked with

A real subprocess.run([sys.executable, str(SCRIPT), ...], env=fake.env) still
works when in-process coverage isn't the point (e.g. checking the script's
final exit code and stdout/stderr framing as an external caller would see it).

Two extras for a script whose behavior depends on what GitHub says over time:

    FakeGh({...}, sequences={
        ("pr", "view", "7", "--json", "closingIssuesReferences"): ["", "", "9"],
        ("pr", "edit", "7"): [("", 0), ("", 1)],
    })

* `sequences` answers the Nth call to a prefix with the Nth item — a stdout
  string, or a (stdout, exit) pair — and repeats the last item after that. It
  takes precedence over `responses` and `exits` for the same prefix.
* `fake.body_edits` lists, in call order, the file content every call carrying
  `--body-file` sent (read at call time, since the caller usually deletes the
  file afterwards) with that call's exit code; `fake.saved_bodies` keeps only
  the ones that exited 0, so its last item is what the PR body now is.

`jq_newline=True` makes every call carrying `-q`/`--jq` print one newline
after its stdout, as the real gh does after a string value, so a response is
written as the bare value ("main", not "main\\n") and a script that writes a
`-q` value back can be tested for keeping that newline out.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
from pathlib import Path

_RUNNER = """#!/usr/bin/env python3
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
reply = {"stdout": "[]\\n", "exit": 0} if best is None else best
if best is not None and "sequence" in best:
    counter = "%s.count%d" % (os.environ["FAKE_GH_CONFIG"], best_index)
    seen = int(open(counter, encoding="utf-8").read()) if os.path.exists(counter) else 0
    with open(counter, "w", encoding="utf-8") as fh:
        fh.write(str(seen + 1))
    sequence = best["sequence"]
    reply = dict(best, **sequence[min(seen, len(sequence) - 1)])
if "--body-file" in argv[:-1]:
    try:
        with open(argv[argv.index("--body-file") + 1], encoding="utf-8") as fh:
            sent = fh.read()
    except OSError:
        sent = None
    with open(os.environ["FAKE_GH_BODIES"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"body": sent, "exit": reply.get("exit", 0)}) + "\\n")
stdout = reply.get("stdout", "[]")
if os.environ.get("FAKE_GH_JQ_NEWLINE") and ("-q" in argv or "--jq" in argv):
    stdout += "\\n"
sys.stderr.write(reply.get("stderr", ""))
sys.stdout.write(stdout)
sys.exit(reply.get("exit", 0))
"""


class FakeGh:
    """Context manager: installs a fake `gh` and yields an object exposing
    `.env` (subprocess env with PATH pointed at the fake) and `.calls`
    (populated after each subprocess call reads the shared log file)."""

    def __init__(
        self,
        responses: dict[tuple[str, ...], str] | None = None,
        *,
        exits: dict[tuple[str, ...], int] | None = None,
        stderrs: dict[tuple[str, ...], str] | None = None,
        sequences: dict[tuple[str, ...], list[str | tuple[str, int]]] | None = None,
        jq_newline: bool = False,
    ):
        self._responses = responses or {}
        self._exits = exits or {}
        self._stderrs = stderrs or {}
        self._sequences = sequences or {}
        self._jq_newline = jq_newline
        self._tmpdir: tempfile.TemporaryDirectory | None = None
        self.env: dict[str, str] = {}
        self.state_dir: Path | None = None

    def __enter__(self) -> FakeGh:
        self._tmpdir = tempfile.TemporaryDirectory()
        bin_dir = Path(self._tmpdir.name) / "bin"
        bin_dir.mkdir()
        gh_path = bin_dir / "gh"
        # The fixture needs only stdlib modules: avoid ambient site customization
        # and repeat site-package startup in every CLI subprocess.
        runner = _RUNNER.replace("#!/usr/bin/env python3", f"#!{sys.executable} -S", 1)
        gh_path.write_text(runner, encoding="utf-8")
        gh_path.chmod(
            gh_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
        )

        config = [
            {
                "prefix": list(prefix),
                "stdout": stdout,
                "exit": self._exits.get(prefix, 0),
                "stderr": self._stderrs.get(prefix, ""),
            }
            for prefix, stdout in self._responses.items()
            if prefix not in self._sequences
        ]
        config += [
            {
                "prefix": list(prefix),
                "stderr": self._stderrs.get(prefix, ""),
                "sequence": [
                    {"stdout": item, "exit": 0}
                    if isinstance(item, str)
                    else {"stdout": item[0], "exit": item[1]}
                    for item in items
                ],
            }
            for prefix, items in self._sequences.items()
        ]
        config_path = Path(self._tmpdir.name) / "gh_config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        calls_path = Path(self._tmpdir.name) / "gh_calls.jsonl"
        calls_path.write_text("", encoding="utf-8")
        bodies_path = Path(self._tmpdir.name) / "gh_bodies.jsonl"
        bodies_path.write_text("", encoding="utf-8")

        self.env = dict(os.environ)
        self.env["PATH"] = f"{bin_dir}{os.pathsep}{self.env.get('PATH', '')}"
        self.env["FAKE_GH_CONFIG"] = str(config_path)
        self.env["FAKE_GH_CALLS"] = str(calls_path)
        self.env["FAKE_GH_BODIES"] = str(bodies_path)
        if self._jq_newline:
            self.env["FAKE_GH_JQ_NEWLINE"] = "1"
        else:
            self.env.pop("FAKE_GH_JQ_NEWLINE", None)
        # Three isolations every test wants, and none is safe to leave to the
        # individual test to remember:
        #   * the run-state dir is redirected into this temp dir, so nothing a
        #     test does can write into the user's real ~/.local/state;
        #   * the digest cache is off, so a test's fake `gh` responses are never
        #     shadowed by data a previous test (or a real run) cached. A test
        #     that is specifically about the cache pops the key back out.
        #   * CLAUDE_CODE_REMOTE is dropped, so a suite run inside a Claude Code
        #     cloud session (where it is exported as "true") cannot make
        #     preflight.sh stop at its host check. A test about the cloud host
        #     sets it back explicitly.
        self.env.pop("CLAUDE_CODE_REMOTE", None)
        self.env["AGENT_SKILL_STATE_DIR"] = str(Path(self._tmpdir.name) / "state")
        self.env["SHIPPING_ISSUES_NO_CACHE"] = "1"
        self.state_dir = Path(self.env["AGENT_SKILL_STATE_DIR"])
        self._calls_path = calls_path
        self._bodies_path = bodies_path
        return self

    def __exit__(self, *exc_info) -> None:
        if self._tmpdir is not None:
            self._tmpdir.cleanup()
            self._tmpdir = None

    @property
    def calls(self) -> list[list[str]]:
        if not self._calls_path.exists():
            return []
        lines = self._calls_path.read_text(encoding="utf-8").splitlines()
        return [json.loads(ln) for ln in lines if ln.strip()]

    @property
    def body_edits(self) -> list[dict]:
        if not self._bodies_path.exists():
            return []
        lines = self._bodies_path.read_text(encoding="utf-8").splitlines()
        return [json.loads(ln) for ln in lines if ln.strip()]

    @property
    def saved_bodies(self) -> list[str | None]:
        return [edit["body"] for edit in self.body_edits if edit["exit"] == 0]


def label_writes(calls: list[list[str]]) -> list[list[str]]:
    """Every `gh label` call other than `gh label list`: a label definition
    created, edited, or deleted. The skill's scripts never make one — that is
    `just labels`' write — so a test asserts this list is empty."""
    return [c for c in calls if c[:1] == ["label"] and c[1:2] != ["list"]]
