# Adapter LINEAGE architecture — classification separated from implementation (2026-07-06)

> Operator-directed design, validated against **Se7en-Seas/boring-vault**
> (https://github.com/Se7en-Seas/boring-vault — Veda's vault framework; its `DecoderAndSanitizer` pattern
> is the on-chain analog of our adapter/classification layer). Companion review:
> `docs/research/design/boring-vault-adapter-review-20260706.md`.

## The rule (one line)
**Adapter is the implementation, lineage is the behavior family, edgeKind is the path semantics — the three
are SEPARATE. Code may split per protocol; the classification vocabulary must NOT fragment.** Adapters can
proliferate; taxonomy stays small. Classification is reused, code is protocol-specific.

```
adapterId       // concrete: how to call / build calldata / quote   (uniswap-v3, pancake-v3, sushi-v3)
lineage         // behavior family / reuse class                    (univ3)
edgeKind        // what leg it is in a path                         (swap | credit | protocol | lp | flash)
protocolAction  // the specific action                             (swap | deposit | redeem | borrow | repay | wrap | unwrap | convert)
```
So: `PancakeV3 → lineage univ3 → edgeKind swap`; `sUSDS → lineage erc4626 → edgeKind protocol`;
`Fluid → lineage fluid-credit → edgeKind credit`. Never `pancakev3-kind` / `susds-kind` / a new strategy.

## Why (what it prevents)
- **No classification explosion**: learning/gap-analysis/planner/venue-discovery keep ONE stable language
  as protocols grow. A competitor using PancakeV3 → we report `adapter=pancake-v3, lineage=univ3,
  edgeKind=swap` = "UniV3-like coverage gap", not a new strategy.
