#!/usr/bin/env bash
set -euo pipefail

# F5: collect a real on-chain sealed-production corpus from the node's local
# reth, split it into train/held-out, and run the real capture CLI so the
# sealed-production acceptance has non-empty held-out negatives with real
# productionProvenance (commit/sourceBlock/sourceBlockHash/evidencePath).
#
# Node-side usage (SSM):
#   bash /opt/MEV-impl-capture/scripts/collect-s1-sealed-production-corpus.sh \
#     <descriptor.json> <corpus-dir>
#
# The descriptor must be produced from real chain data. This script only
# executes and verifies it; it never fabricates evidence refs or block hashes.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
descriptor="${1:?descriptor path required}"
corpus_dir="${2:?corpus output dir required}"

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
split_index="$(( (case_count * 3) / 4 ))"
if (( split_index >= case_count )); then split_index=$((case_count - 1)); fi
if (( split_index < 1 )); then
  echo "[corpus] need at least 2 cases for a non-empty held-out set" >&2
  exit 4
fi

python3 - "$descriptor" "$corpus_dir" "$split_index" <<'PY'
import json, os, sys

descriptor_path, corpus_dir, split_index = sys.argv[1], sys.argv[2], int(sys.argv[3])
doc = json.load(open(descriptor_path))
cases = doc["cases"]
train = cases[:split_index]
heldout = cases[split_index:]
with open(os.path.join(corpus_dir, "train-descriptor.json"), "w") as fh:
    json.dump({**doc, "cases": train}, fh, indent=2)
    fh.write("\n")
with open(os.path.join(corpus_dir, "heldout-descriptor.json"), "w") as fh:
    json.dump({**doc, "cases": heldout}, fh, indent=2)
    fh.write("\n")
print(f"[corpus] train={len(train)} heldout={len(heldout)}")
PY

commit="$(git -C "$repo_root" rev-parse HEAD)"
cd "$repo_root/listener"
for side in train heldout; do
  npx tsx src/searcher/run-architecture-migration-capture-real-cli.ts \
    "$corpus_dir/${side}-descriptor.json" \
    "$corpus_dir/${side}-side.json"
  python3 - "$corpus_dir/${side}-side.json" "$commit" "$side" <<'PY'
import json, sys

path, commit, side = sys.argv[1], sys.argv[2], sys.argv[3]
doc = json.load(open(path))
prov = doc.get("productionProvenance")
if prov is None:
    raise SystemExit(f"{side} capture lacks productionProvenance")
if prov.get("commit") != commit:
    raise SystemExit(f"{side} capture commit mismatch")
print(f"[corpus] {side} side capture sealed commit={commit}")
PY
done

cat >"$corpus_dir/corpus-manifest.json" <<JSON
{
  "format": "s1-sealed-production-corpus-v1",
  "commit": "${commit}",
  "sourceBlock": ${source_block},
  "sourceBlockHash": "${source_hash}",
  "totalCases": ${case_count},
  "trainCases": ${split_index},
  "heldOutCases": $((case_count - split_index)),
  "trainSide": "train-side.json",
  "heldOutSide": "heldout-side.json"
}
JSON
echo "[corpus] DONE corpus_dir=$corpus_dir commit=$commit"
