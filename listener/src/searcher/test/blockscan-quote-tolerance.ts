import assert from "node:assert/strict";
import { test } from "node:test";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { resolveBlockScanSolverSearchConfig } from "../blockscan-solver-search-config.js";
import {
  BlockScanFamilyAttributedError,
  BlockScanFamilyStageBudget,
} from "../detector/blockscan-family-budget.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { AnvilSolver } from "../solver/solver.js";
import type { CanonicalEdgeId } from "../venues/blockscan-state-capability.js";
import { EXECUTOR, makePlans, sharedSession } from "./blockscan-solver-quote-concurrency.js";
import type { StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";

const noState = new Proxy({} as StateBackend, {
  get(_target, key) { throw new Error(`unexpected state I/O: ${String(key)}`); },
});

test("zero Family output never calls the downstream Family", async () => {
  const plan = makePlans(1)[0]!;
  const edges = plan.tokenPath.edges.map((edge, index) => ({
    ...edge, canonicalEdgeId: `${index === 0 ? "upstream" : "downstream"}\u001f${edge.target}` as CanonicalEdgeId,
  }));
  const dustPlan = { ...plan, tokenPath: { edges } };
  const budget = new BlockScanFamilyStageBudget();
  let downstreamCalls = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fixture = sharedSession([dustPlan], {
      toleranceRawUnits: 1n,
      async quote(_input, leg) {
        if (leg > 0) downstreamCalls++;
        return 0n;
      },
    });
    await assert.rejects(
      propagateAmountsWithRawOutputs(dustPlan.tokenPath, 10000n, noState, {
        executor: EXECUTOR, strictSession: fixture.session, toleranceRawUnits: 1n,
      }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert(error instanceof BlockScanFamilyAttributedError);
        assert.match(error.message, /produced zero/);
        return true;
      },
    );
    assert.equal(fixture.stats.calls, 1);
  }
  assert.equal(downstreamCalls, 0);
  assert.deepEqual(budget.openFamilyIds(), []);
  assert.deepEqual(budget.openInstanceCircuitKeys(), []);
  assert.equal(budget.openCompositeKeys().length, 0);
  assert.equal(budget.blocks([
    { ...edges[0]!, canonicalEdgeId: "another-upstream\u001fother-edge" as CanonicalEdgeId }, edges[1]!,
  ]), false, "a different upstream can still quote the same downstream edge");
});

for (const enabled of [false, true]) {
  test(`quote tolerance ${enabled ? "on" : "off"} preserves nominal sizing and binds actual-input cases`, async () => {
    const config = resolveBlockScanSolverSearchConfig({
      SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: enabled ? "1" : "0",
    });
    const plan = makePlans(1)[0]!;
    const seen: bigint[] = [];
    const fixture = sharedSession([plan], {
      toleranceRawUnits: config.quoteToleranceRawUnits,
      async quote(input, leg) {
        seen.push(input.amountIn);
        return leg === 0 ? 20001n : input.amountIn * 3n / 5n;
      },
    });
    const propagated = await propagateAmountsWithRawOutputs(plan.tokenPath, 10000n, noState, {
      executor: EXECUTOR, strictSession: fixture.session, toleranceRawUnits: config.quoteToleranceRawUnits,
    });
    assert.deepEqual(propagated.amounts, [10000n, 20001n, 12000n]);
    assert.deepEqual(seen, propagated.amounts.slice(0, -1), "search never pre-subtracts tolerance");
    assert.equal(propagated.rawOutputs[0], 20001n, "never rewrite the Family's raw quote/evidence");
    const root = await buildResolvedPlanFromPath(plan.tokenPath, plan.opportunity.startToken,
      10000n, propagated.amounts, EXECUTOR, noState, 1n, "morpho-flash",
      propagated.rawOutputs, fixture.session, propagated.exactHandles, enabled ? { runtimeEvidence: [] } : undefined);
    assert.equal(root.amount, 10000n);
    assert.equal(root.params.minProfit, 1n, "repayment/profit guard is unchanged");
    if (enabled) {
      const flow = root.children[0]!;
      assert.equal(flow.adapterId, "actual-amount-flow");
      assert.equal(flow.children[0]!.children[0]!.children[0]!.params.minAmountOut, 20000n);
      const cases = flow.children[1]!.children;
      assert.deepEqual(cases.map(c => c.amount), [20001n, 20000n]);
      assert.deepEqual(cases.map(c => c.params.quotedAmountOut), [12000n, 12000n]);
      assert.deepEqual(cases.map(c => c.children[0]!.amount), [20001n, 20000n]);
      assert.equal(seen.at(-1), 20000n, "short input is separately quoted, never scaled");
    } else {
      assert.equal(root.children[0]!.params.minAmountOut, 20001n);
      assert.equal(root.children[1]!.amount, 20001n);
    }
  });
}

