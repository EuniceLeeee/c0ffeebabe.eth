# univ3-standard — blocked (zero-output tick window, dynamic tick reads, call observation)

> **Re-attempt against merged framework `b8b02479` (2026-10-30 17:5x) — supersedes the gaps below.**
>
> A new draft (`univ3-standard.draft.json`, 9.3k lines) plus math models
> (`univ3-standard-math.ts.draft`) was authored and exercised in-memory. All six domains except
> execution now compile and match the handwritten family; **one hard generic gap remains: the
> declarative callback frame requires literal call targets, so a V3 callback that must pay an
> invocation-dependent token cannot be emitted.** The earlier gaps 1–3, 6 are closed by `b8b02479`
> (zero-output `unavailableReason`, `stateOnlyReads`, conditional `trialState`, `when`-selected
> directional execution); gap 2 (tick-lens) is expressible as one fixed 49-word dependent round and is
> validated. Details and the exact framework change are in “Re-attempt status” below; the original
> 2026-10-30 15:56 analysis is kept verbatim after it.
>
> ## Re-attempt status (merged `b8b02479`)
>
> Draft: `univ3-standard.draft.json`; math: `univ3-standard-math.ts.draft`; harness:
> `univ3-standard.harness.ts.draft`; blocker repro: `univ3-standard.frame-blocker.ts.draft`.
> The earlier 2026-10-30 15:56 draft is archived unchanged as
> `univ3-standard.draft.pre-b8b02479.json`; the analysis below it is kept verbatim for history.
>
> Validated in-memory with the proposed math models registered (19 checks, all green except execution):
> compile/`createDeclarativeSwapRuntime`/`defineSwapFamily`; mapped discovery (`PoolCreated` →
> pool/factory/token0/token1/fee/tickSpacing hints, lower-address candidate key); two-round staged
> identity, including `chain-proven-rejected` for hint mismatch and for a forged/pinned-revert
> `getPool`; `bytecodeGetter` instance evidence for `isSwapper` (`is-swapper` /
> `no-is-swapper-getter` / `unsupported`); two directed routes (production `routeKey` shape);
> pricing flow (slot0/liquidity + conditional Quoter V2 precision probes, inactive-pool
> classification, both mids); exact local-math flow for **all three** state paths:
> 1. canonical/pancake aggregate reader (`local-pool-state`),
> 2. factory-agnostic TickLens 49-word fixed window (`local-slot0`/`local-liquidity` + 49 words),
> 3. `is-swapper` access round with source-bound request id, and `unsupported` bytecode failing closed
>    without a chain call.
> The declarative local quote equals the production `createUniV3Exact()` result bit-for-bit
> (`9895553` on the fixture state) for both the aggregate and TickLens paths; a positive-input zero
> quote returns `amountOut: 0n` with a non-empty `unavailableReason` and cannot be executed; no-getter
> pools bootstrap a conditional `trialState` from the cold read (1 change, 5 effects), `is-swapper`
> pools return `unsupportedReason: "univ3 swap-access trial-state dependencies are unproven"`.
> `src/searcher/test/univ3-family-plugin.ts` still passes on the handwritten entry; the 33 framework
> tests touched by the new math registration (`declarative-trial-state`, `declarative-exact-unavailable`,
> `declarative-modules`, `declarative-swap-observation`) pass.
>
> ### Gap E-U3-1 (hard, execution): callback-body call target must be a literal
>
> `univ3-family/runtime-execution.ts:34-52` makes the pool callback pay the input token
> (`uniswapV3SwapCallback` → `transfer(tokenIn, pool, debt)`); `tokenIn` is the route token, i.e. only
> known per invocation. Declarative frames resolve the whole frame per invocation
> (`venues/declarative-execution.ts:512`), but registration first validates the **unresolved**
> declaration (`:780`, `:788` via `validateSettlementDeclaration` ← `supportsDeclarativeSettlement`
> `:819`), and `venues/declarative-callback-frames.ts:138` rejects any callback `call.target` that is
> not a string. A descriptor- or route-dependent token/outer target therefore throws
> `invalid callback call declaration` before emission; `buildFragment` fails at
> `venues/declarative-family.ts:709` → `declarative-execution.ts:298`. Minimal repro:
> `univ3-standard.frame-blocker.ts.draft`.
>
> Required generic capability (no protocol semantics): allow `DeclarativeCallbackFrame.call.target`
> (and, if desired, `signature`) to be a declarative value expression, validating the **resolved**
> spec in `emitDeclarativeCallbackFrame` (already called with `resolved(step.frame)`), e.g. skip the
> literal-type check at registration when the value is a pure `{op|args}`/reference node, and
> `getAddress`/`new Interface(signature)` the resolved value there. JSON alone cannot work around
> this: the transfer must execute in the callback, and only the frame emitter can build the payload.
>
> ### Gap E-U3-2 (documented by the framework, fail-closed): deferred-input settlement
>
> `univ3-family/runtime-execution.ts:36-55` supports `deferred-input` with `deferredDebtInput` and the
> pool as deferred recipient. The declarative `framedSettlement` requires a parent `expectedOutput`
> witness (`venues/declarative-execution.ts:519`, design doc §6/§8: “only known inside the callback
> and without a parent witness is unsupported”), and the shared runner still rejects
> deferred-input/deferred-debt/settle-output without real callback execution tests. The draft declares
> only `settlement.directOutput`; deferred settlement stays rejected (capability not migrated, not
> weakened).
>
> ### Deviations recorded (no check weakened)
>
> 1. Discovery `sources`: `factory-log` is not in the mapped discovery enum
>    (`venues/declarative-discovery.ts:123-127`); draft uses univ2's accepted
>    `landed-log/observed-call/address-surface` set. PoolCreated decode/poolMaterialization remain.
> 2. Nomination: the recent-Swap-log provider (`univ3-family/nomination.ts`) is replaced by
>    address-surface nomination + `nominationReadFlow` (factory/token0/token1/fee at the source block),
>    the same substitution accepted for univ2; identity still re-verifies all five pool fields and the
>    factory reverse binding on chain.
> 3. Landed/observation/receipt patterns are the union of declared events
>    (`venues/declarative-swap-domain.ts:88-111,104-111`): PoolCreated/Initialize/Mint/Burn become
>    owned triggers, whereas the handwritten `swap.ts:32-59,80-85` lands only swap/mint/burn and
>    observes only swap topics. This is a superset (more receipts classified), not a narrowed check.
> 4. Pricing mid metadata: `pricingProjection` rows cannot carry `kind: "v3"`, `sqrtABX96` or
>    `liquidity` (`venues/declarative-pricing-projection.ts:31-38`), and `feeBps` must be an integer
>    (`:26-28`) while production publishes `Number(fee)/100` (`univ3-family/pricing.ts:195`). The
>    ratio, reserves, depth, pool and fee (rounded to whole bps) match; telemetry loses the v3 kind and
>    sqrt/liquidity fields. Odd fee tiers (not multiples of 100 ppm) lose sub-bps precision.
> 5. Exact evidence cannot carry quote-derived fields: `buildFragment` re-derives evidence and compares
>    hashes (`venues/declarative-family.ts:745-749`), so `sqrtPriceX96After`,
>    `initializedTicksCrossed`, `gasEstimate` are dropped; `direction` and `bindingFingerprint` are
>    added because the trial-state issuer requires them (`venues/declarative-trial-state.ts:148-151`).
> 6. Exact method id is fixed (`local-pool-state`) instead of the descriptor-selected
>    `local-state-49`/`local-ticks-49` (`univ3-family/exact.ts:170-172`); the declarative method id is
>    static per variant (`venues/declarative-family.ts:611`). Cache/continuity shape only.
> 7. Zero-output exact gains a required `unavailableReason` (`venues/declarative-family.ts:700-701`);
>    production zero evidence carries none. Stricter, not weaker.
> 8. Mutation predicate reproduces the five-topic filter (`univ3-family/pricing.ts:49-55,259-269`) as
>    a declared predicate (`venues/declarative-family.ts:574-583`); the TS `accept` callback is not
>    declarable, so any same-pool log topic outside those five no longer invalidates. The predicate is
>    evaluated in both mutation paths.
> 9. `hintedTickSpacing` is declared `uint` and compared by value (`str(hint) === str(on-chain)`)
>    because mapped `number` fields reject ABI-decoded bigints
>    (`venues/declarative-discovery.ts:112-114,260`). Equal spacings pass, any other value rejects; a
>    non-safe/negative value cannot be represented and therefore never verifies.
> 10. Victim replay uses math models for `v3SwapToState`, the exact post-state and
>     `buildApprovedSwapVictimOverlay` (whale/deal/storage-layout knowledge stays in TS); the JSON
>     passes impact/route facts only. `victimSupport: "replay"` is preserved.
>
> ### To finish after the framework change
>
> 1. Move `univ3-standard.draft.json` to `listener/src/searcher/venues/swaps/univ3-family/univ3.json`
>    and `univ3-standard-math.ts.draft` to `.../univ3-family/math.ts`; append
>    `import { univ3MathModels } from "./swaps/univ3-family/math.js";` and `...univ3MathModels,` to
>    `venues/declarative-math-models.ts` (append-only, re-read first).
> 2. Regenerate the production entry with `build-declarative-production` (generator, not hand-written;
>    activation `SEARCHER_FAMILY_UNIV3_STANDARD_ENABLED`).
> 3. Re-run `univ3-standard.harness.ts.draft` (copy to `listener/.scratch/univ3-check.ts`,
>    `npx tsx .scratch/univ3-check.ts`), then `tsc -p listener/tsconfig.live.json --noEmit`,
>    `npm run build:live`, the family/manifest suites, and a temporary rendered entry against
>    `src/searcher/test/univ3-family-plugin.ts` fixtures.

