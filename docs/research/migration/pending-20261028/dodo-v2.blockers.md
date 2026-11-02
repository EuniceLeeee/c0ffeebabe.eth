# `custom-swap:dodo-v2` — declarative JSON migration (framework `f4a16ced`)

Status: **migrated to declarative Swap JSON locally, not cut over**. The handwritten production
entry is untouched and remains authoritative; the production generator was not run, and no
generated entry/artifact is committed. This file replaces the 2026-10-30 parking report: both
decisive gaps below are now expressible on this framework baseline, and the remaining items are
documented lifecycle/artifact-shape deviations, not missing declaration capabilities.

Family: `custom-swap:dodo-v2` (`venues/swaps/dodo-v2-family`), lineage `dodo-v2:registry-member`,
activation `SEARCHER_FAMILY_DODO_V2_ENABLED` (default enabled,
`venues/production-families/dodo-v2.production.ts:15`). Generator stem `dodo-v2` equals the
production entry name, so the JSON lives in the existing family directory (no `*-family`
redirection).

## Files

- `listener/src/searcher/venues/swaps/dodo-v2-family/dodo-v2.json` — root variant
  (`registry-member-0`) and shared definition: scope/production/manifest/discovery/identity
  hook/instance/routes/root pricing/swap/modules/actionAdapters, `variantFiles` pointing at the
  three sibling variants.
- `.../dodo-v2-family/registry-member-1.json`, `-2.json`, `-3.json` — the remaining registry
  identity variants (same lineage, per-variant `identityParameters.registry`).
- `.../dodo-v2-family/math.ts` — seven pure DODO math models (PMM state/fee decode, input
  position, effective input, bounded probe selection, probe quote decode, pricing snapshot). They
  reuse the existing checked port `venues/swaps/dodo-pmm-math.ts` and the Family-owned selector
  `venues/swaps/dodo-v2-family/pricing-helpers.ts`; they perform no I/O, transport or admission.
- `listener/src/searcher/venues/declarative-math-models.ts` — append-only registration of
  `dodoV2MathModels` (one import line, one spread entry).

No handwritten Family TS, test, generated catalog/shadow or production entry was modified. The
temporary generated entry used for the family-test run was restored byte-for-byte (`git diff`
empty for `production-families/dodo-v2.production.ts`).

## Blocker re-evaluation against `docs/research/design/family-common-capabilities-20261102.md`

### G-D1 (was decisive) — adjusted-input Exact + per-direction chain-quote proof: **resolved**

The new conditional quote proof expresses exactly what `exact.ts` does:

