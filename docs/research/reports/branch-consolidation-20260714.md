# Branch consolidation — 2026-07-14

## Outcome

- `origin/main` advanced to `e6d058b7eba2117dccec11bc4196cc2680fd0914`.
- The trusted dual-lane A/B runtime was merged, but the production default remains block-scan only:
  `SEARCHER_ENABLE_BACKRUN=0` and `SEARCHER_ENABLE_MEMPOOL=0` on node A.
- The old low-degree-triangle challenger was deleted. Its committed code had no real pinned +EV replay
  flip; an uncommitted synthetic fixture was not sufficient evidence for a production challenger.
- `codex/tokenedge-venue-graph-index` at `1074af5e405c88c30fc59f11af98356e451d86e1`
  is the only retained development branch. It is a broad analysis/fact-index consolidation based on an
  older main and overlaps newer venue-identity, victim, A/B, and deploy work, so it requires a deliberate
  forward integration rather than a blind merge.

## Validation

The merged runtime passed:

- analysis build and the full analysis suite, 162/162;
- competitor calibration, 22/22;
- listener build;
- live-envelope tests, 8/8;
- victim-application tests, 7/7;
- token/edge taxonomy, 5/5;
- shell syntax checks for the trusted deployment scripts.

The full-suite consolidation run exposed two stale merge boundaries before close: schema-v3 promotion
fixtures omitted the new `lane_mode`, and receipt coverage still assumed the hgUSDC vault itself was the
callable adapter. The fixtures now carry the lane explicitly. The shared pool registry now distinguishes
the Metronome execution target (router) from its receipt emitter (hgUSDC vault), so analysis recognizes
the supported path without pretending direct ERC4626 redemption is executable.

The retained `codex/tokenedge-venue-graph-index` branch independently passed:

- analysis build and full analysis suite, 175/175;
- competitor calibration, 18/18;
- listener build;
- venue identity, 7/7;
- universe split, 11/11;
- victim-effect event tests.

## Live smoke

Node A was deployed through the trusted `origin/main:scripts/deploy-node.sh` path. At the first evidence
read it was running `e6d058b7eba2117dccec11bc4196cc2680fd0914`, PID `689201`, with zero systemd
restarts and B inactive. From `05:19:28Z` through `05:35:10Z`, the runtime completed 43 block-scan
passes over blocks `25528758..25528823`, with zero fatal/unhandled/address-in-use errors. The first and
last summaries each scanned 878 pairs; their total times were 11,645 ms and 11,120 ms. No positive quote
or submission occurred in this bounded regression window, so the smoke proves runtime stability rather
than opportunity capture.

Dual mode was not enabled merely to manufacture a live result: it is default-off, its safety envelope was
tested locally, and the existing block-scan production lane received the bounded smoke regression.

## Historical replay boundary

The pinned Metronome sample at block `25515277` was rerun on the node. Both the generic backrun hunt and
the older specialized gate stopped at admission because the local reth could no longer answer historical
dynamic `eth_call` state for the required UniV3, Curve, and Metronome contracts. The node head was
`25528724`, 13,448 blocks later. V4 metadata and a fixed edge still built, which isolated the failure to
historical state availability.

This is neither a replay pass nor a code failure. An archive-capable state source or a freshly pinned
sample is required before making a capability claim from that fixture.
