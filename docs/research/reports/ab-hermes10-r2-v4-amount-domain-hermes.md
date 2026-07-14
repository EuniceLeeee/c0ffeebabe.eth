# Hermes A/B Canary `hermes10-r2-v4-amount-domain`

> Operator closure (2026-07-14): deleted unmerged. The branch proved a
> structural candidate-slot transition but did not advance a reproducible
> positive-EV sample, produced no quote/final-sim/submit delta, and retained
> unresolved hot-path latency risk. Under the current production gate this is
> not an eligible challenger; another live window would only measure an
> unqualified optimization hypothesis.

> Round 2 of the unattended ten-round production run. The strategy challenger is retained for escalation;
> the analysis-tool defect discovered during the round is independently fixed on main.

## Problem + Implementation Brief
- **problem_id:** blockscan-v4-amount-domain-candidate-admission
- **root cause / causal hypothesis:** a V3 prefix could jump from zero output to an amount beyond the v4
  BalanceDelta int128 domain. The impossible V3-to-v4 ring then occupied one of eight solver slots and
  repeatedly failed exact-amount quoting.
- **semantic success criterion:** reject the structurally impossible route before the final candidate cap,
  preserve valid bounded v4 routes, and promote the next reserve-ranked ring without increasing production
  deadline loss enough to erase the capability gain.
- **change_class:** capability
- **one-change scope:** state-scoped v4 prefix amount-domain validation and reserve-candidate promotion.
- **deterministic gate + pinned sample:** block 25518331: rank-1 XOR route changes from admitted plus exact
  amount overflow to domain-rejected before top-8, solverEntered=0, with the prior rank-2 route promoted.
- **not doing:** no clamping, no profit claim, no bid/config/universe change, and no merge on deterministic
  evidence alone.

## Implementation + Gate
- **generator / evaluator:** Codex generator; orchestrator build/test/replay; two fresh non-author reviews.
- **diff scope:** retained branch `ab/round2-v4-amount-domain`, frozen challenger
  `88907581b54f32aad62851d847243ab81006108d`.
- **build:** listener TypeScript, v4-domain 5/5, scanner 16/16, and reviewer promotion/control gates pass.
- **replay/fork result:** deterministic transition passed at the pinned state; the replay executes the
  challenger guard and control but relies on the separately captured baseline artifact for the base failure.
- **base SHA / challenger SHA:** `4ee5a62f8a1ee8dfaa8daadadccb45f0cbc7f513` /
  `88907581b54f32aad62851d847243ab81006108d`.

## Paired Live Evidence
- **window / warmup excluded:** continuous measured window blocks 25518588..25518887, 3600 seconds after
  warmup. A/B had zero restarts. Canonical comparison later retained 117 fair pairs after excluding 37
  budget-censored, 81 unequal-cache catch-up, and 2 full-warm blocks; required minimum is 120.
- **A/B logs (redacted):** `ab-hermes10-r2-v4-amount-domain-compare.json`; raw logs remain node-local.
- **node slot state:** B paused and then closed through the trusted wrapper as `needs_escalation`; A remained
  active with PID 576515 unchanged.
- **fairness evidence:** same config/universe/runtime view/TokenEdge graph, same block stream, A CPUs 0-3 and
  B CPUs 4-7, no restarts, no champion restart. Budget/catch-up censored blocks are excluded.
- **semantic delta:** A entered the XOR route and recorded 224 amount overflows; B recorded zero overflows,
  rejected the route before the final cap, and promoted a reserve ring in every manually valid pair.
- **cost delta:** the initial manual parse saw total p50 9972 to 11012 ms and solve p50 3433 to 4465 ms,
  but it did not exclude unequal-cache catch-up blocks. It cannot establish a production loss; canonical
  fair-pair count is insufficient to establish a win.
- **profit funnel:** both sides had zero positive quotes, final-sim successes, and submits.

## External Production Calibration
- **window / tool artifact:** `ab-hermes10-r2-v4-amount-domain-coffee-calibration.json`.
- **classifier calibration:** 16/16 pass after the same-round tooling fix.
- **coffeebabe sweep:** five successful watch-matched activities; three executable reward-harvest calls and
  two empty/unknown activities.
- **comparable filter:** no position-conserving `atomic_loop` occurred in-window.
- **excluded:** three `keeper_claim`; one empty self-transfer; one unpriced unknown retained for manual review.
- **B vs comparable takes:** not applicable because no comparable sample occurred.
- **next production blocker filed:** `none:no_comparable_sample`.
- **tooling defect found and closed:** the three keeper calls were initially `unknown` and falsely reported
  as routing gaps. `tooldef-20260712-coffee-keeper-unknown-routing` was codified by
  `6fc2017349924b5a69bb209a8101dbf8f5c0e1d4`; node production-CLI replay changed all three to
  `keeper_claim / non_comparable`, while unknown empty activity remained `manual_required`.
