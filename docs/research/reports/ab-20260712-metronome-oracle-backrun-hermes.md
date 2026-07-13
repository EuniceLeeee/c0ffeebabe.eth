# Hermes A/B Canary `20260712-metronome-oracle-backrun`

> Archive note (2026-07-13): this report and its redacted JSON artifacts were copied to `main`
> before operator-requested branch cleanup. The original final decision below remains historical:
> the capability was a causal win on its tested base, but the branch was retained because main
> advanced and required a current-main retest before any merge.

> Predeclared from the exact deployed champion SHA before challenger code is applied. Raw logs, events,
> RPC URLs, keys, and calldata remain off Git.

## Problem + Implementation Brief
- **problem_id:** `block-25515277-metronome-oracle-backrun`
- **root cause / causal hypothesis:** Coffee's first conserving atomic loop in block 25515277 became +EV
  only after transaction index 0 forwarded a Chainlink transmit into the Metronome oracle. Champion A has
  neither the Metronome synth/hgUSDC execution edge nor a targeted oracle-triggered pinned route, so it
  correctly reported `quotePositive=0` for the pre-block state and could not construct the victim bundle.
- **semantic success criterion:** the production trigger classifier recognizes the pinned forward call;
  after replaying that transaction on block 25515276, the production route builder, planner, solver, and
  BotVM execute the conserving USDC cycle with positive gross profit. In paired live, B must retain A's
  block-scan health/fairness while loading the declared protocol-edge view delta.
- **change_class:** capability
- **one-change scope:** add Metronome synth quoting/execution, the authorized msUSD-to-hgUSDC exit, and one
  pinned `forwarder + oracle + transmit` backrun admission spec. No generic oracle framework.
- **deterministic gate + pinned sample:** block 25515277, trigger
  `0x63e4e781e802ec9c54a47d52a65e30bf43df694b77cbb6bdc8ab7fe303f6bb25`, winner prefix
  `0x4d1e4e51`; `searcher:blockscan-fork-solve-metronome` must execute +gross.
- **not doing:** inventory/one-leg transactions, Coffee's same-actor follow-on batch, hidden payment hub
  `0x00000000000014aa...`, generic Chainlink discovery, credit, or any A restart/config change.

## Block 25515277 Manual Triage
| tx prefix | manual class | independent replay target | disposition |
|---|---|---:|---|
| `0x4d1e4e51` | conserving atomic DEX + protocol loop | yes | reproduced and fixed by this challenger |
| `0x3eb1f2ff`, `0x8a736521`, `0x52509c4f`, `0x17b753ff`, `0x2f0f891d` | same-actor Metronome batch follow-ons | no | depend on earlier Coffee state changes; not separate capability samples |
| `0x19ca8ba1`, `0x3d85e385` | same-actor DEX batch follow-ons | no | source state already moved by earlier Coffee txs |
| `0x7961e81b` | atomic route through private/no-log payment hub | unresolved | permissionless execution not proven; excluded from this slice |
| `0xbae9e055`, `0xa7dd90df` | one-leg inventory | no | non-comparable posture |
| `0x749eefb0` | empty/unknown | no | no executable arb sample |

`0x17b753ff` is an atomic loop, not a sandwich. The causal trigger for the independent sample is block
transaction index 0 (`0x63e4e781...`), which forwards a Metronome oracle `transmit`; it emits no Swap log.

## Implementation + Gate
- **generator / evaluator:** Codex implementation; fresh non-author review required before a capability win.
- **diff scope:** Metronome synth quote/adapter, authorized hgUSDC exit, targeted oracle admission,
  committed route-venue pins, deterministic fork gate, and this report
- **build:** PASS (`npm run build`; taxonomy 5/5)
- **replay/fork result:** PASS on frozen challenger; production registry/classifier/route executes
  `netProfit=111748302` USDC base units at `flashAmount=122474539338`
- **non-author predeploy review:** APPROVE after the reviewer-required durable route-venue admission fix
- **base SHA / challenger SHA:** base `b29571c66bdb19eec979a3d6a064ac1a4bdc91f3`; challenger
  `ee8bf04fdf15711a3105adb67ca1b24038ad3c9b`

## Paired Live Evidence
- **window / exclusions:** started 2026-07-12T10:55:15Z; 157 complete pairs; excluded 6 budget,
  11 catch-up, 1 full-warm, then the first 10 warm pairs; measured 134 blocks
  `25516096..25516253`
