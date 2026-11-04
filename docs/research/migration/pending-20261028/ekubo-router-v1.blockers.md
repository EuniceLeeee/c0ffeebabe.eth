# `custom-swap:ekubo-router-v1` — migration record (2026-11-02 park re-opened 2026-11-04)

Status: **migrated on framework `f4a16ced` (branch head `04553544`), pending central generation.** This
file records the resolution of the 2026-11-02 park. The live mapping/validation report is
[`../ekubo-20261104.md`](../ekubo-20261104.md); delivered files are
`venues/swaps/ekubo-family/ekubo.json` and `venues/swaps/ekubo-family/declarative-math.ts` plus the
append-only math/runtime-math registrations.

## Why the G-E3 park was too strong

The earlier park assumed a cold retained Ekubo row had only a `bytes32` pool id and no address/contract
evidence. The production retained shape is different (`venues/swaps/ekubo/discovery.ts:238-257`):
`PoolUniverseEntry.address` is `EKUBO_ROUTER` (deployed code), and the row carries `poolId`,
`token0/token1` and `routeBinding` (`ekubo.pool-key.v1`, ABI-encoded `(token0,token1,config)`).
The retained legacy materializer itself rebuilds PoolKeys from the same persisted `routeBinding`
without a Core log (`venues/swaps/ekubo/discovery.ts:198-225`, `retainedPoolKeys`); it only falls back
to the Core index for pool-id-only retry rows. `strict-identity-attestation.ts:320` passes
`entryOpaque(pool)`, which copies every non-address field into the nomination opaque. Mapped discovery's address-surface path therefore receives the complete
PoolKey and can derive/verify `poolId = keccak(abiEncode(token0,token1,config))`; identity then re-reads
code (where required) and two full-fill router quote rounds in both directions.

Probe: [`ekubo-retained-path-probe-20261104.ts.draft`](ekubo-retained-path-probe-20261104.ts.draft)
(executed read-only) — retained row → address-surface nomination → declarative candidate with the same
pool id, no `getLogs`; `applies` true. The retained universe path (`swap-family-inventory.ts:130-200`,
`strict-identity-attestation.ts:323-367`) falls through from the now-unsupported reverse-binding channel
to `executeCatalogCaptureNominations`, so the address-surface observation is the fresh channel for cold
rows. The generic `centralAddressSurfaceFallback` also passes `entryOpaque(pool)` as the opaque payload
(`strict-identity-attestation.ts:354-368,790-815`), so it reaches the same decoder.

## Gap resolution

- **G-E1 tuple/derived candidates** — resolved (`declarative-discovery.ts:22-29,169-186,233-235,362-379`);
  candidate `subject` is the real Router/Core target/emitter and `token0/token1/config/poolId` are
  mapped/derived. Candidate key is `[subject, poolId]` because a mapped candidate must carry an address
  field; identity subject remains `poolId`.
- **G-E2 bounded multihop fan-out** — resolved for candidate expansion
  (`:40-42,209-220,258-280`); 33 patterns (single-shot + 32 hops) with per-hop tuple/derived fields and
  zero-limit/initial-amount predicates. Residual: the carried token chain is a sequential fold that
  per-item predicates cannot express, so a malformed non-chaining call nominates each hop; every hop
  still passes full identity.
- **G-E3 reverse binding / Core log index** — **no longer decisive for retained universe rows**: the
  persisted `routeBinding` supplies the PoolKey and identity supplies the behavior proof. Retained rows
  that carry only `poolId`/no `routeBinding` (e.g. raw retry entries before the retained
  `ekuboPoolDiscovery` completes them) still cannot be decoded by this family and would need the legacy
  Core-log index; the production `PoolUniverseEntry` path carries `routeBinding`.
- **G-E4 packed bytes32 quote** — resolved (`declarative-quote-proof.ts:17,68,75-85,132-139,216-287`);
  per-direction `choices` with `outputWord` offset 0/128, signed+negate, and `inputBinding` for the
  signed `int128` amount; full quote signature with returns.

## Remaining limitations (documented in the report)

Native-output `directOutput` capability withheld; anonymous Core-log mutation invalidates all Ekubo
routes; fixed three-step pricing shape; generic fragment/action shapes; multihop chain strictness;
retained rows without `routeBinding`; and the retained `ekubo-family/test/contract.ts` fixtures still
construct the legacy candidate shape (test-side adaptation required).

## Validation

See [`../ekubo-20261104.md`](../ekubo-20261104.md): in-memory parity harness (identity/routes/exact/
pricing/execution/retained path) PASS; rendered entry `tsc`/`build:live`/loader PASS;
`test:family-json` 652/651/0/1; handwritten contract 18/18 on the restored tree. No generator, RPC/VM,
live, signing or broadcast.
