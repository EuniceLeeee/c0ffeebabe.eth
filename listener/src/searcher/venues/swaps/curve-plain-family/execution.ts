import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { executionData } from "./codec.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { MAX_UINT, pullsInput, isNativeCoin, isNativeMode } from "./codec.js";
import { nativeExchangeProgram } from "./native.js";
import { actionId, assertRoute } from "./routes.js";
import type { CurvePlainDescriptor, CurvePlainExactEvidence, CurvePlainRoute } from "./types.js";

export const curvePlainExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertRoute(d, r); runtimeExecutor(executor, d.pool);
    if (isNativeMode(r.executionMode)) return runtimeLeg(actionId(r.executionMode), nativeExchangeProgram(
      d.pool, r.tokenIn, r.tokenOut, r.i, r.j, r.executionMode, executor, isNativeCoin(d.binding.coins[r.i])));
    const p = new RuntimeAmountProgram(), pulls = pullsInput(r.executionMode);
    if (pulls) p.allowance(r.tokenIn, d.pool, 0, MAX_UINT);
    else {
      // Measure this transfer's receipt; existing pool inventory is not its input.
      const balance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [d.pool]);
      p.call(r.tokenIn, balance, { static: true }).load(1, 0)
        .call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("transfer", [d.pool, 0n]), { patches: [{ offset: 36, reg: 0 }] })
        .call(r.tokenIn, balance, { static: true }).load(2, 0).math("sub", 3, 2, 1);
    }
    p.call(d.pool, executionData(r.executionMode, r.i, r.j, 0n, 1n, executor),
      { patches: [{ offset: 68, reg: pulls ? 0 : 3 }] });
    return runtimeLeg(actionId(r.executionMode), p);
  },
  runtimeProjection: ({ hop }) => ({ allowanceSpender: ["curve-exchange-plain", "curve-exchange-uint"].includes(hop.adapterId) ? hop.target : null,
    prewarmQuoteCalls: [] }),
  buildFragment(input) {
    assertRoute(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (input.amountIn <= 0n || input.amountIn > MAX_UINT || input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
      evidence.kind !== "curve-plain-get-dy" || evidence.quoteAbi !== input.route.quoteAbi || evidence.binding !== input.route.bindingRef.fingerprint ||
      evidence.routeKey !== input.route.routeKey || evidence.amountIn !== input.amountIn || evidence.amountOut !== input.quotedAmountOut ||
      evidence.amountOut <= 0n) throw new Error("curve-plain incompatible exact execution evidence");
    if (isNativeMode(input.route.executionMode)) return { requirements: [], nodes: [{
      adapterId: actionId(input.route.executionMode), target: input.descriptor.pool,
      tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
      params: { i: BigInt(input.route.i), j: BigInt(input.route.j), minDy: input.minAmountOut > 0n ? input.minAmountOut : 1n,
        nativeIn: isNativeCoin(input.descriptor.binding.coins[input.route.i]) }, children: [] }] };
    const regular = pullsInput(input.route.executionMode);
    return { requirements: regular
      ? [{ kind: "approve" as const, token: input.route.tokenIn, spender: input.descriptor.pool, amount: MAX_UINT }]
      : [{ kind: "transfer-to-pool" as const, token: input.route.tokenIn, pool: input.descriptor.pool, amount: input.amountIn }],
      nodes: [{ adapterId: actionId(input.route.executionMode), target: input.descriptor.pool,
        tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
        params: { i: BigInt(input.route.i), j: BigInt(input.route.j), minDy: input.minAmountOut, receiver: input.executor }, children: [] }] };
  },
  expectedEffects: ({ route }) => isNativeMode(route.executionMode) ? [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ] : [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenIn, account: "route-target", direction: "increase" },
    { kind: "token-delta", token: route.tokenOut, account: "route-target", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<CurvePlainDescriptor, CurvePlainRoute, CurvePlainExactEvidence>;