- **gate defect found and closed:** the full-sweep gate could not honestly represent non-comparable no-pool
  transactions and counted excluded venues in the coverage KPI. `tooldef-20260712-hermes-noncomparable-full-sweep`
  was codified by `b440609138ce6f04480e772507eec54e2374b0d4`; explicit `comparable:false` records now preserve
  full-sweep completeness without entering comparable coverage.

## Agent Manual Analysis
- **author:** codex-orchestrator
- **verdict:** lose
- **causal evidence:** written before the canonical comparator: the capability flip was present in all 172
  manually budget-valid pairs, but the raw parse also showed higher total/solve p50 and more deadline-bearing
  blocks, with no positive quote on either side.
- **why misleading raw metrics do not decide:** the raw parse failed the equal-cache fairness requirement,
  so its latency direction is evidence of risk, not merge or reject authority.

## Canonical Script Reconciliation
- **command + real exit code:** `ab-canary-compare --metric total_ms --direction lower --aggregate p50
  --min-paired-blocks 120 --warmup-blocks 0`, exit 0.
- **artifact:** `ab-hermes10-r2-v4-amount-domain-compare.json`.
- **assessment:** inconclusive; 117 fair pairs after exclusions, below the required 120.
- **reconciliation:** manual lose versus script inconclusive.

## Fresh Non-Author Adversarial Review
- **A/B reviewer:** `019f5807-aa00-7e71-988d-dd7315f6a16b`.
- **verdict:** inconclusive.
- **evidence:** deterministic slot recovery cannot establish a win while hot-path cost remains unresolved;
  the manual parse cannot establish a loss because it retained unequal-cache catch-up blocks.
- **tooling reviewer:** `019f5820-8495-7ec1-8788-af56ce1bf00a`; final PASS after it required the
  `atomic_loop` gate to move ahead of every watcher/auto-close invocation.
- **gate-schema reviewer:** `019f5833-20b9-70f2-90c4-b68e17c9fdc0`; AGREE that the old schema forced
  fabricated class/pool evidence and that the literal `comparable:false` exception is the bounded fix.

## Final Decision
- **verdict:** needs_escalation
- **branch action:** retained
- **merge/deploy/cleanup evidence:** trusted wrapper closed B as `needs_escalation`; no challenger code was
  merged and the literal branch remains at the frozen SHA. The separate analysis-tool fix was merged to main
  at `fff2357e57dbc543b72b4697842749d87aec293d` after tests, reviewer PASS, and node replay; the full-sweep
  gate fix is `b440609138ce6f04480e772507eec54e2374b0d4`.
- **stronger-model handoff:** rerun `npm run searcher:replay-v4-domain`, retain the captured base failure,
  then repeat a full A/B until at least 120 fair pairs remain after budget/catch-up exclusion. Resolve whether
  candidate-slot recovery can be implemented without the observed hot-path deadline cost.

