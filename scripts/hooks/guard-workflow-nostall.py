#!/usr/bin/env python3
"""Stop hook — ENFORCES HERMES.md rule 15 (a status report is NOT a stop).

The rule-14 no-ask hook stops the agent from *asking* mid-workflow, but the real failure mode is
subtler: after a big analysis the agent writes a checkpoint report and simply YIELDS the turn —
neither asking nor proceeding. That is a silent stall (the loop only advances when a tool call
re-invokes the agent). Observed 2026-07-02: R1 reported, R2 never auto-started until the user asked.

This hook fires when the turn ends. While the workflow marker exists, it BLOCKS the first stop and
forces the agent to confirm a continuation is scheduled (background work running / wakeup set) or
dispatch one. It self-clears via `stop_hook_active` so a legitimate wait (re-affirm, then stop)
isn't looped.

Exit 0 = allow the turn to end; exit 2 = BLOCK the stop and surface stderr to the agent.
"""
import sys, json, os

MARKER = "/tmp/mev-workflow-active"

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

# No active autonomous workflow -> ending the turn is fine.
if not os.path.exists(MARKER):
    sys.exit(0)

# Already reminded once this turn (agent re-affirmed) -> let the stop proceed, don't loop.
if data.get("stop_hook_active"):
    sys.exit(0)

sys.stderr.write(
    "AUTONOMOUS WORKFLOW ACTIVE (/tmp/mev-workflow-active) — do NOT end on a status report alone "
    "(HERMES.md rule 15). Before this turn ends, confirm ONE of:\n"
    "  (a) background work is RUNNING or a wakeup/timer is scheduled that will re-invoke you — then "
    "this stop is fine: briefly say what you're waiting on, and stopping again will proceed;\n"
    "  (b) otherwise DISPATCH the next action NOW (next Codex/agent, deploy, ScheduleWakeup, the next "
    "round step) — reporting is delivered ALONGSIDE the next action in the same turn, not instead of it;\n"
    "  (c) you hit a REAL stop condition (go-live/broadcast, CU-cap, destructive) — state it explicitly.\n"
    "A report that schedules nothing is a silent stall that kills the loop until the human pokes it.\n"
)
sys.exit(2)
