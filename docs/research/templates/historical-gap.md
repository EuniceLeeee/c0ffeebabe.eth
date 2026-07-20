# Historical Gap `<gap_id>`

## Manual Classification

- Transactions and causal source:
- Conservation and net +EV evidence:
- Included DEX / permissionless-protocol legs:
- Excluded postures checked:

## Indexed Tool Reconciliation

- Capability query / manifest / SHA-256:
- Successful tool receipts:
- Manual vs tool result:
- Tooling defect and codify commit, if any:

## Prior Branch Audit

- Ref inventory command / SHA-256:
- Existing branch/worktree/report diffs inspected:
- Reused or rejected prior fix:

## Implementation

- One root cause:
- Diff:
- Replay transitions by sample:
- Short smoke:
- Fresh review:

```historical_gap
{
  "schema_version": 1,
  "gap_id": "<stable-gap-id>",
  "branch": "ab/<gap-id>",
  "author": "<implementing-agent>",
  "base_commit": "<40-char-origin-main-sha>",
  "challenger_commit": "<40-char-frozen-sha>",
  "hypothesis": "<same profitable samples advance one production stage>",
  "components": ["detector"],
  "branch_audit": {
    "origin_main_commit": "<40-char-origin-main-sha>",
    "refs_sha256": "<historical-gap-gate ref inventory sha256>",
    "prepare_receipt_sha256": "<historical-gap-gate trusted prepare receipt sha256>",
    "matches": [
      {
        "ref": "<exact ref from --print-ref-inventory>",
        "kind": "git-ref",
        "fingerprint": "<64-char inventory fingerprint>",
        "disposition": "unrelated",
        "evidence": "<diff/report/replay inspected>"
      }
    ],
    "outcome": "no_prior_fix",
    "evidence": "<actual branch/report/diff/replay audit>"
  },
  "samples": [
    {
      "tx_hash": "<full-winner-tx-hash>",
      "block_number": 0,
      "expected_net_profit_usd": 0.01,
      "strategy_kind": "block-scan",
      "trigger_kind": "standing-state",
      "route_scope": "dex-dex",
      "position_conserving": true,
      "evidence": "<canonical classification and PnL evidence>",
      "candidate_report": "docs/research/reports/<sample-candidate>.md",
      "posture": {
        "keeper": false,
        "inventory": false,
        "private_path": false,
        "credit": false,
        "sandwich": false,
        "jit_lp": false
      }
    }
  ],
  "validation": {
    "build": { "exit_code": 0, "evidence": "<commands/results>" },
    "tests": { "exit_code": 0, "evidence": "<commands/results>" },
    "toolchain_sha256": "<historical_gap_trusted_toolchain_sha256 reviewed with this diff>",
    "review": {
      "reviewer": "<fresh-non-author>",
      "verdict": "pass",
      "live_distribution_verdict": "none",
      "base_commit": "<40-char-origin-main-sha>",
      "challenger_commit": "<40-char-frozen-sha>",
      "diff_sha256": "<sha256-of-exact-git-diff-base-challenger>",
      "artifact": "docs/research/reports/<gap-id>-review.json",
      "artifact_sha256": "<sha256-of-review-json>",
      "reviewed_at": "<ISO-8601>",
      "evidence": "<independent review>"
    },
    "replay_environment": {
      "universe_sha256": "<sha256-of-production-pool-universe-snapshot>",
      "universe_provenance_artifact": "docs/research/reports/<gap-id>-universe.json",
      "universe_provenance_sha256": "<sha256-of-provenance-json>",
      "pool_universe_top_n": "<integer read from active champion>"
    },
    "smoke": {
      "mode": "trusted-local-dry-run",
      "duration_seconds": 600
    }
  },
  "decision": {
    "status": "promote",
    "claim": "fixed",
    "branch_action": "pending_merge",
    "evidence": "<replay and smoke evidence>"
  }
}
```

The fresh reviewer writes a separate JSON artifact committed at the report-only artifact ref. It binds
`schema_version=1`, reviewer, reviewed_at, base/challenger/diff SHA, verdict,
`live_distribution_verdict`, `branch_audit_sha256`, `toolchain_sha256`, and evidence. The universe provenance JSON binds
`schema_version=1`, `kind=production-pool-universe`, the fixed production `instance_id`, active champion
`runtime_commit`, content-addressed
`source_path=/opt/MEV-runtime/universe/active-pools-<sha256>.json`, the same universe SHA-256, production
top-N, and capture time. The gate independently checks those fields through SSM before and after replay/smoke.
Both artifacts must later be archived byte-identically on main.

Every schema-v3 candidate report referenced by the single-route historical-replay track must declare
`production_evidence.sample.expected_route` for both block-scan and backrun sources. Systemic scanner/graph/
universe work uses the cohort/Hermes path and does not fabricate these per-sample reports. The route is one
ordered closed array whose edges contain `adapterId`,
`slotKind=swap|protocol`, `target`, `tokenIn`, `tokenOut`, and `poolId` when the adapter has a distinct pool
identity. The route must match canonical receipt swap order/direction, one interleaved successful call-trace
sequence for every declared DEX/protocol adapter target and selector, and the trusted replay route exactly.

For backrun, set `strategy_kind=backrun`, set `trigger_kind=victim-swap|oracle-update`, and add the exact
`victim_tx_hash`. For analysis-only work use a non-`ab/*` branch, components from
`analysis-tool|classifier|gate`, an empty sample list, and omit `branch_audit`, `replay_environment`, and
smoke. For admission/latency/ranking use
`decision={status:route_to_hermes,claim:implemented_not_validated,branch_action:retained,...}`.
Copy every entry emitted by `--print-ref-inventory` into `branch_audit.matches`, then add its disposition and
specific inspection evidence. The gate rejects omitted, extra, stale, or same-gap-as-unrelated entries.
When `disposition=reusable`, also add `reused_commit`: the concrete prior SHA that is reachable from that
inventoried ref and included in challenger history.

After promote, copy the printed authenticated promotion receipt digest and artifact commit into the final close report as
`decision.promotion_receipt_sha256` and `decision.promotion_artifact_commit`. Close also requires every
candidate report, tool execution manifest, review artifact, and universe provenance artifact on main.
