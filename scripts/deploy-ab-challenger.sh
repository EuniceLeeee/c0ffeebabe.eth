#!/usr/bin/env bash
# Node-side A/B canary slot manager. Run via SSM from the trusted origin/main copy.
# It owns only the shared B runtime slot; Git analysis branches may exist independently.
set -Eeuo pipefail

ROOT=/opt/MEV-ab
MAIN_REPO=/opt/MEV
WT=$ROOT/b
TRUSTED_BASE=$ROOT/trusted-base
ACCEPTANCE_TOOL=$ROOT/acceptance-tool
ENVF=$ROOT/b.env
B_SECRETS=$ROOT/b-secrets.env
B_PROCESS_ENV=$ROOT/b-process.env
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
AUTHORIZED_MAX_WALLET_ETH=0.2
LOCAL_RPC=http://127.0.0.1:8545
EVIDENCE_PROXY_PORT=8576
# A measured Hermes window is 60 minutes after challenger cold-start/warmup. Keep one bounded lease long
# enough for warmup + the full window + close; stale/crashed slots are still reaped automatically.
LEASE_SECONDS=${AB_LEASE_SECONDS:-5400}
PAUSE_LEASE_SECONDS=${AB_PAUSE_LEASE_SECONDS:-900}
# The 20k production universe can need several dual-lane blocks before one uncensored pass gets CPU.
# Keep readiness mandatory, but give the cold start enough wall-clock time to prove it.
FIRST_SCAN_TIMEOUT_SECONDS=${AB_FIRST_SCAN_TIMEOUT_SECONDS:-1200}
MEMPOOL_READY_TIMEOUT_SECONDS=${AB_MEMPOOL_READY_TIMEOUT_SECONDS:-60}
SIX_STEP_ACCEPTANCE_TIMEOUT_SECONDS=${AB_SIX_STEP_ACCEPTANCE_TIMEOUT_SECONDS:-9000}

mkdir -p "$ROOT" "$ROOT/archive" "$ROOT/universe" "$ROOT/candidate"
touch "$LOCK"
exec 9>"$LOCK"
flock -x 9
A_PROCESS_ENV=$(mktemp /run/mev-ab-a-process.XXXXXX)
chmod 600 "$A_PROCESS_ENV"
ACCEPTANCE_WORKER_PID=""

stop_acceptance_worker() {
  local pid=${ACCEPTANCE_WORKER_PID:-}
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      if ! kill -0 "$pid" 2>/dev/null && ! kill -0 -- "-$pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null || true
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  ACCEPTANCE_WORKER_PID=""
}

cleanup_ab_wrapper() {
  stop_acceptance_worker
  rm -f "$A_PROCESS_ENV"
}

trap cleanup_ab_wrapper EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

die() { echo "ABORT: $*" >&2; exit 9; }
env_get() {
  local key=$1 value
  if value=$(printenv "$key" 2>/dev/null); then
    printf '%s\n' "$value"
  else
    sed -n "s/^$key=//p" "$ENVF" | tail -1
  fi
}
lane_mode() {
  local mode
  mode=$(env_get AB_LANE_MODE); mode=${mode:-blockscan-only}
  case "$mode" in
    blockscan-only|dual) printf '%s\n' "$mode" ;;
    *) die "AB_LANE_MODE must be blockscan-only|dual" ;;
  esac
}
victim_mode() {
  local mode
  mode=$(env_get AB_VICTIM_MODE); mode=${mode:-both}
  case "$mode" in
    public-only|both) printf '%s\n' "$mode" ;;
    *) die "AB_VICTIM_MODE must be public-only|both" ;;
  esac
}
file_env_get() { sed -n "s/^$2=//p" "$1" | tail -1; }
process_env_get() {
  tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n "s/^$2=//p" | tail -1
}
lower() { tr '[:upper:]' '[:lower:]'; }
valid_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]]; }
valid_branch() { [[ "$1" =~ ^ab/[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$ ]]; }
valid_report_path() {
  [[ "$1" =~ ^docs/research/reports/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$ ]] && [[ "$1" != *".."* ]]
}
[ "$LEASE_SECONDS" -ge 300 ] && [ "$LEASE_SECONDS" -le 7200 ] || die "AB_LEASE_SECONDS must be 300..7200"
[ "$PAUSE_LEASE_SECONDS" -ge 60 ] && [ "$PAUSE_LEASE_SECONDS" -le 1800 ] || die "AB_PAUSE_LEASE_SECONDS must be 60..1800"
[ "$FIRST_SCAN_TIMEOUT_SECONDS" -ge 90 ] && [ "$FIRST_SCAN_TIMEOUT_SECONDS" -le 1200 ] \
  || die "AB_FIRST_SCAN_TIMEOUT_SECONDS must be 90..1200"
[ "$MEMPOOL_READY_TIMEOUT_SECONDS" -ge 5 ] && [ "$MEMPOOL_READY_TIMEOUT_SECONDS" -le 120 ] \
  || die "AB_MEMPOOL_READY_TIMEOUT_SECONDS must be 5..120"
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
    "b_restarts", "a_pid_before", "a_pid_after", "b_pid_before", "champion_pid_changed",
    "a_universe_from_block", "a_universe_to_block", "b_universe_from_block", "b_universe_to_block",
    "six_step_acceptance_started_at", "six_step_acceptance_completed_at", "pool_universe_top_n",
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

assert_port_free() {
  local port=$1
  if ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|[:.])${port}$"; then
    die "required A/B port $port is already listening"
  fi
}

port_listener_pids() {
  local port=$1
  ss -H -ltnp "sport = :$port" 2>/dev/null \
    | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
}

pid_descends_from() {
  local pid=$1 root=$2 ppid
  while [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$root" ] && return 0
    [ -r "/proc/$pid/stat" ] || return 1
    ppid=$(awk '{print $4}' "/proc/$pid/stat")
    [ "$ppid" != "$pid" ] || return 1
    pid=$ppid
  done
  return 1
}

assert_no_port_owner() {
  local root_pid=$1 label=$2 port listener
  shift 2
  for port in "$@"; do
    [[ "$port" =~ ^[0-9]+$ ]] || continue
    for listener in $(port_listener_pids "$port"); do
      if pid_descends_from "$listener" "$root_pid"; then
        die "$label process tree unexpectedly owns protected port $port (pid=$listener)"
      fi
    done
  done
}

assert_port_owned() {
  local root_pid=$1 label=$2 port=$3 listener
  local listeners
  listeners=$(port_listener_pids "$port")
  [ -n "$listeners" ] || die "$label required port $port is not listening"
  for listener in $listeners; do
    pid_descends_from "$listener" "$root_pid" \
      || die "$label port $port is owned outside its unit tree (pid=$listener)"
  done
}

run_six_step_acceptance_worker() {
  set -Eeuo pipefail
  local analysis_dir=$1 proxy_port=$2 worker_timeout=$3 evidence_rpc
  local proxy_ready=0 listener_pids
  EVIDENCE_PROXY_PID=""
  EVIDENCE_TIMEOUT_PID=""
  shift 3
  export -n -f run_six_step_acceptance_worker 2>/dev/null || true
  [[ "$worker_timeout" =~ ^[1-9][0-9]*$ ]] || {
    echo "historical evidence worker timeout is invalid" >&2
    return 9
  }
  evidence_rpc=$(cat)
  [[ "$evidence_rpc" =~ ^https://[^[:space:]]+$ ]] || {
    echo "historical evidence RPC is not a private HTTPS endpoint" >&2
    return 9
  }
  cd "$analysis_dir"
  cleanup_evidence_proxy() {
    local timeout_pid=${EVIDENCE_TIMEOUT_PID:-} proxy_pid=${EVIDENCE_PROXY_PID:-}
    if [[ "$timeout_pid" =~ ^[1-9][0-9]*$ ]]; then
      kill "$timeout_pid" 2>/dev/null || true
      wait "$timeout_pid" 2>/dev/null || true
    fi
    if [[ "$proxy_pid" =~ ^[1-9][0-9]*$ ]]; then
      kill "$proxy_pid" 2>/dev/null || true
      wait "$proxy_pid" 2>/dev/null || true
    fi
  }
  trap cleanup_evidence_proxy EXIT
  trap 'trap - INT; kill -INT -- -$$ 2>/dev/null || true; exit 130' INT
  trap 'trap - TERM; kill -TERM -- -$$ 2>/dev/null || true; exit 143' TERM
  (sleep "$worker_timeout"; kill -TERM -- -$$ 2>/dev/null || true) &
  EVIDENCE_TIMEOUT_PID=$!

  # The upstream URL enters only through stdin and stays out of gate/hunt argv and logs. The loopback
  # proxy is credential hygiene, not a privilege boundary between same-UID production processes.
  printf '%s' "$evidence_rpc" | MEV_AB_EVIDENCE_PROXY_PORT="$proxy_port" node -e '
    const http = require("node:http");
    const https = require("node:https");
    const upstreamChunks = [];
    process.stdin.on("data", (chunk) => upstreamChunks.push(chunk));
    process.stdin.on("end", () => {
      const upstreamText = Buffer.concat(upstreamChunks).toString("utf8");
      if (!/^https:\/\/\S+$/.test(upstreamText)) process.exit(2);
      const upstream = new URL(upstreamText);
      // Keep the proxy below the archive provider burst ceiling. The trusted
      // replay performs many historical eth_call requests; opening one TLS
      // socket per local caller can turn a healthy archive into a wall of 429s.
      const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
      // Own only transport retries. Ethers already has a bounded HTTP 429
      // retry policy, so forwarding 429 avoids multiplying two retry budgets.
      // Providers that hide saturation in an HTTP 200 JSON-RPC error are
      // normalized to HTTP 429 below so they use that same single owner.
      const retryableStatuses = new Set([502, 503, 504]);
      const maxAttempts = 5;
      const jsonRpcInspectionLimitBytes = 1024 * 1024;
      const requestTimeoutMs = Number(
        process.env.MEV_AB_EVIDENCE_REQUEST_TIMEOUT_MS ?? "300000",
      );
      if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 50) process.exit(2);

      const retryDelayMs = (headers, attempt) => {
        const retryAfter = headers["retry-after"];
        if (typeof retryAfter === "string" && /^\d+$/.test(retryAfter)) {
          return Math.min(10_000, Number(retryAfter) * 1_000);
        }
        return Math.min(4_000, 250 * (2 ** attempt));
      };

      const isJsonRpcRateLimit = (body) => {
        let payload;
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          return false;
        }
        const entries = Array.isArray(payload) ? payload : [payload];
        return entries.some((entry) => {
          const error = entry && typeof entry === "object" ? entry.error : null;
          if (!error || typeof error !== "object") return false;
          const code = Number(error.code);
          if (code === 429) return true;
          const message = typeof error.message === "string" ? error.message : "";
          const hasRevertData = error.data !== undefined && error.data !== null;
          if (code === 3 || hasRevertData) return false;
          const saturationMessage = /\brate limit(?:ed|ing)?\b|\btoo many requests\b|\brequest throttled\b|\bthrottling\b|\bcompute units capacity exceeded\b/i.test(message);
          return saturationMessage && (code === -32005 || !Number.isFinite(code));
        });
      };

      const server = http.createServer(async (request, response) => {
        if (request.method !== "POST") {
          response.writeHead(405, { "content-type": "text/plain" });
          response.end("method not allowed");
          return;
        }
        try {
          const chunks = [];
          let bytes = 0;
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > 16 * 1024 * 1024) throw new Error("request too large");
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks);
          await new Promise((resolve) => {
            let finalized = false;
            let upstreamRequest;
            let retryTimer;
            let attempt = 0;
            const finalize = () => {
              if (finalized) return;
              finalized = true;
              clearTimeout(absoluteTimeout);
              clearTimeout(retryTimer);
              resolve();
            };
            const finishUnavailable = () => {
              if (finalized) return;
              if (!response.headersSent) {
                response.writeHead(502, { "content-type": "text/plain" });
                response.end("archive rpc unavailable");
              } else {
                response.destroy();
              }
              finalize();
            };
            const absoluteTimeout = setTimeout(() => {
              upstreamRequest?.destroy(new Error("archive rpc timeout"));
              finishUnavailable();
            }, requestTimeoutMs);

            const retryOrFail = (headers = {}) => {
              if (finalized) return;
              if (attempt >= maxAttempts - 1) {
                finishUnavailable();
                return;
              }
              const delay = retryDelayMs(headers, attempt);
              attempt++;
              retryTimer = setTimeout(send, delay);
            };

            const send = () => {
              if (finalized) return;
              let attemptSettled = false;
              const settleAttempt = (next) => {
                if (attemptSettled || finalized) return;
                attemptSettled = true;
                next();
              };
              upstreamRequest = https.request(upstream, {
                method: "POST",
                headers: {
                  "accept": "application/json",
                  "content-type": request.headers["content-type"] ?? "application/json",
                  "content-length": String(body.length),
                },
                agent,
              }, (upstreamResponse) => {
                const status = upstreamResponse.statusCode ?? 502;
                if (retryableStatuses.has(status) && attempt < maxAttempts - 1) {
                  upstreamResponse.once("end", () => settleAttempt(() => {
                    retryOrFail(upstreamResponse.headers);
                  }));
                  upstreamResponse.once("aborted", () => settleAttempt(() => retryOrFail()));
                  upstreamResponse.once("error", () => settleAttempt(() => retryOrFail()));
                  upstreamResponse.resume();
                  return;
                }
                const headers = {
                  "content-type": upstreamResponse.headers["content-type"] ?? "application/json",
                };
                for (const name of ["content-encoding", "content-length", "retry-after"]) {
                  const value = upstreamResponse.headers[name];
                  if (typeof value === "string") headers[name] = value;
                }
                if (status === 200 && headers["content-encoding"] === undefined) {
                  const declaredLength = Number(headers["content-length"]);
                  if (Number.isFinite(declaredLength) && declaredLength > jsonRpcInspectionLimitBytes) {
                    response.writeHead(status, headers);
                    upstreamResponse.pipe(response);
                    upstreamResponse.once("end", () => settleAttempt(finalize));
                    upstreamResponse.once("aborted", () => settleAttempt(finishUnavailable));
                    upstreamResponse.once("error", () => settleAttempt(finishUnavailable));
                    return;
                  }
                  const responseChunks = [];
                  let responseBytes = 0;
                  let streaming = false;
                  const onData = (chunk) => {
                    responseChunks.push(chunk);
                    responseBytes += chunk.length;
                    if (responseBytes <= jsonRpcInspectionLimitBytes) return;
                    streaming = true;
                    upstreamResponse.pause();
                    upstreamResponse.off("data", onData);
                    response.writeHead(status, headers);
                    for (const buffered of responseChunks) response.write(buffered);
                    responseChunks.length = 0;
                    upstreamResponse.pipe(response, { end: false });
                    upstreamResponse.resume();
                  };
                  upstreamResponse.on("data", onData);
                  upstreamResponse.once("end", () => settleAttempt(() => {
                    if (streaming) {
                      response.end();
                      finalize();
                      return;
                    }
                    const responseBody = Buffer.concat(responseChunks, responseBytes);
                    const rateLimited = isJsonRpcRateLimit(responseBody);
                    const responseStatus = rateLimited ? 429 : status;
                    headers["content-length"] = String(responseBody.length);
                    response.writeHead(responseStatus, headers);
                    response.end(responseBody);
                    finalize();
                  }));
                  upstreamResponse.once("aborted", () => settleAttempt(finishUnavailable));
                  upstreamResponse.once("error", () => settleAttempt(finishUnavailable));
                  return;
                }
                response.writeHead(status, headers);
                upstreamResponse.pipe(response);
                upstreamResponse.once("end", () => settleAttempt(finalize));
                upstreamResponse.once("aborted", () => settleAttempt(finishUnavailable));
                upstreamResponse.once("error", () => settleAttempt(finishUnavailable));
              });
              upstreamRequest.once("error", () => settleAttempt(() => {
                if (response.headersSent) finishUnavailable();
                else retryOrFail();
              }));
              upstreamRequest.end(body);
            };

            response.once("finish", finalize);
            response.once("close", () => {
              if (!finalized) upstreamRequest.destroy(new Error("acceptance client closed"));
              finalize();
            });
            send();
          });
        } catch {
          response.writeHead(502, { "content-type": "text/plain" });
          response.end("archive rpc unavailable");
        }
      });
      server.listen(Number(process.env.MEV_AB_EVIDENCE_PROXY_PORT), "127.0.0.1");
    });
  ' >/tmp/mev-ab-evidence-proxy.log 2>&1 &
  EVIDENCE_PROXY_PID=$!
  for _ in $(seq 1 50); do
    kill -0 "$EVIDENCE_PROXY_PID" 2>/dev/null || break
    listener_pids=$(
      ss -H -ltnp "sport = :$proxy_port" 2>/dev/null \
        | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
    )
    if [ "$listener_pids" = "$EVIDENCE_PROXY_PID" ]; then
      proxy_ready=1
      break
    fi
    sleep 0.1
  done
  [ "$proxy_ready" = "1" ] || {
    echo "historical evidence RPC proxy failed to start" >&2
    return 9
  }
  node --import tsx src/cli/ab-canary-gate.ts "$@"
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

