# custom-swap:ekubo-router-v1 — parked (candidate shape + nomination/reverse-binding gaps)

Family: `custom-swap:ekubo-router-v1` (`venues/swaps/ekubo-family`), lineage
`ekubo:vanilla-core-pool-key-v1`, activation `SEARCHER_FAMILY_EKUBO_ENABLED`
(`venues/production-families/ekubo.production.ts:15`).
Status: **parked**. The handwritten TS entry is untouched; no `<family>/ekubo.json` production definition is
added. The discovery mapping attempt is parked at
[`ekubo-router-v1.discovery-attempt.draft.json`](ekubo-router-v1.discovery-attempt.draft.json); it is
deliberately **not importable** (the candidate cannot be expressed, see G-E1).

Baseline: the family contract test is green against the handwritten entry
(`node --import tsx --test src/searcher/venues/swaps/ekubo-family/test/contract.ts` → 18/18).

## 1. What the framework can express

| TS module | Declarative block | State |
|---|---|---|
| `identity.ts:27-127` | `identity.definition` | expressible: `get-code`/`get-storage` are ordinary requests, `code`/`codeHash` evaluate bytecode, `get-storage` data can be referenced, and the multi-round `structure → quotes → (retry) → decide` loop maps to `select`/`stages`/`decide` (declarative identity is a `decide → requests → decode` loop, `adapter-family-runtime.ts:3600-3760`; `declarative-identity.ts:108-116`) |
| `instance.ts:13-24`, `routes.ts:38-57` | `instance`/`routes` | expressible, including `executionAssets` native sides and the `familyId:poolId:isToken1` route key (`routes.ts:13`) |
| `pricing.ts:30-155` | `pricing` + `pricingFlow` + math models | expressible only with a **fixed three-round** flow (the conditional partial-depth retry becomes an empty round; §3.1) |
| `exact.ts:14-42` | `exact` + `quoteFlow` | **blocked**: the chain read is one `quote(poolKey,isToken1,amount)` for both directions, but its output is a packed `bytes32` balance update, not a uint ABI amount (G-E4) |
| `execution.ts:13-97` | `standard.execution` version 2 | expressible: `value` for native input, `when`-selected approval/native steps, shared debit/credit balance measurement and signed `int128` output guards become runtime math/effects; `directOutput` native-recipient constraint matches `execution.ts:26` |
| `swap.ts:15-67` | `swap.events` + `swap.receiptObservation` | expressible: the Core anonymous packed log is exactly the bounded layout supported by `declarative-event-codec.ts:40-80` (Core address, 116 bytes, pool-id at offset 20, signed `int128` deltas); `PoolInitialized` is a canonical event |
| `action.ts:9-38` | `actionAdapters[0].descriptor` + traces | descriptor/trace selectors expressible; encoder becomes the shared runtime program (generic shape change) |

Discovery blocks the whole family; exact is additionally blocked by the chain-quote output model (G-E4).

## 2. Blocking gaps

### G-E1 (decisive) The Ekubo candidate is not representable by mapped discovery

The candidate is `{candidateKind: "ekubo-pool-key", poolId: bytes32, poolKey: {token0, token1, config}}`
(`types.ts:5-12`); `poolId` is derived from the tuple (`codec.ts:36-41`, `pool-key.ts` normalization +
`ekuboPoolId`). Mapped discovery requires:

- an **address** `addressField` (`declarative-discovery.ts:144`: fields[addressField] must be `"address"`);
- candidate fields of scalar type `address|uint|bytes32|bool|string|number` (`declarative-discovery.ts:173-176`);
- field sources only `argument` (top-level index), `target`, `sender`, `emitter`, `opaque` (surface only),
  `observation` (txHash/source only) or `literal` (`declarative-discovery.ts:161-181`) — no tuple element and
  no derived/computed value.

Both the swap call and `PoolInitialized` carry the pool key as a tuple (`discovery.ts:14-35`,
`codec.ts:43-100`), and a tuple argument cannot supply a scalar candidate field: the candidate address
must be an address argument (`declarative-discovery.ts:189-195`), and `scalar()` rejects a tuple for every
other field. The candidate also needs the derived `poolId`, which no field source can compute. Probes:

