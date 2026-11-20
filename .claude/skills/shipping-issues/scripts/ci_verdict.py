#!/usr/bin/env python3
"""ci_verdict.py -- Read a pull request's CI for its current head and print one verdict.

For the `shipping-issues` skill: the merge gate. It reads the PR's head commit, then
that commit's check runs and combined status, every `--interval` seconds until the
verdict settles or `--timeout` seconds have passed, and prints:

    verdict: PASS | FAIL | PENDING | EMPTY | MOVED | ERROR
    head_sha: <the commit the verdict is about>
    checks: <n> check runs, <n> statuses
    failed_check: <name> (<conclusion>)        one line per failing check run, on FAIL

The rule, by head SHA and never by branch, so an earlier commit's results stay out:
    FAIL     a completed check run concluded anything but success, neutral, or skipped
             (an unknown conclusion included), or the combined status is `failure`
    EMPTY    neither a check run nor a status exists yet: never a PASS
    PENDING  a check run is not completed, or statuses exist and are not `success`
    PASS     everything else
    MOVED    the PR's head is no longer the commit being watched (`--sha`, or the head
             at the first read): the verdict would be about a commit that is not merged
PASS, FAIL, and MOVED end the watch at once; PENDING and EMPTY are printed when the
timeout ends it, and the caller runs the script again.

Read-only: it runs `gh api` on three REST paths and nothing else.

Usage:
    python3 .claude/skills/shipping-issues/scripts/ci_verdict.py <pr> [--sha SHA]
        [--timeout SECONDS] [--interval SECONDS]

`--timeout` defaults to 480, under a 10-minute foreground command; `--interval` to 30.

Needs `gh`, authenticated against this repository. It works in any directory `gh`
resolves a repository from (or with `GH_REPO` set); outside one, `gh` fails and so does
this script.

Standard library only, Python 3.9 or later.

Exit codes: 0 PASS, 2 FAIL, 3 PENDING, 4 EMPTY, 5 MOVED, 1 an error below.

Errors (stdout `verdict: ERROR`; first stderr line `ERR_<STAGE>_<WHAT>: <summary>`, then
`Expected:`, `Actual:`, and `Next:` lines; exit 1):
    ERR_CI_USAGE  a missing or malformed argument
    ERR_CI_GH     `gh` missing, failing, or printing something other than the JSON asked for
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from typing import Any, Callable

SCRIPT = "python3 .claude/skills/shipping-issues/scripts/ci_verdict.py"
SHA = re.compile(r"[0-9a-f]{40}")
GREEN = ("success", "neutral", "skipped")
EXIT = {"PASS": 0, "FAIL": 2, "PENDING": 3, "EMPTY": 4, "MOVED": 5}


class ScriptError(Exception):
    """A failure that already knows how to explain itself."""

    def __init__(self, code: str, summary: str, expected: str, actual: str, next_: str):
        super().__init__(f"{code}: {summary}")
        self.code = code
        self.summary = summary
        self.expected = expected
        self.actual = actual
        self.next = next_

    def report(self) -> str:
        return "\n".join([
            f"{self.code}: {self.summary}",
            f"Expected: {self.expected}",
            f"Actual: {self.actual}",
            f"Next: {self.next}",
        ])


def usage(summary: str, actual: str) -> ScriptError:
    return ScriptError(
        "ERR_CI_USAGE", summary,
        "<pr> [--sha SHA] [--timeout SECONDS] [--interval SECONDS]",
        actual or "no argument",
        f"run `{SCRIPT} <pr>` with the pull request's number",
    )


def parse_args(argv: list[str]) -> dict[str, Any]:
    """The PR number, the pinned head (or None), the timeout, and the interval."""
    options: dict[str, Any] = {"pr": None, "sha": None, "timeout": 480, "interval": 30}
    words = iter(argv)
    for word in words:
        if word in ("--sha", "--timeout", "--interval"):
            value = next(words, None)
            if value is None:
                raise usage(f"{word} needs a value", " ".join(argv))
            if word == "--sha":
                if not SHA.fullmatch(value):
                    raise usage("--sha is not a full commit SHA", value)
                options["sha"] = value
            elif not value.isdigit():
                raise usage(f"{word} is not a whole number of seconds", value)
            else:
                options[word[2:]] = int(value)
        elif options["pr"] is None and word.isdigit():
            options["pr"] = word
        else:
            raise usage("unknown argument", word)
    if options["pr"] is None:
        raise usage("no pull request number", " ".join(argv))
    return options


def gh_failure(path: str, actual: str) -> ScriptError:
    return ScriptError(
        "ERR_CI_GH", f"cannot read {path}",
        "`gh api` to answer with the JSON the script asked for",
        actual,
        "run the script once more; if it fails the same way, run that `gh api` read on "
        "its own to see the message (a 403 from a cloud session's proxy is a stop)",
    )


def run_gh(path: str, jq: str, paginate: bool = False) -> list[Any]:
    """Every JSON value `gh api <path> --jq <jq>` prints, in order."""
    command = ["gh", "api", path, "--jq", jq] + (["--paginate"] if paginate else [])
    try:
        done = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as error:
        raise gh_failure(path, f"gh could not be started: {error}") from error
    if done.returncode != 0:
        lines = (done.stderr or done.stdout).strip().splitlines()
        raise gh_failure(path, lines[0] if lines else f"gh exited {done.returncode}")
    values, decoder, text = [], json.JSONDecoder(), done.stdout
    at = 0
    while at < len(text):
        if text[at].isspace():
            at += 1
            continue
        try:
            value, at = decoder.raw_decode(text, at)
        except ValueError as error:
            raise gh_failure(path, f"output that is not JSON: {error}") from error
        values.append(value)
    return values


def head_sha(pr: str, run: Callable) -> str:
    values = run(f"repos/{{owner}}/{{repo}}/pulls/{pr}", "{sha: .head.sha}")
    sha = values[0].get("sha") if values and isinstance(values[0], dict) else None
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise gh_failure(f"pull request {pr}", f"no head SHA in the reply: {values!r}")
    return sha


def read_checks(sha: str, run: Callable) -> tuple[list[dict], str, int]:
    """The head's check runs, its combined state, and how many statuses that combines."""
    runs = run(
        f"repos/{{owner}}/{{repo}}/commits/{sha}/check-runs?per_page=100",
        ".check_runs[] | {status, conclusion, name}", paginate=True,
    )
    combined = run(
        f"repos/{{owner}}/{{repo}}/commits/{sha}/status", "{state, total_count}",
    )
    status = combined[0] if combined and isinstance(combined[0], dict) else {}
    count = status.get("total_count")
    if not all(isinstance(item, dict) for item in runs) or not isinstance(count, int):
        raise gh_failure(f"the checks of {sha}", f"an unexpected shape: {combined!r}")
    return runs, str(status.get("state")), count


