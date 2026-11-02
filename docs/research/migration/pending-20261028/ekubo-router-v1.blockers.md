# `custom-swap:ekubo-router-v1` — parked (re-evaluated on framework f4a16ced, 2026-11-02)

Family: `custom-swap:ekubo-router-v1` (`venues/swaps/ekubo-family`), lineage
`ekubo:vanilla-core-pool-key-v1`, activation `SEARCHER_FAMILY_EKUBO_ENABLED`
(`venues/production-families/ekubo.production.ts:15`).
Status: **still parked**. The handwritten TS entry is untouched; no `ekubo.json` production definition was
added. Baseline: merged `f4a16ced` (branch head `04553544`). The earlier discovery draft remains
deliberately non-importable and was not re-authored.

Re-evaluation result: **G-E1, G-E2 (bounded fan-out) and G-E4 are now expressible** by the common
capabilities in `docs/research/design/family-common-capabilities-20261102.md`. **G-E3 (Core-init
reverse binding / historical log index) is still explicitly unsupported and remains decisive** for cold
retained capture; migrating without it would narrow the family, so it stays parked. Probe:
[`ekubo-new-capabilities-probe-20261102.ts.draft`](ekubo-new-capabilities-probe-20261102.ts.draft)
(read-only synthetic fixtures).

## 1. Previous blockers re-evaluated

### G-E1 — tuple candidate / derived `poolId` — RESOLVED (expressible)

Mapped discovery now accepts tuple/array ABI paths and derived scalar fields:
`declarative-discovery.ts:22-29` (field sources incl. `argument.path`, `item`, `expression`),
`:169-178` (`pathType` walks tuple components and bounded arrays), `:180-186` (nested ABI values),
`:233-235` (expression-derived field), `:362-379` (candidate evaluation). The probe compiles one
candidate schema shared by the router `swap` tuple call, the multihop hop tuple and the
`PoolInitialized(bytes32,(address,address,bytes32),int32,uint96)` log; `poolId =
keccak(abiEncode(["address","address","bytes32"],[token0,token1,config]))` is declared with
`{"from":"expression","value":{"op":"codeHash",…}}` and decodes to the same id as the retained
`codec.ts:36-41`/`pool-key.ts` derivation.

Residual structural difference (not a blocker): mapped candidates still require an **address**
`addressField` included in `key`/`instanceKey` (`declarative-discovery.ts:158-164`; calls additionally
require that field to be target or an address argument, `:286-288`). Ekubo has no per-pool address, so
the probe uses the real emitter/target (Core/Router) as `subject` and the composite key
`[subject,poolId]`; the identity subject can still be the pool id. This changes candidate/nomination
grouping relative to the legacy singleton `candidateKey = poolId` (`ekubo-family/discovery.ts:41`), but
does not weaken identity admission.

### G-E2 — bounded multihop fan-out — RESOLVED for candidate expansion

`DeclarativeMappedDiscovery.fanOut` (`declarative-discovery.ts:40-42`) compiles `maxItems` into
per-element catalog patterns (`:209-220` bounds/type check, `:258-262` expansion, `:263-280`
one canonical decode per real observation, `:393-398` per-item candidate). The probe declares
`fanOut:{argument:0,path:[0],maxItems:32}` on `multihopSwap(...)`, gets **33 call patterns**
(1 single-shot + 32 hop patterns), and decodes hop 0/1/2 with correct derived pool ids; an index beyond
the decoded route returns `null`. Per-hop predicates assert zero `sqrtRatioLimit`/`skipAhead` and the
initial `int128` amount bounds (`:253-257` predicate validation).

Residual strictness difference (not admission): the retained decoder also validates the **sequential
token chain** between hops (`ekubo-family/codec.ts:51-60`). Per-item predicates see only
`args`/`item`/`itemIndex` (`:187-208`) and the value language has no fold/reduce, so the carried token
cannot be recomputed for hop *i*. Declaring the multihop pattern would nominate each hop independently
from a malformed call. Every nominated candidate still passes the full Core identity re-verification,
so this is a nomination-strictness difference, not a weaker admission check; it must be recorded if the
family is migrated later.

### G-E4 — packed `bytes32` exact quote — RESOLVED (expressible)

Quote proofs v2 accept `outputWord:{offset,width,signed,negate}` for a `bytes32` output
(`declarative-quote-proof.ts:17,75-85`) and extract the bounded field before the amount comparison
(`:132-139`). A signed `int128` call amount is accepted through `inputBinding`
(`:68`, `:85-95`; the value must explicitly bind `$quote.amountIn`). Per-direction `choices`
(`:216-287`) select the offset: the probe verifies `token0-in` with
`{offset:0,width:128,signed:true,negate:true}` and `token1-in` with
`{offset:128,width:128,signed:true,negate:true}`, both matching
`exactInputAmountOut(decodeEkuboBalanceUpdate(...))`. The proof signature must be the **full**
`quote((address,address,bytes32),bool,int128,uint96,uint256) returns (bytes32,bytes32)`; a `sighash`
has no outputs and is rejected. The common proof still requires positive input/output
(`:174-175`), which matches Ekubo's full-fill exact contract. This closes the old "output is a packed
signed delta, not a uint ABI amount" gap.

Public regression evidence for these capabilities:
`listener/src/searcher/test/declarative-discovery-tuples.test.ts` and
`listener/src/searcher/test/declarative-quote-proof-extended.test.ts`.

### Identity / pricing / execution (previously not blocked)

