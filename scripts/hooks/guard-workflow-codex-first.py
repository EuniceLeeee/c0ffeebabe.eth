#!/usr/bin/env python3
"""PreToolUse(Workflow) guard — ENFORCES CLAUDE.md §5 "Codex-first for fan-out".

Codex (scripts/codex-run.sh) is the sanctioned generator/investigator (HERMES rule 11/12). Multi-agent
fan-out work — reading code/docs, writing code, read-only repo/log analysis — should be dispatched to
Codex in its sandbox (parallel codex-run.sh launches are fine), NOT to a Claude-agent `Workflow`. Claude
sub-agents burn tokens and duplicate what Codex does cheaply. Reserve `Workflow` for work Codex genuinely
CANNOT do in its sandbox: spawning processes (anvil/forge), node/network queries the sandbox blocks,
interactive-auth MCP servers, or Claude-only tools (visualize/artifact/browser).

Teeth: this BLOCKS a `Workflow` call (exit 2 + stderr to the model) UNLESS a one-shot exempt marker
exists — the model creates it to DECLARE "this fan-out is genuinely sandbox-blocked". The hook consumes
(deletes) the marker so the exemption is per-invocation, not a standing bypass.

Exit 0 = allow; exit 2 = BLOCK + surface stderr to the model. Fail-open on any parse error (exit 0 —
never break real work).
"""
import sys, json, os

MARKER = "/tmp/mev-workflow-codex-exempt"

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if data.get("tool_name") != "Workflow":
    sys.exit(0)

# One-shot exemption: the model declared this fan-out is sandbox-blocked. Consume + allow.
if os.path.exists(MARKER):
    try:
        os.remove(MARKER)
    except Exception:
        pass
    sys.exit(0)

sys.stderr.write(
    "BLOCKED (CLAUDE.md §5 Codex-first for fan-out): a `Workflow` spawns Claude sub-agents, but Codex "
    "(scripts/codex-run.sh <read-only|workspace-write> <brief-file> <out-prefix>) is the default for "
    "multi-agent fan-out — reading code/docs, writing code, read-only repo/log analysis. Launch one or "
    "more codex-run.sh runs in the background instead (parallel is fine). Reserve `Workflow` ONLY for "
    "work Codex canNOT do in its sandbox: spawning processes (anvil/forge), node/network queries the "
    "sandbox blocks, interactive-auth MCP, or Claude-only tools (visualize/artifact/browser). If this "
    "fan-out is GENUINELY one of those, run `touch /tmp/mev-workflow-codex-exempt` (one-shot) and retry "
    "the Workflow.\n"
)
sys.exit(2)
