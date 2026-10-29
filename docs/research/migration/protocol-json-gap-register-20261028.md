# Protocol JSON migration — framework gap register (2026-10-28)

Workspace: `work/protocol-json-20261028` @ e57ac81b. Policy: migrate by writing `<family>/<family>.json`;
skip any family whose faithful semantics requires public framework TS changes; record the exact gap.

## G1. Static discovery cannot omit candidateSources
- `declarative-discovery.ts` always projects `candidateSources`; `adapter-family-plugin.ts:3633-3638`
  rejects an empty array. Faithful JSON encoding `[]` throws at generated-entry import.
- Affected (15/23 with discovery.ts): badger, curve-lp, few-wrapped, goldx, metronome-hgusdc,
  metronome-synth, peapods, psm, psv, rocksolid, set-redemption, staked-usdat, token-conversion,
  wsteth, yearn-auction.
- Proposed fix (not applied): project only when non-empty (legacy ~:65, mapped ~:212).

## G2. Multi-step exact chain proof
- `declarative-quote-proof.ts:71-104` / `declarative-protocol.ts:484-491` attest a single request
  whose input = amountIn and output = amountOut. `protocol:erc4626-silo-redeem` needs
  previewRedeem(amountIn) → previewWithdraw(previewAssets); both hops fail the proof.

## G3. No partial availability (pricing multi-round without exact quote)
- `declarative-protocol.ts:124` throws when `pricingFlow` exists without `quoteFlow`/legacy quote.
  Forcing legacy quote returns the wrong asset (silo: previewAssets as payout).

## G4. Exact evidence cannot carry intermediate values
- Evidence env `declarative-protocol.ts:410-414` lacks fields (silo `previewAssets`), and
  `buildFragment` re-hashes evidence (`:519-530`).

## G5. Discovery nomination/carrier for family-owned probes
- No `opaque` FieldSource (`declarative-discovery.ts:19-23`); generic address-surface nomination
  drops opaque and cannot read `asset()`/probe evidence (`address-surface-nomination.ts:49-57`).
  Silo's `nominateErc4626SiloRedeem` has no JSON hook; its Withdraw log has no payout-token field.

## G6. Pricing unavailable classification
- `classifyUnavailable` (silo `silo_preview_chain_zero`) has no declarative hook; zero preview
  hard-fails in `pricingFlow.decodeSnapshot` (`declarative-protocol.ts:355-376`).

## Status
- Parked definitions: `wsteth.json`, `rocksolid.json` (G1), `erc4626-silo-redeem.draft.json` (G2-G6).
- Families with candidateSources and no known gap: ethertoken-native-redeem (in progress),
  compound-ctoken, eigenpie, self-burn-native, token-migration (Map limitation), astra, yieldbasis.
- Awaiting: gcloud re-auth for cloud 208/208 + Ready/acceptance; user decision on public TS fixes.

## G7. Dynamic route fan-out over registry tokens (astra-multitoken)
- TS projects all directed pairs from the behavior-proven token registry (`astra-multitoken-family/routes.ts:11-47`;
  test asserts 6 routes for 3 tokens). Declarative requires a static `routes.directions` array with literal unique
  ids and derives routeKey from the static id (`declarative-protocol.ts:97-100,230-231`); there is no
  expression/program hook to fan out over `$descriptor.registryBinding.tokens`.
- Pricing is per-instance (`declarative-protocol.ts:294`, snapshot must cover every route at `:356-361`) while TS is
  per-route; a 992-entry enumeration workaround loses TS routeKey/pairIndex identity and needs 4 dependent rounds.
- Verdict: astra-multitoken blocked; validated draft parked under `pending-20261028/`.

- Additional astra details: declarative pins `stateKey = route.instanceKey` and requires one snapshot covering
  ALL routes (`declarative-protocol.ts:294,298,356-361`); TS is per-route (`pricing.ts:37,46-64`) and only publishes
  successful groups (`adapter-family-runtime.ts:3540-3556`). One zero/illiquid pair would delete every route of the
  instance. Route `pairIndex` identity (`binding.ts:56-68`) is also not expressible.
