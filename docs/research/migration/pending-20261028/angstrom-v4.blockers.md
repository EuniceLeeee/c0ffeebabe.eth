# custom-swap:angstrom-v4 — parked (declarative runtime-evidence / V4-observation / nomination gaps)

Family: `custom-swap:angstrom-v4` (`listener/src/searcher/venues/swaps/angstrom-v4-family`,
handwritten entry `venues/swaps/angstrom-v4.ts` via
`venues/production-families/angstrom-v4.production.ts`), lineage
`angstrom-v4:official-hook-poolkey`, activation
`SEARCHER_FAMILY_ANGSTROM_V4_ENABLED` (registered `enabled: true`,
`venues/production-families/angstrom-v4.production.ts:15`).

Status: **parked**. The handwritten TS entry is untouched; no
`venues/swaps/angstrom-v4-family/angstrom-v4.json` production definition was added and the
production generator was not run. The validated first-stage draft is parked at
[`angstrom-v4.discovery-attempt.draft.json`](angstrom-v4.discovery-attempt.draft.json); it is
deliberately **not importable** as an entry (it stops after `discovery`, matching the dodo/ekubo
precedent) and the generator must not be pointed at it. Probes are in
[`angstrom-v4-gap-probes.ts.draft`](angstrom-v4-gap-probes.ts.draft).

Target path if the framework gaps below are closed: the generator stem would be `angstrom-v4`
(the handwritten entry is `angstrom-v4.ts`), so `venues/swaps/angstrom-v4-family/angstrom-v4.json`
is the correct `<name>-family/<name>.json` location; no `*-family` redirection is needed.

Baseline: the handwritten family is green. Executed locally, no VM/RPC/live:
`node --import tsx src/searcher/test/angstrom-v4-family-plugin.ts` → **16/16 pass** (plus the
pre-existing strict-family fixture block); `test/angstrom-v4-action-adapter.ts` → PASS;
`test/angstrom-v4-nomination.ts` → PASS. `test/angstrom-v4-family.ts` fails before reaching any
Angstrom assertion on the unrelated pre-existing registry error
`protocol:boring-vault-teller observed source has no enumerable event topic`
(`venues/adapter-family-registry.ts:1251`); it is not an Angstrom result.

## 1. What the declarative framework can express for this family

| TS module | Declarative block | State |
|---|---|---|
| `discovery.ts:44-101` (Initialize log) | `discovery.definition` v2 event mapping | **expressible and probed**: candidate `{adapter, manager, poolId, currency0, currency1, fee, tickSpacing, hooks, sourceKind}` decodes from the canonical `Initialize` log (probe P-A0/P-A3) |
| `identity.ts:49-304` (2 rounds) | `identity.definition` `select`/`stages`/`decide` | expressible in principle: `get-code`/`eth-call` requests, `code`/`codeHash`/`decode`/`bytes`/`hash`/`sameAddress` ops, per-round evidence carried in `$evidence` (`declarative-identity.ts:90-115`), chain-proven reason codes and `continue` |
| `instance.ts:20-40` | `instance.key`/`draft`/`bindingProjection` | expressible: `poolKey` + `immutableBinding` projections can be rebuilt from candidate/read facts; `finalizeDescriptor` returns the frozen draft when no `instanceEvidence` module is declared (`declarative-family.ts:337-342`) |
| `routes.ts:11-70` | `routes.target/bindingKey/directions/graphVenue/effects` | expressible: two directions from `poolKey.currency0/1`, `manager-pool-id` venue, legacy `familyId␟manager␟poolId␟tokenIn␟tokenOut` key and binding fingerprint = hash of the same static projection |
| `pricing.ts:39-192` | `pricing` + `pricingFlow` + `pricingProjection` + a pure math model | expressible with a **new registered math model** reproducing `q96DirectedReserves`/`q96PrecisionProbeAmount`/`directedPoolMid`; `classifyUnavailable` reproduces the tx-bound-precision reason. One fidelity caveat in §3 item 4 |
| `swap.ts:70-106` (pool materialization) | `swap.poolMaterialization.result` | expressible from the same `Initialize` decode (poolId + poolKey + manager/adapter constants) |
| `victim.ts:17-57` (replay shape) | `swap.replay.bind/applyLocal/exactPostState` | shape expressible (`bind` can select the route by tokens, `applyLocal`/`buildOverlay` return `null`, `exactPostState` maps `impact.v4PostState`); see G-A5 for the receipt identity that must feed it |
| `action.ts:3-14` | `actionAdapters[0].descriptor` + traces | expressible: target-pinned `swap((...))` trace and shared runtime-program encoder; the handwritten amount-only checks become runtime guards |
| `manifest.ts:6-18` | `manifest` | exact copy: family/domain/action ids/lineage/pool/edge ids (`requiresProtocolEdgesFlag:false`) |
| `execution.ts:24-124` (source-unlocked branch only) | `standard.execution` v2 | mechanically expressible but **not faithful**: see G-A1/G-A6 |

