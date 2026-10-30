# `swap:algebra-integral` — parked declarative draft and blockers (2026-10-30)

Status: **blocked / not migrated**. The handwritten `algebra-integral.production.ts` remains the
production entry. No live/VM/RPC, signing, public framework TS/test change, production-generator
run or generated artifact. The temporary validation files used for the sibling family are not
part of this family.

Files parked here:

- `algebra-integral.draft.json` — partial `swap-json-v2` draft: scope, manifest, mapped discovery,
  instance projection and routes, Swap observation/calls/action descriptor. It is **not
  importable and not a deliverable**: `identity`, `standard`, `pricing`, `exact` and `modules` are
  omitted because the family cannot be expressed faithfully (see G-A1/G-A2).
- `algebra-integral.blockers.md` — this file.

Framework baseline: merged `47422c97` (directional execution, quoteOutput exports, zero-output
exact, conditional trialState, frame expressions, receipt observation) on top of the Swap/Credit
JSON handoff.

## What the draft expresses

- **Manifest/scope/activation**: family `swap:algebra-integral`, lineage
  `algebra-integral:factory-child`, activation `SEARCHER_FAMILY_ALGEBRA_INTEGRAL_ENABLED`
  (registered disabled in the handwritten entry), one owned action `algebra-integral-swap`, one
  required infra action `erc20-transfer`, `poolAdapterIds ["algebra-integral"]`.
- **Discovery** (`declarative-discovery.ts` v2 mapping): the pool `swap` call, factory `Pool`,
  pool `Swap`/`Initialize`/`Mint`/`Burn` logs and the `algebra-integral-pool-surface-v1`
  address surface; candidate key/instance key = pool; labels `["algebra-integral"]`;
  address-surface nomination; tx-seed nominations. The `factory-log` source is represented as
  `landed-log` because mapped discovery's `sources` enum has no `factory-log`
  (`declarative-discovery.ts:123-127`), the same substitution accepted for univ2/univ3.
- **Instance/routes**: pool/token0/token1/tickSpacing/factoryBinding/executedFee projection, the
  two directed routes and the legacy four-part route key
  `familyId␟lower(pool)␟lower(tokenIn)␟lower(tokenOut)` (`routes.ts:27-48`), graph venue and
  token-delta effects. The draft under-specifies `poolMaterialization` (omitted) rather than
  inventing a decode; the handwritten `swap.ts:94-121` factory-`Pool` materialization is
  canonical ABI and can be added once the identity question is resolved.
- **Swap observation**: canonical `Swap` event with the trailing `overrideFee`/`pluginFee` words,
  the mutation events (`Initialize`/`Mint`/`Burn`), the observed `swap` call and
  `victimSupport: "none"` (`swap.ts:38-52,124-180`). The full event ABI is declarable; the
  declaration is conservative because the handwritten family uses a V3-shaped receipt observer
  with empty intake targets (`swap.ts:83-122`).
- **Action descriptor/trace**: `algebra-integral-swap`, `edgeKind: "swap"`, optional trace on
  `swap(address,bool,int256,uint160,bytes)` (`action.ts:11-41`).

## Blocking gaps

### G-A1 (decisive) One lineage, two exact/pricing models — variants require distinct lineages

The handwritten identity emits exactly one lineage for every admitted pool
(`identity.ts:77,316`, `manifest.ts:6-8`). The executed-fee model is a per-descriptor fact:

- static pools use `algebra-single-range-state` local math (`exact.ts:82-90`);
- dynamic Cypher-plugin pools use the chain `algebra-bound-quoter` with a different method kind,
  `caller: transaction-origin`, evidence shape and cache projection (`exact.ts:78-80`,
  `quoter-exact.ts:1-70`);
- pricing switches refresh policy (`pricing.ts:54`), transports (`pricing.ts:93`), guard reads
  (`pricing.ts:96-97`) and mid semantics (`pricing.ts:191-197`) on the same
  `descriptor.executedFee.kind`.

Declarative exact methods are fixed per selected variant
(`declarative-family.ts:594-667`), and variants are selected by descriptor `match`
(`declarative-family.ts:201-205`). A child variant is the only way to carry a second exact/pricing
program — but the production generator requires one declaration per lineage and rejects duplicate
lineages:

```
build-declarative-production.ts:163   if (lineages.length !== childFiles.length + 1) throw ...
build-declarative-production.ts:319-321  duplicate variant identity/lineage -> throw
```

Splitting static and dynamic into two variants would either:

1. reuse `algebra-integral:factory-child` for both — rejected by the generator; or
2. assign a synthetic lineage to dynamic pools — changes `descriptor.lineageId`, route lineage,
   binding/fingerprint and central lineage semantics for real production instances. Not faithful.

