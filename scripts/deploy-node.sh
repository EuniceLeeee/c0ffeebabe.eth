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
#    Even then, LIVE is REFUSED unless the signing wallet holds <= MEV_LIVE_MAX_WALLET_ETH,
#    which cannot exceed the fixed 0.2 ETH authorization, AND SEARCHER_EV_GATE=1.
#    wallet (flash-loan arbs are atomic → worst-case loss is bounded to that wallet's gas/bribe
#    balance). Remove the marker → next deploy reverts to dry-run.
#  - The full working env is recovered from the RUNNING process BEFORE reset, so a truncated
#    /opt/MEV/.env can never silently drop tuning knobs. Dirty files are tar-backed-up first.
set -uo pipefail
REPO=/opt/MEV
ENVF=$REPO/.env
TS=$(date +%Y%m%d-%H%M%S)
say() { echo "[deploy $TS] $*"; }

env_value() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -1; }
process_env_value() {
  tr '\0' '\n' < "/proc/$2/environ" 2>/dev/null | sed -n "s/^$1=//p" | tail -1
}
process_env_count() {
  tr '\0' '\n' < "/proc/$2/environ" 2>/dev/null | grep -c "^$1=" || true
}

canonicalize_env() {
  local path=$1 out
  out=$(mktemp)
  python3 - "$path" "$out" <<'PY' || { rm -f "$out"; return 1; }
import os, re, sys

source, destination = sys.argv[1:]
values = {}
order = []
for line_number, raw in enumerate(open(source), 1):
    line = raw.rstrip("\n")
    if not line or line.lstrip().startswith("#"):
        continue
    if "=" not in line:
        raise SystemExit(f"invalid env line {line_number}")
    key, value = line.split("=", 1)
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
        raise SystemExit(f"invalid env key on line {line_number}")
    if "\x00" in value or "\r" in value or "\n" in value:
        raise SystemExit(f"invalid env value for {key}")
    if key not in values:
        order.append(key)
    values[key] = value
with open(destination, "w") as out:
    for key in order:
        out.write(f"{key}={values[key]}\n")
os.chmod(destination, 0o600)
PY
  mv "$out" "$path"
}

unit_is_stopped() {
  local unit=$1 props load state pid
  props=$(systemctl show -p LoadState -p ActiveState -p MainPID "$unit" 2>/dev/null) || return 1
  load=$(printf '%s\n' "$props" | sed -n 's/^LoadState=//p')
  state=$(printf '%s\n' "$props" | sed -n 's/^ActiveState=//p')
  pid=$(printf '%s\n' "$props" | sed -n 's/^MainPID=//p')
  [ -n "$load" ] && [ -n "$state" ] && [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$load" = "not-found" ] && [ "$pid" = "0" ] && return 0
  { [ "$state" = "inactive" ] || [ "$state" = "failed" ]; } && [ "$pid" = "0" ]
}

stop_searcher_verified() {
  systemctl stop mev-searcher >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    unit_is_stopped mev-searcher && return 0
    sleep 1
  done
  systemctl kill --kill-who=all --signal=KILL mev-searcher >/dev/null 2>&1 || true
  systemctl stop mev-searcher >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    unit_is_stopped mev-searcher && return 0
    sleep 1
  done
  return 1
}

abort_runtime() {
  local reason=$1 stopped=1
  stop_searcher_verified || stopped=0
  if [ "$MODE" = "LIVE" ]; then
    rm -f "$LIVE_MARKER"
    if [ "$stopped" = "1" ]; then
      say "ABORT (live runtime): $reason; searcher stop verified and live marker removed."
    else
      say "CRITICAL ABORT (live runtime): $reason; live marker removed but searcher stop could not be verified."
    fi
  else
    if [ "$stopped" = "1" ]; then
      say "ABORT (runtime): $reason; searcher stop verified."
    else
      say "CRITICAL ABORT (runtime): $reason; searcher stop could not be verified."
    fi
  fi
  exit 9
}

NON_SEARCHER_KEYS="MAINNET_RPC_URL PRIVATE_KEY OWNER_PRIVATE_KEY BOTVM_ADDRESS BOTVM_OWNER MEV_SHARE_SSE_URL MEV_LIVE_MAX_WALLET_ETH"
OPP_TTL_MS="${SEARCHER_OPP_TTL_MS:-5000}"
# Pool-universe topN: how many ranked active-pools enter the runtime graph. Default 20000 (operator
# 2026-07-12) — the running value; the old 6000 default silently reset a 20000 .env on every deploy
# because SSM spawns a fresh sh (no SEARCHER_* inherited), so the :-fallback ALWAYS applied. Deploy-
# controlled (like OPP_TTL_MS) so it survives the recover-from-process .env rebuild. Latency-affordable.
POOL_UNIVERSE_TOP_N="${SEARCHER_POOL_UNIVERSE_TOP_N:-20000}"
STARTUP_BANNER_TIMEOUT_SECONDS="${SEARCHER_STARTUP_BANNER_TIMEOUT_SECONDS:-600}"
[ "$STARTUP_BANNER_TIMEOUT_SECONDS" -ge 60 ] && [ "$STARTUP_BANNER_TIMEOUT_SECONDS" -le 1200 ] \
  || { say "ABORT: SEARCHER_STARTUP_BANNER_TIMEOUT_SECONDS must be 60..1200"; exit 9; }
LIVE_MARKER=$REPO/.deploy-live
LOCAL_RPC=http://127.0.0.1:8545
LOCAL_WS=ws://127.0.0.1:8546
AUTHORIZED_MAX_WALLET_ETH=0.2
MEV_LIVE_MAX_WALLET_ETH=${MEV_LIVE_MAX_WALLET_ETH:-$AUTHORIZED_MAX_WALLET_ETH}
DEFAULT_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl
ANVIL_PORT=8555
BLOCKSCAN_ANVIL_PORT=8556
# Mode is fixed before any marker/env validation so every later failure can safely stop an old live A.
if [ -f "$LIVE_MARKER" ]; then MODE=LIVE; DRY_VAL=0; else MODE=DRY; DRY_VAL=1; fi
AB_ROOT=/opt/MEV-ab
AB_STATE=$AB_ROOT/state.json
mkdir -p "$AB_ROOT"
exec 8>"$AB_ROOT/slot.lock"
flock -x 8
if ! AB_UNIT_PROPS=$(systemctl show -p LoadState -p ActiveState -p MainPID mev-ab-b 2>/dev/null); then
  say "ABORT: could not verify challenger unit state; close/reap the A/B window before deploying A."
  exit 75
fi
AB_LOAD_STATE=$(printf '%s\n' "$AB_UNIT_PROPS" | sed -n 's/^LoadState=//p')
AB_ACTIVE_STATE=$(printf '%s\n' "$AB_UNIT_PROPS" | sed -n 's/^ActiveState=//p')
AB_MAIN_PID=$(printf '%s\n' "$AB_UNIT_PROPS" | sed -n 's/^MainPID=//p')
if [ -z "$AB_LOAD_STATE" ] || [ -z "$AB_ACTIVE_STATE" ] || ! [[ "$AB_MAIN_PID" =~ ^[0-9]+$ ]]; then
  say "ABORT: incomplete challenger unit state; close/reap the A/B window before deploying A."
  exit 75
fi
if { [ "$AB_LOAD_STATE" != "not-found" ] \
      && [ "$AB_ACTIVE_STATE" != "inactive" ] && [ "$AB_ACTIVE_STATE" != "failed" ]; } \
    || [ "$AB_MAIN_PID" != "0" ]; then
  say "ABORT: challenger unit is not fully stopped (load=$AB_LOAD_STATE state=$AB_ACTIVE_STATE pid=$AB_MAIN_PID); close/reap the A/B window before deploying A."
  exit 75
fi
if [ -f "$AB_STATE" ]; then
  if ! AB_STATUS_LEASE=$(python3 - "$AB_STATE" 2>/dev/null <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
print(str(doc.get("status", "")), int(doc.get("lease_until", 0) or 0))
PY
  ); then
    say "ABORT: malformed A/B state; trusted reap is required before deploying A."
    exit 75
  fi
  AB_STATUS=${AB_STATUS_LEASE%% *}
  AB_LEASE=${AB_STATUS_LEASE#* }
  if [ "$AB_STATUS" = "running" ] || [ "$AB_STATUS" = "paused" ]; then
    say "ABORT: A/B state is still $AB_STATUS (lease=$AB_LEASE); trusted close/reap is required before deploying A."
    exit 75
  fi
fi

if { [ -f "$REPO/.mempool" ] || [ -f "$REPO/.mev-share" ]; } && [ ! -f "$REPO/.backrun" ]; then
  abort_runtime "victim-source markers require .backrun"
fi
if [ -f "$REPO/.backrun" ] && [ ! -f "$REPO/.mempool" ] && [ ! -f "$REPO/.mev-share" ]; then
  abort_runtime ".backrun requires .mempool and/or .mev-share"
fi
if [ -f "$REPO/.backrun" ]; then BACKRUN_VAL=1; else BACKRUN_VAL=0; fi
if [ -f "$REPO/.mempool" ]; then MEMPOOL_VAL=1; else MEMPOOL_VAL=0; fi
if [ -f "$REPO/.mev-share" ]; then MEV_SHARE_VAL=1; else MEV_SHARE_VAL=0; fi

cd "$REPO" || abort_runtime "missing repository $REPO"
DISCOVERY_TO_BLOCK=$(curl -sS "$LOCAL_RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"],16))' 2>/dev/null || echo 0)
[ "$DISCOVERY_TO_BLOCK" -gt 0 ] \
  || abort_runtime "could not pin SEARCHER_DISCOVERY_TO_BLOCK from local reth"