The parked draft compiles and validates the Initialize path; `npx` probe output:

```
P-A0 draft compiles; Initialize candidate decoded; swap-call candidate null; nomination=tx-evidence sources=landed-log|observed-call
```

## 2. Blocking gaps

### G-A1 (decisive) Declarative discovery has no runtime-evidence producer

The family's production execution is tx-bound: it derives an empty-block attestation from a real
observed Angstrom swap and binds it to `txHash + source` before Exact quoting and execution.

- `angstrom-v4-family/discovery.ts:91-97` installs
  `runtimeEvidenceFromObservation: angstromRuntimeEvidenceFromObservation` and
  `pendingRuntimeEvidenceFromObservation: angstromPendingRuntimeEvidenceFromObservation` with
  `runtimeEvidenceRouteActivation: {mode:"current-head-block-scan", scope:"family"}`.
- `angstrom-v4-family/evidence.ts:151-227` derives the evidence from the observed adapter call's
  `hookData` bundle; `evidence.ts:245-296` is the async current-head path (controller reverse
  binding + validator membership multicall, `evidence.ts:298-393`).
- Central only consumes those plugin hooks: `adapter-family-plugin.ts:428-433` says families
  without the hook "carry an empty runtime-evidence list";
  `strict-production-runtime-session.ts:1270-1292` calls
  `family.plugin.discovery?.runtimeEvidenceFromObservation`; only families with
  `runtimeEvidenceRouteActivation` **and** `pendingRuntimeEvidenceFromObservation` are registered
  as pending observers (`strict-production-family-declarations.ts:244-267`,
  `adapter-family-plugin.ts:3485-3515`).
- The declarative discovery compiler returns only the mapped fields
  (`declarative-discovery.ts:294-317`); `DiscoverySemantics` allows the hooks
  (`adapter-family-plugin.ts:434-458`) but `compileDeclarativeDiscovery` never creates them, and
  the declarative root document has no key for them (`declarative-family.ts:95-96` allow-list).
- Probe P-A1 (exact returned key set):

```
P-A1 discovery keys: callPatterns,candidateKey,decodeCandidate,evidenceChannel,instanceNominationKey,logPatterns,nominate,reverseBinding,sources,txSeedNominations
P-A1 runtimeEvidenceFromObservation: undefined
P-A1 pendingRuntimeEvidenceFromObservation: undefined
P-A1 runtimeEvidenceRouteActivation: undefined
```

Consequences, all real capability/security changes:

1. `exact.ts:145-184` selects `tx-bound-quoter` only when `runtimeEvidence` is non-empty and
   throws for non-array/poisoned evidence. With the declarative producer absent the only reachable
   branch is the empty-evidence `source-unlocked-quoter`
   (`exact.ts:150-163`, `exact.ts:283-311`); the signed quote program
   (`exact.ts:37-98`, attestation `unlockData` at `exact.ts:214-237`) is unreachable.
