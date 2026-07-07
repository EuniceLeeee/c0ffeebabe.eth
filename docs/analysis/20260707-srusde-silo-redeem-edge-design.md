# 2026-07-07 — srUSDe silo-redeem edge design (F-013 follow-up): `erc4626-redeem-silo`, byte-exact quote, red-teamed

Scope note: authorized defensive on-chain arbitrage research; reads public chain data + our own
code/telemetry; broadcast stays human-gated (CLAUDE.md Safety Rule 1).

Question (operator): srUSDe is a non-standard ERC4626 — its redeem pays **sUSDe**, not `asset()`
(USDe) — and the F-013 loop (`0xf391d02add5e6cbbd98836d9eacdb66de3e5d76ef3874134145a6563a126ee86`,
block 25462190, net +$5.69) can only be composed once we adapt it. **How do we classify the edge
and the adapter?**

## Verdict

**One new mechanism-named protocol-leg descriptor `erc4626-redeem-silo` + a registry-declared
payout token (`redeemTokenOut`), fail-closed prune retained.** The edge is ONE directed
protocol edge srUSDe→sUSDe; the quote is the byte-exact two-call composition
`sUSDe.previewWithdraw(srUSDe.previewRedeem(shares))` (receipt diff **0** at execution state);
the encode is srUSDe's multi-token **exact-in** `redeem(address,uint256,address,address)` =
`0xfea53be1` (live-verified), NOT the standard `0xba087652`. Two F-013 assumptions were corrected
by ground (sUSDe needs no node registration; c069abea admission = a pinned-warm-pools entry, not
a graph fix). Adversarial red-team verdict: **design_holds_with_amendments** — 3 amendments, all
folded into the rule-12 gate. Decision-log: F-013 addendum (2026-07-07).

## Method (workflow shape)

8-agent workflow, three phases (Ground → Design → Verify), 189 tool calls:

1. **4 parallel ground readers**, each returning file:line-cited facts + explicit unknowns:
   descriptor system / graph+universe admission / quoter+encode wiring / on-chain quote math.
2. **2 design proposals with opposing priors**: A = vault-named dedicated leg
   (`srusde-silo-redeem`, exact-in 4-arg encode, force-include pin); B = mechanism-named
   descriptor (`erc4626-redeem-silo`, encode reused verbatim from standard `erc4626-redeem`,
   pinned-warm-pools pin).
3. **Judge merge** (chosen: `merged` — A's encode + fail-closed graph branch + gate harness;
   B's naming + pool pin + wei-exact gate criterion), then **adversarial red-team** (12 attacks:
   3 amendment_needed, 9 refuted).

## Ground: the on-chain mechanism (receipt + callTracer + live eth_call)

- **Receipt** (tx status 1, executor `0xe08d97e1…d015`): srUSDe burn 934,460889828731878592 raw;
  silo `0xdbf4fb6c31…` pays 773,988351883794733939 raw sUSDe via `transferFrom`; the ERC4626
  `Withdraw` event reports `assets` USDe-denominated (958.15) but **no USDe ever moves**.
- **Byte-exact quote formula**: `sUSDe.previewWithdraw(srUSDe.previewRedeem(shares))` evaluated
  at execution-timestamp state reproduces the actual payout with **diff 0**. Dispositive:
  `debug_traceTransaction` callTracer shows the silo impl itself STATICCALLs
  `sUSDe.previewWithdraw` (`0x0a28a477`) mid-tx returning exactly 773988351883794733939 — the
  quote IS the execution path's own math. The earlier F-013 hypothesis
  `convertToShares(previewRedeem(x))` is the **floor dual, 1 wei low** (773…938) — economically
  identical, rejected for byte-exactness.
- **Execution selector**: exact-in `redeem(address token, uint256 shares, address receiver,
  address owner)` = **`0xfea53be1`**, live-verified via `eth_call` from a real holder (UniV4
  PoolManager) at head block 25477300: returns exactly `previewWithdraw∘previewRedeem`
  (828242569995629500 for 1e18 shares). The competitor used the exact-out twin
  `withdraw(address,uint256,address,address)` = `0xdfcd412e` (verified perfect inverse). The
  standard `redeem(uint256,address,address)` `0xba087652` returns the USDe-denominated number —
  **NOT the silo path**.
