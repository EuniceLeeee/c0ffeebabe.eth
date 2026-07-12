#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess
import tempfile
import time
import unittest

HOOK = os.path.join(os.path.dirname(__file__), "guard-ab-branch-delete.py")


def run(command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [HOOK],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}),
        text=True,
        capture_output=True,
        check=False,
    )


class GuardTest(unittest.TestCase):
    def marker(self, branch: str, verdict: str = "win") -> str:
        path = f"/tmp/mev-ab-cleanup-{hashlib.sha256(branch.encode()).hexdigest()}"
        with open(path, "w") as f:
            json.dump({"branch": branch, "verdict": verdict, "created_at": int(time.time() * 1000)}, f)
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        return path

    def test_blocks_main(self) -> None:
        self.assertEqual(run("git branch -D main").returncode, 2)

    def test_blocks_ungated_ab(self) -> None:
        self.assertEqual(run("git push origin --delete ab/test").returncode, 2)

    def test_allows_gated_ab_local_and_remote(self) -> None:
        self.marker("ab/test")
        self.assertEqual(run("git branch -D ab/test").returncode, 0)
        self.assertEqual(run("git branch --delete ab/test").returncode, 0)
        self.assertEqual(run("git push origin --delete ab/test").returncode, 0)

    def test_allows_main_resolved_ab_cleanup(self) -> None:
        self.marker("ab/resolved", "resolved")
        self.assertEqual(run("git branch -D ab/resolved").returncode, 0)
        self.assertEqual(run("git push origin --delete ab/resolved").returncode, 0)


if __name__ == "__main__":
    unittest.main()
