#!/usr/bin/env bash
set -euo pipefail

# S1 regression sweep: runs every Phase 0-4 contract test, the full
# listener build and active generic capture contracts. Historical fixture-era
# parity/node evidence remains sealed under docs but is not an active gate.
# Evidence/CI gate only: no live, signing, broadcast or cutover.
#
# Usage:
#   scripts/s1-regression-sweep.sh [baseline-dir] [impl-dir] [out-dir]

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
run_test adapter-family-shadow-suite npm run searcher:adapter-family-shadow-suite
run_test default-authority-cutover-gate npm run searcher:default-authority-cutover-gate
run_test systemic-live-gate npm run searcher:systemic-live-gate
run_test s1-cutover-readiness npm run searcher:s1-cutover-readiness
run_test production-family-startup-manifest npm run searcher:production-family-startup-manifest
run_test strict-catalog-consumer-diagnostic npm run searcher:strict-catalog-consumer-diagnostic
run_test universe-rebuild-checkpoint npm run searcher:universe-rebuild-checkpoint
run_test universe-rebuild-runner npm run searcher:universe-rebuild-runner
run_test universe-rebuild-probe-cli npm run searcher:universe-rebuild-probe-cli
run_test universe-rebuild-production npm run searcher:universe-rebuild-production

finished=$(date -u +%s)
sha="$(git -C "${impl_dir}" rev-parse HEAD)"
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
