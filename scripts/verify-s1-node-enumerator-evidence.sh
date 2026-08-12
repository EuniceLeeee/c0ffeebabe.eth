#!/usr/bin/env bash
set -euo pipefail

# Verifies a committed node enumerator dry-run evidence JSON against a fresh
# local run of the same deterministic CLI: catalog hash, family count and
# per-Family inventory hashes must match byte-for-byte. Evidence-chain check
# only; no node access required.
#
# Usage:
#   scripts/verify-s1-node-enumerator-evidence.sh <evidence.json> [impl-dir]

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
evidence="${1:?node enumerator evidence json required}"
impl_dir="${2:-${repo_root}}"

local_output="$(cd "${impl_dir}/listener" && npm run --silent searcher:node-enumerator-dry-run)"

LOCAL_RECORD="${local_output}" python3 - "${evidence}" <<'PY'
import json, os, sys

record = json.load(open(sys.argv[1]))
assert record["format"] == "s1-node-enumerator-dry-run-v1", record.get("format")
assert len(record["ssmRunId"]) >= 8, record["ssmRunId"]
assert record["instanceId"].startswith("i-"), record["instanceId"]
assert len(record["implSha"]) == 40, record["implSha"]
assert len(record["catalogHash"]) == 64, record["catalogHash"]
assert isinstance(record["familyCount"], int), record["familyCount"]

local = json.loads(os.environ["LOCAL_RECORD"])
assert local["format"] == "s1-node-enumerator-dry-run-v1", local.get("format")
assert local["status"] == "pass", local.get("status")
assert local["catalogHash"] == record["catalogHash"], (
    "catalogHash mismatch: record=" + record["catalogHash"] +
    " local=" + local["catalogHash"]
)
assert local["familyCount"] == record["familyCount"], (
    "familyCount mismatch: record=" + str(record["familyCount"]) +
    " local=" + str(local["familyCount"])
)
assert local["inventoryFamilies"] == record["inventoryFamilies"], (
    "inventoryFamilies mismatch"
)
print(
    "S1 node enumerator evidence verified: "
    f"ssm={record['ssmRunId']} families={record['familyCount']}"
)
PY
