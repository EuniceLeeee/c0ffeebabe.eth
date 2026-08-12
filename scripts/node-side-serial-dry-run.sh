#!/usr/bin/env bash
set -euo pipefail

# Runs one serial S1 dry-run side on the node. Reads the live searcher's
# environment through a strict whitelist (never copies the private key),
# forces SEARCHER_DRY_RUN=1 and disables submit/MEV-Share, then runs the
# worktree searcher for a bounded window and prints a machine-readable
# SERIAL_SIDE_JSON summary. Dry-run only; live process untouched.
#
# Usage (on node):
#   node-side-serial-dry-run.sh <side> <sha> <window-seconds> <worktree> <outdir>

side="${1:?side required}"
sha="${2:?sha required}"
window_seconds="${3:?window seconds required}"
dir="${4:?worktree required}"
outdir="${5:?outdir required}"

mkdir -p "${outdir}"
# Scoped cleanup of leftovers from a previous dry-run side (only our ports).
pkill -f -- '--port 9555' 2>/dev/null || true
pkill -f -- '--port 9556' 2>/dev/null || true
cd "${dir}"
git fetch origin codex/parity-capture-baseline codex/s1-unified-adapter-architecture-impl 2>&1 | tail -1
git checkout "${sha}" 2>&1 | tail -1
checked_out="$(git rev-parse HEAD)"

env_lines="$(sudo tr '\0' '\n' < "/proc/$(pgrep -f 'src/searcher/main.ts' | head -1)/environ")"
export SEARCHER_DRY_RUN=1
export SEARCHER_BLOCKSCAN_SUBMIT=0
export SEARCHER_ENABLE_MEV_SHARE=0
export SEARCHER_SUBMIT_HASHONLY_MEVSHARE=0
export SEARCHER_EVENTS_PATH="${outdir}/events.jsonl"
export SEARCHER_BLOCKSCAN_ROUTE_EVENTS_PATH="${outdir}/routes.jsonl"
if [ "${STRICT_LIVE_EXECUTION:-0}" = "1" ]; then
  export SEARCHER_STRICT_LIVE_EXECUTION=1
fi
for var in \
  MAINNET_RPC_URL SEARCHER_LIVE_RPC_URL SEARCHER_LIVE_WS_URL \
  SEARCHER_REVM_SIM_BIN SEARCHER_V2_LINEAGES_PATH \
  SEARCHER_POOL_UNIVERSE_PATH SEARCHER_POOL_UNIVERSE_MANIFEST_PATH \
  SEARCHER_FORCE_INCLUDE_ROUTERS_PATH BOTVM_ADDRESS BOTVM_OWNER \
  SEARCHER_BRIBE_BPS SEARCHER_PROFIT_HAIRCUT_BPS SEARCHER_EV_GATE \
  SEARCHER_BLOCKSCAN_INCREMENTAL_RANGE_BLOCKS SEARCHER_BLOCKSCAN_MAX_CANDIDATES \
  SEARCHER_BLOCKSCAN_REFINE_CANDIDATES SEARCHER_BLOCKSCAN_N_MINUS_ONE_FALLBACK \
  SEARCHER_BLOCKSCAN_N_MINUS_ONE_STATE_BUDGET_MS \
  SEARCHER_BLOCKSCAN_N_MINUS_ONE_FAMILY_SETTLE_MS \
  SEARCHER_BLOCKSCAN_PRODUCER_TOPOLOGY_ADOPT_MS \
  SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS \
  SEARCHER_BLOCKSCAN_STARTUP_PREWARM_BUDGET_MS \
  SEARCHER_DISCOVERY_BLOCKS \
  SEARCHER_REFRESH_INTERVAL_MS SEARCHER_OPP_TTL_MS \
  SEARCHER_ENABLE_BLOCK_SCAN SEARCHER_ENABLE_BACKRUN \
  SEARCHER_ENABLE_MEMPOOL SEARCHER_ENABLE_PROTOCOL_EDGES \
  SEARCHER_ENABLE_HASH_ONLY SEARCHER_EXCLUDE_NON_STATE_INSTANCE_FAMILIES \
  SEARCHER_EAGER_STATE_BACKEND SEARCHER_LIVE_BACKEND \
  SEARCHER_BLOCKSCAN_EXACT_PRODUCER_LAG_YIELD_BUDGET_MS \
  SEARCHER_BLOCKSCAN_EXACT_PRODUCER_LAG_YIELD_MS \
  SEARCHER_BLOCKSCAN_STATE_MULTICALL SEARCHER_BLOCKSCAN_PROTOCOL_TOUCH_MODE \
  SEARCHER_BLOCKSCAN_ANVIL_PORT SEARCHER_ANVIL_PORT; do
  value="$(printf '%s\n' "${env_lines}" | sed -n "s/^${var}=//p" | head -1)"
  if [ -n "${value}" ]; then
    export "${var}=${value}"
  fi
