#!/usr/bin/env bash
# Safe node deploy: update /opt/MEV to latest origin/main and restart the searcher.
#
# Runs ON the EC2 node (SSM-only, no SSH). Bootstraps itself from git so it is always
# the latest version:
#   aws ssm send-command ... --parameters 'commands=[
#     "git -C /opt/MEV fetch origin -q && git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash"]'
#
# DRY-RUN vs LIVE (broadcast) — the guard, and the one bounded escape hatch:
#  - DEFAULT = DRY-RUN. If SEARCHER_DRY_RUN=1 cannot be ensured, ABORT without restarting
#    (never risk an accidental live broadcast). The autonomous cron + every normal deploy hit
#    this path and stay dry-run. This is the project-node-env-dryrun-guard lesson, unchanged.
#  - LIVE is a DELIBERATE, node-side, human action: create the marker file $REPO/.deploy-live.
#    Even then, LIVE is REFUSED unless the signing wallet holds <= MEV_LIVE_MAX_WALLET_ETH
#    (default 0.2 ETH) AND SEARCHER_EV_GATE=1 — so live can only ever run on a BOUNDED test
#    wallet (flash-loan arbs are atomic → worst-case loss is bounded to that wallet's gas/bribe
#    balance). Remove the marker → next deploy reverts to dry-run.
#  - The full working env is recovered from the RUNNING process BEFORE reset, so a truncated
#    /opt/MEV/.env can never silently drop tuning knobs. Dirty files are tar-backed-up first.
set -uo pipefail
REPO=/opt/MEV
ENVF=$REPO/.env
TS=$(date +%Y%m%d-%H%M%S)
say() { echo "[deploy $TS] $*"; }

NON_SEARCHER_KEYS="MAINNET_RPC_URL OWNER_PRIVATE_KEY BOTVM_ADDRESS BOTVM_OWNER"
OPP_TTL_MS="${SEARCHER_OPP_TTL_MS:-5000}"
# Pool-universe topN: how many ranked active-pools enter the runtime graph. Default 20000 (operator
# 2026-07-12) — the running value; the old 6000 default silently reset a 20000 .env on every deploy
# because SSM spawns a fresh sh (no SEARCHER_* inherited), so the :-fallback ALWAYS applied. Deploy-
# controlled (like OPP_TTL_MS) so it survives the recover-from-process .env rebuild. Latency-affordable.
POOL_UNIVERSE_TOP_N="${SEARCHER_POOL_UNIVERSE_TOP_N:-20000}"
LIVE_MARKER=$REPO/.deploy-live
LOCAL_RPC=${SEARCHER_LIVE_RPC_URL:-http://127.0.0.1:8545}
MEV_LIVE_MAX_WALLET_ETH=${MEV_LIVE_MAX_WALLET_ETH:-0.2}
DEFAULT_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl

# Mode: DRY (default) unless the human placed the live marker on the node.
if [ -f "$LIVE_MARKER" ]; then MODE=LIVE; DRY_VAL=0; else MODE=DRY; DRY_VAL=1; fi

cd "$REPO" || { say "no $REPO"; exit 1; }
DISCOVERY_TO_BLOCK=$(curl -sS "$LOCAL_RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"],16))' 2>/dev/null || echo 0)
[ "$DISCOVERY_TO_BLOCK" -gt 0 ] \
  || { say "ABORT: could not pin SEARCHER_DISCOVERY_TO_BLOCK from local reth."; exit 9; }

