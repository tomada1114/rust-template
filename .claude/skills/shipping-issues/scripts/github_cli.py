"""The label writers' shared gh subprocess and label parsing boundary."""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Callable
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from issue_types import Label

PERMISSION_MARKERS = (
    "HTTP 403",
    "Resource not accessible",
    "must have admin",
    "does not have permission",
    "HTTP 404: Not Found",
)


def gh(
    args: list[str], check: bool = True, *, repo: str | None = None
) -> subprocess.CompletedProcess[str]:
    """Run a qualified UTF-8 gh command, preserving the writers' exit codes."""
    if repo:
        args = [*args, "--repo", repo]
    try:
        return subprocess.run(
            ["gh", *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=check,
            timeout=120,
        )
    except FileNotFoundError:
        print("error: gh CLI not found", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.TimeoutExpired:
        print(f"error: gh {' '.join(args)} timed out", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr or ""
        if any(marker in stderr for marker in PERMISSION_MARKERS):
            print(
                f"verdict: NO_WRITE_ACCESS\nerror: gh {' '.join(args)}:\n{stderr}",
                file=sys.stderr,
            )
            raise SystemExit(2)
        print(f"error: gh {' '.join(args)} failed:\n{stderr}", file=sys.stderr)
        raise SystemExit(1)


def read_repo_labels(
    run: Callable[[list[str]], subprocess.CompletedProcess[str]],
) -> list[str]:
    """Read canonical names once; writers retain their local runner test seam."""
    raw = run(["label", "list", "--limit", "500", "--json", "name"]).stdout or "[]"
    labels = cast("list[Label]", json.loads(raw))
    return [label["name"] for label in labels]
