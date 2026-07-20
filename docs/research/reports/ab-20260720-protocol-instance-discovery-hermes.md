# Hermes A/B Canary `20260720-protocol-instance-discovery`

## Problem + Implementation Brief

- **problem_id:** protocol-instance-discovery
- **root cause / causal hypothesis:** Permissionless protocol instances cannot enter the route graph unless they are hand-listed. Projecting identity-attested, probe-verified instances from registered protocol adapters should admit valid instances without weakening identity, taxonomy, simulation, or EV safety gates.
- **semantic success criterion:** B reaches live readiness, retains the shared input universe, emits no discovery source failure, and adds only identity-attested/probe-verified protocol edges while A remains stable.
- **change_class:** capability
- **one-change scope:** Runtime protocol-instance discovery and graph projection derived from registered protocol adapters.
- **predeclared acceptance evidence:** Systemic cohort/coverage/output/fairness/resource comparison. The route-specific six-step diagnostic is not applicable to this scanner/graph change and is not a deployment gate.
- **lane mode:** dual (atomic block-scan + public-mempool backrun; MEV-Share off)
- **route sample:** n/a — this is a systemic graph-discovery experiment.
- **systemic cohort:** Shared A/B universe and discovery cutoff; positive cohort is identity-attested ERC4626 candidates exposed by graph tokens or landed Withdraw evidence; negative controls are non-ERC4626 graph tokens and candidates failing identity or probe. B must become ready within the trusted startup deadline, avoid discovery source errors, preserve hard safety posture, and leave A restart count unchanged.
- **not doing:** No credit, inventory, private flow, sandwich, JIT-LP, flash-adapter, harness, config, universe-input, or six-step gate changes.

## Implementation + Checks

- **generator / evaluator:** Registered `ProtocolConversionAdapter.discovery` capabilities; canonical identity attestation; adapter-owned probe; shared route graph and trusted A/B comparator.
- **diff scope:** 15 production TypeScript files under `listener/src/searcher`; no tests, fixtures, package metadata, analysis tooling, deployment scripts, or governance files.
- **build:** `listener npm run build`; `analysis npm run build`.
- **hypothesis-specific validation result:** listener and analysis builds pass; block-scan warm/refine/contract/scanner, submission coordinator, route-adapter, discovery, and A/B canary suites pass against the frozen production-only transplant.
- **base SHA / challenger SHA:** `27f499c3780db8390c291b4cbfe2160ffd46d6bb` / `dd55dc33fd1592da882a5d989d853247f5d68fac`.
- **pre-deploy findings closed before this freeze:** Earlier attempts exposed permanent-pruned discovery evidence, non-resumable full warm, serial same-block mids, and an undersized 11-second large-graph budget. The `11c714c` live B then proved the remaining soft-deadline defect: four ordinary passes reached `protocolMidDeadline=0` but held in-flight exact probes until `98.5–109.2s`, each ending `pass_budget_exceeded stage=refine` without `scannedPairs`. The frozen challenger retains 11 seconds for smaller graphs, gives graphs with at least 20k edges 30 seconds with an 8-second solve reserve, hard-bounds every exact-probe leg at the refinement deadline, rejects invalid budget values, and uses uncached latest-block reads to fail-close immediately before submission unless source height and canonical hash still match the pinned fork.

## Paired Live Evidence

- **window / warmup excluded:** Final B `dd55dc3` startup block `25572314` is excluded. Ordinary completed passes were observed at blocks `25572337`, `25572341`, `25572344`, `25572347`, `25572359`, `25572362`, and `25572365`.
- **discovery result:** At the shared cutoff `25571807`, final B reported `instances=222`, `would_admit=230`, and expanded protocol edges from `53` to `497` (`+444`). The resulting initial graph had `27544` edges.
- **A/B logs (redacted):** Six of seven ordinary passes emitted `scannedPairs=1294` in `30295–32297ms`, proving that the former refinement-wide `98.5–109.2s` wait was removed. Block `25572347` was a real intermittent solve overrun: `pass_budget_exceeded stage=solve` at `30823ms`, then `solve=110700ms` and `total=132702ms` before `scannedPairs=1294`. The lane recovered and the next three completed passes returned to `30295–32204ms`.
- **node slot state:** The trusted wrapper deployed exact code SHA `dd55dc33fd1592da882a5d989d853247f5d68fac`. A remained active at PID `1136234`, restart count `0`, exact SHA `27f499c3780db8390c291b4cbfe2160ffd46d6bb`; B remained active at PID `1150093`, restart count `0`. `six_step_acceptance_status=not_run`, so the optional six-step diagnostic did not gate deployment.
- **fairness evidence:** A/B config hash `56da09e0d0bdf9de7821f6411fff50d85f1b5822b1f9ec22e03c519d4f46d172`, universe hash `c2ce98ec4765ff266a4d9c02b1f4a6fba9f70ad88d2add82511cc100dfa7147d`, victim-feed hash `530b7fd87984d3e9d074119e7242fa339bde29478569a24fe4a16a3ff61568b9`, shared discovery cutoff `25571807`, and dual/public-only posture matched. Runtime graph delta was predeclared.
- **safety evidence:** Positive routes from the long pass reached the uncached final stale-state check and were recorded as `pipeline_dropped reason=blockscan_stale_state`; no submit/broadcast record was observed for that stale window.

