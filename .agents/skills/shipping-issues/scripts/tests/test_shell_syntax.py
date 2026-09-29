#!/usr/bin/env python3
"""Every bundled shell script parses under the system bash.

macOS ships bash 3.2 as /bin/bash, and `#!/usr/bin/env bash` picks it up on a Mac
without Homebrew's bash first on PATH. bash 3.2 misreads some constructs bash 5
accepts (a here-document inside `$(...)` whose body holds a backtick or quote), so a
script that passes on Linux can fail to parse on the machine that runs it.

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
     (from the shipping-issues skill directory)
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


SCRIPTS = sorted((Path(__file__).resolve().parent.parent).glob("*.sh"))


class ShellSyntaxTest(unittest.TestCase):
    def test_there_are_scripts_to_check(self):
        self.assertGreater(len(SCRIPTS), 0)

    def test_every_script_parses_under_the_system_bash(self):
        for script in SCRIPTS:
            with self.subTest(script=script.name):
                proc = subprocess.run(
                    ["/bin/bash", "-n", str(script)],
                    text=True,
                    capture_output=True,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)


if __name__ == "__main__":
    unittest.main()
