# 2026-07-06 — coffee 0x15352456 postmortem: private RFQ fill, structurally invisible to our live lane

Scope note: authorized defensive on-chain arbitrage research; reads public chain data + our own
run telemetry; broadcast stays human-gated (CLAUDE.md Safety Rule 1).

Question (operator): tx `0x153524566a94f24094c1f083c0b9d98899787f8968943f0f6200230dc45e8e02` —
did our live searcher see the opportunity, and why did we lose it?

## Verdict

**We did not see it, and could not have: both legs of the edge were private flow.** Not a pool
gap (the only public venue touched is in our graph), not a path gap, not latency/admission.
`winner_style` = **rfq_fill** — a non-comparable winner class (same family as the CEX-DEX
one-leg-inventory finding): coffee's profit source is a **signed off-chain RFQ order** we never
receive, and the in-block price move it reacted to was **builder-integrated private flow**
(maxPriorityFee=0, never in mempool/MEV-Share). Net take was **$0.49 — dust**, consistent with
the coffee dust ceiling. No code fix follows; the only lever over this flow class is the
orderflow-relationship posture already recorded in F-006/D-001.

## Facts (each tied to the tool that produced it)

1. **Tx identity** (local reth `eth_getTransactionByHash` via SSM, node i-0ff908dedeec9ebc6):
   from `0xc0ffeebabe…29671` (coffeebabe EOA) → contract `0xe08d97e1…d015`, block 25472647
   (2026-07-06), index 96, effective gas price ≈0.111 gwei.
2. **Structure** (receipt logs, local reth; independently re-pulled from Alchemy as the
   secondary source): Balancer V2 vault flash-loan 0.052562 WETH → coffee sells the WETH via a
   signed-order settlement (WETH: coffee → `0x69355223…` → maker holder `0x166ed9f7…`; USDT
   93.116093: `0x166ed9f7…` → `0x0b7250…9188` → coffee) → buys 0.052900 WETH back on Uni v3
   WETH/USDT 0.01% `0xc7bbec68…` → repays the loan. Net +0.000338 WETH.
3. **Order privacy** (calldata decode): the RFQ call targets `0x0b7250…9188` (selector
   `0x69384be8`) carrying an order struct + **three ECDSA signatures** and deadline
   `0x6a4b77d0` = block timestamp + 29s → a live ~30s-TTL signed quote, not a resting public
   order. WebSearch on `0x0b7250…9188`, `0x69355223…`, and the selector returns nothing public —
   unidentified private settlement infra.
4. **Economics** (`npm run tx-profit`, canonical PnL): realized $0.54, builder payment $0.05,
   **net $0.49** (ethUsd 1756.94). Hand log-sum from the Alchemy receipt gives $0.59 gross —
   agrees within gas/builder accounting (tool-reconciled). Implied prices: maker paid ~1771.6
   USDT/WETH, v3 buy-back at ~1761.3 → the maker's quote sat ~0.58% above the pool; the pool
   itself was at market. **There was no public-venue-vs-public-venue dislocation to take.**
5. **Our live state** (events JSONL `/var/log/mev/events/searcher-live.jsonl`, run
   `5abbb905`, `SEARCHER_DRY_RUN=0`, EV gate on): 60 events at target_block 25472647 — 40
   `opportunity_seen` / 20 `pipeline_dropped` (8 no-profitable-quote, 6 plan_budget_exhausted,
   4 no_matching_graph_pool, 2 expired-before-solver), **none** touching `0xc7bbec…` or the
   WETH/USDT pair. The pool IS indexed (active-pools hit; 1,949 lifetime event mentions; we
   solve on it routinely at other blocks).
6. **Trigger flow** (local reth `eth_getLogs` on the pool, block 25472647): pool swaps at
   indices 79, 96 (coffee), 138, 236. The pre-coffee mover, index 79
   `0x8aa5812e…` (from `0x8d8d5b39…`, to `0xaa755689…`), has **maxPriorityFee = 0** →
   builder-integrated private flow; **0 hits** in our entire events file — our mempool and
   MEV-Share feeds never carried it.
7. **Canonical competitor tool** (`npm run census-report --watch coffeebabe --from/to 25472647`):
   matched 1, qualifying 0, `route_gap_decisive=false`, `distinct_out_of_graph` = 0 across
   univ2/3/4 — confirms no out-of-graph venue (agrees with the hand `eth_getLogs`/active-pools
   grep). Its `net_realized_usd=0` vs tx-profit's $0.54 is a **by-design filter, not stale
   math**: `census-report.ts:180` drops competitor txs whose venues are all in-graph, hiding the
   per-tx `winner_style` it already computed → tooling_defect filed (see below).