- **No cooldown**: every cooldown-style getter (`cooldownDuration()`, `cooldownEnabled()`,
  `silo()`, …13 probed) reverts on srUSDe at 25462189; payout is immediate and atomic (burn
  log 5 + silo transferFrom log 7 in the same tx, no request/claim split).
- **Timestamp drift measured**: quoting at pure pre-state 25462189 (12s earlier) overstates by
  2,412,729,977,881 raw (~0.00003bp) = per-second vesting accrual in both vaults — head-block
  quoting is safe live (≪ the 1bp haircut), but wei-exactness holds only at identical timestamps
  (this drives red-team amendment 1).
- tool-reconciled: `tx-profit` (pnl/arb-profit.ts priceArb) agrees — net $5.66 vs F-013's $5.69
  (ethUsd snapshot drift), same block/shape; no divergence.

## Settled design (judge: merged)

- **Edge classification**: ONE directed TokenEdge srUSDe(`0x3d7d6fdf…`) → sUSDe(`0x9D39A5DE…`),
  target = srUSDe vault; `edgeKind:"protocol"`, `slotKind:"protocol"`,
  `protocolAction:"redeem"` → `leavesStandingPosition=false` (redeem is standing-safe,
  justified by the measured atomic immediate payout). **One-way** (wstETH
  one-descriptor-per-direction precedent); no sUSDe→srUSDe reverse; the standard USDe→srUSDe
  **deposit edge stays withheld** (previewDeposit never receipt-verified for this proxy+oracle
  vault; not needed for the loop). Routes through the template swap slot automatically — zero
  planner changes.
- **Adapter classification**: NEW protocol-leg descriptor id **`erc4626-redeem-silo`**
  (mechanism-named per repo convention; NOT a new ActionAdapter class; NOT a silent reuse of
  `erc4626-redeem`): signature `redeem(address,uint256,address,address)`, `tokenOutArg:0`
  (NEW optional field), `amountArg:1`, `executorArgs:[2,3]`, `needsApprove:false`
  (owner==msg.sender burns own shares), `quoteSig` **deliberately undefined** —
  `quoteProtocolLeg`'s one-call/one-contract shape structurally cannot express the two-contract
  quote (quoter.ts:239-258). The tokenOutArg/ArgSource extension in `makeProtocolAdapter` is
  ~8 additive lines, guarded by the existing exhaustive arg-coverage throw + a byte-pin CASES
  entry (selector `0xfea53be1`, full arg layout) in the same commit. Unique selector ⇒ no
  matchTrace shadowing with `0xba087652`.
- **Registry (data) split**: srUSDe PoolEntry (token-graph.ts:147) **KEEPS**
  `adapter:"erc4626"` (analysis-side classification keys on that string + ERC4626 event topics —
  untouched) and **KEEPS** `nonStandardRedeem:true`; **GAINS**
  `redeemTokenOut: SUSDE`. The prune branch (token-graph.ts:375-379) is rewritten: a flagged
  vault WITH `redeemTokenOut` emits exactly the one silo redeem edge; a flagged vault WITHOUT it
  still emits **zero edges** — the fail-closed doctrine is retained. A second silo-style vault
  becomes a one-line registry addition reusing the descriptor.
- **Quote path**: `quoter.ts quote()` gains one case → `quoteSiloRedeem`: two SEQUENTIAL
  `state.call`s — `previewRedeem(amountIn)` on target (srUSDe), then `previewWithdraw(assets)`
  on `tokenOut` (sUSDe; `quote()` already receives tokenOut, zero plumbing change). Cost: +1
  local eth_call per edge evaluation, worst case ~22 per candidate — same per-evaluation call
  count as `quoteUniV3`'s existing 2 sequential calls. No revm `quoteByAdapter` case needed
  (protocol legs are served through `state.call`).
