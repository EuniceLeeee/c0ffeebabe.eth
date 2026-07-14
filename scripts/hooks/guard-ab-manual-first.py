#!/usr/bin/env python3
"""PreToolUse guard: the canonical A/B comparator may run only after a trusted manual seal.

This does not claim to inspect an analyst's thoughts. It mechanically prevents the repository's canonical
comparison implementation from being invoked through Bash before ab-manual-verdict has sealed the exact
A/B log bytes.
"""

import hashlib
import json
import os
import re
import shlex
import sys


def deny(message):
    sys.stderr.write("AB MANUAL-FIRST BLOCKED: " + message + "\n")
    raise SystemExit(2)


def sha256(path_value):
    with open(path_value, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


try:
    payload = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
if payload.get("tool_name") != "Bash":
    raise SystemExit(0)
command = str((payload.get("tool_input") or {}).get("command") or "")

# Scratch imports are an untracked alternate comparator and therefore never satisfy the canonical gate.
for match in re.finditer(r"(?:node[^;&|]*|tsx\s+|python3?\s+)(/tmp/\S+|\S*/_[^\s;&|]+\.(?:ts|js|mjs|py))", command):
    try:
        source = open(match.group(1), "r").read()
    except Exception:
        continue
    if "compareBlockScanLogs" in source:
        deny("scratch code imports compareBlockScanLogs; use ab-manual-verdict then ab-canary-compare")

if "compareBlockScanLogs" in command and "ab-canary-compare" not in command:
    deny("direct comparison implementation invocation is forbidden; use the trusted CLI")
if "ab-canary-compare" not in command:
    raise SystemExit(0)

try:
    tokens = shlex.split(command)
except Exception:
    deny("cannot parse comparator command")

def option(name):
    try:
        index = tokens.index(name)
        return tokens[index + 1]
    except Exception:
        return None

manual_path = option("--manual-verdict")
a_log = option("--a-log")
b_log = option("--b-log")
if not manual_path or not a_log or not b_log:
    deny("comparator requires --manual-verdict, --a-log, and --b-log")
try:
    with open(manual_path, "r") as handle:
        manual = json.load(handle)
    if (manual.get("schema_version") != 2
            or not re.fullmatch(r"[a-f0-9]{48}", str(manual.get("seal_nonce") or ""))
            or manual.get("a_log_sha256") != sha256(a_log)
            or manual.get("b_log_sha256") != sha256(b_log)
            or manual.get("a_log_bytes") != os.path.getsize(a_log)
            or manual.get("b_log_bytes") != os.path.getsize(b_log)):
        deny("manual artifact is not a trusted seal for these exact log bytes")
except SystemExit:
    raise
except Exception as error:
    deny(f"cannot validate manual seal: {error}")

raise SystemExit(0)