- **A/B evidence:** raw logs retained only on the node at `/var/log/mev-live.log` and
  `/var/log/mev-ab-b.log`; independent redacted facts are in this report (manual SSM evidence
  `57630f3c-a320-41bd-a65a-22cfc71f3e83`; canonical frozen-window comparison
  `cb95f428-71df-48d7-9104-4410d639b057`)
- **semantic outputs:** `scannedPairs=810`, `candidates=8`, `quotePositive=0`, and `bestNet=null`
  matched on all 134 measured blocks; no positive solve, final-sim rejection, EV pass, or submit on either
  side. The declared view change was visible as A `protocolMids=45` versus B `protocolMids=50`.
- **latency:** A p50/p95 `7822.5/10797.45 ms`; B `7909.5/10543.8 ms`. The p50 delta is +87 ms
  (about 1.1%) and p95 improves by about 254 ms; this is not a material regression.
- **node slot state:** trusted wrapper reaped the expired pause lease and closed B as
  `crashed_needs_escalation`; B restarts=0 and the branch/evidence were retained
- **fairness evidence:** A PID `545905` unchanged, restart delta=0; config hash equal
  `2f27e8c1...`; universe hash equal `70e9464d...`; runtime view/graph delta was predeclared and both
  before/after hashes remained stable

## External Production Calibration
- **window / tool artifact:** same measured range `25516096..25516253` against B events/log/graph;
  redacted structured artifact `step1-20260712-metronome-oracle-backrun.json`, backed by node census
  `/tmp/census-gap-20260712-metronome-ab` (SSM `67613187-a527-4c4c-ba46-313dcc02a2c3`)
- **classifier calibration:** PASS 15/15 on current analysis SHA `6b6de58987a92b99237917991c26ab00968944da`
- **coffeebabe + watchlist sweep:** 52 matched watchlist txs; Coffee had two successful comparable takes
- **comparable filter:** conserving `atomic_loop` only
- **excluded:** inventory · sandwich · keeper/liquidation · JIT-LP · standing-credit
- **B vs comparable takes:** `0x43ea1135...` is a position-conserving pure-DEX loop with net `$0.2321`.
  Manual receipt/callTracer reconstruction gives the main cycle
  `USDT→WETH→WIN→ELMT→GIVE→RALLY→USDT` (four middle legs are v4), followed by profit conversion to
  WETH. All six cycle venues are in B's graph. B completed source block 25516125 with eight candidates but
  only WETH overlapped the competitor tokens and no full route was solved/submitted. `0x546483d6...` is
  another atomic DEX loop with net `$0.1629`, but its DODO venue `0x0a67ae79...` is out of graph and B
  skipped source block 25516152 as busy.
- **next production blocker filed:** `path/planner hop cap`: frozen B defaults to
  `SEARCHER_MAX_HOPS=3` and scanner `SEARCHER_BLOCKSCAN_MAX_HOPS=4`, while the all-in-graph
  `0x43ea...` cycle needs six swap hops. The DODO admission + busy case is runner-up.
- **Step-1 `ab_external_calibration`:** PASS; current classifier and manual raw trace agree that both Coffee
  transactions are conserving `atomic_loop`, not inventory or sandwich

## Agent Manual Analysis (write before reading script assessment)
- **author:** Codex, independent raw-log + receipt/callTracer analysis before canonical A/B comparison
- **verdict:** win
- **causal evidence:** the same previously failing Metronome trigger flips to a production-registry route and
  executes for `111748302` USDC base units gross on frozen B; 134 live paired blocks show the declared five
  protocol mids with identical scan/candidate/positive-output behavior and no material latency regression.
- **why misleading raw metrics do/do not change the semantic verdict:** the paired window did not repeat the
  pinned oracle update, so equal `quotePositive=0` is expected and cannot test the new admission directly.
  The capability claim is owned by the exact replay; live A/B supplies the no-regression half. Same-window
  Coffee evidence exposes a separate six-hop planner gap and does not invalidate this Metronome capability.

## Canonical Script Reconciliation
- **command + real exit code:** `ab-canary-compare --a-log <A-to-25516253> --b-log
  <B-to-25516253> --out /tmp/ab-metronome-compare.json --min-paired-blocks 120 --warmup-blocks 10`;
  exit `0`
