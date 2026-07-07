# 2026-07-07 — coffee 0xf698e6c2 postmortem: STBT (permissioned RWA) atomic loop — venue gap we deliberately do NOT close

Scope note: authorized defensive on-chain arbitrage research; reads public chain data + our own
run telemetry; broadcast stays human-gated (CLAUDE.md Safety Rule 1).

Question (operator): tx `0xf698e6c277a0e899ca4bcad18cc23e9ff5cbd9a0abfd1111300d214c190634c0` — what is it?

## Verdict

**Standalone atomic loop (not a backrun) through a permissioned RWA route: two of its four legs
are out of our graph, and we should leave them out.** coffee flash-loans 0.0403 WETH, runs
WETH → DAI (v3, in-graph) → 3CRV (Curve 3pool `add_liquidity`, in-graph venue / lp-style leg) →
**STBT** (Matrixdock T-bill RWA, rebasing + KYC-whitelisted) via the STBT/3CRV metapool
`0x892d701d` (NOT in graph) → sells STBT for ETH at a non-standard venue `0x7d002303` (NOT in
graph) → repays. Net **$0.51** (tx-profit: $0.54 realized − $0.03 builder). The whole venue
class trades **~2×/day** (24h of logs: 2 TokenExchange on the metapool, both via the same
router `0x45312ea0`; 2 fills on the exit venue) ≈ **$1/day class value**. STBT is
KYC-permissioned — coffee's own contract never holds STBT (the whitelisted router does), so the
leg fails the F-009 3-point replicability test (externally callable without whitelist/inventory:
UNPROVEN) until proven otherwise. Dust economics × access-unproven × new-adapter cost ⇒
**classified venue gap, deliberately not closed** (decision-log F-012).

## Facts (tool-cited)

1. **Tx** (local reth via SSM): coffeebabe EOA → `0xe08d97e1…d015`, block 25476156 idx 125,
   prio ≈0.218 gwei, gasUsed 711,823, 23 logs.
2. **Route** (receipt walk): Balancer flash-loan 0.040283 WETH → Uni v3 DAI/WETH 0.05%
   `0x60594a40…` (in-graph): 73.0949 DAI → Curve 3pool `0xbebc4478…` (in-graph)
   `add_liquidity` → 70.3092 3CRV → STBT/3CRV factory metapool `0x892d701d…` (TokenExchange
   `0x8b3e96f2`): 73.8914 STBT → router `0x45312ea0…` → venue `0x7d00230379…` pays
   0.0405977 ETH (its own WETH Deposit then transfer) → repay loan; profit-take Withdrawal
   0.000314 ETH.
3. **Token identity** (on-chain `symbol()` + WebSearch): `0x530824da…` = **STBT** (Matrixdock
   Short-term Treasury Bill Token; 1:1 USD NAV, daily rebase, **KYC-permissioned**);
   `0x892d701d…` symbol `STBT3CRV-f`. Coffee never holds STBT — transfers go
   metapool→router→venue only.
4. **Standing dislocation, not backrun** (block-wide `eth_getLogs` at 25476156): the ONLY tx
   touching all 4 venues in the block is coffee's idx 125; no prior in-block mover (an
   unrelated DAI/WETH swap lands later at idx 133).
5. **Economics** (`npm run tx-profit`, canonical): realized $0.54, builder $0.03, net $0.51.
6. **Class frequency** (local reth, 24h logs): metapool TokenExchange ×2 (both via
   `0x45312ea0`), exit venue events ×2 → ≈$1/day for the whole class.
7. **Graph membership**: v3 DAI/WETH hit=1, 3pool hit=1, metapool hit=0, exit venue hit=0
   (active-pools.json). Our events at that block: 21, zero touching any leg.
8. **Canonical divergence** (`npm run census-report`, same block): `route_gap_decisive=false`,
   `distinct_out_of_graph=0` — WRONG for this tx: its out-of-graph detection counts univ2/3/4
   lineage only, so the curve-metapool + exotic-venue gaps are invisible. Filed as an extension
   of `tooldef-20260706-census-single-tx-ingraph-detail` (rule 16: divergence is the finding).

## Gap classification

- **Formally a venue/pool gap** (metapool is curve-adapter-compatible; exit venue would need a
  new adapter + ABI reverse-engineering — its event `0xb2e76ae9` is unidentified publicly).
- **Practically not ours to close now:** (a) measured class value ≈ $1/day; (b) STBT
  whitelisting means replicability hinges on whether router `0x45312ea0` is permissionless —
  unproven, and per the F-009 operator ruling a leg must be proven externally-callable BEFORE
  any edge work; (c) even in the best case it is one more dust stream inside the coffee dust
  ceiling. Reflex codified: RWA/permissioned-token loops get the F-009 3-point test FIRST, and
  a class-frequency measurement (a day of venue logs) BEFORE any adapter/indexing work.

## Method Trace
task_class:       bundle_postmortem
tools_used:       - SSM + local reth (zero-CU): eth_getTransactionByHash/Receipt, block-wide eth_getLogs (same-block movers), 24h venue-activity logs, on-chain symbol() calls
                  - npm run tx-profit (canonical PnL: $0.54/$0.03/$0.51)
                  - npm run census-report (canonical venue verdict — DIVERGED, univ-only out_of_graph blindness, recorded per rule 16)
                  - active-pools.json membership greps (per-leg in_graph)
                  - WebSearch (STBT/Matrixdock identity + permissioning; router/venue addresses returned nothing public)
                  - events JSONL grep (our 21 events at the block, zero leg overlap)
evidence_order:   1. tx+receipt (route shape) 2. tx-profit (size) 3. symbol()+WebSearch (STBT = KYC RWA) 4. same-block logs (standing vs backrun) 5. per-leg graph membership 6. 24h venue logs (class frequency) 7. census reconcile (divergence found)
analysis_frame:   - atomic-vs-backrun decided by same-block prior movers on ALL legs, not by tx shape alone
                  - who HOLDS the permissioned token mid-route (coffee never does ⇒ access lives in the router/venue, F-009 3-point leg test applies)
                  - class value = venue-frequency × per-take profit measured over a day of logs, BEFORE any close-the-gap work
                  - census verdict is univ-lineage-scoped — curve/exotic venue gaps need the hand receipt-walk (until the tool is extended)
sanity_checks:    - USDC/DAI/WETH amounts followed leg-by-leg to confirm the loop closes (in 0.040283 vs out 0.040598, profit matches Withdrawal 0.000314)
                  - metapool activity attributed by router topic, not assumed to be coffee-only
                  - in_graph checked for all four legs separately (2 in / 2 out), not just the missing ones
                  - census divergence root-caused to detection scope before calling the tool wrong
tool_gap:         census-report out_of_graph detection is univ2/3/4-only — curve-metapool / exotic-venue route gaps produce a false route_gap_decisive=false; recorded as an extension of the existing filed defect.
codify_next:      tooling_defect LearningCase tooldef-20260706-census-single-tx-ingraph-detail — EXTENDED (open) with the univ-only out_of_graph divergence (0xf698e6c2); fix = count curve/balancer/fluid/exotic lineages in distinct_out_of_graph, or at minimum emit unclassified-venue addresses.
distill_for_opus: For a permissioned-asset (RWA) competitor loop: first ask who holds the token at each hop — if only whitelisted intermediaries ever hold it, replicability = F-009 3-point test on the ROUTER, not on the pool. And always price the CLASS (a day of venue logs: here 2 trades/$1 total) before considering adapter work; a closable-looking venue gap at $1/day is a deliberate non-close, logged so it never re-opens.
