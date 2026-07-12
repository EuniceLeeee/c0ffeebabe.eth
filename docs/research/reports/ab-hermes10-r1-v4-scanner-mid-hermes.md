# Hermes A/B Canary `hermes10-r1-v4-scanner-mid`

> Round 1 of the unattended ten-round production run. This is a narrow Uniswap v4 block-scan
> admission capability decision. It does not claim that a profitable v4 opportunity occurred in-window.

## Problem + Implementation Brief
- **problem_id:** blockscan-v4-venue-admission
- **root cause / causal hypothesis:** the champion scanner neither priced v4 venues nor distinguished
  v4 pools behind the singleton PoolManager target, so v4 rings could not become block-scan candidates.
- **semantic success criterion:** on the same frozen universe and state, v4 pools are distinct, priceable
  scanner venues and increase the scanner's admitted pair set; no correctness, fairness, or safety regression.
- **change_class:** capability
- **one-change scope:** v4 block-scan state warming, poolId identity, mid-price construction, and the matching
  blacklist identity needed for that admission path. The extra parent commit only parameterizes the replay
  harness.
- **deterministic gate + pinned sample:** block 25516125 on the same 6000-pool universe
  `833d189d...`: base v4 candidates 0 / scannedPairs 678 / skipped 398; challenger v4 candidates present
  (six v4-containing candidates in the focused replay) / scannedPairs 780 / skipped 90.
- **not doing:** no claim of positive EV, no bid change, no wallet/config expansion, no backrun admission
  change, and no Metronome oracle admission work.

## Implementation + Gate
- **generator / evaluator:** Codex generator; orchestrator diff/test/replay gate; pre-deploy non-author
  reviewer approved admission with profit explicitly unproven; Sagan performed the fresh decision review.
- **diff scope:** seven listener files, 401 insertions / 21 deletions. Production changes are confined to
  v4 scanner/cache/warming/identity; `blockscan-hunt.ts` is test-only parameterization.
- **build:** listener TypeScript; pool-updater; scanner 16/16; contract 5/5; Coffee v4 math 23/23;
  planner 15/15 plus fixtures 20/20 all pass.
- **replay/fork result:** deterministic admission flip passed on the same historical block and universe.
  Neither base nor challenger produced a positive quote, so profit remains unproven.
- **base SHA / challenger SHA:** base
  `61fb1282698fdf52456a75c1a1f0e12bc7dd07eb`; frozen challenger
  `3f4486656a80f1eaafde8aae3859ab0389d4c062`.

## Paired Live Evidence
- **window / warmup excluded:** continuous 60 minutes, blocks 25517781..25518086
  (2026-07-12 16:38:50Z..17:38:50Z). Startup was excluded before block 25517781. Canonical comparison
  additionally excluded 8 budget-censored, 80 catch-up, and 1 full-warm paired blocks, leaving exactly
  120 fair pairs.
- **A/B logs (redacted):** `ab-hermes10-r1-v4-scanner-mid-compare.json`; raw A/B logs remain node-local.
- **node slot state:** B paused through the trusted wrapper before judgment; A PID 566766 stayed unchanged;
  A/B restart deltas are zero.
- **fairness evidence:** normalized config, universe hash, discovery cutoff, runtime pool-view hash, and
  TokenEdge graph hash were equal and stable; CPU split A=0-3/B=4-7.
- **paired result:** scanner pairs p50 797→919 (+122, +15.31%); skipped venues raw paired average
  491.02→135.60. Both sides had quotePositive=0, final-sim=0, submit=0. Raw timing p50
  9002→10030 ms and p95 12538→11641 ms; latency is not the claimed win.

## External Production Calibration
- **window / tool artifact:** `ab-hermes10-r1-v4-scanner-mid-coffee-calibration.json`
- **classifier calibration:** `ab-hermes10-r1-v4-scanner-mid-classifier-calibration.json`, 15/15 pass.
- **coffeebabe + watchlist sweep:** one Coffee transaction,
  `0x579ae15d04312a984768fe5b4c9bc743be7f2702307a5f2b37fe8c4343521855`.
- **comparable filter:** canonical `atomic_loop`, position-conserving, edgeKinds
  `flash,swap,protocol`; realized $0.1563, gas $0.1293, net $0.0270, no unpriced deltas.
