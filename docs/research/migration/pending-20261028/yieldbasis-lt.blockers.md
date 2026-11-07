# `protocol:yieldbasis-lt` — parked declarative draft and blocker (port to 104ff465)

Status: **blocked / not migrated.** Baseline `104ff465`; ported and parked on `codex/json-all-20261107`
(`284afb49` JSON cutover plus this park commit). The Family keeps its handwritten
TypeScript entry.

The draft compiles and is behaviourally equal to the handwritten Family in every
module a declarative variant can serve — identity (with/without the deposit
program proof), discovery, descriptor/routes/graph, pricing (draft, static,
current, mids, dependencies) and the withdraw Exact. Two directions of one
descriptor need **two different chain-quote proof kinds**, and one declarative
variant declares exactly **one** `quoteFlow.sourceKind`; the deposit Exact is
therefore refused explicitly and the draft is not a deliverable.

Files parked here (all **not** deliverables):

- `yieldbasis-lt.draft.json` — `protocol-json-v2`, one root variant, both
  directions. Only port change from the pre-104ff465 draft: `standard.match` is
  `true` (the current engine requires `evaluate(match) === true`; the old draft's
  `{}` is no longer a match-all). Withdraw Exact is faithful; deposit
  identity/pricing/route/execution are faithful, deposit Exact **fails closed** in
  `standard.exact.checks` with
  `Yield Basis deposit exact requires a per-direction chain proof (framework gap G-YB5)`.
- `yieldbasis-lt-math.ts.draft` — `executionMath` model
  `yieldbasis-lt:deposit-debt@1` (`assets * balances(0) / balances(1)` in the VM).
  To be registered append-only in `venues/declarative-runtime-math-models.ts`
  only when the JSON lands.
- `yieldbasis-lt.harness.ts.draft` — JSON↔TS parity harness used for the numbers
  below. Copy to `listener/src/searcher/test/yb-harness.ts` and run with
  `node --import tsx`.
- `yieldbasis-lt.gap-probe.ts.draft` — isolates G-YB5 by branching one flow's
  requests on the direction and flipping only the declared proof kind.
- `yieldbasis-lt.kind-probe.ts.draft` — isolates the compile-time refusal of
  mixed proof kinds inside `chainQuote.version:2.choices`.

No production entry, Family TypeScript, public framework TS/test, generated
catalog artifact, or live/Ready/VM state was changed. The temporary rendered
entry, temporary JSON, temporary math model and its registry line were all
restored; `git status` contains only other workers' unrelated files.

## Reference sample (Obsidian `IMPL配置列表.md`, row "Yield Basis LT：三实例普通存入／赎回适配正确性完成")

- cbBTC TX `0x1d1f257fc96b602e28292c8ff49a8e9924c3872a48ad0f9cf5d1b2af68d13e60`
  @ N`25978646`; WBTC TX
  `0x061eb9595d5deb25b4e5b410a415e3e4567f28f7566c80aaf86cf30cada6a73e`
  @ N`25981574`.
- Family test anchors: yb-WETH `0x2b9c9f3b…43cea`, landed redeem
  `0x022a9ff85219675bcf0a0a2b17c76ac72b98d5e2c4177bc104edff56e706ee77`
  @ N`26003536`, shares `41886001261762273` → assets `42107000017438537`
  (`yieldbasis-lt-family/test/fixtures.ts:24-42`); pinned pricing block
  N`26030452` / `0xdd4b0d73…238de`.
- No new chain/EVM run was made for this port; the numbers above are stored
  acceptance anchors, not new evidence.

## What the draft reproduces (measured at 104ff465)

Setup: copy `yieldbasis-lt.draft.json` to
`listener/src/searcher/venues/protocols/yieldbasis-lt-family/yieldbasis-lt.json`,
copy `yieldbasis-lt-math.ts.draft` to `venues/yieldbasis-lt-math.ts`, register its
model in `venues/declarative-runtime-math-models.ts` (append-only), render the
entry with `renderDeclarativeProductionEntry` (temporary, restored afterwards).

Harness (`yb-harness.ts`, output `logs/protocol-json-yieldbasis-20261107/harness-parity.log`)
→ **`ALL CHECKS PASSED`**:

