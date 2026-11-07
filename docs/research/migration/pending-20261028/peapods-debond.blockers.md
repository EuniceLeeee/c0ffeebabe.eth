# `protocol:peapods-debond` — parked declarative draft and blockers (port to 104ff465)

Status: **blocked / not migrated.** Baseline `104ff465` (`codex/json-all-20261107`,
worktree HEAD `284afb49`). The single-lineage WeightedIndex debond Family is drafted
as protocol-json-v2, compiles, and reproduces identity, routes, pricing, Exact,
quoted execution and runtime execution with representative fixtures. It cannot be
delivered as a declarative production entry in this task: the Family's own contract
suite runs **24/26** against the declarative plugin, and the underlying gaps are API /
evidence / measurement-shape mismatches that cannot be fixed in JSON without narrowing
or changing public TS/tests. (The run shows two failing tests; the third gap, B3, is
masked by B1 aborting the same test earlier.) Task scope is “JSON + family math + append-only registry
only” and “park rather than narrow”, so this is parked rather than papered over.

Files parked / added here:

- `docs/research/migration/pending-20261028/peapods-debond.draft.json` — one-variant
  (`peapods:weighted-single-asset-v1`) protocol-json-v2 draft. Activation remains
  disabled (`SEARCHER_FAMILY_PEAPODS_DEBOND_ENABLED`); `manifest.supportedLineages`
  intentionally contains only the implemented lineage (no bond or multi-asset
  over-claim).
- `listener/src/searcher/venues/peapods-math.ts` (registered, inert) — the Family's
  local math models `peapods:runtime-shape@1` and `peapods:debond@1`, appended to
  `venues/declarative-math-models.ts`.
- No production entry, no `protocols/peapods-debond-family/peapods-debond.json`, no
  generated catalog artifact, no public framework TS and no test change. The temporary
  rendered entry was restored (entry sha256 `3d42fa05…4dde`, the 104ff465 handwritten
  entry) after the measurements below.

To reproduce the declarative measurements, copy the draft to
`listener/src/searcher/venues/protocols/peapods-debond-family/peapods-debond.json`
and temporarily replace
`listener/src/searcher/venues/production-families/peapods-debond.production.ts` with the
rendered entry (the generator output is deterministic):

```ts
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import definition from "../protocols/peapods-debond-family/peapods-debond.json";

export const activation = defineFamilyActivation({"enabled":false,"envKey":"SEARCHER_FAMILY_PEAPODS_DEBOND_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol(definition, []));
```

Then run
`node --import tsx src/searcher/venues/protocols/peapods-debond-family/test/contract.ts`
and restore both files afterwards. Never move the draft into the family directory in the
parked state: a JSON with no rendered production entry is rejected as orphaned by the
production generator/check.

> Concurrent-worktree note: `declarative-math-models.ts` also contains a
> `...fluidCreditMathModels` append from another in-flight Family. It is not part of
> this port; this port adds exactly the two `peapods*` imports/entries.

## Reference sample (IMPL list, row “第2笔：Peapods POD 赎回”)

- `docs/research/reports/peapods-debond-correctness-20261010.json`,
  `originalImplTableUpdate` (old/new IMPL rows) and `naturalReady`.
- Original TX `0xb71237be54af5987a37dc5b9fdab19c3b39dae5d0803c3e4237a8b9d4f22b01d`
  (block **N=26152716**, hash `0x0c80d557cb71bdb448a893597f138dd7c6ec530b04fd7b1136a266877c647c5b`).
- POD `0xf7d7cf9195ed7e1fdc0fb26e463618bc09c67c34`, asset
  `0x62d0a8458ed7719fdaf978fe5929c6d342b0bfce`, debond selector `0xee9c79da`.
- Prior handwritten production row at N end: amountIn `1907361111151028811545`,
  amountOut `1869213888928008235314`. These are stored handwritten evidence, **not**
  re-run against the JSON; the JSON port made no new chain/EVM run.
- The same report records the prior handwritten Family contract 26/26 and the shared
  dual-execution suite 77/77. Those numbers bind the old TS entry; they are not JSON
  acceptance.

## What the draft reproduces (104ff465, temporary rendered entry)

Targeted temporary harness (21 checks, not committed; it reuses the fixture builders in
`test/contract.ts`) at the clean 104ff465 worktree: `21/21 checks passed`.

- Compile/import: the rendered `peapods-debond.production.ts` imports
  `compileDeclarativeProtocol(definition, [])`; manifest family
  `protocol:peapods-debond`, lineage `peapods:weighted-single-asset-v1`, disabled activation.
- Identity: positive fixture admits with one route; the six negative fixtures (runtime,
  multi-asset, reverse staking, empty asset code, zero backing, fee mismatch) stay
  `retryable` — the same decisions as the handwritten Family.