- **excluded:** no inventory, sandwich, keeper/liquidation, JIT-LP, or standing-credit samples in-window.
- **B vs comparable take:** all three canonical arb pools were in graph. The source-block scan completed,
  had 3/6 competitor-token overlap and no submission. The transaction is a same-block backrun, while
  production has `SEARCHER_ENABLE_BACKRUN=0` and `SEARCHER_ENABLE_MEMPOOL=0`.
- **next production blocker filed:** `flow-admission-backrun-disabled`. This is next-round evidence,
  not a reason to overclaim this v4 block-scan change.

## Agent Manual Analysis (write before reading script assessment)
- **author:** codex-orchestrator
- **verdict:** win
- **causal evidence:** before running the comparator, raw same-block logs showed the frozen challenger
  consistently scanned 919 pairs versus 797, while skipped venues fell by about 355. The same-state replay
  independently showed that v4 candidates changed from absent to present.
- **why misleading raw metrics do/do not change the semantic verdict:** neither the absence of an in-window
  +EV quote nor the mixed latency direction creates or cancels this narrow admission result. The verdict is
  based on the behavior flip; profit remains a separate unresolved gate.

## Canonical Script Reconciliation
- **command + real exit code:** `ab-canary-compare --metric summary.scannedPairs --direction higher
  --aggregate p50 --min-paired-blocks 120 --warmup-blocks 0`, exit 0.
- **artifact:** `ab-hermes10-r1-v4-scanner-mid-compare.json`
- **assessment:** supports
- **reconciliation:** agree

## Fresh Non-Author Adversarial Review
- **reviewer:** Sagan (`019f5777-faa4-7a00-bed1-19d10a39216f`)
- **verdict:** win
- **evidence:** no production-blocking finding; deterministic replay plus 120 fair paired blocks support
  the admission-only claim. Zero quote-positive/final-sim/submit correctly prevents a profit claim.
  Exact frozen challenger merge is justified; its additional parent is test-harness-only.

## Final Decision
- **verdict:** win
- **branch action:** pending_merge
- **merge/deploy/cleanup evidence:** trusted wrapper closed the paused experiment as `win`; exact
  challenger was merged with tested base/challenger parents at `ef561c6b6a352b553f769f67c6ce65be4f7390c1`. Guarded deploy and
  gate-authorized branch cleanup remain pending.
- **stronger-model handoff (if retained):** none; this branch has decisive evidence.

