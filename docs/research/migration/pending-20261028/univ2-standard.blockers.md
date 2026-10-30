# univ2-standard — blocked (zero-output capacity, transfer-tax identity, custom swap observation)

Family: `univ2-standard` (`univ2-family`), lineage `univ2:factory-child`,
activation `SEARCHER_FAMILY_UNIV2_STANDARD_ENABLED` (default enabled).
Status: **blocked**. Handwritten TS entry left untouched. Partial mapping draft parked at
`univ2-standard.draft.json` (not deliverable, not importable).

## What the framework can express

- Discovery: `PairCreated`, `Swap`, `Sync`, the pair `swap` call and the address surface map to v2
  mapped discovery / `txSeedNominations`; `poolMaterialization` has a declared form.
- Identity: factory / token0 / token1 reads, `factory.getPair` reverse binding, pool
  `getAmountOut` probes, token code reads and decimals can be staged in `identity.definition`.
- Instance/routes: one pair instance, `zero-for-one` / `one-for-zero` routes with `feeBps` in route
  fields; descriptor checks can restate the token/direction binding.
- Pricing: `pricingFlow` can read `getReserves` plus both token balances; `pricingProjection` can
  publish the `reserveOut/reserveIn` mid and depth. `classifyUnavailable` exists for zero reserves.
- Exact: local-math quote flow + `trialState` (the pair reserve cell with balance dependencies) is the
  exact shape the declarative trial-state module was built for; evidence fields can be declared.
- Execution: ERC20 transfer/pair.swap call, approval, direct-output and deferred-input settlement are
  expressible in v2; a quote can be computed by the `quoteOutput` module.
- Swap replay: declarative `victimSupport: "replay"` with JSON `bind`/`applyLocal`/`buildOverlay`
  can express the constant-product victim transition.

## Gaps (blocking)

