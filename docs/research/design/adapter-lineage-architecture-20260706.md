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

## Reuse boring-vault's PROTOCOL KNOWLEDGE — NOT its code (operator directive)
**Explicit: this is NOT "reuse the whole codebase / import their adapters."** boring-vault is a Solidity
on-chain vault; its decoders cannot be a library for our off-chain TS searcher, and we do NOT copy them
wholesale. What we reuse is the **protocol knowledge each decoder encodes** — signatures, which args define
a position, the catalog of protocols. Their per-protocol decoders live under
`src/base/DecodersAndSanitizers/Protocols/` (~50: ERC4626, MorphoBlue, AaveV3, Curve, UniswapV3,
PancakeSwapV3, BalancerV2, Lido, FluidDex, FluidFToken, PendleRouter, Convex, Gearbox, …). Concretely we
reuse:
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
  off-chain atomic-flash searcher); and NOT their Solidity adapters/decoders as code — knowledge only.

## Adapter correctness — VERIFY against a real on-chain tx log (mandatory per adapter)
A descriptor / signature reference (boring-vault or our own guess) is a HYPOTHESIS until it matches real
chain data. **Every new/derived adapter must be validated against a real competitor tx (coffee's txs are
the corpus) BEFORE it is trusted — not just against a hand-written unit fixture.** Two checks:
1. **Decode/classify matches the log**: pull the real tx's receipt (`tx-profit`/`bundle-postmortem` already
   fetch it, or `cast receipt`), and for each call the tx made to that protocol, `matchTrace(target,
   selector)` must fire on OUR adapter and `classifyCall` must return the right `{lineage, edgeKind,
   action}`; the emitted logs (topic0 + which addresses) must be consistent with the descriptor's
   position-defining args. (E.g. steakUSDC/steakUSDT in `0x9be73297`: the Morpho Blue calls must classify
   `credit`, the vault deposit/redeem `protocol`.)
2. **Encode reproduces the on-chain calldata**: our `encode()` for that action, given the same params, must
   produce calldata byte-identical to what the real tx sent to the target (selector + args). A mismatch =
   the adapter is wrong, regardless of a green unit test.
This is the same discipline that caught earlier errors (the hand-decoded profit, the "dead edge" premise):
**ground the adapter in a real tx, don't trust the fixture.** Record the reference tx hash in the adapter's
lineage header. Coffee's already-collected exemplars (`0x9be73297` Morpho+vaults, plus the per-vault txs in
the handoff §5) are the first corpus.

## Descriptor known-issues — FIX BEFORE any production consumer (2026-07-06 fresh-fable review)
The descriptor code (`72fbfd9`) is landed but UNCONSUMED (only its test reads it), so these are latent, not
live. The reviewer's key point: fix them BEFORE wiring `classifyCall` into venue-discovery/routing, else the
first consumer inherits the bug. Ordered by severity:
- **[MAJOR] `matchTrace` is selector-only + target-blind → false positives.** `classifyCall(anyAddr,
  0x2e1a7d4d)` → `{weth, unwrap}`; `deposit()` on any addr → `{weth-deposit-value}`. `withdraw/deposit` are
  everywhere (staking/Yearn). Also `weth-withdraw` + `weth-withdraw-amount` share selector `0x2e1a7d4d` →
  registration order shadows one. FIX: target-check `ADDR.WETH` in the three weth `matchTrace`s + a registry
  gate asserting no two adapters match the same selector without disjoint target predicates. (morpho/balancer
  flash already target-check — follow that.)
- **[MAJOR] `AdapterAction` is a 3rd action vocab that already drifted.** `erc4626-deposit` runtime edge
  carries `protocolAction:"wrap"` (`token-graph.ts:330`) but its descriptor `action:"deposit"` — same adapter,
  two words, no mapping. venue-registry stores `ProtocolAction[]`, so wiring `classifyCall` into it collides.
  FIX: one total `adapterActionToProtocolAction()` map next to the table (gated), or make `AdapterAction` a
  declared superset of `ProtocolAction` with shared members type-identical.
- **[MAJOR] the mandated "verify vs a real coffee tx log" has NO gate/field/harness** — it's prose. FIX: add
  `referenceTx?: string` to the descriptor + a zero-RPC committed-calldata fixtures gate (matchCall fires,
  classifyCall returns the pinned triple, encode() reproduces the bytes); fail on a venue adapter with no fixture.
- **[MAJOR] `quotable`/`buildable` in the doc spec were dropped from the code.** `fluid-dex-swap.encode()`
  throws "not supported in v3.0" but its descriptor is indistinguishable from a wired swap. FIX: add the two
  fields (fluid-dex-swap `buildable:false`).
- **[MINOR] 6/31 descriptors unreachable via `classifyCall`** (univ4-swap/take/sync/settle/settle-value +
  assert-balance all `matchTrace→false`; only top-level `unlock` classifies). Give the v4 leaves their real
  PoolManager selectors or document the hole.
- **[MINOR] polymorphic-selector actions are statically wrong**: `fluid-vault.operate` is sign-polymorphic
  (borrow/repay/supply/withdraw) but labeled `borrow`; `fluid-dex-liquidate` labeled `repay` is really a
  liquidation. `action` is a REPRESENTATIVE label for polymorphic selectors — decode args for the true action
  (boring-vault review learning 3). ("liquidate" added to AdapterAction 0fc3c47-adjacent if pursued.)
- **[MINOR] venue-registry coupling overstated**: `adapterHint?` is unvalidated freetext (no import of
  `ADAPTER_DESCRIPTORS`), status vocab is `candidate|known|routable|excluded` (doc says "approved"). Align +
  validate `adapterHint ∈ descriptors` in the venue-registry gate.