recover_running_env() {
  tr '\0' '\n' < "/proc/$PID/environ" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    case "$key" in
      SEARCHER_DRY_RUN|SEARCHER_OPP_TTL_MS|SEARCHER_POOL_UNIVERSE_TOP_N|SEARCHER_DISCOVERY_TO_BLOCK|SEARCHER_EVENTS_PATH|SEARCHER_LIVE_RPC_URL|SEARCHER_LIVE_WS_URL|SEARCHER_RUNTIME_COMMIT|SEARCHER_FORCE_INCLUDE_ROUTERS_PATH|SEARCHER_BRIBE_ALL_ABOVE_GAS|SEARCHER_ENABLE_HASH_ONLY|SEARCHER_ENABLE_BACKRUN|SEARCHER_ENABLE_MEMPOOL|SEARCHER_ENABLE_MEV_SHARE|SEARCHER_EAGER_STATE_BACKEND|SEARCHER_ANVIL_PORT|SEARCHER_BLOCKSCAN_ANVIL_PORT|SEARCHER_ENABLE_PROTOCOL_EDGES|SEARCHER_ENABLE_BLOCK_SCAN|SEARCHER_BLOCKSCAN_SUBMIT) continue ;;
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
  echo "SEARCHER_LIVE_RPC_URL=$LOCAL_RPC" >> "$tmp"
  echo "SEARCHER_LIVE_WS_URL=$LOCAL_WS" >> "$tmp"
  echo "SEARCHER_DRY_RUN=$DRY_VAL" >> "$tmp"
  # bribe-all-above-gas is marker-controlled ($REPO/.bribe-all-above-gas), like .deploy-live —
  # a single durable source that survives the recover-from-process rebuild. Does NOT touch the
  # DRY_RUN broadcast guard; only sizes the bribe (net stays ≥0 by the EV gate).
  [ -f "$REPO/.bribe-all-above-gas" ] && echo "SEARCHER_BRIBE_ALL_ABOVE_GAS=1" >> "$tmp"
  # protocol-edges is marker-controlled ($REPO/.protocol-edges), like .bribe-all-above-gas —
  # admits every registered family that declares requiresProtocolEdgesFlag. Family identity and
  # execution semantics remain registry-owned; the deploy script names none. Remove the marker → off.
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
  # Victim sources are independently marker-controlled behind the shared backrun lane.
  echo "SEARCHER_ENABLE_BACKRUN=$BACKRUN_VAL" >> "$tmp"
  echo "SEARCHER_ENABLE_MEMPOOL=$MEMPOOL_VAL" >> "$tmp"
  echo "SEARCHER_ENABLE_MEV_SHARE=$MEV_SHARE_VAL" >> "$tmp"
  echo "SEARCHER_EAGER_STATE_BACKEND=$BACKRUN_VAL" >> "$tmp"
  echo "SEARCHER_ANVIL_PORT=$ANVIL_PORT" >> "$tmp"
  echo "SEARCHER_BLOCKSCAN_ANVIL_PORT=$BLOCKSCAN_ANVIL_PORT" >> "$tmp"
  canonicalize_env "$tmp" \
    || { rm -f "$tmp"; abort_runtime "recovered runtime environment is invalid"; }
  cp -f "$ENVF" "$ENVF.bak-$TS" 2>/dev/null
  cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
  say "env rebuilt ($(wc -l < "$ENVF") keys) + DRY_RUN=$DRY_VAL + TTL=$OPP_TTL_MS + poolUniverseTopN=$POOL_UNIVERSE_TOP_N + discoveryToBlock=$DISCOVERY_TO_BLOCK"
