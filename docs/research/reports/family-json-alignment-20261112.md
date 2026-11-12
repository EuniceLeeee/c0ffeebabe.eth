# Cloud Family JSON alignment and factual gate — 2026-11-12

Authority: `/opt/mev-cloud/family-runtime-20261007`, branch `codex/family-runtime-actual-20261007`. Source comparison: cloud `/opt/mev-cloud/work/json-all-20261107` at `fce11f0`, including its frozen dirty Curve-underlying cutover. This is an implementation and verification report; installation is not a claim that every historical variant is accepted.

## Integration

- Curve plain and Curve underlying now register through their declarative JSON definitions.
- Zero1 Curve adds a declarative implementation. Ammalgam adds a `bindings-v1` JSON production registration and retains its TypeScript semantics; it is not a full JSON-only conversion.
- PSM uses distinct, nonzero assets obtained on-chain. UniV2 includes the reverse-verified Solidly child/getAmountOut variant.
- Existing runtime coverage/pool-identity declarations and UniV2 nomination reads remain. Older source-side common files were not copied over these newer capabilities.
- The catalog contains 52 installed families and 39 generator-visible JSON root registrations (38 declarative-v2, one bindings-v1). Installation does not change the operator's frozen Ready18 activation set of 37 families.

## Factual testing

`listener/scripts/test-family.mjs` runs the common offline suite and registered transaction legs. Each accepted leg must bind its registered input and source, retain raw node simulation evidence, and pass independent decoding of actual debit/credit plus no-input and rollback controls. A successful subprocess or a Ready edge alone cannot pass the gate. Missing inputs and failed legs remain visible in the per-family report.

The registry contains 84 transaction files and 206 leg references across 59 families. The current installed set selects 198 legs, including six incomplete inputs. Historical definition snapshots preserve original hashes and provenance rather than rewriting an old proof to match current code.

Two verifier/backend defects were fixed during integration:

1. A completed `eth_simulateV1` revert can return its bytes in `error.data` while `returnData` is empty. Only status-zero, error-code-three receipts are normalized. Malformed bytes and conflicting nonempty fields fail. The trace witness comparison and nested-halt checks remain mandatory.
2. Funding-token evidence compares Ethereum addresses independent of case. Amount, token identity, ordering, duplicates and extra fields remain strict. The old Ammalgam false-failure report is preserved; it was not rewritten into a pass.

Independent non-author review confirmed both fixes and their negative boundaries. The current live/Ready strict backend default remains unchanged; the new factual run explicitly selects node `eth_simulateV1`. No local REVM or broadcast is used by these factual cases.

## Paused Ready update

Ready18 continues the existing fixed-source review based on generation 17. The CLI authenticates the paused input using its prior Family definitions and discovery receipts while retaining current candidate-file, source, executor/origin and force-policy bindings. Changed proof context or an unbound candidate file is rejected.

A discovery receipt match reuses the sealed candidate discovery; a definition-only update does not force another historical scan or reverse-binding pass. The same atomic reconciliation updates the review fingerprint and retains only compatible completed outcomes. A regression pauses twice and verifies that completed unchanged work, then newly completed changed work, is not repeated.

## Validation and limits

- Production build and generated capability check passed. The unified offline suite ran 874 tests: 873 passed, one skipped, no failures. The later Ready-only fix passed 53 focused tests and reran the installed-Family offline suite.
- Full node factual run: 198 legs, **98 pass / 94 failed / six incomplete**; source fingerprint stayed stable. At registered-input scope, 16 families passed all their listed legs, 34 had failures, and two were incomplete. This is not full adaptation acceptance.
- PSM: all ten registered legs passed. Ammalgam and the registered UniV2 leg passed. The new Solidly variant has no dedicated passing factual case in this run. Curve plain, Curve underlying and Zero1 remained unverified after admission failures.
- One shared failure class was investigated directly: PrecisionPool at block 26129175 failed all twelve controls during node input funding (`unsupported balance layout`), before exchange execution. Do not attribute that result to failed protocol swaps. Other unresolved failures are retained, not relabeled as correct state-dependent rejection.
- Factual simulations pin N state and explicitly use a virtual N+1 execution environment for both quote reads and execution. They do not reproduce the original transaction's complete historical prefix.
- Family/framework tree: `047378b349df36777ac91cb1cac84459668d56b4`. Subsequent Ready-only no-rescan correction: `38dc6f1585569ddd0c0d3b26441e84b0526c4118`. The earlier raw reports are preserved unchanged; no proof hash was overwritten after the correction.
- The machine-readable summary is `docs/research/reports/family-json-facts-20261112.json`.

