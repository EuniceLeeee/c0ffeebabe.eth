import { PROTOCOL_LEG_DESCRIPTORS } from "../../../adapters/protocol-legs.js";
import type { PlanBuildContext, PlanFragment } from "../route-leg-adapter.js";

const MAX_UINT = (1n << 256n) - 1n;

export async function buildDescriptorProtocolPlan(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn } = ctx;
  const descriptor = PROTOCOL_LEG_DESCRIPTORS.find((entry) => entry.id === edge.adapterId);
  if (!descriptor) throw new Error(`protocol plan descriptor not found for ${edge.adapterId}`);
  return {
    requirements: descriptor.needsApprove
      ? [{ kind: "approve", token: edge.tokenIn, spender: edge.target, amount: MAX_UINT }]
      : [],
    nodes: [{
      adapterId: edge.adapterId,
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: {},
      children: [],
    }],
  };
}
