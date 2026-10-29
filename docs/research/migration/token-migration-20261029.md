# protocol:token-migration → declarative JSON (2026-10-29)

Definition: `listener/src/searcher/venues/protocols/token-migration-family/token-migration.json`
(protocol-json-v2, version 2, lineage `token-migration:mantle-solc-0.8.13-v1`). No protocol or
execution math model was added; `declarative-math-models.ts` and
`declarative-runtime-math-models.ts` are untouched.

Naming note: the source-of-truth family at this path is the **Mantle BIT migrator**
(`migrateBIT` / `migrateAllBIT`, `TokensMigrated`). xWin lives in a different family
(`protocol:token-conversion`, lineage `token-conversion:xwin-allocations-v1`) and remains blocked by
G15 (BTB opcode-walk dependency closure); it was not moved or narrowed here. This family has no
sequential/trial state and no V3/Map state; `trialState` is therefore deliberately **undefined**, not
invented.

## Section → TS mapping

| JSON | TS source |
|---|---|
| `manifest` | `token-migration-family/manifest.ts:3-10`: family `protocol:token-migration`, one owned action `token-migration`, lineage `token-migration:mantle-solc-0.8.13-v1`, protocol/convert taxonomy, pool+edge adapter `token-migration` |
| `discovery.definition` | `discovery.ts:6-10,12-39`: call patterns `migrateBIT`/`migrateAllBIT` (call-target candidate), landed log `TokensMigrated` topic, canonical re-encode + amount>0 predicates (`:26-30`), topics/data shape checks (`:21`), tx-evidence nomination labels (`:37`) |
| `identity.definition` `runtime` stage | `identity.ts:10,14-16,23-30`: get-code target + four immutable getters; `codeHash = keccak(code)`; `valid = tokenIn != tokenOut && numerator > 0 && denominator > 0 && verifyRuntime(code, binding)` |
| `identity.definition` `tokens` stage | `identity.ts:17-20,32-39`: get-code of both tokens, `decimals() ≤ 77`, `oneToken = 10^inDecimals`, token code non-empty, prior source re-asserted |
| `identity.definition.decide` | `identity.ts:41-55`: continue → `chain-proven-rejected` (`unsupported-migration-runtime-or-token`, request-id set by phase) → continue → verified `{familyId, lineageId, subject, provenance, tokenIn, tokenOut, numerator, denominator, oneToken, codeHash}`; provenance hash over the whole evidence incl. source |
| `identity.key` | `identity.ts:55`: lower-case subject |
| `instance` | `instance.ts:6-15` + `binding.ts:5-8`: identity-derived instance key, pinned-block source requirement, descriptor fields, binding projection `{target,tokenIn,tokenOut,numerator,denominator,codeHash,semantics:"mantle-migrate-exact-amount-v1"}` |
| `routes` | `routes.ts:7-20`: one `migrate` direction, routeKey `familyId ␟ lower(target) ␟ migrate` (default key), bindingKey lower(target), graph venue `address-protocol`, two `token-delta` expected effects |
| `pricing.draft/finalize` | `pricing.ts:11-19`: one direction per instance key, descriptor + route (+ `routes` for declarative pricing flow) |
| `pricing.static` | No TS static phase; declarative requires a static-evidence block, so it is an empty dependency-only phase (`requests: []`, `{}` output). It adds no check and is not treated as acceptance |
| `pricing.compatibility` / `exactCompatibility` | `binding.ts:5-8`; `exact.ts:30`: binding projection plus route fingerprint and lower-case executor |
| `pricing.sampleAmount` | `pricing.ts:9`: `min(oneToken, MAX / numerator)` |
| `pricing.classifyUnavailable` | `pricing.ts:10,29-32`: `migration-halted`, `migration-zero-output` (when `amountOut == 0`), `migration-insufficient-inventory` |
| `modules.pricingFlow` | `pricing.ts:20-36` + `state.ts:7-21`: `halted`, `balanceOf(tokenOut, target)`, `tokenMigrationAmountToReceive(sample)`; boolean bound, source binding, chain formula equality; snapshot carries `{source, halted, inventory, quotes}` |
| `modules.quoteFlow` (view) | `exact.ts:6-26` + `state.ts:7-21`: same three reads for the caller's exact amount, halted/zero/inventory/formula checks, `chainQuote` proof on `tokenMigrationAmountToReceive` input/output words |
| `standard.exact` | `exact.ts:6-31`: positive amount, uint256/`amount*numerator` bounds, evidence `{kind:"mantle-migration-amount-quote", source, executor, bindingFingerprint, amountIn, amountOut}`; `local-zero` rejects zero input through the same `exact.checks` |
| `standard.execution` | `execution.ts:9-16,19-34`: exact-clear approval, `migrateBIT(amount)` with runtime amount patching, debit/credit effects bound to executor and route assets |
| `actionAdapters` | `action.ts:5-24`: descriptor `{adapterId:"token-migration", lineage:"custom-protocol:token-migration", edgeKind:"protocol", action:"convert", canSendValue:false, leavesStandingPositionDefault:false}`, trace selector `migrateBIT` only |
| `protocol` | `protocol.ts:2`: `candidateKinds:["observed-call"]`, `activeBehaviorProof:"required"` |

Modules used: `quoteFlow` (`view` + `chainQuote`), `pricingFlow`. Omitted/undefined: `math`,
`executionMath`, `trialState` (the TS family has no local formula or trial state).