else
  say "no running process — ensuring DRY_RUN=$DRY_VAL in existing .env (mode=$MODE)"
  EXISTING_EVENTS_PATH=$(sed -n 's/^SEARCHER_EVENTS_PATH=//p' "$ENVF" 2>/dev/null | tail -1)
  EVENTS_PATH=${SEARCHER_EVENTS_PATH:-${EXISTING_EVENTS_PATH:-$DEFAULT_EVENTS_PATH}}
  tmp=$(mktemp)
  cp -f "$ENVF" "$ENVF.bak-$TS" 2>/dev/null
  [ -f "$ENVF" ] && grep -v -E '^(SEARCHER_DRY_RUN|SEARCHER_OPP_TTL_MS|SEARCHER_POOL_UNIVERSE_TOP_N|SEARCHER_DISCOVERY_TO_BLOCK|SEARCHER_EVENTS_PATH|SEARCHER_LIVE_RPC_URL|SEARCHER_LIVE_WS_URL|SEARCHER_RUNTIME_COMMIT|SEARCHER_FORCE_INCLUDE_ROUTERS_PATH|SEARCHER_BRIBE_ALL_ABOVE_GAS|SEARCHER_ENABLE_HASH_ONLY|SEARCHER_ENABLE_BACKRUN|SEARCHER_ENABLE_MEMPOOL|SEARCHER_ENABLE_MEV_SHARE|SEARCHER_EAGER_STATE_BACKEND|SEARCHER_ANVIL_PORT|SEARCHER_BLOCKSCAN_ANVIL_PORT|SEARCHER_ENABLE_PROTOCOL_EDGES|SEARCHER_ENABLE_BLOCK_SCAN|SEARCHER_BLOCKSCAN_SUBMIT)=' "$ENVF" > "$tmp"
  echo "SEARCHER_OPP_TTL_MS=$OPP_TTL_MS" >> "$tmp"
  echo "SEARCHER_POOL_UNIVERSE_TOP_N=$POOL_UNIVERSE_TOP_N" >> "$tmp"
  echo "SEARCHER_DISCOVERY_TO_BLOCK=$DISCOVERY_TO_BLOCK" >> "$tmp"
  echo "SEARCHER_EVENTS_PATH=$EVENTS_PATH" >> "$tmp"
  echo "SEARCHER_LIVE_RPC_URL=$LOCAL_RPC" >> "$tmp"
  echo "SEARCHER_LIVE_WS_URL=$LOCAL_WS" >> "$tmp"
  echo "SEARCHER_DRY_RUN=$DRY_VAL" >> "$tmp"
  [ -f "$REPO/.bribe-all-above-gas" ] && echo "SEARCHER_BRIBE_ALL_ABOVE_GAS=1" >> "$tmp"
  [ -f "$REPO/.protocol-edges" ] && echo "SEARCHER_ENABLE_PROTOCOL_EDGES=1" >> "$tmp"  # registry-declared family gate
  [ -f "$REPO/.block-scan" ] && echo "SEARCHER_ENABLE_BLOCK_SCAN=1" >> "$tmp"  # BS-lane Pass A log-only, marker-gated
  [ -f "$REPO/.blockscan-submit" ] && echo "SEARCHER_BLOCKSCAN_SUBMIT=1" >> "$tmp"  # BS-lane Pass B atomic submit, marker-gated
  [ -f "$REPO/.hash-only" ] && echo "SEARCHER_ENABLE_HASH_ONLY=1" >> "$tmp"  # MEV-Share consumption marker-gated, DEFAULT OFF (2026-07-07 ghost flow)
  echo "SEARCHER_ENABLE_BACKRUN=$BACKRUN_VAL" >> "$tmp"
  echo "SEARCHER_ENABLE_MEMPOOL=$MEMPOOL_VAL" >> "$tmp"
  echo "SEARCHER_ENABLE_MEV_SHARE=$MEV_SHARE_VAL" >> "$tmp"
  echo "SEARCHER_EAGER_STATE_BACKEND=$BACKRUN_VAL" >> "$tmp"
  echo "SEARCHER_ANVIL_PORT=$ANVIL_PORT" >> "$tmp"
  echo "SEARCHER_BLOCKSCAN_ANVIL_PORT=$BLOCKSCAN_ANVIL_PORT" >> "$tmp"
  canonicalize_env "$tmp" \
    || { rm -f "$tmp"; abort_runtime "existing environment is invalid"; }
  cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
fi

# ── 2. Broadcast guard ──
MEV_LIVE_MAX_WALLET_ETH=$(env_value MEV_LIVE_MAX_WALLET_ETH "$ENVF")
MEV_LIVE_MAX_WALLET_ETH=${MEV_LIVE_MAX_WALLET_ETH:-$AUTHORIZED_MAX_WALLET_ETH}
if [ "$MODE" = "DRY" ]; then
  # HARD guard: refuse to continue unless DRY_RUN=1 is present exactly once.
  if [ "$(grep -c '^SEARCHER_DRY_RUN=1' "$ENVF")" != "1" ]; then
    abort_runtime "SEARCHER_DRY_RUN=1 not uniquely present in $ENVF"
  fi
