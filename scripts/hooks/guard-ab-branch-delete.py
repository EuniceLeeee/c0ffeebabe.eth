#!/usr/bin/env python3
"""Guard ordinary managed-branch deletion commands; this is not an auth boundary."""
import hashlib
import json
import os
import re
import shlex
import sys
import time


AB_BRANCH = re.compile(r"ab/[A-Za-z0-9][A-Za-z0-9._/-]{0,119}")
AB_MARKER_MAX_AGE_SECONDS = 7200
NON_ROUTE_CODEX_OVERRIDE = "MEV_NON_ROUTE_CODEX_CLEANUP=1"


def normalize_branch(value: str) -> str:
    for prefix in ("refs/heads/", "refs/remotes/origin/", "origin/"):
        if value.startswith(prefix):
            return value[len(prefix):]
    return value


def ab_cleanup_authorized(branch: str) -> bool:
    if not AB_BRANCH.fullmatch(branch):
        return False
    digest = hashlib.sha256(branch.encode()).hexdigest()
    marker = f"/tmp/mev-ab-cleanup-{digest}"
    try:
        age = time.time() - os.path.getmtime(marker)
        with open(marker, encoding="utf8") as handle:
            record = json.load(handle)
    except (OSError, ValueError, TypeError):
        return False
    return (
        0 <= age <= AB_MARKER_MAX_AGE_SECONDS
        and record.get("branch") == branch
        and record.get("verdict") in {"win", "lose", "resolved"}
    )


def deletion_targets(tokens: list[str]) -> list[str]:
    git_index = next(
        (index for index, token in enumerate(tokens) if os.path.basename(token) == "git"),
        -1,
    )
    if git_index < 0:
        return []
    args = tokens[git_index + 1:]
    while args and args[0] in {"-C", "-c", "--git-dir", "--work-tree"}:
        args = args[2:]
    if not args:
        return []
    command, args = args[0], args[1:]

    if command == "branch":
        deleting = any(
            token in {"-d", "-D", "--delete"} or token.startswith("--delete=")
            for token in args
        )
        if not deleting:
            return []
        inline = [
            token.split("=", 1)[1]
            for token in args
            if token.startswith("--delete=")
        ]
        return inline + [token for token in args if not token.startswith("-")]

    if command == "push":
        inline = [
            token.split("=", 1)[1]
            for token in args
            if token.startswith("--delete=")
        ]
        refspecs = [
            token.lstrip("+:")
            for token in args
            if token.startswith(":") or token.startswith("+:")
        ]
        deleting = any(token in {"-d", "--delete"} for token in args) or bool(inline)
        if not deleting:
            return refspecs
        operands = [
            token for token in args
            if not token.startswith("-") and not token.startswith((":", "+:"))
        ]
        return inline + operands[1:] + refspecs

    if command == "update-ref":
        for index, token in enumerate(args):
            if token in {"-d", "--delete"} and index + 1 < len(args):
                return [args[index + 1]]
            if token.startswith("--delete="):
                return [token.split("=", 1)[1]]
    return []


def blocked_message(target: str, *, non_route_codex_cleanup: bool) -> str | None:
    branch = normalize_branch(target)
    if branch == "main":
        return "BLOCKED: main branch deletion is never allowed.\n"
    if branch.startswith("codex/") and not non_route_codex_cleanup:
        return (
            "BLOCKED: raw deletion of codex/* is forbidden. "
            "Use `six-step-validation-gate --finalize-cleanup` after final validation, "
            "or set MEV_NON_ROUTE_CODEX_CLEANUP=1 only for an explicitly authorized "
            "branch outside the deterministic-route lifecycle.\n"
        )
    if branch.startswith("ab/") and not ab_cleanup_authorized(branch):
        return (
            "BLOCKED: run the trusted A/B decision/close gate with "
            "`--authorize-cleanup` before deleting this ab/* branch.\n"
        )
    return None


try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if payload.get("tool_name") != "Bash":
    sys.exit(0)

command = (payload.get("tool_input") or {}).get("command", "") or ""
try:
    tokens = shlex.split(command)
except ValueError:
    sys.exit(0)

for target in deletion_targets(tokens):
    message = blocked_message(
        target,
        non_route_codex_cleanup=NON_ROUTE_CODEX_OVERRIDE in tokens,
    )
    if message:
        sys.stderr.write(message)
        sys.exit(2)
sys.exit(0)
