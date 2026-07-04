# Loss-coverage auto-add analysis — can the tool LOCATE + AUTO-ADD missing coverage?

Authorized defensive arbitrage research; local reth + bounded-live dry measurement, read-only.
Scope: the three findings behind `onchain-loss-scan` (rule-17 LearningCase). Every claim is a
`file:line` + a node measurement. Head `b73077a`, run_id `de97f26b`, 300-block loss-scan.

## Loss-scan ground truth (300 blocks, 558 competed backruns)
`scan_not_triggered 338 (61%) · source_not_seen 157 (28%) · non_comparable_winner 60 · path_not_found 2 · gas_underwater 1 · venue_missing 0 · outbid 0`.
Confirms the context: we lose at DETECTION, never at bid/venue.

---

## Q1 — the ~62% "not received": identify the private channel? auto-add it?

### (a) What we CAN identify from data we hold — measured
Missed (`source_not_seen`) victims by LANDING-BLOCK builder (extraData, victim-weighted, n=157 / 114 blocks):

| builder | victims | share |
|---|---|---|
| Titan (titanbuilder.xyz) | 106 | 68% |
| Quasar (quasar.win) | 29 | 18% |
| BuilderNet | 10 | 6% |
| Eureka / bob / bombora / btcs | 12 | 8% |

**Top-3 builders cover 92% of missed victims** — a small, targetable set. But the BUILDER is not the
ORDERFLOW CHANNEL: Titan built the block; the tx could have reached Titan via bloXroute / Eden /
direct-RPC / a relay Titan subscribes to. On-chain there is **no field that names the private relay**
(`analysis/src/pnl/sender-flow.ts` already caps out here: it returns `submission_method` bundle/public
+ `builder`, and explicitly cannot prove `mev-share`/`public` membership without an external mempool
archive). **Verdict Q1(a): we can name the winning BUILDER (92% = Titan/Quasar/BuilderNet), never the
relay. Naming the relay needs external orderflow-partner intel (WebSearch per builder — the manual
step CLAUDE.md 6a already prescribes), not our data.**

### (b) Auto-addable like discover-routers? — NO, structural
- `discover-routers.ts:72-148` scans blocks for `to` addresses with swap activity → `appendForceIncludeRouters`
  → widens the mempool `toAddress` filter. Auto-addable **because a router is an on-chain address**.
- A private channel is an **off-chain SSE/WS endpoint + credentials**, not an address. The hint-source
  layer is `main.ts:857-866` (`mergeHints(mevShareHints(config.mevShareSseUrl), mempoolHints(...))`) +
  the generator `main.ts:3192 mevShareHints`. Adding bloXroute/Eden/direct-builder = **write a new
  `async function* xHints(url, authHeader)` + wire it into `mergeHints` + provision creds/account** —
  code + integration, not an appendable address.

**Verdict Q1(b): NOT auto-addable. The tool can only SURFACE "pursue Titan/Quasar/BuilderNet orderflow"
as a human integration decision. `mergeHints`/`mevShareHints` is where the code would change, but the
blocker is credentials/account, not a discoverable on-chain value.**

---

## Q2 — "no matching graph pool": (i) in active-pools but dropped by topN, or (ii) never indexed?

### Measurement (received-but-dropped victims from the raw log, landed+status=1, local reth)
`main.ts:1150-1152` throws `"no matching graph pool"` when the hint yields no pool impact AND no token
hit. Over a 200 MB log tail: **57,998 unique dropped victims (97% MEV-Share)**. Sample of 150 that
LANDED:

| bucket | n | note |
|---|---|---|
| no_swap_logs (noise) | 79 | landed tx had no DEX swap — correctly skipped |
| **in active-pools, NOT a graph edge** | **70** | **all univ4** |
| absent from active-pools (discovery/cap) | 1 | v2/v3 `0x6206ca…7a`, 563 swaps/2d — cut by `POOL_UNIVERSE_MAX_POOLS=3000` |

Of the 71 with swaps: **IN runtime graph = 0, in active-pools-but-not-graph = 70 (99%), truly absent = 1 (1.4%)**.

### Root cause of the 99% (hook resolution, n=120 landed → 14 unique v4 poolIds, all in active-pools)
`token-graph.ts:80,94,251` — `v4HooksAffectSwap = (hooks & 0xcc) != 0`; the v4 build case does
`if (v4HooksAffectSwap(poolKey.hooks)) break;` → **no graph edge emitted**. Result:

| dropped v4 poolId class | n | fixable? |
|---|---|---|
| swap-hooked (0xcc) → rejected at graph build | 13 | **structural** — quote/exec path supplies no hookData |
| zero-hook → SHOULD have matched | 1 | **bug** — real detection/identity miss to chase |

active-pools v4 hook profile (n=2000): `zero_hook 1828 · swap_hook 170 · nonswap_hook 2`. Only 8.5% of
our v4 universe is swap-hooked, yet swap-hooked pools are **93% of the v4 drops** — hooked pools are
disproportionately the flow we lose.

