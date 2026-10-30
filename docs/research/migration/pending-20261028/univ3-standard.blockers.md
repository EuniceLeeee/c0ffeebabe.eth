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
