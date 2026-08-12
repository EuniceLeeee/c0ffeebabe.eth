#!/usr/bin/env bash
set -euo pipefail

# Verifies the committed S1 22-family sealed-capture parity receipt by
# re-running the deterministic local batch and diffing the regenerated
# receipt against the committed artifact. This is evidence verification,
# not a production cutover or live gate.
#
# Usage:
#   scripts/verify-s1-parity-receipt.sh [baseline-dir] [impl-dir] [out-dir]

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
baseline_dir="${1:-${repo_root}/../mev-parity-baseline}"
impl_dir="${2:-${repo_root}}"
out_dir="${3:-$(mktemp -d)}"
manifest="${repo_root}/docs/research/design/evidence/s1-parity-22family-manifest.json"
expected_receipt="${repo_root}/docs/research/design/evidence/s1-parity-22family-receipt.json"
expected_baseline="${repo_root}/docs/research/design/evidence/s1-parity-22family-baseline-side.json"
expected_challenger="${repo_root}/docs/research/design/evidence/s1-parity-22family-challenger-side.json"

if [[ ! -f "${manifest}" ]]; then
  echo "missing committed manifest: ${manifest}" >&2
  exit 2
fi

python3 "${repo_root}/scripts/run-migration-parity-multi.py" \
  --manifest "${manifest}" \
  --baseline-dir "${baseline_dir}" \
  --impl-dir "${impl_dir}" \
  --out "${out_dir}" >/dev/null

generated="${out_dir}/parity-receipt.json"
if [[ ! -f "${generated}" ]]; then
  echo "parity run produced no receipt" >&2
  exit 2
fi

if ! diff -u "${expected_receipt}" "${generated}"; then
  echo "S1 22-family parity receipt diverged from committed evidence" >&2
  exit 1
fi

generated_baseline="${out_dir}/baseline-side.json"
generated_challenger="${out_dir}/challenger-side.json"
if [[ ! -f "${generated_baseline}" || ! -f "${generated_challenger}" ]]; then
  echo "parity run produced no side captures" >&2
  exit 2
fi

if ! diff -u "${expected_baseline}" "${generated_baseline}"; then
  echo "S1 22-family baseline side diverged from committed evidence" >&2
  exit 1
fi

if ! diff -u "${expected_challenger}" "${generated_challenger}"; then
  echo "S1 22-family challenger side diverged from committed evidence" >&2
  exit 1
fi

python3 - "${expected_receipt}" <<'PY'
import json, sys
with open(sys.argv[1]) as handle:
    receipt = json.load(handle)
matrix = receipt["familyCoverage"]
verdict = receipt["parityReceipt"]["aggregateVerdict"]
assert verdict == "pass", verdict
assert len(matrix) == 22, len(matrix)
assert all(row["outcome"] == "pass" for row in matrix), [
    row["familyId"] for row in matrix if row["outcome"] != "pass"
]
assert receipt["parityReceipt"]["assembledCommonGraphParity"] is True
assert "heldOutNegativeVerdicts" in receipt, "missing held-out negative gate"
assert receipt["heldOutNegativeVerdicts"] == [], receipt["heldOutNegativeVerdicts"]
assert receipt["acceptance"]["eligible"] is False, (
    "fixture/comparator corpus must not claim production acceptance eligibility"
)
assert receipt["acceptance"]["verdict"] == "ineligible", (
    receipt["acceptance"]["verdict"]
)
print(
    "S1 22-family sealed-capture parity receipt verified: "
    f"aggregate={verdict}, families={len(matrix)}, "
    "nonPassFamilyIds=[], heldOutNegativeVerdicts=[], "
    "acceptance=ineligible(unit-contract), baseline/challenger side captures identical"
)
PY