- **artifact:** `ab-20260712-metronome-oracle-backrun-compare.json`
- **assessment:** `contradicts` on p50 only: A `7822.5 ms`, B `7909.5 ms`, `-1.112%`; ring-set
  mismatch `0`; all output mismatches are the predeclared `protocolMids 45→50` view change
- **reconciliation:** disagree. Fresh review found the old default `minAbsoluteDelta=0` made every negative
  delta contradict even below `maxRegressionPct=5`. Fixed mechanically by main commit
  `340f41e7db7901d285118cbcf0de7d10849541e4` (A/B tests 31/31, build PASS, non-author APPROVE).

## Fresh Non-Author Adversarial Review
- **reviewer:** Darwin, fresh non-author session `019f5625-fb68-7a62-a5c9-2e600d85bee5`
- **causal verdict:** win. Exact replay proves the previously absent Metronome capability, and paired live
  supplies no-regression evidence; recurrence of the trigger is not required in the authorized
  block-scan-only canary lane.
- **mergeability addendum:** current-main compatibility is inconclusive because `origin/main` advanced from
  tested base `b29571c...` during the window. HERMES has no materiality exception: retain and retest on
  current main before merge. This does not reverse the causal win.
- **ran_gate / evidence:** `test:ab-canary` PASS; exact A→B diff and production registry/trigger/replay paths
  inspected; fairness/config/universe/view hashes, frozen commits, restart counters, and B pause checked.

## Final Decision
- **verdict:** needs_escalation
- **branch action:** retained
- **merge/deploy/cleanup evidence:** B stopped through the trusted wrapper. The tested capability is a causal
  win, but main advanced to `055a43d...`; direct merge is forbidden because its first parent would not be
  the tested base.
- **stronger-model handoff (if retained):** mechanical current-main retest: deploy current main as A, apply
  the exact frozen Metronome production diff to a new literal `ab/*` challenger, rerun the exact replay and
  paired canary, then merge only that newly tested SHA.

