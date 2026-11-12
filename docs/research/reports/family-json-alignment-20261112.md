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
