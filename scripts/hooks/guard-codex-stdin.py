#!/usr/bin/env python3
"""PreToolUse(Bash) guard — ENFORCES HERMES.md rule 11.

A raw `codex ... exec` launch inherits the shell's stdin and hangs forever on
"Reading additional input from stdin..." (2026-07-02: a plan-review sat stdin-hung 15 min).
Docs kept getting missed, so this hook is the hard backstop: it BLOCKS the Bash tool call when
a real `codex exec` launch does not go through scripts/codex-run.sh and lacks `< /dev/null`.

Exit 0 = allow; exit 2 = BLOCK the Bash call and surface stderr to the model.

Detection strips quoted spans first, so a `git commit -m "... codex exec -s read-only ..."`
or any prose that merely MENTIONS the invocation is never blocked — only a genuine launch,
where `codex` / `exec` / `-s <sandbox>` appear as bare shell tokens, triggers the check.
"""
import sys, json, re

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if data.get("tool_name") != "Bash":
    sys.exit(0)

cmd = (data.get("tool_input") or {}).get("command", "") or ""
if not cmd:
    sys.exit(0)

# Remove quoted spans so mentions inside "..." / '...' (commit messages, -m args, briefs) don't match.
stripped = re.sub(r'"[^"]*"', " ", cmd)
stripped = re.sub(r"'[^']*'", " ", stripped)

is_launch = (
    re.search(r"\bcodex\b", stripped)
    and re.search(r"(^|\s)exec(\s|$)", stripped)
    and re.search(r"-s\s+(read-only|workspace-write)", stripped)
)

if is_launch:
    # Sanctioned: the wrapper (guards baked in) or an explicit inline stdin guard.
    if "codex-run.sh" in cmd or "/dev/null" in cmd:
        sys.exit(0)
    sys.stderr.write(
        "BLOCKED (HERMES.md rule 11): do NOT hand-write 'codex exec'. Launch codex via "
        "scripts/codex-run.sh <read-only|workspace-write> <brief-file> <out-prefix> — it bakes in "
        "'< /dev/null' (stdin-hang guard), caffeinate, -o/--json to files, and a 30s stdin-hang "
        "watchdog. A raw 'codex exec' without '< /dev/null' hangs on stdin forever "
        "(2026-07-02: 15 min lost). If you truly must inline, include '< /dev/null'.\n"
    )
    sys.exit(2)

sys.exit(0)
