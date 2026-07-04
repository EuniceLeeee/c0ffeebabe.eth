# Impl plan — runtime arb-relevance pool selection + competitor-scan MEV-Share double-hash resolution

> Scope: authorized, defensive on-chain arbitrage research. Local mainnet-fork / dry-run study;
> reads public chain data; broadcast stays a human-gated step (out of scope for this plan).
> Lean Hermes impl-cycle template. Codex implements each step; Claude (non-author) gates
> build + the rule-12 fixture + regressions before commit.

## Brief

Two independent, ordered fixes, landed from the run `dc9bb4a3` see→no-submit analysis:

1. **Step 1 (do first — makes loss verdicts trustworthy).** `analysis/src/competitor-scan.ts`
   mislabels MEV-Share-sourced drops as `v_not_mined`. Root cause verified: a MEV-Share hint's
   `victim_hash` is a **double-hash** (`keccak256(realTxHash)`, per Flashbots event-stream docs),
   so `eth_getTransactionReceipt(victim_hash)` can NEVER resolve → the drop is auto-labeled
   `v_not_mined` at `competitor-scan.ts:154-158`. On run `dc9bb4a3`: of 1630 distinct no_candidate
   victims, 1381 were `src=mev-share` and 100% show "never mined" — yet a `keccak256(rawTx)`
   reverse-scan over the drop-window blocks matched **284** of them to REAL mined txs. So the
   "95% phantom" reading is a tool artifact, not on-chain truth. Fix = resolve via a
   `keccak256(rawTx)→realTx` reverse map + tag `victim_source: mev-share | mempool`.
   (rule-16 mandatory codify: a fresh-analyst-found tooling gap must be fixed in the script.)

2. **Step 2 (the coverage fix).** The runtime pool loader `loadPoolUniverse`
   (`pool-universe.ts:74-76`) sorts purely by raw `score` (= `activity.count`, written at
   `build-active-pool-universe.ts:530,626`) and topN-slices. Build-time `selectArbRelevantPools`
   (loop-completer-first ranking) exists and is enabled at BUILD (`build-active-pool-universe.ts:238`)
   but only decides which pools get WRITTEN; it does not adjust the runtime `score`, and
   `PoolUniverseLoadOptions` (`pool-universe.ts:27-34`) has no arb-relevance option. So a
   low-count-but-critical loop-completer is dropped by the runtime topN cut. Verified on run
   `dc9bb4a3`: the genuine competitor winner `0x4308955f` closed a loop through 3 pools that are
   in `active-pools.json` but NOT in the runtime graph at topN=1500 (2 HAKKA v2
   `0xb8b84ce0…`/`0x9c599965…` + v4 poolId `0x00d5397c…`); 33 `impact_pool_not_in_routing_graph`
   drops are likewise active-but-not-runtime. Current stopgap `SEARCHER_POOL_UNIVERSE_TOP_N=6000`
   masks this by including everything (adds solver/candidate-cap load, already ~24% of drops). Fix =
   wire arb-relevance into the RUNTIME loader with a reserved loop-completer quota (mirror the
   existing `highSpreadPairQuota` reserved-slot pattern in `selectRankedPools`,
   `pool-universe.ts:85-127`), so loop-completers survive at topN≈1500-2000 and the deploy knob can
   drop back from 6000.

`searcher_behavior_change: yes` (Step 2 changes which pools the planner can route through).
Explicitly scoped OUT (per the analysis): no multi-hop cycle-construction epic, no phantom-victim scorer.

Governance: rules 11 (Codex generator / Claude evaluator), 12 (repair-replay double-gate), 16
(fable-found tooling gap → codify). Each step lands only after its rule-12 fixture flips.

---

## Step 1 — competitor-scan MEV-Share double-hash resolution

**Goal.** Before labeling a drop `v_not_mined`, attempt to resolve the `victim_hash` as a
MEV-Share double-hash via a `keccak256(rawTx)→realTx` reverse map built over the drop-window
blocks. Tag every drop with `victim_source: mev-share | mempool | unknown`.

**Allowed files**
- `analysis/src/competitor-scan.ts` (resolution logic, `DropStatus`/`DropResult`, render row)
- `analysis/src/test/competitor-scan-doublehash.ts` (NEW — rule-12 fixture, pure/offline)

**Forbidden files** — do NOT touch: `analysis/src/cli/live-loss.ts` (CLI unchanged), any
`listener/**`, `pool-universe*.ts`, any `.env` / deploy scripts, `runtime-graph-pools.json`.

