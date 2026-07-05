# Coffee EV unlock — protocol + credit legs (consolidated plan, 2026-07-05)

Scope: authorized defensive on-chain arbitrage research; fork/dry-run; broadcast + credit-live stay human
gates. Synthesis of three code-verified fable-agent landing plans (Thread 1 evidence / Thread 2 execution /
Thread 3 discovery) + the dual-blind backrun-not-found diagnosis. Orchestrator synthesis — sequencing +
decisions are mine.

## Why (the bottleneck, confirmed)

EV is the binding constraint. Two independent confirmations this session:
1. **MEV-Share flag = structural ceiling, NOT a code/latency bug** (dual-blind converged): 20/20 mev_sendBundle
   relay-rejected "backrun not found"; 19/20 referenced hints never land; 102ms/131ms fast submits still
   rejected ⇒ our plain-searcher posture isn't offered open backrun for that flow. Not fixable by
   targetBlock/latency (both proven inert). See `project-mevshare-submit-flag-lever` memory.
2. **Pure-DEX atomic loops are dust** (census 8400 blocks: 14 atomic_loop candidates, all $0.10–$0.58).

**Coffee's real EV is in legs we neither SEE nor ROUTE.** We are blind — in BOTH analysis and execution — to:
non-uni SWAP venues (Pancake-v3 `0x19b47279`, DODO `0xc2c0245e`), PROTOCOL legs (Liquity mint, ERC4626
wrap, PSM reverse), and Fluid CREDIT. `edge-kinds.ts:51` literally says *"Protocol-leg detection … is future
work."* → coffee tx-2 (Liquity BOLD mint) is mislabeled `["flash","swap"]`, its mint EV invisible.

## Cross-cutting corrections the agents surfaced (code-verified — change the framing)

- **PSM is ALREADY routed** (`venues/capability.ts:86-92`, forward USDC→DAI). Don't rebuild it — add the
  REVERSE (buyGem, DAI→USDC) + make the quote fee-aware (`tin`/`tout`; today `quotePSM` assumes 0 fee).
- **wstETH wrap/unwrap ActionAdapters ALREADY EXIST + are registered** (`adapters/wrap.ts`) — only graph +
  quote + builder wiring remains. Cheapest execution win.
- **The blindness is BROADER than protocol** — whole swap venues (Pancake/DODO) + 10 unresolved topics
  (tx-7 fully unknown, plausibly Fluid DEX) are missed. Fixing classification helps swap coverage too.
- **census tx_shape is broken at scale** — `sameBlockSwapLogs` is never populated in `census-report.ts` main(),
  so every live-scanned tx classifies `"unknown"`. Isolating atomic txs at scale needs this fixed first.
- **Planner needs ZERO change** — DFS is edge-kind-agnostic, slot order isn't enforced ⇒ existing
  `FLASH_LEND_SWAP_REPAY` already admits flash→credit→protocol→swap→repay once protocol edges are in the graph.
- **Liquity BOLD mint = DEFER** — its exemplar (0x803a3693) netted $0.33 and its DEX loop is fee-negative;
  keep as the analysis protocol-leg exemplar, route only if a real-EV mint exemplar appears.