```ab_experiment
{
  "schema_version": 2,
  "experiment_id": "20260712-metronome-oracle-backrun",
  "problem_id": "block-25515277-metronome-oracle-backrun",
  "branch": "ab/metronome-oracle-backrun",
  "base_commit": "b29571c66bdb19eec979a3d6a064ac1a4bdc91f3",
  "challenger_commit": "ee8bf04fdf15711a3105adb67ca1b24038ad3c9b",
  "change_class": "capability",
  "hypothesis": "A pinned Metronome oracle forward admits and executes the conserving 0x4d1e route without regressing the block-scan champion lane.",
  "input_mode": "shared",
  "expected_runtime_view_delta": true,
  "allowed_config_delta": [],
  "a": {
    "commit": "b29571c66bdb19eec979a3d6a064ac1a4bdc91f3",
    "config_hash": "2f27e8c1684cebe04b007005c0a9c3f63c11c75ee896e6093bb0e579f6c1c4d1",
    "universe_hash": "70e9464d3262255379399543b8047c7deba7147f8f1478aa2db3c78e6fefa5ff",
    "discovery_to_block": 25515366,
    "blockscan_view_hash": "be034540005111f86ee7340b828080671a7cf27e5c66eb37df24d642cd69876c",
    "blockscan_graph_hash": "51c5210e0856cf4738169871488137c807a615414d6c1ce38fa5727f16a846a8"
  },
  "b": {
    "commit": "ee8bf04fdf15711a3105adb67ca1b24038ad3c9b",
    "config_hash": "2f27e8c1684cebe04b007005c0a9c3f63c11c75ee896e6093bb0e579f6c1c4d1",
    "universe_hash": "70e9464d3262255379399543b8047c7deba7147f8f1478aa2db3c78e6fefa5ff",
    "discovery_to_block": 25515366,
    "blockscan_view_hash": "e06c203fee7af629b03ef609e4ccb4837999c91e626d1b75ec4ed1b87f1f0b86",
    "blockscan_graph_hash": "3693695c6a31159461642cd7bf577e97f45c33112d2b196149e01fbb06638125"
  },
  "window": { "min_paired_blocks": 120, "warmup_blocks": 10 },
  "fairness": {
    "same_block_window": true,
    "paired_blocks": 134,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "70e9464d3262255379399543b8047c7deba7147f8f1478aa2db3c78e6fefa5ff",
    "b_universe_hash_after": "70e9464d3262255379399543b8047c7deba7147f8f1478aa2db3c78e6fefa5ff",
    "a_blockscan_view_hash_after": "be034540005111f86ee7340b828080671a7cf27e5c66eb37df24d642cd69876c",
    "b_blockscan_view_hash_after": "e06c203fee7af629b03ef609e4ccb4837999c91e626d1b75ec4ed1b87f1f0b86",
    "a_blockscan_graph_hash_after": "51c5210e0856cf4738169871488137c807a615414d6c1ce38fa5727f16a846a8",
    "b_blockscan_graph_hash_after": "3693695c6a31159461642cd7bf577e97f45c33112d2b196149e01fbb06638125"
  },
  "deterministic_gate": {
    "result": "pass",
    "evidence": "listener npm run searcher:blockscan-fork-solve-metronome on local reth"
  },
  "analysis": {
    "agent_manual_author": "Codex independent raw-log and receipt/callTracer analysis",
    "agent_manual_verdict": "win",
    "agent_manual_evidence": "Exact Metronome replay flipped to +111748302 USDC-base gross; 134 fair paired live blocks showed the declared protocol view with no output or material latency regression; no same-window oracle recurrence.",
    "script_exit_code": 0,
    "script_assessment": "contradicts",
    "script_artifact": "ab-20260712-metronome-oracle-backrun-compare.json",
    "reconciliation": "disagree",
    "adversarial_review": {
      "verdict": "win",
      "evidence": "Exact replay proves the Metronome capability and 134 fair paired blocks show no material semantic or latency regression; the 1.11% script contradiction was a threshold defect. Current-main advancement separately requires retest before merge.",
      "reviewer": "Darwin fresh non-author 019f5625-fb68-7a62-a5c9-2e600d85bee5"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": true,
  "evidence_bundle": "this report; ab-20260712-metronome-oracle-backrun-compare.json; step1-20260712-metronome-oracle-backrun.json; manual SSM 57630f3c-a320-41bd-a65a-22cfc71f3e83; classifier SSM 2409b0e9-b177-41d4-8c40-fc03a9bc5452; census SSM 67613187-a527-4c4c-ba46-313dcc02a2c3",
  "mergeability": {
    "current_main_commit": "055a43d039a04aa4a3d1b41165d0f99aad364397",
    "tested_base_is_current": false,
    "evidence": "origin/main advanced from tested base b29571c66bdb19eec979a3d6a064ac1a4bdc91f3 to 055a43d during/after the canary; HERMES requires retain and current-main retest"
  }
}
```

```step1
run_id: 20260712-metronome-oracle-backrun
window_blocks: 25516096..25516253
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-20260712-metronome-oracle-backrun.json
method: independent receipt/callTracer reconstruction + competitor-calibration + census-gap/bundle-postmortem reconciliation
fable_manual: no
```

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| Dual-live envelope is block-scan-only, so the oracle-triggered mempool admission itself is deterministic-replay gated; paired live measures runtime safety/regression unless a same-window standing opportunity appears. | orchestrator | decision | open |
| Exact gate originally injected two DEX venues that production did not durably admit; non-author review blocked deployment. Both are now committed pins and the gate reads production registry inputs. | Codex | replay | closed |
| Trusted wrapper's fixed 90s first-pass wait was shorter than the 8,641-pool cold start. `AB_FIRST_SCAN_TIMEOUT_SECONDS` is now bounded 90..600 with default 240 on main. | Codex | deploy | closed |
| Comparator treated every negative delta as regression when `minAbsoluteDelta=0`, and the journal could not express causal win plus stale-base retention. Main `340f41e8...` fixes both with 31 A/B tests. | Codex | close | closed |
| Historical unrelated tooling defects globally blocked cycle-close, while case-ID substring matching could satisfy or block the wrong case. Main `055a43d...` scopes the gate to exact active Method Trace references; 62 focused tests plus fresh non-author approval. | Codex | close | closed |
| All-in-graph Coffee loop `0x43ea...` needs six swap hops while production planner/scanner defaults are 3/4. | next Hermes round | round 1 | open |
| Tested base advanced during this canary, so the Metronome capability must be replayed and paired-live tested on current main before merge. | orchestrator | immediate retest | open |
