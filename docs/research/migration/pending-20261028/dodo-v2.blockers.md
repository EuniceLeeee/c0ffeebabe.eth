# custom-swap:dodo-v2 — parked (adjusted-input chain quote + registry identity variants)

Family: `custom-swap:dodo-v2` (`venues/swaps/dodo-v2-family`), lineage `dodo-v2:registry-member`,
activation `SEARCHER_FAMILY_DODO_V2_ENABLED` (default enabled, `venues/production-families/dodo-v2.production.ts:15`).
Status: **parked**. The handwritten TS entry is untouched; no `<family>/dodo-v2.json` production
definition is added. A partially mapped draft is parked at
[`dodo-v2.draft.json`](dodo-v2.draft.json) (scope/production/manifest/discovery only; it is **not**
importable as an entry and the generator must not be pointed at it).

Baseline: the family contract test is green against the handwritten entry
(`node --import tsx src/searcher/test/dodo-v2-family-plugin.ts` → `PASS`).

## 1. What the framework can express

| TS module | Declarative block | State |
|---|---|---|
| `discovery.ts:22-67` | `discovery.definition` (v2 mapped) | **validated**: two sell calls, `DODOSwap`, interface surface, composite candidate key `pool` |
| `instance.ts:24-50` | `instance.key` / `draft` / `bindingProjection` | expressible; declarative `finalizeDescriptor` returns the evaluator's frozen draft (`declarative-family.ts:337-342`), so `draft` must already be the final descriptor |
| `routes.ts:13-50` | `routes.target/bindingKey/directions/graphVenue/effects/key` | expressible, including the exact `familyId\u001fpool\u001fTokenIn\u001fTokenOut` route key (`routes.ts:42-45`) |
| `pricing.ts:65-271`, `pricing-helpers.ts:1-306` | `pricing` + `pricingFlow` + `pricingProjection` + math models | expressible with **one extra read round**: the conditional bounded-probe round becomes an always-present round whose `requests` may be `[]` (see §3.1) |
| `execution.ts:16-84` | `standard.execution` version 2 | expressible: `transfer(tokenIn→pool, amountIn)` then a `when`-selected `sellBase/sellQuote(recipient)`, saving the pool-reported return and comparing it to the recipient balance delta via a step `credit.equals`; global debit `equals: amountIn`; `protectedAddresses` cover pool/tokenIn/tokenOut |
| `swap.ts:14-48` | `swap.events` + `swap.receiptObservation` | expressible: canonical `DODOSwap` event (`declarative-event-codec.ts:17-38`), impact/poolMaterialization expressions, `victimSupport: "detect-only"` |
| `action.ts:5-18` | `actionAdapters[0].descriptor` + traces | descriptor and trace selectors expressible; the quoted-node encoder becomes the shared runtime program (`declarative-execution.ts:873-894`) — the generic shape change already accepted for univ1/univ2/univ3 |

The expressible discovery block was compiled and exercised with synthetic fixtures:

```
swap-log:      { candidateKind: "dodo-v2-pool", pool, sourceKind: "swap-log", hintedTokenIn, hintedTokenOut }
sell-base:     { candidateKind: "dodo-v2-pool", pool, sourceKind: "sell-base-call", hints: null }
surface:       { candidateKind: "dodo-v2-pool", pool, sourceKind: "pool-surface", hints: null }
candidateKey:  <pool lowercase>
```

## 2. Blocking gaps

### G-D1 (decisive) Exact must re-query at the computed effective input, and the chain-quote proof binds the invocation `amountIn`

`dodo-v2-family/exact.ts` reads the pool's raw input position and re-issues the actor query with
`effectiveInput = currentInput + transfer − deficit` when the transfer does not equal the input:

- `exact.ts:93-114` — dependent program: `if (effectiveInput === programInput.amountIn) return null;`, else
  one `querySellBase/querySellQuote(transactionOrigin, effectiveInput)` request (`exact.ts:101-113`);
- `exact.ts:116-131` — decode selects the *initial* query only when unchanged, otherwise the
  `exact-effective-actor-query` result;
- `exact.ts:183-220` — `decodeInitialInput` derives `effectiveInput` from the input-semantics multicall and
  keeps the gross query result only as the retained four-request contract.

A declarative chain quote is a single static proof object, checked against the invocation amount:

- `declarative-family-modules.ts:65-85` — a non-`local-math` `quoteFlow` **requires** `sourceKind` and a
  `chainQuote`; `local-math` must not claim a chain proof and cannot carry this chain read;
- `declarative-family.ts:687-692` — `verifyDeclarativeQuoteChain({ ..., amountIn: input.amountIn, amountOut })`;
- `declarative-quote-proof.ts:102` — the decoded request argument must equal `amountIn`.

Consequences (both are semantic, not test-shape):

1. **Adjusted input**: the declared proof can only name one request whose input equals `amountIn`. The
   effective-input query's input is `effectiveInput != amountIn`, and using the gross query's output as
   `amountOut` is the discarded (wrong) quote. Probe P1: unadjusted accepted, adjusted rejected with
   `chain quote proof input or output amount mismatch`.
2. **Direction**: the two directions use different selectors (`querySellBase` /
   `querySellQuote`, `dodo-v2-family/exact.ts:52-54,105-113`). `chainQuote` is one static
   `{step, requestId, signature, amountPath, outputPath}` (`declarative-quote-proof.ts:16-47`); a single
   signature cannot canonically decode the other direction's calldata. `exact.methods()` is shared by both
   routes, so a direction map is not expressible today.

Workarounds rejected: (a) declare the gross query as the proof — the published `amountOut` would not be the
proven request's output; (b) label the flow `sourceKind: "local-math"` — drops the chain-amount proof and
changes Exact caching/chain semantics; (c) `exact.unavailableReason` — drops exact quoting and therefore
execution entirely (`declarative-family.ts:735`).