recover_running_env() {
  tr '\0' '\n' < "/proc/$PID/environ" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    case "$key" in
      SEARCHER_DRY_RUN|SEARCHER_OPP_TTL_MS|SEARCHER_POOL_UNIVERSE_TOP_N|SEARCHER_DISCOVERY_TO_BLOCK|SEARCHER_EVENTS_PATH|SEARCHER_BRIBE_ALL_ABOVE_GAS|SEARCHER_ENABLE_HASH_ONLY|SEARCHER_ENABLE_BACKRUN|SEARCHER_ENABLE_PROTOCOL_EDGES|SEARCHER_ENABLE_BLOCK_SCAN|SEARCHER_BLOCKSCAN_SUBMIT) continue ;;
      SEARCHER_*) echo "$line"; continue ;;
    esac
    for wanted in $NON_SEARCHER_KEYS; do
      [ "$key" = "$wanted" ] && { echo "$line"; break; }
    done
  done
}

# ── 1. Recover the full working env from the RUNNING process (ground truth) ──
PID=$(systemctl show -p MainPID --value mev-searcher 2>/dev/null)
if [ -n "$PID" ] && [ "$PID" != "0" ] && [ -r "/proc/$PID/environ" ]; then
  say "recovering env from running PID $PID (mode=$MODE)"
  RUNNING_EVENTS_PATH=$(tr '\0' '\n' < "/proc/$PID/environ" \
    | sed -n 's/^SEARCHER_EVENTS_PATH=//p' | tail -1)
  EVENTS_PATH=${SEARCHER_EVENTS_PATH:-${RUNNING_EVENTS_PATH:-$DEFAULT_EVENTS_PATH}}
  tmp=$(mktemp)
  recover_running_env > "$tmp"
  echo "SEARCHER_OPP_TTL_MS=$OPP_TTL_MS" >> "$tmp"
  echo "SEARCHER_POOL_UNIVERSE_TOP_N=$POOL_UNIVERSE_TOP_N" >> "$tmp"
  echo "SEARCHER_DISCOVERY_TO_BLOCK=$DISCOVERY_TO_BLOCK" >> "$tmp"
  echo "SEARCHER_EVENTS_PATH=$EVENTS_PATH" >> "$tmp"
  echo "SEARCHER_DRY_RUN=$DRY_VAL" >> "$tmp"
  # bribe-all-above-gas is marker-controlled ($REPO/.bribe-all-above-gas), like .deploy-live —
  # a single durable source that survives the recover-from-process rebuild. Does NOT touch the
  # DRY_RUN broadcast guard; only sizes the bribe (net stays ≥0 by the EV gate).
  [ -f "$REPO/.bribe-all-above-gas" ] && echo "SEARCHER_BRIBE_ALL_ABOVE_GAS=1" >> "$tmp"
  # protocol-edges (A6) is marker-controlled ($REPO/.protocol-edges), like .bribe-all-above-gas —
  # admits the NEW wsteth wrap/unwrap protocol edges into the live graph. Full-value conversions
  # (leavesStandingPosition=false); still bounded by the EV gate + wallet cap. Remove the marker → off.
  [ -f "$REPO/.protocol-edges" ] && echo "SEARCHER_ENABLE_PROTOCOL_EDGES=1" >> "$tmp"
  # block-scan (BS-lane Pass A) is marker-controlled ($REPO/.block-scan). LOG-ONLY: runs the block-scan
  # scanner per block and prints candidates — NO plan/sim/submit, NO broadcast impact. Safe to enable in
  # any mode. Remove the marker → off. (Pass B will add the submit path behind its own gate.)
  [ -f "$REPO/.block-scan" ] && echo "SEARCHER_ENABLE_BLOCK_SCAN=1" >> "$tmp"
  # block-scan atomic SUBMIT (BS-lane Pass B) is marker-controlled ($REPO/.blockscan-submit). Wires the
  # block-scan +EV solve into live submission (standalone eth_sendBundle, NO victim). Same EV/phantom/
  # standing-credit gates as backrun; bounded by the EV gate + wallet cap + DRY_RUN. Remove marker → off.
  [ -f "$REPO/.blockscan-submit" ] && echo "SEARCHER_BLOCKSCAN_SUBMIT=1" >> "$tmp"
  # hash-only (MEV-Share consumption) is marker-controlled ($REPO/.hash-only), DEFAULT OFF (2026-07-07:
  # measured 100% phantom-victim rate — pure ghost flow that starved the mempool/atomic paths of CPU).
  # Ingest+sim only (submission also gated by allowHashOnlySubmit). Create the marker to re-enable.
  [ -f "$REPO/.hash-only" ] && echo "SEARCHER_ENABLE_HASH_ONLY=1" >> "$tmp"
  # Backrun victim sources are marker-controlled and default OFF on the node's block-scan production
  # posture. Without this explicit switch, SEARCHER_ENABLE_MEMPOOL=0 still consumes MEV-Share SSE.
  # Create $REPO/.backrun to deliberately restore MEV-Share (and optional public-mempool) processing.
  if [ -f "$REPO/.backrun" ]; then
    echo "SEARCHER_ENABLE_BACKRUN=1" >> "$tmp"
  else
    echo "SEARCHER_ENABLE_BACKRUN=0" >> "$tmp"
  fi
  cp -f "$ENVF" "$ENVF.bak-$TS" 2>/dev/null
  cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
  say "env rebuilt ($(wc -l < "$ENVF") keys) + DRY_RUN=$DRY_VAL + TTL=$OPP_TTL_MS + poolUniverseTopN=$POOL_UNIVERSE_TOP_N + discoveryToBlock=$DISCOVERY_TO_BLOCK"