2. `execution.ts:25-40` builds the runtime leg from `requireAngstromRuntimeEvidence(...)`; without
   evidence it falls back to `[{blockNumber: source.number, unlockData:"0x"}]`. The family comment
   (`execution.ts:86-91`) states the adapter selects the entry for `block.number`: a B+1 execution
   cannot borrow this block's source. A live Angstrom route would therefore be quoted but unable
   to execute at B+1.
3. `execution.ts:45-105,126-161` validates `runtimeEvidenceHash`/`payloadHash`/
   `attestationEvidenceHashes` before execution. JSON can reproduce the call shape but not the
   evidence authorization (G-A2).
4. The current-head pending observer disappears entirely, so the live backrun path that motivated
   this family is not migrated.
5. The family contract test asserts all of this:
   `src/searcher/test/angstrom-v4-family-plugin.ts:522-704` (observation producer, stale-first
   bundle, wrong-block rejection, quote/execution hook-data identity, pending authority reads,
   source-unlocked isolation).

This is decisive: the task's "no weakened checks" rule forbids shipping the unsigned-only subset.

### G-A2 (decisive, verification) Attestation authorization is not expressible

Even with a future evidence-producer hook, the JSON must *verify* the attestations; the handwritten
module does:

- `angstrom-attestation.ts:166-190` — `verifyAngstromAttestation` requires `eoaSignatureValid`;
  `:224-249` recovers the signer with `ethers.verifyTypedData` over the canonical
  `AttestAngstromBlockEmpty` EIP-712 domain (`:36-51`).
- `angstrom-attestation.ts:579-616` — `decodeAngstromExecutionEvidence` re-parses and re-verifies
  every attestation at every quote/plan boundary (canonical re-encoding at `:616`).
- `evidence.ts:298-393` — pending path reads hook controller slot, controller `ANGSTROM()` and
  per-validator `extsload` node mapping, then requires membership.

Declarative expressions have no signature/recovery/typed-data operation: the closed op set is
`declarative-values.ts:23`; there is no crypto op and no `math` model invocation on discovery or
ready observations (`declarative-math.ts:8-15` registers pure value transforms;
`declarative-family-modules.ts:32-98` has no runtime-evidence module). A model *could* implement
ECDSA as a pure function, but there is no attachment point that central calls with an observation,
source and read callback, so it cannot participate in the evidence decision.

Positive finding: the sealed payload itself is ABI-decodable from JSON (`decodeCanonical` accepts
the canonical single dynamic `(uint64,bytes)[]` encoding), probe P-C1:

```
P-C1 decoded sealed payload: [ Proxy(Result(1) [ Proxy(Result(2) [ 100n, '0x1234' ]) ]) ]
```

so a future module can expose `blockNumber`/`unlockData`; the missing piece is validation
(signature, current-source block, validator membership) and the producer, not decoding.

### G-A3 (decisive) Mapped discovery cannot express the swap-call candidate

The production decoder recovers the complete PoolKey from the adapter swap calldata and derives
`poolId = keccak256(abi.encode(PoolKey))` (`discovery.ts:132-156`, `codec.ts:50-67`).

Mapped declarative discovery:

- candidate fields are scalar only (`address|uint|bytes32|bool|string|number`,
  `declarative-discovery.ts:104-115,131-134`);
- field sources are top-level `argument` index, `target`, `sender`, `emitter`, `opaque`
  (surface only), `observation` (txHash/source only) or `literal`
  (`declarative-discovery.ts:155-181`); a tuple argument cannot supply a scalar field —
  `scalar()` rejects it and `decodeCandidate` catches the failure (`:248-281`);
- the candidate key must contain an address field (`:144-150`), and no source can compute a
  derived value (no `keccak(abi.encode(tuple))` expression in mapping).

Probe P-A2 (adapter swap call, all key fields mapped from argument 0):