### G-D2 (decisive) Four registry identity variants share one lineage

`dodo-v2-family/identity.ts:46-56` builds one identity variant per registry singleton,
`registry-member-0..3`, all with the same `lineageId: dodo-v2:registry-member`
(`identity.ts:49`, `dodo-v2-abi.ts:45-53`); the manifest declares exactly that one lineage
(`manifest.ts:14`). Each variant queries its own `getDODOPool(base,quote)` and independently decides
`verified` / `chain-proven-rejected` (`identity.ts:61-81,94-165`).

Declarative identity variants are the document plus its `variantFiles` children
(`declarative-family.ts:127-129`), and the production generator requires one lineage per variant:

- `build-declarative-production.ts:163` — `lineages.length !== childFiles.length + 1` throws
  `variant references do not cover declared lineages`.

Probe P2 confirms it (a `univ2.json` document with one extra child is rejected with exactly that message).

A single variant querying all four registries in one stage is a possible shape workaround (same four reads,
membership if any registry lists the pool), but it is not equivalent: the runtime merges provenance from
**all** verified variants (`adapter-family-runtime.ts:3764-3782`), so a pool listed by two registries would
lose one registry-binding provenance entry; variant ids/count and the per-registry `chain-proven-rejected`
paths also change. The family contract test pins the variant id and the single-registry request
(`test/dodo-v2-family-plugin.ts:111-113,899-916`).

### 2.1 Framework extension that would unblock

1. **Chain quote with declared quote input and per-direction proofs.** Let `quoteFlow.chainQuote` name a
   proof per `route.direction` (or let the proof's `amountPath`/request be selected by an expression), and
   let the proof's input be a declared flow value (e.g. `effectiveInput`) with the verifier comparing the
   request argument to that value and the invocation amount to the evidence `amountIn`. This is the same
   capability needed by any family that adjusts a transfer-tax/deficit input before a chain quote.
2. **Identity variants over a shared lineage.** Allow `variantFiles` children with duplicate
   `lineageId` plus an `applies`/`match` predicate (here: fixed registry parameter), and relax the
   generator count check to `(id, lineage)` coverage. This preserves per-registry provenance merging.

## 3. Deviations that remain after the blockers are fixed

### 3.1 Conditional dependent read rounds (shape)
Pricing's bounded probe (`pricing.ts:151-180`: `null` when every direction selects local math) and Exact's
effective query (`exact.ts:93-96`: `null` when the input is unchanged) are conditional rounds.
`declarative-read-flow.ts:158-167` fixes the round count (`buildDependentProgram` returns `null` only after
the last declared step; `decode` requires `steps-1` evidence rows). A faithful value path is a fixed two-step
flow whose second `requests` is `[]` for the ordinary case; quotes, rejection reasons and read sets match,
but every pricing/exact invocation performs one extra (empty) round and `decodeSnapshot` needs that round's
evidence. Documented as a lifecycle-shape deviation, not a weakening. A conditional-step extension would
remove it.

### 3.2 Opaque graph nomination (capability narrowing)
`nomination.ts:17-58` re-materializes a real recent `DODOSwap` log for an opaque graph nomination via
`findRecentLogHit` (bounded recent log window). Declarative discovery nomination is either generic
`tx-evidence` (needs a transaction-hash evidence and receipt/trace patterns) or `address-surface`, and
`nominationReadFlow` is eth-call-only (`declarative-discovery.ts:234,303-308`). The interface surface is
expressed, but opaque labels without a tx hash lose this recent-log bootstrap. Live discovery from
landed logs and observed calls is unaffected.

### 3.3 Exact zero output (deviation)
TS can publish `amountOut = 0` with `quotePath: "actor-query"` (`exact.ts:116-131`). Declarative zero output
requires a non-empty `unavailableReason` in evidence (`declarative-family.ts:699-702`); the draft would add
`dodo-v2-zero-actor-query` and stay fail-closed (zero output never executes).

### 3.4 Quoted action/fragment shape (generic change)
`buildFragment` always emits a `runtimeAmountProgram` node with `requirements: []`
(`declarative-family.ts:730-749`) and the declared action encoder accepts only that program
(`declarative-execution.ts:873-894`), replacing the pool-specific `sellBase` boolean params and the
`transfer-to-pool` requirement (`execution.ts:38-57`, `action.ts:5-18`). The stored-return/recipient-delta
equality described in §1 keeps the actual receipt check; this is the same generic cutover already applied to
the other swap families.

## 4. Validation performed

- `docs/research/migration/pending-20261028/swap-json-gap-probes-20261028.ts.draft` (copy to
  `listener/.migration-probe/` and run with `node --import tsx`):
  - P1 adjusted-input chain quote → `chain quote proof input or output amount mismatch`;
  - P2 duplicate-lineage variants → `variant references do not cover declared lineages`;
  - P5 (discovery block): see the probe source for the DODOSwap/sell/surface decode assertions.
- Discovery draft compiled with `compileDeclarativeDiscovery` and decoded `DODOSwap`, `sellBase`, and the
  interface surface (all return the expected candidate; `candidateKey` = lowercase pool).
- `tsc -p listener/tsconfig.live.json --noEmit` and `npm run build:live` were not affected: this change is
  documentation + pending drafts only (no production TS/JSON/registry/test edit).

## 5. Files

- `docs/research/migration/pending-20261028/dodo-v2.blockers.md` (this file)
- `docs/research/migration/pending-20261028/dodo-v2.draft.json` (partial discovery map, not importable)
- `docs/research/migration/pending-20261028/swap-json-gap-probes-20261028.ts.draft` (P1/P2 probe source)
