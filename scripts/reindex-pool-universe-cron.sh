#!/bin/sh
# Pool-universe re-index cron — keeps active-pools.json fresh (toBlock~=head) for restarts.
# Fast config: local reth (zero CU), 2d activity window, durable verified
# family topology, v4 backward-search disabled. Atomic + guarded.
set -e
REPO=/opt/MEV
OUT="$REPO/listener/searcher/pools/active-pools.json"
TMP="/tmp/active-pools.cron.$$.json"
OUT_MANIFEST="$OUT.manifest.json"
TMP_MANIFEST="$TMP.manifest.json"
RETAIN="${POOL_UNIVERSE_RETAIN_PATH:-$OUT}"
LOG=/var/log/mev-pooluniverse-cron.log
cd "$REPO/listener" || exit 0
echo "=== $(date -u +%FT%TZ) reindex start ===" >> "$LOG"
if timeout 540 env MAINNET_RPC_URL=http://127.0.0.1:8545 \
      POOL_UNIVERSE_LOOKBACK_DAYS=2 \
      POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS=0 \
      POOL_UNIVERSE_RETAIN_PATH="$RETAIN" \
      POOL_UNIVERSE_OUT="$TMP" \
      POOL_UNIVERSE_MANIFEST_OUT="$TMP_MANIFEST" \
      npx tsx src/searcher/build-active-pool-universe.ts >> "$LOG" 2>&1 \
   && [ -s "$TMP" ] && [ -s "$TMP_MANIFEST" ] \
   && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); p=d["pools"] if isinstance(d,dict) else d; sys.exit(0 if len(p)>500 else 1)' "$TMP"; then
  POOLS=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d["pools"]))' "$TMP")
  mv "$TMP" "$OUT"
  mv "$TMP_MANIFEST" "$OUT_MANIFEST"
  echo "$(date -u +%FT%TZ) reindex OK: $POOLS pools" >> "$LOG"
else
  echo "$(date -u +%FT%TZ) reindex FAILED/timeout — kept existing active-pools.json" >> "$LOG"
  rm -f "$TMP" "$TMP_MANIFEST" 2>/dev/null || true
fi
# keep the log from growing unbounded
tail -n 500 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG" 2>/dev/null || true
