# `protocol:psv` — parked declarative draft and blockers (2026-10-29)

Status: **blocked / not migrated**. The non-execution half of `psv-family` is expressible and
in-memory validated, but the execution contract has hard framework gaps. The legacy
`psv-family` TS entry remains the production entry. No live/VM/RPC work, no signing, no
public framework TS/test change, no production generator run.

Files parked here:

- `psv.draft.json` — protocol-json-v2 draft for one lineage (`psv:uups-exact-input-v1`).
  It is a **partial** draft: execution declares the default swap leg only and fails closed
  for `quote-output`/`direct-output`. It is not a deliverable and must not replace the TS
  entry.
- `psv.blockers.md` — this file.

No math model file is required for the draft. The temporary production entry and temporary
`venues/protocols/psv-family/psv.json` used for validation were removed; the handwritten
entry imports again and `tsc` is clean.

## What the draft expresses (validated in-memory)

- **Discovery** (`declarative-discovery.ts` v2 mapping): `sellGem`/`buyGem` call patterns
  with canonical-calldata/nonzero-amount predicates, the `Swap` log pattern
  (nonzero amounts, distinct tokens), the `psv:uups-exact-input` address surface, `psv`
  nomination labels and one-address candidate key. Call/log/surface positives pass; zero
  address, zero amount, noncanonical calldata and equal-token `Swap` all return `null`.
- **Identity** (3 rounds, 6 → 14 → 4 requests): UUPS proxy/implementation code-hash proof
  (masked self references at bytes 4253/4473), `GEM`/`STABLE`/`gemToWad`/`stableToWad`
  binding, implementation/asset code hashes, decimals, dynamic state (`paused`, fees,
  treasury, caps, reserves, remaining), `whitelist(PROBE_RECEIVER)`, and one
  `effect-delta-simulation` per direction/size. On the family fixture it verifies with
  probe sizes `1,000,000` and `10,000,000` for both directions — identical ids/amounts to
  the legacy `probes()` result. Decode checks the 5 exact token deltas, unique non-aliased
  actor, `Swap` event fields, every result source and a canonical behavior hash. All nine
  legacy negative cases (`wrongCode`, `wrongProxy`, `duplicateToken`, `pause`, `capacity`,
  `wrongDebit`, `wrongFee`, `missingReceipt`, `wrongSource`) fail closed with `retryable`
  or earlier rejection.
- **Routes**: the two legacy directions, the stable
  `protocol:psv:<target>:<direction>` key, `bindingRef` = target / `hashCanonical(binding)`,
  taxonomy `protocol/convert`, `address-protocol` graph venue.
- **Pricing**: one 19-read state round (same ids/order as `stateRequests`), per-route
  sample `capWad / scale` and the legacy integer formula, `each-block` refresh,
  `classifyUnavailable` reason `psv-paused-or-no-positive-capacity`, and a
  `Transfer`-scoped mutation predicate. Paused and capped fixtures produce 0 quotes /
  0 mids / 2 unavailable; normal fixture produces 2 quotes / 2 mids. Mutation
  `affectedStateKeys` matches the legacy contract case (unrelated transfer `[]`,
  target-touching transfer `[instanceKey]`, target call `[instanceKey]`, gem call
  `[instanceKey]`).
- **Exact**: `recipient-amount-preview` request program = state reads + recipient-specific
  `previewSellGem`/`previewBuyGem`, state binding re-proof, treasury!=executor, capacity
  check; expression matches the legacy `formula()` for gem 6/18-decimals × stable 18/6,
  fees `0` and `10%`; zero amount returns `local-zero` evidence; paused/cap/foreign-source
  fail closed.
- **Execution**: only the default swap leg (`approve 0 → approve amount → sellGem/buyGem →
  approve 0`, exact debit, fresh credit, external-recipient unchanged balances). It runs
  in the independent testkit with a stateful balance fixture in both directions. The
  emitted program has 8 calls (2+2 balance captures around the legacy 4 calls), not the
  legacy 4.
- **Action**: fragment built from exact evidence encodes to 894 bytes; malformed params
  reject.
- **Registration**: `createDeclarativeProtocolRuntime` + `defineProtocolFamily` pass;
  `renderDeclarativeProductionEntry` returns a `protocol-json-v2` entry with
  `ownedActionAdapterIds ["psv"]`.