## Agent Manual Analysis

- **author:** Codex
- **verdict:** partial pass; schema decision remains `needs_escalation`.
- **causal evidence:** Deployment and restart stability passed, and the hard per-leg refinement deadline fixed the repeatable refinement starvation: the final B produced seven ordinary `scannedPairs` completions, with six near the 30-second large-graph budget. The `25572347` completion nevertheless held the block-scan lane for `132702ms`, of which `110700ms` was solve wall time. A fresh non-author review classified this as P1: an intermittent in-flight solve overrun, not proof of a permanent/startup deployment stall and not acceptable as sustained 30-second liveness. The data does not yet distinguish residual abandoned-refinement contention from an independently expensive solve candidate.
- **why misleading raw metrics do/do not change the semantic verdict:** Later recovery does not erase the two-minute censored window, while one long pass also does not justify calling the deployment itself failed. No 120-block canonical paired comparator was run, so no performance-equivalence claim is made.

## Final Decision

- **verdict:** `needs_escalation`: B deployment/liveness startup check passed, but sustained block-scan liveness is only a partial pass because of the `132702ms` solve overrun; full paired A/B performance comparison remains unrun.
- **branch action:** retained.
- **merge/deploy/cleanup evidence:** B remains running at frozen code SHA `dd55dc3`; A was not redeployed or restarted. No merge or branch cleanup is authorized by this partial result.

