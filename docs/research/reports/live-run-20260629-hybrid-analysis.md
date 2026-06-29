# Live Run 2026-06-29 Hybrid Analysis

Source artifacts:

- `live-run-20260629-hybrid-redacted.log`
- `live-run-20260629-hybrid-events.redacted.jsonl`
- `live-run-20260629-hybrid-summary.md`

## Bottom Line

The filtered mempool + hybrid backend path is working. The current blocker is not opportunity visibility or pending-hash CU usage; it is planner/path coverage.

The run saw real mempool opportunities, but none reached solver/simulation. Most structured drops are `plan/no_candidate_plans`, meaning the searcher observed an impacted pool/token pair and then failed to construct any executable candidate path.

## Evidence

Searcher counters at the end of the run:

```text
hints=219 impacts=40 opportunities=18 plans=26 solverEntered=0 solverSuccess=0 revmSimSuccess=0 rpcVerifySuccess=0 simSuccess=0 submitAttempts=0 accepted=0 expiredBeforeSolver=2 quoteTimeouts=0 simReverts=0 finalVerifyFailed=0 finalVerifySkipped=0 missingState=0 revmErrors=0 pendingReceived=100 pendingFilteredReceived=95 mempoolOpportunitySeen=18 mempoolToSim=0 cuProxyRpcCalls=0
```

Event distribution:

```text
opportunity_seen: 18
pipeline_dropped: 17
  plan/no_candidate_plans: 15
  solver/expired-before-solver: 2
```

Interpretation:

- `pendingReceived=100` and `pendingFilteredReceived=95` prove the filtered Alchemy mempool subscription is receiving real pending transactions.
- `cuProxyRpcCalls=0` proves the old pending-hash `getTransaction` firehose did not come back.
- `mempoolOpportunitySeen=18` proves mempool opportunities are entering our live-loss telemetry.
- `solverEntered=0` with `15/17` drops at `plan/no_candidate_plans` shows the dominant failure is before solver.

## High-Frequency Gap

The strongest repeated sample is:

```text
pool: 0xEcABc504c30e1a081438B9F3b57Cc8F9dBDc1Ec6
pair: 0x39484A066aF5fEdFdef7ebf828E95CFB035fd1BC / WETH
count: 6 opportunity_seen
outcome: plan/no_candidate_plans
```

This is the first pool to debug because it repeats enough times to avoid chasing a one-off long-tail event.

## Non-Primary Signals

`victim apply failed` still appears in the raw log, so hybrid has not removed all pending-victim apply noise. However, those failures happen before an `opportunity_seen` event is emitted. Among opportunities that did enter the structured pipeline, the dominant failure is still planner construction.

`solver/expired-before-solver` exists but is secondary in this run: 2 events versus 15 `no_candidate_plans` events. Latency is real, but it is not the top blocker in this sample.

## Next Action

Debug `no_candidate_plans` for the repeated pool above. The first questions are:

1. Is either side of the impacted pair borrowable through the current flash-liquidity registry?
2. Does the token graph have a return path from the output token back to the flash-loan repayment token?
3. Is the path rejected because the planner only supports a narrower template than the market opportunity requires?
4. Is this actually a path-shape gap such as LP leg, borrow/lend leg, router-specific route, or a long-tail pool missing from our supported production surface?

Do not prioritize bid/builder/latency yet. We are not reaching solver or submit, so those layers have no useful signal from this run.
