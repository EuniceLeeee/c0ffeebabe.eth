# `protocol:ondo-usdy-instant-redeem` — blocked declarative JSON (2026-10-28)

Status: **blocked** (draft parked; no production JSON, no production entry, no action adapter authored).
Framework baseline: `6876fef0` (family-runtime baseline in `work/protocol-json-20261028`).

## Hard blocker G-O1 — the helper call has no declarable ABI

The handwritten runtime leg is a single call to an unverified helper with a manually assembled
selector/calldata:

- `listener/src/searcher/venues/protocols/ondo-usdy-family/execution.ts:18` resolves the actor with
  `runtimeExecutor(executor, ONDO_REDEEM_HELPER, d.rwa, d.receive)`; `:20` builds
  `new RuntimeAmountProgram().call(ONDO_REDEEM_HELPER, buildOndoHelperCalldata(actor, d.receive, d.rwa))`;
  `:21` wraps it as the leg. The helper address is at `helper.ts:3`.
- `helper.ts:5-10` assembles `0xccee0802` plus nine static words by hand. The helper is unverified and
  no function signature is recorded, so the selector cannot be re-derived from an ABI.
- The declarative execution compiler only accepts declared ABI calls: `declarative-execution.ts:99`
  (execution key whitelist), `:135` (call fields `target/signature/args/save/checks/when/value`),
  `:330-363` (`callInterface(signature)` + `encodeFunctionData`), and `declarative-call-codec.ts:34-60`
  derives selector/offsets from the signature. There is no raw calldata/selector field.
- Substituting the manager's `redeem(uint256,address,uint256)` (selector `0xd8780161`) would change the
  executed bytes and semantics (the helper call is address-only and does not pass an amount), so it is
  not a faithful transcription. Verified in the parked draft's harness: helper selector is
  `0xccee0802`, manager selector is `0xd8780161`.

Unblock options (framework change, not done here): a shared declarative raw-call capability carrying
closed ABI/calldata evidence, or a verified helper ABI whose declared signature re-encodes exactly
`0xccee0802` plus that body.

## Secondary gaps (need review even after G-O1)

| Gap | Handwritten | Declarative engine | Line evidence |
|---|---|---|---|
| G-O2 candidate key | `` `${manager}:${receive}` `` | multi-field key serialized with `JSON.stringify` | `ondo-usdy-family/discovery.ts:36`; `declarative-discovery.ts:275-285` |
| G-O3 exact provenance | `chainAmountQuote: true` with no amount-returning chain view | local-math flow ⇒ `trialState.unsupportedReason` | `ondo-usdy-family/exact.ts:36`; `declarative-protocol.ts:544-559` |
| G-O4 zero-input method | only the request-program method | `local-zero` always exposed | `declarative-protocol.ts:538` |
| G-O5 source scope | base asserts source over the manager-code result only; complete over the first price read | read flow requires one canonical source for every result | `ondo-usdy-family/identity.ts:77,97`; `declarative-read-flow.ts:109-112` |
| G-O6 zero pricing | publishes `amountOut: 0` and only skips the mid | snapshot validator rejects `amountOut == 0` unless classified unavailable | `ondo-usdy-family/pricing.ts:54-59,64-69`; `declarative-protocol.ts:384-390` |
| G-O7 mutation coverage | oracle logs invalidate the instance | shared predicate intersects dependencies with mutation addresses | `ondo-usdy-family/pricing.ts:80-82`; `declarative-protocol.ts:510-519` |

Transcribed without change (for the record): identity hardcodes `rwaDecimals: 18` /
`receiveDecimals: 6` at `identity.ts:77`, then pricing static evidence re-reads actual decimals at
`pricing.ts:23-38`; `decodeComplete` returns an explicit object without `redeemPaused`
(`identity.ts:97`), which the draft reproduces. The draft adds oracle to `mutationAddresses` as a
provisional mapping for G-O7 (broader index registration) and classifies a zero quote as
`ondo_zero_output` (new reason code, G-O6) rather than silently publishing zero.

## Parked draft

`docs/research/migration/pending-20261028/ondo-usdy-instant-redeem.draft.json`

Contains: production/scope/manifest, discovery v2 (redeem call + `Redemption` log), two-stage identity,
instance, single route with the original `${FAMILY}\u001f${lower(manager)}` key, pricing (including the
two decimal static-evidence reads), exact + local-math quote flow, module bindings.

Deliberately omitted: `standard.execution` and `actionAdapters`. Registration therefore fails with
"variant declaration has missing or unknown fields" (asserted), so the parked file cannot be mistaken
for a production definition. The draft references math model `ondo:redeem`; no ondo math TS file was
registered while the family is parked — a future `ondo-usdy-math.ts` must register it first.

## Validation performed (in memory; no repo writes besides the draft and this doc)

With a harness-only execution section (manager `redeem`, *not* part of the draft) and a temporary
in-memory registration of `ondo:redeem` transcribed from `ondo-usdy-family/math.ts`:

- draft as-is: renderer/registration rejected (missing execution) — asserted;
- identity base/complete evidence and verified identity hash-equal to `ondoIdentity` on a synthetic
  pinned vector; paused and unaccepted receive token fail closed in decode;
- descriptor, static binding projection, declared route key, pricing draft fields (modulo `routes`),
  finalized pricing descriptor, current requests, snapshot, mid and below-minimum unavailable outcome
  hash-equal to `ondoInstance` / `ondoRoutes` / `ondoPricing`;
- exact request ids/calldata, amountOut (1,115,700 for 1e18 RWA at the synthetic prices) and evidence
  hash-equal to `ondoExact`; the TS method's `chainAmountQuote: true` vs the declarative
  `trialState.unsupportedReason` is recorded as G-O3;
- helper selector/leg blocker asserted as above.

No ondo historical fixture exists in the baseline; vectors are synthetic. The only ondo family test
(`ondo-usdy-family/test/contract.ts`) checks manifest registration and does not exercise execution.

## Re-entry checklist

1. Resolve G-O1 (raw-call capability or verified helper ABI).
2. Decide G-O2 candidate-key compatibility (accept the new serialization with a migration note, or
   extend mapped discovery).
3. Revisit G-O3/G-O5/G-O6/G-O7 deviations with the family owner; no widening of the original quote or
   settlement semantics.
4. Add `execution` + `actionAdapters`, register the math model, rerun in-memory parity and the family
   contract, then run central generation.