The full factual artifacts are under `logs/jsonall-alignment-20261112/all-facts/`; earlier failures and control runs remain alongside them. Raw logs and receipts are not committed. Ready18's original checkpoint, journal, source range and historical generation 17 are preserved. No live process or deployment was started by this integration.

## Historical executor context follow-up

Code: `bbe345c8843d0226999f8aad4beafd915765085e`.

Ready18's source block 26222895 predates the current executor deployment. At that block the executor address has no code. An explicit `update --test-executor-runtime HASH` option now provisions the operator-selected, hash-checked runtime for historical identity tests. It is independent of `--revalidate-proofs`: retryable-only updates can preserve earlier verified and terminal results. Ordinary updates remain unchanged.

The transport authenticates the executor address and runtime hash and includes that counterfactual context in result provenance, including prefixed calls. Genuine top-level calls do not receive an executor code override. A missing or mismatched receipt marker fails. Discovery reuse excludes only this executor provisioning context; it still binds the simulation method, source, candidate scope and discovery definitions. A pending run cannot silently change its proof context.

A same-state PSM control at source 26222895 / `0x3963feb050e7486f66e2c09595f12dc42206a78b51b2c287caaa1a3e99ceb59c` used candidate `0xf6e72db5454dd049d0788e411b06cfaf16853042`. Without the executor code, identity was retryable; with the explicit runtime it verified. The later nomination transaction is only candidate provenance, not the proof source. The chosen runtime hash is `0xaa678ef6a03701bac0255d4fd9d0ce93f680752776f97dac4ee4415550e1c57b`, matching the current deployed executor. Four actual node simulation receipts retain the same state attestation and the explicit counterfactual code marker. This proves the identity-environment correction, not full original-transaction replay or all-family execution acceptance.

The actual production maintenance CLI also reproduced the flip in an isolated one-candidate checkpoint: generation 1 had one retryable; the retryable-only update produced generation 2 with one verified instance. It restored sealed discovery, inherited the existing archive, and made no changes to the main Ready18 store. See `psm-cli-provision/result.json`, `psm-context-comparison.json` and `psm-context-receipts.json` under the artifact directory above. Independent non-author review checked the implementation and actual receipt bindings.

Validation: 342 focused tests passed. The final installed-JSON offline suite ran 876 tests: 875 passed, one skipped, no failures. The first full run exposed an old NodeStrict test double that omitted the newly required receipt marker; that failed result remains preserved, and the double now derives its marker from the supplied trusted context. Production build and generated catalog check passed against an unchanged source snapshot; the catalog hashes did not change. These are framework checks, not a replacement for the earlier per-family factual failures.

Canonical reconciliation used capability query `family,json,verification`, selected `listener:test:family-json`, manifest `logs/jsonall-alignment-20261112/executor-context-tool-manifest.json`, SHA-256 `9f6a108669ce51cde4ba9d2c1df52078270444009be1fe9df584c6b63f87b60a`. The final recorded execution passed. The original Ready18 process continues under its original loaded code; explicit historical-context retry supplementation is a subsequent normal update after it finishes.

The ignored production BotVM artifact was restored from the preceding launch release and its owner-bound runtime checked against the current deployment. The counterfactual artifact used for the earlier factual suite is preserved separately; those earlier reports keep their original source/artifact identity.

## Ready interruption and scheduled validation

At 2026-11-12 15:11:58 UTC, the resumed Ready process stopped after persisting 37,601 of 129,762 candidate outcomes. The node returned HTTP 429 with `Monthly capacity limit exceeded`; an independent lightweight request confirmed the same provider response without a Retry-After value. This is an allocation blocker, not an unclassified contract revert. The failed attempt status and logs are preserved; no repeated restart was attempted while the allocation remained unavailable.

The checkpoint and journal remain the continuation source. The historical-executor retry-only update has not started. Final Ready publication, launch freeze and network preflight remain pending. A one-time validation task is scheduled for 2026-11-13 07:30 Asia/Shanghai. Its plan requires completed updated Ready before starting the requested 500-block dry-run, preserves the previous public parameters and manual activation scope, and selects logs-driven activity with background trace observation. It must report an unmet prerequisite rather than launch an old or incomplete Ready. No dry-run, signing, broadcast or deployment occurred in this follow-up.
