#!/usr/bin/env bash
set -euo pipefail

# Repeatable node SSM dry-run for the checkpoint-backed point-in-time
# enumerator (§2 acceptance 1, fixture-backed). Requires the AWS CLI with
# SSM access to the node instance. This is a dry-run evidence tool: it
# never deploys, signs, broadcasts or touches the live searcher process.
#
# Usage:
#   scripts/run-s1-node-enumerator-dry-run.sh <instance-id> [impl-sha] [impl-dir]

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
instance_id="${1:?instance id required}"
impl_sha="${2:-$(git -C "${repo_root}" rev-parse HEAD)}"
impl_dir="${3:-/opt/MEV-impl-capture}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 2
fi

echo "[node-enumerator-dry-run] preflight"
preflight_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["set -e; echo ===WORKTREES===; ls -ld '"${impl_dir}"' 2>&1; echo ===GIT_STATUS===; git -C '"${impl_dir}"' status --porcelain 2>&1 | head -20; echo ===HEAD===; git -C '"${impl_dir}"' rev-parse HEAD; echo ===PROCS===; pgrep -af \"searcher|node.*main\" 2>&1 | head -10; echo ===LOCKS===; ls -la '"${impl_dir}"'/foundry.lock 2>&1; echo ===PREFLIGHT_DONE==="]' \
  --query Command.CommandId --output text)"
sleep 4
aws ssm get-command-invocation \
  --command-id "${preflight_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text | sed 's/^/[node-enumerator-dry-run] /'

echo "[node-enumerator-dry-run] checkout exact SHA"
checkout_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"set -e; cd ${impl_dir} && git fetch origin codex/s1-unified-adapter-architecture-impl 2>&1 | tail -1 && git checkout ${impl_sha} 2>&1 | tail -1 && git rev-parse HEAD\"]" \
  --query Command.CommandId --output text)"
sleep 8
aws ssm get-command-invocation \
  --command-id "${checkout_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text | sed 's/^/[node-enumerator-dry-run] /'

echo "[node-enumerator-dry-run] run enumerator"
run_cmd_id="$(aws ssm send-command \
  --instance-ids "${instance_id}" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"set -e; cd ${impl_dir}/listener && npm run --silent searcher:node-enumerator-dry-run\"]" \
  --query Command.CommandId --output text)"

status="pending"
while [[ "${status}" == "pending" || "${status}" == "InProgress" ]]; do
  sleep 10
  status="$(aws ssm get-command-invocation \
    --command-id "${run_cmd_id}" \
    --instance-id "${instance_id}" \
    --query "Status" --output text)"
  echo "[node-enumerator-dry-run] status=${status}"
done

output="$(aws ssm get-command-invocation \
  --command-id "${run_cmd_id}" \
  --instance-id "${instance_id}" \
  --query "StandardOutputContent" --output text)"
echo "${output}" | sed 's/^/[node-enumerator-dry-run] /'

if [[ "${status}" != "Success" ]]; then
  echo "[node-enumerator-dry-run] FAILED (${status})" >&2
  exit 1
fi

valid="$(echo "${output}" | python3 -c "
import json, sys
record = json.load(sys.stdin)
assert record['format'] == 's1-node-enumerator-dry-run-v1', record.get('format')
assert record['status'] == 'pass', record.get('status')
print('VALID')
")"
if [[ "${valid}" != "VALID" ]]; then
  echo "[node-enumerator-dry-run] output did not parse as a pass record" >&2
  exit 1
fi

echo "${output}" | python3 -c "
import json, sys
record = json.load(sys.stdin)
evidence = {
  'format': 's1-node-enumerator-dry-run-v1',
  'ssmRunId': '${run_cmd_id}',
  'instanceId': '${instance_id}',
  'implSha': '${impl_sha}',
  'catalogHash': record['catalogHash'],
  'familyCount': record['familyCount'],
  'inventoryFamilies': record['inventoryFamilies'],
}
print(json.dumps(evidence, indent=2))
" >"${repo_root}/docs/research/design/evidence/s1-node-enumerator-dry-run-${run_cmd_id}.json"

echo "[node-enumerator-dry-run] PASS ssm=${run_cmd_id} sha=${impl_sha}"
