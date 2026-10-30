# `fluid-dex` — parked declarative draft and blockers (2026-10-30)

Status: **blocked / not migrated**. The handwritten `fluid-dex.production.ts` remains the
production entry. No live/VM/RPC, no signing, no public framework TS/test change, no
production generator run, no generated artifact.

Files parked here:

- `fluid-dex.draft.json` — partial `swap-json-v2` draft. It is **not importable and not a
  deliverable**: the blocked sections are omitted or explicitly disabled (see below), and
  no placeholder ABI or placeholder identity was invented.
- `fluid-dex.blockers.md` — this file.

Framework baseline: merged `47422c97` (directional execution, quoteOutput exports,
zero-output exact with unavailableReason, conditional trialState, frame expressions, receipt
observation enrichment) on top of the Swap/Credit JSON handoff.

## What is faithfully expressible (and validated in-memory)

- **Manifest/scope/activation**: family `fluid-dex`, lineage `fluid-dex:factory-child`,
  activation `SEARCHER_FAMILY_FLUID_DEX_ENABLED` (enabled), one owned action
  `fluid-dex-swap`, no infra actions, `poolAdapterIds ["fluid-dex"]`,
  `edgeAdapterIds ["fluid-dex-swap"]`.
- **Discovery** (`declarative-discovery.ts` v2 mapping): `swapIn(bool,uint256,uint256,address)`
  call pattern (candidate address from call target), `dex-token-domain` candidate source, the
  `fluid-dex:constantsView+swapIn` address surface (candidate address from emitter),
  labels `["fluid-dex","fluid"]`, address-surface nomination, candidate/instance key = pool.
  Validated: canonical call and address-surface candidates decode to the pool; bogus calldata
  returns `null`.
- **Instance/binding projection**: pool, raw constants tokens, graph tokens, decimals,
  `factoryBinding {factory,dexId,reverseDex}` and `quoteBinding {target,recipient:
  ADDRESS_DEAD,completion:"return-or-revert-data",successEncoding:"FluidDexSwapResult(uint256)-revert"}`
  plus the two pinned-block runtime requirements (`instance.ts:9-18,50-71`). Validated with a
  synthetic descriptor.
- **Routes**: both directions (`swap0-to-1` / `swap1-to-0`), the legacy
  `familyId␟pool␟tokenIn␟tokenOut␟0-1|1-0` key (`routes.ts:37-69`), native/erc20
  `executionAssets` derived from the raw constants tokens (Fluid native sentinel,
  `codec.ts:6-13`), `swap0To1`/pool route fields, `{kind:"address-pool"}` venue. Validated.
- **Price projection shape**: `pricingProjection.rows` can express the legacy
  `quotedPoolMid` values (`pricing.ts:124-138`: mid = amountOut/amountIn,
  reserveA = amountIn×10⁴, reserveB = amountOut×10⁴, depth = min), `refreshPolicy:
  "each-block"`, `stateKey = route.routeKey`, `mutationKinds ["log"]`, pool/quote-target
  dependencies and the pool-only mutation addresses. Not run end-to-end because the state
  read itself is blocked (G-FL-4).
- **Execution shape**: v2 steps can express the payable `swapIn` call with the runtime input
  patch, recipient/minOut arguments, exact-clear approval, native/erc20 debit-credit effects
  and `directOutput`. The draft compiles both the native-input and token-input runtime legs
  through `buildDeclarativeExecutionProgram`/`buildDeclarativeRuntimeLeg` (validated).

## Gaps (blocking)