else
  say "no running process — ensuring DRY_RUN=$DRY_VAL in existing .env (mode=$MODE)"
  EXISTING_EVENTS_PATH=$(sed -n 's/^SEARCHER_EVENTS_PATH=//p' "$ENVF" 2>/dev/null | tail -1)
  EVENTS_PATH=${SEARCHER_EVENTS_PATH:-${EXISTING_EVENTS_PATH:-$DEFAULT_EVENTS_PATH}}
  tmp=$(mktemp)
  cp -f "$ENVF" "$ENVF.bak-$TS" 2>/dev/null
  [ -f "$ENVF" ] && grep -v -E '^(SEARCHER_DRY_RUN|SEARCHER_OPP_TTL_MS|SEARCHER_POOL_UNIVERSE_TOP_N|SEARCHER_DISCOVERY_TO_BLOCK|SEARCHER_EVENTS_PATH|SEARCHER_BRIBE_ALL_ABOVE_GAS|SEARCHER_ENABLE_HASH_ONLY|SEARCHER_ENABLE_BACKRUN|SEARCHER_ENABLE_PROTOCOL_EDGES|SEARCHER_ENABLE_BLOCK_SCAN|SEARCHER_BLOCKSCAN_SUBMIT)=' "$ENVF" > "$tmp"
  echo "SEARCHER_OPP_TTL_MS=$OPP_TTL_MS" >> "$tmp"
  echo "SEARCHER_POOL_UNIVERSE_TOP_N=$POOL_UNIVERSE_TOP_N" >> "$tmp"
  echo "SEARCHER_DISCOVERY_TO_BLOCK=$DISCOVERY_TO_BLOCK" >> "$tmp"
  echo "SEARCHER_EVENTS_PATH=$EVENTS_PATH" >> "$tmp"
  echo "SEARCHER_DRY_RUN=$DRY_VAL" >> "$tmp"
  [ -f "$REPO/.bribe-all-above-gas" ] && echo "SEARCHER_BRIBE_ALL_ABOVE_GAS=1" >> "$tmp"
  [ -f "$REPO/.protocol-edges" ] && echo "SEARCHER_ENABLE_PROTOCOL_EDGES=1" >> "$tmp"  # A6 marker-gated (wsteth)
  [ -f "$REPO/.block-scan" ] && echo "SEARCHER_ENABLE_BLOCK_SCAN=1" >> "$tmp"  # BS-lane Pass A log-only, marker-gated
  [ -f "$REPO/.blockscan-submit" ] && echo "SEARCHER_BLOCKSCAN_SUBMIT=1" >> "$tmp"  # BS-lane Pass B atomic submit, marker-gated
  [ -f "$REPO/.hash-only" ] && echo "SEARCHER_ENABLE_HASH_ONLY=1" >> "$tmp"  # MEV-Share consumption marker-gated, DEFAULT OFF (2026-07-07 ghost flow)
  if [ -f "$REPO/.backrun" ]; then echo "SEARCHER_ENABLE_BACKRUN=1" >> "$tmp"; else echo "SEARCHER_ENABLE_BACKRUN=0" >> "$tmp"; fi
  cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
