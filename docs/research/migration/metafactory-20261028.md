# `protocol:metafactory` — declarative JSON migration (2026-10-28)

Status: **migrated (JSON + math model), in-memory validated; central generation pending.**
Framework baseline: `6876fef0` (family-runtime baseline in `work/protocol-json-20261028`).

## Files

| File | Role |
|---|---|
| `listener/src/searcher/venues/protocols/metafactory-family/metafactory.json` | protocol-json-v2 definition |
| `listener/src/searcher/venues/metafactory-math.ts` | `metafactory:pro-rata-redeem` |
| `listener/src/searcher/venues/declarative-math-models.ts` | appended `metafactoryRedeemMathModel` |

Source of truth (read-only): `metafactory-family/{manifest,discovery,identity,instance,routes,pricing,exact,execution,codec,action,binding}.ts`.

## Mapping summary

- Manifest/protocol: family `protocol:metafactory`, lineage `metafactory:v1-composter-pro-rata-eth-v1`,
  action `metafactory-compost-redeem`, convert taxonomy, `requiresProtocolEdgesFlag: false`,
  activation stays opt-in (`enabled: false`, `SEARCHER_FAMILY_METAFACTORY_ENABLED`).
- Discovery (v2 mapped): observed `compostAndRedeem(uint256,address)` call and `Redeem` landed log;
  candidate `{target, observedAmount}`, keyed by the lower-cased composter address; amount/target
  predicates mirror the handwritten rejection of zero amounts and the zero target.
- Identity: two stages. `composter` reads runtime code, ROBOT token, DEAD_ADDRESS, paused/activated,
  allocated ETH, circulating supply and redemption end; `tokens` reads ROBOT/WETH code and ROBOT
  decimals. Decide mirrors: invalid structure → chain-proven-rejected (runtime vs token reason ids);
  paused/inactive/unset terms → retryable; valid → verified identity with the same provenance hash.
- Instance/route: single ROBOT→WETH graph route with `executionAssets {erc20, native}`, compost-redeem
  direction, same binding projection (`target,tokenIn,nativeAnchor,deadAddress,codeHash,
  payoutSemantics`), same route key.
- Pricing: `pricingFlow` reads allocated ETH, circulating supply and the composter's own
  `calculateRedemptionAmount(oneToken)`, cross-checks the chain view against
  `metafactory:pro-rata-redeem`, and publishes `source/totalEthAllocated/circulatingSupply/quotes`
  plus an `unavailable` map for unset terms, quote gaps and zero output; sample amount is the verified
  `oneToken` (not 1e18); mutation kinds log+call.
- Exact: view quote flow over the three reads, `chainQuote` proof for the composter's
  `calculateRedemptionAmount` call (amount in = requested amount, output = quoted amount), retained read
  proof, and evidence including both state reads and the executor. Zero-input local method returns zero
  evidence; positive inputs keep `chainAmountQuote: true`.
- Execution (v2): exact-clear approval pair (approve 0 → approve amount), `compostAndRedeem(amount, 0)`,
  approve 0; debit equals `amountIn`; credit is the measured native receipt to the recipient; direct
  output only, third-party recipient and deferred-input are null (native ETH only to msg.sender).

## Validation (in-memory only; generator not run)

- `renderDeclarativeProductionEntry` renders the v2 entry; `createDeclarativeProtocolRuntime` compiles
  `math`, `quoteFlow`, `pricingFlow`; `defineProtocolFamily` accepts the plugin (manifest, activation,
  action adapter).
- Full parity against the handwritten TS family on the pinned sample (N=26244712, real runtime-code
  fixture): discovery call/log candidates, identity composter/tokens evidence, verified identity hash,
  descriptor, route, pricing draft (modulo `routes`), pricing snapshot/mid, unset/reverted/failed quote
  availability, exact requests/amount/evidence (modulo `readProof`), cache-compatibility projection,
  expected effects.
- Runtime leg decoded with the shared VM call layout: `balanceOf` debit capture, approve 0, approve
  amount (r0 patch), `compostAndRedeem` (r0 patch), approve 0, `balanceOf` after; native receipt
  measured for the credit. Third-party direct-output and deferred-input return null.
- Family contract test with a temporary rendered production entry: **PASS** (observed
  2 655 542 356 342 977 559 ROBOT → 1 135 019 301 456 866 wei ETH at N=26244712); the handwritten entry
  was restored byte-identically afterwards.
- Shared declarative framework tests: **31/31 pass**; `tsc -p tsconfig.live.json --noEmit` has no
  errors in the touched files (the worktree's only errors are another agent's in-flight
  `origin-steth-arm-math.ts`, not touched here).

## Deviations (fail-closed or structural; no weakened checks)

1. **Nomination surface**: the mapped discovery nominates from both declared call and log patterns with
   `allMatches`; the handwritten family passed only the call pattern to `createTxEvidenceNomination`
   (while already declaring `sources: ["observed-call","landed-log"]`). Candidate admission is still
   the same `decodeCandidate`. The handwritten call decoder also required a canonical calldata
   re-encode; mapped discovery decodes ABI arguments and keeps the amount/target predicates, so a
   trailing-garbage call would nominate the same real composter target. Identity still proves the
   instance independently; no false instance is admitted from this difference.
2. **Source strictness**: the two identity stages assert one canonical source over all observed results;
   the handwritten decoders asserted it over a subset (manager code / first price read). Stricter.
3. **Pricing descriptor** gains the declared `routes` group (shared snapshot validator contract); the
   snapshot gains an `unavailable` map for the three quote-gap cases the handwritten decoder computed
   separately. Normal snapshots are hash-identical.
4. **Exact zero method**: the shared declarative framework always exposes a `local-zero` method; the
   handwritten family had only the request-program. Zero in → zero out; positive quotes are unchanged.
5. **Retained read proof**: exact evidence carries `readProof`, so execution re-decodes the view chain
   and the chain-quote proof instead of trusting evidence fields; a wrong quoted amount fails earlier
   with "execution read proof amount mismatch" rather than "incompatible exact evidence".
6. **Native settlement capability**: the declarative leg reports `settlement: {}` (with
   `settlementRequest` retained) for the native-output route because the shared boundary owns the wrap;
   the handwritten leg reported `{directOutput:true}` for the raw operation. Third-party/deferred
   settlement remains null, matching the handwritten rejection.
7. **Execution program**: the declarative v2 program adds a debit `balanceOf` capture with
   `delta == amountIn` and a native recipient before/after capture; the handwritten program relied on
   the flow's measured receipt. Stricter, same calls/approval sequence. Quoted nodes carry
   `params.runtimeAmountProgram` and the declarative action re-emits that program (`0x0e` script)
   instead of the handwritten four hand-encoded CALLs.
8. No `types` block is declared; central generation will produce an untyped production entry (optional
   per schema).

## Pending

- Central generation of `production-families/metafactory.production.ts`. The existing handwritten entry
  has no generator marker, so `syncDeclarativeProductionEntries` refuses to overwrite it; central
  generation must replace it. `build-family-capability-manifest --check` is intentionally not run here
  (production generator out of scope for this task).