- Routes: `routeKey` equals
  `protocol:peapods-debond:<pod>:redeem:<asset>` and
  `bindingRef.fingerprint` equals `hashCanonical(binding(descriptor))`, so Ready memo /
  graph keys remain compatible.
- Pricing: `current.decodeSnapshot` yields supply/backing and the `debond` amountOut;
  `deriveMids` publishes mid `1.176` for the fixture (1.2M backing / 1M supply with the
  2% fee); zero backing is classified `peapods-no-positive-backing` from
  `standard.pricing.classifyUnavailable` and does not publish a quote.
- Exact: the declarative request-program output equals both the handwritten `debond`
  math and the handwritten `program.decode` amount; the quoted fragment executes
  positive under the independent runtime testkit and rejects a 1-wei output shortfall
  (checked-math underflow).
- Runtime leg: executes positive under the same testkit with a selector-aware `call`
  fixture and a `nativeBalance` fixture.
- Mutation (production compiled path): a backing `Transfer` touching the POD marks the
  instance; an unrelated transfer marks nothing; shared-asset filtering matches
  `pricing.mutation.compile` semantics.

The 21-check count includes three checks that assert the documented deviations below
exist (runtime effect captures, descriptor-only mutation call, evidence hash mismatch).
They are measurements of the gaps, not cutover pass claims.

## Blockers

### B1. Declarative v2 execution measures route effects; the Family contract expects a one-call program

`declarative-execution.ts:463-464` appends `unchanged-native` to every v2 route without
native sides, `:548` captures before/after state for each declared route effect, and
`:819` emits `balanceOf` reads for debit/credit captures. The resulting runtime program
therefore contains POD-debit, asset-credit and native probes around the single
`debond` call. The handwritten runtime program contains only the `debond` call
(`execution.ts`, `debondProgram`).

`test/contract.ts:165` calls `inspectRuntime(runtime.program, 12345n)` with **no**
`call`/`nativeBalance` fixtures and then asserts exactly one call
(`test/contract.ts:166`). The generic program throws `word bounds`
(`test/runtime-program-testkit.ts:87`) because the first `balanceOf` bytes are not
supplied; it would also fail the one-call assertion. This is a measurement/shape
difference, not a wrong amount: the same program passes the positive/negative probes
when the testkit is given selector-aware call and native-balance fixtures.
Suppressing the captures in JSON would remove execution’s own debit/credit checks and
is exactly the kind of narrowing this task forbids.

Measured: contract test
`✖ runtime construction passes only r0 into one debond; quoted mode keeps a measured minimum`
(`AssertionError: word bounds`).

### B2. Standalone mutation API requires `routes`; the Family contract calls it descriptor-only

The handwritten `pricing.mutation.affectedStateKeys({ descriptor, observation })` derives
the affected key from the descriptor. The declarative standalone implementation
(`declarative-family.ts:612-621`) evaluates pricing keys from `input.routes` and throws
`Cannot read properties of undefined (reading 'map')` when only a descriptor is passed.
The production compiled mutation path takes `entries` (with routes) and matches the
handwritten filtering; only the contract’s direct call shape differs.

`test/contract.ts:202` calls
`plugin.pricing.mutation.affectedStateKeys({ descriptor, observation })`. A JSON-side
workaround would have to invent routes or use a different key; the production caller
already supplies them, so this is an API-shape gap, not a mutation-index defect.

Measured: contract test
`✖ backing donation refreshes; unrelated Transfer does not dirty every POD holding that asset`
(`TypeError: Cannot read properties of undefined (reading 'map')` at
`declarative-family.ts:621`).

### B3. Exact evidence shape/hash differs; the declared trial state requires extra fields

The declarative trial-state validator requires `evidence.direction` and
`evidence.bindingFingerprint` (`declarative-trial-state.ts:149-150`) in addition to the
handwritten evidence fields (`kind`, `source`, `fingerprint`, `routeKey`, `executor`,
`amountIn`, `amountOut`). The draft therefore declares those two fields. As a result the
JSON exact evidence hash differs from the handwritten evidence hash; `buildFragment`
compares them canonically (`declarative-family.ts:827`) and rejects handwritten evidence
with `execution received incompatible exact evidence`.

`test/contract.ts:168-169` builds its evidence from the handwritten `exact.program` and
passes it to the JSON plugin’s `buildFragment`. Removing the two fields from JSON makes
the trial-state decode fail instead
(`trial-state quote evidence does not match invocation`), and dropping `trialState`
would lose the sequential-prefix capability. The draft keeps the fields and records the
hash difference as a cutover concern: existing exact evidence for this Family must be
selectively revalidated/rebound, not assumed compatible.