fi

# ── 2. Broadcast guard ──
if [ "$MODE" = "DRY" ]; then
  # HARD guard: refuse to continue unless DRY_RUN=1 is present exactly once.
  if [ "$(grep -c '^SEARCHER_DRY_RUN=1' "$ENVF")" != "1" ]; then
    say "ABORT: SEARCHER_DRY_RUN=1 not in $ENVF — not restarting (broadcast guard)."; exit 9
  fi
else
  # LIVE path: deliberate marker present. Refuse unless bounded test wallet + EV gate on.
  say "*** LIVE marker present ($LIVE_MARKER) — validating bounded-test-wallet envelope ***"
  grep -q '^SEARCHER_EV_GATE=1' "$ENVF" || { say "ABORT (live): SEARCHER_EV_GATE=1 required."; exit 9; }
  PK=$(grep '^OWNER_PRIVATE_KEY=' "$ENVF" | head -1 | cut -d= -f2-)
  [ -n "$PK" ] || { say "ABORT (live): no OWNER_PRIVATE_KEY."; exit 9; }
  WALLET=$(cast wallet address --private-key "$PK" 2>/dev/null)
  [ -n "$WALLET" ] || { say "ABORT (live): could not derive wallet from key."; exit 9; }
  BAL_WEI=$(cast balance "$WALLET" --rpc-url "$LOCAL_RPC" 2>/dev/null)
  CAP_WEI=$(cast to-wei "$MEV_LIVE_MAX_WALLET_ETH" 2>/dev/null)
  [ -n "$BAL_WEI" ] && [ -n "$CAP_WEI" ] || { say "ABORT (live): could not read wallet balance."; exit 9; }
  if ! python3 -c "import sys; sys.exit(0 if int('$BAL_WEI') <= int('$CAP_WEI') else 1)"; then
    say "ABORT (live): wallet $WALLET balance $BAL_WEI wei > cap ${MEV_LIVE_MAX_WALLET_ETH} ETH."
    say "  LIVE is only for a BOUNDED test wallet. Move funds out or raise MEV_LIVE_MAX_WALLET_ETH deliberately."
    exit 9
  fi
  if [ "$(grep -c '^SEARCHER_DRY_RUN=0' "$ENVF")" != "1" ]; then
    say "ABORT (live): SEARCHER_DRY_RUN=0 not set as expected."; exit 9
  fi
  say "LIVE envelope OK: wallet=$WALLET balance=$BAL_WEI wei (<= ${MEV_LIVE_MAX_WALLET_ETH} ETH), EV_GATE=1."
fi

# ── 3. Backup dirty files, then update code ──
git ls-files -m -o --exclude-standard 2>/dev/null | grep -v node_modules > "/tmp/dirty-$TS.txt"
tar czf "$REPO-deploy-$TS.tar.gz" -T "/tmp/dirty-$TS.txt" 2>/dev/null
git fetch origin -q
git reset --hard origin/main || { say "reset failed"; exit 1; }
say "code now at $(git rev-parse --short HEAD): $(git log --oneline -1)"

# ── 4. Build + production-analysis preflight ──
( cd "$REPO/listener" && npm run build ) \
  || { say "listener build failed — NOT restarting"; exit 1; }
