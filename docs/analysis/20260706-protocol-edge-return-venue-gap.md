# Protocol-edge block-scan: measured dust-bound, and vault loops close via credit not DEX — 2026-07-06

> Scope: authorized defensive on-chain arbitrage research; fork/dry-run only, broadcast human-gated.
> Daily Fable analysis (not a full Hermes round). Neutral DeFi framing per Safety Rule 6.

## TL;DR
Two things settle here, one of them a correction to my own first read.

**(1) The DEX-NAV protocol class is empty at measured blocks.** The protocol-aware block-scan
scanner (BS-1c, shipped this session) now detects and prices protocol conversion edges. Run over the
live protocol-enriched graph at 4 recent blocks via the new `searcher:blockscan-hunt` harness, it
surfaces protocol rings (PSM loops appear) but **zero protocol/vault ring is +EV**; the only
positive fork-solves are sub-cent pure-DEX dust (best ~0.0000045 ETH ≈ $0.017, one block 2751 wei,
one block nothing) that is gas-negative live. Of the 11 protocol entries only wstETH and sUSDS even
have a DEX venue for their share token, and both are so tightly NAV-pegged that no standing
dislocation clears fees.

**(2) The vault loops are NOT dead edges — they close via CREDIT, and it's dust.** My first read (in
an earlier draft of this doc) called the 6 vaults with no DEX share-venue "structurally un-closable."
A concurrent session then traced coffee tx `0x9be73297` (touches steakUSDC+steakUSDT): the loop
closes through **Morpho Blue credit** (supply/borrow/withdraw) + vault deposit/redeem — the share is
never DEX-swapped — and nets **~$1** ($4.65 gross; commits `c62fcc7`/`2516ce0`). So the vault path is
real but (a) needs the un-wired Morpho Blue credit edge, (b) is standing-position ⇒ `.credit-live`
human gate, and (c) hits coffee's known dust ceiling.

Both paths — DEX-NAV (measured par) and Morpho-credit (measured ~$1) — land on the same conclusion:
**protocol/atomic block-scan capture is dust-bounded; the needle-mover is a posture/ROI decision,
not the scanner.** Converges with `f2de7499` (oracle-refresh, not a standing dislocation) and the
atomic-backrun market-ceiling finding.

## What was checked (against code + node state, not prose)

### 1. Share-token DEX venues in the live universe
Node `active-pools.json` (4838 pools; gitignored, node-only), exact token0/token1 match:

| protocol entry | share token | live DEX swap venues | DEX-closable? |
|---|---|---|---|
| wstETH wrap/unwrap | wstETH | **7** (univ3 vs WETH, vs USDC; univ2 vs DAI; …) | yes |
| sUSDS erc4626 | sUSDS | **2** (univ3 `0x0858e2B0`, `0xD80e75fA`) | yes |
| wstUSR erc4626 | wstUSR | 0 | no (Fluid credit only) |
| steakUSDC / steakUSDT | steak* | 0 / 0 | no — closes via **Morpho credit** |
| srUSDe | srUSDe | 0 | no |
| sfrxETH | sfrxETH | 0 | no |
| waEthUSDT / waEthUSDC | waEth* | 0 (Balancer-boosted; no Balancer **swap** adapter) | no |
| PSM USDC↔DAI | — | deep on both legs | yes (grandfathered) |

Underlyings usually have venues (stETH 6, USDS 15, USDe 26, frxETH 4); the **share tokens** mostly do
not. But "no DEX share-venue" ≠ "no arb": as (2) shows, coffee closes the steak* loops through Morpho
Blue credit, not a DEX swap. The correct read is that a share token needs *some* return path — DEX
**or** credit — and the credit path is a standing-position leg behind a separate human gate.

### 2. The curve venues for sUSDS/wstUSR are test-only
`defaultTokenGraph()` (token-graph.ts:423) wires `CURVE_SUSDS_USDT`/`CURVE_DOLA_SUSDS`/
`CURVE_DOLA_WSTUSR`, but grep confirms **`defaultTokenGraph` is not referenced by `main.ts`** — it is
a fixture. `POOL_REGISTRY` (the live source) has none of those curve pools and they are absent from
the universe. So sUSDS's live return path is its 2 univ3 pools; wstUSR has no live *swap* return
venue (Fluid credit only).

### 3. BS-1c — the scanner can now see + price protocol edges
`detectBlockScanOpportunities` grouped/priced swap pools only. **BS-1c** (`0a1984c`) adds an optional
`protocolMids` input, admits non-standing protocol edges, prices them by map lookup (direct or
`1/mid` reverse; reserves synthesized so `estimateSizing` is unchanged), seeds `anchorTokens` from
protocol-edge tokens (a NAV dislocation rarely forms a same-pair 2-venue spread, so the ring search
must be seeded there), and skips standing-position rings. Undefined `protocolMids` = byte-identical
prior behavior. Gate: `searcher:blockscan-scanner` 14/14 (T-nav-dislocation flip + par control +
standing-ring reject + missing-mids no-regression); planner/replay/taxonomy/contract unchanged.