else
  # LIVE path: deliberate marker present. Refuse unless bounded test wallet + EV gate on.
  say "*** LIVE marker present ($LIVE_MARKER) — validating bounded-test-wallet envelope ***"
  [ "$(grep -c '^SEARCHER_EV_GATE=' "$ENVF")" = "1" ] \
    && [ "$(env_value SEARCHER_EV_GATE "$ENVF")" = "1" ] \
    || abort_runtime "unique SEARCHER_EV_GATE=1 required"
  PK=$(env_value PRIVATE_KEY "$ENVF")
  [ -n "$PK" ] || PK=$(env_value OWNER_PRIVATE_KEY "$ENVF")
  [ -n "$PK" ] || abort_runtime "no PRIVATE_KEY or OWNER_PRIVATE_KEY"
  WALLET=$(cast wallet address --private-key "$PK" 2>/dev/null)
  [ -n "$WALLET" ] || abort_runtime "could not derive wallet from key"
  BOTVM_ADDRESS=$(env_value BOTVM_ADDRESS "$ENVF")
  BOTVM_OWNER=$(env_value BOTVM_OWNER "$ENVF")
  [ "$(printf %s "$BOTVM_OWNER" | tr '[:upper:]' '[:lower:]')" = \
    "$(printf %s "$WALLET" | tr '[:upper:]' '[:lower:]')" ] \
    || abort_runtime "effective signer does not match BOTVM_OWNER"
  ONCHAIN_OWNER=$(cast call "$BOTVM_ADDRESS" 'owner()(address)' --rpc-url "$LOCAL_RPC" 2>/dev/null || true)
  [ "$(printf %s "$ONCHAIN_OWNER" | tr '[:upper:]' '[:lower:]')" = \
    "$(printf %s "$WALLET" | tr '[:upper:]' '[:lower:]')" ] \
    || abort_runtime "effective signer is not the on-chain BotVM owner"
  BAL_WEI=$(cast balance "$WALLET" --rpc-url "$LOCAL_RPC" 2>/dev/null)
  CAP_WEI=$(cast to-wei "$MEV_LIVE_MAX_WALLET_ETH" 2>/dev/null)
  AUTHORIZED_CAP_WEI=$(cast to-wei "$AUTHORIZED_MAX_WALLET_ETH" 2>/dev/null)
  [ -n "$BAL_WEI" ] && [ -n "$CAP_WEI" ] && [ -n "$AUTHORIZED_CAP_WEI" ] \
    || abort_runtime "could not read wallet balance/cap"
  if ! python3 - "$CAP_WEI" "$AUTHORIZED_CAP_WEI" <<'PY'
import sys
configured, authorized = map(int, sys.argv[1:])
raise SystemExit(0 if 0 < configured <= authorized else 1)
PY
  then
    abort_runtime "configured cap exceeds the fixed ${AUTHORIZED_MAX_WALLET_ETH} ETH authorization"
  fi
  if ! python3 -c "import sys; sys.exit(0 if int('$BAL_WEI') <= int('$CAP_WEI') else 1)"; then
    abort_runtime "wallet $WALLET balance $BAL_WEI wei exceeds cap ${MEV_LIVE_MAX_WALLET_ETH} ETH"
  fi
  if [ "$(grep -c '^SEARCHER_DRY_RUN=0' "$ENVF")" != "1" ]; then
    abort_runtime "SEARCHER_DRY_RUN=0 not set as expected"
  fi
  say "LIVE envelope OK: wallet=$WALLET balance=$BAL_WEI wei (<= ${MEV_LIVE_MAX_WALLET_ETH} ETH), EV_GATE=1."
fi

# ── 3. Backup dirty files, then update code ──
git ls-files -m -o --exclude-standard 2>/dev/null | grep -v node_modules > "/tmp/dirty-$TS.txt"
tar czf "$REPO-deploy-$TS.tar.gz" -T "/tmp/dirty-$TS.txt" 2>/dev/null
# macOS AppleDouble sidecars are not source files. Preserve them in the backup
# above, then remove only the two namespaces scanned by the production tool index.
find "$REPO/analysis/src/cli" "$REPO/scripts" -type f -name '._*' -delete 2>/dev/null || true
git fetch origin -q || abort_runtime "git fetch origin failed"
git reset --hard origin/main || abort_runtime "git reset to origin/main failed"
say "code now at $(git rev-parse --short HEAD): $(git log --oneline -1)"

# ── 4. Build + production-analysis preflight ──
( cd "$REPO/listener" && npm run build ) \
  || abort_runtime "listener build failed after checkout update"
# Build the next revm daemon outside the live worktree. The old A process keeps
# its immutable process environment throughout every later preflight; only the
# restarted process receives the new content-addressed executable path.
DEPLOY_COMMIT=$(git rev-parse HEAD)
[[ "$DEPLOY_COMMIT" =~ ^[0-9a-f]{40}$ ]] || abort_runtime "deployed commit identity is invalid"
REVM_MANIFEST="$REPO/listener/revm-sim/Cargo.toml"
REVM_CARGO=${REVM_CARGO:-/root/.cargo/bin/cargo}
REVM_RUNTIME_DIR=/opt/MEV-runtime/revm
REVM_BUILD_DIR="$REVM_RUNTIME_DIR/build-$DEPLOY_COMMIT-$$"
REVM_BUILD_BIN="$REVM_BUILD_DIR/release/revm-sim"
[ -x "$REVM_CARGO" ] \
  || abort_runtime "modern Cargo missing at $REVM_CARGO"
mkdir -p "$REVM_RUNTIME_DIR"
CARGO_TARGET_DIR="$REVM_BUILD_DIR" "$REVM_CARGO" build --release --locked --manifest-path "$REVM_MANIFEST" \
  || abort_runtime "revm-sim release build failed after checkout update"
[ -x "$REVM_BUILD_BIN" ] || abort_runtime "staged revm-sim runtime artifact missing after build"
REVM_RUNTIME_HASH=$(sha256sum "$REVM_BUILD_BIN" | awk '{print $1}')
[[ "$REVM_RUNTIME_HASH" =~ ^[a-f0-9]{64}$ ]] \
  || abort_runtime "canonical revm-sim runtime artifact hash is invalid"
REVM_RUNTIME_BIN="$REVM_RUNTIME_DIR/revm-sim-$REVM_RUNTIME_HASH"
if [ ! -f "$REVM_RUNTIME_BIN" ]; then
  REVM_RUNTIME_TMP="$REVM_RUNTIME_BIN.tmp.$$"
  install -m 0555 "$REVM_BUILD_BIN" "$REVM_RUNTIME_TMP"
  mv "$REVM_RUNTIME_TMP" "$REVM_RUNTIME_BIN"