- **Block-scan mid wiring is explicit, not automatic**: both mids builders dispatch on hardcoded
  adapterId switches and **silently return null for unknown ids** — without new cases in
  `main.ts` `blockScanProtocolAdapter` + `readBlockScanProtocolMid` (+ `blockscan-hunt.ts`
  parity), the edge would be planner-visible but block-scan-mid-blind. Wired with the two-call
  mid (~0.828 sUSDe/share; the wrong previewRedeem-only mid would be ~1.025).
- **c069abea pool pin**: via `pinned-warm-pools.json` (registry-merged unconditionally at
  main.ts:648,670 — survives universe-file churn, seeds warm state; precedent = the 395f91b3
  entry), NOT `force-include-poolids.json` (only re-admits entries still present in the 30-min
  regenerated active-pools.json; a 7-swaps/30d pool can genuinely decay out).
- **Rejected**: pure B's standard-redeem `0xba087652` encode (would quote the silo path but
  execute the standard path — an unverified quote/execution coupling on a multi-token vault; B
  itself named A's explicit-token encode as its fallback); pure A's vault-named id, force-include
  pin, and looser `quoteSafetyBps` gate tolerance.

## Two F-013 assumptions corrected by ground

1. **"register sUSDe as a graph node" — unnecessary.** The graph has no token node list: nodes
   are implicit from edge endpoints (buildTokenPaths/buildTokenIndex, token-graph.ts:653-695,
   :254-268). No ADDR constant, decimals table, price entry, or allowlist is needed for a path
   token — profit is measured in `opp.flashToken` units by simulation, and 8 sUSDe-touching
   return venues already exist in the node universe (incl. the competitor's UniV3 sUSDe/USDT
   `0x7EB59373`, already in the live runtime graph).
2. **"c069abea dropped during graph build even at topN=6000" — a probe artifact.** The prior
   probe grep'd the hunt REPORT JSON, which contains no pool/edge list. The pool's node entry is
   complete and passes every backrun-lane admission step at live topN=6000 (no token-based
   filter exists anywhere; `nonStandardRedeem` is referenced nowhere outside token-graph.ts).
   The real exposure is score-7 churn out of the cron-regenerated universe file → pin it in
   `pinned-warm-pools.json`, and the entry **MUST include `fixedTokenIn`/`fixedTokenOut`** —
   token-graph.ts:326-328 hard-throws on univ4 entries without them and `Promise.allSettled`
   swallows the throw into a silent `skipped` count (the gate would stay green while live
   silently lost the pool).

## Red-team (verdict: design_holds_with_amendments)

Three required amendments, all adopted into the gate:

1. **Gate timestamp pin** — before the BotVM final-sim send, pin the execution block timestamp
   to the quote-state timestamp via `evm_setNextBlockTimestamp` (helper precedent
   state-backend.ts:489-490). Both vaults accrue per-second (measured 2.4e12 raw per 12s at
   ~958e18 scale, quote HIGH); `AnvilStateBackend.send()` mines with no timestamp control, so
   without the pin the wei-exact receipt-diff criterion is guaranteed to fail — and at
   amount-propagation's default `safetyBps=10000n` (no haircut) the next leg's transfer of
   exactly the quoted sUSDe amount can spuriously revert the gate sim itself.
2. **Pin field completeness** — the c069abea pinned entry must copy the 395f91b3 shape verbatim
   incl. `fixedTokenIn`/`fixedTokenOut`; add a post-deploy check of the
   `[searcher/live] pinned warm skip` log / token-graph skipped counter.
3. **Negative gate asserts** on the rewritten prune branch — srUSDe emits exactly ONE edge
   (`erc4626-redeem-silo`, NO deposit edge), and a `nonStandardRedeem` vault WITHOUT
   `redeemTokenOut` still emits ZERO edges.

Notable refuted attacks (worth keeping):

- **Cooldown/pause fail-open** — refuted: fail-closed at every layer; a future proxy-upgrade
  gate reverts execution → sim fails → no submission; residual = same class as any DEX leg.
- **Approve/owner semantics** — refuted: `needsApprove:false` correct (owner==msg.sender burns
  own shares; the silo's transferFrom uses the silo's own allowance); bonus: if the tokenOutArg
  extension were forgotten, the 4-arg signature leaves arg 0 uncovered and adapter registration
  throws loudly.