```ab_experiment
{
  "schema_version": 3,
  "experiment_id": "20260720-protocol-instance-discovery",
  "problem_id": "protocol-instance-discovery",
  "branch": "ab/protocol-instance-discovery",
  "base_commit": "27f499c3780db8390c291b4cbfe2160ffd46d6bb",
  "challenger_commit": "dd55dc33fd1592da882a5d989d853247f5d68fac",
  "change_class": "capability",
  "hypothesis": "Identity-attested and probe-verified protocol instances derived from registered adapters enter the live graph without weakening safety or blocking startup.",
  "input_mode": "shared",
  "lane_mode": "dual",
  "infrastructure_shakedown": false,
  "expected_runtime_view_delta": true,
  "allowed_config_delta": [],
  "a": {
    "commit": "27f499c3780db8390c291b4cbfe2160ffd46d6bb",
    "config_hash": "56da09e0d0bdf9de7821f6411fff50d85f1b5822b1f9ec22e03c519d4f46d172",
    "universe_hash": "c2ce98ec4765ff266a4d9c02b1f4a6fba9f70ad88d2add82511cc100dfa7147d",
    "discovery_to_block": 25571807,
    "blockscan_view_hash": "ee1709bf5995665c6ec760166140943a2c86126de52b8f027d596b3e94e0558a",
    "blockscan_graph_hash": "9cd60b55961361eff9aec3423be1d4e79a4570bd5d999ea4b04bca29b594d9f2"
  },
  "b": {
    "commit": "dd55dc33fd1592da882a5d989d853247f5d68fac",
    "config_hash": "56da09e0d0bdf9de7821f6411fff50d85f1b5822b1f9ec22e03c519d4f46d172",
    "universe_hash": "c2ce98ec4765ff266a4d9c02b1f4a6fba9f70ad88d2add82511cc100dfa7147d",
    "discovery_to_block": 25571807,
    "blockscan_view_hash": "ee1709bf5995665c6ec760166140943a2c86126de52b8f027d596b3e94e0558a",
    "blockscan_graph_hash": "6a66fa0bbad6f151bc7c23c23fd29c35d14c5d5ba3253236370400578981094c"
  },
  "window": {
    "min_paired_blocks": 120,
    "warmup_blocks": 10,
    "measured_from_block": 25572337,
    "measured_to_block": 25572365
  },
  "fairness": {
    "same_block_window": false,
    "paired_blocks": 0,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "c2ce98ec4765ff266a4d9c02b1f4a6fba9f70ad88d2add82511cc100dfa7147d",
    "b_universe_hash_after": "c2ce98ec4765ff266a4d9c02b1f4a6fba9f70ad88d2add82511cc100dfa7147d",
    "a_blockscan_view_hash_after": "ee1709bf5995665c6ec760166140943a2c86126de52b8f027d596b3e94e0558a",
    "b_blockscan_view_hash_after": "ee1709bf5995665c6ec760166140943a2c86126de52b8f027d596b3e94e0558a",
    "a_blockscan_graph_hash_after": "9cd60b55961361eff9aec3423be1d4e79a4570bd5d999ea4b04bca29b594d9f2",
    "b_blockscan_graph_hash_after": "6a66fa0bbad6f151bc7c23c23fd29c35d14c5d5ba3253236370400578981094c"
  },
  "deterministic_gate": {
    "result": "pass",
    "evidence": "listener and analysis builds pass; protocol discovery/adapter and block-scan suites pass; a never-settling exact quote returns at the hard refinement deadline as unprobed fallback"
  },
  "production_evidence": {
    "searcher_behavior_change": true,
    "strategy_kind": "block-scan",
    "trigger_kind": "standing-state",
    "route_scope": "dex-permissionless-protocol",
    "position_conserving": true,
    "posture": {
      "victim_dependent": false,
      "keeper": false,
      "inventory": false,
      "private_path": false,
      "credit": false,
      "sandwich": false,
      "jit_lp": false
    }
  },
  "analysis": {
    "agent_manual_author": "Codex",
    "agent_manual_verdict": "inconclusive",
    "agent_manual_evidence": "Frozen dd55dc3 deployed without running the optional six-step diagnostic and completed seven ordinary scans. Six completed in 30.3-32.3 seconds, but block 25572347 held solve for 110.7 seconds and completed at 132.7 seconds, so deployment passed while sustained liveness remains partial.",
    "agent_manual_written_at": "2026-07-20T07:20:40Z",
    "script_exit_code": 1,
    "script_assessment": "inconclusive",
    "script_artifact": "pending",
    "reconciliation": "inconclusive",
    "adversarial_review": {
      "verdict": "inconclusive",
      "evidence": "Post-live review: P0=0/P1=1/P2=0. Deployment/restart stability and the refinement deadline passed, but block 25572347 proves an intermittent solve-stage liveness overrun: 110.7 seconds of solve wall time and 132.7 seconds total. Stale positive routes were rejected before submit.",
      "reviewer": "hard_refine_deadline_design"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": false,
  "evidence_bundle": "trusted wrapper state plus redacted mev-ab-b blockscan and pipeline_dropped summaries for blocks 25572337-25572365"
}
```

## Findings Ledger

| finding | owner | carry_to | status |
|---|---|---|---|
| Permanent pruned historical trace aborted the whole ERC4626 discovery source | Codex | challenger code freeze | closed by per-candidate permanent-prune skip |
| Full warm restarted from batch zero after every pass budget | Codex | main baseline | closed by `27f499c` hash-bound resumable warm |
| Initial active discovery may consume significant startup time at the production lookback | Codex | live B readiness observation | measured: startup completed in `288709ms`; not a deploy blocker |
| Serial external/protocol mid reads exhausted every ordinary 11-second block pass | Codex | challenger code freeze | closed live: ordinary passes reached refinement/solve with `protocolMidDeadline=0` |
| 20k-universe warm + mids + coarse scan consumed the entire 11-second ordinary pass before refinement/solve | Codex | challenger code freeze | partially closed live: six ordinary completions stayed near `30–32s`, but one solve overrun reached `132.7s` |
| Ethers cached `getBlock("latest")` could admit a stale source block inside the 250ms cache window | final_p1_adversarial | challenger code freeze | closed by raw uncached latest-block reads before final verification and immediately before submit |
| In-flight exact probes ignored the soft refinement cutoff and held four ordinary passes for `98.5–109.2s` | Codex | challenger code freeze | closed live by per-leg hard deadline and unprobed fallback; seven ordinary completions observed |
| In-flight solve work can outlive the 30-second pass budget and hold the block-scan lane | hard_refine_deadline_design | next challenger | open P1: block `25572347` used `110700ms` in solve and `132702ms` total before later recovery |
| Fixed-cutoff protocol discovery/graph output drifted across restarts (`226→223→222` instances; prior `27592` versus current `27544` graph edges) | Codex | discovery reproducibility follow-up | open: likely pruned-history evidence loss, but cause is not yet proven |
