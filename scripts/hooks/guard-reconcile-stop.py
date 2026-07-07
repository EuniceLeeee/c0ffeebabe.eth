#!/usr/bin/env python3
"""Stop guard — the TEETH behind guard-tool-reconcile.py (rules 16+17).

guard-tool-reconcile.py (PostToolUse) records a PENDING entry each time a hand-rolled analysis fires,
and clears it when a canonical tool is run OR a `tool-reconciled: <named tool>` line is written. This
Stop hook refuses to let the turn end while a reconciliation is still pending — that is what converts
the reminder into a gate (per the 2026-07-06 blind audit: a per-artifact reminder with no Stop backstop
is a nudge, not enforcement).

Exit 0 = allow stop; exit 2 = BLOCK + stderr to the model. Fail-open on any error.
To clear manually if a fire was a false positive: run a canonical tool, or write
`tool-reconciled: <tool> n/a-<why>`, or `rm /tmp/mev-reconcile-pending`.
"""
import sys, os, json

# Global (non-session-isolated) pending path — operator reverted the per-session key (2026-07-07).
# Tradeoff: with concurrent sessions on this repo, one session's un-reconciled analysis can block
# another's Stop. Must match guard-tool-reconcile.py's PENDING path.
try:
    json.load(sys.stdin)  # consume stdin (session_id no longer used for the path)
except Exception:
    pass
PENDING = "/tmp/mev-reconcile-pending"

try:
    if not os.path.exists(PENDING):
        sys.exit(0)
    with open(PENDING) as f:
        items = [ln.strip() for ln in f if ln.strip()]
    if not items:
        os.remove(PENDING)
        sys.exit(0)
except Exception:
    sys.exit(0)

sys.stderr.write(
    "RECONCILE PENDING — do NOT end the turn (CLAUDE.md §5 / HERMES rules 16+17). Hand-rolled "
    f"analysis fired the tool-reconcile gate and was never reconciled with a canonical tool:\n"
    + "".join(f"  - {it}\n" for it in items[:8])
    + "Before stopping, RUN the canonical tool on the same input (bundle-postmortem's in_graph, "
    "venue-discovery, auto-close-route-gap, tx-profit, …) and reconcile — agreement confirms it, "
    "divergence IS the finding (stale tool -> fix it, or wrong hand analysis -> correct it BEFORE "
    "reporting). Running the tool, or a `tool-reconciled: <named tool>` line, clears this; a genuine "
    f"false positive clears with `rm {PENDING}`.\n"
)
sys.exit(2)
