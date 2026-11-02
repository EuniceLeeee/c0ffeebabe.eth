# `swap:algebra-integral` — declarative definition authored (2026-11-02)

Status: **definition authored and validated; production entry not switched.** The handwritten
`production-families/algebra-integral.production.ts` is still the production entry because the
production generator was not run (out of scope this round). No public framework TS/test, live, VM,
RPC, signing or broadcast was touched.

Deliverables:

- `listener/src/searcher/venues/swaps/algebra-integral-family/algebra-integral.json` — root
  `swap-json-v2` definition: manifest/scope/activation, mapped discovery, two-stage
  factory-reverse-binding identity, instance/routes, shared pricing flow/projection, static
  local-math Exact, Swap observation/materialisation, generated-entry-compatible action.
- `listener/src/searcher/venues/swaps/algebra-integral-family/algebra-dynamic-fee.json` — same
  lineage (`algebra-integral:factory-child`) child variant selected by
  `executedFee.kind == "cypher-bound-quoter"`: view Quoter quote flow, source-bound Quoter evidence,
  `each-block` refresh, guard reads.
- `listener/src/searcher/venues/swaps/algebra-integral-family/declarative-math.ts` — pure models
  (CREATE2/plugin-word Quoter binding, pricing snapshot, single-range quote, integer pricing rows,
  unavailable rows) delegating to the retained family math.
- append-only registry line in `venues/declarative-math-models.ts`.

## Gaps from the 2026-10-30 parking note, re-evaluated

### G-A1 (was decisive) — one lineage, two exact/pricing models: **RESOLVED**

f4a16ced allows several variants on one lineage and selects by a descriptor predicate:
`build-declarative-production.ts:163,319-330` (coverage, not one-child-per-lineage) and
`declarative-family.ts:130-133,207-211` (lineage coverage; exactly one `match`). The static root and
the dynamic child share `algebra-integral:factory-child` and differ only by `executedFee.kind`.

### G-A2 (was decisive) — CREATE2/code/immutable Quoter proof: **RESOLVED**

`declarative-values.ts:185-198` now exposes `abiEncode`, `create2Address` and
`decodeErrorCanonical`, and `maskHash`/`bytes`/`addressWord` already expose bounded code words.
The identity stage reads `get-code` for the fixed Quoter and the pool plugin, then a declared model
(`algebra-integral:quoter-binding`) reproduces the handwritten proof: fixed Quoter runtime hash,
factory/poolDeployer equality, CREATE2(poolDeployer, keccak(abi.encode(sorted tokens)),
poolInitCodeHash) == pool, plugin bytecode length/ten masked immutable words/normalised hash and
plugin factory. Validated against `test/dynamic-fixtures.ts` (no live RPC).

### G-A3 (non-decisive) — capture-channel substitution: **REMAINS, accepted**

Mapped discovery has no `factory-log` source (`declarative-discovery.ts:137` allows
`landed-log`/`observed-call`/`address-surface`) and always installs
`explicitReverseBindingUnsupported` (`declarative-discovery.ts:103`, `:428`). The JSON therefore
nominates from landed logs/address surface and identity re-verifies factory/token/tick/fee and
`poolByPair`. This is the same capture-channel substitution accepted for univ2/univ3/Ella, not an
admission relaxation. The family contract test that asserts `sources.includes("factory-log")` and
`reverseBinding.kind === "implementation"` fails for that reason.

### G-A4 (settlement) — deferred-input: **REMAINS, fail-closed narrowing**

`execution.ts:47-70,236-260` supports direct-output plus deferred-input; the declarative declaration
publishes `settlement.directOutput: true` and default/direct output only. Deferred input with a
signed `int256` debt callback still needs a parent witness the common compiler does not provide for
this callback. Same precedent as univ3. Not converted into a weaker check.

## New deviations observed while validating (framework/API shape, not quote or settlement semantics)

1. **Execution program layout.** Declarative v2 frames always seed `r14/r15`, add an
   untouched-native guard and compile the callback sub-program/returned-floor opcodes
   (`declarative-execution.ts:635-636,415-418`). The handwritten algebra program has 13 flat
   instructions (`execution.ts:104-150`); the family test's `parseRuntimeProgram` assertions
   therefore fail even though the quote/debit/receipt semantics are equivalent or stricter.
