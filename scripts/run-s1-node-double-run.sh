#!/usr/bin/env bash
set -euo pipefail

# Repeatable node SSM double-run for the S1 22-family sealed-capture
# evidence. Requires the AWS CLI with SSM access to the node instance.
# This is a dry-run evidence tool: it never deploys, signs, broadcasts or
# touches the live searcher process.
#
# Usage:
#   scripts/run-s1-node-double-run.sh <instance-id> [baseline-sha] [impl-sha]

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
instance_id="${1:?instance id required}"
baseline_sha="${2:-4265971d123c2d6afc5194aa2b324104558327c7}"
impl_sha="${3:-$(git -C "${repo_root}" rev-parse HEAD)}"
baseline_dir="${4:-/opt/MEV-baseline-capture}"
impl_dir="${5:-/opt/MEV-impl-capture}"
out_base="${6:-/opt/MEV-s1-parity-22family-node}"
manifest="${impl_dir}/docs/research/design/evidence/s1-parity-22family-manifest.json"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 2
fi

echo "[node-run] preflight"
preflight_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["set -e; echo ===WORKTREES===; ls -ld '"${baseline_dir}"' '"${impl_dir}"' 2>&1; echo ===GIT_STATUS===; git -C '"${baseline_dir}"' status --porcelain 2>&1 | head -20; git -C '"${impl_dir}"' status --porcelain 2>&1 | head -20; echo ===HEAD===; git -C '"${baseline_dir}"' rev-parse HEAD; git -C '"${impl_dir}"' rev-parse HEAD; echo ===PROCS===; pgrep -af \"searcher|node.*main\" 2>&1 | head -10; echo ===LOCKS===; ls -la '"${baseline_dir}"'/foundry.lock '"${impl_dir}"'/foundry.lock 2>&1; echo ===PREFLIGHT_DONE==="]' \
  --query Command.CommandId --output text)"
sleep 4
aws ssm get-command-invocation \
  --command-id "${preflight_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text | sed 's/^/[node-run] /'

echo "[node-run] checkout exact SHAs"
checkout_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"set -e; cd ${baseline_dir} && git fetch origin codex/parity-capture-baseline 2>&1 | tail -1 && git checkout ${baseline_sha} 2>&1 | tail -1 && git rev-parse HEAD; cd ${impl_dir} && git fetch origin codex/s1-unified-adapter-architecture-impl 2>&1 | tail -1 && git checkout ${impl_sha} 2>&1 | tail -1 && git rev-parse HEAD\"]" \
  --query Command.CommandId --output text)"
sleep 8
aws ssm get-command-invocation \
  --command-id "${checkout_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text | sed 's/^/[node-run] /'

out_dir="${out_base}-$(date +%s)"
echo "[node-run] double-run out=${out_dir}"
run_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"set -e; mkdir -p ${out_dir}; python3 ${impl_dir}/scripts/run-migration-parity-multi.py --manifest ${manifest} --baseline-dir ${baseline_dir} --impl-dir ${impl_dir} --out ${out_dir} 2>&1 | tail -3; echo ===OUT=${out_dir}===; sha256sum ${out_dir}/parity-receipt.json ${out_dir}/baseline-side.json ${out_dir}/challenger-side.json\"]" \
  --query Command.CommandId --output text)"

status="pending"
while [[ "${status}" == "pending" || "${status}" == "InProgress" ]]; do
  sleep 15
  status="$(aws ssm get-command-invocation \
    --command-id "${run_cmd_id}" \
    --instance-id "${instance_id}" \
    --query "Status" --output text)"
  echo "[node-run] status=${status}"
done

output="$(aws ssm get-command-invocation \
  --command-id "${run_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text)"
echo "${output}" | sed 's/^/[node-run] /'

if [[ "${status}" != "Success" ]]; then
  echo "[node-run] FAILED (${status})" >&2
  exit 1
fi

receipt_sha="$(echo "${output}" | awk '/parity-receipt.json/{print $1}')"
baseline_sha_sum="$(echo "${output}" | awk '/baseline-side.json/{print $1}')"
challenger_sha_sum="$(echo "${output}" | awk '/challenger-side.json/{print $1}')"

expected_receipt_sha="$(sha256sum "${repo_root}/docs/research/design/evidence/s1-parity-22family-receipt.json" | awk '{print $1}')"
expected_baseline_sha="$(sha256sum "${repo_root}/docs/research/design/evidence/s1-parity-22family-baseline-side.json" | awk '{print $1}')"
expected_challenger_sha="$(sha256sum "${repo_root}/docs/research/design/evidence/s1-parity-22family-challenger-side.json" | awk '{print $1}')"

if [[ "${receipt_sha}" != "${expected_receipt_sha}" || \
      "${baseline_sha_sum}" != "${expected_baseline_sha}" || \
      "${challenger_sha_sum}" != "${expected_challenger_sha}" ]]; then
  echo "[node-run] evidence hash mismatch" >&2
  exit 1
fi

cat >"${repo_root}/docs/research/design/evidence/s1-node-run-${run_cmd_id}.json" <<JSON
{
  "format": "s1-node-ssm-double-run-v1",
  "ssmRunId": "${run_cmd_id}",
  "instanceId": "${instance_id}",
  "baselineSha": "${baseline_sha}",
  "implSha": "${impl_sha}",
  "outDir": "${out_dir}",
  "receiptSha256": "${receipt_sha}",
  "baselineSideSha256": "${baseline_sha_sum}",
  "challengerSideSha256": "${challenger_sha_sum}"
}
JSON

echo "[node-run] PASS ssm=${run_cmd_id} receipt=${receipt_sha}"
