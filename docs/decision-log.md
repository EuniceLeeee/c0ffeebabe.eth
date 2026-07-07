# Decision Log — dated decisions & findings (may go stale)

> The committed sink for the dated conclusions CLAUDE.md used to inline. Scope: authorized defensive
> on-chain arbitrage research (fork/dry-run; broadcast is a human gate).
>
> Rules:
> - Each entry has a date + status: ✅ in effect / ⏳ to-verify / ~~❌ retired~~ (strike, don't delete —
>   prevents circling back to a dead path).
> - Conclusions bind the code/data state when written. Stale → update the status, don't erase.
> - Before re-opening a settled question, scan the ✅ and ❌ entries here first.
> - Cross-session operating facts also live in user memory (`MEMORY.md`); this file is the *committed*
>   copy Codex and fresh sessions can read. Link memory slugs as `[[slug]]`.

---

## Decisions

### D-001 | 2026-07-05 | ✅ | Flip the MEV-Share submit flag (falsification of the flow-admission lever)
- **Decision:** `SEARCHER_SUBMIT_HASHONLY_MEVSHARE=1` on the bounded-live node for a measured window.
- **Why:** the 2026-07-05 dual-blind arch review found 95.3% of 3,889 +EV sims (incl. the biggest
  $50–$210) self-drop at `submit_gate/hash_only_unmatchable` because this one flag is unset — the drain
  (`submitMevShareBundle`) is already built. THE production lever, not an epic. [[project-mevshare-submit-flag-lever]]
- **Envelope intact:** wallet ≤0.2 ETH, `EV_GATE=1`; `mev_sendBundle` is conditioned on the referenced
  hash landing ⇒ no phantom-loss path ([[project-mevshare-flow-discarded]]). Broadcast-behavior change ⇒
  required explicit user authorization (Safety Rule 1) — **granted 2026-07-05**.
- **Measured result (run_id `0bf0319a`, ~20 min, PID 187254) — the falsification came back "WRONG-ish":**
  - ✅ Mechanical: `hash_only_unmatchable` drops 95.3% → 0 (submit-gate wall gone); the `submitMevShareBundle`
    drain is live — `bundle_submitted` 0 → 7, all `mode:mev_sendBundle` → `flashbots-mev-share`.
  - ❌ **Inclusion: ZERO. All 7 rejected by the relay with `{"code":-32000,"message":"backrun not found"}`
    (`accepted:0`; 14 rejections this run).** The flag just RELOCATES the drop — our self-gate
    `hash_only_unmatchable` → the relay's `backrun not found`. No bundle reaches a builder.
  - The 7 sims were small (`simulated_profit_eth` 0.0001–0.0018 ETH, ~$0.4–$6), NOT the arch review's
    $50–$210 — those didn't recur in 20 min (thin window). But they'd hit the SAME rejection anyway.
- **Cause (diagnosed, F-006):** MEV-Share SSE IS connected (banner "MEV-Share SSE connected"; no custom
  `SEARCHER_MEVSHARE_SSE_URL` ⇒ real Flashbots default) and the hints are genuine, so "backrun not found"
  is DOWNSTREAM of a valid feed ⇒ the referenced hint is stale/unmatchable by submit time (timing/one-shot,
  or target-block mismatch). NOT a wrong-source and NOT the submit gate. **The next real lever past the
  gate = mev_sendBundle reference validity (latency / target-block), not economics and not flow-admission.**