- Decision: do not accept a 992-entry index-keyed workaround (loses token-address routeKey/pairIndex identity and
  narrows pricing isolation). astra stays blocked pending engine support.

## G8. Map-bearing trial state (token-migration / xWin)
- The design doc (section 8) states the trial-state boundary only accepts plain objects/arrays and rejects
  Map-bearing state; xWin's state model is the documented example. token-migration therefore stays blocked
  until the engine can represent that state without loss.

## G9. yieldbasis-lt: executor-program identity/quote + execution math
- Deposit direction needs identity/quote rounds that compile an effect-delta-simulation of the family's own
  execution program (`yieldbasis-lt-family/deposit.ts:105-115`, `deposit-exact.ts:21-37`; strict transport requires
  from===to + executor caller + assertSubscriptCalldata: `revm-strict-simulation-transport.ts:249-254`,
  `adapter-request-program.ts:1407-1412`). Declarative identity only emits JSON data and does not bind `$executor`
  (`declarative-identity.ts:24,41,95-110`).
- Deposit execution needs an executionMath binding for reserve-derived debt (`deposit.ts:169-174`); the runtime
  registry is empty (`declarative-runtime-math-models.ts:5`) and protocol math models cannot back execution steps
  (`declarative-protocol.ts:502-507`).
- Verdict: withdraw-only draft parked (would narrow behavior); blocked until the three hooks exist.

## G1 affected list (complete)
23 protocol families lack dynamic `candidateSources`: badger, curve-lp, few-wrapped, goldx, metronome-hgusdc,
metronome-synth, peapods, psm, psv, rocksolid, set-redemption, staked-usdat, token-conversion, wsteth,
yearn-auction, arcana-migration, boring-vault-teller, default-collateral, metafactory, olympus,
ondo-usdy-instant-redeem, origin-ousd, origin-steth-arm.

## G10. compound-ctoken declarative plugin fails the family contract test
- After migration, `compound-ctoken-family/test/contract.ts` fails 4 assertions against the generated JSON plugin
  (pristine TS baseline passes 0 failures):
  - Exact rejects an unmodeled prefix even when a trial object is supplied (prefix semantics cannot be declared);
  - identity does not verify revert (declarative identity revert handling differs);
  - identity binds source across registry and simulation and accrues in registry round (multi-round binding difference);
  - exact quote honours the caller's specified share amount (declarative exact path differs).
- Action: compound JSON parked as a draft (`pending-20261028/compound-ctoken.draft.json`); handwritten TS production
  entry restored; contract test green again. Compound stays blocked until these parity gaps are resolved.

## G11. badger-sett-withdraw: route address canonicalization + runtime byte layout
- Declarative route projector canonicalizes token addresses via `ethers.getAddress` (EIP-55) while the TS
  family/tests use lowercase; 5 family-contract assertions fail (strict-equality call nomination + tests mixing
  declarative routes with handwritten `assertRoute`). Addresses/semantics identical.
- Shared declarative execution compiler emits a different (behaviorally equivalent) instruction layout than the
  handwritten program; byte-equality assertion fails.
- Sequential trial state remains unsupported (declared `localStateUnsupportedReason`; prefix quoting fails closed).
- Action encoder cannot restate tokenIn==target / distinct-address checks.
- Action taken: JSON + math parked (`pending-20261028/badger-sett-withdraw*`), handwritten TS entry restored;
  baseline family contract green.

## G12. metronome-synth: protocol.oracleVictim unsupported by v2 compiler
- `build-declarative-production.ts:141` rejects `protocol.oracleVictim`; runtime requires a synchronous
  `oracleVictim.decode` (`adapter-family-plugin.ts:2461-2466,:4698-4751`) that JSON cannot supply
  (`metronome-synth-family/victim.ts:43-69`). The victim is a hashed capability root, so omitting it removes a
  real capability.
- Action: draft + blockers parked; family stays blocked.

## peapods-debond deviations (migrated)
- Declarative execution measures executor input debit (stronger than TS).
- Testkit calls inspectRuntime without a balance fixture; harness incompatibility, not weaker behavior.
- Non-compiled `pricing.mutation.affectedStateKeys` callback needs `input.routes` (declarative-protocol.ts:519);
  production uses the compiled index (test passes).
