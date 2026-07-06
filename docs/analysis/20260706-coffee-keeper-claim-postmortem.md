# 2026-07-06 — coffee 0xcfacdd69 postmortem: Curve FeeCollector keeper claim — not an arbitrage at all

Scope note: authorized defensive on-chain arbitrage research; reads public chain data + our own
run telemetry; broadcast stays human-gated (CLAUDE.md Safety Rule 1).

Question (operator): tx `0xcfacdd6946475c0cbd384104c6a0f1e3d75d16b6c0497e3a4fbf98ec4831348a` —
did our live see it, why did we lose?

## Verdict

**Category error to treat it as a lost arb: this is Curve protocol-fee keeper work, not an
arbitrage.** coffee called Curve's official FeeCollector (`withdraw_many` → `collect`), which
swept $28.95 of accrued admin fees, forwarded **$28.70 to Curve's CoWSwapBurner**
(`0xc0fc3ddf…`) and paid coffee the **$0.25 caller incentive**, which coffee converted to native
ETH via one Fluid DEX swap. Net to coffee **$0.22** (tx-profit). There was no victim, no
dislocation, no route — nothing for our searcher (or any arb searcher) to see. The whole
keeper-bounty market on this contract paid **~$17 over 24h split across ≥5 competing bots**
(coffee's share: 8 calls, $2.02) — dust-tier keeper work, rationally outside our strategy
surface. `winner_style` = **keeper_claim**, third confirmed non-comparable class after
`one_leg_inventory` and `rfq_fill` (F-010).

## Facts (tool-cited)

1. **Tx** (local reth via SSM): coffeebabe EOA → contract `0xe08d97e1…d015`, block 25472884
   idx 66, prio ≈0.14 gwei, gasUsed 363,492.
2. **Calls decoded** (calldata + openchain.xyz selector DB): `0xa2bc…cce00.withdraw_many([
   0x383e…8559, 0x5f6c…da94, 0x0295…4d72])` then `collect([USDC], coffee)`, then Fluid DEX
   `swap()` (`0x1f18b371`) USDC→WETH + WETH `Withdrawal` (native profit-take, matches the
   known coffee pattern).
3. **Contract identity** (WebSearch → Curve docs + Etherscan label): `0xa2bc…cce00` = Curve
   FeeCollector (fee_receiver of the pool factory, DAO-controlled); `collect()` forwards to the
   CoWSwapBurner and pays a caller fee. Sources: docs.curve.finance/fees/FeeCollector/,
   etherscan label "Curve.fi: Fee Receiver".
4. **Flows** (receipt logs, local reth): in — PYUSD 7.091202 + USDC 28.231450 from Curve pool
   `0x383e…8559` (in OUR graph, adapter=curve), USDe 0.340812 + USDC 0.716489 from
   `0x0295…4d72`; out — USDC 28.696092 → `0xc0fc3ddf…` (burner), USDC 0.251847 → coffee.
   USDC conserved exactly (28.947939 in = out); PYUSD/USDe stay in the collector awaiting
   their own burn.
5. **Economics** (`npm run tx-profit`, canonical): realized $0.24, builder $0.02, **net $0.22**.
   Correct, not an artifact — the $28.70 belongs to Curve's burner, not the caller.
6. **Bounty market** (local reth `eth_getLogs`, USDC transfers FROM the FeeCollector, 24h
   window): 60 transfers; $18,547 total to the burner; caller bounties ≈$17.1 split:
   `0x2145…5928` 11×/$10.53, `0xcb39…f156` 4×/$3.87, coffee 8×/$2.02, `0x6818…22c0` 3×/$0.65,
   `0x809c…f99a` 1×/$0.03 — an existing multi-bot keeper race.
7. **Our live** (events JSONL, run `5abbb905`): 12 events at target 25472884, drops all on
   unrelated victims — correctly nothing here for a backrun/arb pipeline.
8. **Canonical reconcile** (`npm run census-report`, same block): matched=1, qualifying=0,
   `route_gap_decisive=false`, `distinct_out_of_graph`=0 (univ2/3/4) — agrees no pool/route
   gap; `net_realized_usd=0` is the already-filed census single-tx display defect
   (`tooldef-20260706-census-single-tx-ingraph-detail`), no new filing.

## Why we "lost" — classification

Not pool gap / path gap / latency / admission — **not an arb**. Chasing it would mean entering
the keeper-bounty business against ≥5 incumbents for ~$0.25/call minus gas. Zero code action.

## Method Trace
task_class:       bundle_postmortem
tools_used:       - SSM + local reth (zero-CU): eth_getTransactionByHash/Receipt, eth_getLogs (FeeCollector 24h USDC outflows)
                  - calldata decode + openchain.xyz selector lookup (withdraw_many/collect/swap)
                  - WebSearch (Curve FeeCollector identity via docs.curve.finance + etherscan label)
                  - npm run tx-profit (canonical PnL: $0.24/$0.02/$0.22)
                  - events JSONL grep (block 25472884 + all involved addresses)
                  - npm run census-report (canonical venue/in_graph reconcile, agrees)
evidence_order:   1. tx + receipt (what is it) 2. full log amounts (flow conservation: USDC in==out, bulk to a fixed sink + small caller cut ⇒ claim-shape, not arb-shape) 3. selector DB (withdraw_many/collect) 4. WebSearch identity (Curve FeeCollector) 5. 24h outflow history (bounty market size) 6. tx-profit 7. our events 8. census reconcile
analysis_frame:   - flow-shape FIRST: exact conservation into a fixed treasury + tiny caller payment ⇒ keeper claim, stop arb-gap analysis
                  - winner_style non-comparability check before gap classification (one_leg_inventory / rfq_fill precedents)
                  - size the WHOLE bounty market (24h logs), not the single tx, before judging if the class is worth entering
                  - realized$ of the caller is the real prize; the treasury flow is NOT competitor profit
sanity_checks:    - USDC conservation checked to 6 decimals (28.947939 = 28.696092 + 0.251847) before naming 0xc0fc a sink
                  - "treasury" hypothesis cross-confirmed by 30 recurring transfers/24h to the same address + Curve docs naming the CoWSwapBurner
                  - tx-profit $0.24 vs hand flow $0.25 bounty agrees (gas/eth-px convention)
                  - our-events zero-hit verified for all 4 involved addresses, not just the pool
tool_gap:         same census-report single-competitor-tx display gap as F-010 (net_realized_usd=0/qualifying=0 hides the computed per-tx detail) — already filed as tooldef-20260706-census-single-tx-ingraph-detail, recurrence noted, no new defect.
codify_next:      tooling_defect LearningCase tooldef-20260706-census-single-tx-ingraph-detail — already FILED (open) today; this tx is a second manifestation. When it is fixed, add keeper_claim to the winner_style enum (withdraw_many/collect + conserved-flow-to-fixed-sink heuristic).
distill_for_opus: Before running any lost-arb decision tree, check the winner's FLOW SHAPE: if value is conserved into a fixed sink with only a small cut to the caller, it is a keeper/claim bounty (fee collectors, liquidation pokes, harvest bots), not an arbitrage — classify keeper_claim, size the whole bounty market from a day of logs (here ~$17/day across ≥5 bots), and spend zero route/coverage budget. Selector DB + protocol docs turn an opaque "competitor win" into a named permissionless mechanism in two lookups.
