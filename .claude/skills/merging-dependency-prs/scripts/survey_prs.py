#!/usr/bin/env python3
"""survey_prs.py -- Survey the open Dependabot and Renovate pull requests.

For the `merging-dependency-prs` skill: each open bot PR's ecosystem, the versions it
moves and their semver level, its check rollup, its merge state, the files it touches,
the files two of them contest, and whether the batch keeps each Tauri crate in step with
its `@tauri-apps/*` npm packages. It marks a Tauri pair split across PRs, at least one of
which breaks it alone, and each major bump.

Read-only: it runs `gh pr list` and reads `Cargo.lock` and `package.json` (each only if
present; a missing or unreadable file gives no baseline), and it is the one step of the
skill that runs before the human's approval.

Usage:
    python3 .agents/skills/merging-dependency-prs/scripts/survey_prs.py [--json]

Needs `gh`, authenticated against this repository. It works in any directory `gh`
resolves a repository from; outside one, `gh` fails and so does this script.

Standard library only (Python 3.11+, `tomllib` for Cargo.lock).

Errors (first stderr line `ERR_<STAGE>_<WHAT>: <summary>`, then `Expected:`, `Actual:`,
and `Next:` lines; exit 1):
    ERR_SURVEY_USAGE  an unknown argument
    ERR_SURVEY_GH     `gh` missing, failing, or printing something other than a JSON list
"""
from __future__ import annotations

import errno
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[4]

# The `gh pr list --json` fields the survey reads.
FIELDS = ",".join([
    "number", "title", "body", "author", "headRefName", "mergeStateStatus",
    "statusCheckRollup", "files", "url",
])

# Dependabot, one dependency: "bump serde from 1.0.228 to 1.0.229", or "update eslint
# requirement from ^10.6.0 to ^10.7.0".
TITLE_BUMP = re.compile(
    r"(?:bump|update)\s+(?P<name>\S+?)(?:\s+requirement)?\s+from\s+(?P<from>\S+)\s+to\s+(?P<to>\S+)",
    re.IGNORECASE,
)
# Dependabot, a group: one "Updates `name` from A to B" line per dependency in the body.
BODY_BUMP = re.compile(r"^Updates `(?P<name>[^`]+)` from (?P<from>\S+) to (?P<to>\S+?)\.?$", re.MULTILINE)
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
    """The semver level of a move, judged the way Cargo's and npm's caret ranges judge
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
    """One verdict for a check rollup, failing closed; `failing` names each check held."""
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
    # Dependabot still calls its npm updater `npm_and_yarn`, pnpm included.
    if branch.startswith("dependabot/npm_and_yarn/"):
        return "npm"
    if branch.startswith("dependabot/github_actions/"):
        return "github-actions"
    if "rust-toolchain.toml" in files:
        return "rust-toolchain"
    if "mise.toml" in files:
        return "mise"
    if any(p == "Cargo.lock" or p.endswith("Cargo.toml") for p in files):
        return "cargo"
    if any(p == "pnpm-lock.yaml" or p.endswith("package.json") for p in files):
        return "npm"
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


_PLUGIN = re.compile(r"^(?:tauri-plugin-|@tauri-apps/plugin-)(?P<plugin>[a-z0-9-]+)\Z")


def pair_key(name: str) -> str | None:
    """Which pair a Tauri package belongs to: the `tauri` crate with `@tauri-apps/api` and
    `@tauri-apps/cli`, and `tauri-plugin-<x>` with `@tauri-apps/plugin-<x>`. The other
    `tauri-*` crates (tauri-build, tauri-utils, ...) carry their own version numbers and
    follow `tauri` through Cargo's resolution, so they pair with nothing."""
    if name in ("tauri", "@tauri-apps/api", "@tauri-apps/cli"):
        return "tauri"
    match = _PLUGIN.match(name)
    return f"plugin-{match.group('plugin')}" if match else None


def _is_tauri_family(name: str) -> bool:
    return name == "tauri" or name.startswith("tauri-") or name.startswith("@tauri-apps/")


def _step_of(key: str, version: str) -> str | None:
    """What a pair must agree on: `tauri` and its npm packages share a minor, but a plugin's
    crate and package must share the exact version, since Tauri ships breaking plugin
    changes in patch releases (https://v2.tauri.app/develop/updating-dependencies/)."""
    match = VERSION.search(version)
    if match is None:
        return None
    minor = f"{match.group(1)}.{match.group(2)}"
    return minor if key == "tauri" else f"{minor}.{match.group(3) or '0'}"


