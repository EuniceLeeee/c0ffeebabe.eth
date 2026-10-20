# SQL Ready input and checkpoint proof reuse — 2026-10-20

This change replaces repeated local RPC archive input verification with the user-requested SQL discovery input. It does not replace production strict admission or execution checks. The existing completed Ready and interrupted checkpoint remain unchanged.

## Scope and evidence

- Authoritative checkout: `/opt/mev-cloud/family-runtime-20261007`, existing branch `codex/family-runtime-actual-20261007`; unrelated dirty changes retained.
- Discovery interval: blocks 26187988–26202387 inclusive (14,400), cutoff hash `0xa1039f363d8d34e4941dd912bb1caeb8d602f951e1dc4ba0ebee7a592406b134`.
- Current production discovery roots: 49. Runtime activation remains the existing 41-family configuration, including StakedUSDat and ordinary ERC4626, with Mooniswap disabled.
- SQL job `mev_family_14400_sql_729b1fcbe50b061b227641c6` completed successfully: 35,476,330,524 bytes processed, 37.466 seconds; 61,073 result rows across 13 pages, all page hashes and row counts verified.
- SQL SHA256 `7f0b79649c7a334c8c8e13431feae6291a199b639426952096ceb331e3684d79`; kernel SHA256 `a6d36988685f0514e0a7f559822c2b53e206c779f5e4c50b3b0c7200e8292010`.
- Independent real-input preflight: all rows validated; active rows 58,970, disabled rows 2,103. Current production decoder/key/fingerprint checks passed for 42,902 active candidate rows and 16,068 opaque rows; production deduplication produced 35,017 candidates and 13,160 opaque identities. A separate process-local all-49 check passed without changing runtime configuration. Both checks attempted zero RPC requests.

## Implementation

`inheritRebuildProofsFrom` initializes an empty destination with validated reusable memos and durable retries from the source base plus journal. It does not inherit a Ready publication, coverage, in-progress run or old outcomes. The normal production runner still checks candidate, definition and canonical-source bindings. Existing targets and same-path inheritance are rejected; source files are not written.

The SQL importer binds the exact plan cutoff, verifies block bounds and page hashes, uses current production decoding and deduplication, respects explicit activation flags, and verifies the original parent/partial lineage. The parent snapshot is reduced to small identity metadata before loading the partial checkpoint. SQL discovery provenance remains separate from the production cutoff-block observation coverage. Default strict concurrency is one.

SQL successful-call ancestry filtering differs from the currently more inclusive RPC trace discovery. The result is a new, separately fingerprinted discovery input, not a claim of identical RPC archive coverage. Ranked discovery witnesses are not a full forensic transaction archive.

## Validation and limitations

- Existing production `npm run build:live`: PASS after the final API change.
- Importer offline regression suite: 28/28 PASS, including fixed cutoff and a changed canonical hash at the production boundary.
- Checkpoint focused and complete suites: PASS; independent focused execution and source review completed. The final test-only CanonicalSource annotation addresses two newly exposed type-inference diagnostics.
- Independent real-input preflight receipt SHA256: `547f7e542c4b190db9248f02701bb31bb1a3a993fac96c7503dbf12c6853268b`.
- The initial broad `npm run build` failed because rustc was absent from PATH. The existing Rust 1.96 toolchain was then located and native enumeration built successfully. Broad all-test TypeScript checking also exposed pre-existing family test errors; these are retained and are not represented as a passing full test build. The actual existing production build is `build:live`.
- An initial reviewer concern about repeated revision-zero initialization was withdrawn: `emptyEnvelope()` returns revision one. The explicit nonempty-target guard and immediate repeat regression strengthen the contract; no reproduced overwrite defect is claimed.
- The initial real-input preflight used a wrong public-config filename and failed before processing input; the corrected run and failure record are retained.

At this record, SQL input and local correctness are validated. Real proof inheritance, strict/Ready completion, and the authorized subsequent 250-block dry-run live are pending. No overall adaptation, Ready, opportunity-replay or timing acceptance is claimed. Live remains unsigned and non-broadcasting, with formal head counting only after successful price publication and startup drain.

Evidence is retained under `logs/family-implementation-20261015.0exjskqq/live250-staked-no-moon-20261020/sql-input-current-source/`; raw input, runtime logs and configuration secrets are not committed.

## First-start recovery

The first SQL worker exited before strict admission because the new output directory did not yet exist when writing `input-pin.json.tmp`. No checkpoint was created and original checkpoints were unchanged. The importer now creates its output directory before the first write. A real-entry-point missing-directory regression passes; the complete offline suite is 28/28 PASS and an independent focused run is 1/1 PASS. The original failure and freeze are retained; a separately frozen attempt will resume with concurrency one. This does not claim real strict or live completion.

Independent repair receipt SHA256: `8e5f2832520407c53b9d810f8c2907d6174b3fdf14975a430fe3d088897a3caa`.
