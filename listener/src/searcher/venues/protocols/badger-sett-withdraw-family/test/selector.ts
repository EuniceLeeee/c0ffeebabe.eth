import assert from "node:assert/strict";
import { test } from "node:test";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { runtimeAmountFlowAdapter } from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/badger-sett-withdraw.production.js";
import { ACTION } from "../manifest.js";
import { actor, input } from "./fixture.js";
// Production sim-amount selection and real encoder; injected simulation is
// deliberately synthetic, not BotVM EVM or economic acceptance.
test("production sim selector constructs actual-receipt flow with zero Exact, quoted build or RPC", async () => {
  const i = input(), r = i.route;
  const leg = plugin.execution.buildRuntimeLeg!(i); assert(leg);
  let exactCalls = 0, quotedBuilds = 0, rpcCalls = 0, simulated = 0;
  const events: Record<string, unknown>[] = [];
  const edges: any[] = [{ adapterId: ACTION, target: i.descriptor.vault, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
    { adapterId: "synthetic-return", target: actor, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
  const session: any = { source: i.source, fundingActionIds: () => ["synthetic-funding"],
    buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? plugin.execution.buildRuntimeLeg!(i) :
      { actionAdapterId: "synthetic-return", program: "0x010001" + "00".repeat(32) }; },
    issueExact() { exactCalls++; throw new Error("unexpected Exact"); },
    buildExecution() { quotedBuilds++; throw new Error("unexpected quoted construction"); },
    buildFundingRoot(q: any) { return { adapterId: "synthetic-funding", target: actor, tokenIn: r.tokenIn,
      tokenOut: r.tokenIn, amount: q.amount, params: {}, children: q.children }; } };
  const selector = createBlockScanSimAmountSelector({ source: i.source, executor: actor, record: e => events.push(e),
    async simulate(plan) {
      simulated++;
      const flow = plan.root.children[0]; assert.equal(flow.adapterId, "runtime-amount-flow");
      const legs = JSON.parse(flow.params.legs as string);
      assert.equal(legs[0].program, leg.program); assert.equal(legs[0].tokenOut, r.tokenOut);
      assert.equal(legs[1].tokenIn, r.tokenOut);
      assert.equal(runtimeAmountFlowAdapter.encode(flow, actor, new Uint8Array())[0], 12);
      return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" };
    } });
  await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
    flashToken: r.tokenIn, profitToken: r.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "badger-offline-construction" } as any,
    { call() { rpcCalls++; throw new Error("unexpected RPC"); } } as any, { executor: actor } as any,
    { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
  assert(simulated >= 4); assert.equal(exactCalls, 0); assert.equal(quotedBuilds, 0); assert.equal(rpcCalls, 0);
  assert(events.some(e => e.type === "sim_amount_construction"));
  assert(events.filter(e => e.type === "sim_amount_construction").every(e => e.mode === "runtime-actual"));
});
