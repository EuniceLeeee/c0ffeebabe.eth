# protocol:yieldbasis-lt — still blocked, one gap left (G-YB5)

Verdict: **blocked**, but the previous three blockers are gone. Framework `6876fef0` (§6
`declarative-execution-simulation` / `programReceipt` / `simulationActor`, execution `math` /
`executionMath`) closed G-YB1/G-YB2/G-YB3: the **deposit direction is now expressible end to end**
(identity 4th-round guarded program proof, program-receipt exact quote, reserve-derived debt in the
VM). What remains is a **per-direction module** problem: one descriptor must be served by exactly one
declarative variant, but `quoteFlow.sourceKind`/`chainQuote` is declared once per variant, while this
family needs a **view** proof for withdraw (`preview_withdraw`) and an **effect-simulation** proof for
deposit (executor-program receipt). Everything else compiles and matches the TS family byte for byte
(identity/descriptor/route/pricing) or behaviourally (execution/action).

Parked artifacts (all **not** deliverables):

- `yieldbasis-lt.draft.json` — maximum expressible declaration: **both** directions in one variant;
  withdraw exact fully faithful; deposit identity/execution/pricing/route faithful; deposit exact
  **fails closed** with `Yield Basis deposit exact requires a per-direction chain proof (framework gap
  G-YB5)`. 2399 lines, `protocol-json-v2`.
- `yieldbasis-lt-math.ts.draft` — the `executionMath` model (`yieldbasis-lt:deposit-debt@1`), to be
  registered append-only in `declarative-runtime-math-models.ts` when the JSON lands.
- `yieldbasis-lt.harness.ts.draft` — the validation harness that produced the results below
  (temporary copy at `listener/src/searcher/test/yb-harness.ts`; run with `node --import tsx`).
- `yieldbasis-lt.gap-probe.ts.draft` — the two-configuration probe that isolates G-YB5.

Policy unchanged: JSON-only migration, public framework TS/tests untouched, no production generator
run, no live/Ready/VM work. A temporary canonical copy of the draft was rendered into
`production-families/yieldbasis-lt.production.ts` to run the family suite; the tree was then restored
(only the four parked docs differ).

## 1. What the new framework now makes expressible (validated)

Every item below was checked against the live TS family (`plugin` from
`production-families/yieldbasis-lt.production.js`) with the same synthetic fixtures
(`yieldbasis-lt-family/test/fixtures.ts`).

| Capability | Result |
| --- | --- |
| `renderDeclarativeProductionEntry` | `protocol-json-v2`, family `protocol:yieldbasis-lt`, both owned action ids |
| `createDeclarativeProtocolRuntime` / `defineProtocolFamily` | compiles; `math=undefined`, `executionMath=compiled`, `quoteFlow=compiled`, `pricingFlow=undefined`, `trialState=undefined` |
| discovery | 4 call patterns, 2 events, LevAMM surface, `candidateKey`, `txSeedNominations` — all equal TS |
| identity, withdraw branch | `base → binding → active`, 3 rounds, **deep-equals** the TS identity object (facts + `evidenceHash`) |
| identity, deposit branch | **4 rounds** (`rounds[3] === ["active-deposit-program"]`), `depositPathVerified:true`; **deep-equals** TS, including `depositProgramProof` (`4907b2b1…`) and the reserve-derived `depositProbeDebt` |
| identity, guarded program reverted | TS behaviour reproduced: withdrawal admitted, `depositPathVerified:false`, proof hash still published, deposit route withheld; deep-equals TS |
| descriptor / routes / graph | both descriptors deep-equal TS; routes `["withdraw"]` vs `["withdraw","deposit"]`; `projectGraph` deep-equal |
| pricing | draft, static evidence, finalized descriptor, current requests+snapshot, mids, dependencies and both compatibility projections deep-equal TS (deposit NAV via `pricePerShare`, withdraw via `preview_withdraw(1e18)`) |
| exact, withdraw | the **same six TS requests and calldata**; `amountOut 1005642419965475619`; every evidence field equals TS, **now including `liveSupplyTokens` / `liquidityTotal` / `poolAssetBalance`** (the old G4 loss is closed by `exact.retainReadEvidence` + `$steps`), plus the retained read proof |
| exact, deposit | **blocked** — see §2 |
| execution, deposit | same mutating call sequence as TS (`approve,approve,deposit,approve`), `debt = assets * balances(0) / balances(1) = 20000000000000000` computed in the VM by `yieldbasis-lt:deposit-debt@1`; `short-mint`, `no-debit` and `stable-drain` are rejected by both the JSON program and the TS program |
| execution, withdraw | same call and shares as TS; runtime floor `1` vs TS `0` (recorded deviation) |
| fragment / expectedEffects / action | withdraw fragment adapter+amount equal TS, mismatched quote refused; `expectedEffects` deep-equal for both directions; the withdraw action emits exactly one `withdraw(shares, quotedFloor)` call (all other calls static) |
| family suite with a temporary rendered entry | **39/42** pass; the 3 failures are the two recorded program-byte deviations and the G-YB5 deposit exact (§4) |