done

# Dry-run signing still needs a key locally; use a per-run random dummy
# (never the production key, never committed) and pin the botvm identity to
# the dummy key's derived address.
export OWNER_PRIVATE_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export BOTVM_OWNER="$(cd "${dir}/listener" && node -e "const {Wallet}=require('ethers'); console.log(new Wallet(process.argv[1]).address)" "${OWNER_PRIVATE_KEY}")"
export BOTVM_ADDRESS="${BOTVM_OWNER}"
# Move anvil forks off the live process's ports (serial run owns them here).
export SEARCHER_ANVIL_PORT=9555
export SEARCHER_BLOCKSCAN_ANVIL_PORT=9556

cd "${dir}/listener"
set +e
timeout "${window_seconds}s" npm run searcher:live >"${outdir}/run.log" 2>&1
exit_code=$?
set -e
echo "${exit_code}" >"${outdir}/exit.txt"

artifact="${dir}/listener/searcher/pools/runtime-blockscan-pools.json"
if [ -f "${artifact}" ]; then
  cp "${artifact}" "${outdir}/runtime-blockscan-pools.json" 2>/dev/null || true
  git -C "${dir}" restore -- listener/searcher/pools/runtime-blockscan-pools.json 2>/dev/null || true
fi

SERIAL_SIDE_JSON="$(python3 - "${side}" "${checked_out}" "${outdir}" <<'PY'
import json, os, re, sys
side, sha, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
priced = None
graph_built = None
log_path = os.path.join(outdir, "run.log")
if os.path.exists(log_path):
    for line in open(log_path, errors="replace"):
        m = re.search(r"priced=(\d+)/(\d+)", line)
        if m:
            priced = (int(m.group(1)), int(m.group(2)))
        g = re.search(r"graph built: edges=(\d+)", line)
        if g:
            graph_built = int(g.group(1))
artifact_pools = None
artifact = os.path.join(outdir, "runtime-blockscan-pools.json")
if os.path.exists(artifact):
    try:
        artifact_pools = len(json.load(open(artifact)))
    except Exception:
        artifact_pools = -1
def lines(path):
    try:
        return sum(1 for _ in open(path, errors="replace"))
    except Exception:
        return -1
record = {
    "side": side,
    "sha": sha,
    "priced": None if priced is None else {"resolved": priced[0], "expected": priced[1]},
    "pricedRatio": None if priced is None or priced[1] == 0 else priced[0] / priced[1],
    "graphBuiltEdges": graph_built,
    "artifactPoolCount": artifact_pools,
    "eventLineCount": lines(os.path.join(outdir, "events.jsonl")),
    "routeEventLineCount": lines(os.path.join(outdir, "routes.jsonl")),
    "exitCode": int(open(os.path.join(outdir, "exit.txt")).read().strip()),
}
print(json.dumps(record))
PY
)"
echo "SERIAL_SIDE_JSON=${SERIAL_SIDE_JSON}"
echo "SERIAL_SIDE_DONE=${side}"
