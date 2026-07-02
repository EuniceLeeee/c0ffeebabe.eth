#!/usr/bin/env python3
"""PreToolUse(AskUserQuestion) guard — ENFORCES CLAUDE.md rule 14.

A multi-round / user-away workflow means the user is NOT at the keyboard: run-scoped, architecture,
and scope calls are the agent's to make (pick the option best for the extraction goal + PROCEED +
record it), NOT to block on with AskUserQuestion. This hook blocks such questions WHILE a workflow
is active — but deliberately ALLOWS the real stop conditions that must still reach the human:
go-live / broadcast, CU-cap, destructive / irreversible, private-key.

Active-workflow signal: the marker file /tmp/mev-workflow-active exists (the agent creates it when a
multi-round/away workflow starts, removes it when it ends). No marker -> asking is always fine.

Exit 0 = allow; exit 2 = BLOCK the AskUserQuestion and surface stderr to the model.
"""
import sys, json, os

MARKER = "/tmp/mev-workflow-active"

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if data.get("tool_name") != "AskUserQuestion":
    sys.exit(0)
if not os.path.exists(MARKER):
    sys.exit(0)  # no active workflow -> the user is present, asking is fine

# All question / header / option text, lowercased, to scan for real stop-condition keywords.
blob = json.dumps(data.get("tool_input") or {}, ensure_ascii=False).lower()

STOP_KEYWORDS = [
    "broadcast", "go-live", "go live", "mainnet", "main-net", "上线", "广播", "主网", "实盘",
    "cu cap", "cu-cap", "cu_cap", "cu budget", "daily cap", "预算", "费用上限",
    "delete", "rm -rf", "drop table", "destructive", "irreversible", "不可逆", "删除", "销毁", "覆盖",
    "private key", "私钥", "signing key",
]
if any(k in blob for k in STOP_KEYWORDS):
    sys.exit(0)  # a genuine stop condition -> still ask the human

sys.stderr.write(
    "BLOCKED (CLAUDE.md rule 14): a multi-round workflow is ACTIVE (/tmp/mev-workflow-active) = the "
    "user is away. Do NOT ask a run-scoped / architecture / scope question — pick the option best for "
    "the extraction goal (catch more MEV) and PROCEED, then RECORD the decision (Hermes md 'Claude "
    "Final Decision' / Findings Ledger for run-scoped; CLAUDE.md for durable governance; memory for "
    "cross-session facts). AskUserQuestion mid-workflow is reserved for the REAL stop conditions only: "
    "go-live/broadcast, CU-cap, destructive/irreversible, private-key. If this genuinely IS one of "
    "those, phrase it with that keyword; otherwise decide it yourself and keep going.\n"
)
sys.exit(2)
