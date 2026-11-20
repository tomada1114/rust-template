#!/usr/bin/env python3
"""survey_prs.py -- Survey the open Dependabot and Renovate pull requests.

For the `merging-dependency-prs` skill: each open bot PR's ecosystem (cargo,
github-actions, mise, or rust-toolchain), the versions it moves and their semver level,
its check verdict, its merge state, the files it touches, and the files two of them
contest. It marks each major bump, a 0.x minor (a ratatui minor, say) included, even
inside a grouped PR.

Read-only: it runs `gh api` GETs on REST paths and nothing else, which a Claude Code
cloud session's proxy admits where it refuses GraphQL, and it is the one step of the
skill that runs before the human's approval. One call lists the open pull requests;
then, for each bot PR only, four more read what that listing leaves out: the PR itself
(its merge state), its files, and its head commit's check runs and commit statuses.

Usage:
    python3 .claude/skills/merging-dependency-prs/scripts/survey_prs.py [--json]

Needs `gh`, authenticated against this repository. It works in any directory `gh`
resolves a repository from; outside one, `gh` fails and so does this script.

Standard library only, Python 3.9 or later.

Errors (first stderr line `ERR_<STAGE>_<WHAT>: <summary>`, then `Expected:`, `Actual:`,
and `Next:` lines; exit 1):
    ERR_SURVEY_USAGE  an unknown argument
    ERR_SURVEY_GH     `gh` missing, failing, or printing something other than the JSON asked for
"""
from __future__ import annotations

import errno
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[4]

REPO = "repos/{owner}/{repo}"  # `gh api` fills both from the checkout's remote.
# What the survey reads of each open pull request in the listing.
LISTING = ("{number, title, body, html_url, user: {login: .user.login}, "
           "head: {ref: .head.ref, sha: .head.sha}}")
SHA = re.compile(r"[0-9a-f]{40}")
# GitHub computes a PR's merge state when the PR is first read and answers `unknown`
# until it has: read again this many times, this many seconds apart, before printing it.
MERGE_STATE_RETRIES = 2
MERGE_STATE_WAIT = 2

# Dependabot, one dependency: "bump serde from 1.0.228 to 1.0.229", or "update clap
# requirement from 4.5 to 5.0".
TITLE_BUMP = re.compile(
    r"(?:bump|update)\s+(?P<name>\S+?)(?:\s+requirement)?\s+from\s+(?P<from>\S+)\s+to\s+(?P<to>\S+)",
    re.IGNORECASE,
)
# Dependabot, a group: one "Updates `name` from A to B" line per dependency in the body.
# `\r?` before `$`: Python's MULTILINE `$` matches only before `\n`, so a CRLF body needs it.
BODY_BUMP = re.compile(r"^Updates `(?P<name>[^`]+)` from (?P<from>\S+) to (?P<to>\S+?)\.?\r?$", re.MULTILINE)
# Renovate: a table row "| name | minor | `A` -> `B` |", the name often a Markdown link.
TABLE_BUMP = re.compile(
    r"^\|\s*\[?(?P<name>[^\]|]+?)\]?(?:\([^)]*\))?\s*\|[^|\n]*\|\s*`(?P<from>[^`]+)`\s*(?:->|→)\s*`(?P<to>[^`]+)`\s*\|",
    re.MULTILINE,
)

# A range such as `^10.7` has no patch component, so that group is optional.
VERSION = re.compile(r"(\d+)\.(\d+)(?:\.(\d+))?")

LEVEL_ORDER = ["unknown", "patch", "minor", "major"]

