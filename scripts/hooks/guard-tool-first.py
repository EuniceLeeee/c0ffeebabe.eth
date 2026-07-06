#!/usr/bin/env python3
"""PreToolUse(Write|Bash) guard — ENFORCES CLAUDE.md §5 / HERMES.md rule 17 (tool-first).

Rule 17 was prose only, so it "didn't take effect": a session hand-rolled a venue/pool
dead-edge analysis in throwaway scripts (`analysis/_venue-full-list.ts`, `/tmp/_vsplit.ts`, …)
instead of using bundle-postmortem's `extractTouchedVenues` + `in_graph` — and reached a WRONG
"dead edge" conclusion the existing tool would have avoided (2026-07-06). This hook is the hard
backstop: it BLOCKS the creation of a SCRATCH analysis script that re-implements what an existing
analysis tool already does, UNLESS the file affirms the tool-first check with a
`tool-first-checked:` line.

Exit 0 = allow; exit 2 = BLOCK and surface stderr to the model.

Scope is deliberately TIGHT (no false positives on real work):
  - only THROWAWAY targets: basename starts with '_', OR path under /tmp/ or /scratchpad/, ending .ts/.py.
    A file under analysis/src/cli|discovery|pnl|test or listener/... is the CODIFIED form rule 17
    WANTS — never blocked.
  - AND the body has >= 2 analysis-extraction markers (receipt/log/venue/pool/trace primitives).
  - AND no `tool-first-checked:` affirmation is present.
The affirmation is the escape hatch: hand analysis IS allowed once you've consciously confirmed no
existing tool fits — you just have to say which tools you checked + why, in one line.
"""
import sys, json, re

TOOLS = (
    "  - analysis/src/cli/bundle-postmortem.ts  -> extractTouchedVenues(receipt, graph) + venue.in_graph\n"
    "  - analysis/src/cli/census-report.ts      -> not-seen competitor venue extraction\n"
    "  - analysis/src/discovery/venue-evidence.ts -> captureAllVenues / extractVenueCandidates\n"
    "  - analysis/src/discovery/venue-discovery-bq.ts -> BigQuery log-export -> venues\n"
    "  - listener/src/searcher/auto-close-route-gap.ts -> force-include missing univ2/3/4 pools\n"
    "  - analysis/src/pnl/arb-profit.ts (priceArb) + cli/tx-profit.ts -> builder-payment-aware PnL\n"
)

MARKERS = [
    "receiptLogs", "deriveEdgeKindsFromLogs", "deriveProtocolActionsFromLogs", "extractTouchedVenues",
    "captureAllVenues", "extractVenueCandidates", "traceTransaction", "callTracer", "debug_trace",
    "active-pools", "previewRedeem", "asset()", "token0", "token1", "topic0", "log_address",
    "in_graph", "priceArb", "builderPayment", "/discovery/", "/learning/edge-kinds", "/pnl/",
]

# throwaway target: basename starts '_', or under /tmp//scratchpad/, ending .ts/.py
SCRATCH_RE = re.compile(r"(^|/)(_[\w.-]+|[\w.-]+)\.(ts|py)$")
def is_scratch_path(p: str) -> bool:
    if not p:
        return False
    base = p.rsplit("/", 1)[-1]
    if not (base.endswith(".ts") or base.endswith(".py")):
        return False
    return base.startswith("_") or "/tmp/" in p or "/scratchpad/" in p

def marker_count(text: str) -> int:
    return sum(1 for m in MARKERS if m in text)

def has_affirmation(text: str) -> bool:
    return "tool-first-checked:" in text

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = data.get("tool_name")
ti = data.get("tool_input") or {}

target, body = "", ""
if tool == "Write":
    target, body = ti.get("file_path", "") or "", ti.get("content", "") or ""
    scratch = is_scratch_path(target)
elif tool == "Bash":
    cmd = ti.get("command", "") or ""
    body = cmd
    # a redirection/heredoc that creates a scratch .ts/.py analysis script
    m = re.search(r">\s*([^\s;|&]+\.(?:ts|py))", cmd)
    target = m.group(1) if m else ""
    scratch = bool(target) and is_scratch_path(target)
else:
    sys.exit(0)

if not scratch:
    sys.exit(0)
if marker_count(body) < 2:
    sys.exit(0)
if has_affirmation(body):
    sys.exit(0)

sys.stderr.write(
    "BLOCKED (CLAUDE.md §5 / HERMES.md rule 17 — TOOL-FIRST): you are hand-writing a throwaway "
    f"analysis script ({target or 'scratch .ts/.py'}) that re-implements venue/pool/trace/PnL "
    "extraction an existing tool already does. Check + RUN/EXTEND the toolset first:\n"
    + TOOLS
    + "This is exactly the check that would have avoided the 2026-07-06 'dead edge' error "
    "(bundle-postmortem's in_graph already answers 'is this pool in our graph').\n"
    "If you genuinely checked and no tool fits, add ONE line to the file:\n"
    "  tool-first-checked: <tools you checked + why they don't fit> \n"
    "then re-run — the affirmation is the escape hatch (forces the conscious check, doesn't ban "
    "hand analysis).\n"
)
sys.exit(2)