**G-FL-1. Topic-only landed event has no canonical ABI.**
`fluid-dex-family/swap.ts:21-37` declares the receipt observer from
`FLUID_DEX_SWAP_TOPIC` only (`codec.ts:16-19`: "receipt-verified topic has no public stable
event ABI"), with `observation.decode: () => []` (`swap.ts:26`). Discovery mirrors it with a
non-ABI signature string `"FluidDexSwap(receipt-verified-topic)"` (`discovery.ts:30-32`).
Declarative mapped discovery requires a parseable `EventFragment`
(`declarative-discovery.ts:213-225`; `EventFragment.from("FluidDexSwap(receipt-verified-topic)")`
throws `invalid event fragment`), and the declarative Swap domain requires every event to be
either one canonical ABI event or a bounded anonymous packed layout
(`declarative-event-codec.ts:10-27`; `declarative-swap-domain.ts:23-34`). There is no
topic-only declaration, so neither the landed-log discovery pattern nor `swap.events` can be
authored without inventing an ABI. The draft therefore omits `landed-log` from discovery and
leaves `swap.events` empty (intentionally invalid).

**G-FL-2. "No receipt impact" cannot be declared.**
The legacy observer returns `[]` for every matched trigger
(`swap.ts:34-36`, `createStrictSwapObservation` wrapper) so the strict session reports the
group as unresolved (`test/strict-receipt-authority.ts:311-333`). The declarative Swap
domain always maps each owned trigger to either a `PoolImpact` or a `mutationOnlyReason`
(`declarative-swap-domain.ts:202-223`) and always emits a `canonicalPayload` for a decoded
observation (`:104-108`). A declarative event can fail closed (throwing yields `unresolved`),
but it cannot express the "resolved with zero impacts/no mutations" legacy result for a
topic-only event, and it cannot express "observation returns no decoded events" without
failing the same decode used by `landedEvents.classify`. This is a declaration-shape gap,
not an optional trimming.

**G-FL-3. Identity asset metadata hook is not declarable.**
The legacy identity variant declares `assets(input)` and uses central
`IdentityAssetMetadata` for graph denominations, decimals, ERC20 code evidence and the
native sentinel mapping (`identity.ts:48-52,68-80,186-220,222-229`; probe sizes use
`assetDecimals` at `:124-139`; asset code evidence is referenced by
`identityAssetRequestId` at `:270`). The declarative identity document has no `assets` hook
and its decode environment exposes only candidate/evidence/step/results/profile/constants
(`declarative-identity.ts:31-116`, environment at `:90-91`). Without asset metadata the draft
cannot faithfully produce `token0/token1` graph tokens (WETH alias for Fluid's native
sentinel), `token0Decimals/token1Decimals`, the ERC20 code rejection, or the per-direction
probe amounts; adding family-owned reads would replace a central authority, not migrate it.
The draft therefore omits `identity.definition` (intentionally invalid).

**G-FL-4. Declared-revert custom-error quote cannot become verified quote evidence.**
Both pricing and exact call `swapIn` with `ADDRESS_DEAD` and expect a
`FluidDexSwapResult(uint256)` custom-error revert (`pricing.ts:89-123`, `exact.ts:31-70`,
`codec.ts:119-163`; identity probes at `identity.ts:124-164,231-246`). Declarative read
flows decode results through `returned`/`decode`, which require completion `"returned"`
(`declarative-values.ts:199` → `protocols/standard-family/common.ts:123-131`). A custom-error
revert can be read with the raw `result` op plus `bytes`/`uint` ops, but the exact path then
needs a chain-quote proof: `quoteFlow.sourceKind` is limited to `view` /
`effect-simulation` / `local-math` (`declarative-family-modules.ts:64-88`);
`view` proof requires canonical ABI **return** encoding and optionally
`completion:"reverted-as-declared"` only through `decodeFunctionResult`
(`declarative-quote-proof.ts:46-53,91-103`), which a custom-error payload does not satisfy;
`effect-simulation` requires observed token deltas (`:106-117`). Claiming `local-math` would
be false (the amount comes from chain execution), and `exact.unavailableReason` would delete
a real capability. So no faithful pricing/exact declaration exists today.

**G-FL-5. Runtime `quote-output` preparation depends on the same revert decoder.**
`execution.ts:17-37` serves `quote-output`/`direct-output` settlements with
`fluidDexRuntimeQuote` (`raw-execution.ts:55-64`), which issues a `revertBytes: 36` call and
decodes the custom-error payload in the runtime program. Declarative `quoteOutput` steps are
static calls that can only `save` ABI **return** words (`declarative-execution.ts:124-146,
194-206,601-638`); `RuntimeAmountProgram.call({revertBytes})` is not reachable from JSON.
`supportsDeclarativeSettlement` additionally rejects `quote-output` for native routes
(`declarative-execution.ts:857-868`). The default/direct legs are expressible (validated),
but the family's quote-output settlement path is not.

**Secondary, same root cause (not separately blocking).** Declarative identity stages accept
arbitrary request objects, but the active-quote probe results are `return-or-revert-data`
(`identity.ts:53-66,124-164`); decoding them needs the raw-result + custom-error path above,
and the reverse-binding decode also consumes `input.assets` (G-FL-3).

## Draft contents / omitted parts

Authored in `fluid-dex.draft.json`: scope/production/manifest, discovery definition without
`landed-log`, instance/binding projection, routes, root pricing skeleton (draft/compat/
static/finalize/sampleAmount/exactCompatibility/mutationKinds/stateKey + standard pricing
policy), execution v2 (both directions), action adapter, and an `exact` block that is
explicitly `{unavailableReason: ...}` so nothing pretends to quote.

Intentionally omitted/invalid: `identity.definition` (G-FL-3), `swap.events` (G-FL-1/2),
`modules.pricingFlow` / `modules.quoteFlow` / pricing projection (G-FL-4; the projection rows
are authored only in this report, not in the JSON, to avoid a state read that cannot exist),
and `quoteOutput` (G-FL-5). The draft is therefore not registered, not generated and not
imported anywhere.

## Verdict

Stop per migration policy: `fluid-dex` is **not faithfully expressible** on the current
framework. The missing pieces are declaration capabilities, not optional trimming:

1. a topic-only (no public ABI) landed-event declaration that preserves the owned trigger,
   `classify` and "resolved with no impact" receipt semantics;
2. an identity `assets`/central-asset-metadata read hook (native sentinel mapping, decimals,
   ERC20 code evidence) in the declarative identity document;
3. a declarative chain-quote proof for declared custom-error revert completions (and the
   matching read-flow/`quoteOutput` decode), so pricing/exact and the runtime quote-output
   preparation keep their actual amount source;
4. if quote-output is migrated later, native-route settlement support for that path.

Revisit when (1)–(3) exist. Until then the handwritten TS entry stays authoritative. The
existing central regression `test/strict-receipt-authority.ts:311-333` continues to pass
against that entry and must be re-run after any future fluid migration.