```
P3a tuple candidate-address rejected: call candidate argument must be address
P3b tuple field candidate: null
```

A second, smaller mapping difference: production discovery declares
`sources: ["landed-log","observed-call","canonical-registry"]` (`discovery.ts:16`); declarative `sources` only
accepts `landed-log|observed-call|address-surface` and `canonical-registry` is a `candidateSources` value
(`declarative-discovery.ts:123-128`), so that channel moves.

Consequence: no Ekubo candidate, no identity, routes, pricing or execution. This is a discovery-model gap,
not a private-key/ABI detail.

### G-E2 (decisive) Multihop fan-out has no declarative form

`codec.ts:43-62` decodes one `multihopSwap` call and yields one candidate per hop (up to 32), validating the
token chain and zero hop amounts. Mapped discovery yields **one candidate per matched pattern**, and a
nested hop key cannot be selected by `{from:"argument", index}`. Probe P4 (a pattern whose hint maps
argument 0):

```
P4 multihop candidate: null
```

so every multihop observation produces no candidate (the `scalar()` conversion rejects the tuple/array).

### G-E3 (decisive for capture) Custom nomination and reverse binding

`nomination.ts:12-130` owns two capabilities that are not in the declarative discovery vocabulary:

- `reverseBindEkubo` (nomination.ts:52-85): rebuilds a pool id from real Core `PoolInitialized` logs by
  scanning `EKUBO_CORE_DEPLOY_BLOCK..source.number` in 50 000-block windows, with provider+source caching,
  duplicate-log rejection and failed-read eviction;
- `ekuboNomination` (nomination.ts:87-130): transaction-receipt logs and successful-`CALL`-frame trace
  traversal, then expands **all** hop keys of a multihop through the Core initialization index.

Declarative discovery nomination is either generic `tx-evidence` or `address-surface`
(`declarative-discovery.ts:285-308`), `nominationReadFlow` is address-surface + eth-call only
(`:234`, `declarative-nomination.ts`), and v2 always installs
`explicitReverseBindingUnsupported` (`declarative-discovery.ts:308`). The live landed-log/observed-call
paths remain, but opaque graph nominations and reverse binding (capture/blockscan) lose the Core-log proof.

### G-E4 (decisive) Exact chain-quote output is a packed `bytes32`, not a uint ABI amount

Ekubo's exact quote is the router `quote` call (`exact.ts:14-35`, `../ekubo/abi.ts:24,53-63`):
`quote(poolKey,bool,int128,uint96,uint256) returns (bytes32 balanceUpdate, bytes32 stateAfter)`, and the
output is decoded by `decodeQuote → decodeSizingProbe → decodeEkuboBalanceUpdate/exactInputAmountOut`
(`codec.ts:127-141`, `../ekubo/abi.ts:107-160`).

A declared view chain quote requires an unsigned ABI output field:

- `declarative-quote-proof.ts:38-53` — `amountType(..., "outputs")` requires the path to identify a
  `uint*` component;
- `declarative-quote-proof.ts:96-105` — the decoded output at `outputPath` must equal `amountOut`.

The output amount is the signed `int128` delta packed into the returned `bytes32`; no `outputPath` can
select it, and a math-model decode is outside the proof interface. Declaring the flow `local-math` would
drop the chain-amount proof (and change Exact chain/caching semantics), and a gross packed field cannot be
substituted. Probe P1 is the same verifier path (a non-matching output is rejected). This is generic: any
router that returns a packed balance delta cannot publish a declarative chain Exact quote today.

## 3. Deviations that would remain after G-E1..G-E4 are fixed

