# `univ4-fee-hook` — parked declarative draft and blockers (2026-10-30)

Status: **not migrated**. The handwritten `production-families/univ4-fee-hook.production.ts` remains
the only production entry (activation `enabled:true`,
`SEARCHER_FAMILY_UNIV4_FEE_HOOK_ENABLED`). No production entry, generated artifact, public
framework TS/test, live, VM, RPC, signing or broadcast was touched.

Framework baseline: merged `47422c97` (directional execution, quoteOutput exports, zero-output exact,
conditional trialState, callback-frame expressions, receipt observation).

Files parked here:

- `univ4-fee-hook.draft.json` — partial `protocol-json-v2` draft. It carries the semantically stable
  parts (scope/production/manifest, mapped discovery with fee-hook-owned pattern ids, action/trace
  declaration) plus explicit `_status`/`_blocker`/`_source` keys. It deliberately has **no**
  `identity`/`instance`/`routes`/`pricing`/`standard`/`swap`/`modules` sections and is therefore not
  importable: the production loader rejects the marker keys
  (`listener/src/searcher/build-declarative-production.ts:118-120`) and the missing required blocks.
  It is evidence, not a deliverable.
- `univ4-fee-hook.blockers.md` — this file.

## Source of truth read

`listener/src/searcher/venues/swaps/univ4-fee-hook-family/{manifest,discovery,identity,sat1-identity,sat1,sat1-local,sat1-math,instance,routes,pricing,exact,tiered-exact,execution,action,swap,victim,types}.ts`,
`test/{sat1,sat1-local,tiered-exact}.ts`, `test/univ4-fee-hook-family-plugin.ts`,
`production-families/univ4-fee-hook.production.ts`, and the common engine
(`declarative-{family,discovery,identity,read-flow,execution,callback-frames,swap-domain,quote-proof}.ts`,
`build-declarative-production.ts`).

Baseline note: `node --import tsx src/searcher/test/univ4-fee-hook-family-plugin.ts` already fails in
this tree before any migration change with
`univ4 fee-hook execution received incompatible exact evidence`
(`test/univ4-fee-hook-family-plugin.ts:121` → `univ4-fee-hook-family/execution.ts:110`). The
handwritten contract suite is therefore not green evidence for this family today.

## What the draft already expresses

- **Manifest/scope/activation** exactly match `univ4-fee-hook-family/manifest.ts:35-60` and
  `production-families/univ4-fee-hook.production.ts:22`: family `univ4-fee-hook`, lineage
  `univ4:pool-manager-fee-hook-subinstance`, activation
  `SEARCHER_FAMILY_UNIV4_FEE_HOOK_ENABLED`, six owned fee-hook actions and the three required infra
  actions (`erc20-transfer`, `weth-deposit-value`, `weth-withdraw-amount`), `singleton-v4`.
- **Discovery**: the same manager `Initialize`/`Swap`/`ModifyLiquidity` surface instantiated with this
  family's own pattern ids (required because the landed-event registry keys topics by id,
  `univ4-family/codec.ts:22-42` and `univ4-fee-hook-family/manifest.ts:27-38`), the
  `univ4-pool-surface-v1` address surface, fee-hook labels and the same
  `PositionManager.poolKeys(bytes25)` nomination read flow as the migrated `univ4` JSON. Identity
  remains the admission gate for the audited hook / sat1 hook subset
  (`univ4-fee-hook-family/discovery.ts:24-40`); the draft records this as a comment, because mapped
  discovery has no math-model predicate on the surface and adding one would only duplicate identity.
- **Action descriptors**: the six fee-hook-owned adapter ids with the same descriptor fields as
  `univ4-fee-hook-family/action.ts:28-104` (`univ4-fee-hook-settle-value` is the only
  `canSendValue:true`).

## Decisive blockers

### G-UV4FH-1 (decisive) One lineage, two incompatible hook models

The family has **one** lineage (`manifest.ts:6-8,52`) but **two** descriptor models:

- the audited tiered dynamic-fee hook (`identity.ts:42-83`, hook address/code hash constants in
  `manifest.ts:16-21`), and
- the SAT1 curve hook (`sat1-identity.ts:18-73`, `applies` on `sat1Permissions(hook)`,
  `sat1.ts:23-25`).

`descriptor.hookModel` then selects pricing, exact and execution semantics
(`pricing.ts:29-31,58-66,81-104`; `exact.ts:214-223`; `execution.ts:20-37`).

Declarative variants are per-lineage, and a family's variant set must cover exactly one lineage per
variant:

- `build-declarative-production.ts:163` — `lineages.length !== childFiles.length + 1` rejects a
  second variant on the same lineage;
- `declarative-family.ts:201-205` — a descriptor must match exactly one variant;
- `declarative-family.ts:316-329` — each variant owns exactly one identity variant, but the family
  needs two identity proofs (`identity.ts:42-83` + `sat1-identity.ts:18-73`) under one lineage.

Splitting into two declarative variants would require a second lineage and would change the
production descriptor/route/graph identity — not a faithful migration.

### G-UV4FH-2 (decisive) One `quoteFlow`/`exact` shape per variant vs two quote sources