current_generation_has() {
  local log=$1 pattern=$2 start_line
  [ -f "$log" ] || return 1
  start_line=$(grep -n '\[searcher/live\] starting V5' "$log" 2>/dev/null | tail -1 | cut -d: -f1)
  [[ "$start_line" =~ ^[1-9][0-9]*$ ]] || return 1
  awk -v start="$start_line" -v pattern="$pattern" \
    'NR >= start && index($0, pattern) { found = 1 } END { exit(found ? 0 : 1) }' "$log"
}

current_generation_hash() {
  local log=$1 key=$2 start_line
  [ -f "$log" ] || { echo unavailable; return; }
  start_line=$(grep -n '\[searcher/live\] starting V5' "$log" 2>/dev/null | tail -1 | cut -d: -f1)
  [[ "$start_line" =~ ^[1-9][0-9]*$ ]] || { echo unavailable; return; }
  tail -n "+$start_line" "$log" \
    | sed -n "s/.*$key=0x\([0-9a-fA-F]\{64\}\).*/\1/p" \
    | tail -1 \
    | tr '[:upper:]' '[:lower:]' \
    | grep -E '^[0-9a-f]{64}$' || echo unavailable
}

current_generation_mempool_state() {
  local log=$1 start_line
  [ -f "$log" ] || { echo unavailable; return; }
  start_line=$(grep -n '\[searcher/live\] starting V5' "$log" 2>/dev/null | tail -1 | cut -d: -f1)
  [[ "$start_line" =~ ^[1-9][0-9]*$ ]] || { echo unavailable; return; }
  awk -v start="$start_line" '
    NR >= start && match($0, /mempool_state=(connected|disconnected)/) {
      state = substr($0, RSTART + 14, RLENGTH - 14)
    }
    END { print state == "" ? "unavailable" : state }
  ' "$log"
}

wait_current_generation_mempool_connected() {
  local log=$1
  for _ in $(seq 1 "$MEMPOOL_READY_TIMEOUT_SECONDS"); do
    [ "$(current_generation_mempool_state "$log")" = "connected" ] && return 0
    sleep 1
  done
  return 1
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

stop_unit_verified() {
  local unit=$1
  systemctl stop "$unit" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    unit_is_stopped "$unit" && return 0
    sleep 1
  done
  systemctl kill --kill-who=all --signal=KILL "$unit" >/dev/null 2>&1 || true
  systemctl stop "$unit" >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    unit_is_stopped "$unit" && return 0
    sleep 1
  done
  return 1
}

stop_b() {
  local stopped=0 effective_cpus
  stop_unit_verified "$UNIT" && stopped=1
  systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
  cpu_layout || return 1
  systemctl set-property --runtime "$A_UNIT" AllowedCPUs="$ALL_CPUS" >/dev/null \
    || return 1
  effective_cpus=$(systemctl show -p AllowedCPUs --value "$A_UNIT" 2>/dev/null) \
    || return 1
  [ "$stopped" = "1" ] && [ "$effective_cpus" = "$ALL_CPUS" ]
}

safety_abort() {
  local reason=${1:-safety_preflight_failed} status already_aborting b_stopped=1 a_stopped=1
  trap - ERR
  already_aborting=${SAFETY_ABORTING:-0}
  SAFETY_ABORTING=1
  status=$(state_field status 2>/dev/null || true)
  if [ "$status" = "running" ] && [ "$already_aborting" != "1" ]; then
    (capture_fairness) || true
  fi
  stop_b || b_stopped=0
  stop_unit_verified "$A_UNIT" || a_stopped=0
  rm -f "$MAIN_REPO/.deploy-live"
  if [ "$b_stopped" != "1" ] || [ "$a_stopped" != "1" ]; then
    reason="${reason};stop_verification_failed:A=${a_stopped},B=${b_stopped}"
  fi
  if [ -f "$STATE" ] && { [ "$status" = "running" ] || [ "$status" = "paused" ]; }; then
    (state_update status closed lease_until 0 outcome crashed_needs_escalation failure_reason "$reason") || true
    (append_history) || true
  fi
  if [ "$b_stopped" = "1" ] && [ "$a_stopped" = "1" ]; then
    echo "ABORT: $reason; A/B stop verified and champion live marker removed" >&2
  else
    echo "CRITICAL ABORT: $reason; live marker removed but unit stop could not be verified" >&2
  fi
  exit 9
}

capture_fairness() {
  [ -f "$STATE" ] || return 0
  local a_before a_now b_now a_path b_path a_pid_before a_pid_after pid_changed a_log b_log a_revm_path b_revm_path
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
  a_revm_path=$(state_field a_revm_path)
  b_revm_path=$(state_field b_revm_path)
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
    a_revm_hash_after "$(hash_or_unavailable "$a_revm_path")" \
    b_revm_hash_after "$(hash_or_unavailable "$b_revm_path")" \
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
    stop_b || safety_abort stale_inactive_b_stop_verification_failed
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
    stop_b || safety_abort stale_b_stop_verification_failed
    state_update status closed lease_until 0 outcome crashed_needs_escalation
    append_history
    echo "reaped stale experiment=$experiment branch=$branch; branch retained"
  fi
}

require_previous_decisive_cleanup() {
  [ -f "$STATE" ] || return 0
  local status outcome branch report expected tmp reported
  status=$(state_field status)
  outcome=$(state_field outcome)
  [ "$status" = "closed" ] || return 0
  branch=$(state_field branch)
  report=$(state_field production_report_path)
  if valid_branch "$branch" && valid_report_path "$report"; then
    git -C "$MAIN_REPO" fetch origin --prune -q \
      || die "cannot inspect previous A/B decision"
    tmp=$(mktemp "$ROOT/previous-decision.XXXXXX")
    if git -C "$MAIN_REPO" show "origin/$branch:$report" > "$tmp" 2>/dev/null; then
      reported=$(python3 - "$tmp" <<'PY'
import json, re, sys
text = open(sys.argv[1]).read()
match = re.search(r"```ab_experiment\s*\n([\s\S]*?)\n```", text)
if match:
    doc = json.loads(match.group(1))
    if doc.get("final_verdict") in ("win", "lose"):
        print(doc["final_verdict"])
PY
)
      if [ -n "$reported" ]; then outcome=$reported; fi
    fi
    rm -f "$tmp"
  fi
  case "$outcome" in
    win) expected=merged_deleted ;;
    lose) expected=deleted_unmerged ;;
    *) return 0 ;;
  esac
  valid_branch "$branch" || die "previous decisive experiment has invalid branch metadata"
  valid_report_path "$report" || die "previous decisive experiment has invalid report metadata"
  if git -C "$MAIN_REPO" ls-remote --exit-code --heads origin "refs/heads/$branch" >/dev/null 2>&1; then
    die "previous decisive experiment is not closed: $branch still exists; run ab-promotion-close before deploying another B"
  fi
  git -C "$MAIN_REPO" fetch origin main -q \
    || die "cannot verify previous decisive close against origin/main"
  tmp=$(mktemp "$ROOT/previous-close.XXXXXX")
  if ! git -C "$MAIN_REPO" show "origin/main:$report" > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    die "previous decisive experiment is not closed: final report is absent from origin/main"
  fi
  python3 - "$tmp" "$(state_field experiment_id)" "$branch" "$outcome" "$expected" <<'PY' \
    || { rm -f "$tmp"; die "previous decisive experiment report does not prove promotion/rejection cleanup"; }
import json, re, sys
path, experiment_id, branch, outcome, expected = sys.argv[1:]
text = open(path).read()
match = re.search(r"```ab_experiment\s*\n([\s\S]*?)\n```", text)
if not match:
    raise SystemExit(1)
doc = json.loads(match.group(1))
ok = (
    doc.get("experiment_id") == experiment_id
    and doc.get("branch") == branch
    and doc.get("final_verdict") == outcome
    and doc.get("branch_action") == expected
    and isinstance(doc.get("closing_branch_tip"), str)
    and re.fullmatch(r"[a-fA-F0-9]{40}", doc["closing_branch_tip"])
)
raise SystemExit(0 if ok else 1)
PY
  rm -f "$tmp"
}