`identity` `get-code`/`get-storage` requests, code/`codeHash` comparisons, the extension-registration
slot and the multi-round quote evidence remain ordinary declarations; the profile still supports
`memoReuse:"recheck-identity"`. `pricing`'s conditional retry becomes a fixed three-step read flow with
an empty retry round (§3.1). Execution v2 supplies native `value`, conditional allowance/transfer steps,
signed runtime-math checks and native/ERC-20 asset boundaries. Nothing here is the reason for parking.

## 2. Remaining decisive blocker — G-E3: reverse binding / Core initialization log index

The retained family declares a real reverse-binding implementation:
`ekubo-family/discovery.ts:50` (`reverseBinding:{kind:"implementation",reverseBinding:reverseBindEkubo}`);
`nomination.ts:52-67` resolves a nominated pool id to a genuine Core `PoolInitialized` observation, and
`nomination.ts:13-37` builds that index with bounded `provider.getLogs` windows from
`EKUBO_CORE_DEPLOY_BLOCK` to the source block (50 000 blocks per window, per-provider/source cache,
duplicate-log rejection).

Declarative discovery still hard-codes the unsupported outcome:
- `venues/declarative-discovery.ts:428` (v2, and `:103` for v1)
  `reverseBinding: explicitReverseBindingUnsupported(...)`;
- `venues/adapter-family-plugin.ts:342` defines that declaration;
- `venues/capture-materialization.ts:135-137` only runs `kind === "implementation"`, so a declarative
  Ekubo family is skipped by the retain channel;
- `venues/declarative-nomination.ts:17-40` allows only source-pinned `eth-call`/`get-code`/`get-storage`
  reads — no `getLogs`, so the Core initialization index cannot be declared as a nomination read flow.

Why this is decisive rather than cosmetic: retained re-attestation prefers the reverse-binding channel
(`strict-identity-attestation.ts:323-335`; retained rows pass `"reverse-binding-first"` at `:901`). With
no implementation, only fresh receipt/trace/landed nominations remain; the generic address-surface
fallback requires deployed code at the nominated address (`strict-identity-attestation.ts:302-308`), but
an Ekubo pool subject is a `bytes32` pool id with no contract code. Historical cold Ekubo pools
therefore lose their chain-truth re-attestation path. That is a capture-capability narrowing, so the
family must not be migrated on a JSON-only workaround.

## 3. Deviations that would remain after G-E3 (updated from 2026-10-28)

1. **Conditional pricing retry (shape)**: `pricing.ts:30-41,66-101` becomes a fixed three-step read
   flow whose retry `requests` is `[]` for the ordinary case; quotes/mids/validations match, but every
   pricing invocation performs one extra empty round and `decodeSnapshot` requires its evidence.
2. **Anonymous Core-log mutation narrowing**: declarative mutation is address-indexed, so any Core
   anonymous log invalidates all Ekubo routes instead of only the matching pool id (conservative).
3. **Quoted fragment/action shape**: generic `{runtimeAmountProgram}` node and shared action program
   instead of the legacy Ekubo node params/`approve` requirement; same cutover already accepted for
   other swap families.
4. **Candidate subject/key**: infrastructure address + derived pool id rather than the legacy
   pool-id-only candidate key (G-E1 residual above).
5. **Multihop chain continuation**: per-hop nomination predicates cannot carry the token chain between
   items (G-E2 residual above).
6. **Quote-proof direction choice**: Exact needs two v2 `choices` (offset 0 vs 128) plus an
   `inputBinding` for the signed `int128` amount; the request id is shared, only one choice applies.
7. **Identity code-hash facts**: full runtime `keccak` comparisons and the extension-registration
   `get-storage` slot are declarable; no per-family verifier is required.

## 4. Generic extension that would unblock

One universal capability: **declarative reverse binding / bounded log-index nomination** — a data
declaration for source-pinned, bounded `getLogs` windows over a fixed address/topic/cutoff with
duplicate detection and provider/source-scoped caching, whose verified log observation feeds the
existing nomination → `catalog.matches` → `decodeCandidate` path. It is generic (any singleton holder of
hash-keyed pools and any cold retained candidate), not Ekubo-specific; adding a protocol callback,
selector table or Ekubo-specific index to the common engine is out of bounds.

## 5. Validation performed

- `docs/research/migration/pending-20261028/ekubo-new-capabilities-probe-20261102.ts.draft` executed
  read-only with synthetic fixtures:
  - `G-E1/G-E2 patterns: 33 call, 1 log`; swap + 3 multihop hops + `PoolInitialized` candidates matched
    with derived pool ids; out-of-range hop returns `null`;
  - `G-E4 packed quote proof token0-in: amountOut=50` and `token1-in: amountOut=50`;
  - `G-E3 reverse binding: explicitly-unsupported`.
- No Ekubo JSON, math model, production TS/test or registry entry was added or changed by this
  re-evaluation. No Ekubo source is involved in the `tsc`/`build:live` result; both were green on the
  final restored tree (the temporary rendered oneswap entry used by the sibling migration was removed
  again).
- No RPC, VM, live, generator, signing or broadcast work was performed.

## 6. Files

- `docs/research/migration/pending-20261028/ekubo-router-v1.blockers.md` (this file)
- `docs/research/migration/pending-20261028/ekubo-new-capabilities-probe-20261102.ts.draft`
- historical: `ekubo-router-v1.discovery-attempt.draft.json`, `swap-json-gap-probes-20261028.ts.draft`
