# `kyberswap-elastic` — declarative Swap JSON migration (2026-10-30)

Status: **migrated to JSON locally**; handwritten production entry left in place (the task does
not run the production generator or commit a generated entry). Tree after validation contains
only `kyberswap-elastic.json`, `declarative-math.ts` and the append-only math-registry
registration; the temporary rendered entry was restored byte-for-byte from `HEAD` (`git diff` on
`kyberswap-elastic.production.ts` is clean).

Family: `kyberswap-elastic` (`listener/src/searcher/venues/swaps/kyberswap-elastic-family`),
lineage `kyberswap-elastic:factory-getpool-child`, activation
`SEARCHER_FAMILY_KYBERSWAP_ELASTIC_ENABLED` (registered `enabled: false`, matching the handwritten
entry). The generator stem `kyberswap-elastic` equals the handwritten entry name, so no
`*-family` redirection was needed.

## Files

- `listener/src/searcher/venues/swaps/kyberswap-elastic-family/kyberswap-elastic.json` —
  protocol-json-v2 Swap definition (7,428 lines).
- `listener/src/searcher/venues/swaps/kyberswap-elastic-family/declarative-math.ts` — pure
  `kyberswap:quote-probe` and `kyberswap:pricing-state` models over already-read state; they call
  the family's existing `quoteExactInput`, `stepTargetTick` and `virtualReserves` integer math.
- `listener/src/searcher/venues/declarative-math-models.ts` — append-only registration of
  `kyberswapElasticMathModels` (import + spread, 4 lines).

No public framework TS/test, generated artifact, production entry or generator run was changed.

## Mapping

- **Discovery** (mapped v2): `swap(address,int256,bool,uint160,bytes)` observed call, canonical
  `Swap` log and `Mint` mutation log, and the `kyberswap-elastic-pool-surface-v1` address surface;
  candidate/instance key = pool; labels `["kyberswap-elastic","kyberswap","elastic"]`;
  address-surface nomination — exactly the handwritten `createAddressSurfaceNomination`
  (`nomination.ts:12-16`), including its labels. The handwritten `Swap`-log candidate filters on
  signed deltas (`codec.ts:126-153`); the declarative event predicate reproduces
  `amount0>0,amount1<0` / `amount1>0,amount0<0`.
- **Identity** (2 rounds): code + `factory`/`token0`/`token1`/`swapFeeUnits`/`tickDistance`/
  `getPoolState`/`getLiquidityState` at the pinned source, the same surface checks and
  `staticValid`/`evidenceRequestIds` shape (`identity.ts:147-207`), then
  `factory.getPool(sorted tokens, feeUnits)` with `return-or-revert-data`; a pinned revert is the
  zero address and a chain-proven reverse-binding rejection. Hint mismatch, fee/tick/state
  rejection codes, identity key `lower(subject)` and the `factory-reverse-binding` provenance
  hash (including `poolCodeHash`) are reproduced. The handwritten variant's `get-code` transport
  and `staticValid` gate on the second round are preserved.
- **Instance/routes**: pool/token0/token1/feeUnits/tickDistance/factoryBinding projection with the
  legacy `swapSemantics` marker (`codec.ts:187-205`); exactly two exact-input directions
  (`token0-in`/`token1-in`), `isToken0` input-selector flag, legacy route key
  `familyId␟lower(pool)␟direction` (`routes.ts:62-70`), binding key lower(pool), four token-delta
  effects and `{kind:"address-pool"}` graph venue.
- **Pricing**: one source-bound three-call state round (`getPoolState`/`getLiquidityState`/
  `swapFeeUnits`, same ids as `state.ts:29-46`), range/fee/tick assertions identical to
  `decodePoolState` (`state.ts:91-150`), and `pricingProjection` rows reproducing
  `virtualReserves` + the raw sqrt-price mid with the fee included exactly once
  (`pricing.ts:83-136`): `numerator/denominator = (sqrtP² or 2¹⁹²)·(FEE_UNITS−feeUnits)`,
  `reserveA/B = depth tokens`, `depth = min`, `feeBps = 0`. `classifyUnavailable` reproduces
  `kyberswap_elastic_pool_locked`, `..._no_active_liquidity`, `..._raw_depth_below_one_unit`
  (`pricing.ts:39-49`); mutation index kinds are `log` and `call` over the pool, as handwritten.
