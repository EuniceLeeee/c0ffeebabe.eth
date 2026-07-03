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
LIVE_MARKER=$REPO/.deploy-live
LOCAL_RPC=${SEARCHER_LIVE_RPC_URL:-http://127.0.0.1:8545}
MEV_LIVE_MAX_WALLET_ETH=${MEV_LIVE_MAX_WALLET_ETH:-0.2}

# Mode: DRY (default) unless the human placed the live marker on the node.
if [ -f "$LIVE_MARKER" ]; then MODE=LIVE; DRY_VAL=0; else MODE=DRY; DRY_VAL=1; fi

cd "$REPO" || { say "no $REPO"; exit 1; }

recover_running_env() {
  tr '\0' '\n' < "/proc/$PID/environ" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    case "$key" in
      SEARCHER_DRY_RUN|SEARCHER_OPP_TTL_MS|SEARCHER_BRIBE_ALL_ABOVE_GAS) continue ;;
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
  tmp=$(mktemp)
  recover_running_env > "$tmp"
  echo "SEARCHER_OPP_TTL_MS=$OPP_TTL_MS" >> "$tmp"
  echo "SEARCHER_DRY_RUN=$DRY_VAL" >> "$tmp"
  # bribe-all-above-gas is marker-controlled ($REPO/.bribe-all-above-gas), like .deploy-live —
  # a single durable source that survives the recover-from-process rebuild. Does NOT touch the
  # DRY_RUN broadcast guard; only sizes the bribe (net stays ≥0 by the EV gate).
  [ -f "$REPO/.bribe-all-above-gas" ] && echo "SEARCHER_BRIBE_ALL_ABOVE_GAS=1" >> "$tmp"
  cp -f "$ENVF" "$ENVF.bak-$TS" 2>/dev/null
  cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
  say "env rebuilt ($(wc -l < "$ENVF") keys) + DRY_RUN=$DRY_VAL + TTL=$OPP_TTL_MS"
else
  say "no running process — ensuring DRY_RUN=$DRY_VAL in existing .env (mode=$MODE)"
  tmp=$(mktemp)
  cp -f "$ENVF" "$ENVF.bak-$TS" 2>/dev/null
  [ -f "$ENVF" ] && grep -v -E '^(SEARCHER_DRY_RUN|SEARCHER_OPP_TTL_MS|SEARCHER_BRIBE_ALL_ABOVE_GAS)=' "$ENVF" > "$tmp"
  echo "SEARCHER_OPP_TTL_MS=$OPP_TTL_MS" >> "$tmp"
  echo "SEARCHER_DRY_RUN=$DRY_VAL" >> "$tmp"
  [ -f "$REPO/.bribe-all-above-gas" ] && echo "SEARCHER_BRIBE_ALL_ABOVE_GAS=1" >> "$tmp"
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

# ── 4. Build ──
( cd "$REPO/listener" && npm run build ) || { say "build failed — NOT restarting"; exit 1; }

# ── Pool-universe re-index (best-effort; never blocks/aborts the deploy) ──
REINDEX_DAYS="${POOL_UNIVERSE_LOOKBACK_DAYS:-2}"
# V4 backfill (per-poolId backward Initialize search, default 2M blocks) is the scan's perf killer:
# hundreds of poolKeys-unresolvable v4 pools × a wide getLogs each pushes the scan >15min. Disable it
# (=0) so the scan completes in a few min — poolKeys()-resolvable v4 pools + in-window Initialize are
# still kept; only deep-history/unresolvable v4 is skipped (the census→auto-close bridge backfills those).
REINDEX_V4_BACKFILL="${POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS:-0}"
REINDEX_OUT="$REPO/listener/searcher/pools/active-pools.json"
REINDEX_TMP="/tmp/active-pools.reindex.$$.json"
say "re-indexing pool universe (local reth, ${REINDEX_DAYS}d window, v4-backfill=${REINDEX_V4_BACKFILL})…"
if timeout 600 env MAINNET_RPC_URL="http://127.0.0.1:8545" \
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

# ── 5. Restart + verify mode ──
LOGF=$(systemctl show mev-searcher -p StandardOutput --value 2>/dev/null | sed -n 's/^append://p')
[ -n "$LOGF" ] || LOGF=/var/log/mev-live.log
LOG_OFFSET=$(wc -c < "$LOGF" 2>/dev/null || echo 0)
systemctl restart mev-searcher
sleep 8
ACTIVE=$(systemctl is-active mev-searcher)
NEWPID=$(systemctl show -p MainPID --value mev-searcher)
DRY=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | grep -c "^SEARCHER_DRY_RUN=$DRY_VAL")
say "restarted: active=$ACTIVE pid=$NEWPID mode=$MODE dry_run_env=$(tr '\0' '\n' < /proc/$NEWPID/environ 2>/dev/null | grep '^SEARCHER_DRY_RUN=' | cut -d= -f2)"
if [ "$DRY" != "1" ]; then
  say "WARNING: restarted process SEARCHER_DRY_RUN != $DRY_VAL (expected for mode=$MODE) — STOP and investigate."; exit 9
fi
BANNER=""
for _ in $(seq 1 60); do
  BANNER=$(tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null | grep 'pool registry:' | tail -1)
  [ -n "$BANNER" ] && break
  sleep 1
done
if [ -z "$BANNER" ]; then
  say "ABORT: missing pool registry startup banner after restart (log $LOGF)."; exit 9
fi
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