- **Disposition:** flag stays ON (harmless — a rejected `mev_sendBundle` never broadcasts, envelope intact,
  no loss; it's the falsification window). It's a diagnostic win, not an inclusion win. Revert path unchanged
  (`rm /opt/MEV/.deploy-live`). Refines the arch review verdict `arch-review-20260705-verdict.md`.

### D-002 | 2026-07-03 | ✅ | Auto-deploy IS in the §6b auto-close chain (do not re-litigate)
- **Decision:** the postmortem → auto-close → deploy chain may auto-deploy via `deploy-node.sh`.
- **Why:** the ~1-min restart gap is acceptable; events JSONL gets a new `run_id` per restart, so analysis
  is naturally segmented (analyze across the boundary). The live/dry guard lives in `deploy-node.sh`, so a
  cron trigger passes the SAME safety envelope as a human one.
- **Requirements (mandatory, not human-gating):** (1) mode-preservation verify after deploy (alert on a
  silent bounded-live→dry-run flip); (2) debounce/batch — the real cost is warm-pool cold-start, deploy at
  most once/window, never once-per-loss. [[feedback-auto-deploy-in-loop-approved]]

### D-003 | 2026-07-03 | ✅ | Bounded-live envelope authorized
- **Decision:** the searcher may broadcast autonomously ONLY inside the script-enforced envelope
  (`.deploy-live` marker + wallet ≤ `MEV_LIVE_MAX_WALLET_ETH` 0.2 ETH + `EV_GATE=1`). See Safety Rule 1.
- **Still hard human gates:** funding above the cap, raising the cap, real-funds key swap, any broadcast
  outside the envelope. [[project-bounded-live-active]] [[project-live-broadcast-authorized]]

### D-004 | 2026-07-04 | ✅ | MEV-Share (hash-only ingest) is always ON at intake
- **Decision:** `SEARCHER_ENABLE_HASH_ONLY=1` unconditionally in `deploy-node.sh` (was marker-gated).
- **Why:** MEV-Share is the primary flow (~72× mempool volume, ~90% of the built pipeline); R13–R21
  "coverage exhausted" was measured on ~1.4% of flow because this was off. Ingest+sim only — submission is
  separately gated (D-001). [[project-mevshare-flow-discarded]]

---

## Facts (verified project state)

### F-001 | 2026-07-05 | ✅ | Primary distance-to-production lever = flow-admission at the submit gate
- **Fact:** with MEV-Share intake ON, the dominant self-drop is `submit_gate/hash_only_unmatchable`
  (95.3% of drops, gated by the D-001 flag), not coverage/`no_candidate`. Runner-up = economics
  (`bribeAllAboveGas ⇒ computeBidEth = max(profit−gas,0) ⇒ net≈0`). [[project-mevshare-submit-flag-lever]]
- **Evidence:** arch review `docs/research/reports/arch-review-20260705-verdict.md`; funnel `file:line` in
  `listener/src/searcher/main.ts` (submit gate `:222`/`:1868`; flag `:435`; EV gate `:1963`).

### F-002 | 2026-07-03 | ✅ | Native-ETH v4 pool gap `0xa32b646c` — CLOSED as a pool gap
- **Fact:** bundle `0xa32b646c…8b2f68` (block 25449741) lost `route_gap_decisive`; winner `0x28390df4…`
  backran the same triggering swap via WETH→CFG (v3 `0x08a10a8b…FCBF`) then CFG→WETH on a **native-ETH v4
  pool `0x267d01a3…9348cd9c`** (on-chain `Initialize`: currency0=`0x0`, currency1=CFG, fee=10001,
  tickSpacing=200, hooks=0x0). Our v3-only 3-hop detour saw ~43% of the value; winner's builder payment
  (~97% of its gross) alone exceeded our FULL sim gross ⇒ coverage, not bids.
- **Close:** commits `8acee06`/`b06717c`/`574d5e4` — reusable `v4-backfill-poolid` verb, force-include
  extended to v4 poolIds (was address-only), committed `force-include-poolids.json` survives deploy.
  Rule-12 flip `pool_in_routing_graph false→true, candidate_plans 0→1`. Native-ETH v4 execution is NOT a
  blocker (epic slice-2b-ii, `c817cc2`). [[project-buildernet-auction-loss-anatomy]] [[project-competitor-native-eth-profit]]

### F-003 | 2026-07-04 | ✅ | Atomic backrun = dust market ceiling *on public flow* (posture-qualified)
- **Fact:** coffeebabe (our exact class) captures dust on public flow (~$0.64/tx; the per-tx
  `realized_profit_usd` is a valuation artifact — builder-payment is the robust floor). For OUR posture the
  ~1/5h ceiling is a MARKET limit, not a capability limit. **Qualified:** this was measured on public
  mempool ≈ 1.4% of flow — the real question is MEV-Share (D-001/D-004), not more atomic-backrun coverage.
  [[project-atomic-backrun-market-ceiling]] [[project-coffeebabe-census-notseen-bridge]]

### F-004 | 2026-07-04 | ⏳ | Mempool router-allowlist is a flow-admission blind spot
- **Fact:** the filtered mempool admits `tx.to` in ~10–14 hardcoded routers OR a tracked pool
  (`main.ts:206`) → public swaps via custom routers are invisible pre-funnel (found: coffee's 1 public
  victim we missed, `to` `0x663dc15d`). Fixable searcher-side (admit by pool-touch), distinct from the
  economics gate. [[project-mempool-router-allowlist-blindspot]] [[project-mempool-filter-flow-admission-gap]]

### F-005 | 2026-07-04 | ✅ | topN=0 pool-universe bug + dominant `no_candidate` root cause
- **Fact:** `SEARCHER_POOL_UNIVERSE_TOP_N` default "0" + `?? Infinity` → `slice(0,0)` → the curated
  active-pools universe never loads → runtime graph misses return venues. Verify `universe=N` in the
  startup banner after every deploy. The dominant see→bundle blocker had been `no_candidate_plans` (94% =
  `only_immediate_same_pool_reverse`, a token-graph return-venue coverage gap). [[project-pool-universe-topn-zero-bug]] [[project-nocandidate-return-venue-gap]]

---

### F-006 | 2026-07-05 | ✅ | MEV-Share `mev_sendBundle` 100% relay-rejected "backrun not found" = a POSTURE gate (not timing)
- **Fact:** with D-001's flag ON, 100% of `mev_sendBundle` submissions to `flashbots-mev-share` return
  `http=200 {"code":-32000,"message":"backrun not found"}` → `accepted:false`. The submit path works; the
  relay won't match the referenced hint. Log: `/var/log/mev-live.log` (`[submitter] flashbots-mev-share
  http=200 …backrun not found`).
- **Implication:** the arch review's "flag ON ⇒ inclusion via submitMevShareBundle" was over-optimistic —
  the flag is necessary but NOT sufficient. [[project-mevshare-submit-flag-lever]]
- **CAUSE — corrected 2026-07-05 (dual-blind: fable diagnosis agent + a concurrent orchestrator, converged;
  supersedes my first "timing/target-block" read):** the reject is **STRUCTURAL / POSTURE, not timing and
  not a code bug.** Ruled out mechanically: target-block is NOT drifting (`main.ts:1988` target=latest+1;
  0/12 submit-block > hint-block); the `{hash}` reference is spec-correct (http=200 *semantic* error, not
  parse/400); and **latency is inert — 102ms and 131ms hint→submit BOTH still got "backrun not found"** (a
  race would let a 100ms submit win). Decisive: **19/20 referenced victim txs NEVER land on-chain** (local
  reth NOTFOUND; phantom), 1/20 mined ~10min *before* the hint (the only genuine stale-timing case). ⇒ the
  relay does not hold these as backrun-matchable pending orders at reference time; our plain-searcher posture
  (reconstruct-from-SSE-logs → `mev_sendBundle{hash}`) is **not offered open backrun for this flow.**
  Corroborates [[project-phantom-victim-flow-admission-epic]] (~82% phantom) + [[project-atomic-backrun-market-ceiling]].
- **Fix direction:** NOT latency / targetBlock / maxBlock (all proven inert). Real capture = a posture /
  eligible-orderflow relationship = **STRATEGY / human gate**, not a code edit. Near-term inclusion instead
  via mempool (has landed before) or protocol/credit-leg coverage to raise +EV opportunity density. Options
  on the flag itself (operator's call): revert to 0 (0/20 convert — stop wasting submit+EV-gate cycles), or
  keep (harmless; a rejected `mev_sendBundle` never broadcasts).

### F-007 | 2026-07-06 | ✅ | Two distinct protocol classes: DEX-NAV = dust; CREDIT (Fluid/Morpho) = episodic $100s, credit-live-gated
> **CORRECTED 2026-07-06 (operator caught the overreach with `0xf88b`).** The first draft said "protocol
> block-scan is dust-bounded" — WRONG generalization. It measured only the credit-EXCLUDED DEX-NAV subset in a
> QUIET (peg) window. Two classes must be kept separate:
- **Class 1 — DEX-NAV protocol (what BS-1c scans): smoke-test-dust, but UNMEASURED — NOT "don't build".**
  Shipped **BS-1c** (`0a1984c`, scanner detects+prices non-standing `slotKind:"protocol"` edges) +
  **`searcher:blockscan-hunt`** (`f48c371`). Fork-solved over the LIVE graph at 4 recent blocks AND at the
  `0xf88b` depeg block (24710788, archive fork): **ZERO +EV protocol ring, only sub-dollar pure-DEX dust**
  (best ~$0.50 even AT the depeg block). Of 11 protocol entries only wstETH/sUSDS have a DEX share-venue, both
  NAV-pegged/par.
  > **SAMPLE-SIZE CORRECTION (2026-07-06, operator caught it):** 4 recent + 1 depeg = a **~5-block smoke
  > test** — this proves BS-1c WORKS but does NOT measure the class's EV. Concluding "DEX-NAV = dust, don't
  > build" from 5 blocks is the **starved-sample true-negative trap** (project rule: never conclude a
  > true-negative from a starved sample; size OUTCOME-DRIVEN). Dislocations are EPISODIC. **Verdict downgraded
  > to UNMEASURED/not-yet-decidable.** To decide DEX-NAV: run `blockscan-hunt` over an outcome-driven window
  > (hours, ideally event-targeted across multiple depeg/volatility blocks + more of the 11 entries' share
  > venues), not 5 consecutive quiet blocks. Only the CREDIT class (Class 2) is evidence-backed so far.
- **Class 2 — CREDIT (Fluid/Morpho): episodic $100–500, NOT dust.** `0xf88b498b…` (block 24710788, from =
  coffeebabe) nets **~273 wstUSR + 0.078 WETH (~$100–500)** during a wstUSR **market depeg**, via
  `flash→Fluid borrow→swap→repay` (a BACKRUN). It routes through wstUSR+sUSDS+PSM+Fluid+curve+v4 in ONE atomic
  loop. **This is credit-ESSENTIAL** (the profit rides Fluid leverage + the market dislocation), so the BS-1c
  scanner CANNOT see it (it excludes credit/standing edges by design, `blockscan-scanner.ts:247`) — which is
  why even the depeg-block hunt found only DEX dust. The vault NAV (`previewRedeem`) is stable across the
  depeg; the dislocation is in the leveraged market position, not the DEX pools.
- **Capability EXISTS; the gate is POSTURE.** `test/WstUSRArb.t.sol` (AC-3, landed) reconstructs the ~273
  wstUSR profit on a fork. The Fluid credit edge is grandfathered live in the backrun graph (D4) and the solver
  sizes it (`fluidDebtBps` search, `solver.ts:96-187`). So capturing the `0xf88b` class is largely a
  **`.credit-live` human-gate + depeg-timing** problem, NOT a capability gap. CR-5 (deterministic Fluid quote)
  is an auction-precision upgrade over the grid search, not a blocker.
- **Corrected implication:** the needle-mover is STILL a **posture decision**, but the reward is REAL
  ($100–500/depeg), not dust — which makes the `.credit-live` decision MORE worth taking to the operator, not
  less. Capture-path order: (1) `.credit-live` posture [human] → (2) backrun already routes+sizes the Fluid
  loop, so it captures the proven exemplar first; (3) CR-5 for auction precision; (4) **BS-3 with credit
  UN-EXCLUDED** (relax `blockscan-scanner.ts:247` + wire `fluidDebtBps` sizing into block-scan) to catch the
  standing depeg dislocation proactively every block instead of waiting for a victim swap. BS-3-as-built
  (credit-excluded) only ever sees dust — that was a scanner SCOPE limit, not a market fact.
  tooling_defect (return-path check) stands.
  Full record: `docs/analysis/20260706-protocol-edge-return-venue-gap.md`.
  > **CLASSIFICATION CORRECTION (2026-07-06, operator + event-level verify): `0x9be73297` is PROTOCOL, NOT
  > credit.** Its 4 Morpho Blue events decode to `Supply` + `Withdraw` + 2×`AccrueInterest` (topic0s verified
  > by keccak) — the MetaMorpho VAULT's own internal supply/withdraw when we deposit/redeem steakUSDC/USDT.
  > **ZERO Borrow / Repay / SupplyCollateral** = we took no credit position. So the steakUSDC+steakUSDT
  > ($2.23) and waEthUSDC ($2.44) txs are **ERC4626-vault PROTOCOL arbs, not credit** (the earlier "vault
  > loops close via Morpho CREDIT ~$1" was a mis-read of the vault's internal Supply as our borrow).
  > TWO consequences: (a) these are **>$1 PROTOCOL txs** — direct evidence the DEX-NAV/protocol class is NOT
  > uniformly dust (reinforces the Class-1 sample-size downgrade above); (b) the ONLY remaining credit
  > exemplar is `0xf88b498b…970` (Fluid), and it too must be event-verified for a real `Fluid borrow` before
  > "credit = $100–500" is trusted (Fluid vaults ARE borrow-based + AC-3 reconstructs a leveraged position,
  > so it is likely genuine — but verify, don't inherit the Morpho error).
  [[project-track-a-b-protocol-edges]] [[project-atomic-backrun-market-ceiling]]

### F-008 | 2026-07-06 | ✅ | Our block-scan scanner CANNOT reach coffee's protocol arbs (verified at the exact arb block)
- **Setup:** BS-lane Pass A/B1/B1b landed the live block-scan lane (log-only, isolated stack, full-warm) and
  **B1b** (`1d0c724`) wired live `protocolMids` so the scanner can price protocol edges. To avoid concluding
  from a starved/protocol-blind window, ran the `protocolMids`-enabled `blockscan-hunt` at **block 24568129 —
  the EXACT block of `0x9be73297`** (coffee's steakUSDC/steakUSDT PROTOCOL arb, $2.23, archive fork).
- **Result (decisive):** 24 opportunities, **ZERO protocol rings** (all `protocol=false`, pure-DEX dust, best
  net ~$0.0035). At the exact block where coffee netted $2.23 via a protocol/vault loop, **our scanner surfaces
  no protocol ring at all.**
- **Why (detection-MODEL gap, not a protocolMids gap):** (1) steakUSDC/steakUSDT/waEthUSDC vault shares have
  **no DEX venue** in our universe → no DEX-mid to spread against the vault NAV → our spread-cycle scanner
  cannot form the ring. (2) coffee's mechanism is a **multi-protocol COMPOSITION** (Balancer-flash → Morpho
  Blue supply/withdraw → MetaMorpho vault deposit/redeem → UniV3 swaps → WETH), NOT a DEX-mid-spread cycle —
  a different SHAPE our scanner does not model.
- **Net picture (after 3 corrections — this is the settled one):** protocol is NOT dust (coffee $2.23/$2.44 is
  real), BUT **our block-scan scanner structurally cannot reach coffee's protocol wins.** Its reachable protocol
  set = only vaults whose share has a DEX venue = **wstETH/sUSDS NAV rings**, and only when they dislocate
  (pegged/rare). Capturing coffee's steakUSDC-class protocol arbs needs a **composition-arb** detect+execute
  capability (model flash→Morpho→vault→swap), a much larger build than the spread-cycle scanner.
- **Implication:** a multi-hour live block-scan window will NOT surface coffee's protocol arbs — the lane is
  blind to that shape, not merely waiting for a dislocation. B1b + the live lane are correct + isolated + safe
  (log-only, zero loss); the limit is the detection model. [[project-track-a-b-protocol-edges]]
- **CORRECTED again (2026-07-06, full amount-trace of `0x9be73297`) — it IS a routable closed loop; the
  block is a STUBBED adapter, not a modeling limit.** Executor `0xe08d97` net = **+0.0016 WETH (~$2-3)**. Flow:
  Balancer flash 326,058.65 USDC → **Fluid DEX swap USDC→USDT (326,058.65→326,061.67, +0.9bp — THE profit
  leg)** → USDT →(steakUSDT deposit → Morpho Blue → steakUSDC redeem, ~1:1 par close)→ USDC → repay flash;
  surplus 3.02 USDC → 0.0016 WETH. The profit VENUE `0x52aa89` = **FluidLiquidityProxy (Fluid/Instadapp DEX)**.
  We HAVE a `fluid-dex-swap` adapter but it is a **STUB**: `fluid-dex.ts:52` `encode()` throws
  "not supported in v3.0: dexCallback has no bytes payload" (Fluid's `swapInWithCallback` 0xbe17c79c callback
  can't carry BotVM's inner script). **So `0x9be73297` is routable as legs (vindicates the leg-based D5
  design — the SAME buildTokenPaths routes it); the only block is the un-implemented Fluid DEX swap adapter.**
  FIX (scoped, no executor change): implement `fluidDexSwapAdapter` via the plain non-callback
  `swapIn(bool swap0to1,uint256 amountIn,uint256 amountOutMin,address to)` (approve+call, curve-pattern) +
  a FluidDexResolver quote + register the Fluid Dex USDC/USDT pool; VERIFY vs `0x9be73297`. This is the real,
  bounded "adapt an unknown/stubbed venue" work — a curve-sized adapter, not a new detection model. (F-008's
  earlier "needs a new composition model" was wrong.)
- **DONE + VERIFIED (2026-07-06, commit `1c4b947`):** `fluidDexSwapAdapter` implemented via plain
  `swapIn(bool,uint256,uint256,address)` (selector `0x2668dfaa`, approve+call, no executor change) +
  a FluidDexResolver/revert-estimate quote + plan-builder approve + `poolToken0/poolToken1` threaded
  through the quote plumbing + the Fluid DexT1 **USDC/USDT pool `0x667701e5`** registered as a swap edge.
  Gate `searcher:fluid-dex-verify` **reproduces `0x9be73297`'s swap exactly** (326,058.65 USDC →
  326,061.67 USDT, diff 4288 wei; block 24568129 archive fork-after-prev-tx); planner/replay/taxonomy/
  scanner/coordinator all additive-unchanged. Evaluator fix: Codex first picked the wrong Fluid pool
  (0xea734B6, off ~2bp); the real swapIn target `0x667701e5` was pinned from the callTracer trace.
  **The Fluid DEX leg now routes through the SAME buildTokenPaths as any swap — coffee's Fluid arb class
  is unblocked in the graph.** Not yet deployed to the node (a swap adapter is principal-safe + within the
  bounded-live envelope; the deploy is an operator restart).

### F-009 | 2026-07-06 | ✅ | `0x9be73297`'s vault middle leg = INVENTORY rebalance, NOT a replicable protocol/credit edge
- **Operator ruling (correct — corrects my overclaim):** do NOT read "funds pass through Morpho" as "add a
  Morpho steakUSDT→steakUSDC edge". A cross-vault return path is only a `protocol` leg if it proves 3 things:
  (1) externally callable with NO inventory, (2) a deterministic input→output leg, (3) does NOT depend on
  vault internal state / bot pre-holdings. Classify by trace/replay BEFORE writing any edge.
- **Classification (decided on-chain, block 24568128→24568129):** the "~1:1 USDT→USDC" middle leg is an
  **inventory rebalance through the operator's PRIVATE vault-wrapper contracts**, verdict
  **`inventory_or_internal_only_not_ours`**:
  - Profit-key numbers (operator's Q): bundler `0xb82809` (a private GenericVault w/ Manager+Controller, NOT
    public Morpho infra) minted **+293,404 steakUSDT** (held ~0 before, keeps it after); mediator `0x4825ef`
    **−291,368 steakUSDC** drawn from a **pre-existing 2,751,718 steakUSDC inventory** (~$2.9M), ending at
    2,460,350. NET position change, NOT atomic net-zero.
  - The share-count asymmetry (293,404 vs 291,368) = the two vaults' different NAV/price-per-share; part of
    the profit is embedded in a favorable cross-vault inventory rebalance, ON TOP of the Fluid swap +0.9bp.
  - Fails all 3 criteria: needs ~$2.9M steakUSDC inventory (not inventory-free), depends on vault internal
    state, requires pre-holdings. ⇒ it is an **inventory/posture play (credit-live-adjacent capital
    commitment), not our flash-arb path** — same class as [[project-cex-dex-inventory-competitor-noise]].
- **Consequence:** the Fluid DEX SWAP leg is real + done (F-008); coffee's SPECIFIC steakUSDC arb is NOT
  replicable as a leg. Open (worth checking, cheap): is there a permissionless ≤0.9bp-loss par USDT↔USDC
  return path (curve/PSM) that lets us capture the Fluid dislocation inventory-free? [[project-track-a-b-protocol-edges]]

### F-010 | 2026-07-06 | ✅ | `0x15352456` (coffee, blk 25472647) = private RFQ fill — non-comparable, structurally invisible
- **Operator Q:** did our live see this opportunity / why did we lose? **A: could not see it — both legs private.**
- **Mechanics (local reth + Alchemy secondary):** Balancer flash-loan 0.0526 WETH → fill a SIGNED off-chain
  order (target `0x0b7250…9188`, sel `0x69384be8`, 3 ECDSA sigs, deadline = block_ts+29s ⇒ live ~30s RFQ
  quote) at ~1771.6 USDT/WETH → buy back on in-graph univ3 WETH/USDT 0.01% `0xc7bbec…` at ~1761.3 → net
  **$0.49** (tx-profit: $0.54 realized − $0.05 builder) = coffee dust ceiling.
- **Visibility (events run 5abbb905, live):** 60 events at that target block, none touching the pool/pair;
  the in-block price-mover (idx 79 `0x8aa5812e…`) had prio=0 (builder-integrated private flow), 0 hits in
  our feeds. Pool in-graph (census `distinct_out_of_graph`=0) ⇒ NOT pool/path/latency/admission.
- **Ruling:** `winner_style: rfq_fill` joins `one_leg_inventory` as a **non-comparable winner class** —
  filter it in postmortems; spend zero route/latency budget on it. Only lever = orderflow relationships
  (F-006/D-001, human). Even BS-3 block-scan can't price a private maker quote (not an indexed venue).
  Tooling: `tooldef-20260706-census-single-tx-ingraph-detail` filed (census hides in-graph-only per-tx
  detail; no single-competitor-tx mode). Full trace: `docs/analysis/20260706-coffee-rfq-fill-postmortem.md`.
  [[project-cex-dex-inventory-competitor-noise]]

### F-011 | 2026-07-06 | ✅ | `0xcfacdd69` (coffee, blk 25472884) = Curve FeeCollector keeper claim — NOT an arbitrage
- **Operator Q:** did our live see it / why did we lose? **A: category error — nothing to see; it's keeper work.**
- **Mechanics (local reth + selector DB + Curve docs):** `withdraw_many([3 pools])` + `collect([USDC], coffee)`
  on Curve FeeCollector `0xa2bc…cce00` sweeps $28.95 accrued admin fees → **$28.70 to the CoWSwapBurner**
  (`0xc0fc3ddf…`), **$0.25 caller incentive to coffee** (net $0.22 tx-profit), converted via one Fluid swap.
  USDC conserved exactly; PYUSD/USDe remain in the collector.
- **Bounty market sized (24h of logs):** $18.5k/day swept to the burner; **~$17/day TOTAL caller bounties
  split across ≥5 competing keeper bots** (coffee 8×/$2.02). Not a strategy class for us at any effort.
- **Ruling:** `winner_style: keeper_claim` = third non-comparable class (after `one_leg_inventory`, F-010
  `rfq_fill`). Reflex: check the winner's FLOW SHAPE (value conserved into a fixed sink + small caller cut)
  BEFORE any gap analysis. Census single-tx display gap recurred (already filed
  `tooldef-20260706-census-single-tx-ingraph-detail`). Full trace:
  `docs/analysis/20260706-coffee-keeper-claim-postmortem.md`. [[project-cex-dex-inventory-competitor-noise]]

### F-012 | 2026-07-07 | ✅ | `0xf698e6c2` (coffee, blk 25476156) = STBT RWA atomic loop — venue gap DELIBERATELY not closed
- **What:** standing-dislocation 4-leg loop (no backrun): flash 0.0403 WETH → v3 DAI/WETH (in-graph) → 3pool
  add_liquidity → 3CRV (in-graph) → STBT/3CRV metapool `0x892d701d` (NOT in graph) → STBT→ETH at exotic venue
  `0x7d002303` (NOT in graph) → net **$0.51** (tx-profit). STBT = Matrixdock T-bill RWA, KYC-whitelisted,
  rebasing; **coffee never holds STBT** — the whitelisted router `0x45312ea0` does.
- **Why not close:** class measured at **~2 trades/$1 per DAY** (24h venue logs); replicability hinges on the
  router being permissionless = F-009 3-point leg test UNPROVEN; exit venue needs a new adapter for an
  unidentified ABI. Dust × access-unproven × adapter cost ⇒ log it, don't build. Re-open ONLY if the class
  frequency changes an order of magnitude or the router is proven open.
- **Tooling divergence (rule 16):** census-report said `route_gap_decisive=false` — its out_of_graph counts
  univ2/3/4 ONLY; curve/exotic venue gaps invisible → extended `tooldef-20260706-census-single-tx-ingraph-detail`.
  Full trace: `docs/analysis/20260707-coffee-stbt-rwa-loop-postmortem.md`.

### F-013 | 2026-07-07 | ✅ | `0xf391d0` (coffee, blk 25462190) = clean ATOMIC protocol arb — backrun-closeable behind ONE bounded adapter (srUSDe→sUSDe)
- **What (opposite of F-009):** verified ATOMIC via share net mint/burn — srUSDe net **−934.46 (pure burn)**,
  sUSDe net **0** (flows in and fully out), NO residual inventory in any helper. Reconciled with canonical
  `tx-profit.ts`: net **+$5.69** (WETH only), `unpricedDeltas:[]`. This is the positive case Agent B's
  atomicity classifier separates from `0x9be73297`'s inventory rebalance.
- **Loop:** Balancer flash USDC → UniV4 USDC/srUSDe `0xc069abea` → **srUSDe redeem → sUSDe** → UniV3
  sUSDe/USDT `0x7eb59` → UniV4 USDT/USDC `0x395f91b3` → surplus → UniV3 USDC/WETH → repay. All legs covered
  EXCEPT the srUSDe redeem + the sUSDe node + the `0xc069abea` pool surviving graph build.
- **Blocker 1 — the ONE real gap (bounded, replicable):** srUSDe (`0x3d7d6fdf`) is a **non-standard ERC4626**:
  `asset()`=USDe but redeem **pays sUSDe** via a silo (previewRedeem lies — says 958.15 USDe, actual pay
  773.99 sUSDe). Our generic `erc4626-redeem` models share→USDe with previewRedeem qty ⇒ wrong on BOTH token
  and amount ⇒ deliberately excluded (`token-graph.ts:147` `nonStandardRedeem:true`). Fix = a dedicated
  **srUSDe→sUSDe** redeem edge that quotes in sUSDe + register **sUSDe (`0x9d39a5de`)** as a graph node + let
  `0xc069abea` survive graph construction. srUSDe/sUSDe are permissionless (Ethena/Strata) ⇒ passes F-009's
  3-point replicability test ⇒ **verdict `protocol_cross_vault_replicable`** — this one justifies building the leg.
- **Blocker 2 — scanner still blind (F-008, structural):** even with the edge, this is a multi-hop composition
  (USDC→srUSDe→sUSDe→USDT→USDC), NOT a same-pair two-venue spread — the block-scan spread-cycle scanner cannot
  compose it (hunt @25462190: 16 opps, 0 srUSDe rings, `c069abea_v4pool_loaded:false`). The **backrun planner
  (`buildTokenPaths`) CAN** compose it once the edge exists. So protocol-leg-closes-a-loop-like-backrun is
  TRUE via the planner; the scanner limit is separate and known (F-008).
- **Next (bounded, gated):** build the srUSDe→sUSDe non-standard-redeem adapter + sUSDe node → then a planner
  fork-solve @25462190 must produce the loop (rule-12 replay flip), NOT just build-passing. Operator decision
  before building.
- **Design round 2026-07-07 (8-agent ground → dual-prior proposals → judge → red-team; full doc
  `docs/analysis/20260707-srusde-silo-redeem-edge-design.md`):** byte-exact quote =
  `sUSDe.previewWithdraw(srUSDe.previewRedeem(shares))` — diff **0** vs the receipt at execution state
  (callTracer: the silo itself staticcalls previewWithdraw; the earlier convertToShares hypothesis is the
  floor dual, 1 wei low). Execution = srUSDe's **multi-token exact-in `redeem(address,uint256,address,address)`
  = `0xfea53be1`** (live-verified via eth_call from a real holder; competitor used the exact-out twin
  `0xdfcd412e`; standard `0xba087652` is NOT the silo path). Two F-013 assumptions corrected by ground:
  sUSDe needs NO node registration (graph nodes are implicit from edge endpoints) and c069abea admission =
  a `pinned-warm-pools.json` entry (must include fixedTokenIn/fixedTokenOut or token-graph hard-throws →
  silently skipped). Verdict: **design_holds_with_amendments** — `erc4626-redeem-silo` descriptor
  (~8-line tokenOutArg extension) + registry `redeemTokenOut` field, fail-closed prune retained; 3 red-team
  amendments folded into the gate (evm_setNextBlockTimestamp pin for wei-exact receipt-diff — vaults accrue
  per-second; full pool-pin fields; negative emission asserts: srUSDe exactly ONE edge, flagged-without-payout
  vaults still ZERO).
- **BUILT + GATED 2026-07-07 (commit d2e73ba):** `erc4626-redeem-silo` descriptor (tokenOutArg extension) +
  `quoteSiloRedeem` (two-contract quote) + `redeemTokenOut` registry field + block-scan/hunt mid wiring +
  unit pins (protocol-legs, erc4626-quote two-call). Gate `searcher:blockscan-fork-solve-f391` @25462190
  **PASS 8/8**: real emission (srUSDe → exactly 1 silo edge, no deposit; flagged-without-payout → 0,
  fail-closed) + **silo quote diff=0** on the pre-competitor fork (timestamp-pinned — the sUSDe/srUSDe
  per-second vesting drift the red-team flagged was real: unpinned = +1.9e16) + planner composes the 4-leg
  ring through the silo leg. Silo edge is PROVEN. **Correction to Blocker 2 wording:** the design-round
  claim "c069abea admission = pinned-warm-pools entry" was necessary but NOT sufficient — see F-014.
- **F-013 verdict refined:** "backrun-closeable" is TRUE for the silo LEG (built + proven) but the FULL loop
  is **NOT yet reproducible +EV** — blocked on F-014 (a v4-quoter entry-leg gap), NOT the srUSDe edge.

### F-014 | 2026-07-07 | ⚠️ | V4Quoter reverts `NotEnoughLiquidity` for USDC→srUSDe on `0xc069abea` — entry-leg blocker for 0xf391d0's loop
- **What:** at 0xf391d0's execution state (fork post-txIndex-85, and the clean archive at blk 25462189), our
  V4Quoter (`0x52F0E24D…`) reverts `NotEnoughLiquidity(0xc069abea…)` (`0x6190b2b0`/`7a5ed734`) for
  **USDC→srUSDe at every size incl. 1 USDC**, while the **reverse** srUSDe→USDC quotes fine (1 srUSDe →
  1.0159 USDC) and the competitor's **real** swap filled **949.488853 USDC → 934.46 srUSDe** at that exact
  state. No JIT: the competitor tx has only a Swap on this pool (no ModifyLiquidity), slot0 tick = −276166
  and pool `liquidity` = 1.238e19 unchanged pre/post block. So the quoter's tick-traversal DIVERGES from the
  real core swap for this pool's (one-sided) liquidity — the same class as the known v4-quoting gaps
  ([[project-v4-swaphook-admission-gap]], [[project-univ4-coverage-frontier]]), here on a HOOKLESS pool.
- **Impact:** the srUSDe silo edge (F-013) is correct and composes the ring, but the loop's ENTRY leg can't be
  quoted/sized by our solver ⇒ no +EV solve ⇒ 0xf391d0 not yet capturable end-to-end. The f391 gate documents
  this as a deferred, separate block (still PASSes on the silo-edge flip).
- **CONFIRMED root cause = quoter-vs-core divergence (2026-07-07, decisive):** replaying the competitor's RAW
  signed tx86 on a post-tx85 fork returns **`status 1 (success)`, gasUsed 858188** — the whole atomic loop
  reproduces on our standalone fork. So core `Pool.swap` DOES fill USDC→srUSDe from that exact state; only the
  QuoterV2 (and our path calling it) can't price it. Rules out "encoding inverted" (real fill decoded genuine
  USDC→srUSDe, zeroForOne=false, via tx86 Transfer flows) and "genuine no-liquidity / non-reproducible"
  (status-1 replay). The loop is standalone-reproducible; our gap is QUOTING (sizing), not execution. Codex A's
  read-only sandbox could not certify this (outbound RPC denied — a tooling fact: on-chain diagnosis needs the
  evaluator's RPC, not a sandboxed Codex).
- **Next → F-016 (task #16):** a local v4 exact-in quote matching core `Pool.swap` (a PORT of the bit-exact
  v3-math tick walk, StateView-fed), wired into `quote()` with on-chain fallback + warmed via the cache. Now
  KNOWN to work (core fills). Sliced, Codex-generated, Claude-gated. Do NOT re-attribute to the srUSDe edge.

## Dead-ends / retired (high-value — don't circle back)

### ~~X-001 | R13–R21 | ❌ | "coverage exhausted → economics/posture is the only gate"~~
- **Why wrong:** measured on ~1.4% of flow (MEV-Share intake was OFF). The router-allowlist + MEV-Share
  intake gaps never ENTER the funnel, so `pipeline_dropped`/pool-coverage could never see them — a SHARED
  WRONG FRAME that dual-blind convergence masked as confirmation. Fix: the mandatory frame audit (rule 13
  arch-review trigger) + the hermes-gate intake-audit lens. [[project-mevshare-flow-discarded]]

### ~~X-002 | 2026-07-01 | ❌ | "coffeebabe is atomic, MEV-Share can't save us" from a single-pool probe~~
- **Why wrong:** concluded without tracing what the competitor backran. A root-cause is INVALID unless it
  names the specific source swap (or proves none) from a manual trace — now Hermes doctrine (Mechanics
  Step-1). 

### ~~X-003 | 2026-07-03 | ❌ | Interim re-classification of `0xa32b646c` as an execution-adapter epic~~
- **Why wrong:** off a corrupted code read (`rg -r` swallows a replacement arg — never `rg -rn`/`-rln`) +
  a stale memory. Re-verified from clean reads + on-chain data; the original pool-gap classification stood
  (F-002). Verify against CODE, not memory (rule 3). [[project-buildernet-auction-loss-anatomy]]

### ~~X-004 | multiple rounds | ❌ | "polishing the microscope" — analysis commits as progress~~
- **Why wrong:** safe verifiable analysis commits left searcher behavior unchanged (the 2026-07-01
  pattern). Fix: rule 12 `turn_class: observability-only` + rule 13 anti-drift cap (one such turn, then the
  next Brief MUST change behavior or escalate).
