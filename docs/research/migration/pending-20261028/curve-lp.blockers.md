# `protocol:curve-lp` — parked declarative draft and blockers (2026-10-29)

Status: **blocked / not migrated**. The legacy `curve-lp:stableswap2-18-6-v031`
lineage is drafted and behaviourally exercised, but the family contract test cannot be
run green against a declarative plugin without public framework/test changes. The other
three lineages (`registry-stableswap-ng`, `registry-fixed-array`,
`registry-underlying-zap`) are not drafted; see B3/B4 below for why a faithful draft
would require new framework capability rather than more JSON.

Files parked here:

- `curve-lp.draft.json` — one-variant (`stableswap2-18-6-v031`) protocol-json-v2 draft.
  It is a partial-family draft: `manifest.supportedLineages` intentionally contains only
  the legacy lineage, because adding child variants that reject the other lineages would
  hide a real capability loss.
- `curve-lp-math.ts.draft` — the only local math the family has (v0.3.1
  `invariant`/`mintQuote`). Not registered in the live math registry.

No production entry, family TS, public framework TS/test, or live/VM state was changed.
The temporary validation entry was restored.

## What the draft does express (verified in-memory)

- Identity: surface (`get-code`/registry/getters) → binding+state (LP minter reverse
  binding, exact pool/LP code hashes, coin code/decimals, `A_precise == future_A`,
  fee/kill bounds) → 8 actual `add_liquidity`/`remove_liquidity_one_coin` behaviour
  probes. Deltas, LP supply delta, native deltas, source and peer-result sources are
  checked with the same fail-closed rules as `identity.ts:43-62`.
- Routes: four mint/redeem routes projected from the descriptor coin list, stable
  `routeKey` `protocol:curve-lp:<pool>:<direction>:<index>`, per-instance pricing
  stateKey, one pricing round with all four quotes, per-route `classifyUnavailable`.
- Exact: fee-adjusted local mint math (`model.ts:30-41`) and the real
  `calc_withdraw_one_coin` view for redeem, with prefix/trial-state rejected
  (`exact.ts:13-15`).
- Execution: exact-clear mint approvals `0 → amount → 0`, no redeem approval, patched
  `add_liquidity` / `remove_liquidity_one_coin`, exact input debit, output bound to the
  pool return, native unchanged.
- Discovery: call candidates re-encode canonical calldata; event patterns assert the
  exact data/topic lengths of the three legacy events.

Measured with the draft and the family fixtures (temporary entry, then reverted):

- `createDeclarativeProtocolRuntime` registration OK.
- Identity: 7 → 15 → 12 requests over three rounds, `verified`.
- Exact vs the TS reference: mint = `mintQuote`, redeem = `mockWithdraw` for all four
  directions on two amounts each — equal.
- Pricing: 4 quotes and 4 mids; `mutation.affectedStateKeys` matches the family contract
  case.
- Direct runtime-leg inspection: mint approvals `[0, amount, 0]`, redeem approvals none.
- `test/contract.ts` against the declarative plugin: **18/21 pass**, 3 failures are B1.
- `test/production-exact.ts`: lifecycle publishes one instance with 4 routes and Exact
  resolves; the assertion fails only on B5 (`route.direction` labels).

## B1. Family contract cannot bind a declarative route to the TS route object

`declarative-protocol.ts:224` always adds `target` and sets
`direction: d.id`; `:100-109` require unique direction ids and forbid
`fields.direction`; `:250` then requires the full canonical route hash to equal the
incoming route. The family's route object has no `target`, has
`direction ∈ {mint,redeem}` shared by both coin indexes and a numeric `index`
(`curve-lp-family/types.ts:17`, `routes.ts:8,12-26`).

`test/contract.ts` deliberately passes TS-built descriptors/routes into the plugin:
`:58-69` (`buildFragment`), `:85-93` (`buildRuntimeLeg`), `:104-117` (amount selector).
The three failures are exactly `declarative route binding mismatch`
(`declarative-protocol.ts:250`). This is not a missing JSON field: a declarative route
can never hash-equal the TS route because of the added `target`/id fields.

Consequence: the family contract cannot be run green with a declarative entry, which is
the acceptance requirement for this migration.

## B2. Execution v2 forces a native-balance probe the family harness does not provide