# univ3-standard — blocked (zero-output tick window, dynamic tick reads, call observation)

Family: `univ3-standard` (`univ3-family`), lineage `univ3:factory-child`,
activation `SEARCHER_FAMILY_UNIV3_STANDARD_ENABLED` (default enabled).
Status: **blocked**. Handwritten TS entry left untouched. Partial mapping draft parked at
`univ3-standard.draft.json` (not deliverable, not importable).

## What the framework can express

- Discovery: `PoolCreated`, the two `Swap` log shapes, `Initialize`/`Mint`/`Burn`, the pool `swap`
  call and the address surface map to v2 mapped discovery; `poolMaterialization` has a declared form;
  Pancake and canonical topics can be declared as separate events.
- Identity: factory / token0 / token1 / fee / tickSpacing reads plus the factory `getPool` reverse
  binding are standard staged identity. The pool `isSwapper(address)` bytecode classifier
  (`univ3-family/swap-access.ts:27-136`) maps directly onto the existing address→bool
  `bytecodeGetter` profile (`venues/declarative-bytecode.ts:57-170`, selector `isSwapper`, storage
  slot 0), so `swapAccess` is one of the few parts that is already expressible.
- Instance/routes: `swapAccess` static evidence, two directed routes with `fee`/`tickSpacing` fields,
  descriptor checks and the binding projection are expressible.