check_wallet_envelope() {
  local env_file=$1 expected_wallet=$2 expected_botvm=$3 label=$4 baseline_file=$5
  local pk wallet botvm owner balance cap cap_wei authorized_wei baseline
  pk=$(file_env_get "$env_file" PRIVATE_KEY)
  [ -n "$pk" ] || pk=$(file_env_get "$env_file" OWNER_PRIVATE_KEY)
  [ -n "$pk" ] || safety_abort "${label}_private_key_missing"
  wallet=$(cast wallet address --private-key "$pk" 2>/dev/null)
  [ "$(printf %s "$wallet" | lower)" = "$(printf %s "$expected_wallet" | lower)" ] \
    || safety_abort "${label}_unauthorized_wallet"
  botvm=$(file_env_get "$env_file" BOTVM_ADDRESS)
  [ "$(printf %s "$botvm" | lower)" = "$(printf %s "$expected_botvm" | lower)" ] \
    || safety_abort "${label}_unauthorized_botvm"
  owner=$(cast call "$botvm" 'owner()(address)' --rpc-url "$LOCAL_RPC" 2>/dev/null || true)
  [ "$(printf %s "$owner" | lower)" = "$(printf %s "$wallet" | lower)" ] \
    || safety_abort "${label}_botvm_owner_mismatch"
  balance=$(cast balance "$wallet" --rpc-url "$LOCAL_RPC" 2>/dev/null)
  cap=$(file_env_get "$env_file" MEV_LIVE_MAX_WALLET_ETH); cap=${cap:-$AUTHORIZED_MAX_WALLET_ETH}
  cap_wei=$(cast to-wei "$cap" 2>/dev/null)
  authorized_wei=$(cast to-wei "$AUTHORIZED_MAX_WALLET_ETH" 2>/dev/null)
  [ -n "$balance" ] && [ -n "$cap_wei" ] && [ -n "$authorized_wei" ] \
    || safety_abort "${label}_wallet_cap_unavailable"
  python3 - "$cap_wei" "$authorized_wei" <<'PY' \
    || safety_abort "${label}_wallet_cap_unauthorized"
import sys
configured, authorized = map(int, sys.argv[1:])
raise SystemExit(0 if 0 < configured <= authorized else 1)
PY
  python3 - "$balance" "$cap_wei" <<'PY' || safety_abort "${label}_wallet_over_cap"
import sys
raise SystemExit(0 if int(sys.argv[1]) <= int(sys.argv[2]) else 1)
PY
  if [ ! -s "$baseline_file" ]; then
    printf '%s\n' "$balance" > "$baseline_file"
    chmod 600 "$baseline_file"
  fi
  baseline=$(cat "$baseline_file")
  python3 - "$balance" "$baseline" <<'PY' || safety_abort "${label}_wallet_below_baseline"
import sys
raise SystemExit(0 if int(sys.argv[1]) * 2 >= int(sys.argv[2]) else 1)
PY
}

