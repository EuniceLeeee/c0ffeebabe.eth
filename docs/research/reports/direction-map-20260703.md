# Direction Map — 做了 / 没做 / 建议 (2026-07-03)

> Scope: authorized defensive on-chain arbitrage research; mainnet-fork + dry-run; broadcast is a
> human-gated step. Synthesis of the three review passes (first-pass gap analysis, Fable 2nd-pass
> ceiling verdict, Codex) + `replay-0x4db34b5c-gap-analysis.md`, mapped against the live codebase.

## Bottom line (the lens for every "建议" below)

Fable 2nd-pass (6h/1800-block, 0 CU) + Codex + the R10/R11 flat-`simSuccess` trigger converge on one
conclusion: **our strategy class (atomic backrun + spatial, no frontrun) is near the ceiling on
public flow.** Every traced miss in our own class (coffeebabe) is **dust** (max builder payment
$0.13 over the window). The non-dust money is elsewhere:
- **sandwiching** (ae2Fc483: $693 / $19 tips = frontrun+backrun brackets) — structurally **outside**
  our backrun-only posture → a **human posture decision**, not a coverage build.
- **v4 / large-aggregator backrun** — the **v4 epic already in flight**, not a new venue.

So the exotic-venue coverage bucket (SmarDex/OUSD/Enzyme/Rigel/DIFX) is **real engineering that
targets dust** — build the *diagnostic* (done), not the *execution adapters* (defer). The three
levers that actually move the production needle: **① on-chain inclusion proof · ② v4 depth ·
③ posture decision.**

Status key: ✅ done · 🔶 partial · ❌ not done ·  建议 tags: **做** / **defer(dust)** /
**接口留口子** / **不做** / **人类门**

## A. 检测 / 准入 (Detection / Admission)

| 方向 | 状态 | 说明 / 证据 | 建议 |
|---|---|---|---|
| Public mempool victim source (filtered) | ✅ | route B, `SEARCHER_ENABLE_MEMPOOL=1`, avoids pending-hash firehose | keep |
| Hash-only victim (pending-hash → getTx) | ✅→弃 | ghosts; mempool is the real path (memory) | keep off |
| Admission = tracked pools ∪ 14 hardcoded routers | 🔶 | `main.ts:176`/`:2308`; misses swaps wrapped in unknown proxy `to` even when they touch tracked pools | 小改可加更多 router,但… |
| Public-but-unmonitored router triggers (0x528a8372 class, ~½ addable) | ❌ | Fable: 4 public entrypoints addable, but admitted public-router triggers already convert to **~0** (`no_candidate_plans`) | **defer(dust)** — admission 不是瓶颈,下游才是 |
| Spatial / standing-cycle detection (no in-block trigger) | ❌ | `BackrunDetector` keys off in-block victim in a graphed pool; 0x4db is invisible end-to-end | **接口留口子** (`Opportunity` union), 现在不实现 |
| Top-of-block cyclic scanner | ❌ | doc Slice 5 | **不做** now |

## B. Venue 覆盖 / discovery

