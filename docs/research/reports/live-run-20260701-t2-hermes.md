# Hermes — Turn 2 `20260701-t2` (coverage classification)

> Same run window as `live-run-20260701-032600` (blocks 25434876–25434966). No new dry-run this turn.
> Step-1 competitor cross-reference is the EXISTING `analysis live-loss --watch <watchlist>` + `--competitor-scan` (per CLAUDE.md).

## Run Facts / Step-1 competitor cross-reference  <!-- auto, grounded -->

Watchlist bots `0xc0ffeebabe…` (coffeebabe) + `0xae2Fc483…` over the window: **21 MEV txs**. `seenScope`: 15 `none`(not_seen) / 3 `block_only` / 2 `same_token` / 1 `same_pool`(`0x7dfddfb8`, seen_but_lost). Secondary-validated vs Alchemy (local reth agreed on distinct-pool counts 6/6, 3/3, 6/6).

## Discovery — the misleading instrument  <!-- verified -->

The watch field `poolInOurGraph` (live-loss.ts:1130) = `pools.some(p => seen.pools.has(p))` — it means **"appeared in OUR events this window"**, NOT routing-graph membership. It reported `poolInOurGraph:false` for `0x3416cf6c` (Uni V3 USDC/USDT) even though that pool IS in `pinned-warm-pools.json`. Verified graph sources: runtime graph = **2422 pools** (2 protocol + 8 pinned + 2324 factory + 100 swap-active), rebuilt each run; `active-pools.json` absent on the node (universe=0). So a `not_seen` with `poolInOurGraph:false` could be a **detection gap** (pool IS in the 2422 graph, we just got no hint) OR a **graph gap** (pool absent) — the field cannot tell them apart. Nearly repeated the turn-1 mistake of concluding "coverage gap" from a non-authoritative signal.

## Claude Final Decision  <!-- AUTHORITATIVE -->
- **decision:** Make the not_seen classification authoritative before doing ANY graph/detection work: searcher dumps its runtime graph pool set at startup; analysis loads it and splits not_seen into `graph_gap` (pool ∉ 2422-pool graph) vs `detection_gap` (pool ∈ graph, no hint). Rename the old field's label to `pool_in_seen_events`; add `pool_in_routing_graph` + `gap_type`. No blind pool-adding.
- **rationale:** two turns in a row a non-authoritative signal nearly drove a wrong conclusion; fixing the instrument is the honest unblocker and decides turn 3's real target (detection vs coverage).

## Implementation Brief
| task | owner | files | done-when |
|---|---|---|---|
| Startup-only fail-open dump of `allPools` → `searcher/pools/runtime-graph-pools.json` | Codex | `listener/src/searcher/main.ts` (~437) | dump written on start; never breaks startup |
| Load dump (`--graph-pools`, default path); add `pool_in_routing_graph` + `gap_type`; relabel old field `pool_in_seen_events`; aggregate not_seen by gap_type | Codex | `analysis/src/cli/live-loss.ts` | tsc clean; fields in watch reports + summary |

## Acceptance Criteria
1. `tsc` clean in listener/ and analysis/.
2. After a searcher startup produces the dump, `--watch … --graph-pools <dump>` classifies `0x3416cf6c` as `detection_gap`; reports the real graph_gap/detection_gap split of the ~18 not_seen.

## Implementation / Review-Fix Loop
### Codex Implementation
- **note:** codex exec truncated on the first two attempts (stopped after the exploration phase — suspected rate/step limit); third attempt landed both edits. Full diff reviewed (turn-1 lesson: gate the WHOLE diff).
- **fixed:** main.ts startup dump (fail-open); live-loss.ts graph-pool load + `pool_in_routing_graph` + `gap_type` + `pool_in_seen_events` relabel + not_seen-by-gap_type aggregate.

### Claude Review
- **ran_gate:** (1) `npm run build` listener + analysis → both tsc exit 0. (2) deployed both files to the node; started `mev-searcher` ~90s → it dumped `runtime-graph-pools.json` (**2512 pools**), stopped. (3) re-ran `--watch <2 bots> --graph-pools <dump>` → aggregate + read raw JSON.
- **finding:** PASS. `0x3416cf6c` → `pool_in_routing_graph:true, gap_type:detection_gap` ✓ (acceptance met). Authoritative split of the 18 not_seen: **graph_gap=13, detection_gap=5, unknown=0.** Both gaps real; graph_gap dominant. (Self-note: my first re-read queried camelCase keys and saw nulls — the JSON is snake_case `gap_type`/`pool_in_routing_graph`; the data was correct. roughProfit is a flat USD number, e.g. this coffeebabe-peer arb `0xfde6557ca7…` = **$315** on a Fluid+Uni-v4 swap-loop.)
- **blocking:** none.
- **approve_or_continue:** final_approval — classification is now authoritative; `--watch --graph-pools` is the Step-1 tool going forward.

## Next Run
- **next_state:** turn 3 attacks the **graph_gap=13** (dominant): identify those 13 genuinely-missing pools, why they're absent from the 2512-pool runtime graph (factory not scanned / adapter unsupported / below discovery topN), and close the highest-value ones. The 5 detection_gap (pool in graph, no hint) → separate mempool/router-signal follow-up.
- **live_allowed:** no (dry-run only; go-live human gate).
