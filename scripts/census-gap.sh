#!/usr/bin/env bash
# census-gap.sh — per-take "why didn't we win" verdicts over a block window.
# Glue only: joins the two existing CLIs — census-report (competitor takes in the window) ×
# bundle-postmortem any-tx (our-side events/venue-overlap/graph signal per take) — and rolls up
# ONE line per take: block, tx, style, net_usd, our_events, overlap, oog, verdict.
# Verdict ladder: non_comparable → routing_gap (venue in discovery but token-graph admission skips
#   it, e.g. hooked v4 — ring can't close) → pool_gap (out-of-graph venue) → not_seen (0 events at
#   block) → seen_no_overlap (events but not on these venues) → seen_lost (had signal, lost anyway).
# routing_gap is ALSO a standalone column so the structural flag stays visible on non_comparable rows.
# Runs ON the node (local reth = zero CU for recent windows; older than ~10k blocks needs archive RPC).
# Usage: census-gap.sh <from-block> <to-block> [watch-csv] [out-dir]
set -uo pipefail
FROM=${1:?from-block}; TO=${2:?to-block}
WATCH=${3:-0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13}
OUT=${4:-/tmp/census-gap-$FROM-$TO}
RPC=${RPC:-http://127.0.0.1:8545}
EVENTS=${EVENTS:-/var/log/mev/events/searcher-live.jsonl}
GRAPH=${GRAPH:-/opt/MEV/listener/searcher/pools/active-pools.json}
command -v jq >/dev/null || { echo "jq required"; exit 2; }
mkdir -p "$OUT"; cd /opt/MEV/analysis

npm run -s census-report -- --watch "$WATCH" --from-block "$FROM" --to-block "$TO" \
  --rpc "$RPC" --graph "$GRAPH" --out "$OUT/census.json" >/dev/null 2>"$OUT/census.err" \
  || { echo "census failed:"; tail -3 "$OUT/census.err"; exit 1; }

# Read ALL matched takes (matched_competitors), NOT analyzed_competitors — the latter is the
# route-gap subset (out-of-graph venue only) and silently hides all-in-graph takes, which are
# exactly the "we could have competed" cases this report exists for (found 2026-07-12: 8 coffee
# takes in one block, analyzed=0 because every venue was in-graph).
HASHES=$(jq -r '(.matched_competitors // .analyzed_competitors)[]?.hash // empty' "$OUT/census.json")
if [ -z "$HASHES" ]; then
  jq -r '"no competitor takes in window '"$FROM-$TO"' (matched=\(.summary.matched_txs) skipped_below_profit=\(.summary.skipped_below_profit // 0) — matched>0 with empty list means an OLD census-report without matched_competitors)"' "$OUT/census.json"
  exit 0
fi

for h in $HASHES; do
  npm run -s bundle-postmortem -- --events "$EVENTS" --tx "$h" --rpc "$RPC" --graph "$GRAPH" \
    --out "$OUT/pm-$h.json" >/dev/null 2>&1 || echo "pm-fail $h" >&2
done

ls "$OUT"/pm-0x*.json >/dev/null 2>&1 || { echo "no postmortems produced"; exit 1; }
{
  printf 'block\ttx\tstyle\tnet_usd\tour_events\toverlap\trouting_gap\toog\tverdict\n'
  jq -r -s 'sort_by(.tx.block)[] |
    (.our_events_at_block.total // 0) as $ev |
    ((.our_events_at_block.venue_overlap // []) | length) as $ov |
    ((.out_of_graph_venues // []) | length) as $oog |
    ([(.touchedVenues // [])[] | select(.routing_admitted == false)] | length) as $rg |
    (if .non_comparable_winner == true then "non_comparable:" + (.winner_style // "?")
     elif $rg > 0 then "routing_gap(hooked-v4 x\($rg))"
     elif $oog > 0 then "pool_gap(\($oog) oog)"
     elif $ev == 0 then "not_seen"
     elif $ov == 0 then "seen_no_overlap"
     else "seen_lost" end) as $v |
    [.tx.block, .tx.hash[0:10], (.winner_style // "?"), (.pnl.netProfitUsd // "null"),
     $ev, $ov, $rg, $oog, $v] | @tsv' "$OUT"/pm-0x*.json
} | tee "$OUT/verdicts.tsv"
echo "reports: $OUT (census.json, pm-<tx>.json, verdicts.tsv)" >&2
