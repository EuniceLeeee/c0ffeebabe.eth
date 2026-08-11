#!/usr/bin/env bash
set -euo pipefail

# Verifies a committed node SSM double-run evidence JSON against the pinned
# 22-family receipt and side captures: every artifact SHA-256 in the record
# must match the committed evidence bytes, and the receipt must still be an
# aggregate pass. Evidence-chain check only; no node access required.
#
# Usage:
#   scripts/verify-s1-node-evidence.sh <node-evidence.json>

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
evidence="${1:?node evidence json required}"

receipt="${repo_root}/docs/research/design/evidence/s1-parity-22family-receipt.json"
baseline="${repo_root}/docs/research/design/evidence/s1-parity-22family-baseline-side.json"
challenger="${repo_root}/docs/research/design/evidence/s1-parity-22family-challenger-side.json"

expected_receipt_sha="$(sha256sum "${receipt}" | awk '{print $1}')"
expected_baseline_sha="$(sha256sum "${baseline}" | awk '{print $1}')"
expected_challenger_sha="$(sha256sum "${challenger}" | awk '{print $1}')"

python3 - "${evidence}" \
  "${expected_receipt_sha}" "${expected_baseline_sha}" \
  "${expected_challenger_sha}" "${receipt}" <<'PY'
import json, sys

record = json.load(open(sys.argv[1]))
expected = {
    "receiptSha256": sys.argv[2],
    "baselineSideSha256": sys.argv[3],
    "challengerSideSha256": sys.argv[4],
}
assert record["format"] == "s1-node-ssm-double-run-v1", record.get("format")
for key, value in expected.items():
    assert record[key] == value, (
        f"{key} mismatch: record={record[key]} committed={value}"
    )
assert len(record["ssmRunId"]) >= 8, record["ssmRunId"]
assert record["instanceId"].startswith("i-"), record["instanceId"]
assert len(record["baselineSha"]) == 40, record["baselineSha"]
assert len(record["implSha"]) == 40, record["implSha"]

receipt = json.load(open(sys.argv[5]))
assert receipt["parityReceipt"]["aggregateVerdict"] == "pass"
assert receipt["parityReceipt"]["nonPassFamilyIds"] == []
assert receipt["parityReceipt"]["assembledCommonGraphParity"] is True
assert receipt["heldOutNegativeVerdicts"] == []
print(
    "S1 node SSM evidence verified: "
    f"ssm={record['ssmRunId']} receipt={record['receiptSha256']}"
)
PY