`declarative-execution.ts:156-157` unconditionally appends `unchanged-native` to every
non-native v2 route; `:182,189` capture it, which emits `nativeBalance` (`:361`). The
independent runtime testkit requires the fixture (`test/runtime-program-testkit.ts:83`),
and the family's `run()` passes only `call` (`test/contract.ts:71-83`). The handwritten
legacy program has no native probe (`curve-lp-family/execution.ts:12-27`).

Evidence: calling the draft's `executionProgram` and `inspectRuntime` with a `call`-only
harness throws `native balance fixture required`. `executionAssets: {erc20,erc20}` does
not suppress it (`execution.ts:49-66` returns `null` for non-native sides). This is an
extra safety check, but it breaks the unmodified family contract.

## B3. Per-direction direct-output settlement capability is static in JSON

The family derives `directOutput` per proven direction
(`curve-lp-family/execution.ts:28-38`, `ng.ts:126-130,299`,
`generic.ts:104-107`). Declarative settlement is one variant-level boolean
(`declarative-execution.ts:113,435,442,450`). Declaring `true` over-claims unproven
directions; `false` removes withdrawal-direct settlement for every route. Neither is a
faithful transcription of the NG/generic/zap families.

## B4. TwoCrypto fee-claim withdrawal cannot be expressed in execution or quote

`generic-effects.ts:97-113` executes the raw operation with a nested runtime program
(`p.run(genericRawProgram(...)).equal(1,0)`) and then conserves pool/FeeReceiver
balances, LP supply and `ClaimAdminFee`/`Transfer` logs per account (`:129-165`).
Declarative execution has no nested-program operation, no log effects, and only
token/supply/native effect kinds (`declarative-execution.ts:172`). Declarative identity
simulations observe only executor token balances and no total supply
(`declarative-simulation.ts:71-80`), and `programReceipt` accepts only symbolic executor
observations (`:114-148`). The crypto exact/quote path itself is a simulation of that
program (`generic-effects.ts:197-212`), which the declarative quote-flow materializer
cannot build (`declarative-protocol.ts:330-345`).

Restricting the generic variant to stable pools would drop real two-coin TwoCrypto pools;
that is capability narrowing, not a fail-closed deviation, so it was not done.

## B5. `route.direction` cannot carry the protocol direction for multiple indexes

`declarative-protocol.ts:224` sets `direction` to the unique declared id (`:100-103`),
and `:108` forbids a `fields.direction` override. `test/production-exact.ts:32-38`
requires `route.direction === "mint"` and `route.index` to choose the expected
`mintQuote` path. The draft labels routes `mint-0`, `mint-1`, `redeem-0`, `redeem-1`;
lifecycle/Exact resolve correctly, but the test compares a redeem expectation against a
mint result (`999950999833440623n` vs `990000000000000000n` at `:37`).

An expression-valued `fields` object could overwrite `direction` at projection time (the
reserved-key check only sees the unevaluated `{op,args}` record), but that bypasses the
documented validator and still cannot fix B1, so it was not used.

## B6. Discovery event canonicality (minor, compensated by length predicates)

The family re-encodes event logs and rejects non-canonical data/topics
(`discovery.ts:36-43`). Mapped declarative discovery only decodes
(`declarative-discovery.ts:195-203`); the values catalogue can encode function calldata
but not event logs (`declarative-values.ts:194`). The draft asserts exact data/topic
lengths per event, which rejects trailing garbage but is weaker than a byte-for-byte
re-encode.

## B7. Mutation malformed-log conservatism (minor)

The family treats a malformed `Transfer` payload as conservatively affected
(`pricing.ts:39-52`). `pricing.mutationPredicate` is an expression without
`attempt`/`catch`, so the draft would throw on malformed address topics instead of
returning affected. Well-formed Transfer/Approval/pool cases match the contract test.

## Verification commands used (temporary entry, then restored)

```bash
node --import tsx --test src/searcher/venues/protocols/curve-lp-family/test/contract.ts
# 18/21; the 3 failures are declarative route binding mismatch (B1)

SEARCHER_FAMILY_CURVE_LP_ENABLED=1 \
  node --import tsx --test src/searcher/venues/protocols/curve-lp-family/test/production-exact.ts
# lifecycle publishes 4 routes; assertion differs only by route.direction (B5)

node --import tsx --test src/searcher/venues/protocols/curve-lp-family/test/contract.ts   # baseline, restored
# 21/21
```

`listener/node_modules/.bin/tsc -p listener/tsconfig.live.json --noEmit` was not used as
acceptance for the draft because the draft is not the live definition and the math
registry change was reverted. The baseline family suite was re-run after restore.