preflight() {
  [ -f "$MAIN_REPO/.deploy-live" ] || die "champion bounded-live marker is missing"
  [ -f "$ENVF" ] || die "missing $ENVF"
  [ "$(stat -c %a "$ENVF")" = "600" ] || die "$ENVF must be mode 600"
  [ "$(systemctl is-active "$A_UNIT" 2>/dev/null || true)" = "active" ] || die "champion unit is not active"
  local apid mode sources expected_backrun expected_mempool expected_mev_share a_rpc a_ws a_log a_runtime_commit a_router_path
  mode=$(lane_mode)
  sources=$(victim_mode)
  if [ "$mode" = "dual" ]; then
    expected_backrun=1
    expected_mempool=1
    [ "$sources" = "both" ] && expected_mev_share=1 || expected_mev_share=0
  else
    expected_backrun=0
    expected_mempool=0
    expected_mev_share=0
  fi
  apid=$(systemctl show -p MainPID --value "$A_UNIT")
  [ -r "/proc/$apid/environ" ] || die "cannot read champion environment"
  tr '\0' '\n' < "/proc/$apid/environ" > "$A_PROCESS_ENV"
  chmod 600 "$A_PROCESS_ENV"
  for pair in \
    SEARCHER_DRY_RUN=0 SEARCHER_EV_GATE=1 SEARCHER_ENABLE_BACKRUN=$expected_backrun \
    SEARCHER_ENABLE_MEMPOOL=$expected_mempool SEARCHER_ENABLE_MEV_SHARE=$expected_mev_share SEARCHER_ANVIL_PORT=8555 \
    SEARCHER_EAGER_STATE_BACKEND=$expected_backrun \
    SEARCHER_ENABLE_BLOCK_SCAN=1 SEARCHER_BLOCKSCAN_SUBMIT=1 SEARCHER_BLOCKSCAN_ANVIL_PORT=8556; do
    local key=${pair%%=*} expected=${pair#*=}
    [ "$(file_env_get "$A_PROCESS_ENV" "$key")" = "$expected" ] \
      || die "champion $key must equal $expected"
  done
  [[ "$(file_env_get "$A_PROCESS_ENV" SEARCHER_DISCOVERY_TO_BLOCK)" =~ ^[0-9]+$ ]] \
    || die "champion SEARCHER_DISCOVERY_TO_BLOCK must be pinned by deploy-node.sh"
  a_rpc=$(file_env_get "$A_PROCESS_ENV" SEARCHER_LIVE_RPC_URL)
  a_ws=$(file_env_get "$A_PROCESS_ENV" SEARCHER_LIVE_WS_URL)
  [ "$a_rpc" = "$LOCAL_RPC" ] || die "champion SEARCHER_LIVE_RPC_URL must use local reth"
  [ "$a_ws" = "ws://127.0.0.1:8546" ] || die "champion SEARCHER_LIVE_WS_URL must use local reth"
  a_runtime_commit=$(file_env_get "$A_PROCESS_ENV" SEARCHER_RUNTIME_COMMIT)
  [[ "$a_runtime_commit" =~ ^[0-9a-f]{40}$ ]] || die "champion runtime commit is unavailable"
  [ "$a_runtime_commit" = "$(git -C "$MAIN_REPO" rev-parse HEAD)" ] \
    || die "champion running commit does not match checkout HEAD"
  a_router_path=$(file_env_get "$A_PROCESS_ENV" SEARCHER_FORCE_INCLUDE_ROUTERS_PATH)
  [[ "$a_router_path" = /* ]] && [ -f "$a_router_path" ] \
    || die "champion router admission snapshot is unavailable"

  for pair in \
    SEARCHER_DRY_RUN=0 SEARCHER_EV_GATE=1 SEARCHER_ENABLE_BACKRUN=$expected_backrun \
    SEARCHER_ENABLE_MEMPOOL=$expected_mempool SEARCHER_ENABLE_MEV_SHARE=$expected_mev_share SEARCHER_ANVIL_PORT=8566 \
    SEARCHER_EAGER_STATE_BACKEND=$expected_backrun \
    SEARCHER_ENABLE_BLOCK_SCAN=1 SEARCHER_BLOCKSCAN_SUBMIT=1 SEARCHER_BLOCKSCAN_ANVIL_PORT=8567; do
    local key=${pair%%=*} expected=${pair#*=}
    [ "$(env_get "$key")" = "$expected" ] || die "$key must equal $expected in $ENVF"
  done
  [ "$(env_get SEARCHER_EVENTS_PATH)" = "/var/log/mev/events/searcher-ab-b.jsonl" ] \
    || die "B requires its dedicated SEARCHER_EVENTS_PATH"
  check_wallet_envelope "$A_PROCESS_ENV" "$EXPECTED_A_WALLET" "$EXPECTED_A_BOTVM" champion "$ROOT/.a-start-balance-wei"
  check_wallet_envelope "$ENVF" "$EXPECTED_WALLET" "$EXPECTED_BOTVM" challenger "$ROOT/.b-start-balance-wei"
  if [ "$mode" = "dual" ]; then
    a_log=$(unit_log_path "$A_UNIT" /var/log/mev-live.log)
    if [ "$expected_mev_share" = "1" ]; then
      current_generation_has "$a_log" 'MEV-Share SSE connected' \
        || die "champion current process has not connected its MEV-Share victim stream"
    else
      current_generation_has "$a_log" '[searcher/live] mevshare=disabled' \
        || die "champion did not confirm MEV-Share is disabled"
      ! current_generation_has "$a_log" 'MEV-Share SSE connected' \
        || die "champion unexpectedly connected MEV-Share"
    fi
    wait_current_generation_mempool_connected "$a_log" \
      || die "champion public mempool subscription is not currently connected"
  fi
}

run_preflight_safely() {
  (preflight) || safety_abort preflight_failed
}

validate_running_pair() {
  local mode sources expected_backrun expected_mempool expected_mev_share a_pid b_pid a_log b_log key expected a_router_path b_router_path a_revm_path b_revm_path
  mode=$(lane_mode)
  sources=$(victim_mode)
  if [ "$mode" = "dual" ]; then
    expected_backrun=1
    expected_mempool=1
    [ "$sources" = "both" ] && expected_mev_share=1 || expected_mev_share=0
  else
    expected_backrun=0
    expected_mempool=0
    expected_mev_share=0
  fi
  [ "$(systemctl is-active "$A_UNIT" 2>/dev/null || true)" = "active" ] || die "champion unit is inactive"
  [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" = "active" ] || die "challenger unit is inactive"
  a_pid=$(systemctl show -p MainPID --value "$A_UNIT")
  b_pid=$(systemctl show -p MainPID --value "$UNIT")
  [ "$a_pid" = "$(state_field a_pid_before)" ] || die "champion PID drift"
  [ "$b_pid" = "$(state_field b_pid_before)" ] || die "challenger PID drift"
  [ "$(unit_restarts "$A_UNIT")" = "$(state_field a_restarts_before)" ] || die "champion restart drift"
  [ "$(unit_restarts "$UNIT")" = "$(state_field b_restarts)" ] || die "challenger restart drift"
  [ "$(git -C "$MAIN_REPO" rev-parse HEAD)" = "$(state_field a_commit)" ] || die "champion commit drift"
  [ "$(git -C "$WT" rev-parse HEAD)" = "$(state_field b_commit)" ] || die "challenger commit drift"
  [ "$(process_env_get "$a_pid" SEARCHER_RUNTIME_COMMIT)" = "$(state_field a_commit)" ] \
    || die "champion running commit drift"
  [ "$(process_env_get "$b_pid" SEARCHER_RUNTIME_COMMIT)" = "$(state_field b_commit)" ] \
    || die "challenger running commit drift"
  a_revm_path=$(process_env_get "$a_pid" SEARCHER_REVM_SIM_BIN)
  b_revm_path=$(process_env_get "$b_pid" SEARCHER_REVM_SIM_BIN)
  [ "$a_revm_path" = "$(state_field a_revm_path)" ] \
    || die "champion revm-sim path drift"
  [ "$b_revm_path" = "$(state_field b_revm_path)" ] \
    || die "challenger revm-sim path drift"
  [ "$(hash_file "$a_revm_path")" = "$(state_field a_revm_hash)" ] \
    || die "champion revm-sim artifact drift"
  [ "$(hash_file "$b_revm_path")" = "$(state_field b_revm_hash)" ] \
    || die "challenger revm-sim artifact drift"
  [ "$(state_field a_revm_hash)" = "$(state_field b_revm_hash)" ] \
    || die "A/B revm-sim artifacts differ"
  for key in SEARCHER_DRY_RUN SEARCHER_EV_GATE SEARCHER_ENABLE_BLOCK_SCAN SEARCHER_BLOCKSCAN_SUBMIT; do
    expected=1
    [ "$key" = "SEARCHER_DRY_RUN" ] && expected=0
    [ "$(process_env_get "$a_pid" "$key")" = "$expected" ] || die "champion $key drift"
    [ "$(process_env_get "$b_pid" "$key")" = "$expected" ] || die "challenger $key drift"
  done
  [ "$(process_env_get "$a_pid" SEARCHER_ENABLE_BACKRUN)" = "$expected_backrun" ] \
    || die "champion backrun posture drift"
  [ "$(process_env_get "$b_pid" SEARCHER_ENABLE_BACKRUN)" = "$expected_backrun" ] \
    || die "challenger backrun posture drift"
  [ "$(process_env_get "$a_pid" SEARCHER_ENABLE_MEMPOOL)" = "$expected_mempool" ] \
    || die "champion mempool posture drift"
  [ "$(process_env_get "$b_pid" SEARCHER_ENABLE_MEMPOOL)" = "$expected_mempool" ] \
    || die "challenger mempool posture drift"
  [ "$(process_env_get "$a_pid" SEARCHER_ENABLE_MEV_SHARE)" = "$expected_mev_share" ] \
    || die "champion MEV-Share posture drift"
  [ "$(process_env_get "$b_pid" SEARCHER_ENABLE_MEV_SHARE)" = "$expected_mev_share" ] \
    || die "challenger MEV-Share posture drift"
  [ "$(process_env_get "$a_pid" SEARCHER_EAGER_STATE_BACKEND)" = "$expected_backrun" ] \
    || die "champion eager-state posture drift"
  [ "$(process_env_get "$b_pid" SEARCHER_EAGER_STATE_BACKEND)" = "$expected_backrun" ] \
    || die "challenger eager-state posture drift"
  [ "$(process_env_get "$a_pid" SEARCHER_LIVE_RPC_URL)" = "$LOCAL_RPC" ] || die "champion RPC source drift"
  [ "$(process_env_get "$b_pid" SEARCHER_LIVE_RPC_URL)" = "$LOCAL_RPC" ] || die "challenger RPC source drift"
  [ "$(process_env_get "$a_pid" SEARCHER_LIVE_WS_URL)" = "ws://127.0.0.1:8546" ] || die "champion WS source drift"
  [ "$(process_env_get "$b_pid" SEARCHER_LIVE_WS_URL)" = "ws://127.0.0.1:8546" ] || die "challenger WS source drift"
  a_router_path=$(process_env_get "$a_pid" SEARCHER_FORCE_INCLUDE_ROUTERS_PATH)
  b_router_path=$(process_env_get "$b_pid" SEARCHER_FORCE_INCLUDE_ROUTERS_PATH)
  [ "$a_router_path" = "$b_router_path" ] && [ "$a_router_path" = "$(state_field router_snapshot_path)" ] \
    || die "router admission snapshot path drift"
  [ "$(hash_file "$a_router_path")" = "$(state_field router_snapshot_hash)" ] \
    || die "router admission snapshot content drift"
  (assert_no_port_owner "$b_pid" challenger 8555 8556) || return 1
  (assert_no_port_owner "$a_pid" champion 8566 8567) || return 1
  if [ "$mode" = "dual" ]; then
    (assert_port_owned "$a_pid" champion 8555) || return 1
    (assert_port_owned "$b_pid" challenger 8566) || return 1
  fi
  (assert_port_owned "$a_pid" champion 8556) || return 1
  (assert_port_owned "$b_pid" challenger 8567) || return 1
  a_log=$(state_field a_log_path)
  b_log=$(state_field b_log_path)
  if [ "$mode" = "dual" ]; then
    if [ "$expected_mev_share" = "1" ]; then
      current_generation_has "$a_log" 'MEV-Share SSE connected' || die "champion victim stream missing"
      current_generation_has "$b_log" 'MEV-Share SSE connected' || die "challenger victim stream missing"
    else
      ! current_generation_has "$a_log" 'MEV-Share SSE connected' || die "champion unexpected MEV-Share stream"
      ! current_generation_has "$b_log" 'MEV-Share SSE connected' || die "challenger unexpected MEV-Share stream"
    fi
    wait_current_generation_mempool_connected "$a_log" \
      || die "champion public mempool subscription disconnected"
    wait_current_generation_mempool_connected "$b_log" \
      || die "challenger public mempool subscription disconnected"
  fi
  for key in victim_feed_hash blockscan_view_hash blockscan_graph_hash; do
    [ "$(current_generation_hash "$a_log" "$key")" = "$(state_field "a_$key")" ] \
      || die "champion $key drift"
    [ "$(current_generation_hash "$b_log" "$key")" = "$(state_field "b_$key")" ] \
      || die "challenger $key drift"
  done
  [ "$(hash_file "$(state_field a_universe_path)")" = "$(state_field a_universe_hash)" ] \
    || die "champion universe drift"
  [ "$(hash_file "$(state_field b_universe_path)")" = "$(state_field b_universe_hash)" ] \
    || die "challenger universe drift"
}

build_runtime_env() {
  local experiment=$1 b_commit=$2 input_mode allowed a_env runtime_env a_common b_common a_pool_path a_sse b_sse b_cap
  local mode sources expected_backrun expected_mempool expected_mev_share
  mode=$(lane_mode)
  sources=$(victim_mode)
  if [ "$mode" = "dual" ]; then
    expected_backrun=1
    expected_mempool=1
    [ "$sources" = "both" ] && expected_mev_share=1 || expected_mev_share=0
  else
    expected_backrun=0
    expected_mempool=0
    expected_mev_share=0
  fi
  input_mode=$(env_get AB_INPUT_MODE); input_mode=${input_mode:-shared}
  [ "$input_mode" = "shared" ] || [ "$input_mode" = "challenger" ] || die "AB_INPUT_MODE must be shared|challenger"
  allowed=",$(env_get AB_ALLOWED_CONFIG_DELTA),"
  a_env="$ROOT/a-search.env"
  runtime_env="$ROOT/b-runtime.env"
  a_common="$ROOT/a-common.env"
  b_common="$ROOT/b-common.env"
  grep '^SEARCHER_' "$A_PROCESS_ENV" > "$a_env"
  write_b_secrets
  a_sse=$(file_env_get "$A_PROCESS_ENV" MEV_SHARE_SSE_URL)
  a_sse=${a_sse:-https://mev-share.flashbots.net}
  [[ "$a_sse" =~ ^https://[^[:space:]]+$ ]] || die "champion MEV_SHARE_SSE_URL must be https"
  b_sse=$(file_env_get "$ENVF" MEV_SHARE_SSE_URL)
  [ -z "$b_sse" ] || [ "$b_sse" = "$a_sse" ] \
    || die "challenger MEV_SHARE_SSE_URL must match champion"
  : > "$a_common"
  : > "$runtime_env"
  while IFS= read -r line; do
    local key=${line%%=*}
    case "$key" in
      SEARCHER_EVENTS_PATH|SEARCHER_ANVIL_PORT|SEARCHER_BLOCKSCAN_ANVIL_PORT|SEARCHER_LIVE_RPC_URL|SEARCHER_LIVE_WS_URL|SEARCHER_RUNTIME_COMMIT|SEARCHER_POOL_UNIVERSE_PATH|SEARCHER_POOL_UNIVERSE_MANIFEST_PATH) continue ;;
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
SEARCHER_ENABLE_BACKRUN=$expected_backrun
SEARCHER_ENABLE_MEMPOOL=$expected_mempool
SEARCHER_ENABLE_MEV_SHARE=$expected_mev_share
SEARCHER_EAGER_STATE_BACKEND=$expected_backrun
SEARCHER_ENABLE_BLOCK_SCAN=1
SEARCHER_BLOCKSCAN_SUBMIT=1
SEARCHER_ANVIL_PORT=8566
SEARCHER_BLOCKSCAN_ANVIL_PORT=8567
SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-ab-b.jsonl
SEARCHER_LIVE_RPC_URL=http://127.0.0.1:8545
SEARCHER_LIVE_WS_URL=ws://127.0.0.1:8546
SEARCHER_RUNTIME_COMMIT=$b_commit
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
  [ -n "${B_UNIVERSE:-}" ] && [ -f "$B_UNIVERSE" ] \
    || die "prepared challenger pool universe missing"
  echo "SEARCHER_POOL_UNIVERSE_PATH=$B_UNIVERSE" >> "$runtime_env"
  if [ -s "${B_UNIVERSE_MANIFEST:-}" ]; then
    echo "SEARCHER_POOL_UNIVERSE_MANIFEST_PATH=$B_UNIVERSE_MANIFEST" >> "$runtime_env"
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
      SEARCHER_EVENTS_PATH|SEARCHER_ANVIL_PORT|SEARCHER_BLOCKSCAN_ANVIL_PORT|SEARCHER_LIVE_RPC_URL|SEARCHER_LIVE_WS_URL|SEARCHER_RUNTIME_COMMIT|SEARCHER_POOL_UNIVERSE_PATH|SEARCHER_POOL_UNIVERSE_MANIFEST_PATH) continue ;;
    esac
    if [[ "$allowed" == *",$key,"* ]]; then continue; fi
    echo "$line" >> "$b_common"
  done < "$runtime_env"
  cmp -s "$a_common" "$b_common" || {
    diff -u "$a_common" "$b_common" >&2 || true
    die "normalized A/B SEARCHER config differs outside AB_ALLOWED_CONFIG_DELTA"
  }
  cat "$B_SECRETS" "$runtime_env" > "$B_PROCESS_ENV"
  printf 'MEV_SHARE_SSE_URL=%s\n' "$a_sse" >> "$B_PROCESS_ENV"
  b_cap=$(file_env_get "$ENVF" MEV_LIVE_MAX_WALLET_ETH); b_cap=${b_cap:-$AUTHORIZED_MAX_WALLET_ETH}
  printf 'MEV_LIVE_MAX_WALLET_ETH=%s\n' "$b_cap" >> "$B_PROCESS_ENV"
  chmod 600 "$B_SECRETS" "$B_PROCESS_ENV" "$runtime_env" "$a_common" "$b_common"
  A_CONFIG_HASH=$(hash_file "$a_common")
  B_CONFIG_HASH=$(hash_file "$b_common")
  INPUT_MODE=$input_mode
}

write_b_secrets() {
  python3 - "$ENVF" "$B_SECRETS" <<'PY'
import os, re, sys

source, destination = sys.argv[1:]
allowed = {"PRIVATE_KEY", "OWNER_PRIVATE_KEY", "BOTVM_ADDRESS", "BOTVM_OWNER"}
values = {}
for line_number, raw in enumerate(open(source), 1):
    line = raw.rstrip("\n")
    if not line or line.lstrip().startswith("#"):
        continue
    if "=" not in line:
        raise SystemExit(f"invalid env line {line_number}")
    key, value = line.split("=", 1)
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
        raise SystemExit(f"invalid env key {key!r}")
    if key not in allowed:
        continue
    if key in values:
        raise SystemExit(f"duplicate secret env key {key}")
    if "\x00" in value or "\n" in value or "\r" in value:
        raise SystemExit(f"invalid control character in {key}")
    if key in {"PRIVATE_KEY", "OWNER_PRIVATE_KEY"} and not re.fullmatch(r"0x[0-9a-fA-F]{64}", value):
        raise SystemExit(f"invalid private key encoding in {key}")
    if key in {"BOTVM_ADDRESS", "BOTVM_OWNER"} and not re.fullmatch(r"0x[0-9a-fA-F]{40}", value):
        raise SystemExit(f"invalid address encoding in {key}")
    values[key] = value
with open(destination, "w") as out:
    for key in sorted(values):
        out.write(f"{key}={values[key]}\n")
os.chmod(destination, 0o600)
PY
}

prepare_trusted_base() {
  local commit=$1
  if [ -e "$TRUSTED_BASE/.git" ]; then
    git -C "$TRUSTED_BASE" reset --hard "$commit" >/dev/null
    git -C "$TRUSTED_BASE" clean -fdx >/dev/null
  elif [ -e "$TRUSTED_BASE" ]; then
    die "$TRUSTED_BASE exists but is not a git worktree"
  else
    git -C "$MAIN_REPO" worktree add --detach "$TRUSTED_BASE" "$commit" >/dev/null
  fi
  [ "$(git -C "$TRUSTED_BASE" rev-parse HEAD)" = "$commit" ] \
    || die "trusted base checkout does not match frozen champion SHA"
  [ -d "$MAIN_REPO/analysis/node_modules" ] || die "champion analysis/node_modules missing"
  [ -d "$MAIN_REPO/listener/node_modules" ] || die "champion listener/node_modules missing"
  verify_forge_dependency "$commit"
  ln -s "$MAIN_REPO/analysis/node_modules" "$TRUSTED_BASE/analysis/node_modules"
  ln -s "$MAIN_REPO/listener/node_modules" "$TRUSTED_BASE/listener/node_modules"
  rm -rf "$TRUSTED_BASE/lib/forge-std"
  ln -s "$MAIN_REPO/lib/forge-std" "$TRUSTED_BASE/lib/forge-std"
  (cd "$TRUSTED_BASE" && forge build >/tmp/mev-ab-trusted-forge-build.log 2>&1) \
    || die "trusted base forge build failed (see /tmp/mev-ab-trusted-forge-build.log)"
  (cd "$TRUSTED_BASE/analysis" && npm run build >/tmp/mev-ab-trusted-analysis-build.log 2>&1) \
    || die "trusted base analysis build failed (see /tmp/mev-ab-trusted-analysis-build.log)"
}

prepare_acceptance_tooling() {
  local commit=$1 base_commit=$2 dependency_drift
  dependency_drift=$(git -C "$MAIN_REPO" diff --name-only "$base_commit..$commit" -- \
    analysis/package.json analysis/package-lock.json listener/package-lock.json)
  [ -z "$dependency_drift" ] \
    || die "trusted acceptance tooling dependencies differ from the installed champion dependencies"
  if [ -e "$ACCEPTANCE_TOOL/.git" ]; then
    git -C "$ACCEPTANCE_TOOL" reset --hard "$commit" >/dev/null
    git -C "$ACCEPTANCE_TOOL" clean -fdx >/dev/null
  elif [ -e "$ACCEPTANCE_TOOL" ]; then
    die "$ACCEPTANCE_TOOL exists but is not a git worktree"
  else
    git -C "$MAIN_REPO" worktree add --detach "$ACCEPTANCE_TOOL" "$commit" >/dev/null
  fi
  [ "$(git -C "$ACCEPTANCE_TOOL" rev-parse HEAD)" = "$commit" ] \
    || die "trusted acceptance tooling checkout does not match the pinned origin/main SHA"
  [ -d "$MAIN_REPO/analysis/node_modules" ] || die "champion analysis/node_modules missing"
  [ -d "$MAIN_REPO/listener/node_modules" ] || die "champion listener/node_modules missing"
  ln -s "$MAIN_REPO/analysis/node_modules" "$ACCEPTANCE_TOOL/analysis/node_modules"
  ln -s "$MAIN_REPO/listener/node_modules" "$ACCEPTANCE_TOOL/listener/node_modules"
}

verify_forge_dependency() {
  local commit=$1 expected actual
  [ -d "$MAIN_REPO/lib/forge-std" ] || die "champion forge-std dependency missing"
  expected=$(git -C "$MAIN_REPO" ls-tree "$commit" lib/forge-std | awk '{print $3}')
  actual=$(git -C "$MAIN_REPO/lib/forge-std" rev-parse HEAD 2>/dev/null || true)
  [ -n "$expected" ] && [ "$actual" = "$expected" ] \
    || die "champion forge-std checkout does not match the frozen commit"
  [ -z "$(git -C "$MAIN_REPO/lib/forge-std" status --porcelain 2>/dev/null)" ] \
    || die "champion forge-std checkout is dirty"
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
  verify_forge_dependency "$(git -C "$WT" rev-parse HEAD)"
  rm -rf "$WT/lib/forge-std"
  ln -s "$MAIN_REPO/lib/forge-std" "$WT/lib/forge-std"
  (cd "$WT" && forge build >/tmp/mev-ab-challenger-forge-build.log 2>&1) \
    || die "challenger forge build failed (see /tmp/mev-ab-challenger-forge-build.log)"
}

resolve_a_universe() {
  local a_pool_path a_manifest_path
  a_pool_path=$(file_env_get "$A_PROCESS_ENV" SEARCHER_POOL_UNIVERSE_PATH)
  if [ -z "$a_pool_path" ]; then
    A_UNIVERSE="$MAIN_REPO/listener/searcher/pools/active-pools.json"
  elif [[ "$a_pool_path" = /* ]]; then
    A_UNIVERSE="$a_pool_path"
  else
    A_UNIVERSE="$MAIN_REPO/listener/$a_pool_path"
  fi
  [ -f "$A_UNIVERSE" ] || die "champion pool universe missing: $A_UNIVERSE"
  a_manifest_path=$(file_env_get "$A_PROCESS_ENV" SEARCHER_POOL_UNIVERSE_MANIFEST_PATH)
  if [ -z "$a_manifest_path" ]; then
    A_UNIVERSE_MANIFEST="$A_UNIVERSE.manifest.json"
  elif [[ "$a_manifest_path" = /* ]]; then
    A_UNIVERSE_MANIFEST="$a_manifest_path"
  else
    A_UNIVERSE_MANIFEST="$MAIN_REPO/listener/$a_manifest_path"
  fi
  [ -s "$A_UNIVERSE_MANIFEST" ] || A_UNIVERSE_MANIFEST=
}

prepare_candidate_universes() {
  local experiment=$1 input_mode=$2 from_block to_block generator_log universe_tmp universe_manifest_tmp universe_hash universe_snapshot
  A_REPLAY_UNIVERSE="$ROOT/universe/$experiment-baseline-active-pools.json"
  cp -f "$A_UNIVERSE" "$A_REPLAY_UNIVERSE"
  [ "$(hash_file "$A_REPLAY_UNIVERSE")" = "$(hash_file "$A_UNIVERSE")" ] \
    || die "could not freeze the champion replay universe"

  if [ "$input_mode" = "shared" ]; then
    B_UNIVERSE="$ROOT/universe/$experiment-challenger-active-pools.json"
    cp -f "$A_UNIVERSE" "$B_UNIVERSE"
    B_UNIVERSE_MANIFEST=
    if [ -n "${A_UNIVERSE_MANIFEST:-}" ]; then
      B_UNIVERSE_MANIFEST="$B_UNIVERSE.manifest.json"
      cp -f "$A_UNIVERSE_MANIFEST" "$B_UNIVERSE_MANIFEST"
    fi
    return
  fi

  from_block=$(jq -er '.fromBlock | select(type == "number" and floor == . and . >= 0)' "$A_UNIVERSE") \
    || die "champion universe has invalid fromBlock"
  to_block=$(jq -er '.toBlock | select(type == "number" and floor == . and . >= 0)' "$A_UNIVERSE") \
    || die "champion universe has invalid toBlock"
  [ "$from_block" -le "$to_block" ] || die "champion universe block window is inverted"
  universe_tmp="$ROOT/universe/$experiment-challenger-active-pools.tmp.json"
  universe_manifest_tmp="$universe_tmp.manifest.json"
  generator_log="$ROOT/candidate/$experiment-universe-build.log"
  rm -f "$universe_tmp" "$universe_manifest_tmp"
  (
    cd "$WT/listener"
    timeout 900 env -i \
      PATH="$PATH" HOME="${HOME:-/root}" \
      MAINNET_RPC_URL="$LOCAL_RPC" \
      POOL_UNIVERSE_FROM_BLOCK="$from_block" \
      POOL_UNIVERSE_TO_BLOCK="$to_block" \
      POOL_UNIVERSE_RETAIN_PATH="$A_UNIVERSE" \
      POOL_UNIVERSE_OUT="$universe_tmp" \
      POOL_UNIVERSE_MANIFEST_OUT="$universe_manifest_tmp" \
      POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS=0 \
      npx tsx src/searcher/build-active-pool-universe.ts
  ) >"$generator_log" 2>&1 \
    || die "challenger universe generation failed (see $generator_log)"
  [ -f "$universe_tmp" ] && [ -f "$universe_manifest_tmp" ] \
    || die "challenger universe generator produced an incomplete artifact pair"
  jq -e --argjson from "$from_block" --argjson to "$to_block" '
    .schemaVersion == 3
    and .fromBlock == $from
    and .toBlock == $to
    and (.pools | type == "array" and length > 0)
  ' "$universe_tmp" >/dev/null \
    || die "challenger universe does not preserve the champion block window"
  universe_hash=$(hash_file "$universe_tmp")
  [[ "$universe_hash" =~ ^[a-f0-9]{64}$ ]] || die "challenger universe hash is invalid"
  universe_snapshot="$ROOT/universe/active-pools-$universe_hash.json"
  if [ -f "$universe_snapshot" ]; then
    [ "$(hash_file "$universe_snapshot")" = "$universe_hash" ] \
      || die "existing challenger universe snapshot hash mismatch"
    rm -f "$universe_tmp"
  else
    mv "$universe_tmp" "$universe_snapshot"
  fi
  B_UNIVERSE_MANIFEST="$universe_snapshot.manifest.json"
  mv "$universe_manifest_tmp" "$B_UNIVERSE_MANIFEST"
  B_UNIVERSE="$universe_snapshot"
}

deploy() {
  local experiment=$1 branch=$2 expected_a=$3 expected_b=$4 report_path=$5 allow_runtime_view_delta=${6:-0}
  local now lease current_status current_lease current_experiment requested_input_mode requested_config_delta
  local requested_lane_mode requested_victim_mode requested_shakedown branch_tip candidate_report
  local a_revm_path b_revm_path a_revm_hash b_revm_hash
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
  [ -z "$requested_config_delta" ] \
    || die "A/B candidate config deltas are forbidden; change one reviewed code variable instead"
  requested_lane_mode=$(lane_mode)
  requested_victim_mode=$(victim_mode)
  requested_shakedown=$(env_get AB_SHAKEDOWN); requested_shakedown=${requested_shakedown:-0}
  [ "$requested_shakedown" = "0" ] || [ "$requested_shakedown" = "1" ] \
    || die "AB_SHAKEDOWN must be 0|1"
  if [ "$requested_shakedown" = "1" ]; then
    [ "$requested_input_mode" = "shared" ] \
      || die "infrastructure shakedown requires AB_INPUT_MODE=shared"
    [ -z "$requested_config_delta" ] \
      || die "infrastructure shakedown requires empty AB_ALLOWED_CONFIG_DELTA"
    [ "$allow_runtime_view_delta" = "0" ] \
      || die "infrastructure shakedown forbids runtime-view delta"
  fi
  reap_stale
  require_previous_decisive_cleanup
  now=$(date +%s)
  current_status=$(state_field status); current_lease=$(state_field lease_until); current_experiment=$(state_field experiment_id)
  if { [ "$current_status" = "running" ] || [ "$current_status" = "paused" ]; } \
      && [ "${current_lease:-0}" -gt "$now" ] && [ "$current_experiment" != "$experiment" ]; then
    echo "BUSY: B slot held by $current_experiment until $current_lease" >&2
    exit 75
  fi
  run_preflight_safely
  resolve_a_universe
  local a_commit b_commit branch_tip candidate_report post_freeze_file
  a_commit=$(git -C "$MAIN_REPO" rev-parse HEAD)
  [ "$a_commit" = "$expected_a" ] || die "champion commit drift: expected $expected_a got $a_commit"
  git -C "$MAIN_REPO" fetch origin "$branch" -q
  git -C "$MAIN_REPO" rev-parse --verify "origin/$branch^{commit}" >/dev/null || die "remote challenger branch missing"
  branch_tip=$(git -C "$MAIN_REPO" rev-parse "origin/$branch^{commit}")
  git -C "$MAIN_REPO" cat-file -e "$expected_b^{commit}" 2>/dev/null \
    || die "frozen challenger commit is unavailable: $expected_b"
  b_commit=$expected_b
  git -C "$MAIN_REPO" merge-base --is-ancestor "$b_commit" "$branch_tip" \
    || die "frozen challenger is not an ancestor of the report branch tip"
  [ "$(git -C "$MAIN_REPO" merge-base "$a_commit" "$b_commit")" = "$a_commit" ] \
    || die "challenger is not based on the deployed champion commit"
  while IFS= read -r post_freeze_file; do
    [ -n "$post_freeze_file" ] || continue
    case "$post_freeze_file" in
      docs/research/reports/*.md|docs/research/reports/*.json) ;;
      *) die "challenger branch changed non-evidence file after frozen code SHA: $post_freeze_file" ;;
    esac
  done < <(git -C "$MAIN_REPO" diff --name-only "$b_commit..$branch_tip")
  candidate_report="$ROOT/candidate/$experiment-report.md"
  git -C "$MAIN_REPO" show "origin/$branch:$report_path" > "$candidate_report" 2>/dev/null \
    || die "candidate report is not present on the challenger evidence tip"
  chmod 600 "$candidate_report"
  local binding_args=(
    "$candidate_report"
    --phase binding
    --expected-experiment "$experiment"
    --expected-branch "$branch"
    --expected-base "$expected_a"
    --expected-challenger "$expected_b"
    --expected-runtime-view-delta "$allow_runtime_view_delta"
    --expected-input-mode "$requested_input_mode"
    --expected-config-delta "$requested_config_delta"
    --expected-lane-mode "$requested_lane_mode"
  )
  [ "$requested_shakedown" = "0" ] || binding_args+=(--shakedown)
  (
    cd "$MAIN_REPO/analysis"
    node --import tsx src/cli/ab-canary-gate.ts "${binding_args[@]}"
  ) >/tmp/mev-ab-deploy-binding.log 2>&1 \
    || die "A/B report identity binding failed (see /tmp/mev-ab-deploy-binding.log)"
  stop_b || safety_abort previous_challenger_stop_verification_failed
  sleep 1
  assert_port_free 8566
  assert_port_free 8567
  if [ -e "$WT/.git" ]; then
    if [ -n "$(git -C "$WT" status --porcelain)" ]; then
      tar czf "$ROOT/archive/$experiment-dirty-$(date +%s).tgz" -C "$WT" .
    fi
    git -C "$WT" reset --hard "$b_commit" >/dev/null
    git -C "$WT" clean -fdx >/dev/null
  elif [ -e "$WT" ]; then
    die "$WT exists but is not a git worktree"
  else
    git -C "$MAIN_REPO" worktree add --detach "$WT" "$b_commit" >/dev/null
  fi
  rm -f "$WT/.env" "$WT/listener/.env"
  local changed_file production_change=0
  while IFS= read -r changed_file; do
    [ -n "$changed_file" ] || continue
    case "$changed_file" in
      */test/*|*/tests/*|*/fixtures/*|*.test.ts|*.spec.ts)
        die "B challenger modifies its own replay/test evidence instead of production only: $changed_file"
        ;;
      listener/src/shared/state/*)
        die "B challenger may not modify the trusted state/port backend: $changed_file"
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
  if [ "$requested_shakedown" = "1" ]; then
    [ "$production_change" = "0" ] \
      || die "infrastructure shakedown must run identical searcher code"
  else
    [ "$production_change" = "1" ] \
      || die "B challenger has no production searcher/contract behavior change"
  fi
  prepare_challenger_dependencies
  (cd "$WT/listener" && npm run build >/tmp/mev-ab-build.log 2>&1) || die "challenger build failed (see /tmp/mev-ab-build.log)"
  prepare_candidate_universes "$experiment" "$requested_input_mode"
  run_preflight_safely
  local deploy_a_pid deploy_a_restarts deploy_a_commit replay_top_n
  deploy_a_pid=$(systemctl show -p MainPID --value "$A_UNIT")
  deploy_a_restarts=$(unit_restarts "$A_UNIT")
  deploy_a_commit=$(git -C "$MAIN_REPO" rev-parse HEAD)
  [ "$deploy_a_commit" = "$a_commit" ] || die "champion commit drifted before challenger start"
  replay_top_n=$(file_env_get "$A_PROCESS_ENV" SEARCHER_POOL_UNIVERSE_TOP_N)
  replay_top_n=${replay_top_n:-20000}
  [[ "$replay_top_n" =~ ^[1-9][0-9]*$ ]] || die "champion SEARCHER_POOL_UNIVERSE_TOP_N is invalid"
  build_runtime_env "$experiment" "$b_commit"
  a_revm_path=$(file_env_get "$A_PROCESS_ENV" SEARCHER_REVM_SIM_BIN)
  b_revm_path=$(file_env_get "$B_PROCESS_ENV" SEARCHER_REVM_SIM_BIN)
  [ -x "$a_revm_path" ] || die "champion canonical revm-sim artifact missing"
  [ "$a_revm_path" = "$b_revm_path" ] || die "A/B revm-sim paths differ"
  a_revm_hash=$(hash_file "$a_revm_path")
  b_revm_hash=$(hash_file "$b_revm_path")
  [ "$a_revm_hash" = "$b_revm_hash" ] || die "A/B revm-sim artifacts differ"
  cpu_layout
  local a_restarts_before a_pid_before
  a_restarts_before=$deploy_a_restarts
  a_pid_before=$deploy_a_pid
  systemctl set-property --runtime "$A_UNIT" AllowedCPUs="$A_CPUS" >/dev/null
  : > "$LOG"
  now=$(date +%s); lease=$((now + LEASE_SECONDS))
  systemd-run --unit="$UNIT" --collect --service-type=simple \
    --property="WorkingDirectory=$WT/listener" \
    --property="AllowedCPUs=$B_CPUS" \
    --property="EnvironmentFile=$B_PROCESS_ENV" \
    --property="Environment=HOME=/root" \
    --property="Environment=PATH=/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    --property="Restart=no" --property="RuntimeMaxSec=${LEASE_SECONDS}s" \
    --property="StandardOutput=append:$LOG" --property="StandardError=append:$LOG" \
    /usr/bin/npm run searcher:live \
    >/dev/null || safety_abort challenger_systemd_run_failed
  trap 'safety_abort post_start_unhandled_failure' ERR
  sleep 8
  [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" = "active" ] \
    || safety_abort challenger_failed_to_start
  grep -q '\[searcher/live\] mode=live' "$LOG" || safety_abort challenger_live_banner_missing
  local mode sources expected_mev_share
  mode=$(lane_mode)
  sources=$(victim_mode)
  if [ "$mode" = "dual" ] && [ "$sources" = "both" ]; then
    expected_mev_share=1
  else
    expected_mev_share=0
  fi
  if [ "$mode" = "dual" ]; then
    grep -q 'backrun=enabled' "$LOG" || safety_abort challenger_backrun_banner_missing
    grep -q 'mempool=enabled' "$LOG" || safety_abort challenger_mempool_banner_missing
  else
    grep -q 'backrun=disabled' "$LOG" || safety_abort challenger_backrun_banner_mismatch
    grep -q 'mempool=disabled' "$LOG" || safety_abort challenger_mempool_banner_mismatch
    ! grep -q 'MEV-Share SSE connected' "$LOG" || safety_abort challenger_unexpected_mev_share_connection
    ! grep -q 'src=mev-share' "$LOG" || safety_abort challenger_unexpected_mev_share_hint
  fi
  grep -q "mevshare=$( [ "$expected_mev_share" = "1" ] && echo enabled || echo disabled )" "$LOG" \
    || safety_abort challenger_mev_share_banner_mismatch
  if [ "$expected_mev_share" = "0" ]; then
    ! grep -q 'MEV-Share SSE connected' "$LOG" || safety_abort challenger_unexpected_mev_share_connection
    ! grep -q 'src=mev-share' "$LOG" || safety_abort challenger_unexpected_mev_share_hint
  fi
  local scan_ready=0
  for _ in $(seq 1 "$FIRST_SCAN_TIMEOUT_SECONDS"); do
    if grep -q '\[searcher/blockscan\] block=.*scannedPairs=' "$LOG"; then
      scan_ready=1
      break
    fi
    sleep 1
  done
  [ "$scan_ready" = "1" ] \
    || safety_abort challenger_first_blockscan_timeout
  if [ "$mode" = "dual" ]; then
    if [ "$expected_mev_share" = "1" ]; then
      local victim_ready=0
      for _ in $(seq 1 60); do
        if grep -q 'MEV-Share SSE connected' "$LOG"; then
          victim_ready=1
          break
        fi
        sleep 1
      done
      [ "$victim_ready" = "1" ] || safety_abort challenger_victim_stream_timeout
    fi
    wait_current_generation_mempool_connected "$LOG" \
      || safety_abort challenger_mempool_stream_timeout
  fi
  local a_pid_now b_pid_now
  a_pid_now=$(systemctl show -p MainPID --value "$A_UNIT")
  b_pid_now=$(systemctl show -p MainPID --value "$UNIT")
  [ "$a_pid_now" = "$deploy_a_pid" ] || safety_abort champion_pid_changed_during_challenger_warmup
  [ "$(unit_restarts "$A_UNIT")" = "$deploy_a_restarts" ] \
    || safety_abort champion_restarted_during_challenger_warmup
  [ "$(git -C "$MAIN_REPO" rev-parse HEAD)" = "$deploy_a_commit" ] \
    || safety_abort champion_commit_changed_during_challenger_warmup
  if [ "$mode" = "dual" ] && [ "$expected_mev_share" = "1" ]; then
    current_generation_has "$(unit_log_path "$A_UNIT" /var/log/mev-live.log)" 'MEV-Share SSE connected' \
      || safety_abort champion_current_victim_stream_missing
  fi
  (assert_no_port_owner "$b_pid_now" challenger 8555 8556) \
    || safety_abort challenger_owns_champion_port
  (assert_no_port_owner "$a_pid_now" champion 8566 8567) \
    || safety_abort champion_owns_challenger_port
  if [ "$mode" = "dual" ]; then
    (assert_port_owned "$a_pid_now" champion 8555) || safety_abort champion_main_anvil_not_owned
    (assert_port_owned "$b_pid_now" challenger 8566) || safety_abort challenger_main_anvil_not_owned
  fi
  (assert_port_owned "$a_pid_now" champion 8556) || safety_abort champion_blockscan_anvil_not_owned
  (assert_port_owned "$b_pid_now" challenger 8567) || safety_abort challenger_blockscan_anvil_not_owned
  [ "$(git -C "$WT" rev-parse HEAD)" = "$b_commit" ] || safety_abort challenger_worktree_commit_drift
  [ "$(process_env_get "$a_pid_now" SEARCHER_RUNTIME_COMMIT)" = "$a_commit" ] \
    || safety_abort champion_runtime_commit_mismatch
  [ "$(process_env_get "$b_pid_now" SEARCHER_RUNTIME_COMMIT)" = "$b_commit" ] \
    || safety_abort challenger_runtime_commit_mismatch
  local a_router_path b_router_path router_hash
  a_router_path=$(process_env_get "$a_pid_now" SEARCHER_FORCE_INCLUDE_ROUTERS_PATH)
  b_router_path=$(process_env_get "$b_pid_now" SEARCHER_FORCE_INCLUDE_ROUTERS_PATH)
  [ -n "$a_router_path" ] && [ "$a_router_path" = "$b_router_path" ] \
    || safety_abort router_admission_paths_differ
  router_hash=$(hash_file "$a_router_path")
  [[ "$router_hash" =~ ^[0-9a-f]{64}$ ]] || safety_abort router_admission_hash_unavailable
  local a_universe_hash b_universe_hash a_universe_from a_universe_to b_universe_from b_universe_to
  local a_log a_view_hash b_view_hash a_graph_hash b_graph_hash
  local a_feed_hash b_feed_hash
  local discovery_to_block
  a_universe_hash=$(hash_file "$A_UNIVERSE")
  b_universe_hash=$(hash_file "$B_UNIVERSE")
  a_universe_from=$(jq -er '.fromBlock | select(type == "number" and floor == .)' "$A_UNIVERSE") \
    || safety_abort champion_universe_window_unavailable
  a_universe_to=$(jq -er '.toBlock | select(type == "number" and floor == .)' "$A_UNIVERSE") \
    || safety_abort champion_universe_window_unavailable
  b_universe_from=$(jq -er '.fromBlock | select(type == "number" and floor == .)' "$B_UNIVERSE") \
    || safety_abort challenger_universe_window_unavailable
  b_universe_to=$(jq -er '.toBlock | select(type == "number" and floor == .)' "$B_UNIVERSE") \
    || safety_abort challenger_universe_window_unavailable
  [ "$a_universe_from" = "$b_universe_from" ] && [ "$a_universe_to" = "$b_universe_to" ] \
    || safety_abort universe_windows_differ
  a_log=$(unit_log_path "$A_UNIT" /var/log/mev-live.log)
  a_view_hash=$(current_generation_hash "$a_log" blockscan_view_hash)
  b_view_hash=$(current_generation_hash "$LOG" blockscan_view_hash)
  a_graph_hash=$(current_generation_hash "$a_log" blockscan_graph_hash)
  b_graph_hash=$(current_generation_hash "$LOG" blockscan_graph_hash)
  a_feed_hash=$(current_generation_hash "$a_log" victim_feed_hash)
  b_feed_hash=$(current_generation_hash "$LOG" victim_feed_hash)
  for pair in \
    "A blockscan view:$a_view_hash" "B blockscan view:$b_view_hash" \
    "A blockscan graph:$a_graph_hash" "B blockscan graph:$b_graph_hash"; do
    [[ "${pair#*:}" =~ ^[0-9a-f]{64}$ ]] || safety_abort runtime_hash_unavailable
  done
  [[ "$a_feed_hash" =~ ^[0-9a-f]{64}$ ]] && [[ "$b_feed_hash" =~ ^[0-9a-f]{64}$ ]] \
    || safety_abort victim_feed_hash_unavailable
  [ "$a_feed_hash" = "$b_feed_hash" ] \
    || safety_abort victim_feed_endpoints_differ
  if [ "$allow_runtime_view_delta" = "0" ]; then
    [ "$a_view_hash" = "$b_view_hash" ] \
      || safety_abort blockscan_pool_views_differ
    [ "$a_graph_hash" = "$b_graph_hash" ] \
      || safety_abort runtime_token_graphs_differ
  fi
  discovery_to_block=$(file_env_get "$A_PROCESS_ENV" SEARCHER_DISCOVERY_TO_BLOCK)
  state_update \
    experiment_id "$experiment" branch "$branch" status running lease_until "$lease" outcome "" \
    production_report_path "$report_path" production_report_hash "$(hash_file "$candidate_report")" \
    a_commit "$a_commit" b_commit "$b_commit" report_commit "$branch_tip" \
    branch_tip_commit "$branch_tip" \
    router_snapshot_path "$a_router_path" router_snapshot_hash "$router_hash" \
    a_config_hash "$A_CONFIG_HASH" b_config_hash "$B_CONFIG_HASH" \
    a_revm_path "$a_revm_path" b_revm_path "$b_revm_path" \
    a_revm_hash "$a_revm_hash" b_revm_hash "$b_revm_hash" \
    a_revm_hash_after "$a_revm_hash" b_revm_hash_after "$b_revm_hash" \
    a_universe_hash "$a_universe_hash" b_universe_hash "$b_universe_hash" \
    a_universe_from_block "$a_universe_from" a_universe_to_block "$a_universe_to" \
    b_universe_from_block "$b_universe_from" b_universe_to_block "$b_universe_to" \
    b_universe_generator_commit "$b_commit" \
    a_universe_hash_after "$a_universe_hash" b_universe_hash_after "$b_universe_hash" failure_reason "" \
    a_universe_path "$A_UNIVERSE" b_universe_path "$B_UNIVERSE" input_mode "$INPUT_MODE" \
    baseline_replay_universe_path "$A_REPLAY_UNIVERSE" \
    baseline_replay_universe_hash "$(hash_file "$A_REPLAY_UNIVERSE")" \
    pool_universe_top_n "$replay_top_n" \
    six_step_acceptance_status not_run six_step_acceptance_failure "" \
    six_step_acceptance_log "$ROOT/candidate/$experiment-six-step-acceptance.log" \
    six_step_acceptance_report "$ROOT/candidate/$experiment-acceptance-report.md" \
    discovery_to_block "$discovery_to_block" allow_runtime_view_delta "$allow_runtime_view_delta" \
    lane_mode "$mode" victim_mode "$requested_victim_mode" infrastructure_shakedown "$requested_shakedown" \
    a_victim_feed_hash "$a_feed_hash" b_victim_feed_hash "$b_feed_hash" \
    a_blockscan_view_hash "$a_view_hash" b_blockscan_view_hash "$b_view_hash" \
    a_blockscan_view_hash_after "$a_view_hash" b_blockscan_view_hash_after "$b_view_hash" \
    a_blockscan_graph_hash "$a_graph_hash" b_blockscan_graph_hash "$b_graph_hash" \
    a_blockscan_graph_hash_after "$a_graph_hash" b_blockscan_graph_hash_after "$b_graph_hash" \
    a_log_path "$a_log" b_log_path "$LOG" \
    a_restarts_before "$a_restarts_before" a_restart_delta 0 b_restarts 0 \
    a_pid_before "$a_pid_before" a_pid_after "$a_pid_before" b_pid_before "$b_pid_now" champion_pid_changed 0 \
    cpu_partition "A:$A_CPUS,B:$B_CPUS"
  trap - ERR
  cat "$STATE"
}

pause_experiment() {
  local experiment=$1 current
  valid_id "$experiment" || die "invalid experiment id"
  current=$(state_field experiment_id)
  [ "$current" = "$experiment" ] || die "state belongs to $current, not $experiment"
  [ "$(state_field status)" = "running" ] || die "experiment is not running"
  (validate_running_pair) || safety_abort running_pair_validation_failed
  capture_fairness
  stop_b || safety_abort challenger_pause_stop_verification_failed
  state_update status paused lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
  cat "$STATE"
}

six_step_acceptance() {
  local experiment=$1 current status
  local branch report_path deployment_report_commit acceptance_report_commit a_commit b_commit acceptance_tool_commit
  local baseline_universe challenger_universe baseline_hash challenger_hash replay_top_n
  local allow_runtime_view_delta input_mode lane require_stage_advance shakedown
  local candidate_report evidence_rpc acceptance_rpc acceptance_timeout acceptance_log acceptance_report_path
  local a_pid a_restarts a_commit_before worker_ready=0 worker_pgid acceptance_status
  valid_id "$experiment" || die "invalid experiment id"
  current=$(state_field experiment_id)
  [ "$current" = "$experiment" ] || die "state belongs to $current, not $experiment"
  status=$(state_field status)
  [ "$status" = "paused" ] \
    || die "six-step acceptance requires a paused experiment so replay cannot contaminate the live A/B window"
  unit_is_stopped "$UNIT" || die "challenger must be stopped before six-step acceptance"

  branch=$(state_field branch)
  report_path=$(state_field production_report_path)
  deployment_report_commit=$(state_field report_commit)
  a_commit=$(state_field a_commit)
  b_commit=$(state_field b_commit)
  baseline_universe=$(state_field baseline_replay_universe_path)
  challenger_universe=$(state_field b_universe_path)
  baseline_hash=$(state_field baseline_replay_universe_hash)
  challenger_hash=$(state_field b_universe_hash)
  replay_top_n=$(state_field pool_universe_top_n)
  allow_runtime_view_delta=$(state_field allow_runtime_view_delta)
  input_mode=$(state_field input_mode)
  lane=$(state_field lane_mode)
  shakedown=$(state_field infrastructure_shakedown)
  acceptance_log=$(state_field six_step_acceptance_log)
  acceptance_report_path=$(state_field six_step_acceptance_report)

  valid_branch "$branch" || die "acceptance state has invalid branch"
  valid_report_path "$report_path" || die "acceptance state has invalid report path"
  for commit in "$deployment_report_commit" "$a_commit" "$b_commit"; do
    [[ "$commit" =~ ^[a-f0-9]{40}$ ]] || die "acceptance state contains an invalid commit"
    git -C "$MAIN_REPO" cat-file -e "$commit^{commit}" 2>/dev/null \
      || die "acceptance commit is unavailable: $commit"
  done
  [ "$(git -C "$MAIN_REPO" rev-parse HEAD)" = "$a_commit" ] \
    || die "champion commit drifted before six-step acceptance"
  [ "$(git -C "$WT" rev-parse HEAD)" = "$b_commit" ] \
    || die "challenger worktree drifted before six-step acceptance"
  [ -z "$(git -C "$WT" status --porcelain --untracked-files=no)" ] \
    || die "challenger worktree has tracked changes before six-step acceptance"
  # Evidence/checker fixes are intentionally decoupled from the live deployment. The runtime SHA stays
  # frozen, while acceptance consumes the latest report-only descendant and current trusted main tooling.
  git -C "$MAIN_REPO" fetch origin main "$branch" -q \
    || die "cannot fetch acceptance report/tooling refs"
  acceptance_tool_commit=$(git -C "$MAIN_REPO" rev-parse 'origin/main^{commit}')
  acceptance_report_commit=$(git -C "$MAIN_REPO" rev-parse "origin/$branch^{commit}")
  git -C "$MAIN_REPO" merge-base --is-ancestor "$a_commit" "$acceptance_tool_commit" \
    || die "trusted acceptance tooling does not descend from the frozen champion"
  git -C "$MAIN_REPO" merge-base --is-ancestor "$b_commit" "$acceptance_report_commit" \
    || die "acceptance report tip does not descend from the frozen challenger"
  local acceptance_changed_file
  while IFS= read -r acceptance_changed_file; do
    [ -n "$acceptance_changed_file" ] || continue
    case "$acceptance_changed_file" in
      docs/research/reports/*.md|docs/research/reports/*.json) ;;
      *) die "acceptance branch changed runtime/non-evidence file after frozen challenger: $acceptance_changed_file" ;;
    esac
  done < <(git -C "$MAIN_REPO" diff --name-only "$b_commit..$acceptance_report_commit")
  [ -n "$acceptance_report_path" ] \
    || acceptance_report_path="$ROOT/candidate/$experiment-acceptance-report.md"
  git -C "$MAIN_REPO" show "$acceptance_report_commit:$report_path" > "$acceptance_report_path" 2>/dev/null \
    || die "acceptance report is missing from the latest report-only tip"
  chmod 600 "$acceptance_report_path"
  candidate_report="$acceptance_report_path"
  require_stage_advance=$(python3 - "$candidate_report" <<'PY'
import json, re, sys
text = open(sys.argv[1]).read()
match = re.search(r"```ab_experiment\s*\n([\s\S]*?)\n```", text)
if not match:
    raise SystemExit("acceptance report is missing ab_experiment JSON")
value = json.loads(match.group(1)).get("require_stage_advance", True)
if not isinstance(value, bool):
    raise SystemExit("require_stage_advance must be boolean when present")
print("1" if value else "0")
PY
  ) || die "cannot read require_stage_advance from the acceptance report"
  [ "$(hash_file "$baseline_universe")" = "$baseline_hash" ] \
    || die "frozen baseline replay universe hash drifted"
  [ "$(hash_file "$challenger_universe")" = "$challenger_hash" ] \
    || die "frozen challenger replay universe hash drifted"
  [[ "$replay_top_n" =~ ^[1-9][0-9]*$ ]] || die "acceptance pool universe top-N is invalid"
  [ "$allow_runtime_view_delta" = "0" ] || [ "$allow_runtime_view_delta" = "1" ] \
    || die "acceptance runtime-view delta is invalid"
  [ "$input_mode" = "shared" ] || [ "$input_mode" = "challenger" ] \
    || die "acceptance input mode is invalid"
  [ "$lane" = "blockscan-only" ] || [ "$lane" = "dual" ] \
    || die "acceptance lane mode is invalid"
  [ "$require_stage_advance" = "0" ] || [ "$require_stage_advance" = "1" ] \
    || die "acceptance stage-advance setting is invalid"
  [ "$shakedown" = "0" ] || [ "$shakedown" = "1" ] \
    || die "acceptance shakedown setting is invalid"
  if [ "$shakedown" = "1" ]; then
    state_update six_step_acceptance_status not_applicable \
      six_step_acceptance_failure "infrastructure_shakedown" \
      six_step_acceptance_completed_at "$(date +%s)" \
      lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
    cat "$STATE"
    return
  fi

  [ "$SIX_STEP_ACCEPTANCE_TIMEOUT_SECONDS" -ge 300 ] \
    && [ "$SIX_STEP_ACCEPTANCE_TIMEOUT_SECONDS" -le 9000 ] \
    || die "AB_SIX_STEP_ACCEPTANCE_TIMEOUT_SECONDS must be 300..9000"
  acceptance_timeout=$SIX_STEP_ACCEPTANCE_TIMEOUT_SECONDS
  # B is already stopped. Extend only the journal's paused lease so status/reap cannot misclassify a long
  # acceptance as a crashed live experiment while the wrapper holds the slot lock.
  state_update lease_until "$(( $(date +%s) + acceptance_timeout + 900 ))"
  # Acceptance is evidence collection, not a live-safety gate. Refresh only A's read-only process snapshot;
  # never call safety_abort here, because a semantic-check failure must not stop the champion.
  [ "$(systemctl is-active "$A_UNIT" 2>/dev/null || true)" = "active" ] \
    || die "champion unit is not active for six-step acceptance"
  a_pid=$(systemctl show -p MainPID --value "$A_UNIT")
  [ -r "/proc/$a_pid/environ" ] || die "cannot read champion environment for six-step acceptance"
  tr '\0' '\n' < "/proc/$a_pid/environ" > "$A_PROCESS_ENV"
  chmod 600 "$A_PROCESS_ENV"
  a_restarts=$(unit_restarts "$A_UNIT")
  a_commit_before=$(git -C "$MAIN_REPO" rev-parse HEAD)
  prepare_trusted_base "$a_commit"
  prepare_acceptance_tooling "$acceptance_tool_commit" "$a_commit"
  for port in 8568 8569 8570 8571 8572 8573 8574 8575 "$EVIDENCE_PROXY_PORT"; do
    assert_port_free "$port"
  done
  # Historical evidence may outlive local reth's trace/state retention. Only the independent acceptance
  # uses A's private archive endpoint; live A/B runtime remains pinned to LOCAL_RPC.
  evidence_rpc=$(file_env_get "$A_PROCESS_ENV" MAINNET_RPC_URL)
  [[ "$evidence_rpc" =~ ^https://[^[:space:]]+$ ]] \
    || die "champion MAINNET_RPC_URL must be a private HTTPS archive endpoint for six-step acceptance"
  [ "$(file_env_get "$A_PROCESS_ENV" SEARCHER_EV_GATE)" = "1" ] \
    || die "champion SEARCHER_EV_GATE must be enabled for six-step acceptance"
  acceptance_rpc="http://127.0.0.1:$EVIDENCE_PROXY_PORT"
  [ -n "$acceptance_log" ] || acceptance_log="$ROOT/candidate/$experiment-six-step-acceptance.log"

  local shakedown_arg=()
  local acceptance_args=(
    "$candidate_report"
    --phase acceptance
    --expected-experiment "$experiment"
    --expected-branch "$branch"
    --expected-base "$a_commit"
    --expected-challenger "$b_commit"
    --expected-runtime-view-delta "$allow_runtime_view_delta"
    --expected-input-mode "$input_mode"
    --expected-config-delta ""
    --artifact-ref "$acceptance_report_commit"
    --report-repo-path "$report_path"
    --expected-lane-mode "$lane"
    --require-stage-advance "$require_stage_advance"
    --base-root "$TRUSTED_BASE"
    --challenger-root "$WT"
    --baseline-universe "$baseline_universe"
    --challenger-universe "$challenger_universe"
    --pool-universe-top-n "$replay_top_n"
    --rpc "$acceptance_rpc"
  )
  [ "$shakedown" = "0" ] || shakedown_arg=(--shakedown)
  acceptance_args+=("${shakedown_arg[@]}")

  local acceptance_env=() key value
  for key in SEARCHER_EV_GATE SEARCHER_MIN_NET_ETH SEARCHER_ETH_USD \
    SEARCHER_PROFIT_HAIRCUT_BPS SEARCHER_BACKRUN_GAS_USED SEARCHER_GAS_BUFFER_MULT_X10 \
    SEARCHER_BRIBE_ALL_ABOVE_GAS SEARCHER_BRIBE_BPS; do
    value=$(file_env_get "$A_PROCESS_ENV" "$key")
    [ -z "$value" ] || acceptance_env+=("$key=$value")
  done
  state_update six_step_acceptance_status running six_step_acceptance_failure "" \
    six_step_acceptance_started_at "$(date +%s)" six_step_acceptance_completed_at 0 \
    require_stage_advance "$require_stage_advance" \
    acceptance_tool_commit "$acceptance_tool_commit" \
    six_step_acceptance_report_commit "$acceptance_report_commit" \
    six_step_acceptance_report_hash "$(hash_file "$candidate_report")"
  export -f run_six_step_acceptance_worker
  printf '%s' "$evidence_rpc" | env "${acceptance_env[@]}" python3 -c '
import ctypes
import os
import signal
import sys

libc = ctypes.CDLL(None)
if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
    raise SystemExit(2)
if os.getppid() == 1:
    raise SystemExit(2)
os.setsid()
os.execvp("bash", ["bash", "-c", sys.argv[1], "ab-acceptance-worker", *sys.argv[2:]])
' 'run_six_step_acceptance_worker "$@"' \
    "$ACCEPTANCE_TOOL/analysis" "$EVIDENCE_PROXY_PORT" "$acceptance_timeout" \
    "${acceptance_args[@]}" \
    >"$acceptance_log" 2>&1 &
  ACCEPTANCE_WORKER_PID=$!
  for _ in $(seq 1 50); do
    kill -0 "$ACCEPTANCE_WORKER_PID" 2>/dev/null || break
    worker_pgid=$(ps -o pgid= -p "$ACCEPTANCE_WORKER_PID" 2>/dev/null | tr -d ' ' || true)
    if [ "$worker_pgid" = "$ACCEPTANCE_WORKER_PID" ]; then
      worker_ready=1
      break
    fi
    sleep 0.1
  done
  if [ "$worker_ready" != "1" ]; then
    stop_acceptance_worker
    state_update six_step_acceptance_status fail \
      six_step_acceptance_failure worker_start_failed six_step_acceptance_completed_at "$(date +%s)" \
      lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
    die "six-step acceptance worker failed to start (see $acceptance_log)"
  fi
  if wait "$ACCEPTANCE_WORKER_PID"; then
    acceptance_status=0
  else
    acceptance_status=$?
  fi
  stop_acceptance_worker
  if [ "$acceptance_status" != "0" ]; then
    state_update six_step_acceptance_status fail \
      six_step_acceptance_failure "worker_exit_$acceptance_status" \
      six_step_acceptance_completed_at "$(date +%s)" \
      lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
    die "six-step acceptance failed (see $acceptance_log)"
  fi
  if [ "$(git -C "$ACCEPTANCE_TOOL" rev-parse HEAD)" != "$acceptance_tool_commit" ]; then
    state_update six_step_acceptance_status fail six_step_acceptance_failure tooling_commit_drift \
      six_step_acceptance_completed_at "$(date +%s)" \
      lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
    die "trusted acceptance tooling commit drifted"
  fi
  if [ -n "$(git -C "$ACCEPTANCE_TOOL" status --porcelain --untracked-files=no)" ]; then
    state_update six_step_acceptance_status fail six_step_acceptance_failure tooling_dirty \
      six_step_acceptance_completed_at "$(date +%s)" \
      lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
    die "trusted acceptance tooling became dirty"
  fi
  for port in 8568 8569 8570 8571 8572 8573 8574 8575 "$EVIDENCE_PROXY_PORT"; do
    assert_port_free "$port"
  done
  if [ "$(systemctl show -p MainPID --value "$A_UNIT")" != "$a_pid" ]; then
    state_update six_step_acceptance_status fail six_step_acceptance_failure champion_pid_changed \
      six_step_acceptance_completed_at "$(date +%s)" \
      lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
    die "champion PID changed during six-step acceptance"
  fi
  if [ "$(unit_restarts "$A_UNIT")" != "$a_restarts" ]; then
    state_update six_step_acceptance_status fail six_step_acceptance_failure champion_restarted \
      six_step_acceptance_completed_at "$(date +%s)" \
      lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
    die "champion restarted during six-step acceptance"
  fi
  if [ "$(git -C "$MAIN_REPO" rev-parse HEAD)" != "$a_commit_before" ]; then
    state_update six_step_acceptance_status fail six_step_acceptance_failure champion_commit_changed \
      six_step_acceptance_completed_at "$(date +%s)" \
      lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
    die "champion commit changed during six-step acceptance"
  fi
  state_update six_step_acceptance_status pass six_step_acceptance_failure "" \
    six_step_acceptance_completed_at "$(date +%s)" \
    lease_until "$(( $(date +%s) + PAUSE_LEASE_SECONDS ))"
  cat "$STATE"
}

close_experiment() {
  local experiment=$1 outcome=$2 current status branch report expected tmp
  valid_id "$experiment" || die "invalid experiment id"
  case "$outcome" in win|lose|needs_escalation) ;; *) die "invalid outcome";; esac
  current=$(state_field experiment_id)
  [ "$current" = "$experiment" ] || die "state belongs to $current, not $experiment"
  branch=$(state_field branch)
  report=$(state_field production_report_path)
  valid_branch "$branch" || die "close state has invalid branch"
  valid_report_path "$report" || die "close state has invalid production report"
  case "$outcome" in
    win) expected=pending_merge ;;
    lose) expected=pending_delete ;;
    needs_escalation) expected=retained ;;
  esac
  git -C "$MAIN_REPO" fetch origin "refs/heads/$branch:refs/remotes/origin/$branch" -q \
    || die "cannot fetch frozen B report for close"
  tmp=$(mktemp "$ROOT/close-report.XXXXXX")
  git -C "$MAIN_REPO" show "origin/$branch:$report" > "$tmp" 2>/dev/null \
    || { rm -f "$tmp"; die "cannot read frozen B report for close"; }
  python3 - "$tmp" "$experiment" "$branch" "$outcome" "$expected" <<'PY' \
    || { rm -f "$tmp"; die "close outcome does not match the committed B report"; }
import json, re, sys
path, experiment_id, branch, outcome, expected = sys.argv[1:]
text = open(path).read()
match = re.search(r"```ab_experiment\s*\n([\s\S]*?)\n```", text)
if not match:
    raise SystemExit(1)
doc = json.loads(match.group(1))
ok = (
    doc.get("experiment_id") == experiment_id
    and doc.get("branch") == branch
    and doc.get("final_verdict") == outcome
    and doc.get("branch_action") == expected
    and doc.get("b_stopped") is True
)
raise SystemExit(0 if ok else 1)
PY
  rm -f "$tmp"
  status=$(state_field status)
  if [ "$status" = "running" ]; then
    (validate_running_pair) || safety_abort running_pair_validation_failed
    capture_fairness
    stop_b || safety_abort challenger_close_stop_verification_failed
  elif [ "$status" != "paused" ]; then
    die "experiment must be running or paused before close (status=$status)"
  fi
  state_update status closed lease_until 0 outcome "$outcome"
  append_history
  cat "$STATE"
}

extend_runtime_deadline() {
  local active_us uptime_us elapsed_s runtime_limit_s
  active_us=$(systemctl show -p ActiveEnterTimestampMonotonic --value "$UNIT")
  uptime_us=$(awk '{ printf "%.0f\n", $1 * 1000000 }' /proc/uptime)
  [[ "$active_us" =~ ^[0-9]+$ ]] && [[ "$uptime_us" =~ ^[0-9]+$ ]] \
    || die "could not read challenger monotonic runtime"
  [ "$uptime_us" -ge "$active_us" ] || die "challenger runtime clock moved backwards"
  elapsed_s=$(( (uptime_us - active_us) / 1000000 ))
  runtime_limit_s=$((elapsed_s + LEASE_SECONDS))
  systemctl set-property --runtime "$UNIT" RuntimeMaxSec="${runtime_limit_s}s"
}

renew() {
  local experiment=$1 current now
  current=$(state_field experiment_id)
  [ "$current" = "$experiment" ] || die "state belongs to $current, not $experiment"
  [ "$(state_field status)" = "running" ] || die "experiment is not running"
  run_preflight_safely
  (validate_running_pair) || safety_abort running_pair_validation_failed
  now=$(date +%s)
  if ! extend_runtime_deadline; then
    echo "RENEW_UNSUPPORTED: systemd cannot extend the active B runtime; A/B remain running under the existing hard deadline" >&2
    return 10
  fi
  (state_update lease_until "$((now + LEASE_SECONDS))") || safety_abort journal_renewal_failed
  cat "$STATE"
}

cancel_pending() {
  local expected_b=$1 status a_pid_before a_pid_after a_restarts_before a_restarts_after b_pid actual_b
  [[ "$expected_b" =~ ^[a-f0-9]{40}$ ]] || die "pending challenger commit must be a full SHA"
  status=$(state_field status)
  [ "$status" != "running" ] && [ "$status" != "paused" ] \
    || die "journaled experiment must use pause/close, not cancel-pending"
  a_pid_before=$(systemctl show -p MainPID --value "$A_UNIT" 2>/dev/null || echo 0)
  a_restarts_before=$(unit_restarts "$A_UNIT")
  [ "$(systemctl is-active "$A_UNIT" 2>/dev/null || true)" = "active" ] \
    && [[ "$a_pid_before" =~ ^[1-9][0-9]*$ ]] \
    || die "champion must be active before pending challenger cleanup"
  b_pid=$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)
  if [[ "$b_pid" =~ ^[1-9][0-9]*$ ]]; then
    actual_b=$(process_env_get "$b_pid" SEARCHER_RUNTIME_COMMIT || true)
    [ -n "$actual_b" ] || actual_b=$(file_env_get "$B_PROCESS_ENV" SEARCHER_RUNTIME_COMMIT)
    [ "$actual_b" = "$expected_b" ] \
      || die "pending challenger runtime commit mismatch: expected $expected_b got ${actual_b:-unavailable}"
  fi
  stop_b || die "pending challenger stop verification failed"
  a_pid_after=$(systemctl show -p MainPID --value "$A_UNIT" 2>/dev/null || echo 0)
  a_restarts_after=$(unit_restarts "$A_UNIT")
  [ "$(systemctl is-active "$A_UNIT" 2>/dev/null || true)" = "active" ] \
    && [ "$a_pid_after" = "$a_pid_before" ] \
    && [ "$a_restarts_after" = "$a_restarts_before" ] \
    || die "champion changed during pending challenger cleanup"
  echo "cancelled pending challenger commit=$expected_b; champion pid=$a_pid_after unchanged"
}

cmd=${1:-status}
case "$cmd" in
  preflight) run_preflight_safely; echo "PASS: challenger bounded-live preflight" ;;
  deploy) { [ "$#" -eq 6 ] || [ "$#" -eq 7 ]; } \
    || die "usage: deploy <experiment-id> <ab/branch> <base-sha> <challenger-sha> <candidate-report.md> [allow-runtime-view-delta=0|1]"; \
    deploy "$2" "$3" "$4" "$5" "$6" "${7:-0}" ;;
  pause) [ "$#" -eq 2 ] || die "usage: pause <experiment-id>"; pause_experiment "$2" ;;
  acceptance) [ "$#" -eq 2 ] || die "usage: acceptance <experiment-id>"; six_step_acceptance "$2" ;;
  close) [ "$#" -eq 3 ] || die "usage: close <experiment-id> <outcome>"; close_experiment "$2" "$3" ;;
  renew) [ "$#" -eq 2 ] || die "usage: renew <experiment-id>"; renew "$2" ;;
  cancel-pending) [ "$#" -eq 2 ] || die "usage: cancel-pending <challenger-sha>"; cancel_pending "$2" ;;
  reap) reap_stale; [ -f "$STATE" ] && cat "$STATE" || echo '{}' ;;
  status) reap_stale; [ -f "$STATE" ] && cat "$STATE" || echo '{}' ;;
  *) die "usage: $0 preflight|deploy|pause|acceptance|close|renew|cancel-pending|reap|status" ;;
esac