## 2. G-YB5. One exact-quote proof kind per variant, two directions per descriptor

`select()` requires a descriptor to match **exactly one** variant
(`declarative-protocol.ts:181-185`) and every capability resolves that variant from the descriptor
alone (`routes.project` `:214-217`, `exact.methods` `:531-533`, `pricing` `:420-445`,
`execution.buildRuntimeLeg` `:641-648`). A second declarative variant cannot take over one direction:
declarative identity variants report `applies: () => true` (`declarative-identity.ts:105`) and the
runtime admits the first variant that verifies (`adapter-family-runtime.ts:3604-3625`), so the **root**
variant's 4-round identity decides `depositPathVerified` and therefore which routes the descriptor
projects. The root variant must serve both directions.

Inside that one variant the quote module is singular:

- one `quoteFlow` is read per variant (`declarative-protocol.ts:140`,
  `declarative-protocol-modules.ts:68-77`) with **one** `sourceKind`, and `decodeExact` verifies
  exactly **one** declared `chainQuote` (`declarative-protocol.ts:618-623`);
- a `view` proof only accepts an `eth-call` with ABI amount paths
  (`declarative-quote-proof.ts:91-104`), while an `effect-simulation` proof only accepts a returned
  token-delta simulation (`:106-108`);
- the ordered request rounds are also variant-level (`declarative-read-flow.ts:50-66`): round 0 of the
  exact quote is step 0's request list (`declarative-protocol.ts:578-580`), and the deposit quote must
  be **one** `executor-program` request with id `deposit-receipt` (`deposit-exact.ts:21-37`) while the
  withdraw quote must be the **six** preview/capacity calls (`exact.ts:64-101`).

The deposit receipt itself cannot move to the legacy `readPrograms.quote` path either: `programReceipt`
consumes the issuer's observed request/result pairs (`declarative-values.ts:128-140`), which only
read-flow and identity decodes bind (`declarative-read-flow.ts:115`, `declarative-identity.ts:111`);
the legacy exact decode environment has no `requests` (`declarative-protocol.ts:605-611`).

Reproduced two ways with the real family JSON (`yieldbasis-lt.gap-probe.ts.draft`, one step, requests
branched on the direction, everything else identical):

```
sourceKind=view              withdraw: requests=eth-call×6                        amountOut=1005642419965475619
sourceKind=view              deposit : REFUSED read-flow proof request is missing
sourceKind=effect-simulation withdraw: REFUSED read-flow proof request is missing
sourceKind=effect-simulation deposit : requests=effect-delta-simulation          amountOut=2000000000000000
```

That is: **each direction quotes exactly as TS does, and the only thing that cannot vary per direction
is the declared chain proof.** A first, cruder reproduction against the erc4626 fixture surfaced the
same pair as `chain quote proof transport or completion mismatch` (view proof observing the simulation)
and `chain quote proof requires returned token effect simulation` (effect proof observing an eth-call).

Consequence for the declaration: with `sourceKind:"view"` (the parked draft) the deposit route would be
served by the withdraw flow, so the draft refuses it explicitly in `exact.checks`
(`Yield Basis deposit exact requires a per-direction chain proof (framework gap G-YB5)`). Without that
guard the engine still refuses, at `verifyDeclarativeQuoteChain` — the failure is fail-closed, never a
wrong amount.

### Minimal engine change that closes it

Let the exact quote's proof/step program be selected per direction, e.g.:

1. `exact.quoteFlows: { withdraw: <declarative-read-flow>, deposit: <declarative-read-flow> }` (or
   `modules.quoteFlow.directions`), selected by `$route.direction` at
   `declarative-protocol.ts:531-533/578-580/618-623`; **or**
