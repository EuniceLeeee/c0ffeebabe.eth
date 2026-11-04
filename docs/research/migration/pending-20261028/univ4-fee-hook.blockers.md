# `univ4-fee-hook` — declarative definition authored after f4a16ced (2026-11-04)

Status: **definition authored and validated; production entry not switched.** The handwritten
`production-families/univ4-fee-hook.production.ts` is still the production entry because the
production generator was not run (out of scope). No public framework TS/test, live, VM, RPC, signing
or broadcast was touched.

Baseline: `04553544` (merge of f4a16ced). This supersedes the 2026-11-02 parking note: **G-UV4FH-5
is retracted** (the generic declarative action adapters are sufficient, exactly as the already
generated univ4 entry), and **G-UV4FH-3 is no longer decisive**; it is now a legacy-shape test
difference. The one remaining expression gap found earlier (new PoolId sharing one SAT1 hook) was
solvable with a second per-pool trial-state cell, and the engine accepted it.

Deliverables:

- `listener/src/searcher/venues/swaps/univ4-fee-hook-family/univ4-fee-hook.json` — root
  `swap-json-v2` (tiered audited hook): mapped discovery with a hook filter, manager/hook
  active-proof identity, instance/routes, univ4 pricing flow/projection, effect-simulation tiered
  Exact (`declarative-execution-simulation` + `effect-simulation` chain proof), six generic owned
  actions, Swap observation + factory Pool materialisation, SAT1-aware victim nulling.
- `listener/src/searcher/venues/swaps/univ4-fee-hook-family/sat1.json` — same-lineage child
  (`hookModel == "sat1"`): SAT1 code/immutable proof identity, SAT1 pricing flow/projection,
  local-math local Exact with `trialState`, SAT1 `hookData` computation, inherited execution with
  SAT1 hookData argument.
- `listener/src/searcher/venues/swaps/univ4-fee-hook-family/declarative-math.ts` — pure models
  wrapping the verified family code: `sat1Permissions`, actor/seller derivation, `hookData`,
  `sat1QuoteAndApply` transition, state resource effects, integer price rows/unavailable rows.
- append-only registry line in `venues/declarative-math-models.ts`.

## Gaps re-checked

- **G-UV4FH-1 — RESOLVED.** `build-declarative-production.ts:163,319-330` and
  `declarative-family.ts:130-133,207-211` allow two variants on the one
  `univ4:pool-manager-fee-hook-subinstance` lineage.
- **G-UV4FH-2 — RESOLVED.** Per-variant modules/exact/pricing (`declarative-family-modules.ts:101-108`,
  `declarative-family.ts:158-190,668-704`). The tiered root keeps the univ4 view/effect-simulation
  machinery; the SAT1 child overrides `pricingFlow`, `pricingProjection`, `quoteFlow`, `trialState`,
  `liveStateProjection`.
- **G-UV4FH-5 — RETRACTED (was too strict).** `univ4.json` (the generated production entry) already
  uses generic declarative action adapters with empty traces for swap/take/sync/settle; the fee-hook
  actions are clones of those same V4 adapters under family-owned ids. The declarative plugin loads
  with all six actions. The only lost surface is legacy graph nodes built from `params.hookData`
  rather than `runtimeAmountProgram`; the Family's own `buildFragment`/`buildRuntimeLeg` emits the
  runtime node, and the SAT1 hookData checks are enforced in the SAT1 Exact/execution declarations.
  No central/graph consumer of the handwritten `params`/`field2Offset` adapters was found.
- **G-UV4FH-3 — DOWNGRADED to legacy-shape.** Trial-state `reads`/`initial`/`stateChanges`/
  `stateEffects` express the hook-shared curve and the per-actor cooldown map. The earlier concern
  about a new PoolId sharing one hook is solved with a second `pool:<poolId>` proof cell whose
  `initial` is only supplied from the source read flow: with no issued cell a prefix quote returns
  `not-applicable`, exactly like `sat1-local.ts:118-133`. The two remaining differences are
  test-shape only: (a) declarative `fromReadFlow` always returns the transition
  (`declarative-trial-state.ts:159-173`) while the handwritten single-leg result omits
  `stateChanges` (`sat1-local.ts:54-64`, asserted at `test/sat1-local.ts:90`); (b) `buildRequests`
  without issued state fails later with the framework's "trial-state prefix requires issued state"
  instead of the handwritten "sat1 sequential quote requires issued trial state" wording.
- **G-UV4FH-4 — RESOLVED.** Per-variant identities; the audited hook uses
  `sameAddress(hooks, 0xfa43…)`, SAT1 uses the `sat1Permissions` math model in `applies` and in the
  discovery predicate. `sat1Permissions` is no longer a framework gap.

## Validation performed (temporary rendered entry, tree restored)

- `compileDeclarativeSwap` + `renderDeclarativeProductionEntry`: green; generated entry loaded via
  `defineSwapFamily`/`assertDefinedFamilyPlugin` with **6 actions, 2 identity variants, 1 lineage**.
- Independent declarative harness (`.scratch-feehook-tmp`, removed): **43 checks passed** —
  tiered/SAT1 discovery filter and identity decisions, descriptors/routes, tiered effect-simulation
  Exact request/decode/evidence/fragment/runtime leg, SAT1 local Exact against
  `sat1QuoteAndApply`, trial-state transition + sequential prefix quote, SAT1 pricing snapshot/mids/
  unavailable/mutation, Swap observation.
- `test/sat1-local.ts`: **3 pass / 2 fail**, both the legacy-shape items above; quote amounts,
  entropy/cooldown/capacity/dependency rejections, shared-hook PoolId proof and sequential state all
  pass.
- `test/tiered-exact.ts`: **2 pass / 3 fail**; failures come from the test calling the handwritten
  `tiered-exact.ts`/`univ4FeeHookExecution` against a *declarative* route (runtime route hash
  mismatch) and from the handwritten cache-projection assertions, not from the declarative Exact.
  The "tiered quoted fragment rejects old Quoter evidence and foreign origin/executor" assertion
  passes.
- `test/sat1.ts` cannot run unchanged: it imports the handwritten `sat1IdentityVariant`/hook helpers
  and feeds them a declarative discovery candidate, whose mapped fields are flat rather than the
  handwritten `poolKey` object. The declarative identity/route/execution behaviour is covered by the
  harness instead.
- `npm run test:family-json`: **652 tests / 651 pass / 0 fail / 1 skip** (with both staged
  families present); `npm run build:live` and `tsc -p tsconfig.live.json --noEmit`: green;
  `check:protocol-json-samples`: green.

## Remaining work before cut-over

- Framework window: generate the production entry (`family-capability-manifest:generate`) and adapt
  the three fee-hook test files to the declarative plugin API/candidate shape, or keep them as
  legacy evidence. The only behaviour-level differences are the two G-UV4FH-3 shape items.
- Then run Ready/graph/Exact acceptance; this round did not generate or publish anything.