A single variant cannot hold both exact methods: the selected `exact` is one object with one
`methodId`/`requirements`/`quoteFlow` (`declarative-family.ts:594-667`), and a child JSON cannot
override only `exact` without also declaring a distinct identity lineage. This is a framework
declaration-model gap, not a JSON detail.

### G-A2 (decisive) Dynamic-fee binding needs a code/CREATE2 proof the declarative language cannot express

Dynamic pools are admitted only with a bound official Quoter and Cypher plugin
(`identity.ts:98-136,281-282`). `quoter-model.ts` proves:

- fixed Quoter runtime code hash (`quoter-model.ts:18-19,63`);
- plugin bytecode length 15869, immutable words at ten offsets all equal and address-shaped,
  masked-code keccak equal to a fixed normalized hash, and pool/factory immutables equal
  (`quoter-model.ts:22-47`);
- `quoter.factory == pool.factory`,
  `quoter.poolDeployer == factory.poolDeployer`, and
  `CREATE2(poolDeployer, keccak(abi.encode(sorted tokens)), poolInitCodeHash) == pool`
  (`quoter-model.ts:63-78`).

Declarative values can hash code and mask fixed byte ranges (`declarative-values.ts:23,183,226`),
so the plugin length/immutables/normalized hash are authorable with `maskHash`/`bytes`/
`addressWord`. The CREATE2 relation is not: the closed op list has no keccak-of-concatenated-bytes
or CREATE2 derivation, and `hash` is canonical JSON hashing, not keccak
(`declarative-values.ts:23`). `bytecodeGetter` has only the
`solidity-0.7-address-bool-mapping` profile (`declarative-bytecode.ts:3-6,27-34`), not an arbitrary
code/immutable classifier. Dropping CREATE2 is not obviously a no-op: it is the only declaration
that ties the Quoter's deployer/salt/init-code to the admitted pool, and the framework offers no
equivalent generic proof. Even if one argues it is implied by the official Quoter's fixed code
hash plus the factory reverse binding, that is a semantic argument the framework does not make;
recording it as “equivalent” would be a new security claim, not a migration.

### G-A3 (non-decisive) Custom capture nomination and reverse binding

The handwritten discovery owns `nominateAlgebraIntegral` (recent pool `Swap` log
re-materialization) and `reverseBindAlgebraIntegral` (address-surface factory read with code
check) (`nomination.ts:1-51`, `reverse-binding.ts:1-95`; `discovery.ts:74-78`). Declarative v2
always installs `explicitReverseBindingUnsupported` (`declarative-discovery.ts:308`) and exposes
only address-surface/tx-evidence nomination. The draft uses address-surface nomination with
factory/token hints, and identity would still re-verify factory/token/tick/fee and
`poolByPair` on chain. This is the same substitution accepted for Ella/univ2 (a capture-channel
change, not an admission relaxation), so it is not the reason the family is parked.

### G-A4 (settlement, same as univ3) Deferred-input is not migrated

The handwritten runtime leg supports `deferred-input` and `direct-output`
(`execution.ts:47-70,236-260`). Declarative execution's `deferred` model requires uint256
debt/output callback arguments and a parent witness (`declarative-callback.ts:17-40,210-260`),
while Algebra's callback is `algebraSwapCallback(int256,int256,bytes)` with signed deltas; the
framed-settlement path requires a parent expectedOutput witness (`declarative-execution.ts:797-812`;
design doc §6). The draft would declare only default/direct output, matching the univ3 precedent.
This is fail-closed narrowing, not a weakened check.

## Validation performed

- The draft is valid JSON and deliberately not importable; no `createDeclarativeSwapRuntime` run is
  claimed. Compiling would fail on the omitted required `identity`/`standard`/`pricing`/`exact`
  blocks, which is the intended parked state.
- Line references above were checked against the current tree. The framework variant/lineage
  constraints are in `build-declarative-production.ts` and `declarative-family.ts` as cited.
- No public framework TS/test, production entry, generated artifact or generator output was
  changed.

## Revisit conditions

1. A generic way for one lineage to select a per-descriptor exact/pricing program (for example,
   variant selection by an instance-controlled fact that does not require a distinct lineage, or
   an exact program with declared per-descriptor method choice). This is the first blocker.
2. A declarative code/CREATE2/immutable-word proof profile for plugin-bound Quoters (not a
   protocol-specific hook). Without it the dynamic variant cannot be admitted faithfully.
3. Optional: declarative nomination/reverse-binding hooks, and a signed-int256 deferred-settlement
   model, to remove the capture/settlement substitutions.