```
P-A2 swap-call candidate: null
```

Probe P-A0 shows the same failure for the parked draft. Consequence: the `observed-call` discovery
source is lost (the family declares `sources: ["factory-log","landed-log","observed-call"]`,
`discovery.ts:46`); only the `Initialize` log (emitted once at pool creation) can nominate a
candidate. The production decoder also guards `currency0 < currency1`, no native currency and
`hooks == ANGSTROM_MAINNET_HOOK` (`codec.ts:34-47`); the hook/ordering predicates are expressible,
`tickSpacing` is signed (`int24`, field types have no int) and canonical pool-key normalization is
not.

### G-A4 (decisive for capture) Custom nomination / reverse path is not expressible

`angstrom-v4-family/nomination.ts:24-84`: for a graph nomination whose opaque payload carries only
`poolId`, the family finds a recent `[Swap, poolId]` log with `findRecentLogHit`, traces the
transaction and returns the real adapter swap-call frame (the only way to recover the PoolKey, since
`poolId` is one-way). The discovery also declares the `factory-log` bootstrap source
(`discovery.ts:46`).

Declarative alternatives are not equivalent:

- mapped `sources` are limited to `landed-log|observed-call|address-surface`
  (`declarative-discovery.ts:123-128`); `factory-log` is rejected (probe P-A4:
  `invalid discovery sources`);
- `nominate` is either generic tx-evidence (requires an opaque `txHash`, re-reads a receipt;
  `createTxEvidenceNomination`, `declarative-discovery.ts:302-307`) or address-surface with a
  read-only `nominationReadFlow` (`declarative-nomination.ts`);
- `nominationOnly: true` events exist, but tx-evidence nomination filters observations with
  `decodeCandidate(...) !== null` (`declarative-discovery.ts:302-305`), and `decodeCandidate`
  returns `null` for nomination-only patterns (`:272-273`). Probe P-A5 (a receipt with one
  nomination-only Swap log, no Initialize):

```
P-A5 swap-log-only nomination: 0
```

so a swap-only transaction cannot seed a nomination; only a pool-creation transaction with
`Initialize` can. Capture/backrun of an existing Angstrom pool through the graph nomination is
therefore unreachable.

Related: declarative discovery has no `canonicalIntakeTargets`
(`declarative-discovery.ts:294-317`); the handwritten discovery declares adapter/hook/manager
(`discovery.ts:47-51`), and the strict declarations feed `discovery?.canonicalIntakeTargets` into
the mempool filtered subscription (`strict-production-family-declarations.ts:221-229`). Without it
the adapter (the pending-tx `to`) is not a family-declared intake target.

### G-A5 (decisive for swap observation) Natural V4 singleton receipt identity is not expressible

The production identity subject is `${manager}\u001f${poolId}` (`identity.ts:281`) and the
production receipt observer binds the singleton `Swap` log by `edge.v4PoolKey`/`edge.poolId`
(`swap-observation.ts:653-664`); the projected declarative edge is only
`{instanceKey, executionVariantKey, adapterId, target, tokenIn, tokenOut, slotKind, taxonomy, score}`
(`adapter-family-graph-runtime.ts:193-205`) — no `v4PoolKey`/`poolId`.

The declarative receipt binder instead requires the declared pool identity to equal
`edge.target`, or the edge `instanceKey` to equal the pool identity when it is a 32-byte poolId
(`declarative-swap-domain.ts:206-222`). With the production instance key and the natural
`Swap(args.id)` pool expression,

```
P-B1 poolId identity: unresolved Swap impact violates admitted route binding
```

An adapter-identity workaround (`pool` = the adapter, matching by `$descriptor.poolId` inside
`match`) does resolve, but it changes ownership: `observedPoolIdentity` returns the adapter for a
*foreign* pool's `Swap` log, so every PoolManager `Swap` log becomes an owned trigger for this
family (over-trigger; unrelated pools resolve as mutation-only rather than no-match):

