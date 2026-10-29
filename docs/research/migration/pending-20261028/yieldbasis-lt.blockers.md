# protocol:yieldbasis-lt — blocked (engine gaps)

Verdict: **blocked**. A faithful `yieldbasis-lt.json` cannot be authored with the current public
engine. The family has two routed directions and the deposit direction cannot be expressed; dropping it
would narrow behavior, so no canonical JSON was written.

Parked artifact: `yieldbasis-lt.draft.json` — **not** a deliverable. It covers the withdraw direction
only and is validated in memory against the live TS family (byte-identical identity/descriptor/route on
the withdraw branch). It exists to prove which half is expressible and to localise the gap.

Policy: JSON-only migration; public framework TS untouched; no generator run; no math-model file added
(the one sanctioned registry would not help — see G-YB3).

## 1. Source facts

- The family owns two actions/directions: `yieldbasis-lt-withdraw` (burn LT shares → `ASSET_TOKEN`) and
  `yieldbasis-lt-deposit` (spend `ASSET_TOKEN`, LT pulls the debt stablecoin from its AMM)
  (`yieldbasis-lt-family/manifest.ts:31-50`, `routes.ts:29-61`).
- The deposit route is projected only when `descriptor.depositPathVerified === true`
  (`routes.ts:53`). That flag is set only by the fourth identity round
  (`identity.ts:279-280`), i.e. the guarded-program proof.
- The deposit identity is a four-round programme (base → binding → active → deposit-program); the
  family's own test pins the round count and the fact that a raw mint is *not* the proof
  (`test/deposit-production.test.ts:9-30`, `:26` "raw mint is not executor proof").
- Deposit Exact is one `effect-delta-simulation` request whose call is
  `executionMode: "executor-program"` with no pre-calls (`deposit-exact.ts:21-37`;
  pinned by `test/deposit-production.test.ts:49-51`).
- Deposit execution is a BotVM program that derives the debt from the bound pool's *current* reserves
  inside the transaction and then asserts input/mint/inventory/native/event invariants
  (`deposit.ts:161-201`, `:117-128`).

## 2. Gaps (file:line)

### G-YB1. Identity cannot issue the guarded execution-program proof

The fourth identity round is the request built by
`depositProgramSimulation("active-deposit-program", …)`
(`identity.ts:174-177`, `deposit.ts:105-115`): an `effect-delta-simulation` whose
`call.data` is `buildSubscriptCalldata(runtimeProgramScript(depositProgram(...).bytes(), assets))`
(`deposit.ts:110`, `botvm-program-entry.ts:8-13`), i.e. the exact bytes of the family's runtime
program.

The declarative identity can only return literal request data evaluated from JSON
(`declarative-identity.ts:95-110`; the request expression is plain data) and is compiled with only
the `math` value models (`declarative-protocol.ts:202-219`). It has no access to the compiled
execution program, and the strict transport rejects any non-program calldata:

- `revm-strict-simulation-transport.ts:249-254`: for `executor-program` it requires
  `caller.kind === "executor"`, `from === to`, executor runtime code, no pre-calls and then calls
  `assertSubscriptCalldata(data)`.
- `adapter-request-program.ts:1407-1412`: the same authority constraints at declaration time.
- The identity environment has no executor/actor root (`declarative-identity.ts:24,41`; roots are
  `candidate/evidence/results/profile/constants/missing/index/error`), so an identity stage cannot even
  name the executor address that `executor-program` must target. Reproduced:
  `unknown declarative reference $executor`.

Reproduced refusals (temporary harness, deleted after the run):

- identity stage request with `executionMode: "executor-program"` and normal `deposit(...)` calldata →
  the declarative identity accepts the shape, the transport data check fails:
  `invalid executor program entry`.
- identity stage that addresses the executor → `unknown declarative reference $executor`.

Required engine change: a declarative identity request kind that names the protocol runtime's own
compiled execution program — e.g. `{"kind":"declarative-execution-simulation","direction":"deposit",
"observe":[…]}` compiled by `createDeclarativeProtocolRuntime` through the same `executionProgram()`
used by `buildRuntimeLeg`/`buildFragment` (`declarative-protocol.ts:502-507`) into
`{kind:"effect-delta-simulation", call:{caller:{kind:"executor"}, executionMode:"executor-program",
to:<executor>, data: buildSubscriptCalldata(program bytes)}, overrideIntent:{caller:{kind:"executor"}},
observe:[…]}` — plus binding the executor address into identity stage environments.

### G-YB2. Deposit Exact cannot quote the program it will execute