- **Exact**: local-math `quoteFlow` over the same state reads plus amount-dependent
  `initializedTicks`/`ticks` rounds; the probe model calls the family's existing
  `quoteExactInput` (`math.ts:32-116`), so amount sensitivity, per-step reinvestment fees, signed
  base-liquidity changes, 480-tick temporary boundaries, step/refusal semantics and crossed-tick
  evidence are the production arithmetic, not a reimplementation. The read flow allocates the
  same four dependent rounds the central exact issuer permits (`adapter-family-runtime.ts:373`;
  `MAX_READ_ROUNDS=5` in `blockscan-state-coordinator.ts:3478`): round 1 = neighbour-or-first
  crossing, rounds 2–4 = crossings. Method id, `stateOnlyReads`, local-math trial-state
  unsupported reason, zero `local-zero` method and evidence fields are preserved; zero outputs
  carry an explicit `unavailableReason` (stricter).
- **Execution**: v2 directional callback frames (the univ3 shape): outer
  `swap(recipient,swapQty,isToken0,limitSqrtP,data)`, `swapCallback(int256,int256,bytes)` body
  paying the positive debt word to the pool by `transfer` from the executor; direction-specific
  signed argument encodings, `maximum: amountIn` debt cap and `minimum: 1` credit; exact input
  patched from runtime `r0`; full debit `equals amountIn`, fresh recipient credit and external
  recipient old-inventory guards. No approval; `settlement.directOutput` matches the handwritten
  direct path. `runtimeProjection` stays the default (no standing allowance/prewarm).
- **Swap**: canonical `Swap` (including trailing `sqrtP`/`liquidity`/`tick`), `Mint` mutation,
  observed `swap` call with `swapQty > 0` exact-input guard, empty canonical intake targets and
  `victimSupport: "detect-only"`, matching `swap.ts:21-145`.

## Validation (executed locally, no VM/RPC/live)

- `createDeclarativeSwapRuntime` / `defineSwapFamily` registration: PASS; module coverage
  `math/pricingFlow/pricingProjection/quoteFlow: compiled`, all other optional modules
  `undefined`.
- In-memory harness (17/17 PASS): discovery positive/negative (zero-delta rejected), 2-round
  identity verify + foreign-reverse/invalid-fee rejects, routes/graph, pricing mids and three
  unavailable states, exact numeric parity with the handwritten `quoteExactInput` on both
  directions/amounts, zero/refusal evidence, two-crossing fixture parity
  (`958043694` / `1057813624`), `retainReadEvidence` fragment build/refusal, runtime leg and
  fragment construction without reading quoted amount fields, Swap classify/decode/receipt.
- Family tests with a temporarily rendered generated entry (then restored):
  - `test/contract.ts`: **38/48 PASS**; 10 fail on legacy artifact/round-sequence shapes (below).
  - `test/central-exact.ts`: **10/18 PASS**; 8 fail on empty-round sequence/budget reason (below).
  - `test/historical-ready.ts` not run (needs read-only RPC/REVM; no VM/RPC in this window).
- `./node_modules/.bin/tsc -p tsconfig.live.json --noEmit`: PASS.
- `npm run build:live` with the handwritten entry restored: PASS.

## Accepted fail-closed / legacy-shape deviations

1. **Fixed read-flow rounds.** `declarative-read-flow.ts:158-167` always returns the next declared
   step and only terminates after the last one, so the five-step Exact flow executes four
   dependent rounds even when the amount needs none or needs fewer. Steps with no missing tick
   declare `requirements.transports: []` and `requests: []` so they are valid empty rounds; the
   fix for a non-empty-transport empty round was required because
   `runRequestProgram` rejects “declared request transport eth-call is not used by any request”.
   Production terminates as soon as no read is needed. Quote arithmetic is unchanged; the
   contract tests that assert the exact `dependentRequests` array and the central tests that
   assert `rounds` equality fail on the extra empty arrays. This is a scheduling/cache shape
   change, not a weaker check: the same ticks are requested, no tick is guessed, and the final
   probe refuses when the four-round budget is exhausted.
