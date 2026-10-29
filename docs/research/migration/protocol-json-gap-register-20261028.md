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