fi
rm -rf "$REVM_BUILD_DIR"
[ -x "$REVM_RUNTIME_BIN" ] \
  || abort_runtime "canonical revm-sim runtime artifact missing after publish"
[ "$(sha256sum "$REVM_RUNTIME_BIN" | awk '{print $1}')" = "$REVM_RUNTIME_HASH" ] \
  || abort_runtime "content-addressed revm-sim runtime artifact failed verification"
say "revm-sim staged: hash=$REVM_RUNTIME_HASH binary=$REVM_RUNTIME_BIN"
# Analysis CLIs execute TypeScript directly via the devDependency `tsx`. A git
# reset updates their source but not ignored node_modules, so install the exact
# lockfile and verify the production blockscan joins before this checkout is
# considered deployable. The running searcher is not restarted until these pass.
( cd "$REPO/analysis" \
    && npm ci --include=dev --prefer-offline --no-audit --no-fund \
    && npm run build \
    && node --import tsx --test src/test/blockscan-log-join.ts src/test/block-activity.ts \
      src/test/live-loss-blockscan.ts ) \
  || abort_runtime "analysis preflight failed after checkout update"

tmp=$(mktemp)
grep -vE '^SEARCHER_(RUNTIME_COMMIT|REVM_SIM_BIN)=' "$ENVF" > "$tmp" || true
echo "SEARCHER_RUNTIME_COMMIT=$DEPLOY_COMMIT" >> "$tmp"
echo "SEARCHER_REVM_SIM_BIN=$REVM_RUNTIME_BIN" >> "$tmp"
canonicalize_env "$tmp" || { rm -f "$tmp"; abort_runtime "could not bind runtime commit"; }
cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"

# ── V2 factory/fee lineage refresh (one snapshot shared by every process) ──
V2_LINEAGE_LOOKBACK_BLOCKS="${V2_LINEAGE_LOOKBACK_BLOCKS:-7200}"
V2_LINEAGE_DIR=/opt/MEV-runtime/v2-lineages
mkdir -p "$V2_LINEAGE_DIR" \
  || abort_runtime "could not create V2 lineage snapshot directory"
V2_LINEAGE_TMP="$V2_LINEAGE_DIR/.v2-lineages.refresh.$$.json"
V2_LINEAGE_CURRENT=$(env_value SEARCHER_V2_LINEAGES_PATH "$ENVF")
V2_LINEAGE_PINNED_PATH="${V2_LINEAGE_PINNED_PATH:-}"
V2_LINEAGE_SNAPSHOT=""
if [ -n "$V2_LINEAGE_CURRENT" ] && [ ! -f "$V2_LINEAGE_CURRENT" ]; then
  abort_runtime "configured V2 lineage snapshot is missing: $V2_LINEAGE_CURRENT"
fi
if [ -n "$V2_LINEAGE_PINNED_PATH" ]; then
  [ -f "$V2_LINEAGE_PINNED_PATH" ] \
    || abort_runtime "pinned V2 lineage snapshot is missing: $V2_LINEAGE_PINNED_PATH"
  V2_LINEAGE_HASH=$(sha256sum "$V2_LINEAGE_PINNED_PATH" | awk '{print $1}')
  [[ "$V2_LINEAGE_HASH" =~ ^[0-9a-f]{64}$ ]] \
    || abort_runtime "pinned V2 lineage snapshot hash is invalid"
  V2_LINEAGE_SNAPSHOT="$V2_LINEAGE_PINNED_PATH"
  say "using pinned V2 lineages: hash=$V2_LINEAGE_HASH"
elif say "refreshing V2 factory/fee lineages (${V2_LINEAGE_LOOKBACK_BLOCKS} blocks)…"; \
   timeout 240 env MAINNET_RPC_URL="http://127.0.0.1:8545" \
       V2_LINEAGE_OUT="$V2_LINEAGE_TMP" \
       SEARCHER_V2_LINEAGES_PATH="$V2_LINEAGE_CURRENT" \
       sh -c 'cd "$0/listener" && npm run refresh-v2-lineages -- --blocks "$1"' \
         "$REPO" "$V2_LINEAGE_LOOKBACK_BLOCKS" \
       >/tmp/deploy-v2-lineages.log 2>&1 \
   && [ -s "$V2_LINEAGE_TMP" ] \
   && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("chainId")==1 and len(d.get("lineages",[]))>0 else 1)' "$V2_LINEAGE_TMP"; then
  V2_LINEAGE_HASH=$(sha256sum "$V2_LINEAGE_TMP" | awk '{print $1}')
  [[ "$V2_LINEAGE_HASH" =~ ^[0-9a-f]{64}$ ]] \
    || abort_runtime "generated V2 lineage snapshot hash is invalid"
  V2_LINEAGE_SNAPSHOT="$V2_LINEAGE_DIR/v2-lineages-$V2_LINEAGE_HASH.json"
  if [ ! -f "$V2_LINEAGE_SNAPSHOT" ]; then
    chmod 444 "$V2_LINEAGE_TMP"
    mv "$V2_LINEAGE_TMP" "$V2_LINEAGE_SNAPSHOT"
  else
    rm -f "$V2_LINEAGE_TMP"
  fi
  [ "$(sha256sum "$V2_LINEAGE_SNAPSHOT" | awk '{print $1}')" = "$V2_LINEAGE_HASH" ] \
    || abort_runtime "content-addressed V2 lineage snapshot failed verification"
else
  rm -f "$V2_LINEAGE_TMP" 2>/dev/null || true
  if [ -n "$V2_LINEAGE_CURRENT" ]; then
    say "WARNING: V2 lineage refresh failed/timed out — keeping $V2_LINEAGE_CURRENT."
  else
    say "WARNING: V2 lineage refresh failed/timed out — keeping the built-in verified baseline."
  fi
