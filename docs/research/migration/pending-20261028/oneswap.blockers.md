# `custom-swap:oneswap` — parked declarative draft and blockers (2026-10-30)

Status: **not migrated**. The handwritten `oneswap.production.ts` remains the only production
entry (activation `enabled: false`, `SEARCHER_FAMILY_ONESWAP_ENABLED`). No production entry,
generated artifact, live/VM/RPC run, signing or broadcast was performed.

Framework baseline: merged `47422c97` (directional execution, quoteOutput exports, zero-output
exact with `unavailableReason`, conditional trialState, callback-frame expressions, receipt
observation enrichment).

Files parked here:

- `oneswap.draft.json` — **partial, non-importable** draft. It carries only the parts that are
  semantically stable (scope/production/manifest, mapped discovery, action/trace declaration).
  It deliberately has `_status`/`_blocker` keys and no `identity`/`instance`/`routes`/`pricing`/
  `standard` sections, so the production loader and generator must reject it.
- `oneswap.blockers.md` — this file.

## Source of truth read

`listener/src/searcher/venues/swaps/oneswap-family/{action,capture,codec,discovery,exact,execution,identity,instance,manifest,math,pricing,proxy,routes,runtime-execution,state,swap,types}.ts`
and `test/{contract,fixtures,historical-ready,historical-recipient}.ts`.

## What the partial draft already expresses (validated in-memory)

`compileDeclarativeDiscovery(oneswap.draft.json#discovery.definition)` compiles and produces:

- one call pattern `oneswap-market-order` with selector `0xa6e81533` from
  `function addMarketOrder(address,address,uint112) payable returns(uint256)`; a canonical
  call observation for the recorded ABI decodes to `{candidateKind:"oneswap",pool:<call target>}`;
- the three canonical events `NewMarketOrder(uint256)`, `DealWithPool(uint256)` and
  `OrderChanged(uint256)`, each mapped to the emitting pool;
- the `oneswap-interface` address surface (`oneswap-amm-orderbook-v1`) and candidate/instance
  key = lower pool address.
- scope/lineage/activation/action descriptor exactly match
  `oneswap-family/manifest.ts:6-10`, `action.ts:6-14` and `production-families/oneswap.production.ts:15`
  (`enabled:false`, `SEARCHER_FAMILY_ONESWAP_ENABLED`, owned action `oneswap-market-order`).

## G-OS-1 (decisive) — the execution amount is `uint112`; declarative v2 rejects it

The family's only swap operation is

```solidity
function addMarketOrder(address stock, address money, uint112 amount) payable returns (uint256)
```

(`oneswap-family/codec.ts:15`). The handwritten runtime program transfers the ERC-20 input to the
pool, then patches the **third** ABI word (`offset 68`) with the runtime amount and, for native
input, also sends `amountIn` as `msg.value`
(`oneswap-family/runtime-execution.ts:33-36`, `codec.ts:19`; the native/ERC-20 split is at
`runtime-execution.ts:19-28,37-44`).

The declarative v2 call compiler derives patches with `encodeDeclarativeCall`, whose scalar leaves
are restricted to `uint256`, `int256` and `bytes32`
(`listener/src/searcher/venues/declarative-call-codec.ts:35-40`);
a runtime reference on any other ABI type throws
`runtime ABI references require uint256 or bytes32 leaves (full-width int256 also supported)`
(`declarative-call-codec.ts:53-58`). Executed probe:

```
encodeDeclarativeCall(
  "function addMarketOrder(address,address,uint112) payable returns(uint256)",
  [pool, recipient, { runtime: "amountIn" }],
) -> runtime ABI references require uint256 or bytes32 leaves (full-width int256 also supported)
```

The v1 execution path is not a faithful fallback. It permits dynamic scalar words (so `uint112`
would pass `scalarWord`/the v1 offset loop), but v1 supports exactly one call and no step conditions
(`listener/src/searcher/venues/declarative-execution.ts:468`), while native/ERC-20 debit semantics,
`value`, and per-call `when` are only defined for v2
(`declarative-execution.ts:381-388,404-413`). Oneswap needs at least:

- optional `transfer(rawIn, pool, amountIn)` before the market call for ERC-20 input
  (`runtime-execution.ts:33`), and no transfer for native input;
- `msg.value = amountIn` only for native input (`runtime-execution.ts:34-36`);
- debit/receipt checks for both native and ERC-20 sides (`runtime-execution.ts:27-44`).

There is no JSON-only workaround: the selector is fixed by `addMarketOrder(address,address,uint112)`,
so declaring a `uint256` variant would execute different calldata; passing a literal is impossible
because the amount is invocation-local; and omitting execution would leave Exact quoting without a
settlement path (not a migration).

## G-OS-2 (secondary, same class as the precision-pool deviation) — swap classification vs mutation-only receipt

The handwritten family classifies all three events as `"swap"` for landed observation
(`oneswap-family/swap.ts:7`) but its strict receipt decoder returns `mutationOnlyReason` for every
matched trigger (`swap.ts:14-18`). The declarative Swap domain only selects the mutation-only branch
for an event whose `classification` is `"mutation"`
(`listener/src/searcher/venues/declarative-swap-domain.ts:202-205`); a `"swap"`-classified event must
evaluate a full `PoolImpact` (`:206-222`) or the receipt becomes `unresolved`
(`swap-observation.ts:278-287`). Declaring the events as `"mutation"` preserves the resolved
mutation-only receipt but changes `landedEvents.classify`/`isSwapLog` telemetry
(`searcher/strict-production-family-declarations.ts:347`) and the reason text
(`"declared state mutation"` vs the legacy per-family reason). This is the same fail-closed/
legacy-shape deviation recorded for `precision-pool`; it is not the reason this family is parked.

## G-OS-3 — remaining domains are probably expressible but were not authored

The orderbook quote is a bounded pure function of state (`oneswap-family/math.ts:4-98`): expand the
27-bit price mantissa/exponent, `intoPoolTillPrice` (Taylor branch/truncation/stockUnit rounding),
maker fills, aggregate output fee and incomplete-prefix rejection. A declarative `math` model can
carry it (the engine supports arbitrary stateless model entries), and pricing/exact can bind it over
the 9 state reads in `state.ts:10-15`; the 64-word order-list chains and proxy/factory identity can
use `maskHash`/`bytes`/`word` expressions. None of that was authored because G-OS-1 makes the family
non-deliverable; authoring it would create a large draft that still cannot settle a swap.

## Validation performed

- `compileDeclarativeDiscovery` on the parked definition: PASS (pattern/candidate/key output above).
- Source/action/scope transcription checked against the files listed above; no framework TS/test or
  generated artifact changed.
- No `compileDeclarativeSwap`/`defineSwapFamily` registration is claimed: the draft is intentionally
  incomplete, and the handwritten entry remains active.

## Re-entry condition

A shared declarative call capability that (a) patches a fixed-width `uintN`/`intN` ABI leaf with
explicit range checking, and (b) supports the same conditional value/transfer/effect shape as v2
(`declarative-call-codec.ts:35-58` + v2 step/effect compiler), would unblock G-OS-1. G-OS-2 needs a
domain declaration for a `"swap"`-classified event whose receipt contribution is mutation-only (or a
custom mutation reason). Until then the family must stay parked; do not narrow execution or Exact.
