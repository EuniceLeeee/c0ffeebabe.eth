# custom-swap:uniswap-v1 — blocked (per-direction execution program)

Family: `custom-swap:uniswap-v1` (`univ1-family`), lineage `uniswap-v1:immutable-vyper-exchange`,
activation `SEARCHER_FAMILY_UNISWAP_V1_ENABLED` (default enabled).
Status: **blocked**. Handwritten TS entry left untouched. A partial mapping draft is parked at
`uniswap-v1.draft.json` (not a deliverable; it is not importable as an entry).

## What the framework can express

- Discovery: the four swap calls, the two Vyper events and the address surface map to a v2 mapped
  discovery (`calls`/`events`/`surface`, `nomination: "address-surface"`, labels
  `univ1-exchange`/`univ1-exact-input`/`custom-swap:uniswap-v1`). ABI canonicality, extra data and
  topic-count rejection are already enforced by `declarative-discovery.ts` / `declarative-event-codec.ts`.
- Identity: the Vyper `create_with_code_of` clone pattern is expressible with `matches`/`bytes`
  (`declarative-values.ts:23,225-227`); the implementation code hash selects the issuer-fee vs standard
  model with `codeHash`/`eq`; token/factory/issuer reads, `getExchange`/`getToken` reverse registration
  and `decimals` fit `identity.definition` stages. Multi-stage `decide → requests → decode` is generic
  (`declarative-identity.ts:92-115`).
- Instance/routes: one instance per exchange, two directed routes (`buy`/`sell`) with `fields` and a
  custom route key are expressible (`declarative-family.ts:232-257`).
- Pricing: `pricingFlow` can read `getEthBalance(pool)` (multicall) plus `token.balanceOf(pool)`, and
  `pricingProjection` can publish the same integer `amountOut/amountIn` ratio, depth and reserves.
- Exact/trial state: the issuer-fee quote/transition can be a registered math model; the read flow
  yields the initial reserves; `trialState` (`reads`/`model`/`amountOut`/`stateChanges`/`stateEffects`)
  can carry the reserve cell and the issuer/WETH balance effects. `exact.evidence` can reproduce the
  TS evidence fields (`kind`, `source`, `executor`, `binding`, `routeKey`, `amountIn`, `amountOut`).
- Swap observation: both events decode as `swap` impacts with the standard `createStrictSwapObservation`
  wrapper; `victimSupport: "detect-only"` is available.

## Gap (blocking)

**G-U1. Execution program must differ by route direction, but a variant is selected by descriptor
only and execution steps cannot branch.**

- The engine selects a variant from the *instance descriptor* with no route in scope:
  `declarative-family.ts:199-203` (`variants.filter(v => v.values.evaluate(v.document.match, { descriptor }))`);
  `executionProgram` at `:698-703` calls `select(input.descriptor)`. A family has one descriptor with
  both routes, so one `standard.execution` block must serve `eth→token` and `token→eth`.
- Execution step calls cannot be conditionally skipped: `declarative-execution.ts:450`
  (`execution step calls cannot silently skip on when`). Confirmed by a direct engine probe with a
  v2 step carrying `when: true` → throws that message. Calls also have a static target/signature
  (`declarative-execution.ts:511-549`), so the two different selectors cannot be selected at runtime.
- uniV1's directions are not parameterizations of one call:
  - buy: `WETH.withdraw(amountIn)` then `ethToTokenSwapInput(min, deadline)` with `value = amountIn`
    (`univ1-family/execution.ts:18-22`);
  - sell: temporary finite approval, `tokenToEthSwapInput(amount, min, deadline)` then
    `WETH.deposit()` of the measured native output (`univ1-family/execution.ts:23-31`);
  - direct output uses yet another pair of functions, `ethToTokenTransferInput` /
    `tokenToEthTransferInput` (`univ1-family/recipient.ts:9-47`);
  - the quoted action encoder branches on `fragment.nodes[0].params.buy` and emits different calldata
    (`univ1-family/action.ts:19-24`).
- This is the same generic engine gap already recorded as **M2** in
  `docs/research/migration/framework-ts-changes-20261029.md` (per-direction quote/execution program),
  not landed in the merged framework (`declarative-execution.ts` still has a static `steps` array and
  one `call`/`steps` choice per variant).
- The family contract test exercises both directions through the production entry
  (`univ1-family/test/contract.ts:81-113,114-135,228-247`), so narrowing to one direction is a real
  capability loss, not a test-shape difference.

## Secondary/deviating-but-not-blocking differences (test-side or generic boundary)

1. Declarative `buildFragment` publishes only `params.runtimeAmountProgram`
   (`declarative-family.ts:747-749`; action encoder `declarative-execution.ts:769-790`), while uniV1's
   action needs `params.buy/amountOut/executor` (`univ1-family/execution.ts:41-43`,
   `univ1-family/action.ts:19-24`). If the direction program existed, the action adapter could be a
   declarative program action and the test assertions on `params` would be normalized (the built
   program is the executable artifact). Not the blocker.
2. Declarative native movement is applied by the common `executionAssets` boundary
   (`execution-asset-boundary.ts:139-160`) instead of the family leg's own WETH withdraw/deposit
   (`univ1-family/execution.ts:17-31`). Behaviorally equivalent for the graph asset, but the existing
   test inspects the leg for `WETH.deposit` directly (`test/contract.ts:105-110`), so it is a
   test-shape difference only.

## Engine change that would unblock

Generic: allow **route-scoped program selection** for the execution/quote declaration — e.g.
`execution: { byRoute: { "<direction>": <v2 execution> } }` (and the analogous `exact.quoteFlows`),
or allow `when` on v2 step calls with a static exhaustiveness check that exactly one branch runs.
This is the M2 change; it is protocol-independent and would also unblock `yieldbasis-lt`.
Family-specific after that: register the uniV1 quote/transition math model, author the reserve/
issuer/WETH state effects, and provide the per-direction program bodies.

## Verdict

Stop per migration policy: the hand-written Swap entry stays. Revisit when route-scoped execution
programs exist; no narrowing to a single direction, no drop of direct-output, and no replacement of
the issuer-fee model.