- **One-way edge phantom reverse** — refuted: buildTokenPaths is a pure directed DFS; the
  blockscan `readExternalMid` 1/mid inversion is direction-gated by `findEdge`.
- **EV/valuation of intermediates** — refuted: profit token = flash token = USDC (priced-stable
  table); intermediates are pure simulation pass-throughs; phantom-profit guard compares in the
  flash token (loop is ~74bps of flash, far under the 2000bps guard).
- **Analysis-side misclassification** (`INVENTORY_REBALANCE_SELECTORS`) — refuted: the set is
  {`0x6e553f65`, `0xba087652`}; neither `0xfea53be1` nor `0xdfcd412e` is in it, the selector
  layer is only consulted when `!hasAtomicLoopFlow`, and F-013 already classifies atomic via the
  canonical tool.

## Rule-12 gate (fixed ≠ implemented)

New harness `npm run searcher:blockscan-fork-solve-f391` — sibling of `blockscan-fork-solve.ts`,
anchored at block 25462190 pre-competitor intra-block state (fallback end-of-25462189); env:
archive `MAINNET_RPC_URL` (local reth pruned ~10k blocks; 25462190 is ~15k back) +
`SEARCHER_ENABLE_PROTOCOL_EDGES=1`. **PASS requires ALL of:**

1. `buildTokenGraph` over the real POOL_REGISTRY (srUSDe with `redeemTokenOut`) emits the
   `erc4626-redeem-silo` edge — the REAL emission branch, not hand-seeded edges — **plus** the
   two negative asserts (amendment 3);
2. planner composes the 4-leg ring USDC → srUSDe (v4 `0xc069abea` fee 100) → sUSDe (silo
   redeem) → USDT (v3 `0x7EB59373`) → USDC (v4 `0x395f91b3` fee 8);
3. solver `netProfit > 0` in USDC after gas+flash (competitor surplus ~7.01 USDC on 949.49
   flash) with final BotVM fork execution SUCCESS, all legs status 1;
4. **WEI-EXACT receipt-diff**: sUSDe received from the silo == quoted
   `previewWithdraw(previewRedeem(shares))`, under the `evm_setNextBlockTimestamp` pin
   (amendment 1) — this simultaneously receipt-verifies the `0xfea53be1` encode for the first
   time;
5. fixture pins `sUSDe.decimals()==18` and the pre-state pair
   `previewRedeem(934460889828731878592)=958150733475481205886` @25462189.

Known-red exclusion: `searcher:overlay-coverage` already fails at HEAD (below) — not part of
this gate; its failure must not be attributed to this change.

## Pre-existing defect surfaced (NOT caused by this design)

`searcher:overlay-coverage` is red at HEAD for `erc4626-deposit`: `routedSwapVenues()` pulls
every descriptor id from SWAP_ADAPTERS but `seedForAdapter` covers only univ2/univ3/univ4
(overlay-venue-coverage.ts:47-57,131-166,190-195), so every protocol descriptor — including any
new one — hits an already-failing assertion. Separate work item; filed as a `tooling_defect`
LearningCase (`tooldef-20260707-overlay-coverage-protocol-seeds`).

## Method Trace
task_class:       protocol_leg
tools_used:       - 8-agent workflow (4 ground readers → 2 dual-prior proposals → judge merge → red-team), 189 tool calls, all facts file:line-cited
                  - eth_call quote probes at historical blocks 25462189/25462190 + head 25477300 (previewRedeem / previewWithdraw / convertToShares, exact-in/exact-out selector verification from a real holder)
                  - debug_traceTransaction callTracer on 0xf391d02a (silo staticcalls previewWithdraw — dispositive for the quote formula) + receipt log decode
                  - SSM reads of the node universe (/opt/MEV/listener/searcher/pools/active-pools.json 4895 pools: c069abea entry complete, 8 sUSDe-touching venues; pinned-warm-pools.json precedent shape)
                  - local ethers selector computation (0xfea53be1 / 0xdfcd412e / 0xba087652 / 0x4cdad506 / 0x0a28a477) reconciled against the pinned test table (test/protocol-legs.ts)
                  - node --import tsx run of test/overlay-venue-coverage.ts (surfaced the pre-existing red)
                  - npm run tx-profit reconcile (canonical PnL: net $5.66 vs F-013 $5.69, ethUsd snapshot drift — agrees)
