#!/usr/bin/env bash
# #2 sealed-parity capture orchestrator (challenger side).
#
# Usage:
#   scripts/capture-migration-parity.sh <corpus.json> <challenger-out.json>
#
# Runs the current-branch capture generator over a frozen corpus manifest and
# writes the challenger raw side capture. The baseline side must be produced
# by the ds-baseline capture exporter at the frozen baseline SHA; then the
# batch request (both side paths + state anchors + diagnostics) is validated
# and run with:
#   npm run architecture-migration-parity:run -- <batch-request.json>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS="${1:?usage: capture-migration-parity.sh <corpus.json> <challenger-out.json>}"
CHALLENGER_OUT="${2:?usage: capture-migration-parity.sh <corpus.json> <challenger-out.json>}"

cd "$REPO_ROOT/listener"
npm run --silent architecture-migration-capture:run -- "$CORPUS" "$CHALLENGER_OUT"
echo "challenger side written: $CHALLENGER_OUT"
echo "next: architecture-migration-parity:run <batch-request.json> (baseline + challenger sides)"