2. **Exact budget-exhaustion status.** The final crossing step asserts that no missing tick
   remains after the fourth dependent round (stricter than returning an unavailable zero quote).
   The central Exact test expects `failed` with `exact-dependent-round-budget-exhausted`; the
   read-flow assertion instead surfaces a deterministic decode failure and the observed status
   was `unresolved` in the fixture where a transport result was absent. It still fails closed and
   never returns a partial quote. A later smaller quote after the failure resolves normally
   (central test `growing beyond cached crossings` passes).
3. **`retainReadEvidence: true`.** Quote-local evidence fields (`sqrtPAfter`, `deltaL`,
   `targetTick`, `steps`, `crossedTicks`, `refusal`, `unavailableReason`) cannot be re-derived at
   `buildFragment` without the observed read rounds, so the Exact retains
   `{initialResults, dependentEvidence}` in `evidence.readProof`. The framework re-runs the same
   flow on those observations and compares the full evidence hash
   (`declarative-family.ts:738-745`); the issued evidence now carries this proof in addition to
   the handwritten fields. No execution check is relaxed.
4. **Zero-output evidence.** A positive-input zero quote must carry a non-empty
   `unavailableReason` (`declarative-family.ts:700-701`); the JSON sets it to the model refusal
   (for example `no-representable-output`). Handwritten evidence has only `refusal`. Stricter.
5. **Action encoder shape.** The declarative action is `isWrapper:false`, `field2Offset:null`,
   and accepts only a runtime amount program (`declarative-execution.ts:873-894`); the handwritten
   action also encodes a fixed-amount callback script (`action.ts:30-76`). The contract test
   “the action encodes a positive exact-input swap with a callback payment” asserts the old byte
   layout (`a9059cbb` in the returned calldata), so it fails. The replacement carries the same
   transfer semantics inside the runtime program and refuses nodes without a program.
6. **Pricing finalize call shape.** `finalizePricingDescriptor` requires static evidence
   (`declarative-family.ts:466-468`). The legacy contract tests call it with only
   `{draft, sharedBindings}` and fail “pricing lacks static evidence”; the production lifecycle
   supplies the source-local `{}` and resolves both mids. This is a test-harness call-shape
   difference, not a production behavior change.
7. **Receipt observation is a superset.** `swap.events` includes `Mint` so the strict receipt
   observer watches `Swap` and `Mint` topics; the handwritten observer watches only `Swap`
   (`swap.ts:21-33`). A `Mint` trigger classifies as a mutation-only observation and publishes no
   impact; no admission or execution capability is added. The same deviation was accepted for
   univ3.
8. **Deferred-input settlement is not migrated.** Handwritten `buildRuntimeLeg` supports
   `deferred-input`/`direct-output` with a signed-delta callback (`execution.ts:47-70,130-170`).
   Declarative `deferred` requires uint256 debt/output callback arguments and a parent witness
   (`declarative-callback.ts:17-40`; `declarative-execution.ts:817-841`), which
   `swapCallback(int256,int256,bytes)` does not provide; framed settlement also needs a parent
   expectedOutput witness (design doc §6). The JSON declares default/direct output only and
   `buildRuntimeLeg` returns `null` for deferred-input. Fail-closed narrowing, matching the univ3
   migration; the central runner independently rejects deferred execution cases.
9. **Identity evidence is merged/built differently.** Declarative provenance uses the same
   `factory-reverse-binding` kind and hash fields; the candidate hints are all null in the
   handwritten family, and the JSON declares that nullable shape. No admission relaxation:
   factory/token/fee/tick/state checks and `getPool` are on chain at the same source.

## Revisit / follow-up

- Run the central generator once the migration window accepts a generated entry; the generator
  refuses to overwrite the handwritten file, so the entry must first move to the established
  `.handwritten` evidence path.
- The extra empty Exact rounds and the budget-failure reason are framework read-flow semantics,
  not protocol JSON shape. If the framework adds amount-dependent flow termination or an early
  stop, the JSON can drop the four fixed crossing steps and the test-shape failures should
  disappear without changing arithmetic.
- A real single-block/live acceptance run needs the existing `historical-ready.ts` with a
  read-only RPC file and the current workspace `revm-sim`; not done here (no VM/RPC).
