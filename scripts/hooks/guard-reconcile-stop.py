#!/usr/bin/env python3
"""Stop gate behind capability-selected RECONCILE-after."""

import json
import os
import sys


try:
    json.load(sys.stdin)
except Exception:
    pass

if os.environ.get("MEV_HOOK_TEST") == "1":
    PENDING = os.environ.get("MEV_RECONCILE_PENDING_PATH", "/tmp/mev-reconcile-pending")
else:
    PENDING = "/tmp/mev-reconcile-pending"

try:
    if not os.path.exists(PENDING):
        sys.exit(0)
    with open(PENDING) as handle:
        state = json.load(handle)
    items = [str(item).strip() for item in (state.get("items") or []) if str(item).strip()]
    if not items:
        os.remove(PENDING)
        sys.exit(0)
except Exception:
    sys.exit(0)

sys.stderr.write(
    "RECONCILE PENDING — do not end the turn (CLAUDE.md §5 / HERMES rules 16+17):\n"
    + "".join(f"  - {item}\n" for item in items[:8])
    + "Query the generated inventory with `cd analysis && npm run tool-index -- --select "
    "<capabilities> --out <manifest.json>`, inspect its coverage set and alternatives, then use `npm run "
    "tool-run -- --manifest <manifest.json> --tool <indexed-id> -- <args>` for enough selected tools on the "
    "same input to cover the query. Agreement confirms the manual result; divergence means fix the stale "
    "tool or correct the manual analysis. A false positive is recorded after selection as "
    "`tool-reconciled: <exact-indexed-id> n/a <reason>`.\n"
)
sys.exit(2)