**Anchors / mechanism**
- Reverse map: for the set of distinct victim `blockNumber`s already discovered
  (`seenVictimBlocks`, `competitor-scan.ts:227-231`; or the union of all resolved `victimBlock`
  plus a small ± window), fetch full blocks via `ctx.rpc.getBlockByNumber(n, true)`
  (`analysis/src/rpc/client.ts:44`) and build `Map<keccak256(rawTxHex), {realTx, block}>`.
  `ethers` is already a dependency (`competitor-scan.ts` may import `{ ethers }`; `keccak256` +
  raw-tx serialization live there). If the node returns full tx objects (not raw hex),
  serialize with `ethers.Transaction.from(tx).serialized` then `ethers.keccak256(...)`, or use the
  block's raw-tx form if available — pick whichever the local reth returns; assert one match in
  the fixture so the encoding is proven.
- Resolution point: at `competitor-scan.ts:154-158`, when `victimReceipt` is null, first look up
  `reverseMap.get(drop.victimHash.toLowerCase())`. If hit → treat `realTx` as the victim (fetch
  its receipt, set `victimBlock`/`victimIndex`, tag `victim_source: "mev-share"`, continue the
  normal competitor analysis). If miss → keep `v_not_mined` and tag `victim_source: "mempool"`
  (its hash was a real tx hash that genuinely didn't land) or `"unknown"`.
- `victim_source` tag: add to `DropResult` (`competitor-scan.ts:50-58`) and surface it in the
  rendered per-drop line (`competitor-scan.ts:357` region) and the summary counts.
- Two-pass ordering: the reverse map needs the window blocks, which come from resolved victims.
  Simplest correct approach: pass 1 resolves all mempool (real-hash) victims to collect the block
  window; build the reverse map over `[minBlock-1 … maxBlock+K]` (K≈8, cover backruns landing a
  few blocks late); pass 2 re-resolves the still-`v_not_mined` drops through the map. Keep it a
  single added helper; do not restructure `runCompetitorScan`'s existing flow beyond this.

**rule-12 flip (deterministic, offline fixture — `analysis/src/test/competitor-scan-doublehash.ts`)**
- Pin ≥3 real `{doubleHash, realTxHex, block}` triples from the run (e.g. hint
  `0xa91c60992f66…` → realTx `0x2b3c78ca63a7…` block 25456945; two more from the 284-match set).
- Feed a stub RpcClient that returns those blocks' raw txs; assert `keccak256(rawTx)===doubleHash`
  for each (proves the encoding) AND that `analyzeDrop`/resolution reclassifies a
  double-hash victim from `v_not_mined` → resolved (`victim_source:"mev-share"`, non-`v_not_mined`).
- `expected_transition`: on the `dc9bb4a3` 150-drop sample, `v_not_mined` count drops **143 → ~7**
  (only genuine never-mined mempool victims remain). Record this as the live-sample confirmation
  (run the scan against the local reth after the fixture passes).

**Verify commands**
```bash
cd analysis && npm run build
cd analysis && npx tsx src/test/competitor-scan-doublehash.ts      # rule-12 fixture, offline
# live-sample confirmation (local reth, zero-CU), report v_not_mined 143->~7:
cd analysis && npm run live-loss -- --competitor-scan --events /tmp/nc-sample.jsonl --rpc http://127.0.0.1:8545
```

`turn_class: observability-only` (instrument fix) — but it gates the correctness of every
downstream loss verdict, so it lands first.

---

## Step 2 — runtime arb-relevance loop-completer quota in `loadPoolUniverse`

**Goal.** At topN≈1500-2000 (NOT 6000), reserve topN slots for loop-completers so a low-count
pool that closes a cycle with a token already selected survives the runtime cut. Reuse
`selectArbRelevantPools`; mirror the `highSpreadPairQuota` reserved-slot pattern.

**Allowed files**
- `listener/src/searcher/pool-universe.ts` (`PoolUniverseLoadOptions`, `loadPoolUniverse`,
  `selectRankedPools`)
- `listener/src/searcher/main.ts` (thread the new option from config at the `loadPoolUniverse`
  call, `main.ts:550-556`; add an env knob next to the existing universe knobs, `main.ts:402-407`)
- `listener/src/searcher/test/planner.ts` (add ONE fixture test, mirror
  `testHighSpreadUniverseSelectionReplay` at `:830-924`; register in `main()` at `:942`)

**Forbidden files** — do NOT touch: `build-active-pool-universe.ts` (build-time selection is
correct as-is), `pool-universe-arb-relevance.ts` (reuse its exported `selectArbRelevantPools` /
`RankablePool`, do not modify), any `.env` / deploy scripts, `active-pools.json`,
`runtime-graph-pools.json`, `force-include-poolids.json`.

**Anchors / mechanism**
- Add to `PoolUniverseLoadOptions` (`pool-universe.ts:27-34`):
  `loopCompleterQuota?: number` (reserved slots) — default 0 (behavior unchanged when unset).
- In `selectRankedPools` (`pool-universe.ts:85-127`): after the primary top-N fill and BEFORE the
  final backfill loop, add a loop-completer reservation pass symmetric to the high-spread pass
  (`:106-118`). Compute loop-completers by adapting `selectArbRelevantPools`: map the parsed
  `PoolUniverseEntry[]` to `RankablePool` (`key = poolRegistryKey(pool)`, `token0`/`token1`,
  `count = pool.score ?? 0`, `lastSwapBlock`), pass the already-selected pools as
  `externalTokenPools` so a candidate counts as a completer only if BOTH its tokens already have
  degree ≥2 in the selected-plus-candidate graph. Fill up to `loopCompleterQuota` slots from
  not-yet-selected loop-completers (highest `count` first), then run the existing final backfill.
  Keep `cappedMax` as the hard ceiling; loop-completers displace only the tail, exactly like
  high-spread. Reuse `appendSelected`/`poolRegistryKey`/`unorderedTokenPairKey`.
- `main.ts`: add `poolUniverseLoopCompleterQuota: Number(process.env.SEARCHER_POOL_UNIVERSE_LOOP_COMPLETER_QUOTA ?? "0")`
  to config (near `:406`), pass it as `loopCompleterQuota` in the `loadPoolUniverse` opts (`:550-556`),
  and echo it in the universe banner (`:524-527`) so a deploy can confirm it's active. (The
  intended deploy value is set later by the human via `deploy-node.sh`; the plan does not change
  any deploy default.)