def tauri_report(rows: list[dict], current: dict[str, str]) -> dict:
    """Whether the batch leaves each Tauri pair in step, from the versions the checkout
    has now plus every move the open PRs make; and every Tauri major, which is a migration
    rather than a bump."""
    landed: dict[str, tuple[str, int | None]] = {n: (v, None) for n, v in current.items()}
    moved: dict[str, list[int]] = {}
    majors: list[dict] = []
    for row in rows:
        for b in row["bumps"]:
            if not _is_tauri_family(b["name"]):
                continue
            if semver_level(b["from"], b["to"]) == "major":
                majors.append({"pr": row["number"], **b})
            landed[b["name"]] = (b["to"], row["number"])
            key = pair_key(b["name"])
            if key is not None:
                prs = moved.setdefault(key, [])
                if row["number"] not in prs:
                    prs.append(row["number"])

    def aligned_alone(key: str, row: dict) -> bool:
        alone = dict(current)
        for b in row["bumps"]:
            alone[b["name"]] = b["to"]
        return len({_step_of(key, v) for n, v in alone.items() if pair_key(n) == key}) == 1

    pairs = []
    for key, prs in moved.items():
        members = sorted(
            ((n, vp) for n, vp in landed.items() if pair_key(n) == key),
            key=lambda item: item[0].startswith("@"),
        )
        versions = [
            {"name": n, "version": v} if pr is None else {"name": n, "version": v, "pr": pr}
            for n, (v, pr) in members
        ]
        aligned = len({_step_of(key, m["version"]) for m in versions}) == 1
        split = (aligned and len(prs) >= 2
                 and any(r["number"] in prs and not aligned_alone(key, r) for r in rows))
        pairs.append({"key": key, "prs": sorted(prs), "aligned": aligned, "split": split,
                      "versions": versions})
    return {"pairs": pairs, "majors": majors}


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def current_tauri_versions(root: Path) -> dict[str, str]:
    """The Tauri family's versions in this checkout: locked crates, and npm ranges as written."""
    versions: dict[str, str] = {}
    lock = _read_text(Path(root) / "Cargo.lock")
    if lock is not None:
        try:
            for pkg in _list(tomllib.loads(lock), "package"):
                name, version = _text(pkg, "name"), _text(pkg, "version")
                if name is not None and version is not None and pair_key(name) is not None:
                    versions[name] = version
        except tomllib.TOMLDecodeError:
            pass  # An unparsable lockfile gives no baseline; `cargo` itself reports it.
    manifest = _read_text(Path(root) / "package.json")
    if manifest is not None:
        try:
            parsed = json.loads(manifest)
        except ValueError:
            parsed = None  # pnpm reports a broken package.json better than this survey can.
        for section in ("dependencies", "devDependencies"):
            entries = _field(parsed, section)
            if not isinstance(entries, dict):
                continue
            for name, spec in entries.items():
                if isinstance(spec, str) and pair_key(name) is not None:
                    versions[name] = spec
    return versions


def _number(value: Any) -> int | float:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    try:
        return int(str(value))
    except ValueError:
        return 0


def collect(pulls: list) -> list[dict]:
    """One row per open Dependabot or Renovate PR, in PR-number order."""
    rows = []
    for pull in pulls:
        author = _text(_field(pull, "author"), "login") or ""
        if "dependabot" not in author and "renovate" not in author:
            continue
        title = _text(pull, "title") or ""
        branch = _text(pull, "headRefName") or ""
        files = [p for p in ((_text(f, "path") or "") for f in _list(pull, "files")) if p]
        bumps = parse_bumps(title, _text(pull, "body") or "")
        checks = check_summary(_list(pull, "statusCheckRollup"))
        merge_state = _text(pull, "mergeStateStatus")
        rows.append({
            "number": _number(_field(pull, "number") or 0),
            "title": title,
            "url": _text(pull, "url") or "",
            "branch": branch,
            "author": author,
            "ecosystem": ecosystem_of(branch, files),
            "bumps": bumps,
            "level": highest_level([semver_level(b["from"], b["to"]) for b in bumps]),
            "checks": checks["state"],
            "failingChecks": checks["failing"],
            "mergeState": "?" if merge_state is None else merge_state,
            "files": files,
        })
    return sorted(rows, key=lambda r: r["number"])


def format_report(rows: list[dict], tauri: dict) -> list[str]:
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
    if tauri["pairs"]:
        lines.append("")
        lines.append(
            "Tauri family (one branch; tauri on its packages' minor, a plugin on its package's version):"
        )
        for pair in tauri["pairs"]:
            members = ", ".join(
                f"{m['name']} {m['version']}" + ("" if m.get("pr") is None else f" (#{m['pr']})")
                for m in pair["versions"]
            )
            split = f", split across {' '.join(f'#{n}' for n in pair['prs'])}" if pair["split"] else ""
            lines.append(f"  {pair['key']}: {'aligned' if pair['aligned'] else 'MISMATCH'}{split} -- {members}")
    if tauri["majors"]:
        lines.append("")
        lines.append("Tauri major (a migration issue, never part of a batch):")
        for major in tauri["majors"]:
            lines.append(f"  #{major['pr']} {major['name']} {major['from']} -> {major['to']}")
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


def gh_pull_requests(root: Path, run: Callable = run_gh) -> list:
    status, stdout, stderr = run(
        ["pr", "list", "--state", "open", "--limit", "100", "--json", FIELDS], root)

    def failure(actual: str) -> ScriptError:
        return ScriptError(
            "ERR_SURVEY_GH",
            "`gh pr list` did not return the open pull requests",
            "the GitHub CLI on PATH, authenticated, printing a JSON list",
            actual,
            "run `gh auth status` and confirm this checkout has a GitHub remote",
        )

    if status != 0:
        raise failure(stderr.strip() or f"exit status {'null' if status is None else status}")
    try:
        parsed = json.loads("[]" if stdout == "" else stdout)
    except ValueError:
        raise failure(f"output that is not JSON: {stdout[:120]}") from None
    if not isinstance(parsed, list):
        raise failure(f"JSON that is not a list: {stdout[:120]}")
    return parsed


def main(argv: list[str] | None = None, *, root: Path | None = None,
         run: Callable = run_gh, log: Callable[[str], None] = print) -> None:
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
            "run `python3 .agents/skills/merging-dependency-prs/scripts/survey_prs.py`",
        )
    rows = collect(gh_pull_requests(root, run))
    tauri = tauri_report(rows, current_tauri_versions(root))
    if "--json" in argv:
        log(json.dumps({"rows": rows, "contested": contested_files(rows), "tauri": tauri},
                       indent=2, ensure_ascii=False))
        return
    if not rows:
        log("No open Dependabot or Renovate pull requests.")
        return
    for line in format_report(rows, tauri):
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