### Q2 answer — it is NEITHER (i) nor (ii)
- **NOT (i) topN/minScore:** `topN=6000 > 5000` file size and `minScore=1` with every pool `score≥1`
  → the file loads in full (`main.ts:413-414`, banner `universe=4991`). topN is not the knob.
- **NOT (ii) discovery:** 99% of dropped pools ARE in active-pools.json. Discovery indexed them
  (build indexes 11,322 active, 6,960 above `minSwaps=2`).
- **It is (iii): present in the universe, rejected DOWNSTREAM at graph build** by the v4 hook mask
  (`token-graph.ts:251`) — a **v4 hooked-pool execution-capability gap (structural)**, plus 1 zero-hook
  detection bug, plus a minor `POOL_UNIVERSE_MAX_POOLS=3000` build cap that drops high-activity tail
  pools (`build-active-pool-universe.ts:130`).

### Is there already an auto-add loop, and why didn't it catch these?
`auto-close-route-gap.ts` fires ONLY on a `route_gap_decisive` bundle-postmortem (bundles WE submitted
that lost), reading `analyzed_competitors[].touchedVenues[in_graph=false]`. It does **not** scan
`no_matching_graph_pool` / `source_not_seen` victims — so it never sees these. **And even if wired,
force-include would be a NO-OP here:** `appendForceIncluded` (`pool-universe.ts:169`) runs UPSTREAM of
`buildTokenGraph`; a force-included swap-hooked v4 pool still hits `token-graph.ts:251 break` → still no
edge. Force-include only defeats the topN cut, which is not the blocker.

---

## Q3 — verdict: what the tool CAN auto-add vs what needs a human

| source type | on-chain addressable? | auto-add path | verdict |
|---|---|---|---|
| v2/v3/curve pool cut by build cap | yes (address) | force-include-poolids / raise `POOL_UNIVERSE_MAX_POOLS` | **auto-addable** (but only 1.4% of drops) |
| zero-hook v4 poolId mis-dropped | yes (poolId) | force-include + fix identity load | **auto-addable** (small; chase the bug) |
| **swap-hooked v4 pool** | yes (poolId) but **unquotable** | none — needs hookData in quote/exec | **NOT auto-addable — structural (v4-hook adapter epic)**; force-include is a no-op |
| private orderflow channel (Q1) | **no** (off-chain endpoint+creds) | new SSE/WS client in `mergeHints` | **NOT auto-addable — human integration** |

**The user's "auto-add missed pools into force-include-poolids" extension is the RIGHT reflex but hits a
wall on the dominant bucket:** ~93% of `no_matching_graph_pool` v4 drops are swap-hooked pools that are
ALREADY in the universe and are rejected for a capability we don't have — force-include cannot add
capability. Auto-add would correctly close only the ~1.4% cap-cut pools + the ~7% zero-hook v4, i.e. the
minority. The real levers are an epic (v4 hooked-pool quote/exec) and a cheap build-cap bump, not a new
pin loop.

### Recommended, gated rule-12
1. **`onchain-loss-scan --auto-close` for the CLASSIFIABLE minority (cheap, do it):** for
   `source_not_seen_reason: pool_not_in_graph` cases whose venue is a zero-hook v4 poolId OR a v2/v3
   address present in a recent build but cut by the cap, append to `force-include-poolids.json` (reuse
   `appendForceIncludePoolIds`). **Gate first on `v4HooksAffectSwap===false`** so it never pins an
   unquotable hooked pool. rule-12 flip: pin the sample victim → `pool_in_routing_graph false→true` +
   the pool becomes a graph edge on reload.
2. **Bump `POOL_UNIVERSE_MAX_POOLS` 3000→~7000** (6,960 pools already clear `minSwaps=2`; the file cap,
   not topN=6000, is what dropped `0x6206ca…`). One-line env change; validates by the cut pool appearing
   in the next build.
3. **Escalate the dominant bucket to the v4-hooked-pool quote/exec epic** (rule-13). Do NOT keep pinning
   hooked v4 into force-include — it is a no-op and would grow the pin file forever (the exact rule-13
   force-include-≥3 → fix-the-capability signal).
4. **Tool-honesty fix (rule-16):** `no_matching_graph_pool` throws at `main.ts:1152` with NO structured
   event (first `emitEvent` in `handleHint` is downstream at `main.ts:1241`). So the loss-scan
   `received_but_dropped` sub-reason (b73077a, `onchain-loss-scan.ts:1095`) is undercounted — these
   detection drops are event-silent and fall to `not_received`. Emit a `pipeline_dropped` (stage
   `detect`, reason `no_matching_graph_pool`, with the touched v4 poolId + hook bit) BEFORE the throw so
   the tool can separate "hooked-v4 we can't quote" from genuine "never received".

### Private channels (Q1) — human decision, stated plainly
Cannot be auto-added. The actionable, data-backed output the tool CAN produce: "92% of missed value was
built by Titan/Quasar/BuilderNet → evaluate their orderflow-sharing terms" — a business/integration
call, wired (if pursued) as a new generator in `mergeHints` (`main.ts:860`), not an on-chain append.
