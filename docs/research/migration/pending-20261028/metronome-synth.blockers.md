# protocol:metronome-synth — blocked (framework gap: declarative oracle victim)

Faithful JSON cannot be registered with the current public v2 compiler. A near-complete draft is
parked at `metronome-synth.draft.json`. The family remains on its hand-written TS entry; no production
entry, generated artifact, default switch or test was changed.

## Gap (exact locations)

1. **The v2 production compiler rejects protocol victim semantics outright.**
   `listener/src/searcher/build-declarative-production.ts:141`
   `if (Object.hasOwn(doc.protocol, "oracleVictim")) throw new Error("v2 protocol victim semantics are not declared by this compiler");`
   The same rejection is asserted by `listener/src/searcher/test/declarative-production.test.ts:278`.
   `declarative-protocol.ts:679` forwards `document.protocol` unchanged into `defineProtocolFamily`, so
   without a compiler/module extension there is no declarative path for this capability.

2. **The runtime contract needs a synchronous decode function that JSON cannot supply.**
   `listener/src/searcher/venues/adapter-family-plugin.ts:2461-2466` guards
   `protocol.oracleVictim.decode` as a synchronous own data function; `:4698-4751` requires
   `callPatterns`, `canonicalIntakeTargets`, `runtimeDetection` **and** `decode`.
   The source implementation is `metronome-synth-family/victim.ts:43-69`: it decodes
   `forward(address,bytes)` from the observed call, checks the oracle address and the payload selector,
   and returns `{forwarder, oracle, selector, payloadHash, oracleBinding}`. The v2 value language has
   closed ops but no victim-decode slot/stage; a data object fails registration with
   `protocol.oracleVictim is missing required field decode`.

3. **The victim capability is also a hashed semantic root.**
   `family-capability-catalog.ts:16-27` includes `victim` in `FAMILY_CAPABILITY_NAMES`, and
   `test/special-protocol-family-direct-roots.ts:127-135` pins
   `src/searcher/venues/protocols/metronome-synth-family/victim.ts` as its root. Dropping the victim
   block would remove a catalog capability and its source-root identity, not merely an optional field;
   that is the weakening the migration policy forbids.

## Observed failures (executed)

```
renderDeclarativeProductionEntry(draft + oracleVictim)
  -> "v2 protocol victim semantics are not declared by this compiler"
createDeclarativeProtocolRuntime(draft + oracleVictim) + defineProtocolFamily
  -> "protocol.oracleVictim is missing required field decode"
```

## What is validated (draft minus `_status/_note/_blockers` and `oracleVictim`)

Everything except the victim capability was exercised in memory with synthetic source-bound fixtures:

- discovery: both `swap(address,address,uint256)` and `quoteSwapOut(address,address,uint256)` calls map
  `pool` + optional `hintIn/hintOut`; interface-surface nomination maps `pool`; candidate keys bind.
- identity: membership round (pool code + `doesSyntheticTokenExist` per unique supported/hinted token),
  active-quote round (`quoteSwapOut` at 1e18 for every ordered pair), 3 tokens -> 6 verified directions,
  provenance hash over pool/tokens/directions; verified identity -> descriptor
  (`oracleBinding` `4ac71f0f…9948`, runtime requirements `source-state` + `oracle-state`).
- routes: 6 dynamic pairs with stable per-pair route keys, `address-protocol` graph identity.
- pricing: 3 static decimals reads -> `oneTokens`; 6 current `quoteSwapOut` reads; snapshot with 6
  quotes and 6 mids.
- exact: `quoteSwapOut` chain quote, amount-out/fee evidence (fee retained through `retainReadEvidence`),
  local-zero `zeroEvidence`.
- execution: `ensure` allowance (grant `MaxUint256`) + `swap(tokenIn,tokenOut,amountIn)` runtime program;
  debit `equals amountIn`, credit `minimum minAmountOut`.
- mutation: pod log and oracle-forwarder call invalidate; calls to the pool do not.

The accepted declarative actions/adapter trace, route/taxonomy and manifest all register through
`defineProtocolFamily`, so only the victim gap blocks production.

## Non-blocking deviations to record if the gap is fixed

- Declarative `execution` self-approves inside the runtime program, so `buildFragment.requirements` is
  empty while the hand-written family emitted an `approve` `MaxUint256` requirement. The program still
  grants the same allowance before `swap`; planners must not also queue a separate approve node.
- `createDeclarativeProgramAction` matches the declared `swap` trace by selector only, the same shape
  as the hand-written `bindProtocolLegAction` registration.

## Proposed minimal fix (not applied; public framework TS is out of scope here)

Add a v2 `victim` module (same pattern as `quoteFlow`/`trialState`) whose declarative stage compiles
`canonicalIntakeTargets`, call patterns, runtime detection and a closed-op decode body, and have
`build-declarative-production.ts` render it into the existing `protocol.oracleVictim` contract.
Accepting a `victim.binding` TS module would re-introduce the handwritten root this migration removes.
