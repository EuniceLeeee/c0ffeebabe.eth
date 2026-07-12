#!/usr/bin/env python3
"""PreToolUse(AskUserQuestion) guard — ENFORCES HERMES.md rule 14.

A multi-round / user-away workflow means the user is NOT at the keyboard: run-scoped, architecture,
and scope calls are the agent's to make (pick the option best for the extraction goal + PROCEED +
record it), NOT to block on with AskUserQuestion. This hook blocks such questions WHILE a workflow
is active — but deliberately ALLOWS the real stop conditions that must still reach the human:
out-of-envelope broadcast/funding/cap/key changes, standing-credit enablement, CU-cap, and unrelated
destructive / irreversible operations. The dated bounded-live A/B and gate-authorized ab/* cleanup
are already authorized and are not ask points.

Active-workflow signal: the marker file /tmp/mev-workflow-active exists (the agent creates it when a
multi-round/away workflow starts, removes it when it ends). No marker -> asking is always fine.

Exit 0 = allow; exit 2 = BLOCK the AskUserQuestion and surface stderr to the model.
"""
import sys, json, os, re

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
    "out-of-envelope", "outside the envelope", "超出封套", "封套外",
    "fund wallet", "funding", "充值", "raise cap", "increase cap", "提高上限",
    "credit-live", "standing credit", "standing-position", "留仓", "开仓",
    "cu cap", "cu-cap", "cu_cap", "cu budget", "daily cap", "预算", "费用上限",
    "delete", "rm -rf", "drop table", "destructive", "irreversible", "不可逆", "删除", "销毁", "覆盖",
    "private key", "私钥", "signing key",
]
authorized_ab_cleanup = bool(re.search(r"\bab/[a-z0-9]", blob)) \
    and any(k in blob for k in ("branch", "分支")) \
    and any(k in blob for k in ("delete", "删除"))
if any(k in blob for k in STOP_KEYWORDS) and not authorized_ab_cleanup:
    sys.exit(0)  # a genuine stop condition -> still ask the human

sys.stderr.write(
    "BLOCKED (HERMES.md rule 14): a multi-round workflow is ACTIVE (/tmp/mev-workflow-active) = the "
    "user is away. Do NOT ask a run-scoped / architecture / scope question — pick the option best for "
    "the extraction goal (catch more MEV) and PROCEED, then RECORD the decision (Hermes md 'Claude "
    "Final Decision' / Findings Ledger for run-scoped; CLAUDE.md for durable governance; memory for "
    "cross-session facts). AskUserQuestion mid-workflow is reserved for the REAL stop conditions only: "
    "out-of-envelope funding/cap/key/standing-credit, CU-cap, or unrelated destructive operations. "
    "Bounded-live A/B and gate-authorized literal ab/* cleanup are already authorized. If this genuinely IS one of "
    "those, phrase it with that keyword; otherwise decide it yourself and keep going.\n"
)
sys.exit(2)