### 3.1 Conditional pricing retry (shape)
`pricing.ts:30-41,66-101`: after the initial unit quotes, a dependent `small/depth` probe runs, and a
**second dependent round** re-quotes smaller full-fill sizes only when the depth probe was partial.
Declarative read flows have a fixed step count (`declarative-read-flow.ts:158-167`); the faithful value path
is a fixed three-step flow whose retry `requests` is `[]` for the ordinary case. Quotes/mids/validations
match, but every pricing invocation performs one extra (empty) round and `decodeSnapshot` requires its
evidence. Not a weakening.

### 3.2 Anonymous Core-log mutation narrowing (conservative)
`pricing.ts:114-148` invalidates only the routes whose `poolId` matches the parsed anonymous Core swap log;
malformed Core logs conservatively invalidate all Core owners. Declarative mutation is an address index
(`declarative-family.ts:574-590`), so any Core log would invalidate **all** Ekubo routes. Over-invalidation
is conservative, never a weaker check, but it changes refresh/pruning behaviour.

### 3.3 Quoted action/fragment shape (generic change)
`buildFragment` always emits a `runtimeAmountProgram` node with `requirements: []`
(`declarative-family.ts:730-749`) and the declared action encoder accepts only that program
(`declarative-execution.ts:873-894`). Ekubo's handwritten fragment emits an `approve` requirement plus
`{token0,token1,config,poolId,bindingHash,isToken1,amountOutMin,receiver}` node params
(`execution.ts:73-96`) consumed by `action.ts:9-38`; the contract test asserts that shape
(`venues/swaps/ekubo-family/test/contract.ts:168-190`). The generic compiler keeps the same receipt
guards (actual debit, fresh credit, native/allowance restoration); this is the same cutover already
accepted for the other swap families, and the test would be adapted by the framework window.

### 3.4 Identity code/get-storage and quote math (not blocked)
`get-code`/`get-storage` requests are plain declared requests and the evaluator has `code`, `codeHash`,
`decode`/`decodeCanonical` plus registered math models (`declarative-values.ts:45-55,183-210`), so the
`structure → quotes` evidence machine is expressible. Variable identity rounds are already supported by
`decide` returning `continue` (`adapter-family-runtime.ts:3600-3760`; `declarative-identity.ts:108-116`).

## 4. Framework extensions that would unblock

1. **Discovery candidate with derived fields.** Allow `nominationReadFlow`/`expression`-computed candidate
   fields (already available in evaluation) and a non-address candidate key, or a declared ABI "tuple
   projection" that can map tuple elements and derive `poolId` (e.g. a registered hash model used in the
   candidate mapping). Ekubo needs `poolId = keccak(abi.encode(token0,token1,config))` and the three key
   components.
2. **Bounded nested-list fan-out for call patterns.** Allow a call pattern to declare a repeated nested
   argument path (hop array) and emit one candidate per element, with the existing canonical-calldata and
   predicate checks retained. This is generic (multihop routers), not Ekubo-specific.
3. **Declarative nomination/reverse binding.** Expose the existing `CaptureNominationProvider` capabilities
   as data: bounded `getLogs` windows with topic/address/cutoff, receipt-log and successful-CALL-frame
   traversal, duplicate detection and provider/source-scoped caching; and a reverse-binding declaration
   from a fixed log topic to candidate keys. Otherwise capture/block-replay for Ekubo stays handwritten.

## 5. Validation performed

- `docs/research/migration/pending-20261028/swap-json-gap-probes-20261028.ts.draft`:
  - P3a tuple candidate address → `call candidate argument must be address`;
  - P3b tuple-derived candidate field → `null` (no nested field source);
  - P4 multihop extraction → `null` (no nested field source).
- `tsc -p listener/tsconfig.live.json --noEmit` / `npm run build:live` are unaffected: documentation +
  pending drafts only (no production TS/JSON/registry/test edit).

## 6. Files

- `docs/research/migration/pending-20261028/ekubo-router-v1.blockers.md` (this file)
- `docs/research/migration/pending-20261028/ekubo-router-v1.discovery-attempt.draft.json` (invalid by design)
- `docs/research/migration/pending-20261028/swap-json-gap-probes-20261028.ts.draft` (P3/P4 sources)
