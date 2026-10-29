# protocol:astra-multitoken — blocked (engine gaps)

Faithful JSON cannot be authored with the current public engine. Verified in-memory draft:
`astra-multitoken.draft.json` (not a deliverable; exercises discovery/identity/instance/exact/
execution/action against a 3-token fixture with a single observed-pair route).

## Source facts

- The strict family projects **every ordered distinct pair** of the behavior-proven registry:
  `listener/src/searcher/venues/protocols/astra-multitoken-family/routes.ts:11-47`; the contract
  test asserts six routes for a three-token registry
  (`listener/src/searcher/test/astra-multitoken-family-plugin.ts:242-256`). The registry accepts
  2..32 tokens (`astra-multitoken-family/codec.ts:30`, `identity.ts:300-311`), so up to 992 routes.
- Pricing is **per route**: `pricing.ts:37` (`stateKey: route => route.routeKey`),
  `pricing.ts:46-64` (`compileDraft` requires exactly one route), `pricing.ts:201-213`
  (`requires one route`). A failed/zero `getReturn` route is isolated; other routes still publish
  (`venues/adapter-family-runtime.ts:3540-3556` publishes only successful state groups' routes).
- Exact is the chain view `getReturn(tokenIn,tokenOut,amountIn)` (`exact.ts:23-77`); execution is
  `change(tokenIn,tokenOut,amountIn,minReturn)` with clear→exact→clear allowance
  (`execution.ts:16-26`); both are expressible in JSON (see draft).

## Gaps (file:line)

1. **No dynamic route projection.** `routes.directions` must be a literal, nonempty,
   unique-id array (`venues/declarative-protocol.ts:97-100`); projection maps only that array
   (`:230`) and derives `routeKey` from the static direction id (`:231`); direction lookup is by
   static id (`:175`). There is no `directions`/`project` expression or program, so the
   registry → `flatMap(tokens × tokens)` fan-out cannot be declared. Encoding the maximum
   Cartesian product as 992 static directions keyed by token index is technically possible but
   hardcodes the 32-token bound into data, replaces token-address route identity with index ids,
   and cannot carry the TS `pairIndex` binding (`routes.ts:42`, `binding.ts:44-68`); treat as a
   framework decision, not an authored-JSON workaround.
2. **No per-route pricing isolation / partial availability.** The engine fixes
   `pricing.stateKey = route => route.instanceKey` (`declarative-protocol.ts:294`) and
   `compileDraft` requires `stateKey === descriptor.instanceKey` with a route array (`:298`); one
   `pricingFlow` snapshot must cover **all** descriptor routes (`:356-361`). With one group per
   instance, a single zero/illiquid `getReturn` pair throws
   (`"pricing flow returned incompatible quote"`) and removes **all** routes of the instance,
   whereas the TS family fails only that pair's state instance and keeps the rest.
3. **Route identity / pairIndex.** Declarative routes derive `routeKey` from the direction id
   (`declarative-protocol.ts:231`) and expose no `pairIndex`; TS binds `routeKey` from
   family/target/tokenIn/tokenOut and checks `pairIndex` against the registry order
   (`routes.ts:19-42`, `binding.ts:44-68`). No current consumer reads `pairIndex`, but a faithful
   all-pairs migration cannot reproduce the TS route identity without evaluated direction ids.

Budget note (not the blocker): 992 quotes cannot fit one request program
(`reth-adapter-work-runtime.ts:172` cap 256; `strict-central-adapter-runtime.ts:181` cap 512) but
can be split across the four pricing rounds allowed by `adapter-family-runtime.ts:373`
(4 × 248). Empty later rounds pass `assertRequestsMatchRequirements` only with per-round dynamic
`transports`; the draft proves this mechanism works for a one-route instance. It still cannot
express gap 2.

## Proposed minimal framework hooks (not applied; public TS is out of scope)

- `routes` block: allow `directions` (or a `project` program) to be a value expression that
  `flatMap`s over `$descriptor.registryBinding.tokens`, with evaluated direction ids/route keys
  and an optional `pairIndex` field on `FamilyRouteDescriptor`.
- `pricing` block: allow `stateKey` to be declared (e.g. `"$route.routeKey"`) and let a
  `pricingFlow` produce a snapshot for only its own state-key group, so one unavailable pair does
  not delete the other routes. Alternatively add a declarative `classifyUnavailable` hook.

## Validated in the draft (in-memory, no repo writes besides this file)

- `JSON.parse` + duplicate-key scan; `renderDeclarativeProductionEntry` (hypothetical canonical
  path); `createDeclarativeProtocolRuntime` + `defineProtocolFamily`; modules:
  `math`/`executionMath`/`trialState` undefined, `quoteFlow`/`pricingFlow` compiled.
- Discovery v2 call/log candidates equal the TS candidates for the same observations; call/log
  candidate keys stay distinct; sender-less calls and same-token pairs reject.
- 3-stage identity: surface (erc165 vs legacy-abi vs denial), registry (dynamic `flatMap` token
  loops, 2..32, uniqueness, pair binding), active effect-delta proof. Evidence fields,
  `behaviorProofHash`, identity `evidenceHash`, facts and provenance are byte-equal to the TS
  strict variant for the same fixture; legacy-abi and legacy-empty-return modes equal TS.
- Instance binding projection hash equals `astraBindingFingerprint(TS descriptor)`; runtime
  requirements equal TS.
- Expected effects equal TS for the probed pair; graph venue equal.
- Pricing static (all registry decimals → `oneTokens`), current `getReturn`, four-round flow
  (rounds 1-3 empty), snapshot and mid/feeBps/reserveA/reserveB/depthProxy equal TS.
- Exact local-zero and `getReturn` request program; exact evidence deep-equals TS.
- Execution v2 (clear→exact→clear approval): approve/change call sequence, targets, calldata and
  amount patches equal the TS `buildRuntimeLeg`; quoted fragment uses `minAmountOut` as
  `minReturn` while the runtime leg uses 1, matching TS; action adapter trace/encode works.
- Negative: stale binding fingerprint, mismatched exact evidence and forged route rejected.
- `npx tsc -p listener/tsconfig.live.json --noEmit` (see migration report).

## Verdict

Skip per migration policy (no public TS changes). Revisit only after gaps 1-2 are closed; the
draft is the ready basis for identity/discovery/exact/execution once dynamic routes and per-route
pricing are available.
