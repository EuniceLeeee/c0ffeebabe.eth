# Blockscan global recent-block gas reference

## Scope and approved behavior

Base: `86794240a4988a76560e57dd0b03527ec5344f14`. This is a generic sizing-policy change,
not an Adapter repair or a claim of improved production profitability/latency.

The user clarified that a pass uses successful simulation gas units from the **previous block**,
or the **nearest earlier successful block** when the previous block has no usable sample.
It does not select a maximum across historical blocks. Multiple successful simulations in the
chosen block contribute their maximum gas units. The estimate is shared across route identities.
An older late-arriving result cannot displace a newer block. Existing connected-ancestry,
bounded-memory, source/hash, restart and per-pass snapshot checks remain.

Only gas **units** are reused. The existing current-header target base-fee estimate prices them;
the current enumeration spread (200 bps) and same-source directed mid references convert the cost
to each input token's raw amount. Token conversion remains at most three hops and is computed once
per token per pass. No old gas price is carried over and no 5% constant is introduced.

The existing `P = max(10, G)`, missing-reference fallback of 10 raw units, amount ceilings,
four initial Solver points (`P, 5P, 10P, 15P`) and GSS remain. There is no imported historical
simulation or invented startup gas estimate. A new process remains cold until its first usable
successful simulation. No successful sim means this mechanism has not yet activated.

Final sim and EV continue to consume the actual selected transaction's gas usage. The sizing
reference is not a gas limit or a guarantee of positive net EV. The existing recording caller
still checks successful positive-gross execution and the source hash before recording, ahead of
EV rejection. No extra RPC, protocol/pool/ABI branch, new table, Ready change or central API change.

## Implementation and checks

Only `listener/src/searcher/blockscan-amount-reference.ts` and its existing test change.
The observation API remains compatible; its opportunity field no longer keys the gas cache.
The reviewed two-file patch SHA-256 is
`a3bb43306cd3a002314aef58e6c02f48b2c09def715cfd663bfc5c03ddca0d55`.

Regression-first checks demonstrated both former failures: an unseen route had no reference;
then the initially proposed history-wide maximum overrode a newer lower-gas block. The final
implementation passes both, plus same-block/future exclusion, missing previous-block fallback,
late older observations, fee increases/decreases, units/fees/three hops, reorg/disconnected ancestry,
capacity expiry, frozen passes, Exact amount handoff and over-cap attribution.

Full listener build passed. The generated tool inventory check passed (342 entries). Current
zero-RPC tests executed through tool-run: `listener:searcher:blockscan-amount-reference`,
`listener:searcher:blockscan-solver-amount-grid`, `listener:searcher:runtime-defaults`,
`listener:searcher:final-simulation-work-runtime`. The last three confirm retained sampling,
100% profit-ratio ceiling and execution/freshness safety boundaries.

Non-author review pass 2 approved the exact recent-block patch and 500-height launcher, with no
P0–P3 findings or required fixes. It executed five suites (amount reference, candidate refinement,
EV evaluator, final verify, Exact deadline), 56,000 independent nearest-block comparisons and
isolated launcher mocks covering no stop at 50/first sim, stop at source+499 with/without sim,
user/throttle stops and owned-child signaling. The review receipt is
`blockscan-global-gas-reference-20260910-review.json`. The mandated CLI attempt failed with
model/CLI version incompatibility; native independent review was the fallback. Local checks
consume zero Alchemy CU; previous live CU usage is unavailable, not asserted zero.

## Stopped preceding live

The user requested stopping `logs/profit-100-live.kO6BRQ`. Its owned supervisor and runtime
terminated normally at `2026-09-10T07:49:25.834Z`; their identities were checked before signaling,
and simulation ports 8555–8560 were released. Unrelated processes were not touched.

The full observation spanned 122 source heights (`25945480–25945601`): 107 Solver blocks,
zero final-sim-stage blocks, zero simulation results and zero EV stages. The last pass was
interrupted by the requested shutdown. The pre-frozen first 50 heights (`25945480–25945529`)
had all 50 terminals, 46 Solver blocks, zero final sim/EV and zero gas-reference passes.
This window therefore cannot validate the changed 100% guard or the new shared gas behavior.

Manual inspection preceded indexed reconciliation. On that fixed window, `analysis:blockscan-window`
confirms 50 passes, but its N-1 qualification reports `missing_coarse_source_block`; this is not
evidence that Source-N mid is absent. `analysis:block-activity` at target 25945530 reconstructs
source 25945529 with 28,602 mids, matching source/hash and 169 enumerated candidates.
`analysis:blockscan-pass-latency` includes the bootstrap sample (51 records), unlike the frozen
50-height summary. Its total-time statistic includes cancelled passes and does not measure
completed EV cycles. Initial slices lacking the required process anchor were rerun from log line 2.
These scope differences are retained, not relabeled as passing production timing evidence.

Selection query: `runtime,verification,blockscan,latency,production-events,state-coverage`.
Manifest: `logs/global-gas-tools.json`; SHA-256
`9f6db390553d7559e74eceb40752b48e76db1e5331ccf6a12b34d40fa7f2deb6`.
Successful receipts are archived in `blockscan-global-gas-reference-20260910-tools.json`.

## Next live contract

Task-local launcher: `logs/global-gas-live.2LkA7c/launch.mjs`; actual launch receipts will bind
the clean reviewed commit and owned PIDs. Reuse compatible Ready generation 2, 16,175 instances,
32,058 edges, original discovery range 25923216–25937615, checkpoint SHA-256
`418209d12a09dabf34eb292983850403326619b2bbf8e3fa1a366c416a9d5a70`.
The compatibility check passed with no stale Family hashes and zero RPC; no rebuild.

User-authorized observation is **until user stop or at most 500 consecutive source heights**,
starting with the first non-bootstrap terminal. Missing/cancelled heights remain in the denominator.
No automatic stop at 50 heights or first sim. Explicit Alchemy throttle/quota and process failure
remain safety stops. No automatic restart/provider switch, no signing, no broadcast, EV gate enabled.
Enumeration stays 2%, Exact admission stays 50 bps and the profit-ratio ceiling stays 100%.

Track the first usable simulation, subsequent gas-reference coverage, selected amounts and the
furthest natural sim/EV result. A revert, EV rejection or absent sample needs its own evidence;
no positive-EV or systemic improvement claim is made by this implementation report.