evidence_order:   1. receipt + callTracer of the competitor tx (mechanism: multi-token silo withdraw, payout token, selectors) 2. eth_call quote math at execution state (formula byte-exact, diff 0; convertToShares floor dual rejected) 3. live-holder eth_call at head (0xfea53be1 exact-in verified, structure holds today) 4. code ground: descriptor/graph/quoter/mids dispatch sites file:line (4 parallel readers) 5. node universe presence via SSM (c069abea + return venues) 6. dual-prior design proposals 7. judge merge on the 2 load-bearing splits (encode, pool pin) 8. red-team code-verified attacks → 3 amendments
analysis_frame:   - registry-owns-data / descriptor-owns-mechanism split: the vault instance + payout token are registry data; encode+quote mechanism is a descriptor — vault #2 must be a one-line registry addition
                  - a quote must be the execution path's OWN math (byte-exact previewWithdraw∘previewRedeem, silo-staticcalled), not an economically-close dual — wei-exact receipt-diff is the gate criterion, quoteSafetyBps stays a live-safety layer not a gate tolerance
                  - fail-closed doctrine: a flagged vault without a receipt-verified payout token must emit ZERO edges; explicit-token calldata makes wrong-payout-token structurally impossible
                  - hardcoded-switch inventory before claiming "auto-appears": quoter quote() and BOTH protocolMids builders silently null/throw on unknown adapter ids — every dispatch site enumerated up front
                  - graph nodes are implicit from edge endpoints — verify what registration a new token actually needs (none) instead of assuming node/decimals/price plumbing
sanity_checks:    - exact-out twin inverse check: withdraw(sUSDe, quoted_amount, …) returns exactly 1e18 shares — perfect inverse of the exact-in quote
                  - convertToShares vs previewWithdraw distinguished at the same state (1 wei apart) before declaring the winning formula
                  - per-second accrual measured across 12s (2.4e12 raw at ~958e18 scale) before claiming wei-exactness is achievable — became gate amendment 1
                  - 13 cooldown-style getters probed (all revert) before classifying protocolAction=redeem as standing-safe
                  - the prior "c069abea dropped from graph" claim re-derived from the probe's own grep target (hunt report JSON has no pool list) — probe artifact, not admission bug
                  - selector table recomputed locally and reconciled against the pinned test CASES; overlay-coverage red confirmed pre-existing at HEAD before attributing
tool_gap:         listener test searcher:overlay-coverage is red at HEAD for every protocol descriptor id (routedSwapVenues enumerates all SWAP_ADAPTERS but seedForAdapter only seeds univ2/univ3/univ4) — a gate-adjacent test that mis-attributes failure to any new protocol descriptor; surfaced by ground reader, not caused by this design.
codify_next:      tooling_defect LearningCase tooldef-20260707-overlay-coverage-protocol-seeds — FILED (open): fix = seedForAdapter gains protocol-leg seeds (or routedSwapVenues excludes protocol slotKind ids with an explicit allowlist) in listener/src/searcher/test/overlay-venue-coverage.ts; until then every protocol-descriptor gate report must carry the known-red exclusion line.
distill_for_opus: For a non-standard protocol venue, settle the QUOTE before the design: callTracer the competitor tx to find which preview function the protocol ITSELF calls mid-execution — that composition is the byte-exact quote (here previewWithdraw∘previewRedeem; the plausible convertToShares dual was 1 wei off and only the trace could disambiguate). Then classify by splitting data from mechanism: payout token is registry DATA (redeemTokenOut), the two-call quote + explicit-token encode is a reusable mechanism descriptor — and before claiming any new id "auto-appears" anywhere, enumerate every hardcoded dispatch switch (quoter + both mids builders here) because unknown ids fail SILENT, not loud. Time-dependent vault math makes wei-exact gates impossible without pinning the execution timestamp to the quote state.
