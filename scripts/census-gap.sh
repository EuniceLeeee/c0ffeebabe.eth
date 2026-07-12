#!/usr/bin/env bash
# census-gap.sh — per-take "why didn't we win" verdicts over a block window.
# Glue only: joins the two existing CLIs — census-report (competitor takes in the window) ×
# bundle-postmortem any-tx (our-side events/venue-overlap/graph signal per take) — and rolls up
# ONE line per take: block, tx, style, net_usd, our_events, overlap, oog, verdict.
# Verdict ladder: structural non_comparable/routing/pool gaps first, then the source-block N-1
# block-scan evidence (complete/busy/budget/rotated/token-overlap), then the legacy JSONL/backrun
# lane fallback. A solved-ring token overlap is evidence only; it is not asserted to be the same
# route because the text log contains top candidate rings rather than the full scanned universe.
# routing_gap is ALSO a standalone column so the structural flag stays visible on non_comparable rows.
# Runs ON the node (local reth = zero CU for recent windows; older than ~10k blocks needs archive RPC).
# Usage: census-gap.sh <from-block> <to-block> [watch-csv] [out-dir] [--blockscan-log <path>]
set -euo pipefail
FROM=${1:?from-block}; TO=${2:?to-block}
WATCH=${3:-0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13}
OUT=${4:-/tmp/census-gap-$FROM-$TO}
BLOCKSCAN_LOG=${BLOCKSCAN_LOG:-}
if [ "${5:-}" = "--blockscan-log" ]; then
  BLOCKSCAN_LOG=${6:?--blockscan-log requires a path}
elif [ -n "${5:-}" ]; then
  echo "unknown argument: ${5}" >&2
  exit 2
