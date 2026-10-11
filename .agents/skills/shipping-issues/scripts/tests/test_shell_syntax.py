#!/usr/bin/env python3
"""Every bundled shell script parses under the system bash.

macOS ships bash 3.2 as /bin/bash, and `#!/usr/bin/env bash` picks it up on a Mac
without Homebrew's bash first on PATH. bash 3.2 misreads some constructs bash 5
accepts (a here-document inside `$(...)` whose body holds a backtick or quote), so a
script that passes on Linux can fail to parse on the machine that runs it.

The reverse holds for awk: Ubuntu's default awk is mawk, whose 1.3.4 release
(Ubuntu 24.04, the Claude Code cloud VM) panics on an interval expression such
as `{0,3}` in a regex literal, while macOS awk and GitHub's runners (gawk)
accept it. So no awk regex in a bundled script uses one.

CI runs this on Linux, where /bin/bash is bash 5, so CI cannot check bash 3.2: only
a run on a Mac (every `just check` there) does.

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
"""

from __future__ import annotations

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

# tests/ -> scripts/ -> shipping-issues/ -> the skills tree this copy sits in
# (.agents/skills/ in the source, so the .claude/skills/ mirror is not scanned).
SKILLS_ROOT = Path(__file__).resolve().parents[3]


def discover_scripts(skills_root):
    """Every bundled shell script under any skill, not only this one."""
    return sorted(skills_root.rglob("*.sh"))


SCRIPTS = discover_scripts(SKILLS_ROOT)

# A /.../ regex literal holding a {n}, {n,} or {n,m} interval. bash's own
# `[[ =~ ]]` regexes carry no slashes, so they never match.
AWK_INTERVAL = re.compile(r"/[^/\n]*\{\d+(,\d*)?\}[^/\n]*/")


class ShellSyntaxTest(unittest.TestCase):
    def test_there_are_scripts_to_check(self):
        self.assertGreater(len(SCRIPTS), 0)

    def test_discovery_reaches_scripts_in_every_skill(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            own = root / "shipping-issues" / "scripts" / "own.sh"
            other = root / "other-skill" / "scripts" / "nested" / "other.sh"
            for path in (own, other):
                path.parent.mkdir(parents=True)
                path.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            (root / "other-skill" / "notes.txt").write_text("", encoding="utf-8")

            self.assertEqual(discover_scripts(root), sorted([own, other]))

    def test_every_script_parses_under_the_system_bash(self):
        for script in SCRIPTS:
            with self.subTest(script=str(script.relative_to(SKILLS_ROOT))):
                proc = subprocess.run(
                    ["/bin/bash", "-n", str(script)],
                    text=True,
                    capture_output=True,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_no_awk_regex_uses_an_interval_expression(self):
        for script in SCRIPTS:
            text = script.read_text(encoding="utf-8")
            for number, line in enumerate(text.splitlines(), start=1):
                with self.subTest(
                    script=str(script.relative_to(SKILLS_ROOT)), line=number
                ):
                    self.assertIsNone(AWK_INTERVAL.search(line), line.strip())


if __name__ == "__main__":
    unittest.main()