# Analysis CLIs execute TypeScript directly via the devDependency `tsx`. A git
# reset updates their source but not ignored node_modules, so install the exact
# lockfile and verify the production blockscan joins before this checkout is
# considered deployable. The running searcher is not restarted until these pass.
( cd "$REPO/analysis" \
    && npm ci --include=dev --prefer-offline --no-audit --no-fund \
    && npm run build \
    && node --import tsx --test src/test/blockscan-log-join.ts src/test/block-activity.ts \
      src/test/live-loss-blockscan.ts ) \
  || { say "analysis preflight failed — NOT restarting"; exit 1; }

# ── Pool-universe re-index (best-effort; never blocks/aborts the deploy) ──
REINDEX_DAYS="${POOL_UNIVERSE_LOOKBACK_DAYS:-2}"
# V4 backfill (per-poolId backward Initialize search, default 2M blocks) is the scan's perf killer:
# hundreds of poolKeys-unresolvable v4 pools × a wide getLogs each pushes the scan >15min. Disable it
# (=0) so the scan completes in a few min — poolKeys()-resolvable v4 pools + in-window Initialize are
# still kept; only deep-history/unresolvable v4 is skipped (the census→auto-close bridge backfills those).
REINDEX_V4_BACKFILL="${POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS:-0}"
REINDEX_OUT="$REPO/listener/searcher/pools/active-pools.json"
REINDEX_TMP="/tmp/active-pools.reindex.$$.json"
UNIVERSE_SNAPSHOT_DIR=/opt/MEV-runtime/universe
# Debounce: with frequent dry-run on/off toggles, re-scanning on EVERY restart is wasteful. Skip if the
# universe is already fresh — its data toBlock is within MAX_STALE_BLOCKS of chain head (~7200 = ~1 day).
# (The 30-min cron keeps it far fresher, so this check usually skips; it only fires if the cron lapsed.)
# Block-based, NOT mtime — mtime is a deceptive deploy re-save; toBlock is the real data freshness.
REINDEX_MAX_STALE_BLOCKS="${POOL_UNIVERSE_MAX_STALE_BLOCKS:-7200}"
REINDEX_HEAD=$(curl -s http://127.0.0.1:8545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"],16))' 2>/dev/null || echo 0)
REINDEX_CUR_TOBLOCK=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(int(str(d.get("toBlock",0))))' "$REINDEX_OUT" 2>/dev/null || echo 0)
if [ "$REINDEX_HEAD" -gt 0 ] && [ "$REINDEX_CUR_TOBLOCK" -gt 0 ] \
   && [ "$((REINDEX_HEAD - REINDEX_CUR_TOBLOCK))" -lt "$REINDEX_MAX_STALE_BLOCKS" ]; then
  say "pool universe already fresh (toBlock=$REINDEX_CUR_TOBLOCK, head=$REINDEX_HEAD, $((REINDEX_HEAD - REINDEX_CUR_TOBLOCK)) < $REINDEX_MAX_STALE_BLOCKS blocks) — skipping re-index."
elif say "re-indexing pool universe (local reth, ${REINDEX_DAYS}d window, v4-backfill=${REINDEX_V4_BACKFILL})…"; \
   timeout 600 env MAINNET_RPC_URL="http://127.0.0.1:8545" \
       POOL_UNIVERSE_LOOKBACK_DAYS="$REINDEX_DAYS" \
       POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS="$REINDEX_V4_BACKFILL" \
       POOL_UNIVERSE_OUT="$REINDEX_TMP" \
       sh -c 'cd "$0/listener" && npx tsx src/searcher/build-active-pool-universe.ts' "$REPO" \
       >/tmp/deploy-reindex.log 2>&1 \
   && [ -s "$REINDEX_TMP" ] \
   && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); p=d["pools"] if isinstance(d,dict) else d; sys.exit(0 if len(p)>0 else 1)' "$REINDEX_TMP"; then
  POOLS=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); p=d["pools"] if isinstance(d,dict) else d; print(len(p))' "$REINDEX_TMP")
  cp -a "$REINDEX_OUT" "${REINDEX_OUT}.bak-$(date +%s)" 2>/dev/null || true
  mv "$REINDEX_TMP" "$REINDEX_OUT"
  say "pool universe re-indexed: $POOLS pools (toBlock=head)."