fi
# Validate the exact snapshot selected for the next process with the same
# production parser the searcher imports. This deliberately runs before the
# lineage env rewrite and systemd restart, so an invalid pinned/current fallback
# is never persisted or started. The existing deploy-wide fail-closed policy
# still applies. An empty path validates the bundled baseline.
V2_LINEAGE_VALIDATION_PATH="${V2_LINEAGE_SNAPSHOT:-$V2_LINEAGE_CURRENT}"
( cd "$REPO/listener" \
    && env SEARCHER_V2_LINEAGES_PATH="$V2_LINEAGE_VALIDATION_PATH" \
      node --input-type=module -e \
        'const { loadV2Lineages } = await import("./dist/searcher/venues/v2-lineage.js"); loadV2Lineages(process.env.SEARCHER_V2_LINEAGES_PATH || undefined);' ) \
  || abort_runtime "selected V2 lineage snapshot failed production validation"
if [ -n "$V2_LINEAGE_SNAPSHOT" ]; then
  tmp=$(mktemp)
  grep -v '^SEARCHER_V2_LINEAGES_PATH=' "$ENVF" > "$tmp" || true
  echo "SEARCHER_V2_LINEAGES_PATH=$V2_LINEAGE_SNAPSHOT" >> "$tmp"
  canonicalize_env "$tmp" || { rm -f "$tmp"; abort_runtime "could not pin V2 lineage snapshot"; }
  cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
  V2_LINEAGE_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["lineages"]))' "$V2_LINEAGE_SNAPSHOT")
  say "V2 lineages pinned: hash=$V2_LINEAGE_HASH lineages=$V2_LINEAGE_COUNT"
fi

# ── Pool-universe re-index (best-effort; never blocks/aborts the deploy) ──
REINDEX_DAYS="${POOL_UNIVERSE_LOOKBACK_DAYS:-2}"
REINDEX_OUT="$REPO/listener/searcher/pools/active-pools.json"
REINDEX_TMP="/tmp/active-pools.reindex.$$.json"
REINDEX_MANIFEST="$REINDEX_OUT.manifest.json"
REINDEX_TMP_MANIFEST="$REINDEX_TMP.manifest.json"
REINDEX_RETAIN="${POOL_UNIVERSE_RETAIN_PATH:-$REINDEX_OUT}"
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
   && [ "$((REINDEX_HEAD - REINDEX_CUR_TOBLOCK))" -lt "$REINDEX_MAX_STALE_BLOCKS" ] \
   && [ -s "$REINDEX_MANIFEST" ]; then
  say "pool universe already fresh (toBlock=$REINDEX_CUR_TOBLOCK, head=$REINDEX_HEAD, $((REINDEX_HEAD - REINDEX_CUR_TOBLOCK)) < $REINDEX_MAX_STALE_BLOCKS blocks) — skipping re-index."
elif say "re-indexing pool universe (local reth, ${REINDEX_DAYS}d window, V4 from deployment)…"; \
   timeout 600 flock -w 30 /run/lock/mev-pooluniverse.lock \
       env MAINNET_RPC_URL="http://127.0.0.1:8545" \
       SEARCHER_V2_LINEAGES_PATH="$(env_value SEARCHER_V2_LINEAGES_PATH "$ENVF")" \
       POOL_UNIVERSE_LOOKBACK_DAYS="$REINDEX_DAYS" \
       POOL_UNIVERSE_RETAIN_PATH="$REINDEX_RETAIN" \
       POOL_UNIVERSE_OUT="$REINDEX_TMP" \
       POOL_UNIVERSE_MANIFEST_OUT="$REINDEX_TMP_MANIFEST" \
       sh -c 'cd "$0/listener" && npx tsx src/searcher/build-active-pool-universe.ts' "$REPO" \
       >/tmp/deploy-reindex.log 2>&1 \
   && [ -s "$REINDEX_TMP" ] && [ -s "$REINDEX_TMP_MANIFEST" ] \
   && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); p=d["pools"] if isinstance(d,dict) else d; sys.exit(0 if len(p)>0 else 1)' "$REINDEX_TMP"; then
  POOLS=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); p=d["pools"] if isinstance(d,dict) else d; print(len(p))' "$REINDEX_TMP")
  cp -a "$REINDEX_OUT" "${REINDEX_OUT}.bak-$(date +%s)" 2>/dev/null || true
  cp -a "$REINDEX_MANIFEST" "${REINDEX_MANIFEST}.bak-$(date +%s)" 2>/dev/null || true
  mv "$REINDEX_TMP" "$REINDEX_OUT"
  mv "$REINDEX_TMP_MANIFEST" "$REINDEX_MANIFEST"
  say "pool universe re-indexed: $POOLS pools (toBlock=head)."
else
  say "WARNING: pool-universe re-index failed/timed out — keeping existing active-pools.json (deploy continues)."
  rm -f "$REINDEX_TMP" "$REINDEX_TMP_MANIFEST" 2>/dev/null || true
fi

# Pin the running process to an immutable, content-addressed universe. The 30-minute indexer may replace
# active-pools.json while an A/B window is running; that file update must become input to the NEXT deploy,
# not silently mutate the champion's recorded fairness input mid-window.
UNIVERSE_HASH=$(sha256sum "$REINDEX_OUT" 2>/dev/null | awk '{print $1}')
case "$UNIVERSE_HASH" in
  [0-9a-f][0-9a-f]*) ;;
  *) abort_runtime "could not hash pool universe $REINDEX_OUT" ;;
esac
[ "${#UNIVERSE_HASH}" = "64" ] \
  || abort_runtime "invalid pool universe hash for $REINDEX_OUT"
mkdir -p "$UNIVERSE_SNAPSHOT_DIR" \
  || abort_runtime "could not create $UNIVERSE_SNAPSHOT_DIR"
UNIVERSE_SNAPSHOT="$UNIVERSE_SNAPSHOT_DIR/active-pools-$UNIVERSE_HASH.json"
UNIVERSE_MANIFEST_SNAPSHOT="$UNIVERSE_SNAPSHOT.manifest.json"
if [ ! -f "$UNIVERSE_SNAPSHOT" ]; then
  SNAPSHOT_TMP="$UNIVERSE_SNAPSHOT.tmp.$$"
  cp "$REINDEX_OUT" "$SNAPSHOT_TMP" \
    || abort_runtime "could not snapshot pool universe"
  chmod 444 "$SNAPSHOT_TMP"
  mv "$SNAPSHOT_TMP" "$UNIVERSE_SNAPSHOT"