| Capability | Result |
| --- | --- |
| `renderDeclarativeProductionEntry` | `protocol-json-v2`, `protocol:yieldbasis-lt`, both owned action ids |
| `createDeclarativeProtocolRuntime` | compiles; `executionMath=compiled`, `quoteFlow=compiled`, `math`/`pricingFlow`/`trialState` undefined |
| discovery | 4 call patterns, 2 events, LevAMM surface, candidate key — equal TS |
| identity, withdraw branch | 3 rounds; deep-equals TS (facts + evidence hash) |
| identity, deposit branch | 4th round `["active-deposit-program"]`, `depositPathVerified:true`; deep-equals TS incl. `depositProgramProof` and reserve-derived probe debt |
| identity, guarded program reverted | TS behaviour: withdrawal admitted, deposit withheld, proof hash still published |
| descriptor / routes / graph | both descriptors deep-equal TS; `["withdraw"]` vs `["withdraw","deposit"]` |
| pricing | draft/static/finalize/current snapshot/mids/dependencies equal TS |
| exact, withdraw | same six requests/calldata, `amountOut 1005642419965475619`, evidence equal TS incl. `liveSupplyTokens`/`liquidityTotal`/`poolAssetBalance`, retained read proof |
| exact, deposit | **blocked — G-YB5** (explicit refusal; engine would also fail closed at the proof check) |
| execution, deposit | same mutating sequence `approve,approve,deposit,approve`, VM debt `20000000000000000`, `short-mint`/`no-debit`/`stable-drain` rejected |
| execution, withdraw | same call/shares; runtime floor `1` vs TS `0` (deviation 2) |
| fragment / expectedEffects / action | withdraw fragment equal TS, mismatched quote refused; expectedEffects equal both directions; one `withdraw(shares, quotedFloor)` call |

## Blocker G-YB5. One exact-quote proof kind per variant, two directions per descriptor

`protocol:yieldbasis-lt` has two routed directions on the same LT instance:
`withdraw` (LT shares → asset) and `deposit` (asset → LT shares). Their exact
quotes are different *kinds* by design:

- withdraw — `preview_withdraw(uint256)` view + five capacity checks
  (`yieldbasis-lt-family/exact.ts:64-101`, first request at `:70`), method id
  `yieldbasis-lt-withdraw-preview` (`exact.ts:224`);
- deposit — one guarded executor-program simulation
  (`yieldbasis-lt-family/deposit-exact.ts:21-37`, request at `:25`), because
  `preview_deposit` is not exact and is not a proof
  (`yieldbasis-lt-family/deposit.ts:73-77`); there is no `preview_deposit` in the
  Family ABI at all (`abi.ts:47` only has `preview_withdraw`).
- `exact.methods` in TS chooses the program per `route.direction`
  (`yieldbasis-lt-family/exact.ts:214`).

The declarative engine cannot carry that per-direction split:

1. **A descriptor selects exactly one variant, and the match cannot see the
   direction.** `declarative-family.ts:234-237` evaluates each variant's `match`
   with `{ descriptor }` only and requires exactly one match. Routes, exact,
   pricing and execution all resolve through that one `select(descriptor)`:
   `declarative-family.ts:273` (`projectRoutes`), `:383` (`routes.project`),
   `:644` (`exact.methods`), `:709-710` (exact requests), `:742-744` (exact
   decode), `:799-806` (runtime leg). A second variant cannot take over one
   direction; two matching variants are rejected, one matching variant must serve
   both directions.
2. **That one variant declares one quote-flow source kind.**
   `declarative-family-modules.ts:19-21` defines `sourceKind` as a single
   `"view" | "effect-simulation" | "local-math"`; `:69-92` validates exactly one
   `quoteFlow` block per variant and passes `block.sourceKind` to
   `quoteProofGroups`. Root/variant overlay merges whole module blocks
   (`declarative-family-modules.ts:106-113`), so a child cannot add a second flow
   either.
3. **`chainQuote.version:2.choices` allows per-direction *selection*, not mixed
   kinds.** Every choice is validated with the same kind
   (`declarative-quote-proof.ts:322-336`). A `view` proof only accepts an
   `eth-call` with a signature/ABI amount path (`declarative-quote-proof.ts:59-70`,
   runtime check `:217`); an `effect-simulation` proof accepts only
   `{step, requestId}` and requires a returned `effect-delta-simulation`
   (`:279-284`). Mixing them inside one flow is refused at compile time (see
   probe output below).
4. **The exact decode verifies with the single declared kind.**
   `declarative-family.ts:762-770` calls `verifyDeclarativeQuoteChain` with
   `sourceKind: declaration.sourceKind`. So a `view`-declared variant can never
   verify a program receipt, and an `effect-simulation`-declared variant can never
   verify the `preview_withdraw` call.
5. **The legacy `readPrograms.quote` fallback does not help.** `programReceipt`
   reads the issuer-observed requests/results bound per evaluation
   (`declarative-values.ts:131-140`, sealed from `env.requests`/`env.results` at
   `:279-282`); the legacy exact decode environment carries `results` but no
   `requests` (`declarative-family.ts:742-744`), so a deposit receipt cannot be
   decoded outside a read flow. It also would not set `chainAmountQuote` /
   the withdraw proof the Family tests require.

Reproduced two ways with the real draft (raw output in
`logs/protocol-json-yieldbasis-20261107/draft-validation.log`):

```
# kind-probe: one step, requests branched on direction, only sourceKind flipped
view-kind, per-direction choices [view, effect]: REFUSED chain quote proof requires an ABI signature
effect-kind, per-direction choices [view, effect]: REFUSED unknown chain quote proof field
view-kind, two view choices (control): COMPILED

# gap-probe: each direction quotes exactly as TS only under its own kind
sourceKind=view              withdraw: requests=eth-call×6                  amountOut=1005642419965475619
sourceKind=view              deposit : REFUSED read-flow proof request is missing
sourceKind=effect-simulation withdraw: REFUSED read-flow proof request is missing
sourceKind=effect-simulation deposit : requests=effect-delta-simulation    amountOut=2000000000000000
```