Measured in the targeted harness: JSON evidence hash ≠ handwritten evidence hash;
`buildFragment` accepts its own evidence and rejects the handwritten evidence. This
failure is masked in the 24/26 contract run by B1 aborting the same test earlier.

### B4. Candidate-kind metadata is declared differently from the handwritten Family

The handwritten `protocol.ts:2` declares
`candidateKinds: ["observed-call", "registry-member"]`, while its discovery actually
installs `createAddressSurfaceNomination` and lists `address-surface` as a source. The
draft declares `["observed-call", "address-surface"]`, matching the discovery source it
really uses. `candidateKinds` is validated metadata in the current engine (no consumer
found outside the capability manifest), so this is not a functional blocker, but it is
a manifest-metadata difference that should be reviewed before a cutover.

### B5. Existing Ready / exact evidence needs selective revalidation

The JSON Family definition/evidence hash cannot equal the handwritten Family’s
definition hash while B3 persists. Prior Ready memos (`targetMemoFingerprint
5234de0f…`, `familyDefinitionHash 6b3ca514…` in the 20261010 report) therefore cannot
be re-admitted unchanged. No Ready or memo was rebuilt for this port.

## Framework changes since the 82bfc8fc park

`git diff 82bfc8fc 104ff465` touches the declarative framework
(`declarative-family.ts`, `declarative-execution.ts`, `declarative-discovery.ts`,
`declarative-quote-proof.ts`, `declarative-read-flow.ts`, `declarative-runtime-math.ts`,
etc.); the draft was re-verified on 104ff465. None of B1–B3 is addressed by those
changes. The draft needed no JSON-only rewrite relative to the backup artifact: its
route key already joins with `:`, its instance draft does not inject `target`/`directions`,
and its pricing static dependencies already name the POD/asset.

## Local math registration

`listener/src/searcher/venues/peapods-math.ts` is registered as
`peapods:runtime-shape@1` (compiler-runtime identity with only immutable words masked)
and `peapods:debond@1` (source-faithful unchecked uint256 product / two Q96 floors /
retained fee shares / 98%-supply exemption). Both are statically imported in
`declarative-math-models.ts` (append-only). No installed Family binds them while the
draft is parked, so they are inert at runtime; `tsc` still typechecks them.

The registry file is inside the semantic-dependency closure of every declarative
Family, so this append makes the checked-in
`family-capability-shadow.generated.json` stale for `prebuild --check`
(`build-family-capability-manifest.ts --check` →
`generated capability artifact is stale`). Regeneration is the parent’s cutover step;
this task intentionally ran **no generator**.

## Validation performed

Clean detached worktree at `104ff465` (only `peapods-math.ts` + the registry append,
otherwise pristine):

- `npx tsc --noEmit` → the same **1879** pre-existing errors as the clean baseline
  (unrelated Family test/type drift; no new error, no `peapods` error). This full-repo
  `tsc` is already red at 104ff465; `build:live` is the gate.
- `npm run build:live` → exit 0.
- `node --import tsx …/peapods-debond-family/test/contract.ts` → **26/26** with the
  restored handwritten entry.
- With a temporary rendered declarative entry (then restored): import OK,
  `build:live` exit 0, targeted harness **21/21**, contract suite **24/26**
  (B1 + B2 above).
- Shared offline declarative suite `npm run test:protocol-json` with the registry
  append → **711 tests, 710 pass, 0 fail, 1 skip**.
- `npm run check:protocol-json-samples` → exit 0 (unchanged sample library; peapods
  case is already indexed).
- `build-family-capability-manifest.ts --check` → stale (expected, see above).

Shared worktree (task-start HEAD `284afb49`; branch later advanced doc-only to `c5a3ea1a`,
handwritten entry restored, only this port's registry append kept alongside other agents'
concurrent work): contract **26/26**, `npm run build:live` exit 0. Full `npx tsc --noEmit`
is pre-existing red there too, with no `peapods` error.

## Not run / not claimed

- No Ready / Graph rebuild, no mid/effective table publication and no `accept:protocol-json`
  for the JSON entry: no pinned Ready/prices/RPC artifact for N=26152716 was available
  locally, and this port was not authorized to rebuild a block or start live.
- No same-state chain execution, original-TX pre-call parity, natural-loop replay or EV.
  The stored N-end numbers and the old 26/26 + 77/77 results are handwritten evidence,
  not a JSON claim.
- No generator, no production entry, no family-dir JSON, no swap/funding/credit change,
  no live/VM state change, no performance/latency measurement.
- B1–B3 mean the Family is not ready for cutover; resolving them needs a framework or
  test-contract change (or an explicit decision to relax the Family test), not a
  narrower JSON declaration.