else
  say "WARNING: pool-universe re-index failed/timed out — keeping existing active-pools.json (deploy continues)."
  rm -f "$REINDEX_TMP" 2>/dev/null || true
fi

# Pin the running process to an immutable, content-addressed universe. The 30-minute indexer may replace
# active-pools.json while an A/B window is running; that file update must become input to the NEXT deploy,
# not silently mutate the champion's recorded fairness input mid-window.
UNIVERSE_HASH=$(sha256sum "$REINDEX_OUT" 2>/dev/null | awk '{print $1}')
case "$UNIVERSE_HASH" in
  [0-9a-f][0-9a-f]*) ;;
  *) say "ABORT: could not hash pool universe $REINDEX_OUT."; exit 9 ;;
esac
[ "${#UNIVERSE_HASH}" = "64" ] \
  || { say "ABORT: invalid pool universe hash for $REINDEX_OUT."; exit 9; }
mkdir -p "$UNIVERSE_SNAPSHOT_DIR" \
  || { say "ABORT: could not create $UNIVERSE_SNAPSHOT_DIR."; exit 9; }
UNIVERSE_SNAPSHOT="$UNIVERSE_SNAPSHOT_DIR/active-pools-$UNIVERSE_HASH.json"
if [ ! -f "$UNIVERSE_SNAPSHOT" ]; then
  SNAPSHOT_TMP="$UNIVERSE_SNAPSHOT.tmp.$$"
  cp "$REINDEX_OUT" "$SNAPSHOT_TMP" \
    || { say "ABORT: could not snapshot pool universe."; exit 9; }
  chmod 444 "$SNAPSHOT_TMP"
  mv "$SNAPSHOT_TMP" "$UNIVERSE_SNAPSHOT"
fi
[ "$(sha256sum "$UNIVERSE_SNAPSHOT" | awk '{print $1}')" = "$UNIVERSE_HASH" ] \
  || { say "ABORT: content-addressed universe snapshot failed verification."; exit 9; }
tmp=$(mktemp)
grep -v '^SEARCHER_POOL_UNIVERSE_PATH=' "$ENVF" > "$tmp" || true
echo "SEARCHER_POOL_UNIVERSE_PATH=$UNIVERSE_SNAPSHOT" >> "$tmp"
cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
say "pool universe pinned: hash=$UNIVERSE_HASH snapshot=$UNIVERSE_SNAPSHOT"

# ── Router allowlist auto-discovery (best-effort; never blocks/aborts the deploy) ──
# Proactive flow-admission refresh: scan recent local-reth blocks for out-of-allowlist `to` contracts
# that emit DEX swaps and are called by many distinct EOAs (router/aggregator, NOT single-operator arb
# bot), and append them to force-include-routers.json so the restarted searcher admits their swap flow.
# git reset --hard already restored the committed seed; this appends live-discovered routers on top
# (idempotent, re-run each deploy). Mirrors the pool-universe re-index above.
ROUTER_DISCOVERY_BLOCKS="${MEMPOOL_ROUTER_DISCOVERY_BLOCKS:-600}"
if timeout 180 sh -c 'cd "$0/listener" && npx tsx src/searcher/discover-routers.ts --rpc http://127.0.0.1:8545 --blocks "$1"' "$REPO" "$ROUTER_DISCOVERY_BLOCKS" \
     >/tmp/deploy-discover-routers.log 2>&1; then
  RADD=$(grep -c '\[discover-routers\] added ' /tmp/deploy-discover-routers.log 2>/dev/null || echo 0)
  say "router discovery: appended $RADD new router(s) to force-include-routers.json."
