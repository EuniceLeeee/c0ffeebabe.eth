# `univ4-fee-hook` — parked after f4a16ced re-evaluation (2026-11-02)

Status: **still parked / not migrated**. The handwritten
`production-families/univ4-fee-hook.production.ts` remains the only production entry
(activation `enabled:true`, `SEARCHER_FAMILY_UNIV4_FEE_HOOK_ENABLED`). No production entry,
generated artifact, public framework TS/test, live, VM, RPC, signing or broadcast was touched.

Baseline: `04553544` (merge of f4a16ced) on `codex/protocol-json-20261029`. The earlier parking
note is superseded where marked below; the draft `univ4-fee-hook.draft.json` stays evidence only.

## Gaps that f4a16ced actually closed

### G-UV4FH-1 (was decisive) — one lineage, two hook models: RESOLVED

`f4a16ced` permits several variant declarations on one lineage and validates coverage instead of a
one-child-per-lineage count:

- `listener/src/searcher/build-declarative-production.ts:163` now rejects only
  `lineages.length > childFiles.length + 1`; `:319-330` de-duplicates variant `id`s but no longer
  rejects a repeated `lineageId`, and still requires the declared lineage set to be covered.
- `listener/src/searcher/venues/declarative-family.ts:130-133` accepts repeated lineages while
  requiring every variant lineage to be declared; `:207-211` selects exactly one variant by
  `match` and requires a boolean result.

The audited tiered hook and the SAT1 hook can therefore be two variants of the one
`univ4:pool-manager-fee-hook-subinstance` lineage, as already exercised by
`protocols/token-conversion-family/{token-conversion,xwin-allocations-v1}.json` and the new
`test/declarative-production.test.ts:195` case.

### G-UV4FH-2 (was decisive) — one quoteFlow/exact shape per variant: RESOLVED

Modules are read per variant and overlaid over the root declaration
(`venues/declarative-family-modules.ts:101-108`), and exact/quoteFlow/pricing are selected from the
variant that matches the descriptor (`venues/declarative-family.ts:158-190,668-704`). A SAT1 child
can declare `local-math` + `trialState` while the tiered root keeps an `effect-simulation` quote.

### G-UV4FH-4 (was decisive) — model-dependent identity shape: RESOLVED

Each variant owns its identity variant (`venues/declarative-family.ts:321-329`), and `applies` is
evaluated per candidate (`venues/declarative-identity.ts:113`). The fee-hook/SAT1 split is exactly
the handwritten structure (`univ4-fee-hook-family/identity.ts:42-83,155-206` plus
`sat1-identity.ts:18-75`). The `sat1Permissions` bit test
(`univ4-fee-hook-family/sat1.ts:23-25`) is expressible as an identity/discovery predicate through a
declared math model or an address-pattern match; it no longer needs a new framework hook.

## Genuinely still unsupported

### G-UV4FH-5 (decisive, new) — declarative actions cannot carry the fee-hook graph nodes

The declarative action compiler only accepts one-parameter runtime nodes:

- `listener/src/searcher/venues/declarative-execution.ts:947-967` —
  `createDeclarativeProgramAction` sets `isWrapper:false`, `field2Offset:null`, and its `encode`
  rejects any node whose `params` is not exactly `{runtimeAmountProgram}` (`:962`); it never encodes
  a graph node from protocol parameters.

The fee-hook Family currently owns six graph-level action adapters:
`univ4-fee-hook-family/action.ts:56-104` builds `univ4-fee-hook-{swap,take,sync,settle,settle-value}`
from the shared V4 encoders and the SAT1 `swap` wrapper at `action.ts:59-77` validates
`params.hookData`, `zeroForOne`, `amountSpecified === -node.amount`, actor binding and empty
children. `test/sat1.ts:116-128` exercises that path directly. A declarative entry would either
drop these adapters or reject every valid node, which is a capability narrowing, not a migration.
The unlock action is also a wrapper (`adapters/univ4.ts:44-59`, `V4_UNLOCK_FIELD2 = 68`), so even
the runtime-node re-encoding loses wrapper metadata.

### G-UV4FH-3 (narrowed, still a contract mismatch) — single-leg SAT1 trial publication

The earlier claim that SAT1 trial state cannot be declared is no longer accurate:
`declarative-trial-state.ts` now supports expression-valued `reads[].refs`/`initial`, one model,
and expression-valued `stateChanges`/`stateEffects` (`:45-56,109-173`), and a sequential prefix is
accepted once trial state is issued (`:108`; the central consumer already calls
`method.trialState.quote` for prefixes, `adapter-family-runtime.ts:1528-1555`). The hook-shared
ref key/binding/dependencies and per-actor cooldown map can be authored.

What still differs is publication shape: `fromReadFlow` always runs the model and always returns
`stateChanges`/`stateEffects` when the trial-state module is available
(`venues/declarative-trial-state.ts:159-173`), while the production SAT1 local method publishes them
only when the consumer already issued trial state
(`univ4-fee-hook-family/sat1-local.ts:54-64`). The family contract asserts the production shape
(`univ4-fee-hook-family/test/sat1-local.ts:90`), and `declarative-family.ts:689-692` therefore adds
transition fields to a single-leg result that the handwritten method never emits. This is a
result-shape difference (ignored without a prefix) rather than a narrowing, but it is not faithful
as long as the family test is the oracle and test changes are out of scope.

## Non-decisive deviations that would remain

1. **SAT1 pricing mid/fee telemetry**: production `pricing.ts:66-72` derives a float mid
   (`1e18/marginalPrice*0.997` or supply-ratio sell) and `feeBps: 30`; declarative rows are integer
   numerator/denominator/depth (`venues/declarative-pricing-projection.ts:24-31`). A rational can
   reproduce the mid to float rounding, but odd raw-fee hints lose sub-bps precision because
   `feeBps` must be an integer. Telemetry only; Exact still uses the local/Quoter model.
2. **Tiered exact evidence** (`tiered-exact.ts:29-96`) is expressible through the new
   `declarative-execution-simulation` + `effect-delta-simulation` chain proof
   (`venues/declarative-simulation.ts:49-100`, `venues/declarative-quote-proof.ts:160-220`), so it
   is not a blocker; the dropped `gasEstimate` is zero in production anyway.
3. **Deferred/native settlement**: the fee-hook runtime program reuses the shared V4 unlock
   callback; declarative supports the default/direct path and framed deferred with a parent
   witness. Any fee-hook path that relies on deferred input without a witness remains unsupported
   and must be recorded per direction if the Family is ever migrated.

## Verdict

Stop per migration policy. Same-lineage multi-model, per-variant quote sources, per-variant
identity and CREATE2/ABI value ops are now sufficient for the *definition* shape, but G-UV4FH-5
loses a supported graph-level execution/action surface, and G-UV4FH-3 still changes the
single-leg exact result contract. Revisit when declarative actions can encode protocol-parameter
graph nodes (including wrapper metadata) and when trial-state publication can be conditioned on the
consumer having issued state.

## Validation performed

- Read the current sources listed above and the new common tests
  (`declarative-common-models.test.ts`, `declarative-execution-assets.test.ts`,
  `declarative-quote-proof-extended.test.ts`, `declarative-production.test.ts`).
- No JSON/TS/entry change was made for this Family; the draft remains non-importable evidence.