- **[NIT] `assertDescriptorCoverage` has no production caller** — call it at the end of `adapters/index.ts` so
  the process can't boot with a missing descriptor (real teeth vs manual-gate-only).

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

## Status / decision context (corrected 2026-07-06 — do not re-open WITHOUT reading decision-log F-007)
**Two protocol classes, kept separate (decision-log F-007, corrected — the earlier "protocol block-scan is
all dust" here was an OVERREACH the operator caught with `0xf88b`):**
- **DEX-NAV protocol (BS-1c scans this) = genuinely DUST.** `blockscan-hunt` fork-solved 4 live blocks AND
  the `0xf88b` depeg block = zero +EV protocol ring, best ~$0.50; of 11 protocol entries only wstETH/sUSDS
  have a DEX share-venue, both NAV-par. Don't build BS-3 for this class.
- **CREDIT (Fluid/Morpho) = EPISODIC $100–500, NOT dust.** `0xf88b498b…` (block 24710788, from coffeebabe)
  nets ~273 wstUSR + 0.078 WETH during a wstUSR market DEPEG via `flash→Fluid borrow→swap→repay`. BS-1c
  CANNOT see it — it excludes credit/standing edges by design (`blockscan-scanner.ts:247`), which is why the
  hunt saw only DEX dust. **"BS-3-as-built (credit-excluded) sees only dust — a scanner SCOPE limit, not a
  market fact."** The Morpho-vault class (`0x9be73297`, ~$1) is the same shape, smaller.
- **Capability EXISTS; the gate is POSTURE.** `WstUSRArb.t.sol` (AC-3) reconstructs the ~273 wstUSR profit;
  the Fluid credit edge is grandfathered live in the backrun graph (D4) + the solver sizes it (`fluidDebtBps`).
  So the reward is REAL ($100–500/depeg) — which makes the `.credit-live` decision MORE worth taking to the
  operator, not less. This lineage architecture serves that: clean `credit` classification + the Morpho/Fluid
  credit lineage are exactly what a credit-UN-excluded scanner + the `.credit-live` path consume.

## Remaining from the unified plan (`unified-strategy-edge-impl-plan-20260704.md`) — consolidated status
Carried here so the incomplete work has one current home. **Verdict column is load-bearing, and split by the
F-007 two-class correction** (DEX-NAV dust vs credit episodic).

**DON'T-BUILD (the DEX-NAV protocol class is measured dust):**
| slice | what | status |
|---|---|---|
| BS-3 as built (credit-EXCLUDED) | block-scan over DEX-NAV protocol edges only | `blockscan-hunt` = zero +EV; don't wire it FOR the DEX-NAV class |
| BS-lane / BS-4 for DEX-NAV | live lane + window to run the credit-excluded scanner | nothing +EV in that class to run |
| CS-min / CS-full / D | strategy-compare + dispatcher/auto-close | Phase 3/4; only worth it once a +EV strategy class is live |
| B-residual | residual backrun coverage | evidence-gated |

**WORTH-BUILDING but POSTURE/human-gated (the credit class is episodic $100–500, F-007 capture-path):**
| step | what | gate |
|---|---|---|
| 1. `.credit-live` posture | authorize standing-position (credit) submits | **human gate** (Safety Rule 1) — the real decision, reward now known REAL not dust |
| 2. backrun-captures-first | the Fluid loop already routes+sizes in the backrun graph (D4) → captures the proven `0xf88b` exemplar without new code | needs step 1 only |
| 3. CR-5 | deterministic Fluid quote (auction precision over the `fluidDebtBps` grid) | CR-5b escalated: no deterministic Fluid quote path yet (resolver eth_call design). Precision upgrade, NOT a blocker |
| 4. BS-3 credit-UN-EXCLUDED | relax `blockscan-scanner.ts:247` + wire `fluidDebtBps` sizing into block-scan → catch the standing depeg dislocation proactively every block | after 1–3 |
| Morpho/Aave credit edges (CR-8) | `edge_kind:"credit"`, D2/D5; Fluid is the template; reuse boring-vault `MorphoBlueDecoderAndSanitizer` signatures + VERIFY vs `0x9be73297` log | `.credit-live` gate; Morpho EV smaller ($1) than Fluid |
| MEV-Share submit flag | `SEARCHER_SUBMIT_HASHONLY_MEVSHARE` | **already flipped + measured (F-006/D-001): 100% relay-rejected "backrun not found", cause = structural POSTURE (not a code edit).** Real lever = eligible-orderflow relationship, not the flag |

**LANDED-BUT-NOT-LIVE-WIRED (small follow-ups):**
| item | state |
|---|---|
| A2 PSM buyGem | encode landed; the DAI→USDC reverse edge is NOT in the live registry (forward-only), so buyGem is unreachable live; anvil fork round-trip fork-sim outstanding. Low EV. |
| Track B B3–B6 | venue-discovery + venue-registry LANDED this session (`e0a223f`/`3df4d0a`); remaining = B3 trace enrichment, the B4 status machine (candidate→approved→**routable**, human gate), B5–B6 feed into classifier + graph |
| tooling_defect (open) | venue-discovery promotes a vault on `asset()`/`previewRedeem` WITHOUT checking a return path exists (DEX venue OR credit edge) — surfaced the "5/6 no-return-path" false-promote; fix = gate promotion on loop-closability |

**The one thing worth doing next (if anything): the adapter descriptor CODE layer is LANDED (`72fbfd9`);
the natural follow-up is wiring `classifyCall` into venue-discovery (replace the topic heuristic) + the
loop-closability check — offline, cheap, improves classification correctness regardless of the dust verdict.**