## Why we "lost" — classification

- Gap class: **none of pool/path/unanticipated** — the opportunity never existed in flow we can
  legally-of-visibility receive. It is **non-comparable private-orderflow** (rfq_fill).
- Even BS-3 block-scan (when live) would not catch it: block-scan prices dislocations between
  *indexed venues*; a 30s-TTL private maker quote is not an indexed venue.
- Bidding/latency analysis is moot: with the maker order in hand the arb was uncontested
  ($0.05 builder payment, index 96, 0.111 gwei).

## Actions taken

- tooling_defect LearningCase filed: `tooldef-20260706-census-single-tx-ingraph-detail`
  (census-report/bundle-postmortem lack a single-competitor-tx report mode; in-graph-only txs
  silently excluded, `net_realized_usd=0` ambiguous).
- decision-log: F-010 entry (rfq_fill = non-comparable winner class; do not spend
  route/latency work on this flow class).
- Memory: extended the non-comparable-competitor note with the rfq_fill class.

## Method Trace
task_class:       bundle_postmortem
tools_used:       - Skill bundle-postmortem (procedure frame)
                  - SSM + local reth (zero-CU): eth_getTransactionByHash/Receipt, eth_getLogs (pool swaps in block), eth_getBlockByNumber (index→hash)
                  - npm run bundle-postmortem (errored by design: competitor tx has no bundle_submitted — that error itself localized the question)
                  - npm run tx-profit (canonical PnL: $0.54/$0.05/$0.49)
                  - events JSONL greps: block 25472647 event/type/reason breakdown; pool + victim-hash presence
                  - npm run census-report --watch coffeebabe (canonical venue/in_graph + route_gap verdict)
                  - Alchemy $MAINNET_RPC_URL (secondary-source verify of the profit number)
                  - WebSearch x2 (settlement/maker contracts — no public identity)
evidence_order:   1. tx + receipt from local reth (what is it) 2. searcher env + .deploy-live (were we live) 3. tx-profit (how big) 4. events at that block (did we see anything) 5. pool in_graph (was it coverage) 6. in-block pool swap logs → trigger tx prio (was the trigger visible) 7. census-report reconcile 8. Alchemy secondary verify
analysis_frame:   - "did we see it" decomposed into: pool indexed? victim flow visible? edge between which two prices?
                  - identify the CHEAP SIDE of the arb first — if the mispriced side is not a public venue, no coverage/latency work applies
                  - winner_style non-comparability check (one_leg_inventory precedent) BEFORE gap classification
                  - order privacy read off calldata mechanics: signature count + deadline TTL (30s ⇒ live quote, not resting order)
                  - dust honesty: $0.49 net keeps this inside the measured coffee ceiling; not a needle-mover even if visible
sanity_checks:    - prio-fee of the trigger tx checked before calling it "missable" (prio=0 ⇒ private, not an admission drop)
                  - our events grepped for BOTH the pool and the trigger hash (0 hits each) before claiming invisibility
                  - census distinct_out_of_graph=0 cross-checked the hand active-pools grep
                  - tx-profit vs hand log-sum reconciled ($0.54 vs $0.59 gross — convention, not error)
                  - bundle-postmortem's near-miss list confirmed our submitted bundles that day were unrelated targets
tool_gap:         census-report computes winner_style/touchedVenues per competitor tx but drops the record when all venues are in-graph (census-report.ts:180) and emits ambiguous net_realized_usd=0; no canonical single-competitor-tx report entry point (bundle-postmortem requires our bundle_submitted).
codify_next:      tooling_defect LearningCase tooldef-20260706-census-single-tx-ingraph-detail — FILED (open): add --tx single-competitor-tx mode (or --include-in-graph) emitting the per-tx record; rename summary field to route_gap_profit_usd.
distill_for_opus: In a competitor postmortem, locate the cheap side of the winner's trade FIRST. If the cheap side is a signed off-chain order (multiple ECDSA sigs + a ~seconds deadline in calldata) the winner class is rfq_fill = non-comparable: no pool/path/latency work can capture it, and "did our live see it" is answered by flow visibility (trigger tx prio=0 ⇒ private), not by coverage. Spend the fix budget on flow classes we can receive.
