import assert from "node:assert/strict";
import { test } from "node:test";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { EXECUTOR, makePlans, sharedSession } from "./blockscan-solver-quote-concurrency.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { SequentialQuoteUnsupportedError } from "../strict-production-runtime-session.js";
import { BlockScanFamilyStageBudget } from "../detector/blockscan-family-budget.js";
import { AnvilSolver } from "../solver/solver.js";
const noState = new Proxy({} as StateBackend, { get() { throw new Error("unexpected state IO"); } });

test("repeated logical state gets isolated full prefixes and carries exact handles to execution", async () => {
  const plan = makePlans(1)[0]!;
  plan.tokenPath.edges.forEach(e => { e.instanceKey = "shared-logical-state"; });
  const trialInputs = new WeakMap<object, bigint>();
  const fixture = sharedSession([plan], {
    onExact(input, handle) { trialInputs.set(handle, input.amountIn); },
    async quote(input, leg) {
      assert.equal(input.priorQuotes!.length, leg);
      if (!leg) return input.amountIn * 2n;
      const first = input.priorQuotes![0]!;
      assert.equal(first.amountOut, input.amountIn);
      // The fixture stands in for a Family's sequential method, not a second
      // production formula: expose trial mixing or omitted prefix deterministically.
      return trialInputs.get(first)! + 10n;
    },
    onBuildExecution(input) { assert.equal(input.priorQuotes!.length, input.edge === plan.tokenPath.edges[0] ? 0 : 1); },
  });
  const directionalSession = { ...fixture.session,
    stateKeyForEdge: (edge: typeof plan.tokenPath.edges[number]) => `direction:${edge.tokenIn}` };
  const runs = await Promise.all([100n, 200n, 100n].map(amount =>
    propagateAmountsWithRawOutputs(plan.tokenPath, amount, noState, { executor: EXECUTOR,
      strictSession: directionalSession as typeof fixture.session, toleranceRawUnits: 0n })));
  assert.deepEqual(runs.map(r => r.amounts), [[100n, 200n, 110n], [200n, 400n, 210n], [100n, 200n, 110n]]);
  for (const run of runs) await buildResolvedPlanFromPath(plan.tokenPath, plan.opportunity.startToken,
    run.amounts[0]!, run.amounts, EXECUTOR, noState, 1n, "morpho-flash", run.rawOutputs,
    fixture.session, run.exactHandles);
});

test("unsupported sequential composition is not attributed to an entire Family", async () => {
  const plan = makePlans(1)[0]!;
  plan.tokenPath.edges.forEach(e => { e.instanceKey = "repeated"; });
  const unsupported = new SequentialQuoteUnsupportedError();
  const fixture = sharedSession([plan], { async quote(input, leg) {
    if (leg) throw unsupported;
    return input.amountIn * 2n;
  } });
  await assert.rejects(propagateAmountsWithRawOutputs(plan.tokenPath, 100n, noState,
    { executor: EXECUTOR, strictSession: fixture.session }), error => error === unsupported);
  const budget = new BlockScanFamilyStageBudget(3);
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(new AnvilSolver().solve(plan, noState,
      { executor: EXECUTOR, async simulate() { throw new Error("unsupported route cannot reach sim"); } },
      { strictSession: fixture.session, quoteSafetyBps: 10000n }), error => {
        assert.equal(error, unsupported, "full Solver preserves the route-only rejection");
        budget.recordFailure(plan.tokenPath.edges, error);
        return true;
      });
  }
  const unrelated = makePlans(2)[1]!;
  assert.deepEqual(budget.openFamilyIds(), []);
  assert.deepEqual(budget.openCompositeKeys(), []);
  assert.equal(budget.blockingCircuit(unrelated.tokenPath.edges), null);
});

test("different logical pools retain ordinary quote behavior", async () => {
  const plan = makePlans(1)[0]!;
  plan.tokenPath.edges.forEach((e, i) => { e.instanceKey = `logical-pool-${i}`; });
  const fixture = sharedSession([plan], { async quote(input, leg) {
    assert.equal(input.priorQuotes, undefined);
    return leg ? input.amountIn / 2n + 1n : input.amountIn * 2n;
  } });
  const result = await propagateAmountsWithRawOutputs(plan.tokenPath, 100n, noState,
    { executor: EXECUTOR, strictSession: fixture.session, toleranceRawUnits: 0n });
  assert.deepEqual(result.amounts, [100n, 200n, 101n]);
});
