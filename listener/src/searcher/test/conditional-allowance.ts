import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { erc20ApproveAdapter } from "../../adapters/erc20.js";
import type { ResolvedPlanNode } from "../../types.js";
import type { StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { EXECUTOR, makePlans, sharedSession } from "./blockscan-solver-quote-concurrency.js";
const token = `0x${"11".repeat(20)}`, spender = `0x${"22".repeat(20)}`;
const noState = {} as StateBackend;
const node = (minimum: unknown = 100n, grant = 200n): ResolvedPlanNode => ({ adapterId: "erc20-approve",
  target: token, tokenIn: token, tokenOut: token, amount: grant,
  params: { spender, amount: grant, ...(minimum === undefined ? {} : { minimumAllowance: minimum as bigint }) }, children: [] });

test("conditional allowance encodes minimum separately from the unchanged grant", () => {
  const data = erc20ApproveAdapter.encode(node(), EXECUTOR, new Uint8Array());
  assert.equal(data.length, 105); assert.equal(data[0], 10);
  assert.equal(ethers.hexlify(data.slice(1, 21)), token);
  assert.equal(ethers.hexlify(data.slice(21, 41)), spender);
  assert.equal(BigInt(ethers.hexlify(data.slice(41, 73))), 100n);
  assert.equal(BigInt(ethers.hexlify(data.slice(73))), 200n);
});
test("raw approvals/revocations remain explicit and conditional invalid bounds reject", () => {
  const raw = node(); delete raw.params.minimumAllowance;
  assert.equal(erc20ApproveAdapter.encode(raw, EXECUTOR, new Uint8Array())[0], 0);
  assert.equal(erc20ApproveAdapter.encode({ ...raw, amount: 0n, params: { spender, amount: 0n } }, EXECUTOR, new Uint8Array())[0], 0);
  for (const bad of [node(0n), node(-1n), node(201n), node("100"), node(1n, 1n << 256n),
    { ...node(), target: ethers.ZeroAddress }, { ...node(), params: { ...node().params, spender: ethers.ZeroAddress } }]) {
    assert.throws(() => erc20ApproveAdapter.encode(bad, EXECUTOR, new Uint8Array()), /conditional ERC20 allowance/);
  }
});

for (const tolerance of [0n, 1n]) for (const grant of ["finite", "unlimited"]) {
  test(`shared builder keeps each ${grant} requirement at spend time, tolerance=${tolerance}`, async () => {
    const plan = makePlans(1)[0]!;
    const fixture = sharedSession([plan], { toleranceRawUnits: tolerance });
    const session = { ...fixture.session,
      buildExecution(input: Parameters<StrictProductionRuntimeSession["buildExecution"]>[0]) {
        const result = fixture.session.buildExecution(input);
        if (result.status !== "resolved") throw new Error("unresolved fixture");
        return { ...result, fragment: { ...result.fragment, requirements: [{ kind: "approve" as const,
          token: input.edge.tokenIn, spender, amount: grant === "unlimited" ? ethers.MaxUint256 : result.fragment.nodes[0]!.amount }] } };
      },
    } as unknown as StrictProductionRuntimeSession;
    const propagated = await propagateAmountsWithRawOutputs(plan.tokenPath, 10000n, noState,
      { executor: EXECUTOR, strictSession: session, toleranceRawUnits: tolerance });
    const root = await buildResolvedPlanFromPath(plan.tokenPath, plan.opportunity.startToken, 10000n,
      propagated.amounts, EXECUTOR, noState, 1n, "morpho-flash", propagated.rawOutputs, session,
      propagated.exactHandles, tolerance);
    const branches = plan.tokenPath.edges.map((_edge, i) => ({ amount: propagated.amounts[i], children: root.children.slice(2 * i, 2 * i + 2) }));
    assert.equal(root.children.length, 4, "one conditional approval and nominal action per leg; no flow wrapper");
    for (const branch of branches) {
      const approval = branch.children[0]!;
      assert.equal(approval.adapterId, "erc20-approve");
      assert.equal(approval.params.minimumAllowance, branch.amount);
      assert.equal(approval.amount, grant === "unlimited" ? ethers.MaxUint256 : branch.amount);
      assert.equal(erc20ApproveAdapter.encode(approval, EXECUTOR, new Uint8Array())[0], 10);
    }
  });
}