### 4. The hunt — measured +EV/−EV over the real enriched graph
`searcher:blockscan-hunt` (this session): loads the live universe + POOL_REGISTRY protocol edges,
warms v2/v3/curve state at a pinned block, computes `protocolMids` from live
`previewDeposit`/`previewRedeem`/`getWstETHByStETH`/PSM-`tin`, runs BS-1c, then fork-solves the top
candidates against a local anvil fork (read-only; nothing signs/broadcasts). Ran on the node against
the live reth (worktree, live searcher untouched). Per-block:

| block | candidates | protocol rings found | +EV solves | best net | +EV ring is protocol? |
|---|---|---|---|---|---|
| 25470505 | 24 | 2 (PSM) | 1 | ~0.0000045 ETH (~$0.017) | no (univ2/univ2) |
| 25470025 | 24 | ≥1 (PSM) | 1 | ~0.0000045 ETH | no (univ2/univ2) |
| 25468325 | 24 | ≥1 (PSM) | 1 | 2751 wei | no (curve/curve) |
| 25466325 | 24 | ≥1 (PSM) | 0 | none | — |

The scanner detects and prices protocol rings (PSM loops surfaced and were fork-solved), confirming
BS-1c works on real state. But every protocol ring fork-solved to *no profitable amount*, and every
positive solve was a pure-DEX dust loop with no gas floor in the harness (2751 wei and 0.0000045 ETH
are both far below gas ⇒ negative live). **No capturable +EV protocol dislocation at any sampled
block.** Caveat: 4 blocks is a sample, not a census; the claim is "no standing DEX-NAV protocol arb
in this window," corroborated by the pegged-asset structure and the credit-path evidence in (2).

## Consequence for the plan
- BS-3 (scan→sim→standalone bundle) stays EPIC-blocked: the hunt found **no viable +EV DEX-NAV
  exemplar**, and the one real protocol/vault exemplar (`0x9be73297`) is Morpho-credit + dust +
  `.credit-live`-gated. Wiring the live block-scan lane now would chase a dust-bounded class.
- The real next lever is the **Morpho Blue credit edge** (supply/borrow/withdraw/repay) — the missing
  leg that closes the vault loops — but its EV is ~$1/tx and it is a standing-position / human-gate
  class. That is a posture/ROI decision for the operator, not a capability build.
- Keep BS-1c + the hunt harness: they are the instrument that turns "is there a +EV protocol loop?"
  from a prior into a measurement, re-runnable at any block.

## Method Trace
task_class:       protocol_leg
tools_used:       - Explore agent x2 (scanner-state map; share-token venue map)
                  - SSM read-only: node active-pools.json token0/token1 match; reth prune-window probe; worktree hunt runs (3 blocks + 1)
                  - Read: blockscan-scanner.ts, token-graph.ts, pool-state-cache.ts, blockscan-fork-solve.ts, unified-strategy-edge-impl-plan
                  - codex-run.sh (BS-1c + hunt-harness generators); evaluator re-ran every gate + applied 2 fixes
                  - searcher:blockscan-hunt (new harness) fork-solving top-K over the live graph
evidence_order:   1. live active-pools.json (node truth) 2. scanner/cache source 3. fork-solve measurement 4. concurrent-session trace of 0x9be73297 5. compared to handoff claim
analysis_frame:   - strategy_kind first (block-scan), edge_kind second (protocol vs credit)
                  - loop-closability (does a return path exist — DEX OR credit?) before "add coverage"
                  - probe (convertible) vs venue (DEX-traded) vs measured EV (fork-solve) — three distinct gates
                  - fixed vs implemented: BS-1c gated by a replay flip; the hunt is a live-fork measurement not a backtest
                  - dust honesty: netProfit with no gas floor ⇒ 2751 wei is not +EV
sanity_checks:    - exact token0/token1 match not substring - universe vs POOL_REGISTRY vs test fixture separated
                  - reth prune window verified before picking a fork block - worktree run never touched the live /opt/MEV checkout or restarted the searcher
                  - fork-solve rejected the trillion-bps decimal-artifact candidates (junk) - my own "dead edge" conclusion refuted by the credit trace and corrected here
tool_gap:         (a) venue-discovery classifies an ERC4626 as loop-closable from asset()/previewRedeem WITHOUT checking a return path exists (DEX venue OR credit edge) — filed as a tooling_defect. (b) blockscan-hunt harness had two generator bugs the evaluator fixed (v3 ticks metadata-only seeding; solver must read the fork not the detection cache) — codified in the commit.
codify_next:      tooling_defect LearningCase (share-token return-path gate in analysis/src/discovery) — FILED (open). Consider a startup-banner count of loop-closable protocol edges.
distill_for_opus: "Convertible" (probe) ≠ "loop-closable" (a return path exists) ≠ "+EV" (fork-solve clears fees+gas). Check all three before treating a venue as capture. And the return path can be CREDIT, not just a DEX swap — absence of a DEX share-venue does not make a vault edge dead; trace the competitor before concluding.
