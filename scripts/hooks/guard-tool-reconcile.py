#!/usr/bin/env python3
"""PostToolUse(Write|Edit|Bash) guard — CLAUDE.md §5 / HERMES rules 16+17 RECONCILE-after.

POST (not a pre-block): a pre-block suppresses the manual analysis that catches a STALE tool (rule 16:
manual analysis is a TEST of our tooling). So keep hand analysis, but make it RECONCILE with the
canonical tool afterward — the two verify each other. Motivating miss (2026-07-06): a hand-rolled
venue/pool "dead-edge" analysis reached a wrong conclusion `bundle-postmortem`'s `in_graph` would have
avoided (a "dead edge" was really an unindexed pool = pool gap).

This fires AFTER a hand-rolled analysis is written/run: exit 2 -> stderr reminder to the model, AND it
records a PENDING entry so the Stop backstop (guard-reconcile-stop.py) can refuse to end the turn until
the reconciliation is recorded — that is what makes it a gate, not a nudge. Running a canonical tool
(npm run bundle-postmortem/census-report/venue-discovery*/auto-close*/tx-profit) OR an explicit
`tool-reconciled: <named tool>` line CLEARS the pending state.

Fail-open: any parse error -> exit 0 (never break real work). Scope stays tight; risk skews to
under-firing, so recall was widened per the 2026-07-06 blind audit.
"""
import sys, json, re, os

PENDING = "/tmp/mev-reconcile-pending"
TOOL_NAMES = ("bundle-postmortem", "census-report", "venue-discovery", "venue-evidence",
              "venue-registry", "auto-close-route-gap", "auto-close", "tx-profit", "arb-profit")
TOOLS_TXT = (
    "  - bundle-postmortem.ts  extractTouchedVenues(receipt, graph) + venue.in_graph (pool-in-graph truth)\n"
    "  - census-report.ts / venue-discovery-bq.ts  competitor / log-export -> venues\n"
    "  - discovery/venue-evidence.ts  captureAllVenues\n"
    "  - searcher/auto-close-route-gap.ts  force-include missing univ2/3/4 pools\n"
    "  - pnl/arb-profit.ts (priceArb) + cli/tx-profit.ts  builder-payment-aware PnL\n"
)
MARKERS = [
    "receiptLogs", "deriveEdgeKindsFromLogs", "deriveProtocolActionsFromLogs", "extractTouchedVenues",
    "captureAllVenues", "extractVenueCandidates", "traceTransaction", "callTracer", "debug_trace",
    "active-pools", "runtime-graph-pools", "previewRedeem", "asset()", "token0", "token1", "topic0",
    "log_address", "in_graph", "priceArb", "builderPayment", "getLogs", "eth_getLogs", "slot0",
    "get_dy", "coins(", "/discovery/", "/learning/edge-kinds", "/pnl/",
    "0xddf252ad",  # ERC20 Transfer topic literal (raw-hash analyses)
    "0xc42079f9", "0x19b47279",  # univ3 / pancake-v3 Swap topic literals
]
SCRATCH_EXT = (".ts", ".py", ".sh", ".mjs", ".js")

def is_scratch(p):
    if not p:
        return False
    base = p.rsplit("/", 1)[-1]
    if not base.endswith(SCRATCH_EXT):
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

def affirmed(t):
    return re.search(r"tool-reconciled:\s*(" + "|".join(re.escape(n) for n in TOOL_NAMES) + r")", t) is not None

def ran_canonical_tool(cmd):
    return any(("run " + n) in cmd or (n + ".ts") in cmd or (n + " ") in cmd for n in TOOL_NAMES)

def clear_pending():
    try:
        os.remove(PENDING)
    except Exception:
        pass

def add_pending(target):
    try:
        with open(PENDING, "a") as f:
            f.write(target + "\n")
    except Exception:
        pass

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = data.get("tool_name")
ti = data.get("tool_input") or {}
target, body = "", ""

if tool in ("Write",):
    target = ti.get("file_path", "") or ""
    body = ti.get("content", "") or ""
    scratch = is_scratch(target)
elif tool in ("Edit", "MultiEdit"):
    target = ti.get("file_path", "") or ""
    body = (ti.get("new_string", "") or "") + " " + " ".join(
        (e.get("new_string", "") or "") for e in (ti.get("edits") or []))
    scratch = is_scratch(target)
elif tool == "Bash":
    cmd = ti.get("command", "") or ""
    body = cmd
    # git/gh/version-control ops are never analysis — their messages quote marker words (false positives).
    if re.search(r"\b(git|gh)\s+(commit|add|push|pull|mv|rm|fetch|show|log|status|diff|checkout|reset|stash|branch|clone|tag|pr|issue)\b", cmd):
        sys.exit(0)
    # running a canonical tool = the reconciliation act -> clear pending
    if ran_canonical_tool(cmd) or affirmed(cmd):
        clear_pending()
        sys.exit(0)
    # a heredoc/redirect/run of a scratch script (resolve a `cd x &&` basename), OR inline -c/-e code
    m = re.search(r"(?:>\s*|node\s[^\n|;&]*?|tsx\s|python3?\s|bash\s|sh\s)([^\s;|&'\"]+\.(?:ts|py|sh|mjs|js))", cmd)
    if m:
        ref = m.group(1)
        target = ref
        base = ref.rsplit("/", 1)[-1]
        scratch = base.startswith("_") or "/tmp/" in ref or "/scratchpad/" in ref
        for cand in (ref, os.path.join("analysis", ref), os.path.join("listener", ref)):
            if os.path.exists(cand):
                body += "\n" + read(cand)
                break
    elif re.search(r"(python3?|node)\s+-[ce]\b", cmd):
        target = "inline-code"     # python3 -c / node -e analysis (no file); markers gate it below
        scratch = True
    else:
        scratch = False
else:
    sys.exit(0)

if tool != "Bash" and affirmed(body):
    clear_pending()
    sys.exit(0)
if not scratch:
    sys.exit(0)
# threshold 1 for a clearly-scratch target (audit: >=2 missed real venue analyses)
if markers(body) < 1:
    sys.exit(0)
if affirmed(body):
    clear_pending()
    sys.exit(0)

add_pending(target or "scratch-analysis")
sys.stderr.write(
    "RECONCILE REQUIRED (CLAUDE.md §5 / HERMES rules 16+17): you ran a hand-rolled analysis "
    f"({target}) that re-derives venue/pool/trace/PnL facts a canonical tool also computes. Rule 16 makes "
    "the hand analysis a TEST of the tool — run the tool on the SAME input and RECONCILE before trusting/"
    "reporting it (and the turn cannot end until you do — Stop backstop):\n" + TOOLS_TXT +
    "Record the outcome to clear it: run the tool (npm run bundle-postmortem/…), OR add a line "
    "`tool-reconciled: <named tool> agrees|diverged -> <fix>`. Divergence IS the finding "
    "(fix the stale tool per rule 16, or the wrong hand analysis — e.g. in_graph shows a 'dead edge' is an "
    "unindexed pool = pool gap).\n"
)
sys.exit(2)
