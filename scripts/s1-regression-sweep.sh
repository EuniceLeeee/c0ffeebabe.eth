#!/usr/bin/env bash
set -euo pipefail

# S1 regression sweep: runs every Phase 0-4 contract test, the full
# listener build and the committed 22-family sealed-capture parity
# verifier. Writes a machine-readable receipt to the output directory.
# Evidence/CI gate only: no live, signing, broadcast or cutover.
#
# Usage:
#   scripts/s1-regression-sweep.sh [baseline-dir] [impl-dir] [out-dir]

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
baseline_dir="${1:-${repo_root}/../mev-parity-baseline}"
impl_dir="${2:-${repo_root}}"
out_dir="${3:-$(mktemp -d)}"
mkdir -p "${out_dir}"

listener="${impl_dir}/listener"
started=$(date -u +%s)

run_test() {
  local name="$1"
  shift
  echo "[s1-regression] ${name}"
  (cd "${listener}" && "$@") >"${out_dir}/${name}.log" 2>&1
  echo "${name}" >>"${out_dir}/tests-passed.txt"
}

run_test build npm run build
run_test architecture-migration-capture npm run searcher:architecture-migration-capture
run_test adapter-family-shadow-suite npm run searcher:adapter-family-shadow-suite
run_test architecture-migration-parity-runner npm run searcher:architecture-migration-parity-runner
run_test default-authority-cutover-gate npm run searcher:default-authority-cutover-gate
run_test systemic-live-gate npm run searcher:systemic-live-gate
run_test s1-cutover-readiness npm run searcher:s1-cutover-readiness
run_test production-family-startup-manifest npm run searcher:production-family-startup-manifest
run_test strict-catalog-consumer-diagnostic npm run searcher:strict-catalog-consumer-diagnostic

echo "[s1-regression] parity verifier"
"${repo_root}/scripts/verify-s1-parity-receipt.sh" \
  "${baseline_dir}" "${impl_dir}" "${out_dir}/parity-verify" \
  >"${out_dir}/parity-verify.log" 2>&1
echo "parity-verifier" >>"${out_dir}/tests-passed.txt"

echo "[s1-regression] node evidence verifier"
node_records=("${repo_root}"/docs/research/design/evidence/s1-node-run-*.json)
if [[ ${#node_records[@]} -gt 0 ]]; then
  for record in "${node_records[@]}"; do
    "${repo_root}/scripts/verify-s1-node-evidence.sh" "${record}" \
      >"${out_dir}/node-evidence-$(basename "${record}" .json).log" 2>&1
  done
  echo "node-evidence-verifier" >>"${out_dir}/tests-passed.txt"
else
  echo "[s1-regression] no committed node evidence records" >&2
  exit 2
fi

echo "[s1-regression] node enumerator evidence verifier"
enumerator_records=(
  "${repo_root}"/docs/research/design/evidence/s1-node-enumerator-dry-run-*.json
)
if [[ ${#enumerator_records[@]} -gt 0 ]]; then
  for record in "${enumerator_records[@]}"; do
    "${repo_root}/scripts/verify-s1-node-enumerator-evidence.sh" \
      "${record}" "${impl_dir}" \
      >"${out_dir}/node-enumerator-evidence-$(basename "${record}" .json).log" 2>&1
  done
  echo "node-enumerator-evidence-verifier" >>"${out_dir}/tests-passed.txt"
else
  echo "[s1-regression] no committed node enumerator evidence records" >&2
  exit 2
fi

finished=$(date -u +%s)
sha="$("${repo_root}/scripts/verify-s1-parity-receipt.sh" \
  "${baseline_dir}" "${impl_dir}" "${out_dir}/parity-verify" \
  >/dev/null 2>&1 && git -C "${impl_dir}" rev-parse HEAD)"
cat >"${out_dir}/s1-regression-receipt.json" <<JSON
{
  "format": "s1-regression-sweep-v1",
  "implCommit": "${sha}",
  "passedTests": $(wc -l <"${out_dir}/tests-passed.txt" | tr -d ' '),
  "startedAtUnix": ${started},
  "finishedAtUnix": ${finished}
}
JSON

echo "[s1-regression] PASS commit=${sha} tests=$(wc -l <"${out_dir}/tests-passed.txt" | tr -d ' ')"
echo "receipt: ${out_dir}/s1-regression-receipt.json"