**rule-12 flip (deterministic — new test in `listener/src/searcher/test/planner.ts`)**
- Mirror `testHighSpreadUniverseSelectionReplay` (`:830-924`): write a synthetic universe file with
  (a) 1500+ high-`score` filler pools and (b) the winner's real loop as low-`score` pools — the
  two HAKKA v2 (`0xb8b84ce0…`, `0x9c599965…`) + the v4 `0x00d5397c…` — plus the return legs so a
  closed cycle exists through a shared token.
- BEFORE (score-only, `loadPoolUniverse({maxPools:1500, loopCompleterQuota:0})`): assert the 3
  low-score pools are excluded and the planner returns `0` plans with
  `classification === "impact_pool_not_in_routing_graph"` (impact_pool_edge_in_routing_graph false).
- AFTER (`loadPoolUniverse({maxPools:1500, loopCompleterQuota:150})`): assert all 3 loop-completer
  pools are selected, and `planner.plan(...)` for the winner's impact returns `>0` plans with
  `impact_pool_edge_in_routing_graph === true`.
- `expected_transition`: `impact_pool_edge_in_routing_graph false→true` + `candidate_plans 0→1` at
  **topN=1500** (i.e. WITHOUT the 6000 brute-force). Log a `[planner] loop-completer quota flip: …`
  line like the CFG/high-spread fixtures do.
- After the fixture flips, the human can lower the deploy knob `SEARCHER_POOL_UNIVERSE_TOP_N` back
  from 6000 toward ~1500-2000 with the quota carrying the loop-completers (out of scope for Codex;
  noted so the gate confirms the fixture proves it's safe to lower).

**Verify commands**
```bash
cd listener && npm run build
cd listener && npm run searcher:planner     # must print 14/14 + replay fixtures + high-spread + loop-completer flip
```

`verdict` recorded at gate: `fixed | implemented_not_validated` per rule 12 —
`fixed` only if the planner fixture shows the `false→true` / `0→1` transition at topN=1500.

---

## Gate checklist (Claude, non-author)
- [ ] Step 1: `analysis` build green; offline double-hash fixture passes; live sample shows
      `v_not_mined` 143 → ~7; `victim_source` tag present. Regressions: existing `live-loss`
      invocations still run.
- [ ] Step 2: `listener` build green; `searcher:planner` prints the loop-completer flip AND the
      prior 14/14 + replay + high-spread lines (no regression); banner shows the new quota.
- [ ] Commit each step separately, signed as the orchestrating model, only after its gate passes.
