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
   `v_not_mined` at `competitor-scan.ts:154-158`.

   **REFINED (gate on Codex's Step 1, run `3f5046c9`): "pure tool artifact" was OVERSTATED — the
   reverse-map only rescues ~15-20%, the rest is a REAL phantom.** The `keccak256(rawTx)→realTx`
   reverse-map resolves only 12/79 mev-share victims (15%) in the sample — matching the independent
   full-run reverse-scan (284/1381 ≈ 20%). A wide-scan spot-check (±50 blocks, 101-block window) on
   12 unresolved mev-share double-hashes: **3 near (dist 0), 0 far, 9 not-found** — zero recovered
   by widening, so the ~80% unresolved are genuinely **never-mined within ±50 blocks = effectively
   phantom for a backrun**, NOT a too-narrow window. So the reverse-map is a real correctness
   improvement (rescues the 15-20% that DID land) but does NOT flip the phantom read: the MEV-Share
   phantom-victim problem is LARGELY REAL and must NOT be fully scoped out (see the reopened lever
   note below). (Spot-check caveat: the 12 sampled victims shared one target_block neighborhood
   `25456945`; the rate still agrees with both independent full-run reverse-scans.)

   **Two Step-1 corrections from the gate (fold into the Codex re-brief):**
   - **`victim_source` must be AUTHORITATIVE, not inferred.** Codex's fix inferred source from
     resolution success → the 67 mev-share victims that failed to resolve were mislabeled `mempool`.
     The reverse-map is best-effort real-tx resolution and MUST NOT drive the source label.
     **Recommendation: the SEARCHER emits `victim_source` in the event** (not competitor-scan reads
     the log). `hint.source` (`"mev-share" | "mempool"`) is already in scope at the drop-emit site
     (`main.ts:1308` `emitPipelineDropped` closure; the same value gates `main.ts:1270,1676`), so add
     `victim_source: hint.source ?? "mev-share"` to the `pipeline_dropped` event
     (`events.ts:85-98` + the emit at `main.ts:1319-1333`). This is the durable fix: the events JSONL
     becomes self-describing, no fragile log-scrape coupling, and every future analysis (not just
     this scan) gets authoritative source. competitor-scan then reads `victim_source` from the event
     when present, falling back to the log-scrape only for old events lacking the field.
   - **The reverse-map STAYS** — it is the best-effort real-tx resolution that lets competitor
     analysis run on the ~15-20% of mev-share victims that did land (without it, those are lost).
     It just no longer sets the source label.

   Fix = (a) searcher emits authoritative `victim_source`; (b) competitor-scan keeps the reverse-map
   for real-tx resolution and reads `victim_source` from the event for labeling.
   (rule-16 mandatory codify: a fresh-analyst-found tooling gap must be fixed in the script.)

2. **Step 2 (the coverage fix — CANDIDATE-CAP relief, NOT latency).** The runtime pool loader
   `loadPoolUniverse` (`pool-universe.ts:74-76`) sorts purely by raw `score` (= `activity.count`,
   written at `build-active-pool-universe.ts:530,626`) and topN-slices. Build-time
   `selectArbRelevantPools` (loop-completer-first ranking) exists and is enabled at BUILD
   (`build-active-pool-universe.ts:238`) but only decides which pools get WRITTEN; it does not
   adjust the runtime `score`, and `PoolUniverseLoadOptions` (`pool-universe.ts:27-34`) has no
   arb-relevance option. So a low-count-but-critical loop-completer is dropped by the runtime topN
   cut. Verified on run `dc9bb4a3`: the genuine competitor winner `0x4308955f` closed a loop
   through 3 pools that are in `active-pools.json` but NOT in the runtime graph at topN=1500 (2
   HAKKA v2 `0xb8b84ce0…`/`0x9c599965…` + v4 poolId `0x00d5397c…`); 33
   `impact_pool_not_in_routing_graph` drops are likewise active-but-not-runtime.

   **Motivation is throughput, NOT latency (benchmark-corrected).** `searcher:bench-topn` on the
   real 5026-pool universe: plan p95 `96ms (topN=1500) → 131ms (topN=5026)` = **+35ms**, trivial
   vs the 5000ms TTL; one-time graph `buildMs 269→902` is off the per-victim hot path
   (startup/refresh only); live at topN=6000 shows most hints <170ms and `expiredBeforeSolver=4`
   (the rare 5000ms spikes are fork-refresh cold-state, present at 1500 too — NOT topN-caused). So
   full-universe topN is latency-fine, and the current stopgap `SEARCHER_POOL_UNIVERSE_TOP_N=6000`
   (universe 1500→5026 live) is a valid coverage answer on its own. Step 2's ONLY benefit is
   **candidate-cap / throughput relief**: more pools → more candidate plans → more hit the solver
   candidate-cap (~24% of drops). A reserved loop-completer quota lets the deploy knob drop back
   from 6000 toward ~1500-2000 WITHOUT losing the loop-completers — trading raw pool count for
   arb-relevant pool count so the candidate cap is spent on pools that actually close loops. Fix =
   wire arb-relevance into the RUNTIME loader with a reserved loop-completer quota (mirror the
   existing `highSpreadPairQuota` reserved-slot pattern in `selectRankedPools`,
   `pool-universe.ts:85-127`).

   **GATE-BEFORE-LAND (do not build Step 2 until this holds).** topN=6000 is currently deployed and
   latency-fine, so Step 2 is only justified if throughput is actually hurting: it lands ONLY if a
   longer bounded-live window shows `solver/candidate-cap` measurably WORSENED at topN=6000 vs the
   1500 baseline (share of drops or absolute rate up, crowding out real opps). If candidate-cap is
   fine at 6000, **Step 2 is DEFERRED** — topN=6000 is the sufficient coverage answer and no code
   change is needed. The rule-12 fixture below still stands as the correctness proof for WHEN we do
   land it. (Step 1 is unconditional and lands first regardless.)

`searcher_behavior_change: yes` (Step 2 changes which pools the planner can route through).
Explicitly scoped OUT: no multi-hop cycle-construction epic. **REOPENED (was wrongly scoped out):
the phantom-victim problem for MEV-Share flow is a REAL lever, not a scan artifact** — the spot-check
shows ~80% of mev-share hint victims never land within ±50 blocks, so a stateful victim
source-quality / sender-land-rate scorer that down-weights low-land-rate MEV-Share sources IS on the
table for MEV-Share (the existing `VictimSourceTracker` / `victim-source-quality.ts` is the seed;
memory `project-phantom-victim-flow-admission-epic`). NOT part of this MD's Step 1/2 code — it is a
separate tracked finding (`owner: phantom-victim epic`, `carry_to_round`), unblocked by Step 1's
authoritative `victim_source` (which lets us measure land-rate per source honestly).

Governance: rules 11 (Codex generator / Claude evaluator), 12 (repair-replay double-gate), 16
(fable-found tooling gap → codify). Each step lands only after its rule-12 fixture flips.

---

## Step 1 — authoritative `victim_source` (searcher-emitted) + competitor-scan double-hash resolution

**Goal.** (a) The SEARCHER emits an authoritative `victim_source` on each `pipeline_dropped` event
so the events JSONL is self-describing (no inference, no fragile log-scrape). (b) competitor-scan
labels from that field and keeps the `keccak256(rawTx)→realTx` reverse-map as best-effort real-tx
RESOLUTION (rescues the ~15-20% of mev-share victims that DID land, for competitor analysis) — the
reverse-map no longer sets the source label.

**Sub-step 1a (searcher, small) — emit authoritative source.**
- Allowed: `listener/src/searcher/events.ts` (add `victim_source?: "mev-share" | "mempool"` to the
  `pipeline_dropped` variant, `:85-98`), `listener/src/searcher/main.ts` (set it in the
  `emitPipelineDropped` closure, `:1319-1333`, from `hint.source ?? "mev-share"` — `hint` is in
  scope; same value already gates `:1270,:1676`). Also set it on the other `pipeline_dropped` emit
  (the `expired-before-solver` block at `:1290-1299`).
- Forbidden: any planner/pool-universe/deploy/.env file; no behavior change beyond adding the field.
- Verify: `cd listener && npm run build`; run a short dry/bounded window (or replay a recorded
  fixture) and confirm `pipeline_dropped` events now carry `victim_source`, and it matches the
  `hint tx=… src=` log line for the same victim.

**Sub-step 1b (competitor-scan) — label from event, resolve via reverse-map.**
- Allowed: `analysis/src/competitor-scan.ts` (read `event.victim_source` into `DropInput`; reverse-map
  resolution; `DropResult`/render), `analysis/src/test/competitor-scan-doublehash.ts` (NEW fixture).
- Forbidden: `analysis/src/cli/live-loss.ts` (CLI unchanged) beyond passing the field through if it
  is stripped in `toDropInput`; `pool-universe*.ts`; deploy/.env.
- **Labeling (authoritative):** `victim_source` on `DropResult` comes from `event.victim_source` when
  present. Fallback ONLY when the field is absent (old events): the log-scrape (`hint tx=… src=`) if a
  log path is provided, else `"unknown"` — NEVER inferred from resolution success.
- **Resolution (best-effort, unchanged in spirit):** reverse map over the window blocks
  (`ctx.rpc.getBlockByNumber(n, true)`, `rpc/client.ts:44`) → `Map<keccak256(rawTxHex), {realTx, block}>`.
  `ethers` is already imported in the analysis package. If blocks return full tx objects, serialize
  with `ethers.Transaction.from(tx).serialized` then `ethers.keccak256(...)`; assert one match in the
  fixture so the encoding is proven. At `competitor-scan.ts:154-158`, when `victimReceipt` is null,
  look up the reverse map; on hit, use `realTx` as the victim (fetch its receipt, set
  `victimBlock`/`victimIndex`, continue competitor analysis); on miss keep `v_not_mined`. **The
  source LABEL is independent of whether resolution hit.** Window: `[minBlock-1 … maxBlock+8]` from the
  resolved-victim block set (widening beyond this does NOT help — spot-check found 0 far hits).

**rule-12 flip (deterministic, offline fixture — `analysis/src/test/competitor-scan-doublehash.ts`)**
- Pin ≥3 real `{doubleHash, realTxHex, block}` triples (e.g. hint `0xa91c60992f66…` → realTx
  `0x2b3c78ca63a7…` block 25456945; two more from the 12-match set). Assert
  `keccak256(rawTx)===doubleHash` for each (proves encoding) AND that a double-hash victim with a
  reverse-map hit reclassifies `v_not_mined → resolved` (competitor analysis runs).
- **Assert labeling is authoritative**: a mev-share event that does NOT resolve keeps
  `victim_source:"mev-share"` (from the event field) — NOT `"mempool"`. This is the specific bug the
  gate caught (67 mislabeled); the fixture must lock it.
- `expected_transition` (live confirmation, honest numbers): on the sample, the ~15-20% of mev-share
  victims that landed flip `v_not_mined → resolved`; the ~80% that never landed stay `v_not_mined`
  but are correctly labeled `victim_source:"mev-share"` (a REAL phantom, not a mislabel). Do NOT
  expect `v_not_mined → ~7`; expect the mev-share resolved count ≈ 12/79 and zero source-mislabels.

**Verify commands**
```bash
cd listener && npm run build                                        # 1a
cd analysis && npm run build                                        # 1b
cd analysis && npx tsx src/test/competitor-scan-doublehash.ts       # rule-12 fixture, offline
# live confirmation (local reth, zero-CU): mev-share resolved ≈15-20%, zero source-mislabels
cd analysis && npm run live-loss -- --competitor-scan --events /tmp/nc-sample.jsonl --rpc http://127.0.0.1:8545
```

`turn_class: observability-only` (instrument fix) — but it gates the correctness of every
downstream loss verdict, so it lands first.

---

## Step 2 — runtime arb-relevance loop-completer quota in `loadPoolUniverse`

> **GATED — build only after the throughput trigger fires (see Step 2 Brief).** topN=6000 is
> deployed and latency-fine; this step lands ONLY if a longer bounded-live window shows
> `solver/candidate-cap` worsened at 6000 vs 1500. Otherwise DEFER. Benefit = candidate-cap relief
> (lets topN drop back from 6000 without losing loop-completers), NOT latency.

**Goal.** Reserve topN slots for loop-completers so a low-count pool that closes a cycle with a
token already selected survives the runtime cut — letting the deploy knob drop back from 6000
toward ~1500-2000 while keeping arb-relevant coverage, spending the solver candidate-cap on pools
that actually close loops rather than raw high-activity pools. Reuse `selectArbRelevantPools`;
mirror the `highSpreadPairQuota` reserved-slot pattern.

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
- [ ] Step 1 (unconditional, first): `listener` + `analysis` builds green; searcher emits
      authoritative `victim_source` on `pipeline_dropped` (matches the `hint … src=` log); offline
      double-hash fixture passes AND locks the "unresolved mev-share stays labeled mev-share, not
      mempool" assertion; live sample shows mev-share resolved ≈15-20% (NOT 143→~7) with ZERO
      source-mislabels. Regressions: existing `live-loss` invocations still run.
- [ ] Step 2 TRIGGER: a longer bounded-live window confirms `solver/candidate-cap` worsened at
      topN=6000 vs the 1500 baseline. If NOT confirmed → Step 2 DEFERRED, topN=6000 stands, do not
      build. (Latency is NOT a trigger — bench shows +35ms p95, immaterial.)
- [ ] Step 2 (only if triggered): `listener` build green; `searcher:planner` prints the
      loop-completer flip AND the prior 14/14 + replay + high-spread lines (no regression); banner
      shows the new quota.
- [ ] Commit each step separately, signed as the orchestrating model, only after its gate passes.
