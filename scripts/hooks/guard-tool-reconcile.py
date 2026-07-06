#!/usr/bin/env python3
"""PostToolUse(Write|Bash) guard — ENFORCES CLAUDE.md §5 / HERMES.md rules 16+17 as RECONCILE-after.

Why POST, not a PRE-block (operator insight 2026-07-06): a pre-block that forces "always use the
canonical tool" is anti-fragile-NEGATIVE — it suppresses the very hand analysis that catches a STALE
tool (rule 16: manual analysis is a TEST of our tooling). The 2026-07-06 hand-rolled dead-edge script
was WRONG, but it also DISCOVERED a real thing (the pool universe truncates low-volume pools). The right
gate keeps the hand analysis AND makes it reconcile with the tool, so the two verify each other:
  - hand agrees with tool  -> confirmed.
  - hand disagrees with tool -> a FINDING: either the tool is STALE (fix it — rule 16 tooling_defect) or
    the hand analysis is wrong (bundle-postmortem's in_graph would have caught the 'dead edge' error).

Fires AFTER a hand-rolled analysis script is written/run and REMINDS (exit 2 -> stderr to the model) to
run the canonical tool on the same input and record the reconciliation. It does not block (the run
already happened); it forces the cross-check before the conclusion is trusted/reported.

Escape hatch: a `tool-reconciled:` line in the script/command silences it (you already reconciled).
Scope is TIGHT (no noise on real work): only throwaway targets (_*.ts/.py or /tmp//scratchpad/) with
>=2 venue/pool/trace/PnL-extraction markers; real tools/tests/docs under src/ never fire.
"""
import sys, json, re, os

TOOLS = (
    "  - bundle-postmortem.ts  extractTouchedVenues(receipt, graph) + venue.in_graph (pool-in-graph truth)\n"
    "  - census-report.ts      not-seen competitor venue extraction\n"
    "  - discovery/venue-evidence.ts  captureAllVenues / extractVenueCandidates\n"
    "  - discovery/venue-discovery-bq.ts  BigQuery log-export -> venues\n"
    "  - searcher/auto-close-route-gap.ts  force-include missing univ2/3/4 pools\n"
    "  - pnl/arb-profit.ts (priceArb) + cli/tx-profit.ts  builder-payment-aware PnL\n"
)
MARKERS = [
    "receiptLogs", "deriveEdgeKindsFromLogs", "deriveProtocolActionsFromLogs", "extractTouchedVenues",
    "captureAllVenues", "extractVenueCandidates", "traceTransaction", "callTracer", "debug_trace",
    "active-pools", "previewRedeem", "asset()", "token0", "token1", "topic0", "log_address",
    "in_graph", "priceArb", "builderPayment", "/discovery/", "/learning/edge-kinds", "/pnl/",
]

def is_scratch(p):
    if not p:
        return False
    base = p.rsplit("/", 1)[-1]
    if not (base.endswith(".ts") or base.endswith(".py")):
        return False
    return base.startswith("_") or "/tmp/" in p or "/scratchpad/" in p

def markers(t):
    return sum(1 for m in MARKERS if m in t)

def read(p):
    try:
        with open(p, "r") as f:
            return f.read()
    except Exception:
        return ""

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = data.get("tool_name")
ti = data.get("tool_input") or {}
target, body = "", ""

if tool == "Write":
    target = ti.get("file_path", "") or ""
    body = ti.get("content", "") or ""
    if not is_scratch(target):
        sys.exit(0)
elif tool == "Bash":
    cmd = ti.get("command", "") or ""
    body = cmd
    # a heredoc/redirect that CREATES a scratch script, or a run (node/tsx/python) of one
    m = re.search(r"(?:>\s*|node\s[^\n|;&]*?|tsx\s|python3?\s)([^\s;|&'\"]+\.(?:ts|py))", cmd)
    target = m.group(1) if m else ""
    if not is_scratch(target):
        sys.exit(0)
    # for a RUN, the extraction markers live in the file on disk, not the command
    if os.path.exists(target):
        body += "\n" + read(target)
else:
    sys.exit(0)

if markers(body) < 2:
    sys.exit(0)
if "tool-reconciled:" in body:
    sys.exit(0)

sys.stderr.write(
    "RECONCILE REQUIRED (CLAUDE.md §5 / HERMES rules 16+17): you ran a hand-rolled analysis "
    f"({target}) that re-derives venue/pool/trace/PnL facts an existing tool also computes. Per rule 16 "
    "the hand analysis is a TEST of the tool — run the canonical tool on the SAME input and RECONCILE "
    "before trusting/reporting the result:\n"
    + TOOLS
    + "Then record the outcome so this stops firing:\n"
    "  - agree  -> add a `tool-reconciled: <tool> agrees` line.\n"
    "  - differ -> that IS the finding: fix the STALE tool (rule 16 tooling_defect) OR the wrong hand "
    "analysis (e.g. bundle-postmortem in_graph shows a 'dead edge' is really an unindexed pool = pool gap), "
    "then add `tool-reconciled: <tool> diverged -> <what you fixed>`.\n"
)
sys.exit(2)
