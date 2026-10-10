import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeAmountFlowAdapter } from "../../adapters/runtime-amount-program.js";
import { addressToBytes, concatBytes, uint24ToBytes, uint256ToBytes } from "../../encoder.js";
import type { ResolvedPlanNode } from "../../types.js";
import { createBlockScanSimAmountSelector } from "../simulator/blockscan-sim-amount-selector.js";

const A = "0x1000000000000000000000000000000000000001";
const B = "0x1000000000000000000000000000000000000002";
const ACTOR = "0x1000000000000000000000000000000000000003";
const program = ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes());
function encode(modes: unknown[], tolerance = 0n): Uint8Array {
  const legs = [{ tokenIn: A, tokenOut: B }, { tokenIn: B, tokenOut: A }].map((leg, i) => ({
    ...leg, program, ...(modes[i] === undefined ? {} : { inputMode: modes[i] }) }));
  const node: ResolvedPlanNode = { adapterId: "runtime-amount-flow", target: ACTOR,
    tokenIn: A, tokenOut: A, amount: 100n, children: [],
    params: { legs: JSON.stringify(legs), quoteToleranceRawUnits: tolerance, minimumReturn: 101n } };
  return runtimeAmountFlowAdapter.encode(node, ACTOR, new Uint8Array());
}
test("legacy exact-input flow bytes are unchanged", () => {
  const bytes = ethers.getBytes(program);
  const leg = (input: string, output: string, floor: bigint) => concatBytes(addressToBytes(input), addressToBytes(output), uint256ToBytes(floor), uint24ToBytes(bytes.length), bytes);
  for (const tolerance of [0n, 1n]) {
    const data = concatBytes(uint256ToBytes(100n), new Uint8Array([2 | (Number(tolerance) << 7)]), leg(A, B, 1n), leg(B, A, 101n));
    assert.deepEqual(encode([], tolerance), concatBytes(new Uint8Array([12]), uint24ToBytes(data.length), data));
  }
});
test("maximum-input opt-in is an explicit per-leg mask, independent of 0/1 rounding", () => {
  for (const [modes, mask] of [[["maximum"], 1], [[undefined, "maximum"], 2], [["maximum", "maximum"], 3]] as const) {
    for (const tolerance of [0n, 1n]) {
      const output = encode([...modes], tolerance);
      assert.equal(output[36], 0x42 | (Number(tolerance) << 7));
      assert.equal(output[37], mask);
      assert.equal(output.length, encode([], tolerance).length + 1);
      assert.deepEqual(output.slice(38), encode([], tolerance).slice(37));
    }
  }
});
test("unknown input policies are not silently treated as permissive", () => {
  for (const mode of [null, true, 1, "partial", "exact", {}]) assert.throws(() => encode([mode]), /runtime input mode/);
});
test("maximum-input does not broaden the rounding or final-return policy", () => {
  assert.throws(() => encode(["maximum"], 2n));
});

test("production amount selection carries the per-leg policy into encoded trials without Exact or quoted fallback", async () => {
  const source = { number: 1234, hash: "0x" + "ab".repeat(32), generation: 1 };
  const edges = [{ adapterId: "budget-fixture", target: ACTOR, tokenIn: A, tokenOut: B },
    { adapterId: "exact-fixture", target: ACTOR, tokenIn: B, tokenOut: A }];
  let exact = 0, quoted = 0, simulated = 0;
  const modes: unknown[] = [];
  const session: any = {
    source, fundingActionIds: () => ["fixture-funding"],
    buildRuntimeAmountLeg({ edge }: any) {
      return { actionAdapterId: edge.adapterId, program,
        ...(edge === edges[0] ? { inputMode: "maximum" } : {}) };
    },
    issueExact() { exact++; throw new Error("unexpected off-chain Exact"); },
    buildExecution() { quoted++; throw new Error("unexpected quoted fallback"); },
    buildFundingRoot(input: any) {
      return { adapterId: "fixture-funding", target: ACTOR, tokenIn: A, tokenOut: A,
        amount: input.amount, params: {}, children: input.children };
    },
  };
  const selector = createBlockScanSimAmountSelector({ source, executor: ACTOR,
    record(event) { if (event.type === "sim_amount_construction") modes.push(event.mode); },
    async simulate(plan) {
      simulated++;
      const flow = plan.root.children[0]!;
      const legs = JSON.parse(flow.params.legs as string);
      assert.equal(legs[0].inputMode, "maximum");
      assert.equal(legs[1].inputMode, undefined);
      const encoded = runtimeAmountFlowAdapter.encode(flow, ACTOR, new Uint8Array());
      assert.equal(encoded[36], 0x42);
      assert.equal(encoded[37], 1);
      assert.equal(flow.params.minimumReturn, plan.flashAmount + 1n);
      return { success: true, grossProfit: 1n, netProfit: 1n, gasUsed: 1n, profitToken: A, calldata: "0x" };
    },
  });
  await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
    flashToken: A, profitToken: A }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "input-budget-fixture" } as any,
    { call() { throw new Error("unexpected RPC"); } } as any, { executor: ACTOR } as any,
    { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
  assert.equal(exact, 0); assert.equal(quoted, 0);
  assert(simulated >= 6, "coarse and fine trials use the actual production selector");
  assert(modes.length > 0 && modes.every(mode => mode === "runtime-actual"));
});
