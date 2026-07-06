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

## credit vs protocol-convert — a STRUCTURAL adapter distinction (keep distinct)
Not a strategy call — a shape-of-the-quote fact that determines how a credit adapter is written:
- **`protocol` convert/wrap/redeem** (PSM, ERC4626, wstETH) → a plain TOKEN DELTA. Quotable as `bigint`
  amountOut today (EdgeQuote later); `leavesStandingPosition=false`. Simple to write — deposit/redeem/wrap
  are pure conversions.
- **`credit` borrow/supply** (Aave, Morpho, Fluid) → carries a POSITION by nature → the quote must be
  `positionDeltas`/`constraints`, NOT a `bigint` amountOut (D5). `leavesStandingPosition=true` unless closed
  in-tx (S2 fail-closed). Never a new strategy — it's a LEG.
- **Credit is the HARDER adapter class and is NOT built.** Beyond positionDeltas, a credit leg's value depends
  on the DEX price vs the protocol/oracle price (the arb lives in that gap), so a credit adapter needs a
  market-vs-oracle-aware quote, not a single `amountOut`. We have NOT built this. `fluid-vault` is
  grandfathered/sized by the legacy `fluidDebtBps` grid, not a proper credit quote. So: keep the `credit`
  lineage + classification clean now (this doc), but the credit ADAPTER (Morpho/Aave/Fluid proper) is deferred
  work — reuse boring-vault's `MorphoBlue`/`AaveV3` decoder signatures + the position-defining args when it is
  built, and VERIFY against a real tx log (§ Adapter correctness).

---
> **Scope note:** this doc is the ADAPTER ARCHITECTURE only (lineage / descriptor / reuse / verification).
> The EV / dust-vs-episodic / capture-path / build-or-not decisions for protocol + credit classes live in
> **`docs/decision-log.md` F-007** (two protocol classes: DEX-NAV dust vs credit episodic $100–500) and the
> session handoff — not here. Don't duplicate strategy into the architecture doc.