- Pricing: a two-step `pricingFlow` (slot0/liquidity, then Quoter V2 precision probes) is the shape
  the dependent read-flow supports; `pricingProjection` can publish sqrt-price/liquidity mids.
- Exact: the local v3 swap math can be a registered math model over a decoded pool state; evidence
  fields and access checks can be declared; a descriptor-selected variant can cover the
  `is-swapper` vs `no-is-swapper-getter` branches.
- Execution: the v3 pool `swap` + callback payment (`univ3-family/runtime-execution.ts:34-57`) fits
  the declarative callback-frame/deferred-input shape; the amount is patched from `amountIn`.

## Gaps (blocking)

**G-U3-1. A positive local quote can be legitimately unavailable (`amountOut = 0`) and must not throw.**
`univ3-family/exact.ts:224-235` returns `zeroQuote(input, "univ3-local-ticks")` when `v3SwapToState`
throws `V3MissingBitmapWordError` (tick outside the 49-word window) or when the price reaches
`MIN_SQRT_RATIO+1`/`MAX_SQRT_RATIO-1`; `zeroQuote` (`:258-269`) attaches valid
`univ3-local-ticks` evidence with `amountOut: 0n`. The declarative exact program rejects every
non-positive amountOut for positive amountIn (`venues/declarative-family.ts:680`); a direct engine
probe on a local-math quote returning 0 throws `exact quote returned no output`. Treating the window
edge as a quote error is not equivalent: the solver can still size smaller amounts against the same
source, and the family contract asserts the zero-evidence shape. Same generic gap as univ2 G-U2-1
(and the gap register's "zero-output pricing validator").

**G-U3-2. The local quote program is data-dependent: 49-word packed reader vs per-word tick-lens
fallback.**
`univ3-family/exact.ts:87-117` selects `resolveUniV3StateReader(descriptor)` (a fixed
`UNIV3_STATE_READER` call returning a packed 49-word bitmap window,
`state-reader.ts:1-137`) or `tickLensStateRequests` + `tickLensDependentProgram` when no reader is
available (`tick-lens-state.ts:1-75`). The tick-lens path builds its next-round requests from the
words still missing after the previous round and uses ids derived from the word index; the number and
identity of calls therefore depend on chain data. Declarative read flows have a static `steps` array
and a fixed number of rounds (`venues/declarative-read-flow.ts:50-66,142-163`); a declared step can
return an empty request list, but a 49-step fixed fan-out cannot reproduce "next missing word" ids,
stop early, or the `tickLensStateRequests` result map without a new dynamic-program form. The packed
reader path alone is expressible (one static call + a math model); the fallback is a real capability
for pools whose reader is unavailable.

**G-U3-3. Per-quote `isSwapper` authorization and trial-state gating are external program hooks.**
`univ3-family/exact.ts:168-175` adds `uniV3SwapAccessRequest(input)` as an extra dependent round and
asserts the source-bound `isSwapper(executor)` result before decoding; `:205-208` only enables the
shared trial state when `swapAccess.kind === "no-is-swapper-getter"`. A declarative exact program
has no preflight read outside its `quoteFlow` (`declarative-family.ts:626-655` runs checks then the
single declared flow), and a `trialState` is declared per variant, not conditionally per descriptor
field. Two variants keyed on `swapAccess.kind` could express the trial-state split, but the access
call is a per-invocation, executor/source-bound round that must be ordered between the state read and
the quote; the fixed flow could host it as step 0 only by branching its request list, and the
descriptor's `is-swapper` branch still needs the trial-state `unsupportedReason` variant. Not yet
proven equivalent.

**G-U3-4. Custom strict swap observation and call decode.**
`univ3-family/swap.ts:67-86` uses `createUniV3SwapObservation({ resolvePool, adapterIds,
canonicalIntakeTargets, topics })` and `:118-216` decodes both `Swap` logs and pending `swap(...)`
calls (recipient, zeroForOne, amountSpecified, sqrtPriceLimit, callback data, exact post-state) and
rejects non-swap sign pairs. The declarative Swap domain only decodes declared events
(`venues/declarative-swap-domain.ts:33-44,58-64`) and has no family `resolvePool`/call-observation
hook. `replay.exactPostState` itself is declarable, but the pending-call observation path is not.

**G-U3-5. Family-owned nomination provider and implementation reverse binding are not declarable.**
`univ3-family/discovery.ts:89-94` declares `nominate: nominateUniv3` and
`reverseBinding: { kind: "implementation", reverseBinding: reverseBindUniv3 }`; declarative discovery
only offers generic tx-evidence/address-surface nomination and hardcodes
`explicitReverseBindingUnsupported` (`venues/declarative-discovery.ts:92,308`). The recent-log
re-materialization provider is replaced by a narrowing, and the retained-entry reverse binding is
lost.

**G-U3-6. Exact method flags/ids.**
`univ3-family/exact.ts:196-208` publishes `stateOnlyReads: true` with a descriptor-dependent method id
(`local-state-49` / `local-ticks-49`) and trial-state support only for `no-is-swapper-getter`; the
declarative request-program method is always `chainAmountQuote` or `trialState`
(`venues/declarative-family.ts:609-624`) and `stateOnlyReads` is not declarable. This is a caching/
continuity capability plus test shape; the bigger exact gaps are G-U3-1/G-U3-3.

## Generic vs family-specific engine work

Generic:
1. **Zero-output unavailability**: return `{ amountOut: 0n, unavailableReason }` from a request-program
   quote for positive input instead of throwing (`declarative-family.ts:680`).
2. **Data-dependent read programs**: a sanctioned form for "repeat rounds while the decoded state
   requests more keys" with per-iteration request ids and early stop (tick-lens fallback), rather than
   a static step array (`declarative-read-flow.ts:50-66,142-163`).
3. **Per-quote preflight/authorization rounds and conditional trial-state support** (or the M2
   per-direction program selection extended to per-descriptor quote programs).
4. **Call-observation swap decode + family resolvePool** and a declarative strict-wrapper form
   (`declarative-swap-domain.ts:58-64`).
5. **Nomination/reverse-binding provider hooks** (generic discovery extension;
   `declarative-discovery.ts:92,308`).
6. `stateOnlyReads`/reuse-policy declaration for exact methods (generic caching contract).

Family-specific:
- Register the v3 swap/state math model and the packed-49-word decode; author the tick-lens fallback
  program if the generic repeat form lands.
- Author the `isSwapper` gate and the descriptor-selected trial-state variant.
- Author the precision pricing program and the victim replay expressions.

## Verdict

Stop per migration policy. The `isSwapper` bytecode classifier is not the problem; the zero-window
quote semantics, the data-dependent tick reads, the per-quote authorization round and the call
observation are. Revisit when the generic items above exist; do not narrow to state-reader-only pools
or drop the pending-call observation.