fi
[ "$(sha256sum "$UNIVERSE_SNAPSHOT" | awk '{print $1}')" = "$UNIVERSE_HASH" ] \
  || abort_runtime "content-addressed universe snapshot failed verification"
if [ -s "$REINDEX_MANIFEST" ] && [ ! -f "$UNIVERSE_MANIFEST_SNAPSHOT" ]; then
  MANIFEST_SNAPSHOT_TMP="$UNIVERSE_MANIFEST_SNAPSHOT.tmp.$$"
  cp "$REINDEX_MANIFEST" "$MANIFEST_SNAPSHOT_TMP" \
    || abort_runtime "could not snapshot pool universe manifest"
  chmod 444 "$MANIFEST_SNAPSHOT_TMP"
  mv "$MANIFEST_SNAPSHOT_TMP" "$UNIVERSE_MANIFEST_SNAPSHOT"
fi
tmp=$(mktemp)
grep -Ev '^SEARCHER_POOL_UNIVERSE_(PATH|MANIFEST_PATH)=' "$ENVF" > "$tmp" || true
echo "SEARCHER_POOL_UNIVERSE_PATH=$UNIVERSE_SNAPSHOT" >> "$tmp"
if [ -s "$UNIVERSE_MANIFEST_SNAPSHOT" ]; then
  echo "SEARCHER_POOL_UNIVERSE_MANIFEST_PATH=$UNIVERSE_MANIFEST_SNAPSHOT" >> "$tmp"
fi
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

# Pin the exact router admission input too. A/B processes run from different worktrees, so a relative
# force-include file would silently give them different public-mempool victim sets.
ROUTER_ALLOWLIST="$REPO/listener/searcher/pools/force-include-routers.json"
[ -f "$ROUTER_ALLOWLIST" ] || abort_runtime "router allowlist missing: $ROUTER_ALLOWLIST"
ROUTER_HASH=$(sha256sum "$ROUTER_ALLOWLIST" 2>/dev/null | awk '{print $1}')
[[ "$ROUTER_HASH" =~ ^[0-9a-f]{64}$ ]] || abort_runtime "could not hash router allowlist"
ROUTER_SNAPSHOT_DIR=/opt/MEV-runtime/routers
mkdir -p "$ROUTER_SNAPSHOT_DIR" || abort_runtime "could not create $ROUTER_SNAPSHOT_DIR"
ROUTER_SNAPSHOT="$ROUTER_SNAPSHOT_DIR/force-include-routers-$ROUTER_HASH.json"
if [ ! -f "$ROUTER_SNAPSHOT" ]; then
  ROUTER_TMP="$ROUTER_SNAPSHOT.tmp.$$"
  cp "$ROUTER_ALLOWLIST" "$ROUTER_TMP" || abort_runtime "could not snapshot router allowlist"
  chmod 444 "$ROUTER_TMP"
  mv "$ROUTER_TMP" "$ROUTER_SNAPSHOT"
fi
[ "$(sha256sum "$ROUTER_SNAPSHOT" | awk '{print $1}')" = "$ROUTER_HASH" ] \
  || abort_runtime "content-addressed router snapshot failed verification"
tmp=$(mktemp)
grep -v '^SEARCHER_FORCE_INCLUDE_ROUTERS_PATH=' "$ENVF" > "$tmp" || true
echo "SEARCHER_FORCE_INCLUDE_ROUTERS_PATH=$ROUTER_SNAPSHOT" >> "$tmp"
canonicalize_env "$tmp" || { rm -f "$tmp"; abort_runtime "could not pin router allowlist"; }
cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
say "router allowlist pinned: hash=$ROUTER_HASH snapshot=$ROUTER_SNAPSHOT"

# ── 5. Restart + verify mode ──
LOGF=$(systemctl show mev-searcher -p StandardOutput --value 2>/dev/null | sed -n 's/^append://p')
[ -n "$LOGF" ] || LOGF=/var/log/mev-live.log
LOG_OFFSET=$(wc -c < "$LOGF" 2>/dev/null || echo 0)
systemctl restart mev-searcher || abort_runtime "systemctl restart mev-searcher failed"
sleep 8
ACTIVE=$(systemctl is-active mev-searcher)
NEWPID=$(systemctl show -p MainPID --value mev-searcher)
DRY=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | grep -c "^SEARCHER_DRY_RUN=$DRY_VAL")
PROCESS_UNIVERSE=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null \
  | sed -n 's/^SEARCHER_POOL_UNIVERSE_PATH=//p' | tail -1)
BACKRUN_EXPECTED=$BACKRUN_VAL
MEMPOOL_EXPECTED=$MEMPOOL_VAL
MEV_SHARE_EXPECTED=$MEV_SHARE_VAL
BACKRUN=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | grep -c "^SEARCHER_ENABLE_BACKRUN=$BACKRUN_EXPECTED")
MEMPOOL=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | grep -c "^SEARCHER_ENABLE_MEMPOOL=$MEMPOOL_EXPECTED")
MEV_SHARE=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | grep -c "^SEARCHER_ENABLE_MEV_SHARE=$MEV_SHARE_EXPECTED")
PROCESS_ANVIL_PORT=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | sed -n 's/^SEARCHER_ANVIL_PORT=//p' | tail -1)
PROCESS_BLOCKSCAN_ANVIL_PORT=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | sed -n 's/^SEARCHER_BLOCKSCAN_ANVIL_PORT=//p' | tail -1)
PROCESS_EAGER_STATE=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | sed -n 's/^SEARCHER_EAGER_STATE_BACKEND=//p' | tail -1)
PROCESS_RUNTIME_COMMIT=$(process_env_value SEARCHER_RUNTIME_COMMIT "$NEWPID")
PROCESS_REVM_SIM_BIN=$(process_env_value SEARCHER_REVM_SIM_BIN "$NEWPID")
PROCESS_ROUTER_SNAPSHOT=$(process_env_value SEARCHER_FORCE_INCLUDE_ROUTERS_PATH "$NEWPID")
say "restarted: active=$ACTIVE pid=$NEWPID mode=$MODE dry_run_env=$(tr '\0' '\n' < /proc/$NEWPID/environ 2>/dev/null | grep '^SEARCHER_DRY_RUN=' | cut -d= -f2)"
if [ "$DRY" != "1" ]; then
  abort_runtime "restarted process SEARCHER_DRY_RUN != $DRY_VAL"