- `declarative-quote-proof.ts:216-287` (`version:2` / `choices`) selects one **complete** proof
  per direction and adjustment before any observation is read; each literal `signature` names
  `querySellBase`/`querySellQuote` (so the former "one static signature cannot decode the other
  direction" blocker is gone).
- `declarative-quote-proof.ts:85-95,189-200` (`inputBinding.value` + `checks`) binds the computed
  invocation input while keeping the original `amountIn` as `$quote.amountIn`. The JSON uses
  `surplus + ($quote.amountIn - deficit)` from the source-bound input-semantics round and
  `gt($quote.amountIn, deficit)`, so the actor query is issued at the adjusted pool input and the
  proof compares the decoded argument with that derived value, not with the request amount.
- The four choices are `(sell-base | sell-quote) x (unchanged | adjusted)`; the unchanged choice
  proves the gross `exact-actor-query`, the adjusted choice proves
  `exact-effective-actor-query`. Both alternatives retain the four-request initial contract and a
  successful gross query is still required when the input is adjusted.

Observed parity: unchanged/surplus/deficit for both directions produce byte-identical request
sets, dependent requests and quote evidence versus the handwritten entry, including
`evidence.amountIn`, `evidence.effectiveInput`, `quotePath` and the actor used by
`querySellBase/querySellQuote`/`getUserFeeRate` (`transactionOrigin`).

### G-D2 (was decisive) — four registry identity variants on one lineage: **resolved**

`build-declarative-production.ts:163` now only requires each declared lineage to be covered
(`lineages.length > childFiles.length + 1`), so the three children may share
`dodo-v2:registry-member`; `declarative-family.ts:127-133` keeps variant ids unique and checks
lineage coverage. Each sibling declares `identityParameters.registry`, and the identity workflow
reads `$profile.registry` for the `getDODOPool(base,quote)` request, the reverse-membership
decision and the `registry-reverse-behavior-proof` provenance subject.

Parity: for exactly one real registry, the JSON proves the same `chain-proven-rejected` decision
(`registry_reverse_binding_failed`) or the same merged identity facts/provenance hash as the
handwritten entry — verified for all four `registry-member-N` variants, not just the fixture
registry.

Variant selection: a descriptor must hit exactly one model (`declarative-family.ts:209-213`), so
the four variants select on `$descriptor.registryBinding.registry`. The first variant is the
declared fallback for a registry outside the four singletons (`not(any of the other three)`), so
synthetic/foreign descriptors used by the family's own runtime-program tests still select exactly
one model; production identity can only emit one of the four origins.

## Mapping

- **Discovery**: v2 mapped declaration — `sellBase(address)`/`sellQuote(address)` call patterns
  (candidate from call target), the canonical `DODOSwap` log (candidate from emitter, token hints
  from arguments 0/1), the `dodo-pool-surface-v1` interface surface, labels
  `["dodo-v2","custom-swap:dodo-v2"]`, `nomination: "address-surface"`, candidate/instance key
  `pool`. The draft's synthetic decode assertions are preserved.
- **Identity**: two stages. Behavior: `_BASE_TOKEN_`/`_QUOTE_TOKEN_`/`getPMMStateForCall` +
  `getUserFeeRate(quoteActor)` with `verified-actor` caller; decode asserts distinct non-zero
  tokens, candidate hints, pmm domain (`K <= 1e18`, `R in {0,1,2}`), fee domain and
  `behaviorProofHash = hash({pool,baseToken,quoteToken,quoteActor,pmm,fees})`. Registry:
  `getDODOPool(base,quote)` at `$profile.registry`, reverse membership, then verified facts
  `{pool,baseToken,quoteToken,registryBinding,quoteActorBinding}` and
  `evidenceHash = hash({registryBinding,pool,baseToken,quoteToken,quoteActorBinding,behaviorProofHash})`.
  `identity.key = lower(address(subject))`; no `memoReuse` (same as the handwritten entry).
- **Instance/routes**: descriptor draft = identity facts + `{source-state/pinned-block,
  execution-actor/verified-actor, quote-completion/return-data}`; `staticBindingProjection`
  reproduces the handwritten pool/base/quote/registryBinding/quoteActorBinding projection
  (identical `bindingRef.fingerprint`); two directions `sell-base`/`sell-quote` with the legacy
  route key `familyId␟lower(pool)␟lower(tokenIn)␟lower(tokenOut)` (`routes.key`), binding key
  `lower(pool)`, `{kind:"address-pool"}` venue and the four token-delta expected effects.
- **Pricing**: static stage preserves the dependency-proof `decimals` reads
  (`baseOneToken`/`quoteOneToken`). Current stage: two-round `pricingFlow` — round 1 reads
  `_BASE_TOKEN_`/`_QUOTE_TOKEN_`/`getPMMStateForCall`/`getUserFeeRate(actor)` plus the
  `aggregate3` input semantics (balances/reserves/getters/mt-fee ledger), then models the input
  positions and the per-direction bounded-probe selection (`pricing-helpers.selectDodoProbeInput`);
  round 2 issues exactly the `aggregate3` probe queries the handwritten entry would and the
  snapshot model reproduces `decodeSnapshot` (local quote, first positive probe or
  `provably-unavailable`). `pricingProjection` rows reproduce `quotedPoolMid`
  (`mid=out/in`, `reserveA=in*1e4`, `reserveB=out*1e4`, `depth=min`, `feeBps=0`), and
  `classifyUnavailable` passes the snapshot's unavailable map. `liveStateProjection` reproduces
  `dodo-v2-pmm-live`. Dependencies/mutation addresses/mutation predicate match the handwritten
  entry (pool/base/quote/registry/actor/multicall3; `DODOSwap` log only).
- **Exact**: method `actor-bound-query`, `chainAmountQuote`, `transaction-origin` caller on all
  four initial reads and on the dependent read; two-step `quoteFlow` with the conditional proof
  above; `zeroEvidence` for `amountIn = 0`; evidence rebuilds the handwritten
  `dodo-v2-actor-bound-query` shape and is re-derived (hash-checked) at `buildFragment`, so
  forged executor/origin/amount/route are rejected; `exactUnavailableReason` is not used.
- **Execution**: v2 steps `transferInput` (`transfer(pool, runtime amountIn)`) then the
  direction-selected `sellBase(recipient)`/`sellQuote(recipient)` with `save.sellOut`; effects
  `debit(tokenIn,executor)==amountIn`, `credit(tokenOut,recipient)==sellOut`, shared
  `unchanged-native`, and external-recipient inventory guards on `tokenOut(executor)` /
  `tokenIn(recipient)`; protected addresses pool/tokenIn/tokenOut; runtime requires a valid
  transaction origin; `settlement.directOutput` only (no `quoteOutput` claim), so
  `quote-output`/`deferred-input` requests return `null` exactly like the handwritten entry.
- **Swap**: canonical `DODOSwap` event (`swap` classification, detect-only victim support, the
  legacy intake target), canonical payload, per-route match on `(fromToken,toToken)`, impact with
  `poolToken0/1`, and `poolMaterialization` decoding the six-word data layout (returns `null` for
  a non-canonical log like the handwritten decoder).
- **Action**: `dodo-v2-swap` descriptor (swap/lineage `dodo-v2`, no value, no standing position)
  with selector traces for `sellBase`/`sellQuote`.

## Remaining deviations (documented, not capability gaps)

1. **Fixed read-flow round count.** `declarative-read-flow.ts:155-172` fixes the number of rounds,
   so both pricing and exact always expose a second dependent round; for the ordinary
   "no probe / unchanged pool input" case its `requests` is empty. Values, request ids and the
   four/five-request physical contract are unchanged, but the handwritten entry returns `null`
   from `buildDependentProgram` in that case. This is the deviation already recorded in the
   previous report (§3.1); it is a lifecycle shape, not a narrowing. Consequence:
   `test/dodo-v2-family-plugin.ts:224` (`assert.equal(dependentProgram, null, ...)`) fails
   with the temporary rendered entry, so that test stops before its later sections.
2. **Nomination / reverse binding.** Declarative discovery has no per-family reverse-binding hook
   (`declarative-discovery.ts:428` is `explicitReverseBindingUnsupported`). The declared
   `nomination: "address-surface"` path still performs the code+storage surface read the
   handwritten `reverseBindDodoV2` does (`venues/address-surface-nomination.ts:54-71`), so a
   retained pool is still re-materialized from its deployed code and then behavior/registry
   re-verified by identity. What is lost is the handwritten "recent `DODOSwap` log" bootstrap
   (`nomination.ts:17-58`): a nomination now yields a `pool-surface` candidate with null token
   hints instead of a `swap-log` candidate with hints. Admission and instance identity are
   unchanged (hints are only asserted when present), and the surface path no longer requires
   recent activity. `nominationReadFlow` is a read-only eth-call/code/storage flow (`declarative-nomination.ts:17-38`), so it cannot reproduce a log lookup either.
3. **Zero exact output.** A chain quote proof requires a positive input/output
   (`declarative-quote-proof.ts:174-175`), so the handwritten "publish `amountOut = 0` with
   `quotePath: actor-query`" case is not expressible; the declarative path fails closed instead.
   A zero output never executes, and zero `amountIn` keeps the declared zero evidence.
4. **Quoted fragment / runtime artifact shape.** `buildFragment` emits the shared
   `runtimeAmountProgram` node with empty requirements (the generic cutover used by every migrated
   swap family) instead of the handwritten `transfer-to-pool` requirement + `params.sellBase`.
   The runtime leg also keeps the shared full debit/credit assertions on the default (no
   settlement request) path, where the handwritten default leg only transfers and calls
   `sellBase`; the direct-output path carries the same checks on both sides. This is stricter,
   never weaker, but it changes the saved runtime-script hashes, so
   `test/recipient.test.ts:32`'s "default runtime bytes match all eight saved historical programs"
   case fails (16/17 of that file pass).

## Validation performed (no live/VM/RPC/signing; generator not run)

- In-memory compile: `createDeclarativeSwapRuntime` + `defineSwapFamily` over the four JSON files
  with the registered math models; all modules `compiled`/explicitly `undefined` as expected.
- Parity harness against the handwritten entry (26 groups, all pass):
  discovery candidates/patterns/sources; identity for all four variants including request sets,
  evidence and decided identities (facts + provenance hash) and the forged-pool
  `chain-proven-rejected`; descriptor/binding projection and route keys/fingerprints/graph
  projection/expected effects; static decimals evidence and finalized pricing descriptor;
  pricing current requests + dependent requests + snapshot + mids + unavailable + live projection
  for (a) ordinary local math, (b) the bounded-probe fallback (zero active PMM target) and
  (c) double-zero behavior-unavailable; exact for pass-through/surplus/deficit on both directions,
  zero input, negative input, missing dependent evidence, forged origin and cache-compatibility
  projection; execution fragment/requirements and settlement capabilities; runtime-leg behavior
  through the independent `runtime-program-testkit` interpreter for correct, short-output and
  short-debit receipts on the default and direct-output paths; swap classify/payload/receipt
  topics/intake/pool materialization; action selectors; manifest.
- Handwritten legacy math parity: `dodoV2BlockScanState` static/current/dependent reads + derived
  mids, and `dodoV2Adapter.quoteExact` for 200 wei sell-base, both equal to the declared values.
- Family tests with a temporary rendered generated entry (then restored):
  `test/dodo-v2-family-plugin.ts` fails at `:224` on deviation 1 (above);
  `test/recipient.test.ts` 16/17 (only the saved-runtime-hash case, deviation 4);
  `test/reference-amount.test.ts` 2/2; `test/historical-dual.test.ts` 3/3;
  `src/searcher/test/dodo-v2.ts` 1/1. The RPC/REVM historical CLI
  (`test/historical-ready.ts`, `historical-dual.ts` main) was not run (no VM/live).
- `npx tsc -p tsconfig.live.json --noEmit` green both with the temporary rendered entry and with
  the handwritten entry restored; `npm run build:live` green; shared `test:family-json` suite
  652 tests / 651 pass / 0 fail / 1 pre-existing skip.
- `npm run family-capability-manifest:check` is not green in this shared tree because several
  migration JSONs are still intentionally parked next to handwritten production entries; for this
  family it would refuse to overwrite `dodo-v2.production.ts`
  (`build-declarative-production.ts:355-365`). The generator was therefore not run; cutover needs
  the entry replacement step in the framework window.

## Cutover prerequisites

1. Replace `venues/production-families/dodo-v2.production.ts` with the rendered entry
   (`renderDeclarativeProductionEntry`) and archive the handwritten one, then regenerate the
   capability manifest/shadow with the shared generator.
2. Decide whether the fixed-round deviation (1) is acceptable for the production Exact/pricing
   scheduler (it adds one empty dependent round per invocation in the common case); otherwise it
   needs a conditional-step read-flow extension.
3. Re-run the family contract test after the cutover; the expected deltas are the four items in
   "Remaining deviations" (no other behavior change).
