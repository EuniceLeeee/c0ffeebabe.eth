# `ella-exchange` — declarative Swap JSON migration (2026-10-30)

Status: **migrated to JSON locally**; handwritten production entry left in place (the task
deliberately does not run the production generator or commit a generated entry). Tree after
validation contains only `ella-exchange.json`, `math.ts` and the append-only math-registry
registration; the temporary generated entry was restored byte-for-byte from `HEAD`.

Family: `ella-exchange` (`listener/src/searcher/venues/swaps/ella-exchange-family`), lineage
`ella-exchange:native-base-v1`, activation `SEARCHER_FAMILY_ELLA_EXCHANGE_ENABLED` (enabled).
Scope/lineage/activation match `ella-exchange.production.ts` / `manifest.ts` exactly.

Files:

- `listener/src/searcher/venues/swaps/ella-exchange-family/ella-exchange.json` —
  protocol-json-v2 Swap definition (generator stem `ella-exchange` matches the handwritten
  entry name, so no `*-family` redirection was needed).
- `listener/src/searcher/venues/swaps/ella-exchange-family/math.ts` — pure
  `ella:source-quote` model (SafeDecimalMath checked multiply, fee/system-cut, inventory and
  fee-counter unavailability).
- `listener/src/searcher/venues/declarative-math-models.ts` — append-only registration of
  `ellaMathModels` (2 added lines).

No public framework TS/test, generated artifact, production entry or generator run was changed.

## Mapping

- **Discovery** (declarative v2 mapped): `swapBase1()` / `swap1(uint256)` call patterns with
  canonical-calldata decoding, the canonical `Bought(price,grossOut,amountIn,exchange,isBuy,
  timestamp)` log with predicates `exchange == emitter`, `price > 0`, `amountIn > 0`, the
  `ella-exchange-native-base-v1` address surface, candidate key/instance key = pool, labels
  `["ella-exchange"]`, `nomination: "address-surface"`, `txSeedNominations: true`.
- **Identity** (3 rounds: 5 → 5 → 1 requests): storage layout (token slot 1, packed
  `factory|native` slot 2, secretary slot 10, oracle slot 15), pool runtime code hash,
  factory/token/oracle code hashes (+ aggregator code), token decimals, oracle aggregator,
  packed native flag, secretary/factory and zero-address rejections, unchanged-source and
  mixed-source rejection, `memoReuse: "recheck-identity"`, identity key `lower(subject)`.
  Facts/provenance shape equals the handwritten `EllaBinding`, including
  `evidenceHash = hashCanonical({binding, source})`.
- **Instance/routes**: pool instance with pinned-block source state; `buy-token`
  (WETH→token, native input) and `sell-token` (token→WETH, native output) with the legacy
  `routeKey` format `familyId:lower(pool):direction` (explicit `routes.key`), binding key
  lower(pool), fingerprint `hashCanonical(staticBinding)`, execution assets and
  `{kind:"address-pool"}` graph venue.
- **Pricing**: one amount-independent `pricingFlow` state round (tokenPrice, getFees,
  getSystemCut, getFeesAddress, token/native balances, slots 11/12/15, oracle aggregator)
  with the legacy oracle/aggregator revalidation, price/fee/systemCut bounds and mixed-source
  rejection; `pricingProjection` reproduces the handwritten capacity-aware raw mid
  (`capacity/100`, `mid = quoteOut/amountIn`, `reserveA = capacity`, `reserveB = outBalance`,
  `depth = min`, `feeBps = 0`) and `classifyUnavailable` preserves the legacy "skip this
  route" behaviour for zero-capacity/zero-output samples.
- **Exact**: local-math `quoteFlow` over the same state reads; method `ella-source-math`;
  `amountOut` from the quote model; `unavailableReason` propagated for zero results
  (`gross-output-exceeds-inventory`, `fee-counter-overflow`, `zero-output`); zero-input
  `zeroEvidence`; trial-state declared unsupported with the legacy reason
  `ella-token-oracle-dependency-models-unproven`; no `stateOnlyReads` and no
  `chainAmountQuote` claim; executor/fee-recipient alias rejection in `outputChecks`.
- **Execution**: v2 directional steps (`buy` = payable `swapBase1()`, `sell` = `approve`
  ensure + `swap1(amount)`), runtime amount in `r0`, native/erc20 debit-credit effects with
  exact input debit, protected pool, `settlement.directOutput`.
- **Swap**: canonical `Bought` event, `detect-only` victim support, no intake targets,
  pool materialization decoded from the canonical event, and the legacy unresolved receipt
  result (`reason: "ella Bought needs call context to distinguish token variant and net
  output"`, produced by a declared impact that fails closed).

## Validation (all executed locally, no VM/RPC/live)

- `compileDeclarativeSwap` + `defineSwapFamily` import/registration: PASS.
- End-to-end drive (public fixture, `ella-exchange-family/test/public-sample.json`):
  discovery log/call/surface positives and negatives, 3-round identity verification and all
  handwritten negative branches, routes/graph, pricing draft→finalize→snapshot→mids,
  exact both directions incl. capacity/zero reasons, execution fragment and runtime leg both
  directions, forged route/actor/minimum rejections, swap classify/observation/receipt/
  pool-materialization: PASS.