2. `chainQuote`/`sourceKind` allowed to be a per-direction map, with `quoteProofSteps` resolving it from
   the invocation's direction (`declarative-quote-proof.ts:122-139`).

Option 1 also removes the second-order deviation in §3.1 (a withdraw leg would stop carrying the
deposit reserve reads). Nothing else is missing: identity, routes, discovery, pricing, execution,
action and the withdraw quote are already expressible.

## 3. Recorded deviations of the parked draft (all fail-closed)

1. **Withdraw runtime/quoted program carries the deposit reserve reads.** Because one variant serves
   both directions and `execution.steps` is a fixed list (`declarative-execution.ts:244-250`, a step's
   call cannot be skipped or `when`-gated, `:271`), the withdraw program performs
   `cryptopool.balances(0)`, `balances(1)` and one in-register math step before its `withdraw` call.
   These are read-only and the math inputs are pinned to `1` for withdraw, so the call sequence and
   amounts are unchanged (verified); the bytes and gas differ. A per-direction execution module would
   remove this the same way as G-YB5.
2. **Withdraw runtime floor `1` vs TS `0`.** The declarative runtime leg encodes `minAmountOut = 1`
   (`declarative-execution.ts:458`); `execution.ts:77-88` encodes `min_assets = 0`. Stricter, already
   recorded in the withdraw-only draft.
3. **Program bytes differ from the TS emitters** (effect captures and the two reserve reads above), so
   `test/recipient.test.ts` byte comparisons fail; the mutating call sequence, debt, guards and
   rollback-style rejections match (validated with the bytecode interpreter).
4. **`exact.retainReadEvidence` adds `readProof` to the withdraw evidence** so that
   `liveSupplyTokens`/`liquidityTotal`/`poolAssetBalance` can be published and re-verified by
   `buildFragment` (`declarative-protocol.ts:655-661`). Every TS field keeps its value; the object gains
   the retained proof.
5. **`buildDependentProgram` is present** on the exact method (framework-wide for flow-backed quotes),
   so `deposit-production.test.ts:47` and `contract.ts:265` differ from TS.
6. **Raw deposit probe effects are not re-verified in the identity.** `simulationActor` still requires
   the unique `-amountIn` input debit, the returned mint must be positive, and the guarded
   `programReceipt` (exact token scope, native/extra-token conservation, `data === "0x"`), the
   raw/program mint equality and the `Deposit` event are all enforced. The TS `verifyDepositEffects`
   checks on the raw diagnostic probe (`deposit.ts:130-154`) are not repeated; its own comment calls
   that path "Raw policy diagnostic ONLY, not proof" (`deposit.ts:73-77`).
7. **`approval.verifyAllowance` semantics**: TS additionally re-reads `allowance == 0` after cleanup
   (`deposit.ts:195-196`); the declarative `exact-clear` approval clears and bool-checks the same three
   `approve` calls but does not re-read the allowance. Recorded before as G-YB4, still fail-closed.

## 4. Family suite with a temporary rendered entry

`renderDeclarativeProductionEntry` + `node --import tsx --test
src/searcher/venues/protocols/yieldbasis-lt-family/test/*.test.ts` → **42 tests, 39 pass, 3 fail**:

- `deposit Exact is one guarded request; quoted action and runtime use production emitter` — G-YB5 plus
  deviation 5 (`buildDependentProgram`).
- `withdraw keeps default and quoted bytes; direct construction is amount/quote free` and
  `deposit keeps default and quoted bytes; direct construction is amount/quote free` — deviation 3.

The remaining 39 (identity round budget and program-proof requirement, deposit behaviour, historical
dual/ready observers, recipient observers, probe report, reserve/receipt contracts) pass against the
rendered JSON entry.

Restored afterwards: the temporary canonical JSON, the temporary math registration and the rendered
production entry were removed; `listener/node_modules/.bin/tsc -p listener/tsconfig.live.json --noEmit`
→ exit 0.

## 5. Verdict

The family stays on its TS implementation. The deposit direction is no longer the blocker: it compiles,
proves, prices and executes from JSON, and its exact quote is one declarative-execution-simulation away
from TS parity. What is missing is one generic hook — **per-direction selection of the exact quote
program/proof** (and, for full byte parity, of `execution.steps`). Do not ship the draft as-is: it would
drop the deposit exact quote, and shipping the mirror configuration would drop the withdraw one.
