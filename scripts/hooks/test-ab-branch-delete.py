#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess
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
        with open(path, "w") as handle:
            json.dump({"branch": branch, "verdict": verdict}, handle)
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        return path

    def assert_blocked(self, command: str, text: str | None = None) -> None:
        result = run(command)
        self.assertEqual(result.returncode, 2, (command, result.stderr))
        if text:
            self.assertIn(text, result.stderr)

    def test_main_is_always_blocked(self) -> None:
        self.assert_blocked("git branch -D main", "main branch deletion")
        self.assert_blocked("git push origin --delete main", "main branch deletion")

    def test_codex_requires_six_step_finalizer(self) -> None:
        for command in (
            "git branch -d codex/test",
            "git branch -D codex/test",
            "git push origin --delete codex/test",
            "git push -d origin codex/test",
            "git push origin :refs/heads/codex/test",
            "git update-ref -d refs/heads/codex/test",
        ):
            with self.subTest(command=command):
                self.assert_blocked(command, "six-step-validation-gate --finalize-cleanup")

    def test_explicit_non_route_codex_cleanup_is_untouched(self) -> None:
        for command in (
            "MEV_NON_ROUTE_CODEX_CLEANUP=1 git branch -D codex/telemetry",
            "env MEV_NON_ROUTE_CODEX_CLEANUP=1 git push origin --delete codex/telemetry",
            "MEV_NON_ROUTE_CODEX_CLEANUP=1 git update-ref -d refs/heads/codex/telemetry",
        ):
            with self.subTest(command=command):
                self.assertEqual(run(command).returncode, 0)

    def test_non_route_codex_override_never_authorizes_main_or_ab(self) -> None:
        self.assert_blocked(
            "MEV_NON_ROUTE_CODEX_CLEANUP=1 git branch -D main",
            "main branch deletion",
        )
        self.assert_blocked(
            "MEV_NON_ROUTE_CODEX_CLEANUP=1 git branch -D ab/test",
            "trusted A/B decision/close gate",
        )

    def test_ungated_ab_cleanup_is_blocked(self) -> None:
        self.assert_blocked("git branch -D ab/test", "trusted A/B decision/close gate")
        self.assert_blocked("git push origin --delete ab/test", "trusted A/B decision/close gate")

    def test_existing_ab_marker_allows_old_cleanup_flow(self) -> None:
        self.marker("ab/test")
        self.assertEqual(run("git branch -D ab/test").returncode, 0)
        self.assertEqual(run("git push origin --delete ab/test").returncode, 0)
        self.assertEqual(run("git update-ref -d refs/heads/ab/test").returncode, 0)

    def test_resolved_marker_allows_old_cleanup_flow(self) -> None:
        self.marker("ab/resolved", "resolved")
        self.assertEqual(run("git branch --delete ab/resolved").returncode, 0)
        self.assertEqual(run("git push origin :refs/heads/ab/resolved").returncode, 0)

    def test_invalid_or_expired_ab_marker_is_blocked(self) -> None:
        path = self.marker("ab/test", "needs_escalation")
        self.assert_blocked("git branch -D ab/test")
        with open(path, "w") as handle:
            json.dump({"branch": "ab/test", "verdict": "win"}, handle)
        expired = time.time() - 7201
        os.utime(path, (expired, expired))
        self.assert_blocked("git branch -D ab/test")

    def test_ab_marker_never_authorizes_codex_cleanup(self) -> None:
        self.marker("codex/test")
        self.assert_blocked("git branch -D codex/test")

    def test_other_branches_and_non_delete_commands_are_untouched(self) -> None:
        for command in (
            "git branch -D feature/test",
            "git status",
            "git push origin codex/test",
            "npm run ab-canary-gate -- report.md --phase decision --authorize-cleanup",
            "npm run six-step-validation-gate -- --phase final --finalize-cleanup",
        ):
            with self.subTest(command=command):
                self.assertEqual(run(command).returncode, 0)


if __name__ == "__main__":
    unittest.main()