`depositExactProgram` is one `effect-delta-simulation` request built by
`depositProgramSimulation("deposit-receipt", …)` (`deposit-exact.ts:21-37`) and decoded by
`decodeDepositProgramReceipt` (`deposit.ts:117-128`), which requires `result.data === "0x"`
(`deposit.ts:123`) and the executor's LT share-delta row for the mint (`deposit.ts:124-127`).

A declarative `quoteFlow` can only enumerate JSON request data
(`declarative-protocol.ts:439-458`, `declarative-read-flow.ts:103-110`). An impersonated-call-frame
substitute is a *different* call path (direct `deposit`, no `execSubscript`, no program guards) and
would be exactly what the family rejects (`deposit.ts:73-77` "Raw policy diagnostic ONLY, not proof
that the executor's guarded program can execute"; `test/deposit-production.test.ts:49-51`). The
effect-simulation quote proof also only re-checks the executor's route-token deltas
(`declarative-quote-proof.ts:106-117`), not the program receipt.

Required engine change: allow a `quoteFlow` step (and its `chainQuote` proof) to reference the compiled
execution program as the effect simulation, with a program-receipt decode (`data === "0x"` + token
delta + optional `event` assertion).

### G-YB3. Deposit execution needs on-chain reserve-derived debt (executionMath)

`depositProgram` computes `debt = assets * balances(0) / balances(1)` *inside* the VM
(`deposit.ts:169-174`) and then checks the mint against the observed LT delta and the stable/native
inventory (`deposit.ts:175-199`). Declarative v2 execution supports math steps, but only through a
registered **runtime math** model:

- `declarative-execution.ts:251-267`, and failing at `:255` with
  `runtime math module is undefined` when no `executionMath` block is bound (reproduced).
- The runtime math registry is empty (`declarative-runtime-math-models.ts:5`) and is a different
  registry from the sanctioned `declarative-math-models.ts:8-11`.
- The task authorises at most one math-model file plus one entry in `declarative-math-models.ts`;
  a `math`-module model cannot back an execution step (`declarative-protocol.ts:502-507` binds
  `executionMath` only), and a model that emitted request/program bytes would put ABI, authorisation
  and call ordering into a math function, which the design forbids
  (`docs/research/design/protocol-json-module-evolution-20261028.md:39`).

Required engine change: let execution `math` steps bind the arithmetic-only `math` registry models with
declared inputs/outputs (mul/div), or sanction a runtime-math registry entry. Independent of G-YB1/G-YB2,
this blocks the deposit *execution* program.

### G-YB4. Minor execution-side differences (recorded, not independently blocking)

- Declarative execution emits balance/supply/native captures only (`declarative-execution.ts:40-47`,
  `:388-394`); there is no log/event assertion in a runtime program. TS checks the `Deposit` event only
  in the *simulation receipt* (`deposit.ts:144-150`), so an effect-simulation receipt decode with the
  `event` value op would cover it — not a blocker by itself.
- `approval.verifyAllowance` checks `allowance == amount` before the call
  (`declarative-execution.ts:216-218`); TS checks `allowance == 0` after the exact-clear cleanup
  (`deposit.ts:195-196`). Fail-closed difference, not a blocker.

## 3. What would unblock (minimal engine change)

1. Declarative identity stage request kind for the protocol's own compiled execution program
   (`declarative-execution-simulation`), with the executor actor available to identity stage/request
   values (closes G-YB1).
2. The same request kind usable as a `quoteFlow` step with `sourceKind: "effect-simulation"`, plus a
   program-receipt decode contract (`data === "0x"`, executor token delta, optional event) (closes G-YB2).
3. Execution `math` steps able to bind arithmetic-only models registered in
   `declarative-math-models.ts` (inputs → outputs), so reserve-derived debt is expressible without a
   second registry (closes G-YB3).

Until then the family stays on its TS implementation. No TS extension was added: a math model alone
cannot close 1 or 2, and adding only 3 would still leave the deposit proof and quote unexpressible.

## 4. Draft scope and validated results (withdraw branch)

`yieldbasis-lt.draft.json`:

- discovery: all four call patterns (2-arg/3-arg withdraw, 3-arg/4-arg deposit), both events, the
  LevAMM surface, `tx-evidence` nomination.
- identity: `base → binding → active → verified`; LT getters, LevAMM/pool mutual reference, live
  withdrawal preview; `decide` reproduces TS reason codes
  (`foreign-yieldbasis-lt-candidate`, `yieldbasis_lt_binding_surfaces_failed`,
  `yieldbasis_lt_amm_lt_contract_mismatch`, `yieldbasis_lt_cryptopool_coin_binding_failed`,
  `yieldbasis_lt_asset_decimals_invalid`, `yieldbasis_lt_killed`,
  `yieldbasis_lt_redemption_path_inactive`).
- Only the withdraw direction is declared (`routes.directions: [withdraw]`, `depositPathVerified:false`,
  `depositPath:null`). The deposit action adapter remains declared (the manifest owns both actions) but
  no deposit route is projected.
- pricing static/current (`preview_withdraw`), exact withdraw quote with capacity/remainder/killed
  checks and a `preview_withdraw` chain-quote proof, execution v2 withdraw (2-arg, or 3-arg with
  `$recipient` for a direct-output settlement), both action adapters.
- `modules`: `quoteFlow` + `pricingFlow` compiled; `math`/`executionMath`/`trialState` undefined.

In-memory verification performed (temporary harness in `listener/src/searcher/test/`, deleted afterwards;
no generator run, nothing written under `venues/`):

- `renderDeclarativeProductionEntry` at the hypothetical canonical path
  `listener/src/searcher/venues/protocols/yieldbasis-lt-family/yieldbasis-lt.json` — `protocol-json-v2`,
  family `protocol:yieldbasis-lt`.
- `createDeclarativeProtocolRuntime` + `defineProtocolFamily`; discovery candidate decode for
  call/log/address-surface observations; `candidateKey` = lower LT.
- Identity over the same fixture as the TS family: JSON `identity` object **deep-equals** the TS
  `identity` object (facts, provenance `evidenceHash`, `behaviorProofHash`), and the compiled
  `descriptor` **deep-equals** the TS descriptor.
- Route + graph projection deep-equal TS; route key
  `protocol:yieldbasis-lt\u001f<lt>\u001fwithdraw`.
- Pricing static evidence (`oneShare`/`oneAsset`), current snapshot and mid equal TS; dependency set and
  both compatibility projections deep-equal TS.
- Exact withdraw: request ids
  `quote-preview-withdraw,quote-is-killed,quote-staker,quote-live-supply,quote-liquidity,quote-pool-asset-balance`;
  amount out equals TS; evidence differs only by the three flow intermediates the engine cannot carry
  (`liveSupplyTokens`, `liquidityTotal`, `poolAssetBalance` — gap G4 in
  `protocol-json-gap-register-20261028.md:23-25`).
- Execution: quoted fragment program + action encode + runtime leg + direct-output settlement leg +
  `expectedEffects` equal TS; stale exact evidence / wrong state key / oversize shares throw.
- `npx tsc -p listener/tsconfig.live.json --noEmit` → exit 0 (no TS changed).

## 5. Recorded deviations of the withdraw branch (if it were migrated)

1. Exact evidence cannot carry `liveSupplyTokens` / `liquidityTotal` / `poolAssetBalance`
   (engine gap G4). The quote denies on those checks but cannot re-publish them as evidence.
2. The quoted fragment is an `execSubscript` re-entrant program (`params.runtimeAmountProgram`), not the
   TS direct `withdraw(shares,minAssets)` calldata; both call the same protocol function. Framework-wide
   v2 behavior (also used by compound/eigenpie).
3. Runtime legs fix `minAmountOut = 1` (`declarative-execution.ts:458`), where TS encodes `min_assets=0`
   for the default runtime withdraw (`execution.ts:77-88`). Fail-closed (the central flow still requires
   a positive observed credit delta).
4. Discovery nomination for retained candidates without a tx hash (TS `nomination.ts:122-165`) has no
   declarative hook; only the generic `tx-evidence` nomination exists (same deviation recorded for
   compound/eigenpie).
5. Action trace matching stays the TS set (2-arg `withdraw`, 3-arg `deposit`). The declared
   settlement execution can emit the 3-arg `withdraw(uint256,uint256,address)`, which the TS action also
   encodes but does not trace-match; parity retained, not widened.
6. `depositProbe*` facts are fixed at `0`/`false`/`null` because the draft never reaches the deposit
   branch; this is exactly what TS emits when `depositAssets == 0`, and it is why the draft is
   *not* a faithful replacement for live instances (they all have a positive deposit probe).

## 6. Verdict

Skip per migration policy (no public TS changes, no narrowing). The withdraw direction is ready as JSON
and the draft can be promoted the moment G-YB1/G-YB2/G-YB3 close; until then
`protocol:yieldbasis-lt` stays on its typed TS family.
