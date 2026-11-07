# `protocol:curve-lp` — parked declarative draft and blockers (port to 104ff465)

Status: **blocked / not migrated.** Baseline `104ff465` (`codex/json-all-20261107`).
The legacy lineage `curve-lp:stableswap2-18-6-v031` is drafted, compiles, and is
behaviourally equivalent to the handwritten Family through the *declarative*
projection (identity, pricing, Exact, execution, production strict lifecycle).
It still cannot be delivered as a declarative production entry: the other three
lineages are not expressible without new framework capability, and the Family's
own contract suite cannot run green against the declarative plugin without a
framework or test change. Both are excluded by this task ("JSON + family-local
math + append-only registry only"; "park rather than narrow").

Files parked / added here:

- `curve-lp.draft.json` — one-variant (`stableswap2-18-6-v031`) protocol-json-v2
  draft. `manifest.supportedLineages` intentionally contains only the legacy
  lineage: declaring the other three would either over-claim (empty variants) or
  narrow real capability.
- `listener/src/searcher/venues/curve-lp-math.ts` (registered, inert) — the only
  local math the Family has (v0.3.1 `invariant`/`mintQuote`), registered as
  `curve-lp-stableswap2-mint@1`; see "Local math registration".
- `listener/docs/migration/curve-lp-validation.mts` — 44-check harness that drives
  the shared strict lifecycle, Exact, pricing flow and runtime programs against a
  temporary rendered entry.

No production entry, Family TypeScript, public framework TS/test, generated
catalog artifact, or live/VM state was changed. The temporary rendered entry was
restored.

## Reference sample (Obsidian `IMPL配置列表.md`, row "Yearn Auction＋Curve LP")

- Family acceptance surface: pool `0xdcef968d416a41cdac0ed8702fac8128a64241a2`
  (FRAXBP), LP `0x3175df0976dfa876431c2e9ee6bc45b65d3473cc`, source
  N`26152335` (hash `0xb4da0ba9c8490e1037b17c43d3e93a454b77447ea0562dad8becfd29d4964f32`),
  `docs/research/reports/curve-lp-correctness-20261010.json`.
- Original TX `0x6cc7a620da9e1fc47e894ec69bdbd3b1075c05ebc6c1807a3a6a000035fe136b`
  (Yearn auction + Curve LP single-coin mint/redeem legs).
- LP187 lineage expansion anchors: N`26202387` (`0xa1039f36…b134`), N`26200988`
  (`0xf5ad6072…52ec`, swap leg), N`26192964` (`0x6780ef7f…333d`, mint 1).
- No new chain/EVM run was made for this port; the numbers above are the stored
  acceptance anchors, not new evidence.

## What the draft reproduces (measured at 104ff465, temporary rendered entry)

Harness: `SEARCHER_FAMILY_CURVE_LP_ENABLED=1 node --import tsx docs/migration/curve-lp-validation.mts`
→ `ALL CHECKS PASSED` (44 checks). Setup: copy `curve-lp.draft.json` to
`listener/src/searcher/venues/protocols/curve-lp-family/curve-lp.json` and replace
`production-families/curve-lp.production.ts` with

```ts
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import definition from "../protocols/curve-lp-family/curve-lp.json";
export const activation = defineFamilyActivation({"enabled":false,"envKey":"SEARCHER_FAMILY_CURVE_LP_ENABLED"});
export const plugin = defineProtocolFamily(compileDeclarativeProtocol(definition, []));
```

- `createDeclarativeProtocolRuntime(draft, [], { math, executionMath })` compiles;
  module coverage = `math` + `pricingFlow` (no blocked extension).
- Identity: 7 → 15 → 12 requests, decision `verified`; all 13 negative fixtures
  (code, lpCode, minter, reverse, decimals, ramp, killed, debit, receipt, supply,
  missing, native, source) fail closed with the legacy reason codes.
- `routeKey` **equals** the legacy identifier
  `protocol:curve-lp:<pool>:<mint|redeem>:<index>`, and
  `bindingRef.fingerprint` equals `hashCanonical(binding(descriptor))`
  (`a323fe63…4fda`), so Ready/memo keys stay compatible.
- Pricing: 24 requests, 4 quotes, 4 mids, all equal to `mintQuote`/`mockWithdraw`
  on the production sample amounts (1e18 / 1e6 mint, 1e18 redeem).
- Exact: 4 directions × 2 amounts equal to the legacy reference; fragments carry
  the requested amount and pool target.
- Runtime program under the independent interpreter: mint approvals `0 → amount → 0`,
  redeem none, debit `= amountIn`, credit `= pool return ≥ minOut` (the interpreter
  needs the `nativeBalance` fixture, see B2).
- Production strict lifecycle publishes 1 instance / 4 routes and
  `executeFamilyExactQuote` resolves all 8 cases to the legacy amounts.

## Blockers

### B1. A legacy-shaped route can never equal a declarative route

`declarative-family.ts:281` always adds `target` and sets `direction: d.id`;
`:127` forbids `fields.direction`; `:307` requires the canonical hash of the
projected route to equal the caller's route. The handwritten route
(`curve-lp-family/types.ts:17`, `routes.ts:8,12-26`) has no `target`, has
`direction ∈ {mint,redeem}` shared by two indexes and a numeric `index`.

`test/contract.ts` builds its descriptor/routes from the handwritten modules
(`fixtures.ts:58-60`) and hands them to the plugin at `:63`, `:89`, `:109`. All
three failures are exactly `declarative route binding mismatch` (18/21 pass).
Making the JSON accept both shapes is impossible while `target` is injected, and
a JSON-side workaround (`$route.side ?? $route.direction`) would only mask it.

### B2. Declared v2 execution always probes the native balance

`declarative-execution.ts:463-464` appends `unchanged-native` to every v2 route
without native sides. The legacy program has no native probe, and the Family
harness passes only `call` (`test/contract.ts:71-83`), so the independent
runtime testkit throws `native balance fixture required`
(`test/runtime-program-testkit.ts:83`). `executionAssets:{erc20,erc20}` does not
suppress it. v1 is not an escape hatch here: `add_liquidity(uint256[2],uint256)`
patches one element of an array argument, and v1 patches only top-level scalar
words (`declarative-execution.ts:733`; the shared tuple encoder is v2-only).
This is a stricter check, not a capability loss — but it changes the Family's
executable surface and its tests.

### B3. Per-direction direct-output settlement is a variant-level boolean

The Family derives `directOutput` per proven direction
(`curve-lp-family/execution.ts:28-38`, `ng.ts:126-130,299`, `generic.ts:104-107`).
Declarative settlement is one variant-level boolean
(`declarative-execution.ts:113,435,442,450`). `true` over-claims unproven
directions; `false` drops withdrawal-direct settlement for every route. Only the
legacy lineage (no direct output) is faithfully `false`.

### B4. TwoCrypto fee-claim withdrawal has no declarative execution/quote path

`generic-effects.ts:97-113` executes a nested runtime program
(`p.run(genericRawProgram(...)).equal(1,0)`) and conserves pool/FeeReceiver
balances, LP supply and `ClaimAdminFee`/`Transfer` logs per account (`:129-165`).
Declarative execution cannot nest programs (`declarative-execution.ts` has no
nested-program operation), has no log effects, and its effect kinds are limited to
token/supply/native. Declarative identity also observes only executor balances, no
total supply (`declarative-simulation.ts:71-80`). A faithful `registry-fixed-array`
variant needs those capabilities. Restricting it to stable pools would drop real
TwoCrypto pools (capability narrowing).

### B5. `route.direction` cannot carry the protocol direction for two indexes

`:281` sets `direction` to the unique declared id and `:127` forbids overriding
it. The draft labels routes `mint-0`/`mint-1`/`redeem-0`/`redeem-1`; the Family
tests require `route.direction === "mint"` plus `route.index`
(`test/contract.ts:19,58,64`, `test/production-exact.ts:32-38`). With `route.side`
the production lifecycle resolves all four routes correctly (see above), so this
is a route-identity contract mismatch, not a pricing/execution defect.

### B6. Lineage coverage: `registry-stableswap-ng`, `registry-fixed-array`, `registry-underlying-zap`

Not drafted. `ng.ts` (29 KB), `generic.ts` (44 KB) + `generic-effects.ts` (22 KB),
and `zap.ts` (30 KB) cover meta pools, dynamic/fixed arrays, external oracles,
native sides, receiver modes and zap unwrap/wrap. Beyond B3/B4, zap and generic
routes need declared native-asset execution and per-direction settlement, and
`manifest.supportedLineages` must equal the declared variants, so declaring four
lineages without expressing them would silently disable real capability.

### B7. Minor conservatism gaps (compensated in the draft, not equal)

- Discovery re-encodes call calldata but only *decodes* logs
  (`classifyEvent` path, `declarative-discovery.ts`); the values catalogue can
  encode function calldata only (`declarative-values.ts:217`). The draft asserts
  exact data/topic lengths per event, which rejects trailing garbage but is weaker
  than a byte-for-byte re-encode (`discovery.ts:36-43`).
- Malformed `Transfer` payloads are conservatively "affected" in
  `pricing.ts:39-52`; `pricing.mutationPredicate` has no `attempt`/`catch`, so the
  draft would throw instead of returning affected. Well-formed cases match the
  contract test.
- Provenance: the declarative identity evidence hash differs from the handwritten
  one (`203460ee…` vs `e092eae8…`) even though both verify the same facts, so
  existing Ready evidence for this Family needs selective revalidation at cutover.

## Framework changes since the 82bfc8fc park

`git diff 82bfc8fc 104ff465` touches only three declarative files
(`declarative-family.ts` +89, `declarative-execution.ts` +166,
`declarative-discovery.ts` +92). They add signed block evidence, amount rejection,
direct mutation input and discovery mappings; **none of B1–B7 is addressed.** The
draft was re-verified against this baseline, and three JSON-only fidelity fixes
were applied relative to the Oct 29 draft:

1. `routes.key` now joins with `:` so `routeKey` equals the legacy identifier
   (previously `\u001f`, which would have re-keyed Ready/memo/graph entries).
2. `instance.draft` no longer injects `target`/`directions`; the descriptor now
   equals the legacy projection except the verified `decimals` row the quote
   programs need.
3. `pricing.static.dependencies` now names the pool (it referenced the removed
   `target`), so the strict lifecycle reaches the static stage.

## Local math registration

`listener/src/searcher/venues/curve-lp-math.ts` is registered as
`curve-lp-stableswap2-mint@1` in `declarative-math-models.ts` (append-only) so
`tsc -p listener/tsconfig.live.json --noEmit` typechecks the Family-local math and
the parked draft stays loadable. No installed Family binds it, so it is inert at
runtime; if the JSON is dropped, remove the import/entry with it.

The registry file is inside the semantic-dependency closure of every declarative
Family (`declarative-family-modules.ts`), so any append there invalidates the
checked-in `family-capability-shadow.generated.json` for `prebuild --check`. That
regeneration is already required by the other concurrent Family ports and is
exactly the parent's cutover step; it is not caused by the runtime behaviour of
this entry.

## Validation performed

Restored tree (handwritten entry, shared worktree at 104ff465):

- `node --import tsx src/searcher/venues/protocols/curve-lp-family/test/contract.ts`
  → 21/21 pass.
- `SEARCHER_FAMILY_CURVE_LP_ENABLED=1 node --import tsx …/test/production-exact.ts`
  → 1/1 pass.
- `npx tsc -p listener/tsconfig.live.json --noEmit` (`npm run build:live`) in the
  shared worktree currently reports **only** the untracked in-flight file
  `listener/src/searcher/venues/psv-math.ts` (another agent's `RuntimeMathModel`
  typing), which is absent at 104ff465 and unrelated to this port.

Clean-baseline verification (detached `git worktree` at 104ff465, sibling edits
excluded, only `curve-lp-math.ts` + the registry append applied):

- `npx tsc -p listener/tsconfig.live.json --noEmit` → clean (exit 0).
- With a temporary rendered declarative entry + `curve-lp.json` in place:
  `npm run build:live` → clean; harness → `ALL CHECKS PASSED` (44 checks);
  `test/contract.ts` → 18/21 (the three B1 failures);
  `test/production-exact.ts` → 0/1 (only B5: fixed amount expectation).
- The temporary entry and JSON were then removed/restored; the shared worktree
  holds no `curve-lp.json` and no modified `curve-lp.production.ts`.

## Not run / not claimed

- No declaration for the NG/generic/zap lineages (B6), so the Family cannot be
  rendered without capability loss.
- No same-state chain comparison, no Ready/Graph rebuild, no latency measurement
  for this port. The numbers above are offline fixtures plus the shared strict
  lifecycle over the existing fixture transport.
- No generator run: `build-declarative-production.ts` / `build-family-capability-manifest.ts`
  were intentionally not executed (the parent cuts over).
