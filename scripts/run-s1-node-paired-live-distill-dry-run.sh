#!/usr/bin/env bash
set -euo pipefail

# Repeatable node SSM dry-run for the systemic-live decision chain
# (distiller + gate) over a fixture paired-live report. Requires the AWS CLI
# with SSM access. Dry-run evidence tool: no live window, no deploy, no
# signing, no broadcast; never touches the live searcher process.
#
# Usage:
#   scripts/run-s1-node-paired-live-distill-dry-run.sh <instance-id> [impl-sha] [impl-dir]

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
instance_id="${1:?instance id required}"
impl_sha="${2:-$(git -C "${repo_root}" rev-parse HEAD)}"
impl_dir="${3:-/opt/MEV-impl-capture}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 2
fi

echo "[paired-live-distill-dry-run] preflight"
preflight_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["set -e; echo ===WORKTREES===; ls -ld '"${impl_dir}"' 2>&1; echo ===GIT_STATUS===; git -C '"${impl_dir}"' status --porcelain 2>&1 | head -20; echo ===HEAD===; git -C '"${impl_dir}"' rev-parse HEAD; echo ===PROCS===; pgrep -af \"searcher|node.*main\" 2>&1 | head -10; echo ===LOCKS===; ls -la '"${impl_dir}"'/foundry.lock 2>&1; echo ===PREFLIGHT_DONE==="]' \
  --query Command.CommandId --output text)"
sleep 4
aws ssm get-command-invocation \
  --command-id "${preflight_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text | sed 's/^/[paired-live-distill-dry-run] /'

echo "[paired-live-distill-dry-run] checkout exact SHA"
checkout_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"set -e; cd ${impl_dir} && git fetch origin codex/s1-unified-adapter-architecture-impl >/dev/null 2>&1 && git checkout --detach ${impl_sha} >/dev/null 2>&1 && test \\\"\$(git rev-parse HEAD)\\\" = \\\"${impl_sha}\\\" && git rev-parse HEAD\"]" \
  --query Command.CommandId --output text)"
sleep 8
aws ssm get-command-invocation \
  --command-id "${checkout_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text | sed 's/^/[paired-live-distill-dry-run] /'

echo "[paired-live-distill-dry-run] run decision chain"
run_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"set -e; cd ${impl_dir}/listener && npm run --silent searcher:node-paired-live-distill-dry-run\"]" \
  --query Command.CommandId --output text)"

status="pending"
while [[ "${status}" == "pending" || "${status}" == "InProgress" ]]; do
  sleep 10
  status="$(aws ssm get-command-invocation \
    --command-id "${run_cmd_id}" \
    --instance-id "${instance_id}" \
    --query "Status" --output text)"
  echo "[paired-live-distill-dry-run] status=${status}"
done

output="$(aws ssm get-command-invocation \
  --command-id "${run_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text)"
echo "${output}" | sed 's/^/[paired-live-distill-dry-run] /'

if [[ "${status}" != "Success" ]]; then
  echo "[paired-live-distill-dry-run] FAILED (${status})" >&2
  exit 1
fi

echo "${output}" | python3 -c "
import json, sys
record = json.load(sys.stdin)
assert record['format'] == 's1-node-paired-live-distill-dry-run-v1', record.get('format')
assert record['status'] == 'pass', record.get('status')
assert record['gateVerdict'] == 'pass', record.get('gateVerdict')
print('VALID')
"

echo "${output}" | python3 -c "
import json, sys
record = json.load(sys.stdin)
evidence = {
  'format': 's1-node-paired-live-distill-dry-run-v1',
  'ssmRunId': '${run_cmd_id}',
  'instanceId': '${instance_id}',
  'implSha': '${impl_sha}',
  'reportSha256': record['reportSha256'],
  'gateVerdict': record['gateVerdict'],
  'gateReasons': record['gateReasons'],
}
print(json.dumps(evidence, indent=2))
" >"${repo_root}/docs/research/design/evidence/s1-node-paired-live-distill-dry-run-${run_cmd_id}.json"

echo "[paired-live-distill-dry-run] PASS ssm=${run_cmd_id} sha=${impl_sha}"
