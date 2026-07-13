#!/usr/bin/env bash
# Node-side A/B canary slot manager. Run via SSM from the trusted origin/main copy.
# It owns only the shared B runtime slot; Git analysis branches may exist independently.
set -euo pipefail

ROOT=/opt/MEV-ab
MAIN_REPO=/opt/MEV
WT=$ROOT/b
ENVF=$ROOT/b.env
B_SECRETS=$ROOT/b-secrets.env
STATE=$ROOT/state.json
HISTORY=$ROOT/history.jsonl
LOCK=$ROOT/slot.lock
UNIT=mev-ab-b
A_UNIT=mev-searcher
LOG=/var/log/mev-ab-b.log
EXPECTED_WALLET=0x2a6b8024190CF537efA3685792f201FD1Aac7294
EXPECTED_BOTVM=0xCF471995e8FbD99F8dBE8377FA67Db89Ab18af24
EXPECTED_A_WALLET=0xb8578B6de173C8554FF0390dB5a7effA567DDA3c
EXPECTED_A_BOTVM=0x4aF9495C4aC24c5CD3b0C90611550a1996415BCe
LOCAL_RPC=http://127.0.0.1:8545
# A measured Hermes window is 60 minutes after challenger cold-start/warmup. Keep one bounded lease long
# enough for warmup + the full window + close; stale/crashed slots are still reaped automatically.
LEASE_SECONDS=${AB_LEASE_SECONDS:-5400}
PAUSE_LEASE_SECONDS=${AB_PAUSE_LEASE_SECONDS:-900}
FIRST_SCAN_TIMEOUT_SECONDS=${AB_FIRST_SCAN_TIMEOUT_SECONDS:-240}

mkdir -p "$ROOT" "$ROOT/archive" "$ROOT/universe"
touch "$LOCK"
exec 9>"$LOCK"
flock -x 9
A_PROCESS_ENV=$(mktemp /run/mev-ab-a-process.XXXXXX)
chmod 600 "$A_PROCESS_ENV"
trap 'rm -f "$A_PROCESS_ENV"' EXIT