def decide(runs: list[dict], state: str, statuses: int) -> tuple[str, list[str]]:
    """The verdict for one read, and the failing check runs as `name (conclusion)`."""
    done = [item for item in runs if item.get("status") == "completed"]
    failed = [
        f"{item.get('name')} ({item.get('conclusion') or 'none'})"
        for item in done if item.get("conclusion") not in GREEN
    ]
    if failed or state == "failure":
        return "FAIL", failed
    if not runs and statuses == 0:
        return "EMPTY", []
    if len(done) < len(runs) or (statuses > 0 and state != "success"):
        return "PENDING", []
    return "PASS", []


def main(argv: list[str] | None = None, *, run: Callable = run_gh,
         log: Callable[[str], None] = print, sleep: Callable[[float], None] | None = None,
         clock: Callable[[], float] = time.monotonic) -> int:
    """Watch and print; returns the verdict's exit code, raises ScriptError on an error."""
    options = parse_args(sys.argv[1:] if argv is None else argv)
    sleep = time.sleep if sleep is None else sleep
    started = clock()
    watched = options["sha"]
    while True:
        head = head_sha(options["pr"], run)
        watched = watched or head
        if head != watched:
            log("verdict: MOVED")
            log(f"head_sha: {head}")
            log(f"watched_sha: {watched}")
            return EXIT["MOVED"]
        runs, state, statuses = read_checks(head, run)
        verdict, failed = decide(runs, state, statuses)
        settled = verdict in ("PASS", "FAIL")
        if settled or clock() - started + options["interval"] > options["timeout"]:
            log(f"verdict: {verdict}")
            log(f"head_sha: {head}")
            log(f"checks: {len(runs)} check runs, {statuses} statuses")
            for name in failed:
                log(f"failed_check: {name}")
            if verdict == "FAIL" and state == "failure":
                log("failed_status: the combined commit status is failure")
            return EXIT[verdict]
        sleep(options["interval"])


def cli(argv: list[str] | None = None) -> int:
    """Run main, turning a ScriptError (or anything unexpected) into the four-line report."""
    try:
        return main(argv)
    except ScriptError as error:
        report = error.report()
    except Exception as error:  # noqa: BLE001 -- the failure contract names every exit
        report = ScriptError(
            "ERR_INTERNAL_UNEXPECTED", str(error),
            "the script to finish or fail with a named ERR_ code",
            "an unexpected exception",
            "report this as a bug in the script, with the command you ran",
        ).report()
    print("verdict: ERROR")
    print(report, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(cli())