```ab_experiment
{
  "schema_version": 2,
  "experiment_id": "hermes10-r1-v4-scanner-mid",
  "problem_id": "blockscan-v4-venue-admission",
  "branch": "ab/round1-v4-scanner-mid",
  "base_commit": "61fb1282698fdf52456a75c1a1f0e12bc7dd07eb",
  "challenger_commit": "3f4486656a80f1eaafde8aae3859ab0389d4c062",
  "change_class": "capability",
  "hypothesis": "poolId-keyed v4 state and mid-price admission makes v4 venues distinct, priceable block-scan candidates on the same frozen runtime inputs",
  "input_mode": "shared",
  "expected_runtime_view_delta": false,
  "allowed_config_delta": [],
  "a": {
    "commit": "61fb1282698fdf52456a75c1a1f0e12bc7dd07eb",
    "config_hash": "15260b71f61ffdcd63254d32fcd3eacac57323fdf380fe2437db0c01eea6145e",
    "universe_hash": "833d189dd37a7872e29fa6a698560f7ec5dcb771cf97ca2067a968f83a22637f",
    "discovery_to_block": 25517354,
    "blockscan_view_hash": "687f8186de5590b7937ca0d59a7de5bcda59d7adf45745ffe2d959c8a7d64973",
    "blockscan_graph_hash": "68e848558f869924168ab5dae8e77038614b9d557fbf6f0ca12827e3d5042e46"
  },
  "b": {
    "commit": "3f4486656a80f1eaafde8aae3859ab0389d4c062",
    "config_hash": "15260b71f61ffdcd63254d32fcd3eacac57323fdf380fe2437db0c01eea6145e",
    "universe_hash": "833d189dd37a7872e29fa6a698560f7ec5dcb771cf97ca2067a968f83a22637f",
    "discovery_to_block": 25517354,
    "blockscan_view_hash": "687f8186de5590b7937ca0d59a7de5bcda59d7adf45745ffe2d959c8a7d64973",
    "blockscan_graph_hash": "68e848558f869924168ab5dae8e77038614b9d557fbf6f0ca12827e3d5042e46"
  },
  "window": { "min_paired_blocks": 120, "warmup_blocks": 0 },
  "fairness": {
    "same_block_window": true,
    "paired_blocks": 120,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "833d189dd37a7872e29fa6a698560f7ec5dcb771cf97ca2067a968f83a22637f",
    "b_universe_hash_after": "833d189dd37a7872e29fa6a698560f7ec5dcb771cf97ca2067a968f83a22637f",
    "a_blockscan_view_hash_after": "687f8186de5590b7937ca0d59a7de5bcda59d7adf45745ffe2d959c8a7d64973",
    "b_blockscan_view_hash_after": "687f8186de5590b7937ca0d59a7de5bcda59d7adf45745ffe2d959c8a7d64973",
    "a_blockscan_graph_hash_after": "68e848558f869924168ab5dae8e77038614b9d557fbf6f0ca12827e3d5042e46",
    "b_blockscan_graph_hash_after": "68e848558f869924168ab5dae8e77038614b9d557fbf6f0ca12827e3d5042e46"
  },
  "deterministic_gate": {
    "result": "pass",
    "evidence": "same block 25516125 and same 6000-pool universe: v4 candidates 0 to six v4-containing candidates; scannedPairs 678 to 780; skippedVenues 398 to 90; listener regression suites pass"
  },
  "mergeability": {
    "current_main_commit": "61fb1282698fdf52456a75c1a1f0e12bc7dd07eb",
    "tested_base_is_current": true,
    "evidence": "git fetch origin --prune immediately before decision; origin/main and node A both equal the tested base"
  },
  "analysis": {
    "agent_manual_author": "codex-orchestrator",
    "agent_manual_verdict": "win",
    "agent_manual_evidence": "written before script: raw paired blocks consistently show 797 to 919 scanned pairs and about 355 fewer skipped venues; deterministic replay independently flips v4 admission",
    "script_exit_code": 0,
    "script_assessment": "supports",
    "script_artifact": "ab-hermes10-r1-v4-scanner-mid-compare.json",
    "reconciliation": "agree",
    "adversarial_review": {
      "verdict": "win",
      "evidence": "fresh reviewer found no production blocker and approved the narrow admission claim while rejecting any profit overclaim",
      "reviewer": "Sagan"
    }
  },
  "final_verdict": "win",
  "merge_commit": "ef561c6b6a352b553f769f67c6ce65be4f7390c1",
  "branch_action": "pending_merge",
  "b_stopped": true,
  "evidence_bundle": "compare JSON; classifier calibration; same-window Coffee postmortem summary; Step-1 artifact; stable trusted-wrapper status; deterministic replay reports remain node-local"
}
```

```step1
run_id: hermes10-r1-v4-scanner-mid
window_blocks: 25517781..25518086
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671
artifact: docs/research/reports/step1-hermes10-r1-v4-scanner-mid.json
method: manual-onchain-trace
fable_manual: no
```

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| v4 scanner cannot price or distinguish pools | round 1 | round 1 | done |
| same-window Coffee atomic backrun was unseen because backrun/mempool admission is off | round 2 | round 2 | open |
| no positive v4 quote occurred in the measured window | future live windows | trend | open |

## 当前 Hermes 规范要求但本轮实际上没有做到的事项
- 没有在窗口内观察到任何正报价、final-sim 成功或提交，因此没有验证“v4 admission 会产生真实
  +EV”；本轮只验证到 admission capability。
- 唯一 Coffee 可比样本是同块 backrun，不是 prior-block standing block-scan 样本；本轮不能用它
  验证 block-scan 盈利。
- 生产 JSONL 没有写入本窗口的 block-scan 事件；标准 funnel 只能来自结构化 block-scan 文本摘要，
  不能提供逐候选 JSONL 因果链。

## Close Gates
```bash
cd analysis
npm run ab-canary-gate -- ../docs/research/reports/ab-hermes10-r1-v4-scanner-mid-hermes.md --phase decision
npm run ab-canary-gate -- ../docs/research/reports/ab-hermes10-r1-v4-scanner-mid-hermes.md --phase close
npm run hermes-gate -- ../docs/research/reports/ab-hermes10-r1-v4-scanner-mid-hermes.md
```
