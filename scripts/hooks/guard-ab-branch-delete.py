#!/usr/bin/env python3
"""Allow unattended branch deletion only for gate-authorized ab/* challengers."""
import hashlib
import json
import os
import re
import shlex
import sys
import time

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if data.get("tool_name") != "Bash":
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command", "") or ""
if not re.search(r"\bgit\b", cmd):
    sys.exit(0)

branches = []
try:
    tokens = shlex.split(cmd)
except ValueError:
    tokens = cmd.split()

for i, token in enumerate(tokens):
    if token in ("-d", "-D") and i > 0 and tokens[i - 1] == "branch" and i + 1 < len(tokens):
        branches.append(tokens[i + 1])
    if token == "--delete" and i > 0 and tokens[i - 1] == "branch" and i + 1 < len(tokens):
        branches.append(tokens[i + 1])
    if token == "--delete" and i > 0 and "push" in tokens[:i] and i + 1 < len(tokens):
        branches.append(tokens[i + 1])

if not branches:
    sys.exit(0)

for branch in branches:
    if not re.fullmatch(r"ab/[A-Za-z0-9][A-Za-z0-9._/-]{0,119}", branch):
        sys.stderr.write("BLOCKED: unattended deletion is authorized only for literal ab/* challenger branches.\n")
        sys.exit(2)
    digest = hashlib.sha256(branch.encode()).hexdigest()
    marker = f"/tmp/mev-ab-cleanup-{digest}"
    try:
        age = time.time() - os.path.getmtime(marker)
        record = json.load(open(marker))
    except Exception:
        age = 10**9
        record = {}
    if age > 7200 or record.get("branch") != branch or record.get("verdict") not in ("win", "lose", "resolved"):
        sys.stderr.write(
            "BLOCKED: run `npm run ab-canary-gate -- <report> --phase decision --authorize-cleanup` "
            f"before deleting {branch}. Unresolved branches must be retained; main-resolved branches use "
            "`--phase close --authorize-cleanup`.\n"
        )
        sys.exit(2)

sys.exit(0)