The tiered model's production default Exact is an **executor-program receipt simulation**:
`tiered-exact.ts:29-66` builds an `effect-delta-simulation` request from the family's runtime program
and decodes the observed token deltas (`tiered-exact.ts:68-96`, `chainAmountQuote`).

The SAT1 model's production default Exact is a **source-pinned local integer curve** with trial
state: `sat1-local.ts:106-134` (`sat1-local-exact-in`, `trialState.quote`, state changes/effects) over
11 `eth-call` reads (`sat1-local.ts:66-94`), plus optional sequential prefix quoting
(`exact.ts:24-61,140-160`).

A declarative variant declares exactly one `quoteFlow` with one `sourceKind`
(`declarative-family-modules.ts:18,65-86`) and one request-program exact method id
(`declarative-family.ts:594-666`). `effect-simulation` and `local-math` cannot be combined in one
variant, and a chain `view` flow cannot prove the tiered simulation receipt. The two models therefore
cannot share one declarative variant, while G-UV4FH-1 forbids two variants on one lineage.

### G-UV4FH-3 (decisive) SAT1 trial state and sequential prefix are not declarable

- The SAT1 state cell is hook-shared and carries dynamic per-actor cooldown keys plus the
  `initializedPools` list (`sat1-local.ts:15,29-40,93`); the state transition is published as
  `stateChanges`/`stateEffects` (`sat1-local.ts:55-67`) with resource coordinates from
  `local-state-models/resources.ts`.
- Declarative trial state requires pre-declared read refs whose evaluated objects must match the
  change refs (`declarative-trial-state.ts:45-56,163-172`) and requires trial evidence to carry
  `executor/direction/amountIn/bindingFingerprint` (`declarative-trial-state.ts:148-151`). The SAT1
  model could be registered as a pure math model (`sat1-math.ts:1-204`), but the hook-shared state
  refs, per-actor cooldown resource effects and issued-state commit are projector-owned; JSON can
  only imitate them, not preserve the production risk proof.
- Sequential prefix: `univ4-fee-hook-family/exact.ts:24-61` requires a complete same-instance prefix
  and emits a V4 Quoter multi-hop path; declarative exact has no `prefix` input in its flow/replay
  environment (`declarative-family.ts:668-704`), and trial state rejects a prefix without issued state
  (`declarative-trial-state.ts:108`).

### G-UV4FH-4 (decisive) Identity decision shape is also model-dependent

The SAT1 identity proof returns a `retryable` decision for the first-100-block entropy window
(`sat1-identity.ts:56-63`) and different facts (`hookModel:"sat1"`, token/minter/genesis reads,
`sat1-identity.ts:18-48`), while the audited hook proof returns `hook_code_hash_changed` /
`pool_not_initialized` with a different fact set (`identity.ts:155-206`). A single declarative identity
variant could branch in `decide`, but it must also own one `quoteFlow`/`exact` shape (G-UV4FH-2) and
one pricing projection, so the identity split cannot be resolved independently of the other two
blockers. The fee-hook/SAT1 candidate filter also needs a bit-mask predicate (`sat1Permissions`) that
is only available through a math model, not through discovery scalar predicates.

## Non-decisive deviations that would remain

If the generic gaps were closed, the following would still need explicit declaration/documentation:

1. **Pricing mid shape**: SAT1 `deriveMids` uses float factors
   (`pricing.ts:85-97`: `1e18/marginalPrice*0.997`, supply ratios) and depth proxies
   (`SAT1_MAX_BUY`, remaining fair-supply cap). Declarative projection rows are integer
   numerator/denominator/depth (`declarative-pricing-projection.ts:19-30`); a rational declaration can
   approximate but not reproduce the production float mid exactly. Telemetry-only, not a trade gate.
2. **SAT1 execution hookData**: `hookDataFor` (`sat1.ts:26-46`) derives an actor-bound buyer/seller
   address and the fee-hook swap action wrapper validates `amountSpecified === -node.amount`
   (`action.ts:57-83`). Declarative execution can compute the same hookData through a math model, but
   the graph-level `univ4-fee-hook-swap` node path (params.hookData) has no declarative adapter; only
   the runtime-program path exists (`declarative-execution.ts:887-891`).
3. **Fee-hook withdrawal/wrap actions**: the manifest requires `weth-deposit-value` and
   `weth-withdraw-amount` infra; those exist on the shared surface but the declarative entry has no
   execution steps that use them. The sat1 `settle-value`/wrap path must be re-expressed if the family
   is ever migrated.
4. **Tiered exact evidence**: `tiered-executor-receipt` evidence carries `executor` and
   `transactionOrigin` (`tiered-exact.ts:88-93`); the declarative evidence hash is re-derived in
   `buildFragment` (`declarative-family.ts:745-749`) and can carry invocation facts, but the
   `gasEstimate`/`hookData` details would need the same treatment recorded for `univ4`.

## Verdict

Stop per migration policy. G-UV4FH-1 (one lineage/two models), G-UV4FH-2 (one quote source per variant)
and G-UV4FH-3 (SAT1 trial state/prefix) are structural; any single-variant workaround would narrow or
rewrite the two production semantics. Revisit when the common framework can declare per-descriptor
exact/pricing programs (or two lineages for one family) and a generic trial-state resource projection.