else
  say "WARNING: router discovery failed/timed out — keeping committed force-include-routers.json (deploy continues)."
fi

# ── 5. Restart + verify mode ──
LOGF=$(systemctl show mev-searcher -p StandardOutput --value 2>/dev/null | sed -n 's/^append://p')
[ -n "$LOGF" ] || LOGF=/var/log/mev-live.log
LOG_OFFSET=$(wc -c < "$LOGF" 2>/dev/null || echo 0)
systemctl restart mev-searcher
sleep 8
ACTIVE=$(systemctl is-active mev-searcher)
NEWPID=$(systemctl show -p MainPID --value mev-searcher)
DRY=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | grep -c "^SEARCHER_DRY_RUN=$DRY_VAL")
PROCESS_UNIVERSE=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null \
  | sed -n 's/^SEARCHER_POOL_UNIVERSE_PATH=//p' | tail -1)
BACKRUN_EXPECTED=0
[ -f "$REPO/.backrun" ] && BACKRUN_EXPECTED=1
BACKRUN=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | grep -c "^SEARCHER_ENABLE_BACKRUN=$BACKRUN_EXPECTED")
say "restarted: active=$ACTIVE pid=$NEWPID mode=$MODE dry_run_env=$(tr '\0' '\n' < /proc/$NEWPID/environ 2>/dev/null | grep '^SEARCHER_DRY_RUN=' | cut -d= -f2)"
if [ "$DRY" != "1" ]; then
  say "WARNING: restarted process SEARCHER_DRY_RUN != $DRY_VAL (expected for mode=$MODE) — STOP and investigate."; exit 9
fi
if [ "$BACKRUN" != "1" ]; then
  say "WARNING: restarted process SEARCHER_ENABLE_BACKRUN != $BACKRUN_EXPECTED — STOP and investigate."; exit 9
fi
if [ "$PROCESS_UNIVERSE" != "$UNIVERSE_SNAPSHOT" ] \
   || [ "$(sha256sum "$PROCESS_UNIVERSE" 2>/dev/null | awk '{print $1}')" != "$UNIVERSE_HASH" ]; then
  say "ABORT: restarted process did not retain the verified immutable universe snapshot."; exit 9
fi
say "runtime universe verified: $PROCESS_UNIVERSE hash=$UNIVERSE_HASH"
BANNER=""
for _ in $(seq 1 60); do
  BANNER=$(tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null | grep 'pool registry:' | tail -1)
  [ -n "$BANNER" ] && break
  sleep 1
done
if [ -z "$BANNER" ]; then
  say "ABORT: missing pool registry startup banner after restart (log $LOGF)."; exit 9
fi
tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null \
  | grep -q "\[searcher/live\] backrun=$( [ "$BACKRUN_EXPECTED" = "1" ] && echo enabled || echo disabled )" \
  || { say "ABORT: backrun startup banner does not match marker-controlled posture."; exit 9; }
tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null \
  | grep -Fq "[searcher/live] events emit → $EVENTS_PATH" \
  || { say "ABORT: events telemetry banner missing for $EVENTS_PATH."; exit 9; }
say "startup banner: $BANNER"
if echo "$BANNER" | grep -Eq '(^|[[:space:]])universe=0([^0-9]|$)|\+ 0 universe([^0-9]|$)'; then
  say "ABORT: pool universe loaded zero pools after restart."; exit 9
fi
if [ "$MODE" = "LIVE" ]; then
  say "########################################################################"
  say "### DONE — *** LIVE BROADCAST MODE *** on bounded test wallet $WALLET  ###"
  say "### Real mainnet transactions will be signed + sent. Remove $LIVE_MARKER ###"
  say "### to revert to dry-run on the next deploy.                           ###"
  say "########################################################################"
else
  say "DONE — dry-run on latest main. backup: $REPO-deploy-$TS.tar.gz"
fi