## Validation receipts

- `listener/node_modules/.bin/tsc -p listener/tsconfig.live.json --noEmit`: exit 0 with
  the temporary declarative entry, and exit 0 after restore (handwritten entry).
- Family contract test with temporary declarative entry: **17/20 pass**. Failures:
  - `runtime supplies r0 input, exact approval and checked cleanup…` —
    `declarative route binding mismatch` (TS-built route passed at
    `psv-family/test/contract.ts:88-90`);
  - `production amount selector calls runtime and not Exact/quoted/RPC` — same route
    mismatch (`:108-111`);
  - `block cap resets are not carried; compiled touched index scopes reserve transfers` —
    `plugin.pricing.refreshPolicy` is `undefined` vs `"each-block"` (`:128`).
- Family contract test after restoring the handwritten entry: **19/20 pass**; the sole
  failure is the pre-existing central test-stub issue
  `session.blocksPrefixInversion is not a function`
  (`blockscan-sim-amount-selector.ts:57`), the same class already recorded in
  `protocol-json-framework-gaps-20261029.md` §8. It is not caused by this draft.
- `src/searcher/test/psv-direct-recipient.ts` with temporary declarative entry:
  **0/5 pass**. Identity and pricing compile/publish successfully; the first failure is
  `assert.deepEqual(base.settlement, { quoteOutput: true, directOutput: true })` —
  declarative routes return `{}` (`:155`). `quote-output` and `direct-output` legs are
  `null` (`:164`, `:180`, `:194`, `:207`, `:225`). The byte-equality assertion at `:157-162`
  is not reached, but it would also fail (see B3).
- `src/searcher/test/psv-direct-recipient.ts` after restoring the handwritten entry:
  **5/5 pass** (baseline), confirming the failures above are declarative-entry gaps,
  not a broken workspace or harness.

## Blockers (file:line)

### B1. Declarative execution has no `quote-output` settlement capability

Legacy PSV is both a quote emitter and a direct executor:
`psv-family/execution.ts:46-52` claims `{ quoteOutput: true, directOutput: true }` and
routes `{kind:"quote-output"}` to `runtime-quote.ts:12-32`; the settlement composer uses
that capability (`simulator/runtime-settlement.ts:20-22`), and the family lifecycle test
asserts it (`test/psv-direct-recipient.ts:155,163-167`; Solidity check
`test/RuntimeRecipient.t.sol:95-99`).

Declarative legs expose only `directOutput` and `deferredInput`:
`declarative-settlement` cannot claim or build a quote emitter
(`declarative-execution.ts:439-452`), `declarativeSettlementCapabilities` has no
`quoteOutput` key (`:448-452`), and `buildDeclarativeRuntimeLeg` returns `null` for
`quote-output` (`:454-461`). JSON cannot declare a second read-only runtime program for
the same variant. This is a real capability loss (quote-output legs are composed by
`runtime-settlement.ts`), so it must not be papered over.

### B2. `direct-output` needs a per-settlement program and a nested quote program

Legacy direct output runs the quote program as a read-only subscript, then the swap
program, then exact debit/receipt/native/cross-balance checks
(`psv-family/execution.ts:25-44`; `runtime-quote.ts:12-32`). The declarative compiler
builds one program per variant for every settlement request
(`declarative-execution.ts:454-461`) and has no nested `run` operation
(`:40-47` operation union; only `deferred` callbacks). Even inlining the quote steps
would need runtime math for the treasury-gross and WAD-cap checks and a branch selecting
default vs direct vs quote behavior from `$settlement`; execution steps cannot branch on
settlement (`:268-272`), and `settlement` is a static `{directOutput:boolean}` declaration
(`:112-113`). The draft therefore declares `directOutput:false` and fails closed.

### B3. In-program effect measurement breaks the legacy execution contract

