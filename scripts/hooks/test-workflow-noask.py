#!/usr/bin/env python3
import json
import os
import subprocess
import unittest

HOOK = os.path.join(os.path.dirname(__file__), "guard-workflow-noask.py")
MARKER = "/tmp/mev-workflow-active"


def run(question: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [HOOK],
        input=json.dumps({"tool_name": "AskUserQuestion", "tool_input": {"question": question}}),
        text=True,
        capture_output=True,
        check=False,
    )


class NoAskTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.had_marker = os.path.exists(MARKER)
        open(MARKER, "a").close()

    @classmethod
    def tearDownClass(cls) -> None:
        if not cls.had_marker and os.path.exists(MARKER):
            os.unlink(MARKER)

    def test_blocks_routine_and_already_authorized_ab_questions(self) -> None:
        self.assertEqual(run("Which blocker should I fix next?").returncode, 2)
        self.assertEqual(run("Should I run the authorized bounded-live A/B challenger?").returncode, 2)
        self.assertEqual(run("Should I delete branch ab/test after its cleanup gate passed?").returncode, 2)

    def test_allows_real_out_of_envelope_stops(self) -> None:
        self.assertEqual(run("Should I fund wallet B above its cap?").returncode, 0)
        self.assertEqual(run("Should I delete branch main?").returncode, 0)


if __name__ == "__main__":
    unittest.main()