- **Primary EV metric = `builder_payment_usd`** (priority tip + coinbase transfer, pin-tested), NOT
  `realized_profit_usd` (a valuation artifact that can't price BOLD/sUSDS/wstUSR).
- **CR-5 (Fluid quote determinism) must NOT gate the deterministic legs** — the fluid grid already extracts
  870.99 wstUSR (AC-3); ship protocol legs first, upgrade Fluid sizing later via a resolver eth_call.

## The unified plan — one classification foundation, then two parallel tracks

Three agents independently converged on the SAME first slice: land protocol/venue CLASSIFICATION (the declared
`edge-kinds.ts` "future work"). It is offline, zero-node, closes the gap, and unblocks all analysis AND is the
evidence foundation. Do it first.

### PHASE 0 — Classification unblock (offline, zero-node, HIGH priority)  [= Thread1-S2 ≡ Thread3-Slice1]
Extend `analysis/src/registry/protocols.ts` TOPICS + `analysis/src/learning/edge-kinds.ts`:
- protocol topics: Liquity `TroveOperation`/`TroveUpdated`/`BatchUpdated` (hashes verified by both agents),
  ERC4626 Deposit/Withdraw, Sky PSM BuyGem/SellGem, reuse WETH Deposit/Withdrawal as wrap/unwrap;
- missing SWAP topics: Pancake-v3 `0x19b47279`, DODO `0xc2c0245e`;
- missing CREDIT topic: Fluid `LogOperate`;
- add `deriveProtocolActionsFromLogs` (BOLD mint→"mint") + a generic mint/redeem heuristic (Transfer from/to 0x0);
- `STABLE_ORDER` → `[flash,swap,credit,lp,protocol]`; drop the `:51` future-work comment;
- fix the LearningCase hardcode `edge_kinds: arb_pools>0?["swap"]:[]` (`test/learning-case.ts:210`) to use the derivation;
- populate `sameBlockSwapLogs` in `census-report.ts` main() so tx_shape classifies at scale.
- **Gate (rule-12 flip):** tx-2 `["flash","swap"]`→`["flash","swap","protocol"]` + action `["mint"]`; tx-4 swap
  observations include pancake+dodo; no silent `[]` for action-bearing logs (tx-7). `npm run test:learning-case`.

### TRACK A — EXECUTION (Thread 2, deterministic-local legs; node only at fork-sim)
- **A0 taxonomy:** widen `slotKind` with `"protocol"` + `protocolAction?` on TokenEdge/PoolEntry; extend
  `deriveEdgeTaxonomy` with the leavesStandingPosition table (mint=true→S2-guarded; wrap/convert/redeem=false);
  reclassify the existing PSM entry to protocol/convert (behavior-neutral). Gate: `searcher:taxonomy` + planner byte-identical. **offline.**
- **A1 PSM reverse + fee-aware quote + protocol template slot** — flip fixture (DAI→USDC absent→0 / present→≥1), modeled on the `credit-f88b` pair. **offline.**
- **A2 PSM buyGem build** (`adapters/psm.ts` reverse encode). Gate: anvil fork round-trip sim. **node.**
- **A3/A4 ERC4626 (sUSDS, wstUSR)** route+quote (`previewDeposit`/`previewRedeem`, local math later) + build (`adapters/erc4626.ts`). **node at sim.**
- **A5 wstETH wiring** (adapters exist) — graph+quote+builder only. **node at sim.**
- **A6 live-enable** `SEARCHER_ENABLE_PROTOCOL_EDGES` (default 0→1) + `valueInEth` USDS; one dry-run window (operator). **operator window.**

### TRACK B — DISCOVERY scanner (Thread 3; extensible to all bots/chains)
- **B1** = PHASE 0 (shared).
- **B2 evidence extractor + `venue-discovery-scan` CLI** (log-only mode, offline). Gate: coffee fixture emits the Liquity venue candidate, not WETH/uni/bot. **offline.**
- **B3 trace enrichment** (callTracer `withLog:true` → (contract,selector,topic) triples; resolves wstETH/zapper/tx-7). **node once, then offline.**
- **B4 venue-registry** (`listener/src/searcher/venue-registry.ts` + `searcher/pools/venue-registry.json`; forward-only status candidate→approved→routable, human gate) + LearningCase `adapter_missing` link.
- **B5/B6** registry feeds the analysis classifier + `extractTouchedVenues` (census/postmortem see protocol venues) + the routing graph (behind the status gate).
- Interface: Track B DISCOVERS+CLASSIFIES+REGISTERS; Track A CONSUMES the registry to quote/build. Coupling = `quote.adapterId` + the status machine.

### DEFERRED (don't let these gate the above)
- **CR-5 Fluid sizing** (resolver eth_call `getVaultEntireData` → deterministic maxBorrow) — after operator archive access; the grid keeps routing meanwhile.
- **Aave/Morpho credit** edges — standing-position, `/opt/MEV/.credit-live` human gate.
- **Liquity BOLD mint** routing — analysis-only until a +EV exemplar exists.

## Priority (evidence-ordered, to be validated by Thread1-S4 builder_payment attribution)
1. PHASE 0 classification (unblocks everything, offline).
2. wstETH wiring + PSM-reverse (cheapest execution EV, deterministic, adapters partly exist).
3. ERC4626 (sUSDS/wstUSR — on the reference-arb token set).
4. Discovery scanner (Pancake/DODO/tx-7 venue + protocol venues at scale).
5. CR-5 / Aave / Liquity — deferred/gated.

## Node / human gates
- Offline (zero-node): PHASE 0, A0, A1, B2, all gates on recorded fixtures.
- Operator node: fork-sim slices (A2/A3/A5), trace fetch (B3), the A6 dry-run window; `cast`-verify all new addresses before landing (don't trust memory).
- Human gate: A6 live-enable flip, credit-live (Aave), any broadcast.

## The immediate next move
PHASE 0 (classification) — offline, zero-node, zero-risk, closes the declared gap, and makes every downstream
slice measurable. Then wstETH+PSM-reverse execution. Everything else sequences off those.