- behaviorProofHash uses canonical sha256 over binding/source/behavior (same audit role, not cross-comparable).

## G13. ondo-usdy-instant-redeem: raw selector/calldata helper call
- TS execution runtime leg is a single call to an unverified helper with a manually assembled selector
  0xccee0802 + 9 words (`ondo-usdy-family/execution.ts:18-21`, `helper.ts:3-10`). Declarative calls are
  signature-only (`declarative-execution.ts:99,135,330-363`; `declarative-call-codec.ts:34-60`), so the raw
  selector is not expressible; substituting the manager's redeem (0xd8780161) changes executed bytes.
- Secondary gaps documented in the parked blockers (candidate key encoding, chainAmountQuote vs local-math,
  local-zero, source-scope strictness, zero-output pricing validator, oracle-log mutation coverage).
- Action: draft + blockers parked; family blocked.

## olympus / metafactory notes
- Migrated with math models; family contract 8/8 (olympus) and PASS (metafactory); deviations are fail-closed
  (retained readProof, shared runtime program, pricing routes field, trialState unsupported where applicable).

## G14. mellow-queue: uint224 runtime leaf + bytes32[] deposit args
- deposit is `deposit(uint224 assets,address referral,bytes32[] merkleProof)`; TS patches word 4
  (`mellow-queue-family/abi.ts:11`, `execution.ts:23-25`). Declarative execution rejects uint224 runtime leaves
  (`declarative-call-codec.ts:27-29,43-46`: only uint256/bytes32) and v1 requires scalar args + dynamic bytes32[]
  (`declarative-execution.ts:343-346`). Both fragment and runtime leg throw for deposit; redeem works.
- Action: draft + blockers parked; needs codec widening (bounded fixed-width uintN) or v1 scalar+dynamic support.

## G15. token-conversion: EVM opcode walk for asset dependency closure
- BTB dependency closure walks bytecode opcodes (`variants.ts:32-49`, fallback template `asset-runtime.ts:20-47`).
  JSON value ops have no bytecode indexing/looping/opcode classes (`declarative-values.ts:22`; maskHash only fixed
  offsets `:218`). Template-only JSON would reject local-only ERC20 assets TS accepts (narrowing).
- xWin pricing/exact also needs large Map/V3 trial state. Action: blocked, blockers parked.

## G16. yearn-auction: one-observation nomination limits
- TS discovery enumerates `getAllEnabledAuctions()` and emits one address-surface observation per enabled sold token
  (`discovery.ts:9-21`; contract test requires both at `test/contract.ts:41-43`). Declarative nomination read flow
  returns one opaque object or null (`declarative-nomination.ts:62-66`); surface nomination emits one observation per
  address (`address-surface-nomination.ts:44-58`). Deferred callback risk noted (`declarative-callback.ts:150`).
- Action: blocked, blockers parked.

## G17. curve-lp: route identity, forced native probe, per-direction settlement, crypto fee claims
- Legacy stableswap2 is drafted and exercised: contract 18/21 against the temporary declarative entry; the 3
  failures are `declarative route binding mismatch` because the declarative route always adds `target` and uses a
  unique direction id (`declarative-protocol.ts:224,100-109,250`) while the family contract feeds TS routes with
  `direction ∈ {mint,redeem}` + numeric `index` (`curve-lp-family/types.ts:17`, `routes.ts:8,12-26`;
  `test/contract.ts:58-69,85-93,104-117`).
- Execution v2 unconditionally appends `unchanged-native` (`declarative-execution.ts:156-157,182,189,361`), which
  the family contract's `run()` does not fixture (`test/runtime-program-testkit.ts:83`, `test/contract.ts:71-83`);
  evidence: call-only `inspectRuntime` throws `native balance fixture required`.
- Per-direction direct-output settlement (`curve-lp-family/execution.ts:28-38`, `ng.ts:126-130,299`) is a static
  variant boolean in JSON (`declarative-execution.ts:113,435,442,450`): cannot claim proven-only.