```
P-B2 adapter identity: resolved impact {... v4PostState ...}
P-B2 foreign-pool observedPoolIdentity: 0xb535aeb27335b91e1b5bccbd64888ba7574efbf8
P-B2 foreign-pool receipt: resolved [{"logIndex":0,"reason":"direction absent from admitted graph",...}]
```

The natural path is blocked and the workaround is observably non-equivalent; this must be fixed in
the shared V4/singleton observation model (or declared as an accepted, reviewed deviation) before
`victimSupport: "replay"` can be claimed.

### G-A6 (decisive for Exact) Exact method set is input-dependent, declarative is static

`exact.ts:145-184` returns a *different request program* depending on the runtime-evidence list:
empty evidence → `local-zero` + `source-unlocked-quoter` (`exact.ts:100-143`); non-empty evidence →
`local-zero` + `tx-bound-quoter` (`exact.ts:37-98`). The declarative exact block exposes exactly one
`methodId` + one request program plus `local-zero` (`declarative-family.ts:594-665`), and the
method set is fixed at registration. A single JSON flow could branch on `$runtimeEvidence` inside
`requests`, but the method id/cache projection/evidence shape and the signed-vs-unsigned
authorization gate are not expressible without G-A2; with G-A1 the signed branch is dead.

### G-A7 (deviation, not decisive) Pricing feeBps integer

`pricing.ts:111` publishes `feeBps: Number(snapshot.lpFee) / 100` (may be fractional: LP fee is in
hundredths of a bip dynamically set by the Angstrom hook). The declarative price row requires an
unsigned integer `feeBps` bigint (`declarative-pricing-projection.ts:19,26-27,33`). A model can only
floor/round; this changes graph fee/scoring input. It is not a safety check but it is a fidelity
loss and should be fixed (e.g. a declared fractional/ppm fee) or accepted explicitly.

## 3. Deviations that would remain after G-A1..G-A6 are fixed

1. **Identity evidence shape.** The handwritten decide hashes `{manager,adapter,hook,poolId,
   poolKey,controller,codeHashes,canonicalHook,sqrtPriceX96,liquidity}` with `hashCanonical`
   (`identity.ts:262-303`). JSON can reproduce the same fields/`hash`, but provenance object
   identity and `instance.runtimeRequirements` ordering must match the legacy descriptors that
   Ready hashes; this needs a descriptor-parity check, not just compile.
2. **Discovery source/channel names.** `factory-log` is not declarable; the draft uses
   `landed-log|observed-call` and loses the reverse-bootstrap channel. `canonicalIntakeTargets` is
   absent (G-A4). The candidate key becomes a structured JSON array (probe P-A3) instead of the
   legacy `manager␟poolId` string; `instanceNominationKey` can restore grouping but not the legacy
   key text.
3. **Pricing static stage.** Declarative `finalizePricingDescriptor` requires static evidence
   (`declarative-family.ts:466-468`) and the JSON must declare a `pricing.static` block even though
   the handwritten family has none; the source-local empty stage is the established pattern.
4. **Pricing feeBps** (G-A7).
5. **Execution settlement shape.** The handwritten `buildRuntimeLeg` returns no settlement
   capability (`runtime-execution.ts:13-14`); the declarative variant must declare
   `settlement.directOutput` (`declarative-family.ts:147-148`,
   `declarative-execution.ts:826-841`). Declaring `true` adds a direct-recipient capability the
   handwritten path did not advertise (the shared guards are not weaker, but it is an API change);
   declaring `false` fails closed for direct settlement.
6. **Action encoder shape.** The declarative action accepts only a `runtimeAmountProgram` node
   (`declarative-execution.ts:873-894`); the handwritten tests assert the legacy calldata bytes and
   `attestationBlockNumbers`/`attestationUnlockData` node params
   (`test/angstrom-v4-action-adapter.ts`). This is the generic shape change already accepted for
   univ1/univ2/univ3/ella/kyberswap.
