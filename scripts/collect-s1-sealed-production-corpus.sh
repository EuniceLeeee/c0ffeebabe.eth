#!/usr/bin/env bash
set -euo pipefail

# F5: execute one catalog-issued descriptor against two independent fixed
# source closures, generate one schema-level canonical mutation per captured
# Family, and run the sealed-production parity judge. This orchestrator knows
# no Family/protocol/selector/topic/address semantics.
#
# Both worktrees run the SAME generic catalog-driven capture CLI, each at
# its own fixed HEAD: baseline_root is the pre-migration closure (frozen
# earlier impl tip), challenger_root is the migration closure. Generic
# capture consumes each closure OWN catalog/plugin semantics, so the parity
# judge compares pre- vs post-migration behavior on the same real input.
#
# Node-side usage (SSM):
#   bash /opt/MEV-impl-capture/scripts/collect-s1-sealed-production-corpus.sh \
#     <descriptor.json> <corpus-dir> <baseline-worktree> <challenger-worktree>
#
# The descriptor must be produced from real chain data. This script only
# executes and verifies it; it never fabricates evidence refs or block hashes.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
descriptor="${1:?descriptor path required}"
corpus_dir="${2:?corpus output dir required}"
baseline_root="${3:?baseline worktree required}"
challenger_root="${4:?challenger worktree required}"

if ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("sourceBlock") and d.get("sourceBlockHash") and isinstance(d.get("cases"), list) and d["cases"]' "$descriptor"; then
  echo "[corpus] descriptor must carry sourceBlock, sourceBlockHash and non-empty cases" >&2
  exit 2
fi

source_block="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceBlock"])' "$descriptor")"
source_hash="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceBlockHash"])' "$descriptor")"
case_count="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["cases"]))' "$descriptor")"

# Fail-closed: real provenance must match the node's canonical chain view.
local_hash="$(curl -sS http://127.0.0.1:8545 \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"0x$(printf '%x' "$source_block")\",false]}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["hash"])')"
if [[ "${local_hash,,}" != "${source_hash,,}" ]]; then
  echo "[corpus] sourceBlockHash mismatch: descriptor=$source_hash local=$local_hash" >&2
  exit 3
fi

mkdir -p "$corpus_dir"
baseline_commit="$(git -C "$baseline_root" rev-parse HEAD)"
challenger_commit="$(git -C "$challenger_root" rev-parse HEAD)"
if [[ "$baseline_commit" == "$challenger_commit" ]]; then
  echo "[corpus] baseline and challenger commits must be distinct" >&2
  exit 4
fi
if [[ -n "$(git -C "$baseline_root" status --porcelain)" ]] ||
   [[ -n "$(git -C "$challenger_root" status --porcelain)" ]]; then
  echo "[corpus] both capture worktrees must be clean" >&2
  exit 5
fi
for root in "$baseline_root" "$challenger_root"; do
  if [[ ! -f "$root/listener/src/searcher/run-architecture-migration-capture-real-cli.ts" ]]; then
    echo "[corpus] $root lacks the generic capture CLI at its fixed HEAD" >&2
    exit 6
  fi
done

run_side() {
  local root="$1"
  local output="$2"
  (
    cd "$root/listener"
    node --import tsx \
      src/searcher/run-architecture-migration-capture-real-cli.ts \
      "$descriptor" "$output"
  )
}

run_side "$baseline_root" "$corpus_dir/baseline-side.json"
run_side "$challenger_root" "$corpus_dir/challenger-side.json"

held_out_manifest="$corpus_dir/held-out-negatives.json"
(
  cd "$challenger_root/listener"
  node --import tsx \
    src/searcher/generate-architecture-migration-held-out-negatives.ts \
    "$corpus_dir/baseline-side.json" \
    "$corpus_dir/challenger-side.json" \
    "$corpus_dir/held-out" \
    "$held_out_manifest"
)

state_root="$(curl -sS http://127.0.0.1:8545 \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"0x$(printf '%x' "$source_block")\",false]}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["stateRoot"])')"

python3 - "$corpus_dir" "$held_out_manifest" "$source_block" "$source_hash" \
  "$state_root" "$challenger_commit" "$case_count" <<'PY'
import json, os, sys

directory, negatives_path, number, block_hash, state_root, commit, count = sys.argv[1:]
negatives = json.load(open(negatives_path))
if not negatives:
    raise SystemExit("held-out negative manifest is empty")
request = {
    "baselinePath": os.path.join(directory, "baseline-side.json"),
    "challengerPath": os.path.join(directory, "challenger-side.json"),
    "evidenceClass": "sealed-production",
    "mode": "pure-refactor",
    "stateAnchors": [{
        "number": int(number),
        "hash": block_hash,
        "stateRoot": state_root,
    }],
    "performanceDiagnostics": {
        "wallMs": 0,
        "requestCount": 0,
        "batchCount": 1,
        "peakConcurrency": 1,
    },
    "heldOutNegatives": negatives,
    "productionProvenance": {
        "commit": commit,
        "sourceBlock": int(number),
        "sourceBlockHash": block_hash,
        "evidencePath": directory,
    },
}
with open(os.path.join(directory, "batch-request.json"), "w") as handle:
    json.dump(request, handle, indent=2)
    handle.write("\n")
manifest = {
    "format": "s1-sealed-production-corpus-v2",
    "baselineCommit": json.load(open(request["baselinePath"]))["closure"]["commit"],
    "challengerCommit": json.load(open(request["challengerPath"]))["closure"]["commit"],
    "sourceBlock": int(number),
    "sourceBlockHash": block_hash,
    "totalCases": int(count),
    "heldOutNegatives": len(negatives),
}
with open(os.path.join(directory, "corpus-manifest.json"), "w") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PY

(
  cd "$challenger_root/listener"
  node --import tsx src/searcher/run-architecture-migration-parity-cli.ts \
    "$corpus_dir/batch-request.json" >"$corpus_dir/parity-receipt.json"
)
python3 - "$corpus_dir/parity-receipt.json" <<'PY'
import json, sys
receipt = json.load(open(sys.argv[1]))
if receipt.get("acceptance", {}).get("eligible") is not True:
    raise SystemExit("sealed-production acceptance is not eligible")
if receipt.get("acceptance", {}).get("verdict") != "pass":
    raise SystemExit("sealed-production acceptance verdict is not pass")
print("[corpus] sealed-production eligible=true verdict=pass")
PY
echo "[corpus] DONE corpus_dir=$corpus_dir baseline=$baseline_commit challenger=$challenger_commit"