- TwoCrypto withdrawal (`generic-effects.ts:97-113,129-165,197-212`) needs a nested runtime program, log effects and
  fee-receiver/pool/total-supply per-account conservation; declarative execution/simulation have no such ops
  (`declarative-execution.ts:172`; `declarative-simulation.ts:71-80,114-148`).
- Also `production-exact.ts:32-38` needs `route.direction === "mint"`; draft ids cannot carry it (same `:224`).
- Action: draft + math + blockers parked (`pending-20261028/curve-lp.*`); family stays blocked.

## G17. default-collateral: txSeedNominations with address-surface nomination
- TS declares both tx-seeded and address-surface nomination (`default-collateral-family/discovery.ts:43`); mapped v2
  discovery sets `txSeedNominations` only for `nomination: "tx-evidence"` (`declarative-discovery.ts:266-272`), so the
  recent-call seed scan (`recent-call-seed-scan.ts:72`) is disabled for this family. Observed-call, landed-log and
  address-surface channels remain; admission/behavior proof unchanged.
- Decision: accepted as documented discovery-scope narrowing (no public TS change); revisit if framework adds a
  combined nomination mode.

## Test-fixture incompatibilities (accepted, harness-only)
- peapods-debond and boring-vault-teller family tests call `inspectRuntime` with zero-data balance fixtures while the
  declarative execution program measures real input/output deltas (stronger check). Same class as the recorded
  testkit limitation; re-proven with stateful fixtures in the agents' harnesses.

## G18. curve-lp: route identity, native fixture, per-direction settlement, log ops
- B1 route identity: declarative routes always add `target` and use a unique direction id (`declarative-protocol.ts:224,100-109,250`),
  so the JSON route can never hash-equal the TS route fed to execution/pricing by `test/contract.ts:58-69,85-93,104-117`.
- B2 execution v2 unconditionally adds `unchanged-native` (`declarative-execution.ts:156-157,182,189,361`); the family's
  `run()` has no native fixture, so `runtime-program-testkit.ts:83` fails.
- B3 per-direction `directOutput` is static in JSON (`execution.ts:28-38`, `ng.ts:126-130,299` vs `declarative-execution.ts:113,435,442,450`).
- B4 TwoCrypto fee-claim needs nested runtime program + ClaimAdminFee/Transfer log/per-account conservation
  (`generic-effects.ts:97-113,129-165,197-212`); declarative execution/simulation have no such ops.
- B5 route.direction labels mint/redeem per index not expressible; B6 event canonical re-encode impossible;
  B7 malformed Transfer topic handling.
- Evidence: contract 18/21 with declarative entry (baseline 21/21); production-exact publishes 1 instance/4 routes but
  direction labels differ. Action: draft+math+blockers parked; family blocked.

## G19. psv: quote-output settlement, byte equality, route identity
- Declarative settlement exposes only directOutput/deferredInput (`declarative-execution.ts:448-452`); the family needs
  `RuntimeSettlementCapabilities.quoteOutput` (`runtime-amount-program.ts:243`, `psv-family/execution.ts:48-50`,
  `runtime-quote.ts`), asserted by `test/psv-direct-recipient.ts:155` + `RuntimeRecipient.t.sol:95-99`.
- Declarative execution always emits in-program balance captures (`declarative-execution.ts:178-202,300-301`), so the
  default 4-call leg bytes differ from the legacy program (`psv-direct-recipient.ts:157-161` asserts byte equality).
- Declarative routes always add `target`/`adapterId` (`declarative-protocol.ts:220-232`); the family contract feeds
  TS-built routes (`psv-family/test/fixtures.ts:67-71`, `test/contract.ts:58-85`) into exact/execution, so
  `assertInvocation` (`:246-253`) rejects them.
- Action: draft + blockers parked; family blocked.
- Additional PSV details: direct-output needs a per-settlement/nested read-only quote program + runtime math
  (`declarative-execution.ts:40-47,112-113,268-272,454-461`); v2 appends `unchanged-native` (`:153-157`);
  `pricing.static.refreshPolicy` marker absent (`declarative-protocol.ts:393-398`; contract `contract.ts:128`);
  draft contract 17/20 (route shape x2 + refreshPolicy), lifecycle 0/5 (quoteOutput), baseline 19/20 (pre-existing stub).