7. **Victim replay shape.** `bind`/`applyLocal`/`buildOverlay`/`exactPostState` are expressions in
   JSON; the handwritten `bind` checks `impact.pool == manager` and returns a route object, which
   the declarative wrapper replaces with a route-key contract
   (`declarative-swap-domain.ts:230-241`). Equivalent only if the route keys and impact identity
   are pinned; blocked by G-A5 anyway.

## 4. Generic framework extensions that would unblock

1. **Declarative runtime evidence (the decisive one).** A `discovery.runtimeEvidence` declaration
   with sync observation derivation, current-head pending derivation (`observation + source + call`),
   activation, and a *sanctioned verification attachment* (pure model or bounded op) for
   payload→verified evidence plus hashes. Central already owns transport, deadlines and
   evidence sealing; only the Family-owned extraction/authorization is missing.
2. **Mapped-discovery tuple projection and derived fields.** Allow a call/event pattern to project
   nested tuple components and computed values (e.g. `keccak(abi.encode(...))` via a registered
   model) into candidate fields, with the same scalar/key checks. This is the ekubo G-E1 request;
   Angstrom needs `PoolKey` + `poolId` and writes the expected shape in the parked draft.
3. **Nomination-only tx-evidence and trace nomination.** Let a nomination-only pattern seed a
   tx-evidence/trace nomination without a complete candidate (the family's recent-`Swap`-log→trace
   path), and expose the existing `CaptureNominationProvider` getLogs/trace capabilities as
   declared data.
4. **Singleton/V4 swap observation.** Declare `edge.poolId`/`v4PoolKey` on projected graph edges or
   a `swap.observation.poolIdentity` binding so a manager-emitted `Swap` can bind to an
   adapter-targeted route with `instanceKey = manager␟poolId`; otherwise the only workaround
   over-owns every PoolManager `Swap` (G-A5).
5. **Exact method selection by invocation evidence.** Declare a method set (or method selector)
   that can distinguish empty vs present runtime evidence, preserving per-method ids, cache
   projection and fail-closed rejection of poisoned evidence.
6. **Discovery `canonicalIntakeTargets`** (mempool intake) and a fractional/fee-ppm price row.

## 5. Validation performed

All local, read-only, synthetic fixtures; no VM, RPC, live, signing or broadcast.

- Probes (`angstrom-v4-gap-probes.ts.draft`, copied to
  `listener/.migration-probe/angstrom-probes.ts`, `node --import tsx`, exit 0): P-A0 draft
  discovery compile + Initialize candidate; P-A1 runtime-evidence hooks absent; P-A2 swap-call
  candidate null; P-A3 Initialize positive; P-A4 `factory-log` rejected; P-A5 swap-only nomination
  0; P-B1 natural V4 receipt unresolved; P-B2 adapter workaround resolved + foreign-pool
  over-ownership; P-C1 sealed payload decodes. The temporary probe directory was removed after the
  run.
- Handwritten baseline: family plugin 16/16, action adapter PASS, nomination PASS (commands above).
- `tsc -p listener/tsconfig.live.json --noEmit`: PASS (exit 0).
- `npm run build:live`: PASS (exit 0).
- Tree after validation: only the three files in §6 are untracked; no production TS/JSON/test/
  registry edit, no generated artifact. The parked draft is not a rendered production entry and
  was not run through `build-declarative-production.ts`; the production generator was not run.

## 6. Files

- `docs/research/migration/pending-20261028/angstrom-v4.blockers.md` (this file)
- `docs/research/migration/pending-20261028/angstrom-v4.discovery-attempt.draft.json` (partial,
  validated discovery only; **not importable**)
- `docs/research/migration/pending-20261028/angstrom-v4-gap-probes.ts.draft` (probe sources; copy to
  `listener/.migration-probe/angstrom-probes.ts` and run `node --import tsx` from `listener/`)
