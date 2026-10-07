import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, runtimeWrapReceipt, RUNTIME_WRAP } from "../../runtime-execution.js";
import { POOL } from "./codec.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import type { ResolvedPlanNode } from "../../../../types.js";
import { MAX_UINT, same } from "./codec.js";
import { actionId, assertRoute } from "./routes.js";
import type { EllaDescriptor, EllaEvidence, EllaRoute } from "./types.js";

export const ellaExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertRoute(d, r); runtimeExecutor(executor, d.pool);
    const p = new RuntimeAmountProgram(), buy = r.direction === "buy-token";
    if (buy) {
      p.call(ADDR.WETH, RUNTIME_WRAP.encodeFunctionData("withdraw", [0n]), { patches: [{ offset: 4, reg: 0 }] })
        .call(d.pool, POOL.encodeFunctionData("swapBase1"), { valueReg: 0 });
    } else {
      p.allowance(r.tokenIn, d.pool, 0, MAX_UINT).nativeBalance(13)
        .call(d.pool, POOL.encodeFunctionData("swap1", [0n]), { patches: [{ offset: 4, reg: 0 }] });
      runtimeWrapReceipt(p, ADDR.WETH);
    }
    return runtimeLeg(actionId(r.direction), p);
  },
  runtimeProjection: ({ hop }) => ({ allowanceSpender: hop.adapterId === "ella-sell-token" ? hop.target : null, prewarmQuoteCalls: [] }),
  buildFragment(i) {
    assertRoute(i.descriptor, i.route);
    const e = i.exactEvidence;
    if (i.amountIn <= 0n || i.amountIn > MAX_UINT || i.quotedAmountOut <= 0n || i.minAmountOut < 0n || i.minAmountOut > i.quotedAmountOut ||
        e.kind !== "ella-source-math" || e.unavailableReason || e.binding !== i.route.bindingRef.fingerprint ||
        e.routeKey !== i.route.routeKey || e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut || !same(e.executor, i.executor)) {
      throw new Error("ella incompatible execution evidence");
    }
    const buy = i.route.direction === "buy-token";
    const swap: ResolvedPlanNode = { adapterId: actionId(i.route.direction), target: i.descriptor.pool,
      tokenIn: buy ? ADDR.ZERO : i.descriptor.token, tokenOut: buy ? i.descriptor.token : ADDR.ZERO,
      amount: i.amountIn, params: {}, children: [] };
    const wrap: ResolvedPlanNode = { adapterId: buy ? "weth-withdraw-amount" : "weth-deposit-value", target: ADDR.WETH,
      tokenIn: buy ? ADDR.WETH : ADDR.ZERO, tokenOut: buy ? ADDR.ZERO : ADDR.WETH,
      amount: buy ? i.amountIn : i.quotedAmountOut, params: {}, children: [] };
    // No native minOut function exists. The common executor amount propagation
    // and mandatory terminal balance/repayment guard remain authoritative.
    return { requirements: buy ? [] : [{ kind: "approve" as const, token: i.descriptor.token, spender: i.descriptor.pool, amount: MAX_UINT }],
      nodes: buy ? [wrap, swap] : [swap, wrap] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<EllaDescriptor, EllaRoute, EllaEvidence>;
