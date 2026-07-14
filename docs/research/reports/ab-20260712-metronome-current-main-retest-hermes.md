# Hermes A/B Retest `20260712-metronome-current-main-retest`

> Resolution (2026-07-14): current-main commit `bc54762` replaces the pinned
> Metronome-only trigger with the shared `swap | oracle` victim-effect pipeline.
> The unchanged block `25515277` sample now passes the production detector,
> generic planner, candidate-order cap, solver, and BotVM gate 9/9. The detector
> observes no effect at N-1, admits only concrete quote deltas after applying
> `0x63e4e781...`, ranks the conserving Coffee route fourth within cap six, and
> flips the same amount from negative pre-victim gross to positive post-victim
> gross. The retained retest and victim-v2 branches are therefore cleanup-only
> once this archive is on `main`; no new live window is needed for this
> deterministic admission claim.

> Current-main compatibility retest of retained branch `ab/metronome-oracle-backrun`. No B process was
> deployed and no A/B window was opened after the predeploy reviewer found the capability unreachable in
> the authorized block-scan-only production posture.

## Frozen Inputs
- **base / deployed A:** `055a43d039a04aa4a3d1b41165d0f99aad364397`
- **replayed challenger:** `545deac`
- **retained branch tip after fail-closed fix:** `beb31e6`
- **pinned trigger:** `0x63e4e781e802ec9c54a47d52a65e30bf43df694b77cbb6bdc8ab7fe303f6bb25`
- **target competitor tx:** `0x4d1e4e51...`, block `25515277`

## Deterministic Replay
- Local-reth fork command ran on node worktree `/opt/MEV-gates/metronome-retest` at frozen code
  `545deac` (SSM `7758a354-a426-448b-8e57-277c4f265071`).
- `searcher:blockscan-fork-solve-metronome`: **PASS 6/6**.
- The production registry, graph builder, planner, solver, BotVM compiler, and adapters executed the exact
  six-edge conserving route with `netProfit=111748302` USDC base units and
  `flashAmount=122474539338`.

## Predeploy Adversarial Review
- **reviewer:** fresh non-author `019f56c1-e063-7ba2-9b5a-10968018d5df`
- **verdict:** NOT APPROVED
- **P1, decisive:** the replay calls `buildMetronomeOracleBackrunOpportunity` directly. Production calls it
  only from `handleHint`, while the authorized A/B posture has `SEARCHER_ENABLE_BACKRUN=0` and therefore a
  disabled hint stream. Generic block-scan runs after the source block and cannot capture this same-block
  oracle backrun. The replay proves quote/execution, not production admission.
- **P2:** `SEARCHER_ENABLE_PROTOCOL_EDGES=0` filtered `metronome-synth` but left
  `metronome-hgusdc` admitted. Commit `beb31e6` now fails closed on both adapters and adds
  `searcher:protocol-edge-admission` regression coverage.

## Decision
- **causal execution result:** implemented and replayable
- **production result:** not reachable under the current block-scan-only posture
- **final verdict:** `needs_escalation`
- **branch action:** retained
- **B status:** never deployed; trusted preflight passed, but reviewer veto stopped deployment
- **merge:** forbidden; no production-lane admission proof and no paired live window

## Stronger-Model Handoff
Choose and gate one explicit admission architecture before retesting:
1. restore a bounded public-mempool/backrun lane that can see the exact oracle forward, or
2. add a separately declared targeted oracle-forward subscription with its own CPU/safety envelope.

Do not claim block-scan support for this sample: a new-head scan observes state only after the same-block
opportunity has already been consumed. Retest must drive the production handler from the real admission
source, then replay the same trigger and run a fair A/B window with that source enabled on both sides.

## Verification
- current-main deploy: trusted `deploy-node.sh`, bounded LIVE envelope preserved
- challenger build: PASS
- adapter/taxonomy/protocol/quote tests: PASS
- protocol-edge admission regression: PASS
- pinned fork replay: PASS 6/6
- paired live window: not run (predeploy veto)