Declarative execution always emits balance captures for declared effects — before/after
calls and `difference`/`equal` checks (`declarative-execution.ts:178-202,300-301`). The
default PSV leg is a fixed four-call program and the family/lifecycle tests assert the
exact bytes and call shape (`psv-family/test/contract.ts:91-95`;
`test/psv-direct-recipient.ts:157-162`). The declarative default leg is behaviorally
equivalent but has two pre-swap and two post-swap `balanceOf` probes (8 calls), so both
byte equality and `calls.length === 4` fail. In v2 the compiler additionally appends an
`unchanged-native` capture (`declarative-execution.ts:153-157`); the family test's
`inspectRuntime` fixture has no native/stateful balance hook (`contract.ts:91`), so it
throws before behavioral checks. This is the same generic class as badger-sett-withdraw
(G11) and curve-lp (G17-B2), not a PSV-specific bug.

### B4. Declarative routes cannot hash-equal the TS route passed by the family test

Declarative projection always adds `target` and `adapterId` and uses the direction id
(`declarative-protocol.ts:220-232`); `assertInvocation` requires full canonical hash
equality (`:246-253`). The family fixture still builds routes with the legacy TS
projector (`psv-family/test/fixtures.ts:67-71`), which has no `target`/`adapterId`, and
passes them into `plugin.execution.buildRuntimeLeg` (`contract.ts:88-90,108-111`).
PSV's identity/exact/pricing semantics are the same, but the two route shapes can never
hash-equal. This is a harness/capability-shape incompatibility, not a missing protocol
fact. It blocks the existing contract test but is fixable by using plugin-projected routes
(as psm/compound family tests already do) — the separate central lifecycle test is still
blocked by B1/B3.

### B5. Declarative pricing does not expose the static `refreshPolicy` marker

The declarative plugin implements `refreshPolicyForInstance` (`each-block` is correct and
was exercised) but not the legacy optional static `pricing.refreshPolicy`
(`adapter-family-plugin.ts:836-839`; declarative pricing object
`declarative-protocol.ts:393-398`). The PSV contract test asserts
`plugin.pricing.refreshPolicy === "each-block"` (`psv-family/test/contract.ts:128`).
Behavior is correct; the marker/contract is absent.

### B6. Minor residual differences (not the reason for parking)

- The generic declarative action encoder checks only adapter id and one `params` field,
  then `encodeRuntimeAmountNode` (`declarative-execution.ts:485-490`); legacy
  `action.ts:7-9` also requires four distinct addresses and one param. Issued nodes are
  route-bound and identity-checked, but a standalone malformed node is not rejected at
  the action boundary.
- Legacy exact rejects any prefix/runtime evidence (`exact.ts:9-12`). `$prefix` is not
  bound in the declarative exact-check environment when no prefix is supplied
  (`declarative-protocol.ts:569-580` uses `environment()` not `readEnvironment()`), so the
  draft checks `runtimeEvidence` only. Central skips request methods under a prefix
  (`adapter-family-runtime.ts:1528-1530`), so positive-amount prefix quotes fail closed;
  the local-zero path would not reject a supplied prefix.
- Legacy `behaviorHash` is `hashCanonical(JSON.stringify(results, bigint→string))`;
  declarative `hash($results)` hashes bigint-typed values. Same audit role, different
  digest (not cross-compared).
- Scalar-result canonical re-encode is implicit in `ethers` decoding; the legacy explicit
  `encodeFunctionResult === data` check has no direct JSON op.

## Verdict

Stop per migration policy. The draft demonstrates that discovery, identity, instance,
routes, pricing and exact are expressible; the execution capability is not. The missing
pieces are real settlement capabilities, not optional trimming:

1. a declarative `quote-output` emitter (a read-only runtime program whose child `r0` is
   the expected receipt) exposed through `RuntimeSettlementCapabilities`;
2. per-settlement execution programs (or an explicit per-kind selector) for
   default/direct/quote, plus a runtime-math path for the direct preflight/conservation
   arithmetic, or a nested-read-only-`run` primitive;
3. an effect-verification mode that preserves the legacy program byte layout (central
   receipt effects instead of in-program balance captures), or an accepted behavioral
   equivalence gate in the family/lifecycle tests;
4. route projection compatibility for TS-built routes and the static
   `pricing.refreshPolicy` marker (or family-test migration to plugin routes plus a
   declarative static refresh marker).

Revisit when (1) and (3) exist; a quote-output PSV leg cannot be replaced by
direct-output without removing a settlement path used by `runtime-settlement.ts`.