# The only conclusions that let a PR through: an allow-list, so a conclusion this script
# has never seen (STARTUP_FAILURE, STALE, one GitHub adds later) holds the PR instead of
# passing it. SKIPPED is how a conditional job says "not applicable".
# States arrive in lower case from REST and are compared in upper case.
PASSING_STATES = {"SUCCESS", "NEUTRAL", "SKIPPED"}
PENDING_STATES = {"PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "EXPECTED"}


class ScriptError(Exception):
    """A failure that already knows how to explain itself."""

    def __init__(self, code: str, summary: str, expected: str, actual: str, next_: str,
                 exit_code: int = 1):
        super().__init__(f"{code}: {summary}")
        self.code = code
        self.summary = summary
        self.expected = expected
        self.actual = actual
        self.next = next_
        self.exit_code = exit_code

    def report(self) -> str:
        return "\n".join([
            f"{self.code}: {self.summary}",
            f"Expected: {self.expected}",
            f"Actual: {self.actual}",
            f"Next: {self.next}",
        ])


def _field(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else None


def _text(value: Any, key: str) -> str | None:
    read = _field(value, key)
    return read if isinstance(read, str) else None


def _list(value: Any, key: str) -> list:
    read = _field(value, key)
    return read if isinstance(read, list) else []


def bump(name: str, from_: str, to: str) -> dict:
    return {"name": name, "from": from_, "to": to}


def parse_bumps(title: str, body: str) -> list[dict]:
    """Every dependency a bot PR moves: the body's list first, the title when the body has none."""
    found: dict[str, dict] = {}
    for pattern in (BODY_BUMP, TABLE_BUMP):
        for match in pattern.finditer(body):
            name = match.group("name").strip()
            if name not in found:
                found[name] = bump(name, match.group("from"), match.group("to"))
    if found:
        return list(found.values())
    match = TITLE_BUMP.search(title)
    return [bump(match.group("name"), match.group("from"), match.group("to"))] if match else []


def semver_level(from_: str | None, to: str | None) -> str:
    """The semver level of a move, judged the way Cargo's caret ranges judge
    compatibility: below 1.0.0 the first non-zero component is the breaking one, so
    0.2 -> 0.3 is a major move (https://doc.rust-lang.org/cargo/reference/semver.html)."""
    before = VERSION.search(from_) if from_ is not None else None
    after = VERSION.search(to) if to is not None else None
    if before is None or after is None:
        return "unknown"
    major, minor, patch = (
        (int(before.group(i) or "0"), int(after.group(i) or "0")) for i in (1, 2, 3)
    )
    if major[0] != major[1]:
        return "major"
    if minor[0] != minor[1]:
        return "major" if major[0] == 0 else "minor"
    if patch[0] != patch[1]:
        return "major" if major[0] == 0 and minor[0] == 0 else "patch"
    return "patch"


def highest_level(levels: list[str]) -> str:
    best = "unknown"
    for level in levels:
        if LEVEL_ORDER.index(level) > LEVEL_ORDER.index(best):
            best = level
    return best


def check_summary(rollup: list) -> dict:
    """One verdict for a head's check runs and commit statuses together, failing closed;
    `failing` names each check held."""
    if not rollup:
        return {"state": "NONE", "failing": []}
    failing: list[str] = []
    pending = False
    for check in rollup:
        # A check run reports conclusion and status; a commit status reports state.
        conclusion = _text(check, "conclusion")
        state = (conclusion if conclusion is not None else (_text(check, "state") or "")).upper()
        status = (_text(check, "status") or "").upper()
        name = _text(check, "name")
        if name is None:
            name = _text(check, "context")
        if name is None:
            name = "?"
        if state == "" and status != "" and status != "COMPLETED":
            pending = True
        elif state in PENDING_STATES:
            pending = True
        elif state not in PASSING_STATES:
            failing.append(f"{name}={'UNKNOWN' if state == '' else state}")
    if failing:
        return {"state": "FAILING", "failing": failing}
    return {"state": "PENDING" if pending else "PASSING", "failing": []}


def ecosystem_of(branch: str, files: list[str]) -> str:
    """Dependabot names its branch after the ecosystem; Renovate is told apart by the file it edits."""
    if branch.startswith("dependabot/cargo/"):
        return "cargo"
    if branch.startswith("dependabot/github_actions/"):
        return "github-actions"
    if "rust-toolchain.toml" in files:
        return "rust-toolchain"
    if "mise.toml" in files:
        return "mise"
    if any(p == "Cargo.lock" or p.endswith("Cargo.toml") for p in files):
        return "cargo"
    if any(p.startswith(".github/workflows/") for p in files):
        return "github-actions"
    return "other"


def contested_files(rows: list[dict]) -> dict[str, list[int]]:
    """Each file two or more PRs touch, with those PRs: the case for a combined branch."""
    seen: dict[str, list[int]] = {}
    for row in rows:
        for path in row["files"]:
            seen.setdefault(path, []).append(row["number"])
    return {path: numbers for path, numbers in seen.items() if len(numbers) > 1}


def _number(value: Any) -> int | float:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    try:
        return int(str(value))
    except ValueError:
        return 0


def author_of(pull: Any) -> str:
    """The PR's author, an app named `app/<slug>` (REST's login is `<slug>[bot]`)."""
    login = _text(_field(pull, "user"), "login") or ""
    return f"app/{login[:-len('[bot]')]}" if login.endswith("[bot]") else login


def is_bot_pr(pull: Any) -> bool:
    author = author_of(pull)
    return "dependabot" in author or "renovate" in author


def collect(pulls: list) -> list[dict]:
    """One row per open Dependabot or Renovate PR, in PR-number order. Each pull is the
    listing's element, with `mergeable_state`, `files` (paths), `check_runs`, and
    `statuses` added by the reads of that PR."""
    rows = []
    for pull in pulls:
        if not is_bot_pr(pull):
            continue
        author = author_of(pull)
        title = _text(pull, "title") or ""
        branch = _text(_field(pull, "head"), "ref") or ""
        files = [p for p in _list(pull, "files") if isinstance(p, str) and p]
        bumps = parse_bumps(title, _text(pull, "body") or "")
        checks = check_summary(_list(pull, "check_runs") + _list(pull, "statuses"))
        merge_state = _text(pull, "mergeable_state")
        rows.append({
            "number": _number(_field(pull, "number") or 0),
            "title": title,
            "url": _text(pull, "html_url") or "",
            "branch": branch,
            "author": author,
            "ecosystem": ecosystem_of(branch, files),
            "bumps": bumps,
            "level": highest_level([semver_level(b["from"], b["to"]) for b in bumps]),
            "checks": checks["state"],
            "failingChecks": checks["failing"],
            "mergeState": "?" if merge_state is None else merge_state.upper(),
            "files": files,
        })
    return sorted(rows, key=lambda r: r["number"])


def format_report(rows: list[dict]) -> list[str]:
    """The human-readable survey, one line per entry, for the caller to print."""
    lines = [f"{len(rows)} open bot PR(s)"]
    for row in rows:
        lines.append("")
        lines.append(
            f"  #{str(row['number']).ljust(4)} [{row['ecosystem'].ljust(14)}] {row['level'].ljust(7)} "
            f"checks={row['checks'].ljust(8)} merge={row['mergeState']}"
        )
        lines.append(f"        {row['title']}")
        for b in row["bumps"]:
            marker = " (major)" if semver_level(b["from"], b["to"]) == "major" else ""
            lines.append(f"        {b['name']} {b['from']} -> {b['to']}{marker}")
        if row["failingChecks"]:
            lines.append(f"        HELD: {', '.join(row['failingChecks'])}")
        lines.append(f"        files: {', '.join(row['files']) or '(none)'}")
    contested = contested_files(rows)
    if contested:
        lines.append("")
        lines.append("Contested files (one combined branch):")
        for path, numbers in contested.items():
            lines.append(f"  {path}: {', '.join(f'#{n}' for n in numbers)}")
    return lines


def run_gh(args: list[str], cwd: Path) -> tuple[int | None, str, str]:
    """Run `gh`; a child that cannot start or times out has status None."""
    try:
        result = subprocess.run(["gh", *args], cwd=cwd, capture_output=True, text=True,
                                timeout=120, check=False)
    except OSError as exc:
        name = errno.errorcode.get(exc.errno or 0, "OSError")
        return None, "", f"spawn gh {name}: {exc.strerror}"
    except subprocess.TimeoutExpired:
        return None, "", "gh timed out after 120 s"
    return result.returncode, result.stdout, result.stderr


def gh_api(path: str, jq: str, root: Path, run: Callable) -> list:
    """Every JSON value `gh api <path> --jq <jq> --paginate` prints, in order. A GET:
    nothing here passes a field or a method, which is what would make it a write."""
    status, stdout, stderr = run(["api", path, "--jq", jq, "--paginate"], root)

    def failure(actual: str) -> ScriptError:
        return ScriptError(
            "ERR_SURVEY_GH",
            f"cannot read {path}",
            "the GitHub CLI on PATH, authenticated, answering `gh api` with the JSON asked for",
            actual,
            "run `gh auth status` and confirm this checkout has a GitHub remote; a 403 "
            "from a cloud session's proxy is a stop",
        )

    if status != 0:
        lines = (stderr or stdout).strip().splitlines()
        raise failure(lines[0] if lines else f"exit status {'null' if status is None else status}")
    values, decoder, at = [], json.JSONDecoder(), 0
    while at < len(stdout):
        if stdout[at].isspace():
            at += 1
            continue
        try:
            value, at = decoder.raw_decode(stdout, at)
        except ValueError:
            raise failure(f"output that is not JSON: {stdout[at:at + 120]}") from None
        values.append(value)
    return values


def merge_state(path: str, root: Path, run: Callable, sleep: Callable[[float], None]) -> Any:
    """The PR's `mergeable_state`, read again while GitHub still answers `unknown`."""
    state = None
    for attempt in range(MERGE_STATE_RETRIES + 1):
        if attempt:
            sleep(MERGE_STATE_WAIT)
        read = gh_api(path, "{mergeable_state}", root, run)
        if len(read) != 1 or not isinstance(read[0], dict):
            raise unexpected_shape(path, read)
        state = read[0].get("mergeable_state")
        if state != "unknown":
            break
    return state


def unexpected_shape(path: str, actual: Any) -> ScriptError:
    return ScriptError(
        "ERR_SURVEY_GH",
        f"cannot read {path}",
        "the fields the survey asked `gh api` for",
        f"an unexpected shape: {json.dumps(actual)[:120]}",
        "run that `gh api` read on its own to see what GitHub answers",
    )


def gh_pull_requests(root: Path, run: Callable = run_gh,
                     sleep: Callable[[float], None] = time.sleep) -> list:
    """The open pull requests, each bot PR with what the listing leaves out."""
    listing = f"{REPO}/pulls?state=open&per_page=100"
    pulls = gh_api(listing, f".[] | {LISTING}", root, run)

    for pull in pulls:
        number = _field(pull, "number")
        if not isinstance(number, int) or isinstance(number, bool):
            raise unexpected_shape(listing, pull)
        if not is_bot_pr(pull):
            continue
        # Checks are read by head SHA, so no other commit's results count; without one
        # there is nothing to read them for, and no checks must never look like a pass.
        sha = _text(_field(pull, "head"), "sha")
        if sha is None or not SHA.fullmatch(sha):
            raise unexpected_shape(listing, pull)
        one = f"{REPO}/pulls/{number}"
        pull["mergeable_state"] = merge_state(one, root, run, sleep)
        # One array per page: `--jq` prints a bare string unquoted, which is not JSON.
        pages = gh_api(f"{one}/files?per_page=100", "[.[].filename]", root, run)
        pull["files"] = [path for page in pages if isinstance(page, list) for path in page]
        pull["check_runs"] = gh_api(
            f"{REPO}/commits/{sha}/check-runs?per_page=100",
            ".check_runs[] | {name, status, conclusion}", root, run)
        pull["statuses"] = gh_api(
            f"{REPO}/commits/{sha}/status?per_page=100",
            ".statuses[] | {context, state}", root, run)
    return pulls


def main(argv: list[str] | None = None, *, root: Path | None = None,
         run: Callable = run_gh, log: Callable[[str], None] = print,
         sleep: Callable[[float], None] = time.sleep) -> None:
    """Survey and print; raises ScriptError on a usage or `gh` failure."""
    argv = sys.argv[1:] if argv is None else argv
    root = REPO_ROOT if root is None else Path(root)
    unknown = [arg for arg in argv if arg != "--json"]
    if unknown:
        raise ScriptError(
            "ERR_SURVEY_USAGE",
            f"unknown argument: {' '.join(unknown)}",
            "no argument, or --json",
            " ".join(argv),
            "run `python3 .claude/skills/merging-dependency-prs/scripts/survey_prs.py`",
        )
    rows = collect(gh_pull_requests(root, run, sleep))
    if "--json" in argv:
        log(json.dumps({"rows": rows, "contested": contested_files(rows)},
                       indent=2, ensure_ascii=False))
        return
    if not rows:
        log("No open Dependabot or Renovate pull requests.")
        return
    for line in format_report(rows):
        log(line)


def cli(argv: list[str] | None = None) -> int:
    """Run main, turning a ScriptError (or anything unexpected) into the four-line report."""
    try:
        main(argv)
    except ScriptError as error:
        print(error.report(), file=sys.stderr)
        return error.exit_code
    except Exception as error:  # noqa: BLE001 -- the failure contract names every exit
        print(ScriptError(
            "ERR_INTERNAL_UNEXPECTED", str(error),
            "the script to finish or fail with a named ERR_ code",
            "an unexpected exception",
            "report this as a bug in the script, with the command you ran",
        ).report(), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(cli())