die() { echo "ABORT: $*" >&2; exit 9; }
env_get() {
  local key=$1 value
  if value=$(printenv "$key" 2>/dev/null); then
    printf '%s\n' "$value"
  else
    sed -n "s/^$key=//p" "$ENVF" | tail -1
  fi
}
file_env_get() { sed -n "s/^$2=//p" "$1" | tail -1; }
lower() { tr '[:upper:]' '[:lower:]'; }
valid_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]]; }
valid_branch() { [[ "$1" =~ ^ab/[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$ ]]; }
valid_report_path() {
  [[ "$1" =~ ^docs/research/reports/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$ ]] && [[ "$1" != *".."* ]]
}
[ "$LEASE_SECONDS" -ge 300 ] && [ "$LEASE_SECONDS" -le 7200 ] || die "AB_LEASE_SECONDS must be 300..7200"
[ "$PAUSE_LEASE_SECONDS" -ge 60 ] && [ "$PAUSE_LEASE_SECONDS" -le 1800 ] || die "AB_PAUSE_LEASE_SECONDS must be 60..1800"
[ "$FIRST_SCAN_TIMEOUT_SECONDS" -ge 90 ] && [ "$FIRST_SCAN_TIMEOUT_SECONDS" -le 600 ] \
  || die "AB_FIRST_SCAN_TIMEOUT_SECONDS must be 90..600"

state_field() {
  python3 - "$STATE" "$1" <<'PY'
import json, os, sys
p, k = sys.argv[1:]
if not os.path.exists(p):
    print("")
else:
    print(json.load(open(p)).get(k, ""))
PY
}

state_update() {
  local tmp
  tmp=$(mktemp "$ROOT/state.XXXXXX")
  python3 - "$STATE" "$tmp" "$@" <<'PY'
import json, os, sys, time
state, out, *pairs = sys.argv[1:]
if len(pairs) % 2:
    raise SystemExit("state_update requires key/value pairs")
doc = json.load(open(state)) if os.path.exists(state) else {"schema_version": 1}
integer_keys = {
    "lease_until", "updated_at", "a_restarts_before", "a_restart_delta",
    "b_restarts", "a_pid_before", "a_pid_after", "champion_pid_changed",
}
for i in range(0, len(pairs), 2):
    key, value = pairs[i:i + 2]
    doc[key] = int(value or 0) if key in integer_keys else value
doc["updated_at"] = int(time.time())
with open(out, "w") as f:
    json.dump(doc, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  mv "$tmp" "$STATE"
}

unit_restarts() {
  systemctl show -p NRestarts --value "$1" 2>/dev/null | grep -E '^[0-9]+$' || echo 0
}

hash_file() {
  [ -f "$1" ] || die "missing fairness input $1"
  sha256sum "$1" | awk '{print $1}'
}

hash_or_unavailable() {
  if [ -f "$1" ]; then sha256sum "$1" | awk '{print $1}'; else echo unavailable; fi
}

unit_log_path() {
  local unit=$1 fallback=$2 path
  path=$(systemctl show "$unit" -p StandardOutput --value 2>/dev/null | sed -n 's/^append://p')
  printf '%s\n' "${path:-$fallback}"
}

runtime_hash() {
  local log=$1 key=$2
  [ -f "$log" ] || { echo unavailable; return; }
  grep "$key=" "$log" 2>/dev/null | tail -1 \
    | sed -n "s/.*$key=0x\([0-9a-fA-F]\{64\}\).*/\1/p" \
    | tr '[:upper:]' '[:lower:]' \
    | grep -E '^[0-9a-f]{64}$' || echo unavailable
}

append_history() {
  python3 - "$STATE" "$HISTORY" <<'PY'
import json, sys
state, history = sys.argv[1:]
with open(state) as f:
    row = json.load(f)
with open(history, "a") as f:
    f.write(json.dumps(row, sort_keys=True) + "\n")
PY
}

cpu_layout() {
  local count half
  count=$(nproc)
  [ "$count" -ge 4 ] || die "need at least 4 CPUs for simultaneous A/B"
  half=$((count / 2))
  A_CPUS="0-$((half - 1))"
  B_CPUS="$half-$((count - 1))"
  ALL_CPUS="0-$((count - 1))"
}

stop_b() {
  systemctl stop "$UNIT" >/dev/null 2>&1 || true
  systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
  cpu_layout
  systemctl set-property --runtime "$A_UNIT" AllowedCPUs="$ALL_CPUS" >/dev/null
}

capture_fairness() {
  [ -f "$STATE" ] || return 0
  local a_before a_now b_now a_path b_path a_pid_before a_pid_after pid_changed a_log b_log
  a_before=$(state_field a_restarts_before); a_before=${a_before:-0}
  a_now=$(unit_restarts "$A_UNIT")
  b_now=$(unit_restarts "$UNIT")
  a_pid_before=$(state_field a_pid_before); a_pid_before=${a_pid_before:-0}
  a_pid_after=$(systemctl show -p MainPID --value "$A_UNIT" 2>/dev/null || echo 0)
  pid_changed=0; [ "$a_pid_after" = "$a_pid_before" ] || pid_changed=1
  a_path=$(state_field a_universe_path)
  b_path=$(state_field b_universe_path)
  a_log=$(state_field a_log_path)
  b_log=$(state_field b_log_path)
  state_update \
    a_restart_delta "$((a_now - a_before))" \
    a_pid_after "$a_pid_after" champion_pid_changed "$pid_changed" \
    b_restarts "$b_now" \
    a_universe_hash_after "$(hash_or_unavailable "$a_path")" \
    b_universe_hash_after "$(hash_or_unavailable "$b_path")" \
    a_blockscan_view_hash_after "$(runtime_hash "$a_log" blockscan_view_hash)" \
    b_blockscan_view_hash_after "$(runtime_hash "$b_log" blockscan_view_hash)" \
    a_blockscan_graph_hash_after "$(runtime_hash "$a_log" blockscan_graph_hash)" \
    b_blockscan_graph_hash_after "$(runtime_hash "$b_log" blockscan_graph_hash)" \
    failure_reason ""
}

reap_stale() {
  [ -f "$STATE" ] || return 0
  local status lease now experiment branch
  status=$(state_field status)
  lease=$(state_field lease_until)
  now=$(date +%s)
  if [ "$status" = "running" ] && [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" != "active" ]; then
    experiment=$(state_field experiment_id)
    branch=$(state_field branch)
    capture_fairness
    stop_b
    state_update status closed lease_until 0 outcome crashed_needs_escalation \
      failure_reason b_unit_inactive_while_state_running
    append_history
    echo "reaped inactive B experiment=$experiment branch=$branch; branch retained"
    return 0
  fi
  if { [ "$status" = "running" ] || [ "$status" = "paused" ]; } \
      && [ "${lease:-0}" -gt 0 ] && [ "$lease" -le "$now" ]; then
    experiment=$(state_field experiment_id)
    branch=$(state_field branch)
    if [ "$status" = "running" ]; then capture_fairness; fi
    stop_b
    state_update status closed lease_until 0 outcome crashed_needs_escalation
    append_history
    echo "reaped stale experiment=$experiment branch=$branch; branch retained"
  fi
}

check_wallet_envelope() {
  local env_file=$1 expected_wallet=$2 expected_botvm=$3 label=$4 baseline_file=$5
  local pk wallet botvm owner balance cap cap_wei baseline
  pk=$(file_env_get "$env_file" PRIVATE_KEY)
  [ -n "$pk" ] || pk=$(file_env_get "$env_file" OWNER_PRIVATE_KEY)
  [ -n "$pk" ] || die "$label private key missing"
  wallet=$(cast wallet address --private-key "$pk" 2>/dev/null)
  [ "$(printf %s "$wallet" | lower)" = "$(printf %s "$expected_wallet" | lower)" ] \
    || die "$label key does not match its authorized wallet"
  botvm=$(file_env_get "$env_file" BOTVM_ADDRESS)
  [ "$(printf %s "$botvm" | lower)" = "$(printf %s "$expected_botvm" | lower)" ] \
    || die "$label BOTVM_ADDRESS is not authorized"
  owner=$(cast call "$botvm" 'owner()(address)' --rpc-url "$LOCAL_RPC" 2>/dev/null || true)
  [ "$(printf %s "$owner" | lower)" = "$(printf %s "$wallet" | lower)" ] \
    || die "$label wallet is not BotVM owner"
  balance=$(cast balance "$wallet" --rpc-url "$LOCAL_RPC" 2>/dev/null)
  cap=$(file_env_get "$env_file" MEV_LIVE_MAX_WALLET_ETH); cap=${cap:-0.2}
  cap_wei=$(cast to-wei "$cap" 2>/dev/null)
  [ -n "$balance" ] && [ -n "$cap_wei" ] || die "could not evaluate $label wallet cap"
  python3 - "$balance" "$cap_wei" <<'PY' || die "$label wallet exceeds bounded-live cap"
import sys
raise SystemExit(0 if int(sys.argv[1]) <= int(sys.argv[2]) else 1)
PY
  if [ ! -s "$baseline_file" ]; then
    printf '%s\n' "$balance" > "$baseline_file"
    chmod 600 "$baseline_file"
  fi
  baseline=$(cat "$baseline_file")
  python3 - "$balance" "$baseline" <<'PY' || die "$label wallet fell below 50% of its bounded-live baseline"
import sys
raise SystemExit(0 if int(sys.argv[1]) * 2 >= int(sys.argv[2]) else 1)
PY
}

preflight() {
  [ -f "$ENVF" ] || die "missing $ENVF"
  [ "$(stat -c %a "$ENVF")" = "600" ] || die "$ENVF must be mode 600"
  [ "$(systemctl is-active "$A_UNIT" 2>/dev/null || true)" = "active" ] || die "champion unit is not active"
  local apid
  apid=$(systemctl show -p MainPID --value "$A_UNIT")
  [ -r "/proc/$apid/environ" ] || die "cannot read champion environment"
  tr '\0' '\n' < "/proc/$apid/environ" > "$A_PROCESS_ENV"
  chmod 600 "$A_PROCESS_ENV"
  for pair in \
    SEARCHER_DRY_RUN=0 SEARCHER_EV_GATE=1 SEARCHER_ENABLE_BACKRUN=0 SEARCHER_ENABLE_MEMPOOL=0 \
    SEARCHER_ENABLE_BLOCK_SCAN=1 SEARCHER_BLOCKSCAN_SUBMIT=1; do
    local key=${pair%%=*} expected=${pair#*=}
    [ "$(file_env_get "$A_PROCESS_ENV" "$key")" = "$expected" ] \
      || die "champion $key must equal $expected"
  done
  [[ "$(file_env_get "$A_PROCESS_ENV" SEARCHER_DISCOVERY_TO_BLOCK)" =~ ^[0-9]+$ ]] \
    || die "champion SEARCHER_DISCOVERY_TO_BLOCK must be pinned by deploy-node.sh"

  for pair in \
    SEARCHER_DRY_RUN=0 SEARCHER_EV_GATE=1 SEARCHER_ENABLE_BACKRUN=0 SEARCHER_ENABLE_MEMPOOL=0 \
    SEARCHER_ENABLE_BLOCK_SCAN=1 SEARCHER_BLOCKSCAN_SUBMIT=1 SEARCHER_BLOCKSCAN_ANVIL_PORT=8567; do
    local key=${pair%%=*} expected=${pair#*=}
    [ "$(env_get "$key")" = "$expected" ] || die "$key must equal $expected in $ENVF"
  done
  [ "$(env_get SEARCHER_EVENTS_PATH)" = "/var/log/mev/events/searcher-ab-b.jsonl" ] \
    || die "B requires its dedicated SEARCHER_EVENTS_PATH"
  check_wallet_envelope "$A_PROCESS_ENV" "$EXPECTED_A_WALLET" "$EXPECTED_A_BOTVM" champion "$ROOT/.a-start-balance-wei"
  check_wallet_envelope "$ENVF" "$EXPECTED_WALLET" "$EXPECTED_BOTVM" challenger "$ROOT/.b-start-balance-wei"
}

build_runtime_env() {
  local experiment=$1 input_mode allowed a_env runtime_env a_common b_common a_pool_path
  input_mode=$(env_get AB_INPUT_MODE); input_mode=${input_mode:-shared}
  [ "$input_mode" = "shared" ] || [ "$input_mode" = "challenger" ] || die "AB_INPUT_MODE must be shared|challenger"
  allowed=",$(env_get AB_ALLOWED_CONFIG_DELTA),"
  a_env="$ROOT/a-search.env"
  runtime_env="$ROOT/b-runtime.env"
  a_common="$ROOT/a-common.env"
  b_common="$ROOT/b-common.env"
  grep '^SEARCHER_' "$A_PROCESS_ENV" > "$a_env"
  grep -v '^SEARCHER_' "$ENVF" > "$B_SECRETS"
  : > "$a_common"
  : > "$runtime_env"
  while IFS= read -r line; do
    local key=${line%%=*}
    case "$key" in
      SEARCHER_EVENTS_PATH|SEARCHER_BLOCKSCAN_ANVIL_PORT|SEARCHER_LIVE_RPC_URL|SEARCHER_LIVE_WS_URL|SEARCHER_POOL_UNIVERSE_PATH) continue ;;
    esac
    if [[ "$allowed" == *",$key,"* ]]; then continue; fi
    echo "$line" >> "$a_common"
    echo "$line" >> "$runtime_env"
  done < "$a_env"
  IFS=',' read -r -a allowed_keys <<< "$(env_get AB_ALLOWED_CONFIG_DELTA)"
  for key in "${allowed_keys[@]}"; do
    [ -n "$key" ] || continue
    [[ "$key" =~ ^SEARCHER_[A-Z0-9_]+$ ]] || die "invalid AB_ALLOWED_CONFIG_DELTA key: $key"
    local val
    val=$(env_get "$key")
    [ -n "$val" ] || die "allowed config delta $key has no B value"
    echo "$key=$val" >> "$runtime_env"
  done
  cat >> "$runtime_env" <<EOF
SEARCHER_DRY_RUN=0
SEARCHER_EV_GATE=1
SEARCHER_ENABLE_BACKRUN=0
SEARCHER_ENABLE_MEMPOOL=0
SEARCHER_ENABLE_BLOCK_SCAN=1
SEARCHER_BLOCKSCAN_SUBMIT=1
SEARCHER_BLOCKSCAN_ANVIL_PORT=8567
SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-ab-b.jsonl
SEARCHER_LIVE_RPC_URL=http://127.0.0.1:8545
SEARCHER_LIVE_WS_URL=ws://127.0.0.1:8546
EOF
  a_pool_path=$(file_env_get "$A_PROCESS_ENV" SEARCHER_POOL_UNIVERSE_PATH)
  if [ -z "$a_pool_path" ]; then
    A_UNIVERSE="$MAIN_REPO/listener/searcher/pools/active-pools.json"
  elif [[ "$a_pool_path" = /* ]]; then
    A_UNIVERSE="$a_pool_path"
  else
    A_UNIVERSE="$MAIN_REPO/listener/$a_pool_path"
  fi
  [ -f "$A_UNIVERSE" ] || die "champion pool universe missing: $A_UNIVERSE"
  if [ "$input_mode" = "shared" ]; then
    local snapshot="$ROOT/universe/$experiment-active-pools.json"
    cp -f "$A_UNIVERSE" "$snapshot"
    echo "SEARCHER_POOL_UNIVERSE_PATH=$snapshot" >> "$runtime_env"
    B_UNIVERSE="$snapshot"
  else
    B_UNIVERSE="$WT/listener/searcher/pools/active-pools.json"
    echo "SEARCHER_POOL_UNIVERSE_PATH=$B_UNIVERSE" >> "$runtime_env"
  fi
  python3 - "$a_common" "$runtime_env" <<'PY'
import sys
for path in sys.argv[1:]:
    values = {}
    for raw in open(path):
        line = raw.rstrip("\n")
        if "=" in line:
            values[line.split("=", 1)[0]] = line
    with open(path, "w") as f:
        for key in sorted(values):
            f.write(values[key] + "\n")
PY
  : > "$b_common"
  while IFS= read -r line; do
    local key=${line%%=*}
    case "$key" in
      SEARCHER_EVENTS_PATH|SEARCHER_BLOCKSCAN_ANVIL_PORT|SEARCHER_LIVE_RPC_URL|SEARCHER_LIVE_WS_URL|SEARCHER_POOL_UNIVERSE_PATH) continue ;;
    esac
    if [[ "$allowed" == *",$key,"* ]]; then continue; fi
    echo "$line" >> "$b_common"
  done < "$runtime_env"
  cmp -s "$a_common" "$b_common" || {
    diff -u "$a_common" "$b_common" >&2 || true
    die "normalized A/B SEARCHER config differs outside AB_ALLOWED_CONFIG_DELTA"
  }
  chmod 600 "$B_SECRETS" "$runtime_env" "$a_common" "$b_common"
  A_CONFIG_HASH=$(hash_file "$a_common")
  B_CONFIG_HASH=$(hash_file "$b_common")
  INPUT_MODE=$input_mode
}

prepare_challenger_dependencies() {
  local a_lock="$MAIN_REPO/listener/package-lock.json"
  local b_lock="$WT/listener/package-lock.json"
  local a_modules="$MAIN_REPO/listener/node_modules"
  [ -f "$a_lock" ] && [ -f "$b_lock" ] || die "listener package-lock.json missing"
  cmp -s "$a_lock" "$b_lock" \
    || die "challenger dependency lock differs from champion; unattended canary install is not authorized"
  [ -d "$a_modules" ] || die "champion listener/node_modules missing"
  rm -rf "$WT/listener/node_modules"
  ln -s "$a_modules" "$WT/listener/node_modules"
}

resolve_a_universe() {
  local a_pool_path
  a_pool_path=$(file_env_get "$A_PROCESS_ENV" SEARCHER_POOL_UNIVERSE_PATH)
  if [ -z "$a_pool_path" ]; then
    A_UNIVERSE="$MAIN_REPO/listener/searcher/pools/active-pools.json"
  elif [[ "$a_pool_path" = /* ]]; then
    A_UNIVERSE="$a_pool_path"
  else
    A_UNIVERSE="$MAIN_REPO/listener/$a_pool_path"
  fi
  [ -f "$A_UNIVERSE" ] || die "champion pool universe missing: $A_UNIVERSE"
}

deploy() {
  local experiment=$1 branch=$2 expected_a=$3 expected_b=$4 report_path=$5 allow_runtime_view_delta=${6:-0}
  local now lease current_status current_lease current_experiment requested_input_mode requested_config_delta
  valid_id "$experiment" || die "invalid experiment id"
  valid_branch "$branch" || die "branch must match ab/*"
  [[ "$expected_a" =~ ^[a-f0-9]{40}$ ]] || die "base commit must be a full SHA"
  [[ "$expected_b" =~ ^[a-f0-9]{40}$ ]] || die "challenger commit must be a full SHA"
  valid_report_path "$report_path" || die "candidate report must be a safe docs/research/reports/*.md path"
  [ "$allow_runtime_view_delta" = "0" ] || [ "$allow_runtime_view_delta" = "1" ] \
    || die "allow-runtime-view-delta must be 0|1"
  requested_input_mode=$(env_get AB_INPUT_MODE); requested_input_mode=${requested_input_mode:-shared}
  [ "$requested_input_mode" = "shared" ] || [ "$requested_input_mode" = "challenger" ] \
    || die "AB_INPUT_MODE must be shared|challenger"
  requested_config_delta=$(env_get AB_ALLOWED_CONFIG_DELTA)
  reap_stale
  now=$(date +%s); lease=$((now + LEASE_SECONDS))
  current_status=$(state_field status); current_lease=$(state_field lease_until); current_experiment=$(state_field experiment_id)
  if { [ "$current_status" = "running" ] || [ "$current_status" = "paused" ]; } \
      && [ "${current_lease:-0}" -gt "$now" ] && [ "$current_experiment" != "$experiment" ]; then
    echo "BUSY: B slot held by $current_experiment until $current_lease" >&2
    exit 75
  fi
  preflight
  resolve_a_universe
  local a_commit b_commit
  a_commit=$(git -C "$MAIN_REPO" rev-parse HEAD)
  [ "$a_commit" = "$expected_a" ] || die "champion commit drift: expected $expected_a got $a_commit"
  git -C "$MAIN_REPO" fetch origin "$branch" -q
  git -C "$MAIN_REPO" rev-parse --verify "origin/$branch^{commit}" >/dev/null || die "remote challenger branch missing"
  b_commit=$(git -C "$MAIN_REPO" rev-parse "origin/$branch^{commit}")
  [ "$b_commit" = "$expected_b" ] || die "challenger branch drift: expected $expected_b got $b_commit"
  [ "$(git -C "$MAIN_REPO" merge-base "$a_commit" "$b_commit")" = "$a_commit" ] \
    || die "challenger is not based on the deployed champion commit"
  stop_b
  if [ -e "$WT/.git" ]; then
    if [ -n "$(git -C "$WT" status --porcelain)" ]; then
      tar czf "$ROOT/archive/$experiment-dirty-$(date +%s).tgz" -C "$WT" .
    fi
    git -C "$WT" reset --hard "origin/$branch" >/dev/null
    git -C "$WT" clean -fd >/dev/null
  elif [ -e "$WT" ]; then
    die "$WT exists but is not a git worktree"
  else
    git -C "$MAIN_REPO" worktree add --detach "$WT" "origin/$branch" >/dev/null
  fi
  [ -f "$WT/$report_path" ] || die "candidate report is not present in the frozen challenger commit"
  local changed_file production_change=0
  while IFS= read -r changed_file; do
    [ -n "$changed_file" ] || continue
    case "$changed_file" in
      "$report_path") ;;
      */test/*|*/tests/*|*/fixtures/*|*.test.ts|*.spec.ts)
        die "B challenger modifies its own replay/test evidence instead of production only: $changed_file"
        ;;
      listener/src/searcher/*.ts|listener/src/shared/*.ts|listener/src/adapters/*.ts|\
      listener/src/submitter.ts|listener/src/compiler.ts|listener/src/encoder.ts|listener/src/types.ts)
        production_change=1
        ;;
      *)
        die "B challenger contains a non-runtime or unapproved file: $changed_file"
        ;;
    esac
  done < <(git -C "$MAIN_REPO" diff --name-only "$a_commit..$b_commit")
  [ "$production_change" = "1" ] \
    || die "B challenger has no production searcher/contract behavior change"
  prepare_challenger_dependencies
  (cd "$WT/listener" && npm run build >/tmp/mev-ab-build.log 2>&1) || die "challenger build failed (see /tmp/mev-ab-build.log)"
  local replay_universe="$ROOT/universe/$experiment-replay-active-pools.json"
  cp -f "$A_UNIVERSE" "$replay_universe"
  (cd "$MAIN_REPO/analysis" && npm run ab-canary-gate -- "$WT/$report_path" \
    --phase candidate \
    --expected-experiment "$experiment" \
    --expected-branch "$branch" \
    --expected-base "$expected_a" \
    --expected-challenger "$expected_b" \
    --expected-runtime-view-delta "$allow_runtime_view_delta" \
    --expected-input-mode "$requested_input_mode" \
    --expected-config-delta "$requested_config_delta" \
    --base-root "$MAIN_REPO" \
    --challenger-root "$WT" \
    --universe "$replay_universe" \
    --rpc "$LOCAL_RPC") \
    >/tmp/mev-ab-candidate-gate.log 2>&1 \
    || die "production candidate gate failed (see /tmp/mev-ab-candidate-gate.log)"
  build_runtime_env "$experiment"
  cpu_layout
  local a_restarts_before a_pid_before
  a_restarts_before=$(unit_restarts "$A_UNIT")
  a_pid_before=$(systemctl show -p MainPID --value "$A_UNIT")
  systemctl set-property --runtime "$A_UNIT" AllowedCPUs="$A_CPUS" >/dev/null
  : > "$LOG"
  systemd-run --unit="$UNIT" --collect --service-type=simple \
    --property="WorkingDirectory=$WT/listener" \
    --property="AllowedCPUs=$B_CPUS" \
    --property="Restart=on-failure" --property="RestartSec=5" \
    --property="StandardOutput=append:$LOG" --property="StandardError=append:$LOG" \
    /bin/bash -lc "set -a; source '$B_SECRETS'; source '$ROOT/b-runtime.env'; set +a; exec /usr/bin/npm run searcher:live" \
    >/dev/null
  sleep 8
  [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" = "active" ] || { stop_b; die "challenger failed to start"; }
  grep -q '\[searcher/live\] mode=live' "$LOG" || { stop_b; die "challenger live banner missing"; }
  grep -q 'backrun=disabled' "$LOG" || { stop_b; die "challenger backrun-off banner missing"; }
  grep -q 'mempool=disabled' "$LOG" || { stop_b; die "challenger mempool-off banner missing"; }
  ! grep -q 'MEV-Share SSE connected' "$LOG" || { stop_b; die "challenger unexpectedly connected to MEV-Share"; }
  ! grep -q 'src=mev-share' "$LOG" || { stop_b; die "challenger unexpectedly processed a MEV-Share hint"; }
  local scan_ready=0
  for _ in $(seq 1 "$FIRST_SCAN_TIMEOUT_SECONDS"); do
    if grep -q '\[searcher/blockscan\] block=.*scannedPairs=' "$LOG"; then
      scan_ready=1
      break
    fi
    sleep 1
  done
  [ "$scan_ready" = "1" ] || {
    stop_b
    die "challenger never completed its first block-scan pass within ${FIRST_SCAN_TIMEOUT_SECONDS}s"
  }
  [ "$(git -C "$WT" rev-parse HEAD)" = "$b_commit" ] || { stop_b; die "challenger worktree commit drift"; }
  local a_universe_hash b_universe_hash a_log a_view_hash b_view_hash a_graph_hash b_graph_hash
  local discovery_to_block
  a_universe_hash=$(hash_file "$A_UNIVERSE")
  b_universe_hash=$(hash_file "$B_UNIVERSE")
  a_log=$(unit_log_path "$A_UNIT" /var/log/mev-live.log)
  a_view_hash=$(runtime_hash "$a_log" blockscan_view_hash)
  b_view_hash=$(runtime_hash "$LOG" blockscan_view_hash)
  a_graph_hash=$(runtime_hash "$a_log" blockscan_graph_hash)
  b_graph_hash=$(runtime_hash "$LOG" blockscan_graph_hash)
  for pair in \
    "A blockscan view:$a_view_hash" "B blockscan view:$b_view_hash" \
    "A blockscan graph:$a_graph_hash" "B blockscan graph:$b_graph_hash"; do
    [[ "${pair#*:}" =~ ^[0-9a-f]{64}$ ]] || { stop_b; die "${pair%%:*} hash unavailable"; }
  done
  if [ "$allow_runtime_view_delta" = "0" ]; then
    [ "$a_view_hash" = "$b_view_hash" ] \
      || { stop_b; die "A/B blockscan pool views differ without a predeclared runtime-view delta"; }
    [ "$a_graph_hash" = "$b_graph_hash" ] \
      || { stop_b; die "A/B runtime token graphs differ without a predeclared runtime-view delta"; }
  fi
  discovery_to_block=$(file_env_get "$A_PROCESS_ENV" SEARCHER_DISCOVERY_TO_BLOCK)
  state_update \
    experiment_id "$experiment" branch "$branch" status running lease_until "$lease" outcome "" \
    production_report_path "$report_path" production_report_hash "$(hash_file "$WT/$report_path")" \
    a_commit "$a_commit" b_commit "$b_commit" \
    a_config_hash "$A_CONFIG_HASH" b_config_hash "$B_CONFIG_HASH" \
    a_universe_hash "$a_universe_hash" b_universe_hash "$b_universe_hash" \
    a_universe_hash_after "$a_universe_hash" b_universe_hash_after "$b_universe_hash" failure_reason "" \
    a_universe_path "$A_UNIVERSE" b_universe_path "$B_UNIVERSE" input_mode "$INPUT_MODE" \
    discovery_to_block "$discovery_to_block" allow_runtime_view_delta "$allow_runtime_view_delta" \
    a_blockscan_view_hash "$a_view_hash" b_blockscan_view_hash "$b_view_hash" \
    a_blockscan_view_hash_after "$a_view_hash" b_blockscan_view_hash_after "$b_view_hash" \
    a_blockscan_graph_hash "$a_graph_hash" b_blockscan_graph_hash "$b_graph_hash" \
    a_blockscan_graph_hash_after "$a_graph_hash" b_blockscan_graph_hash_after "$b_graph_hash" \
    a_log_path "$a_log" b_log_path "$LOG" \
    a_restarts_before "$a_restarts_before" a_restart_delta 0 b_restarts 0 \
    a_pid_before "$a_pid_before" a_pid_after "$a_pid_before" champion_pid_changed 0 \
    cpu_partition "A:$A_CPUS,B:$B_CPUS"
  cat "$STATE"
}

pause_experiment() {
  local experiment=$1 current
  valid_id "$experiment" || die "invalid experiment id"
  current=$(state_field experiment_id)
  [ "$current" = "$experiment" ] || die "state belongs to $current, not $experiment"
  [ "$(state_field status)" = "running" ] || die "experiment is not running"
  capture_fairness
  stop_b
  state_update status paused lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
  cat "$STATE"
}

close_experiment() {
  local experiment=$1 outcome=$2 current status
  valid_id "$experiment" || die "invalid experiment id"
  case "$outcome" in win|lose|needs_escalation|crashed_needs_escalation) ;; *) die "invalid outcome";; esac
  current=$(state_field experiment_id)
  [ "$current" = "$experiment" ] || die "state belongs to $current, not $experiment"
  status=$(state_field status)
  if [ "$status" = "running" ]; then
    capture_fairness
    stop_b
  elif [ "$status" != "paused" ]; then
    die "experiment must be running or paused before close (status=$status)"
  fi
  state_update status closed lease_until 0 outcome "$outcome"
  append_history
  cat "$STATE"
}

renew() {
  local experiment=$1 current now
  current=$(state_field experiment_id)
  [ "$current" = "$experiment" ] || die "state belongs to $current, not $experiment"
  [ "$(state_field status)" = "running" ] || die "experiment is not running"
  now=$(date +%s)
  state_update lease_until "$((now + LEASE_SECONDS))"
  cat "$STATE"
}

cmd=${1:-status}
case "$cmd" in
  preflight) preflight; echo "PASS: challenger bounded-live preflight" ;;
  deploy) { [ "$#" -eq 6 ] || [ "$#" -eq 7 ]; } \
    || die "usage: deploy <experiment-id> <ab/branch> <base-sha> <challenger-sha> <candidate-report.md> [allow-runtime-view-delta=0|1]"; \
    deploy "$2" "$3" "$4" "$5" "$6" "${7:-0}" ;;
  pause) [ "$#" -eq 2 ] || die "usage: pause <experiment-id>"; pause_experiment "$2" ;;
  close) [ "$#" -eq 3 ] || die "usage: close <experiment-id> <outcome>"; close_experiment "$2" "$3" ;;
  renew) [ "$#" -eq 2 ] || die "usage: renew <experiment-id>"; renew "$2" ;;
  reap) reap_stale; [ -f "$STATE" ] && cat "$STATE" || echo '{}' ;;
  status) reap_stale; [ -f "$STATE" ] && cat "$STATE" || echo '{}' ;;
  *) die "usage: $0 preflight|deploy|pause|close|renew|reap|status" ;;
esac