That is fail-closed in both mirror configurations, never a wrong amount.

### Minimal engine change that closes it

Let the exact quote's proof/step program be selected per direction, e.g.:

1. `exact.quoteFlows: { withdraw: <read-flow>, deposit: <read-flow> }` (or
   `modules.quoteFlow.directions`), selected by `$route.direction` where the
   current code reads `v.quoteFlow` (`declarative-family.ts:709-710/742-744/763`);
   **or**
2. allow `chainQuote`/`sourceKind` to be a per-direction map resolved by
   `quoteProofGroups`/`verifyDeclarativeQuoteChain`
   (`declarative-quote-proof.ts:322-345`) instead of a single `sourceKind`.

Nothing else is missing: identity, discovery, routes, pricing, execution, action
and the withdraw quote already match TS.

## Recorded deviations (all fail-closed, none ship)

With the temporary rendered entry
(`logs/protocol-json-yieldbasis-20261107/family-suite-json-entry.log`):
**42 tests, 39 pass, 3 fail**. The handwritten TS entry is 42/42 on the same
suite (`family-suite-ts-entry.log`), so the three failures are declarative-only:

1. `deposit-production.test.ts:47` — `m.program.buildDependentProgram` is
   `undefined` in TS, always a function for flow-backed exact methods in the
   current engine (`declarative-family.ts:711-725`). The deposit Exact also fails
   earlier in this draft because of G-YB5.
2. `recipient.test.ts:27` ("withdraw keeps default and quoted bytes") — the
   declarative runtime program captures balances/effects differently from the
   bespoke TS emitter; withdraw also carries the deposit reserve reads because
   `execution.steps` is one fixed list (`declarative-execution.ts:267-288`, now
   supports `when`/`op` gating but the draft predates using it). Mutating
   call/shares still match.
3. `recipient.test.ts:27` ("deposit keeps default and quoted bytes") — same
   emitter-byte difference; mutating sequence and debt match.

Other recorded, already fail-closed deviations of the draft:

- withdraw runtime floor `1` vs TS `min_assets=0`
  (`declarative-execution.ts:371` vs `yieldbasis-lt-family/execution.ts:23-33`);
  `buildFragment` carries the real quoted floor in both.
- `exact.retainReadEvidence` adds `readProof` to withdraw evidence so the
  capacity fields can be re-verified by `buildFragment`; every TS field keeps its
  value.
- `approval.verifyAllowance` re-read semantics: the declarative `exact-clear`
  clears and bool-checks the calls but does not re-read `allowance == 0` after
  cleanup (`deposit.ts:195-196`); still fail-closed.
- Raw deposit probe effects are not re-checked in identity (the TS path calls
  itself "Raw policy diagnostic ONLY, not proof", `deposit.ts:73-77`); the guarded
  program receipt, event, raw/program mint equality and conservation are enforced.

## Validation commands (all re-run at 104ff465)

```bash
cd listener
cp ../docs/research/migration/pending-20261028/yieldbasis-lt.draft.json \
   src/searcher/venues/protocols/yieldbasis-lt-family/yieldbasis-lt.json
cp ../docs/research/migration/pending-20261028/yieldbasis-lt-math.ts.draft \
   src/searcher/venues/yieldbasis-lt-math.ts
# append registration in src/searcher/venues/declarative-runtime-math-models.ts
cp ../docs/research/migration/pending-20261028/yieldbasis-lt.harness.ts.draft \
   src/searcher/test/yb-harness.ts
node --import tsx src/searcher/test/yb-harness.ts                  # ALL CHECKS PASSED
node --import tsx src/searcher/test/yb-gap-scratch.ts             # G-YB5 output above
node --import tsx src/searcher/test/yb-kind-scratch.ts            # mixed-kind refusal above
node --import tsx <render script>                                 # temporary entry
node --import tsx --test --test-concurrency=1 \
  src/searcher/venues/protocols/yieldbasis-lt-family/test/*.test.ts   # 39/42
npm run build:live                                                # exit 0 with the rendered entry
```

Restored afterwards: the temporary JSON, math file, registry line, test
harnesses and the rendered `production-families/yieldbasis-lt.production.ts`.
`npm run build:live` on the restored tree: **exit 0**. Full
`tsc -p tsconfig.json --noEmit` is not a gate on this branch and has 1226
pre-existing errors (including legacy `yieldbasis-lt-family/test/*` files);
`build:live` covers the production entries and passes.

## Verdict

The Family stays on its TS implementation. The deposit direction is otherwise
expressible end to end (identity 4th-round program proof, program-receipt quote,
reserve-derived debt in the VM), and the withdraw side is already faithful. What
is missing is one generic hook — **per-direction selection of the exact quote
program/proof** (and, for byte parity, of `execution.steps` / the emitters). Do
not ship the draft as-is: it would drop the deposit Exact quote; shipping the
mirror configuration would drop the withdraw one.