- **Discovery reuses existing adapters**: a new venue is first PROBED against existing lineages (does it
  answer an existing adapter's canAdapt?), reuse the adapter, then protocol-specific micro-adjust — instead
  of "write N new adapters".
- **Analysis ↔ production align**: the same descriptor drives routing, reporting, LearningCase, replay.

## The descriptor (machine-readable, separate table keyed by adapterId — "把 lineage 跟 adapter 分开")
```ts
interface AdapterDescriptor {
  adapterId: string;
  lineage: Lineage;                 // univ2|univ3|univ4|curve|balancer-flash|morpho-flash|psm|erc4626|wsteth|weth|fluid-credit|fluid-dex|erc20-infra|morpho-credit|aave-credit|...
  edgeKind: EdgeKind | null;        // swap|credit|protocol|lp|flash ; null = non-venue infra
  action: AdapterAction;            // swap|deposit|redeem|borrow|repay|supply|withdraw|wrap|unwrap|convert|flash|approve|transfer|guard
  canSendValue: boolean;
  leavesStandingPositionDefault: boolean;   // credit borrow/supply → true; swap/wrap/redeem → false
  quotable: boolean; buildable: boolean;    // wired end-to-end?
  // per-VENUE fields (target, status candidate/approved/routable, forkSimGate) live in venue-registry,
  // which references adapterId — NOT here.
}
```
`ADAPTER_DESCRIPTORS: Record<adapterId, AdapterDescriptor>` + `classifyCall(target, selector) =
matchCall(...) → descriptorFor(id)` + `assertDescriptorCoverage()` (throws if any registered adapter lacks
a descriptor — anti-drift teeth). Classification table for the current 31 adapters is in the descriptor
Codex brief (`scratchpad/codex-descriptor.brief.md`); lineage/edgeKind pinned there.

## Reuse boring-vault — DO NOT reinvent (operator directive)
boring-vault has canonical per-protocol decoders under
`src/base/DecodersAndSanitizers/Protocols/` (~50: ERC4626, MorphoBlue, AaveV3, Curve, UniswapV3,
PancakeSwapV3, BalancerV2, Lido, FluidDex, FluidFToken, PendleRouter, Convex, Gearbox, …).
**They are Solidity (on-chain), so we don't import them as a library — we reuse their PROTOCOL KNOWLEDGE:**
- **Signatures + position-defining args** for each protocol (their decoder tells us exactly which args
  matter). E.g. `MorphoBlueDecoderAndSanitizer`: supply/withdraw/borrow/repay/supplyCollateral/
  withdrawCollateral, position = `(loanToken, collateralToken, oracle, irm, onBehalf)`, `receiver` is not
  position-defining. → our `creditAction` maps 1:1; `leavesStandingPosition = onBehalf==executor not closed
  in-tx`. Reference it instead of reverse-engineering Morpho from scratch.
- **The Protocols/ list = our integration roadmap + classification reference set** — an unknown venue's
  selectors matched against it → instant lineage + a reference impl. It also enumerates the credit/protocol
  venues we lack (MorphoBlue, Fluid, Aave, Curve, Pendle, Gearbox…).
- **What we still write ourselves** (they don't do it — they're a vault, not a searcher): quote (amountOut
  or EdgeQuote), BotVM calldata encode, fork-sim gate, PnL, LearningCase.
- **Do NOT copy**: their Merkle-authorization / Teller / Accountant (vault security model, irrelevant to an
  off-chain atomic-flash searcher).

## Adding a new venue — the workflow
```
scan/discover venue
 → PROBE against existing lineages (ERC4626: asset()+previewRedeem; univ3: token0/token1; morpho: iface; curve: coins/get_dy)
 → matches a lineage?
     yes → reuse that adapter; classification = the lineage's (edgeKind/action); if a behavioral quirk
           (custom revert/maxRedeem/decimals/fee), derive a thin protocol-specific adapter WITH a lineage
           header (derivedFrom / reuses / custom / why-not-base); if NO quirk, just a venue-registry row on
           the base adapter (today's 6 vaults — do NOT make identical files).
     no  → genuinely new behavior: new lineage + (rarely) a new edgeKind/action. Reference boring-vault's
           decoder for that protocol first.
```

## credit vs protocol-convert (keep distinct — boring-vault's Aave/Fluid decoders prove it)
- `protocol` convert/wrap/redeem (PSM, ERC4626, wstETH) → quotable as a plain token delta (bigint amountOut
  today; EdgeQuote later), `leavesStandingPosition=false`.
- `credit` borrow/supply (Aave, Morpho, Fluid) → has a POSITION by nature → must carry positionDeltas /
  constraints, NOT a long-term bigint quote (D5). `leavesStandingPosition=true` unless closed in-tx →
  S2/`.credit-live` gate. Never a new strategy — it's a LEG.

## Status / decision context (do not re-open)
- Building the Morpho credit edge + block-scan scanner for LIVE capture is **de-risk-refuted DUST** (both
  windows measured it 2026-07-06: `blockscan-hunt` fork-solved 4 blocks = zero +EV protocol ring; the vault
  loops net ~$1). So this lineage architecture is built for **classification coherence + future coverage**,
  NOT to chase the dust atomic-arb class now. The Morpho credit adapter, if built, is an OFFLINE `credit`
  lineage exemplar — not wired live (needs `.credit-live` human gate). Needle-mover = posture/ROI.

## Remaining from the unified plan (`unified-strategy-edge-impl-plan-20260704.md`) — consolidated status
Carried here so the incomplete work has one current home. **Verdict column is load-bearing:** the
block-scan/credit tail is MEASURED dust (2026-07-06, decision-log F-007) — most of it should NOT be built.

**DON'T-BUILD (measured dust-bound — chasing them hits the "atomic = market ceiling" wall):**
| slice | what | status |
|---|---|---|
| BS-3 full pipeline | block-scan scan→sim→standalone-bundle→submit | EPIC-blocker RESOLVED-NEGATIVE: `blockscan-hunt` fork-solved 4 blocks = zero +EV protocol/vault ring. Do not wire. |
| BS-lane | concurrent block-scan lane in the live process | not built; don't wire (nothing +EV to run through it) |
| BS-4 | live block-scan dry-run window | blocked on BS-lane; don't |
| CS-min / CS-full / D | strategy-compare + `blockscan-triggers.ts` + dispatcher/auto-close-strategy-gap | Phase 3/4, not built; block-scan-dependent → moot while block-scan is dust |
| B-residual | residual backrun coverage | evidence-gated; not pursued |

**GATED (needs archive / human authorization, not just code):**
| slice | what | gate |
|---|---|---|
| CR-5 | Fluid resolver-quote adapter + deterministic max-borrow (replace `fluidDebtBps` search) | archive RPC + **CR-5b escalated: no deterministic Fluid quote path** (needs a resolver eth_call design). prod OFF |
| CR-6-live | credit live-enable (depeg-gated insertion) | **human gate** (posture) |
| CR-8 | Aave/Euler credit edges | after CR-5; `.credit-live` human gate |
| Morpho Blue credit edge | the missing leg that closes coffee's vault loops (`edge_kind:"credit"`, D2/D5; Fluid is the template; reuse boring-vault `MorphoBlueDecoderAndSanitizer` signatures) | build only as an OFFLINE `credit`-lineage exemplar; live = `.credit-live` gate. EV = dust. |
| MEV-Share submit flag | `SEARCHER_SUBMIT_HASHONLY_MEVSHARE` — 95% of +EV sims self-drop at submit_gate | **the real production needle-mover (flow-admission), a HUMAN-GATE config flip** — not more scaffolding |

**LANDED-BUT-NOT-LIVE-WIRED (small follow-ups):**
| item | state |
|---|---|
| A2 PSM buyGem | encode landed; the DAI→USDC reverse edge is NOT in the live registry (forward-only), so buyGem is unreachable live; anvil fork round-trip fork-sim outstanding. Low EV. |
| Track B B3–B6 | venue-discovery + venue-registry LANDED this session (`e0a223f`/`3df4d0a`); remaining = B3 trace enrichment, the B4 status machine (candidate→approved→**routable**, human gate), B5–B6 feed into classifier + graph |
| tooling_defect (open) | venue-discovery promotes a vault on `asset()`/`previewRedeem` WITHOUT checking a return path exists (DEX venue OR credit edge) — surfaced the "5/6 no-return-path" false-promote; fix = gate promotion on loop-closability |

**The one thing worth doing next (if anything): the adapter descriptor CODE layer is LANDED (`72fbfd9`);
the natural follow-up is wiring `classifyCall` into venue-discovery (replace the topic heuristic) + the
loop-closability check — offline, cheap, improves classification correctness regardless of the dust verdict.**