- Numeric parity against the handwritten TS (`decodeState`, `quoteAmount`): snapshot deep
  equality, mids (`mid/reserveA/reserveB/depth/feeBps`) equality, exact output equality for
  both directions across `1`, `1e12`, sample amount and capacity-boundary amounts, refreshed
  price parity: PASS.
- Family tests with a temporarily rendered generated entry (then restored):
  - `test/refresh.ts`: PASS (synthetic production lifecycle/session/coordinator/effective/Exact).
  - `test/memo-reuse.ts`: PASS (memo reuse/recheck fences, zero RPC on same cutoff).
  - `test/historical-evidence.test.ts`: 4/4 PASS.
  - `test/trial-state.ts`: 4/4 PASS (legacy TS kernel, unchanged).
  - `test/contract.ts`: **8/13 PASS**, 5 fail on legacy artifact/error shapes (below).
- `npx tsc -p tsconfig.live.json --noEmit` with the generated entry: PASS.
- `npm run build:live` (same `tsc -p tsconfig.live.json --noEmit`) with the handwritten entry
  restored: PASS.

## Accepted fail-closed / legacy-shape deviations

1. **Nomination channel / reverse binding.** The handwritten discovery uses
   `createTxEvidenceNomination` with a receipt-block-bounded provider wrapper and an
   `implementation` reverse binding that code-hashes retained addresses
   (`discovery.ts:49-55`, `nomination.ts:9-23`). Declarative discovery has no reverse-binding
   hook and tx-evidence nomination cannot reproduce the custom receipt bound
   (`declarative-discovery.ts:302-308`). The JSON uses address-surface nomination with the
   declared interface fingerprint, plus the legacy tx-seed switch. Admission is unchanged:
   identity still re-verifies runtime/factory/token/oracle at the canonical source, so the
   change only moves where a retained address is code-checked (identity instead of
   nomination), and cannot admit an unverified instance.
2. **Swap receipt impact corner case.** The legacy receipt observer returns `unresolved` for
   any matched `Bought` trigger. The declarative event decodes canonically, binds the
   direction from `isBuy`, and its impact program fails closed with the same reason, so a
   trigger on an admitted pool is `unresolved` with the legacy reason. If the emitter is not
   present in the admitted graph, the shared declarative observer reports `mutation-only`
   ("direction absent from admitted graph") instead of `unresolved`; it still publishes no
   impact (`swap-observation.ts:307-325`).
3. **`observedPoolIdentity`.** Legacy returns the emitter for any topic-matching log; the
   declarative value requires a canonical `Bought` decode (`declarative-swap-domain.ts:112`),
   so a malformed `Bought` yields `null` instead of an identity. Fail-closed; no admission.
4. **`swap.observation.decode`.** Legacy returns `[]` for log observations; the declarative
   domain publishes the canonical log data as `canonicalPayload` for the same event
   (detect-only, no impact). This does not add execution/victim replay capability.
5. **Execution artifacts.** The declarative engine compiles canonical runtime programs with
   in-program balance captures/checks and exposes them through the generated action adapter;
   the legacy contract test compares raw `encodeCall`/`encodeCallValue` bytes, the legacy
   `approve` fragment requirement and a legacy `applyQuotedAssetBoundary` child list, so
   `test/contract.ts:155,174-183,195` fail. The replacement is stricter (full debit/credit
   checks), not weaker; it cannot reproduce the old byte layout by design.
6. **Error wording / shape.** `contract.ts:82` expects `/unresolved/` but the declarative
   identity transport raises `RequiredAdapterRequestError: required adapter request
   factory-code failed: rpc`; `contract.ts:157` expects `/incompatible/` but actor/evidence
   mismatch is reported as `execution actor/evidence mismatch`; a forged route carrying an
   explicit `executionAssets: undefined` fails earlier in `hashCanonical` (still throws,
   fail-closed) so it does not match `/route/`.
7. **Pricing dependencies projection.** `pricing.dependencies` is normalized to sorted,
   lower-case addresses by the shared helper (`declarative-family.ts:551-554`), so
   `contract.ts:250` (expected checksum order) fails; the address set is identical and the
   mutation mapping still keys the instance (that assertion passes).
8. **Native output settlement.** `settlement.directOutput` is not advertised for native-output
   routes (`declarative-execution.ts:857-868`), so `buildRuntimeLeg` returns no
   `directOutput` capability for sell; the handwritten leg had no settlement capability at
   all, and the central asset boundary remains the only wrapping path (fail-closed narrowing).

## Revisit / follow-up

- Run the central generator once the migration window accepts a generated entry; the
  generator refuses to overwrite the handwritten file, so it must first be moved to the
  established `.handwritten` evidence path.
- If preserving the legacy action/runtime byte layout is required, that is a framework
  artifact-shape decision, not a JSON capability gap.
- For a real single-block/live acceptance run, execute the existing `historical-ready.ts`
  with a read-only RPC file and the current workspace `revm-sim`; not done here (no VM/RPC).