| 方向 | 状态 | 说明 / 证据 | 建议 |
|---|---|---|---|
| univ2 / sushi(v2-fork) / univ3 | ✅ | factory-scanned | keep |
| curve (plain + ng) | ✅ | bit-exact local quote 14/14 | keep |
| psm / fluid | ✅ | seeded | keep |
| **univ4 singleton** | 🔶 | adapter + native-ETH landed; **discovery churn ongoing** (R11: 100% of window's competitor legs v4-not-in-graph) | **做 — v4 epic 继续**(非-dust backrun 钱在这;incremental discovery cadence 是最尖的 lead) |
| **venue-gap 5-way classifier** (doc Slice B / 你的 #1) | ✅ | **shipped `8f2bf13`**, gated on 0x4db 9-pool hand-trace | done |
| **轻量 capability 表** (你的 #4) | ✅ | **shipped `8f2bf13`**, real on-chain addrs, analysis-only (inert) | done |
| VenueAdapter registry seam (unify 4 switches, doc Slice A) | ❌ | discovery/quoter/plan-builder/BotVM 各一处硬编码 | **接口留口子** — 仅当决定真加 venue 才落地 |
| RigelSwap + DIFX v2-fork factories (doc Slice 4 / 你的 #2) | ❌ | plain xy=k, reuse univ2 math | **defer(dust)** — classifier 现标 `venue_class_gap`,落地后自动翻 `pool_gap` |
| SmarDex (fictive-reserve AMM, doc Slice 1) | ❌ | non-xy=k; needs custom quote + callback | **defer(dust)** |
| OUSD (custom AMM, no factory, doc Slice 2) | ❌ | seed discovery + custom quote | **defer(dust)** |
| Enzyme `redeemSharesInKind` (non-AMM, doc Slice 3) | ❌ | share redemption, generic `0x00` call | **defer(dust)** |

## C. 路由 / 路径 (Routing / Path)

| 方向 | 状态 | 说明 / 证据 | 建议 |
|---|---|---|---|
| Multi-hop (≤3) + closed-loop construction | ✅ | `SEARCHER_MAX_HOPS=3` | keep |
| competitor-path → pool force-include 候选 (你的 #3) | ❌ | seed graph from competitor's touched pools | **做(轻量)** — 但先看 venue-share 测量;诊断驱动,低风险 |
| MAX_HOPS raise for cyclic mode | ❌ | doc Slice 5 | 随 spatial detection defer |
| 8-hop full-graph DFS | ❌ | — | **不做** |

## D. 执行 (Execution)

| 方向 | 状态 | 说明 / 证据 | 建议 |
|---|---|---|---|
| Morpho flash / Balancer flash | ✅ | `flash-liquidity.ts:35`; WBTC borrowable | keep |
| BotVM generic call (`0x00`/`0x01`) + value-call | ✅ | on-chain exec of new venue largely already possible | keep |
| bit-exact local quote: curve / v3 | ✅ | 14/14, 8/8 vs QuoterV2 | keep |
| bit-exact local quote: v4 | 🔶 | pending | 随 v4 epic |
| Callback-venue field wiring (smardex-style) | ❌ | mirrors v3 callback | defer(dust) |

## E. 经济 / 上链 (Economics / Inclusion)

| 方向 | 状态 | 说明 / 证据 | 建议 |
|---|---|---|---|
| EV gate + bribe + valuation | ✅ | `SEARCHER_EV_GATE=1`, bribe=builder payment %, values WETH/USDC/USDT/DAI/FRAX | keep |
| Sim fidelity (gasUsed=0 fallback) | ✅ | fixed (was 12M fallback killing modest lanes) | keep |
| **On-chain inclusion instrumentation** (task #18) | ❌ | `accepted`(builder HTTP 200) **≠ mined**; must pull tx_hash on-chain | **做 — 重要缺口**;bounded-live 已在跑,这是"证明能上链"的最后一环 |
| Latency / bid competitiveness | ✅🔶 | candidate cap, TTL, local quote; non-fork-provable, live-gated | keep measuring |

## F. 策略类 / 姿态 (Strategy-class / Posture)

| 方向 | 状态 | 说明 / 证据 | 建议 |
|---|---|---|---|
| Atomic backrun (our class) | ✅ | the production line | keep |
| Spatial / standing-cycle arb | ❌ | 0x4db class; dust | **接口留口子**, 不实现 |
| **Sandwiching (frontrun)** | ❌ | Fable: the non-dust money ($693 tips) lives here; **outside backrun-only posture** | **人类门(rule-14)** — 你拍板;详见下 |
| JIT-LP (mirrored mint/burn) | ❌ | unsupported shape; `realized_profit_usd` often valuation noise | **不做** |

## G. 诊断 / 工具 (Diagnostics)

| 方向 | 状态 | 说明 / 证据 | 建议 |
|---|---|---|---|
| competitor-scan (victim real-block + arb sig) | ✅ | Hermes auto-step | keep |
| live-loss --watch (seenScope/primaryReason/poolInGraph) | ✅ | per-tx classification | keep |
| **venue-gap 5-way + venue-share counts** | ✅ | shipped; `not_seen_venue_gap_types` counter | done — **now dogfooded to measure v4/exotic/sandwich share** |
| hermes-gate 强制四分析 | ✅ | forcing function | keep |

## Recommended sequence (ceiling-aware)

1. **① On-chain inclusion instrumentation** (task #18) — prove `accepted → mined`. This is the one
   gap between "pipeline works" and "we can land a bundle". Highest production ROI.
2. **② v4 depth** — incremental v4 pool-discovery cadence (R11's sharpest lead) so we stop
   re-discovering "100% v4 not in graph" every round. This is where non-dust backrun money is.
3. **③ Posture decision (人类门)** — sandwiching is the only path to the *large* non-dust money in
   our blocks, and it's a deliberate strategy-class change. Escalated to you (see below).
4. **Diagnostic-driven only:** `#3 competitor-path→pool force-include` (cheap, low-risk) — gate on
   the venue-share measurement; if v4 dominates, force-include is subsumed by ②.
5. **Defer (dust):** all exotic-venue **execution** adapters (SmarDex/OUSD/Enzyme/Rigel/DIFX = doc
   Slices 1–4), spatial detection (Slice 5), end-to-end 0x4db replay (Slice 8). Keep the classifier
   pointing at them so the moment one stops being dust, we know.

## Measured (2026-07-03, dogfooded the v4-aware classifier — refines "v4 is the lever")

Ran the Slice-1b classifier over a live 200-block window (competitors coffeebabe + ae2Fc483,
`not_seen` txs), poolId-level v4 membership:

| class | count | meaning |
|---|---|---|
| venue_class_gap | 0 | **no exotic venues at all** — reconfirms defer of SmarDex/OUSD/Enzyme/Rigel/DIFX |
| **pool_gap** | **14** | v4 poolIds competitors used that we DON'T index → true coverage gap (② v4-depth) |
| **detection_gap** | **41** | v4 poolIds we DO index but didn't catch → detection/routing/latency, NOT coverage |
| unknown | 21 | venue unidentifiable (non-v4) |

**Refinement:** the majority of not-seen competitor v4 txs (41/76) touch pools we ALREADY have —
the loss there is detection/admission/economics, not missing coverage. Only 14/76 are genuine v4
coverage gaps. So **② v4-depth (adding pools) addresses the minority**; the bigger lever is
funnel-internal (why we don't act on pools we already index) + ① inclusion. This is exactly the
kind of prioritization the classifier was built to give — it moved "v4 is the lever" from a guess
to "coverage=14, detection=41" with numbers. (Caveats: per-tx summary picks pool_gap over
detection_gap; net_per_block carries the known JIT-LP valuation noise — treat counts as direction,
not P&L.)

## Posture decision escalated to human (rule-14 gate)

**The fork:** our atomic-backrun class is near ceiling on public flow; the only path to the *large*
non-dust money observed in our own blocks is **sandwiching** (frontrun + backrun bracket), which the
project has deliberately avoided (memory: jared-benchmark "ae2Fc483 ≈ sandwich bot, can't match").
Options: **(a)** accept dust-only atomic + push ① inclusion + ② v4 depth (stay in posture); **(b)**
authorize a sandwiching posture (new strategy class, new risk profile); **(c)** deepen v4/large-swap
backrun only (partial reach without frontrunning). This is yours to call — recorded here, not acted on.
