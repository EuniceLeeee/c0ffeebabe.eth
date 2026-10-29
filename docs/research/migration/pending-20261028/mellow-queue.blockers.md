# protocol:mellow-queue — declarative migration blocked (2026-10-29)

Status: **STOPPED / parked**. The JSON draft below is a full transcription of
`venues/protocols/mellow-queue-family/*.ts` except the deposit execution
encoding, which the common JSON execution compiler cannot express. A
redeem-only production entry would drop the deposit direction and is not
authored.

- Draft: `mellow-queue.draft.json` (2599 lines, protocol-json-v2)
- Draft math entry: `mellow-queue-math.ts.draft` (pure sync-queue quote)

## Source of truth read

`venues/protocols/mellow-queue-family/{abi,action,capture,discovery,exact,execution,identity,instance,manifest,math,pricing,protocol,routes,shared,types}.ts`
plus `adapters/mellow-queue.ts` and
`production-families/mellow-queue.production.ts`. The family is enabled by
default (`activation.enabled: true`).

## Blocker B1 — `deposit(uint224,...)` runtime amount cannot be compiled

- The queue interface is `deposit(uint224 assets, address referral, bytes32[]
  merkleProof)` (`mellow-queue-family/abi.ts:11`). The handwritten runtime leg
  patches the first calldata word with `amountIn`:
  `new RuntimeAmountProgram().call(queue, encodeFunctionData("deposit",[0n,executor,[]]), {patches:[{offset:4,reg:0}]})`
  (`mellow-queue-family/execution.ts:23-25`); the quoted fragment carries
  `params:{referral}` and relies on the same encoder.
- Declarative execution v2 routes dynamic arguments through
  `encodeDeclarativeCall` (`venues/declarative-execution.ts:348`), whose
  `scalar()` accepts **only** `uint256` or `bytes32` leaves
  (`venues/declarative-call-codec.ts:27-29`) and otherwise throws
  "runtime ABI references require uint256 or bytes32 leaves"
  (`declarative-call-codec.ts:43-46`). `uint224` is rejected even though the
  patch itself is a fixed-width word.
- Declarative execution v1 does not provide an alternative: its patch path
  requires **every** input to be a scalar word
  (`declarative-execution.ts:343-346`), and the `bytes32[] merkleProof`
  parameter is dynamic.
- Observed failure (draft, synthetic invocation):
  `buildFragment` and `buildRuntimeLeg` for the deposit descriptor both throw
  `/uint256 or bytes32 leaves/`; the identical redeem path
  (`redeem(uint256,address)`) builds and encodes correctly.
- Impact: deposit is a declared direction (`manifest` wrap + `mellow-deposit`
  action). Omitting it narrows the family's supported behavior, which the
  migration policy forbids. There is no Family-local workaround: the
  declarative `ExecutionSemantics.buildFragment`/`buildRuntimeLeg` always go
  through this compiler; the handwritten action adapter is not selectable from
  JSON.
- Minimal shared fix (not applied; public framework TS is out of scope):
  allow fixed-width `uintN`/`intN` runtime leaves in
  `declarative-call-codec.ts` `scalar()` with an explicit width bound, or let
  v1 patch scalar arguments of a call whose other inputs are dynamic
  (`declarative-execution.ts:344`). Both need negative overflow tests.

## Deviation D1 — probe actor authority cannot be registered from JSON

- TS identity uses a fixed historical verified actor
  (`mellow-queue-family/shared.ts:29-34`, evidence id
  `mellow-queue-probe-actor`, requirements `caller:"verified-actor"` at
  `identity.ts:49-61`). Caller authority is the central
  `production-verified-actors.ts` map (`:34-48`); the id is absent, and
  `verified-actor` requests with an unknown id fail closed
  (`revm-strict-simulation-transport.ts:330-331`,
  `strict-central-adapter-runtime.ts:716`). JSON-only migration cannot add the
  entry.
- The draft therefore uses the nominating call's **observed sender** as the
  probe actor (`discovery` maps `actor` from the call observation `sender`;
  identity probe caller/override are `observed-sender`, receiver/referral is
  the same address). This is same-source (the block where that address really
  deposited/redeemed, so allowance/whitelist state is the historical one) and
  is fail-closed: without a sender the candidate is not decoded, and a
  simulation whose observed debit/receipt does not match fails the behavior
  proof. It is still a semantic deviation from the fixed TS actor; if
  `mellow-queue-probe-actor` is added to `production-verified-actors.ts`, the
  draft's three probe `caller`/`account` values should switch to
  `{kind:"verified-actor",evidenceId:"mellow-queue-probe-actor"}`.

## Other documented deviations (fail-closed)

1. Exact evidence keeps the real oracle report via
   `retainReadEvidence:true`, but the local-math quote flow cannot claim
   `chainAmountQuote` (the TS method sets it). No continuity claim is made;
   quote output is still re-derived from the retained read proof.
2. A failed/absent simulation result is refused by the common active-proof
   guard ("requires successful results") instead of being converted to
   `chain-proven-rejected` as `decodeActive` does in TS. Unresolved stays
   unresolved; no candidate is admitted.
3. `isSuspicious=true` produces no quote and no `classifyUnavailable` entry, so
   snapshot validation fails closed instead of silently producing no mid.
4. No `trialState` module: sequential prefix quoting fails closed with the
   declared `localStateUnsupportedReason`; TS also has no local transition
   model.

## What the draft already validates

- In-memory `createDeclarativeProtocolRuntime` compile + `defineProtocolFamily`:
  one variant, `math`/`quoteFlow`/`pricingFlow` compiled, `trialState`/
  `executionMath` undefined.
- Synthetic semantics (script in `listener/.migration-mellow/exercise.ts`,
  removed after the window): base→surface→probe identity for both kinds,
  verified and `mellow_queue_behavior_failed` decisions, discovery field
  mapping for both call patterns and malformed-calldata rejection, route keys
  (`protocol:mellow-queue\x1f<queue>\x1f<kind>`), static decimals evidence,
  pricing snapshot/zero-price classification/suspicious fail-closed, Exact for
  positive and zero amounts, deposit quote math parity with the TS
  `depositShares`/`redeemAssets`, redeem `buildFragment`/`buildRuntimeLeg`.
  Deposit execution is asserted to throw the codec error above.
- Temporary rendered entry at `production-families/mellow-queue.production.ts`
  (from `renderDeclarativeProductionEntry`, restored afterwards) +
  `node --import tsx --test
  src/searcher/venues/protocols/mellow-queue-family/test/{contract,math.test}.ts`:
  5/5 pass. This only proves registration/contract shape, not deposit
  execution.

## Re-entry checklist

1. Shared compiler accepts uint224 (or an equivalent bounded runtime patch).
2. Re-add `mellow-queue-math.ts.draft` as `venues/mellow-queue-math.ts` and its
   entry in `declarative-math-models.ts`.
3. Move the draft to `venues/protocols/mellow-queue-family/mellow-queue.json`,
   regenerate the entry, run the two family tests, then the strict/Ready gates.
4. Decide the actor: central verified-actor entry (preferred) or keep the
   documented observed-sender deviation.