2. **Action metadata.** `createDeclarativeProgramAction` fixes `isWrapper:false`,
   `field2Offset:null` and accepts only `{runtimeAmountProgram}` nodes
   (`declarative-execution.ts:947-967`); the handwritten algebra action declares
   `field2Offset:132, isWrapper:true` (`action.ts:19-33`). Encode behaviour for real nodes matches.
3. **Built-in local-zero id.** The common compiler names it `local-zero`; the test expects
   `algebra-local-zero` (`declarative-family.ts:610`).
4. **Pricing static evidence.** Declarative `finalizePricingDescriptor` requires `staticEvidence`
   (`declarative-family.ts:473-475`); the handwritten contract helper calls it with `{draft}` only.
   The production lifecycle supplies the evidence.
5. **Evidence rejection wording / classify input.** With `retainReadEvidence` a tampered amount is
   rejected before the hash compare as `execution read proof amount mismatch`
   (`declarative-family.ts:750-757`), and `landedEvents.classify` decodes the full event rather than
   classifying a truncated `data:"0x"` observation (`declarative-swap-domain.ts:111-113`).
6. **Pricing fee telemetry.** Projection `feeBps` is an integer
   (`declarative-pricing-projection.ts:24-31`), so raw hundredths-of-a-bip hints floor to whole bps
   (static 500 → 5 is exact; odd/dynamic hints lose sub-bps). Mids still use the same integer
   numerator/denominator ratio.
7. **Landed `Pool` materialisation** is declared as a mutation event so the factory log can seed
   `poolMaterialization`; the handwritten observer classifies only swap/mutation events from the
   pool itself.

## Validation performed

- `compileDeclarativeSwap` + `renderDeclarativeProductionEntry` for root+child: green; generated
  entry loaded through `defineSwapFamily`/`assertDefinedFamilyPlugin` with 6 discovery patterns,
  2 identity variants, one owned action and a runtime leg; handwritten entry restored afterwards
  (`git status` clean for that path).
- In-memory parity harness against the handwritten plugin and its real/synthetic fixtures:
  **137 checks passed** — static+dynamic identity/descriptor/rejections, routes/graph, static Exact
  for 1k/10k/1M and decline/crossing/dynamic-fee cases, dynamic Quoter Exact/evidence, pricing
  snapshot/mids/reserves/fee, Swap observation payload/classification, fragment/runtime-leg and
  evidence rejection.
- Family contract test with the temporary rendered entry: **22 pass / 11 fail**; every failure is
  one of deviations 1–7 above (execution byte layout, action metadata, local-zero id, pricing
  `staticEvidence`, wording, discovery channel, classify input). No quote amount, route,
  identity verdict or settlement effect differed from the retained implementation.
- `test/refresh.ts` is not runnable unchanged in this tree (it imports the missing
  `production-families/univ2-standard.production.js` and then expects the retired univ2 lifecycle).
  A temporary copy with absolute imports, the univ2 leg skipped and the two derived row/edge counts
  adjusted passed its Algebra assertions **6/6** in both `coarse` and `runtime` paths: dynamic
  each-block refresh, static on-touch carry, repeated failure withdrawal/recovery, Quoter calls from
  `transactionOrigin`, effective mids and the exact read round `["exact-quoter","pool-plugin",
  "plugin-code","quoter-code"]`.
- `npm run test:family-json`: **652 tests / 651 pass / 0 fail / 1 skip**.
- `npm run check:protocol-json-samples`: green (input-library integrity only).
- `tsc -p tsconfig.live.json --noEmit` / `npm run build:live`: only unrelated errors from the
  concurrently added untracked `venues/swaps/dodo-v2-family/math.ts`; zero algebra errors.
- `family-capability-manifest:check` now stops at this staged JSON with "refusing to overwrite a
  handwritten production entry" (it wants to generate `algebra-integral.production.ts`). This is the
  expected staged-migration state while the production generator is out of scope; the framework
  window must run `family-capability-manifest:generate` during cut-over (the same is true for the
  concurrently staged dodo/oneswap JSON). `check:protocol-json-samples` and `test:family-json` are
  green.

## Remaining work before cut-over

- Framework window: adapt the algebra contract test to the declarative action/execution/pricing API
  (or restore byte-identical emission) and re-run it green.
- Decide whether the accepted capture-channel substitution and direct/default-only settlement are
  acceptable for this Family's production cut-over; both are recorded above rather than narrowed
  silently.
- Run the production generator and the normal Ready/graph/exact acceptance after cut-over; this
  round did not generate or publish anything.