fi
RPC=${RPC:-http://127.0.0.1:8545}
EVENTS=${EVENTS:-}
GRAPH=${GRAPH:-/opt/MEV/listener/searcher/pools/runtime-graph-pools.json}
if [ -z "$BLOCKSCAN_LOG" ]; then
  UNIT_LOG=$(systemctl show mev-searcher -p StandardOutput --value 2>/dev/null \
    | sed -n 's/^append://p' || true)
  BLOCKSCAN_LOG=${UNIT_LOG:-/var/log/mev-live.log}
fi
if [ -z "$EVENTS" ]; then
  SEARCHER_PID=$(systemctl show mev-searcher -p MainPID --value 2>/dev/null || true)
  if [ -n "$SEARCHER_PID" ] && [ "$SEARCHER_PID" != "0" ] && [ -r "/proc/$SEARCHER_PID/environ" ]; then
    EVENTS=$(tr '\0' '\n' < "/proc/$SEARCHER_PID/environ" \
      | sed -n 's/^SEARCHER_EVENTS_PATH=//p' | tail -1)
  fi
  EVENTS=${EVENTS:-/var/log/mev/events/searcher-live.jsonl}
fi
command -v jq >/dev/null || { echo "jq required"; exit 2; }
[ -r "$EVENTS" ] || { echo "events file unreadable: $EVENTS" >&2; exit 2; }
[ -r "$GRAPH" ] || { echo "routing graph unreadable: $GRAPH" >&2; exit 2; }
echo "inputs: events=$EVENTS blockscan=$BLOCKSCAN_LOG graph=$GRAPH" >&2
mkdir -p "$OUT"
# A window may be rerun with a different watchlist or after a transient PM
# failure. Never let artifacts from an earlier invocation enter this run.
rm -f "$OUT/census.json" "$OUT/census.err" "$OUT/blockscan.log" \
  "$OUT/verdicts.tsv" "$OUT"/pm-0x*.json
cd /opt/MEV/analysis

# Read the potentially large mixed live log once. The PM parser still needs all
# block-scan markers to distinguish a rotated target from an in-window absence,
# but each per-tx process can consume this much smaller lane-only slice.
BLOCKSCAN_INPUT=$BLOCKSCAN_LOG
if [ -r "$BLOCKSCAN_LOG" ]; then
  BLOCKSCAN_INPUT="$OUT/blockscan.log"
  grep '\[searcher/blockscan\]' "$BLOCKSCAN_LOG" > "$BLOCKSCAN_INPUT" || true
fi

npm run -s census-report -- --watch "$WATCH" --from-block "$FROM" --to-block "$TO" \
  --rpc "$RPC" --graph "$GRAPH" --out "$OUT/census.json" >/dev/null 2>"$OUT/census.err" \
  || { echo "census failed:"; tail -3 "$OUT/census.err"; exit 1; }
jq -e '
  (.summary | type == "object")
  and ((.matched_competitors // .analyzed_competitors) | type == "array")
' "$OUT/census.json" >/dev/null \
  || { echo "census output missing summary or matched competitor list" >&2; exit 1; }

# Read ALL matched takes (matched_competitors), NOT analyzed_competitors — the latter is the
# route-gap subset (out-of-graph venue only) and silently hides all-in-graph takes, which are
# exactly the "we could have competed" cases this report exists for (found 2026-07-12: 8 coffee
# takes in one block, analyzed=0 because every venue was in-graph).
HASHES=$(jq -r '(.matched_competitors // .analyzed_competitors)[]?.hash // empty' "$OUT/census.json")
if [ -z "$HASHES" ]; then
  jq -r '"no competitor takes in window '"$FROM-$TO"' (matched=\(.summary.matched_txs) skipped_below_profit=\(.summary.skipped_below_profit // 0) — matched>0 with empty list means an OLD census-report without matched_competitors)"' "$OUT/census.json"
  exit 0
fi

PM_FILES=()
PM_FAILURES=0
for h in $HASHES; do
  pm="$OUT/pm-$h.json"
  if npm run -s bundle-postmortem -- --events "$EVENTS" --tx "$h" --rpc "$RPC" --graph "$GRAPH" \
    --blockscan-log "$BLOCKSCAN_INPUT" --out "$pm" >/dev/null 2>&1; then
    PM_FILES+=("$pm")
  else
    rm -f "$pm"
    PM_FAILURES=$((PM_FAILURES + 1))
    echo "pm-fail $h" >&2
  fi
done

[ "${#PM_FILES[@]}" -gt 0 ] || { echo "no postmortems produced (failures=$PM_FAILURES)"; exit 1; }
{
  printf 'block\ttx\tstyle\tnet_usd\tour_events\toverlap\tbs_source\tbs_status\tbs_rings\tbs_token_overlap\trouting_gap\toog\tverdict\n'
  jq -r -s 'sort_by(.tx.block)[] |
    (.our_events_at_block.total // 0) as $ev |
    ((.our_events_at_block.venue_overlap // []) | length) as $ov |
    ((.out_of_graph_venues // []) | length) as $oog |
    ([(.touchedVenues // [])[] | select(.routing_admitted == false)] | length) as $rg |
    (.our_blockscan_for_target // null) as $bs |
    ($bs.status // "unset") as $bss |
    (if .non_comparable_winner == true then "non_comparable:" + (.winner_style // "?")
     elif $rg > 0 then "routing_gap(hooked-v4 x\($rg))"
     elif $oog > 0 then "pool_gap(\($oog) oog)"
     elif $bs != null and $bss == "unknown_log_rotated" then "unknown_log_rotated"
     elif $bs != null and ($bss == "unknown_log_not_covered" or $bss == "unknown_log_empty" or $bss == "log_unavailable") then "unknown_log_unavailable:\($bss)"
     elif $bs != null and ($bss == "incomplete" or $bss == "error") then "unknown_log_incomplete:\($bss)"
     elif $bs != null and $bss == "skipped_busy" then "scan_skipped_busy"
     elif $bs != null and $bss == "not_running" then "not_running"
     elif $bs != null and $bss == "budget_exceeded" then "scan_budget_exceeded"
     elif $bs != null and $bss == "complete" and ($bs.competitor_token_count // 0) == 0 then "unknown_competitor_tokens"
     elif $bs != null and $bss == "complete" and ($bs.related_jsonl_submission_seen // false) then "scan_related_submission_seen"
     elif $bs != null and $bss == "complete" and ($bs.any_submitted // false) then "scan_pass_had_submission"
     elif $bs != null and $bss == "complete" and ($bs.token_overlap_count // 0) == 0 then "scan_candidate_token_gap"
     elif $bs != null and $bss == "complete" then "scan_token_overlap_no_submit"
     elif $ev == 0 then "not_seen"
     elif $ov == 0 then "seen_no_overlap"
     else "seen_lost" end) as $v |
    [.tx.block, .tx.hash[0:10], (.winner_style // "?"), (.pnl.netProfitUsd // "null"),
     $ev, $ov, ($bs.source_block // "-"), $bss, ($bs.solve_ring_count // 0),
     (($bs.token_overlap_count // 0) | tostring) + "/" + (($bs.competitor_token_count // 0) | tostring),
     $rg, $oog, $v] | @tsv' "${PM_FILES[@]}"
} | tee "$OUT/verdicts.tsv"
echo "reports: $OUT (census.json, pm-<tx>.json, verdicts.tsv)" >&2
if [ "$PM_FAILURES" -gt 0 ]; then
  echo "incomplete: $PM_FAILURES postmortem(s) failed; stale artifacts were excluded" >&2
  exit 1
fi