```ab_experiment
{
  "schema_version": 2,
  "experiment_id": "hermes10-r2-v4-amount-domain",
  "problem_id": "blockscan-v4-amount-domain-candidate-admission",
  "branch": "ab/round2-v4-amount-domain",
  "base_commit": "4ee5a62f8a1ee8dfaa8daadadccb45f0cbc7f513",
  "challenger_commit": "88907581b54f32aad62851d847243ab81006108d",
  "change_class": "capability",
  "hypothesis": "state-scoped v4 amount-domain validation removes a structurally impossible top-8 route and promotes the next reserve candidate without unacceptable hot-path cost",
  "input_mode": "shared",
  "expected_runtime_view_delta": false,
  "allowed_config_delta": [],
  "a": {
    "commit": "4ee5a62f8a1ee8dfaa8daadadccb45f0cbc7f513",
    "config_hash": "e1414e4bcafc17f39294084c12d0ff4ee035826087fa6e4e3020ef5e0cdf708a",
    "universe_hash": "f8ac4c7f3d2bb5f7f2a4d0c7bd55891b82187cb9c5db9cf8c6c271bfa6b9e31d",
    "discovery_to_block": 25518310,
    "blockscan_view_hash": "3b67c9a238373870863dd90be408c67eea8caca289bf42fea720e8bee81cac81",
    "blockscan_graph_hash": "1b68966753b24144ad7fd088288010d6969130fa384360bd03337894dba1ac86"
  },
  "b": {
    "commit": "88907581b54f32aad62851d847243ab81006108d",
    "config_hash": "e1414e4bcafc17f39294084c12d0ff4ee035826087fa6e4e3020ef5e0cdf708a",
    "universe_hash": "f8ac4c7f3d2bb5f7f2a4d0c7bd55891b82187cb9c5db9cf8c6c271bfa6b9e31d",
    "discovery_to_block": 25518310,
    "blockscan_view_hash": "3b67c9a238373870863dd90be408c67eea8caca289bf42fea720e8bee81cac81",
    "blockscan_graph_hash": "1b68966753b24144ad7fd088288010d6969130fa384360bd03337894dba1ac86"
  },
  "window": { "min_paired_blocks": 120, "warmup_blocks": 0 },
  "fairness": {
    "same_block_window": true,
    "paired_blocks": 117,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "f8ac4c7f3d2bb5f7f2a4d0c7bd55891b82187cb9c5db9cf8c6c271bfa6b9e31d",
    "b_universe_hash_after": "f8ac4c7f3d2bb5f7f2a4d0c7bd55891b82187cb9c5db9cf8c6c271bfa6b9e31d",
    "a_blockscan_view_hash_after": "3b67c9a238373870863dd90be408c67eea8caca289bf42fea720e8bee81cac81",
    "b_blockscan_view_hash_after": "3b67c9a238373870863dd90be408c67eea8caca289bf42fea720e8bee81cac81",
    "a_blockscan_graph_hash_after": "1b68966753b24144ad7fd088288010d6969130fa384360bd03337894dba1ac86",
    "b_blockscan_graph_hash_after": "1b68966753b24144ad7fd088288010d6969130fa384360bd03337894dba1ac86"
  },
  "deterministic_gate": {
    "result": "pass",
    "evidence": "block 25518331 changed from an admitted XOR v4 route with exact-amount overflow to rejection before top8 with solverEntered zero and the reserve-ranked route promoted; controls pass"
  },
  "mergeability": {
    "current_main_commit": "4ee5a62f8a1ee8dfaa8daadadccb45f0cbc7f513",
    "tested_base_is_current": true,
    "evidence": "origin/main and champion A matched the tested base at the A/B decision point"
  },
  "analysis": {
    "agent_manual_author": "codex-orchestrator",
    "agent_manual_verdict": "lose",
    "agent_manual_evidence": "written before canonical compare: semantic flip in 172 manually budget-valid pairs, but raw total/solve p50 and deadline-bearing blocks worsened with no positive quote",
    "script_exit_code": 0,
    "script_assessment": "inconclusive",
    "script_artifact": "ab-hermes10-r2-v4-amount-domain-compare.json",
    "reconciliation": "inconclusive",
    "adversarial_review": {
      "verdict": "inconclusive",
      "evidence": "semantic candidate-slot recovery is proven, but canonical fair sample is below 120 and manual latency evidence retained unequal-cache catch-up blocks",
      "reviewer": "019f5807-aa00-7e71-988d-dd7315f6a16b"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": true,
  "evidence_bundle": "redacted compare summary; Step-1 artifact; Coffee calibration; classifier calibration; pinned replay and raw A/B logs remain node-local"
}
```

```step1
run_id: hermes10-r2-v4-amount-domain
window_blocks: 25518588..25518887
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671
artifact: docs/research/reports/step1-hermes10-r2-v4-amount-domain.json
method: manual-onchain-trace
fable_manual: yes
```

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| v4 amount-domain guard recovers a solver slot but live latency cost is unresolved | stronger model | retained branch | open |
| Coffee reward-harvest was unknown and falsely emitted routing gaps | round 2 | main `fff2357` | done |
| Hermes full-sweep gate could not represent excluded no-pool activity | round 2 | main `b440609` | done |
| no comparable Coffee atomic loop occurred in the measured window | future rounds | trend | open |

## Method Trace
```text
task_class: implementation
tools_used: raw A/B block-scan logs, ab-canary-compare, local reth call trace, census-gap, bundle-postmortem, competitor-calibration, replay-v4-domain
evidence_order: manual A/B causal parse before comparator; manual Coffee trace before census; canonical reconciliation; fresh non-author review; node production-CLI replay
analysis_frame: separate deterministic capability evidence from fair live performance evidence, and exclude non-position-conserving competitor activity before gap attribution
sanity_checks: same config and universe hashes; zero restarts; exact 60-minute window; catch-up and budget blocks excluded; real calldata fixture; atomic-loop controls preserved
tool_gap: tooldef-20260712-coffee-keeper-unknown-routing and tooldef-20260712-hermes-noncomparable-full-sweep - keeper rewards reached routing auto-close and the full-sweep gate forced false class/pool evidence
codify_next: tooldef-20260712-coffee-keeper-unknown-routing codified by 6fc2017349924b5a69bb209a8101dbf8f5c0e1d4; tooldef-20260712-hermes-noncomparable-full-sweep codified by b440609138ce6f04480e772507eec54e2374b0d4
distill_for_opus: competitor venue gaps may mutate production registries only after winner_style is positively proven atomic_loop; unknown is manual-required, never conservatively auto-closed
```

## Close Gates
```bash
cd analysis
npm run ab-canary-gate -- ../docs/research/reports/ab-hermes10-r2-v4-amount-domain-hermes.md --phase decision
npm run ab-canary-gate -- ../docs/research/reports/ab-hermes10-r2-v4-amount-domain-hermes.md --phase close
npm run hermes-gate -- ../docs/research/reports/ab-hermes10-r2-v4-amount-domain-hermes.md
```
