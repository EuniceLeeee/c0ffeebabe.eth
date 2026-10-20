# SQL Ready startup correction — 2026-10-20

Code commit: `b33d1039426d8d6e946b71828d93a8b0edb46c93`. Unrelated existing dirty changes remain in the cloud checkout; this is not a clean-main or all-Family performance result.

SQL input completed: 14,400 blocks (26187988–26202387), 61,073 rows. Strict concurrency 1; 43,158 candidates = 23,604 verified + 4,994 terminal rejected + 14,560 retryable, none unaccounted. Ready generation 1 is sealed at 26202387 with 48,467 Graph edges and admitted memos from 35 of 41 enabled Families (49 installed). Ready state/source coverage is the single cutoff block, not 14,400-block RPC coverage. StakedUSDat is enabled with 0 admitted instances; no live/execution coverage is claimed for it.

First live exited at 12:58:09 UTC before warmup or formal counting: `added=892 removed=0 changed=0`. The 892 inherited proof-only entries belong to disabled Families: Curve plain 484, Balancer V2 195, Curve underlying 61, Balancer V3 48, Few 39, Fluid DEX 30, Mooniswap 27, Yield Basis LT 8. The old preflight omitted the production publication guard and incorrectly reported startup-readiness. Its original file/hash and receipt, and the failed live logs, remain preserved.

The guard now accepts the full installed activation view. Only explicitly disabled unpublished proofs are excluded; enabled/unknown additions and published removal/replacement still reject. Both main guards and SQL fresh-completion/recovery paths share this check. The exported helper is used by the thin read-only verifier alongside root, current-definition/activation and canonical checks. No cache deletion, fabricated partitions, Graph expansion, rewritten Ready hash, or strict rerun. The previously uncommitted guard/tests were necessary dependencies included in the code commit; unrelated files were untouched.

Runtime tests PASS; SQL 31/31 PASS; independent review PASS. Initial build failed on branded FamilyId map typing; adding explicit string keys and synchronizing the source assertion fixed it. Final build:live and independent runtime rerun PASS. Failed build/invocation logs remain. Real checkpoint: legacy check reproduces added=892; current helper passes; re-enable, unknown, published removal and replacement negative cases reject. Checkpoint SHA-256 remains `36da3c211138c7ed0e12e2adb175b73b0cb65e52643e6322a63864066f374a90`.

Evidence directory: `logs/family-implementation-20261015.0exjskqq/live250-staked-no-moon-20261020/sql-input-current-source`.

- `startup-activation-real-checkpoint-verification.json`: SHA-256 `f0439a278613ff4351e292966195b1eee65d0fff21df73b4df7226bd34470bba`.
- `startup-activation-independent-type-followup-review.json`: SHA-256 `55a5085d7a6601138663409b90ec59a5e8a2067a79bbd000929b17237693ae56`.
- `startup-activation-production-build-r2.json`: final production build receipt.
- LearningCase `tooling-defect-ready-startup-admission-20261020` codified by the code commit above.
- Manual failure diagnosis reconciled via inventory query `redaction,live-window,production-events` and actual `analysis:redact-live-run` tool-run execution, exit 0. Manifest `startup-failure-tool-selection.json`, SHA-256 `2041e42176cdbcc7f863af58ba6ad5961a53119f6b56cb7361209f2686b8a11c`. Redacted output retains the identical fatal error. Initial index invocation without safe.directory failed and is retained; per-command configuration corrected it.

Next: separately logged 250-head dry-run live, same 41-Family parameters except commit and output paths. Count only after valid price publication and startup drain; steady median target 3,000 ms. Preserve failures and report effective head-to-publication/drain, sim amount-selection-to-drain, coverage, fresh/carried/failed and resource interference. No completion, performance pass or long-term P95 claimed yet. No signing, broadcast or deployment.
