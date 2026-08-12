#!/usr/bin/env bash
set -euo pipefail

# Serial S1 dry-run comparison orchestrator: runs the baseline and challenger
# capture worktrees one after another for the same bounded window through
# node-side-serial-dry-run.sh (dry-run only, whitelisted env, no private key,
# no submit), then compares priced/expected coverage, runtime graph pool
# counts and event line counts, and writes an evidence record.
#
# Usage:
#   scripts/run-s1-node-serial-dry-run.sh <instance-id> <window-seconds> \
#     [baseline-sha] [impl-sha] [side:both|baseline|challenger]

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
instance_id="${1:?instance id required}"
window_seconds="${2:?window seconds required}"
baseline_sha="${3:-4265971d123c2d6afc5194aa2b324104558327c7}"
impl_sha="${4:-$(git -C "${repo_root}" rev-parse HEAD)}"
side="${5:-both}"
baseline_dir="${6:-/opt/MEV-baseline-capture}"
impl_dir="${7:-/opt/MEV-impl-capture}"
out_base="${8:-/tmp/mev-s1-serial-dry-run}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 2
fi

echo "[serial-dry-run] preflight"
preflight_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["set -e; echo ===WORKTREES===; ls -ld '"${baseline_dir}"' '"${impl_dir}"' 2>&1; echo ===GIT_STATUS===; git -C '"${baseline_dir}"' status --porcelain 2>&1 | head -20; git -C '"${impl_dir}"' status --porcelain 2>&1 | head -20; echo ===HEAD===; git -C '"${baseline_dir}"' rev-parse HEAD; git -C '"${impl_dir}"' rev-parse HEAD; echo ===PROCS===; pgrep -af \"searcher|node.*main\" 2>&1 | head -10; echo ===LOCKS===; ls -la '"${baseline_dir}"'/foundry.lock '"${impl_dir}"'/foundry.lock 2>&1; echo ===PREFLIGHT_DONE==="]' \
  --query Command.CommandId --output text)"
sleep 4
aws ssm get-command-invocation \
  --command-id "${preflight_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text | sed 's/^/[serial-dry-run] /'

echo "[serial-dry-run] ensure runner script at impl SHA"
runner_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"set -e; cd ${impl_dir} && git fetch origin codex/parity-capture-baseline codex/s1-unified-adapter-architecture-impl 2>&1 | tail -1 && git checkout ${impl_sha} 2>&1 | tail -1 && git rev-parse HEAD\"]" \
  --query Command.CommandId --output text)"
sleep 8
aws ssm get-command-invocation \
  --command-id "${runner_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text | sed 's/^/[serial-dry-run] /'

run_side() {
  local name="$1"
  local sha="$2"
  local dir="$3"
  local outdir="${out_base}/${name}"
  echo "[serial-dry-run] ${name} window=${window_seconds}s sha=${sha}"
  run_cmd_id="$(aws ssm send-command \
    --instance-ids "${instance_id}" \
    --document-name AWS-RunShellScript \
    --parameters "commands=[\"bash ${impl_dir}/scripts/node-side-serial-dry-run.sh ${name} ${sha} ${window_seconds} ${dir} ${outdir}\"]" \
    --query Command.CommandId --output text)"
  local status="pending"
  while [[ "${status}" == "pending" || "${status}" == "InProgress" ]]; do
    sleep 20
    status="$(aws ssm get-command-invocation \
      --command-id "${run_cmd_id}" \
      --instance-id "${instance_id}" \
      --query "Status" --output text)"
    echo "[serial-dry-run] ${name} status=${status}"
  done
  local output
  output="$(aws ssm get-command-invocation \
    --command-id "${run_cmd_id}" \
    --instance-id "${instance_id}" \
    --query "StandardOutputContent" --output text)"
  echo "${output}" | sed 's/^/[serial-dry-run] /'
  if [[ "${status}" != "Success" ]]; then
    echo "[serial-dry-run] ${name} FAILED (${status})" >&2
    exit 1
  fi
  local json
  json="$(echo "${output}" | sed -n 's/^SERIAL_SIDE_JSON=//p' | tail -1)"
  if [ -z "${json}" ]; then
    echo "[serial-dry-run] ${name} missing SERIAL_SIDE_JSON" >&2
    exit 1
  fi
  echo "${json}" >"${repo_root}/.serial-${name}-meta"
  echo "[serial-dry-run] ${name} metrics: $(echo "${json}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:d[k] for k in ("priced","artifactPoolCount","eventLineCount","exitCode")})')"
}

if [[ "${side}" == "baseline" || "${side}" == "both" ]]; then
  run_side baseline "${baseline_sha}" "${baseline_dir}"
fi
if [[ "${side}" == "challenger" || "${side}" == "both" ]]; then
  run_side challenger "${impl_sha}" "${impl_dir}"
fi

echo "[serial-dry-run] summarize"
python3 - "${repo_root}" "${window_seconds}" <<'PY'
import json, os, sys

root, window = sys.argv[1], int(sys.argv[2])
summary = {"format": "s1-node-serial-dry-run-v1", "windowSeconds": window, "sides": {}}
for side in ("baseline", "challenger"):
    meta_path = os.path.join(root, f".serial-{side}-meta")
    if not os.path.exists(meta_path):
        continue
    with open(meta_path) as fh:
        summary["sides"][side] = json.load(fh)
summary["comparison"] = {
    "pricedRatioDelta": None,
    "graphBuiltEdgesDelta": None,
    "artifactPoolCountDelta": None,
}
if "baseline" in summary["sides"] and "challenger" in summary["sides"]:
    base = summary["sides"]["baseline"]
    chal = summary["sides"]["challenger"]
    if base["pricedRatio"] is not None and chal["pricedRatio"] is not None:
        summary["comparison"]["pricedRatioDelta"] = round(
            chal["pricedRatio"] - base["pricedRatio"], 6
        )
    if base["graphBuiltEdges"] is not None and chal["graphBuiltEdges"] is not None:
        summary["comparison"]["graphBuiltEdgesDelta"] = (
            chal["graphBuiltEdges"] - base["graphBuiltEdges"]
        )
    if base["artifactPoolCount"] is not None and chal["artifactPoolCount"] is not None:
        summary["comparison"]["artifactPoolCountDelta"] = (
            chal["artifactPoolCount"] - base["artifactPoolCount"]
        )
record_path = os.path.join(
    root,
    "docs/research/design/evidence",
    "s1-node-serial-dry-run-latest.json",
)
with open(record_path, "w") as fh:
    json.dump(summary, fh, indent=2)
    fh.write("\n")
print(json.dumps(summary, indent=2))
PY

echo "[serial-dry-run] PASS record=docs/research/design/evidence/s1-node-serial-dry-run-latest.json"