**G-U2-1. Exact capacity must return `amountOut = 0` + `unavailableReason`, not throw.**
`univ2-family/exact.ts:108-137` treats an input above the current `uint112`/balance headroom as an
*unavailable amount*: it returns `amountOut: 0n` with `unavailableReason: "input-reserve-capacity"`
(`:112-116,130,247-258`) and the solver may retry a smaller legal amount at the same source. The
declarative exact program rejects every non-positive amountOut for positive amountIn:
`venues/declarative-family.ts:680` (`exact quote returned no output`). Confirmed by a direct engine
probe on a local-math quote flow returning 0 → throws that message. Treating capacity as a hard error
is not equivalent: the family contract asserts the zero+reason behaviour and the "smaller amounts stay
usable" semantics (`test/univ2-family-plugin.ts:478-495`). This is the **generic zero-output
unavailability** gap already noted in the gap register (G13 secondary, "zero-output pricing
validator") and not landed.

**G-U2-2. Verified transfer-tax identity is a bytecode classifier with no declarative surface.**
`univ2-family/identity.ts:119-122` calls `identifyTokenTransferModel` for both tokens; the only
verified model is the BTB Bear runtime template (`venues/token-transfer-semantics/btb-bear.ts:5-27`):
exact code length, five fixed asset operands, a token operand and an EIP-712 domain hash at fixed
offsets, then `keccak256(masked code) === template hash`. The declarative identity model surface is the
address→bool `bytecodeGetter` (`venues/declarative-bytecode.ts:57-170`) plus generic value ops
(`declarative-values.ts:23,226` `maskHash`/`matches`); there is no sanctioned runtime-proof/opcode
classifier (the same class as gap register G15/M9). The model is not decoration: it changes
`receivedInput`/`receivedOutput` in exact (`univ2-family/exact.ts:281-288`), the mid transfer factor
(`pricing.ts:133-137`), the pool-quote probe amount (`pricing.ts:88-92`), the runtime transfer path
(`runtime-execution.ts:84-130,160-175`) and victim replay (`victim.ts:36-39`). Ignoring it would
over-quote BTB pools.

**G-U2-3. The runtime quote program is shared by quotation and settlement and its result must feed the
swap calldata.**
`univ2-family/runtime-execution.ts:39` advertises `quoteOutput: true` for every leg, and the
`getReserves`/`getAmountOut` quote is used both as the settlement output (`univ2-family/execution.ts`
buildFragment uses `exactEvidence.poolAmountOut`) and as the `amount0Out/amount1Out` argument of the
in-program `pair.swap` call (`runtime-execution.ts:84-99,160-175`). A declarative `modules.quoteOutput`
program is compiled only for `quote-output`/`direct-output` settlement requests
(`declarative-execution.ts:282-290`) and its result is checked against the credit delta (`:480`). Its
declared capture name is not addressable from execution step arguments: a probe with a quote capture
`q` and a step arg `{runtime:"q"}` fails with `unknown runtime capture q`. Only the internal mangled
slot `quoteLocalq` resolves, and only when the quote program was emitted (i.e. a quote/direct-output
settlement request); for an ordinary funded leg the quote operations are absent, so the same step
cannot compile. uniV2's leg uses one program for both cases (`runtime-execution.ts:84-99,160-175`),
so one declaration cannot represent it without depending on an internal naming convention.
Recomputing the same output in a separate runtime-math step is possible, but it is a second formula
in the same transaction rather than the single family-owned quote/settle program, so equivalence
(including transfer-tax and pool-quote variants) would be unproven — a capability change, not just
layout.

**G-U2-4. Custom strict swap observation decodes call observations and resolves the pair from the
declarative binding.**
`univ2-family/swap.ts:41-67` uses `createUniV2SwapObservation({ resolvePool, adapterIds, topics })`
and `swap.ts:87-147` decodes both `Swap` logs and pending `swap(...)` calls into canonical payloads
(including recipient/callback data). The declarative Swap domain only decodes declared events
(`venues/declarative-swap-domain.ts:33-44,58-64`); it has no call-observation decode and no
family-owned `resolvePool` callback. Its `replay` block can express the reserve transition, but the
call-observation/pending-swap capability and the custom strict wrapper are lost.

**G-U2-5. Exact method flags and evidence shape.**
`univ2-family/exact.ts:162-174` declares `stateOnlyReads: true` with a local trial state for the
ordinary constant-product path; declarative request-program methods can only declare
`chainAmountQuote` or `trialState` (`venues/declarative-family.ts:609-624`), never
`stateOnlyReads`. This is a cache/continuity capability (amount changes reuse one source-bound state
read), not a correctness check, but the family contract asserts it. Evidence fields
(`receivedAmountIn`, `poolAmountOut`, `maxAmountIn`, `unavailableReason`, `quoteModel`,
`reserveIn/Out`, `inputBalance`) are declarable, but `maxAmountIn`/`unavailableReason` depend on
G-U2-1 and the pool-quote/router variants.

**G-U2-6. Family-owned nomination provider and implementation reverse binding are not declarable.**
`univ2-family/discovery.ts:62-70` supplies `nominate: nominateUniv2` (a recent-log re-materialization
provider, `nomination.ts:20-53`) and `reverseBinding: { kind: "implementation", reverseBinding: reverseBindUniv2 }`
(`reverse-binding.ts:22-103`). Declarative discovery only offers the generic tx-evidence/address-surface
nomination and hardcodes `reverseBinding: explicitReverseBindingUnsupported(...)`
(`venues/declarative-discovery.ts:92,308`); it has no `nominationReadFlow` equivalent to a recent-log
scan and no reverse-binding hook. Dropping the reverse binding changes how retained graph entries are
re-admitted at a source block (the family re-materializes the pair surface from `factory()` and the
retained token hints, then identity re-verifies it).

**G-U2-7. Pool-owned quote model and Router preference.**
Identity can mark a pair `pool-get-amount-out` (`univ2-family/identity.ts:226-233`) and exact/execution
then use `getAmountOut`/Router amounts; production uses the local preference, but the router
constructor is a tested public capability (`createUniV2Exact("router")`). A two-variant descriptor
match (local vs pool quote) is possible in principle; the router path is generator/TS-only
(`router-quote.ts`), and the exact method id/flags differ. Not the primary blocker, but the migration
cannot claim the Router contract passes.

## Generic vs family-specific engine work

Generic:
1. **Zero-output unavailability**: let a request-program quote return
   `{ amountOut: 0n, unavailableReason }` for positive input and surface it as the existing
   solver-unavailable path instead of throwing (`declarative-family.ts:680`). Unblocks univ2 capacity
   and univ3 tick-window quotes.
2. **Quote-output binding**: expose the declared `quoteOutput` result to execution step arguments
   (a public capture name), or support a "quote then execute" step whose quote result patches the
   call argument (`declarative-execution.ts:153-217,480`).
3. **Call-observation swap decode + family resolvePool** in the Swap domain (generic observation
   extension), plus a declarative strict-wrapper form equivalent to
   `createUniV2SwapObservation` (`declarative-swap-domain.ts:58-64`).
4. **Sanctioned read-only runtime classifier** (M9 class) for immutable token templates, or a
   sanctioned bytecode-template identity op.
5. `stateOnlyReads`/reuse policy declaration for request-program exact methods (generic caching
   contract).

Family-specific:
- Register the constant-product quote/transition math model (including `uniV2InputCapacity` and the
  `uint112` post-state checks) and the BTB received-amount math.
- Author the transfer-tax identity facts and the victim replay expressions.
- Two-variant descriptor split for `constant-product` vs `pool-get-amount-out` if the pool-owned quote
  model is to be preserved.

## Verdict

Stop per migration policy. Do not silently drop capacity unavailability, the transfer-tax model, the
call-observation path, or quoteOutput; each is a real capability that would change quotes or
observations. Revisit when the generic items above exist.
