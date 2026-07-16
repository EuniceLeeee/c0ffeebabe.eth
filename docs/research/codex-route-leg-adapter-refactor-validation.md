# Codex Route Leg Adapter Refactor — Implementation and Validation

Date: 2026-07-16  
Status: `implemented_not_validated`  
Baseline: `4392ffc59fd4aa593500c6ee4fb83b34fe50340a`  
Candidate: `f72ccde0ba61f9acd02f694694cfa66be35fe10e`  
Branch: `codex/route-leg-adapter-refactor`

## Scope implemented

- Added an explicit `RouteAdapterRegistry` split into swap, protocol-conversion, and compatibility adapters. Flash routing remains on the existing architecture by design; no `FlashAdapterRegistry` was added.
- Separated pool identity/admission from execution family. `IdentityAdmissionPolicy` now owns provisional factory and Curve-underlying admission; `main.ts` no longer repeats `allowProvisionalFactories` or `allowProvisionalCurveUnderlying` flags.
- Migrated UniV2, UniV3, Curve plain/underlying, Balancer V3, UniV4, ERC4626, PSM, wstETH, RockSolid, Metronome, and GOLDx routing into family modules.
- Preserved the legacy Fluid credit edge as a fail-closed compatibility adapter. Fluid DEX remains the only explicit legacy switch because the plan marks its final-simulation fixture as blocked.
- Kept route construction separate from BotVM `ActionAdapter` encoding. Route adapters return multi-node `PlanFragment`s so UniV4 and approval/transfer siblings remain representable.
- Extracted the block-scan warm coordinator and retained synchronous mid reads over prewarmed state.
- Separated victim replay models from route execution, unified RPC victim replay, and extracted EV evaluation.
- Added prepared-state quote/prewarm/allowance capabilities and removed the second concrete venue dispatch from `revm-live-backend.ts`.
- Added runtime taxonomy validation and a final standing-position fail-closed re-derivation.

The candidate has 14 registered route adapters. `main.ts` is 4,936 lines versus 5,565 at the baseline (629 lines removed). The remaining concrete switches in token graph, quoter, and plan builder are all the same explicitly blocked `fluid-dex-swap` family; Revm has no migrated-family quote/prewarm switch.

## Adversarial review

The requested subagent performed two review passes against the local code diff.

- First pass found one code P1: Revm still contained a second venue quote/prewarm dispatch. This was fixed in `bbd5ae6` by moving the prepared-state capabilities into the route adapters.
- Second pass found no P0 or P1 and confirmed the Revm dispatch was closed.
- It found one P2: Fluid credit advertised a prepared quote that always threw. This was fixed in `f72ccde` as `quote: null` plus an explicit unsupported reason, preserving the old fail-closed error.
- Final targeted re-review passed with no new P0/P1.

Non-blocking follow-ups remain: inject the production registry into Revm from the composition root instead of importing the singleton; turn the quote/reason pair into a discriminated union; connect the oracle raw-tx model descriptor to production composition; and add identity proof/fee-rule behavior only with pinned fork fixtures. DODO, Fluid DEX migration, and a separate liquidity adapter kind remain fixture-gated future work.

## Deterministic validation

At both baseline and candidate:

- TypeScript build passes.
- Adapter descriptors pass 5/5.
- Venue identity passes 7/7.
- Planner passes 15/15, replay fixtures 22/22, plus the high-spread universe replay.
- Final verify, standing guard, submit gate, taxonomy, warm coordinator, victim model/apply, protocol legs, protocol quotes, overlay fidelity, V4 admission, Balancer V3, universe split, and EV evaluator gates pass.

The final candidate ran 23 no-RPC gates successfully. `searcher:blockscan-scanner` retains the exact baseline-known failure at `delta-restrict` after 4/17 (`untouched anchor should be filtered`); it is not a candidate regression. RPC/fork gates were not run locally because no `MAINNET_RPC_URL` was available.

## Local performance comparison

This is a local deterministic TopN planner benchmark, not the trusted same-block production A/B. Both revisions used the same 7,704-pool input:

`active-pools.json` SHA-256: `eb4f064aee642ad270ab228499de16a51adf2e7da25ba42e644b2ff8dcd51baf`

Six 50-iteration rounds were run in AB/BA alternating order. Values below are medians across rounds; retention is `baseline / candidate` for latency, so 100% is equal and lower is slower.

| TopN | Edges A/B | Build A→B | Plan p50 A→B | p50 retention | Plan p95 A→B | p95 retention |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1,798 / 1,798 | 48.666 → 48.739 ms | 17.950 → 18.285 ms | 98.17% | 20.171 → 20.707 ms | 97.41% |
| 3,000 | 5,470 / 5,470 | 145.136 → 145.314 ms | 30.405 → 31.369 ms | 96.93% | 32.225 → 33.799 ms | 95.34% |
| 6,000 | 11,158 / 11,158 | 280.351 → 280.042 ms | 33.734 → 34.971 ms | 96.46% | 35.404 → 38.132 ms | 92.85% |

The edge counts and graph-build latency are equivalent. Median planner latency retains 96.46–98.17%, meeting the requested approximate 95% target. The 6,000-pool p95 is below 95%; individual runs show large tail variation on both sides, consistent with local V8 JIT/GC and CPU-frequency noise. A smaller real component may come from changed edge object shapes and registry/taxonomy indirection. This tail result must be measured on the trusted nodes before claiming production parity.

Raw AB/BA log-set digest: `dc42d3e3db8eca5f6fb711035e6fe55df3092b6e5e896d8223c28b423b0557a1`.

## Trusted A/B deployment decision

No production A/B was started, and the active A process was not changed. Read-only preflight found A running commit `840069d9d30b40d0c9585ed5a879091a666aa533`; the requested baseline is `4392ffc`, so the deployed champion is not the requested baseline.

More importantly, the trusted deployment contract mechanically rejects this candidate for two independent reasons:

1. The implementation branch includes its conformance tests and `listener/package.json`; the trusted challenger accepts production-only diffs and rejects challenger-authored test evidence.
2. A production challenger must show the same real +EV sample advancing at least one production stage. This refactor intentionally preserves stages. The infrastructure-shakedown mode cannot be used because it requires identical searcher code.

Creating a production-only branch would remove the first veto but not the second. Inventing a stage transition or using the shakedown path for changed code would falsify the trusted evidence, so deployment was stopped before mutating A or B.

Therefore the architecture and local approximate-95% performance checks are complete, but the requested trusted-node A/B acceptance is not. Under `docs/research/gates.md`, the honest verdict remains `implemented_not_validated` until the project adds an equivalence/performance-only trusted A/B mode or authorizes a different non-production parity harness.