fi
if [ "$BACKRUN" != "1" ]; then
  abort_runtime "restarted process SEARCHER_ENABLE_BACKRUN != $BACKRUN_EXPECTED"
fi
if [ "$MEMPOOL" != "1" ]; then
  abort_runtime "restarted process SEARCHER_ENABLE_MEMPOOL != $MEMPOOL_EXPECTED"
fi
if [ "$MEV_SHARE" != "1" ]; then
  abort_runtime "restarted process SEARCHER_ENABLE_MEV_SHARE != $MEV_SHARE_EXPECTED"
fi
if [ "$PROCESS_ANVIL_PORT" != "$ANVIL_PORT" ]; then
  abort_runtime "restarted process SEARCHER_ANVIL_PORT != $ANVIL_PORT"
fi
if [ "$PROCESS_BLOCKSCAN_ANVIL_PORT" != "$BLOCKSCAN_ANVIL_PORT" ]; then
  abort_runtime "restarted process SEARCHER_BLOCKSCAN_ANVIL_PORT != $BLOCKSCAN_ANVIL_PORT"
fi
if [ "$PROCESS_EAGER_STATE" != "$BACKRUN_EXPECTED" ]; then
  abort_runtime "restarted process SEARCHER_EAGER_STATE_BACKEND != $BACKRUN_EXPECTED"
fi
if [ "$PROCESS_RUNTIME_COMMIT" != "$DEPLOY_COMMIT" ]; then
  abort_runtime "restarted process runtime commit does not match deployed checkout"
fi
if [ "$PROCESS_REVM_SIM_BIN" != "$REVM_RUNTIME_BIN" ] \
   || [ "$(sha256sum "$PROCESS_REVM_SIM_BIN" 2>/dev/null | awk '{print $1}')" != "$REVM_RUNTIME_HASH" ]; then
  abort_runtime "restarted process did not retain the verified revm-sim artifact"
fi
if [ "$PROCESS_ROUTER_SNAPSHOT" != "$ROUTER_SNAPSHOT" ] \
   || [ "$(sha256sum "$PROCESS_ROUTER_SNAPSHOT" 2>/dev/null | awk '{print $1}')" != "$ROUTER_HASH" ]; then
  abort_runtime "restarted process did not retain the verified router snapshot"
fi
if [ "$MODE" = "LIVE" ]; then
  [ "$(process_env_count SEARCHER_EV_GATE "$NEWPID")" = "1" ] \
    && [ "$(process_env_value SEARCHER_EV_GATE "$NEWPID")" = "1" ] \
    || abort_runtime "effective SEARCHER_EV_GATE is not 1"
  RUNTIME_PK=$(process_env_value PRIVATE_KEY "$NEWPID")
  [ -n "$RUNTIME_PK" ] || RUNTIME_PK=$(process_env_value OWNER_PRIVATE_KEY "$NEWPID")
  RUNTIME_WALLET=$(cast wallet address --private-key "$RUNTIME_PK" 2>/dev/null || true)
  [ "$(printf %s "$RUNTIME_WALLET" | tr '[:upper:]' '[:lower:]')" = \
    "$(printf %s "$WALLET" | tr '[:upper:]' '[:lower:]')" ] \
    || abort_runtime "effective signer changed after restart"
  [ "$(printf %s "$(process_env_value BOTVM_ADDRESS "$NEWPID")" | tr '[:upper:]' '[:lower:]')" = \
    "$(printf %s "$BOTVM_ADDRESS" | tr '[:upper:]' '[:lower:]')" ] \
    || abort_runtime "effective BotVM changed after restart"
  [ "$(printf %s "$(process_env_value BOTVM_OWNER "$NEWPID")" | tr '[:upper:]' '[:lower:]')" = \
    "$(printf %s "$WALLET" | tr '[:upper:]' '[:lower:]')" ] \
    || abort_runtime "effective BotVM owner changed after restart"
fi
if [ "$PROCESS_UNIVERSE" != "$UNIVERSE_SNAPSHOT" ] \
   || [ "$(sha256sum "$PROCESS_UNIVERSE" 2>/dev/null | awk '{print $1}')" != "$UNIVERSE_HASH" ]; then
  abort_runtime "restarted process did not retain the verified immutable universe snapshot"
fi
say "runtime universe verified: $PROCESS_UNIVERSE hash=$UNIVERSE_HASH"
BANNER=""
for _ in $(seq 1 "$STARTUP_BANNER_TIMEOUT_SECONDS"); do
  BANNER=$(tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null | grep 'pool registry:' | tail -1)
  [ -n "$BANNER" ] && break
  sleep 1
done
if [ -z "$BANNER" ]; then
  abort_runtime "missing pool registry startup banner after restart (log $LOGF)"
fi
tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null \
  | grep "\[searcher/live\] backrun=$( [ "$BACKRUN_EXPECTED" = "1" ] && echo enabled || echo disabled )" >/dev/null \
  || abort_runtime "backrun startup banner does not match marker-controlled posture"
tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null \
  | grep "\[searcher/live\] mempool=$( [ "$MEMPOOL_EXPECTED" = "1" ] && echo enabled || echo disabled )" >/dev/null \
  || abort_runtime "mempool startup banner does not match marker-controlled posture"
tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null \
  | grep "\[searcher/live\] mevshare=$( [ "$MEV_SHARE_EXPECTED" = "1" ] && echo enabled || echo disabled )" >/dev/null \
  || abort_runtime "MEV-Share startup banner does not match marker-controlled posture"
if [ "$MEV_SHARE_EXPECTED" = "0" ]; then
  ! tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null | grep -q 'MEV-Share SSE connected' \
    || abort_runtime "MEV-Share connected despite disabled marker posture"
fi
tail -c "+$((LOG_OFFSET + 1))" "$LOGF" 2>/dev/null \
  | grep -F "[searcher/live] events emit → $EVENTS_PATH" >/dev/null \
  || abort_runtime "events telemetry banner missing for $EVENTS_PATH"
say "startup banner: $BANNER"
if echo "$BANNER" | grep -Eq '(^|[[:space:]])universe=0([^0-9]|$)|\+ 0 universe([^0-9]|$)'; then
  abort_runtime "pool universe loaded zero pools after restart"
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