test("tolerance never turns a failed final simulation into success", async () => {
  const config = resolveBlockScanSolverSearchConfig({ SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: "1" });
  const plan = makePlans(1)[0]!;
  const fixture = sharedSession([plan], { toleranceRawUnits: config.quoteToleranceRawUnits });
  let sims = 0;
  await assert.rejects(new AnvilSolver().solve(plan, noState, {
    executor: EXECUTOR,
    async simulate() { sims++; return { success: false, netProfit: 0n, revertReason: "tolerance-fixture-revert" }; },
  }, { strictSession: fixture.session, quoteToleranceRawUnits: config.quoteToleranceRawUnits,
    quoteProfitFloorBps: 0n, finalSimTopN: 1, gssMaxTries: 2 }), /tolerance-fixture-revert/);
  assert(sims > 0, "the final simulation must actually run");
});

test("absolute tolerance never subtracts units from nominal Solver quotes", async () => {
  for (const raw of [2n, 11928445n, 100000000n, 15809n, 10n ** 30n + 123n]) {
    const plan = makePlans(1)[0]!;
    const quote = async () => raw;
    const run = async (toleranceRawUnits: bigint | undefined, safetyBps = 9999n) => {
      const fixture = sharedSession([plan], { toleranceRawUnits, safetyBps, quote });
      return propagateAmountsWithRawOutputs(plan.tokenPath, 10000n, noState, {
        executor: EXECUTOR, strictSession: fixture.session, toleranceRawUnits, safetyBps,
      });
    };
    const fine = await run(1n);
    assert.equal(fine.amounts[1], raw, "never pre-subtract or stack with legacy BPS");
    assert.equal(fine.rawOutputs[0], raw);
    const legacy = await run(undefined);
    assert.equal(legacy.amounts[1], raw * 9999n / 10000n);
    assert.equal((await run(0n)).amounts[1], raw, "explicit off overrides any generic BPS setting");
    if (raw === 11928445n) assert.equal(fine.amounts[1], 11928445n);
  }
});

test("invalid raw-unit tolerance rejects locally before issuing any Family quote", async () => {
  const plan = makePlans(1)[0]!;
  const fixture = sharedSession([plan]);
  for (const toleranceRawUnits of [-1n, 2n, 1000000n]) {
    await assert.rejects(propagateAmountsWithRawOutputs(plan.tokenPath, 10000n, noState, {
      executor: EXECUTOR, strictSession: fixture.session, toleranceRawUnits,
    }), /tolerance must be 0 or 1 token raw unit/);
  }
  assert.equal(fixture.stats.calls, 0);
});

test("legacy percentage validation remains fail-closed before any quote", async () => {
  const plan = makePlans(1)[0]!;
  const fixture = sharedSession([plan]);
  for (const safetyBps of [0n, -1n, 10001n]) {
    await assert.rejects(propagateAmountsWithRawOutputs(plan.tokenPath, 10000n, noState, {
      executor: EXECUTOR, strictSession: fixture.session, safetyBps,
    }), /retained output must be in \[1, 10000\] bps/);
  }
  assert.equal(fixture.stats.calls, 0);
});

test("actual-input cases retain finite Family approval bounds", async () => {
  const plan = makePlans(1)[0]!;
  const fixture = sharedSession([plan], { toleranceRawUnits: 1n });
  const session = { ...fixture.session,
    buildExecution(input: Parameters<StrictProductionRuntimeSession["buildExecution"]>[0]) {
      const result = fixture.session.buildExecution(input);
      assert.equal(result.status, "resolved");
      if (result.status !== "resolved") throw new Error("unresolved test execution");
      const amount = result.fragment.nodes[0]!.amount;
      return { ...result, fragment: { ...result.fragment,
        requirements: [{ kind: "approve" as const, token: input.edge.tokenIn,
          spender: input.edge.target, amount }] } };
    },
  } as unknown as StrictProductionRuntimeSession;
  const propagated = await propagateAmountsWithRawOutputs(plan.tokenPath, 10000n, noState, {
    executor: EXECUTOR, strictSession: session, toleranceRawUnits: 1n,
  });
  const root = await buildResolvedPlanFromPath(plan.tokenPath, plan.opportunity.startToken,
    10000n, propagated.amounts, EXECUTOR, noState, 1n, "morpho-flash",
    propagated.rawOutputs, session, propagated.exactHandles, { runtimeEvidence: [] });
  assert.equal(root.children.length, 1, "finite approvals are not hoisted or widened");
  for (const step of root.children[0]!.children) for (const branch of step.children) {
    assert.equal(branch.children[0]!.adapterId, "erc20-approve");
    assert.equal(branch.children[0]!.amount, branch.amount);
    assert.equal(branch.children[0]!.params.amount, branch.amount);
  }
});