## Validation performed (read-only)

Evidence corpus: mainnet read-only RPC at block 26029585 for
`0x576dcfa0…c583` was used to rebuild the cached coffee corpus locally in `/tmp` (runtime code 3277
bytes, creation tx `0x648cd0ff…faa6`, receipt, callTracer trace, verified-bytecode HTML excerpt). The
VM, production generator, framework TS/tests and the handwritten production entry were not touched.
The pristine handwritten entry + corpus still run **12/12** family contract tests.

- `renderDeclarativeProductionEntry` renders the v2 entry (no children, one owned action);
  `createDeclarativeProtocolRuntime` + `defineProtocolFamily` import succeed. Module coverage is
  `quoteFlow: compiled`, `pricingFlow: compiled`, `math/executionMath/trialState: undefined`.
- Differential harness against the TS plugin (real runtime patched across bindings): **37/37** checks
  pass. It covers discovery call/log decode + candidate key + nomination channel; both identity
  stages' requests/evidence/decisions (valid, generalized token/rate bindings, unknown/mutated
  runtime, empty token code, decimals>77, getter/runtime mismatch, foreign source, unresolved request);
  instance/key/projection; routes/graph; pricing draft/static/finalize/current/decode/classify/mids,
  halt/zero/short-inventory dynamics, mixed-source rejection, dependencies and log/call mutation;
  exact method surface, request parity, quotes/evidence, halted/zero/inventory/formula/source/boolean
  failures, zero/negative/MAX bounds; execution expected effects, fragment evidence tampering, runtime
  approve(0)→approve(amount)→`migrateBIT(amount)`→approve(0) program, and quoted `minAmountOut` floor;
  action trace + program encoding.
- `src/searcher/venues/protocols/token-migration-family/test/contract.ts` run with a temporary rendered
  entry: **4/12 pass, 8/12 fail; every failure is a handwritten-harness/API or message-surface
  mismatch, not a behavior mismatch**:
  - 6 tests stop at `plugin.exact.methods(input)[0]` because declarative exact exposes the framework
    `local-zero` method first (`contract.ts:98`); selecting `.find(kind === "request-program")` runs the
    same request/decode paths (covered by the differential harness). Zero input still fails closed:
    `exact.checks` throw `migration requires positive input` from both the local-zero and request-program
    decoders.
  - 1 test passes `staticEvidence: undefined` to `finalizePricingDescriptor` (`contract.ts:208`); the
    declarative finalizer requires the declared static evidence (this JSON's phase is empty). Injecting
    the empty static evidence makes finalization and all assertions pass.
  - 1 test expects `/unresolved/` from a failed request (`contract.ts:157`); the declarative identity
    compiler surfaces the shared typed `RequiredAdapterRequestError` (`failed: rpc`). Same fail-closed
    class and same request id, different message.
  - The other message-level differences observed are `/incompatible/` vs `execution actor/evidence
    mismatch` and `/positive|bounds/` vs the framework negative-input message; both still throw.
- `listener/node_modules/.bin/tsc -p listener/tsconfig.live.json --noEmit`: exit 0. The final tree
  contains only `token-migration.json` (no generated entry, no math registry edit); the temporary
  harness directory was removed.

## Deviations (all fail closed; no assertion weakened)

1. `exact.methods()` includes the framework `local-zero` method. It is rejected for zero input by
   `exact.checks`, so the TS "positive input" policy is preserved; only method order differs.
2. `pricing.finalize` requires the declarative static-evidence block; this family's block is empty
   (no TS static proof exists). It cannot accept `undefined` like the TS finalizer.
3. Exact `buildFragment` checks evidence identity, amount and upper bounds, but `minAmountOut >
   quotedAmountOut` is not rejected at build time. The shared execution program's credit floor uses
   `minAmountOut` and fails at execution via checked subtraction (verified in the harness); this is
   fail-closed later rather than a weakened bound.
4. The declarative action encoder emits the shared runtime-program script (`0x0e` header + program)
   instead of the four literal calldata frames; the program contains exactly
   approve(0) → approve(amount) → `migrateBIT(amount)` → approve(0) plus executor balance probes.
5. Discovery mapped nomination uses `allMatches:true` (the shared mapped-discovery implementation)
   whereas the TS family returns the first log/call. This can nominate the same subject twice in one
   tx; strict identity still verifies each, so admission is unchanged.
6. Error-message differences for required-request failures, negative exact amounts and executor
   evidence are the shared compiler's messages; behavior remains fail-closed.
7. Pricing snapshot is the declarative `{source, halted, inventory, quotes}` shape (extra fields are
   allowed by `ProtocolPricingSnapshot`); TS's top-level `amountIn/amountOut` are carried in `quotes`.
8. The quote/exact path adds a canonical calldata/return `chainQuote` proof for the
   `tokenMigrationAmountToReceive` word. This is stronger than the TS formula equality.
9. Immutable token words are re-read with `addressWord`; a word with non-zero high bytes throws
   instead of returning `valid:false` as `verifyRuntime` would. Both refuse admission; this only
   affects a non-canonical/unknown runtime, and valid addresses are unchanged.

## Gaps

None for this family. `protocol:token-conversion` (BTB/xWin) remains separately blocked under G15;
this migration neither covers nor narrows it.
