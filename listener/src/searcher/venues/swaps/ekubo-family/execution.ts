import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor } from "../../runtime-execution.js";
import { ekuboRouterIface } from "../ekubo/abi.js";
import { ethers } from "ethers";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { EKUBO_MAX_EXACT_INPUT, EKUBO_ROUTER } from "../ekubo/abi.js";
import { createEkuboPoolKeyBinding } from "../ekubo/pool-key.js";
import { assertSource, MAX_UINT, same } from "./codec.js";
import { EKUBO_ACTION_ID } from "./manifest.js";
import { assertRoute } from "./routes.js";
import type { EkuboDescriptor, EkuboExactEvidence, EkuboRoute } from "./types.js";

export const ekuboExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertRoute(d, r); runtimeExecutor(executor, EKUBO_ROUTER);
    const nativeInput = d.poolKey.token0 === ethers.ZeroAddress && !r.isToken1;
    const p = new RuntimeAmountProgram().constant(1, 127n).math("shr", 2, 0, 1).constant(3, 0n).equal(2, 3);
    if (!nativeInput) p.allowance(r.tokenIn, EKUBO_ROUTER, 0, MAX_UINT);
    p.call(EKUBO_ROUTER, ekuboRouterIface.encodeFunctionData("swap", [d.poolKey, r.isToken1, 0n, 0n, 0n, 1n, executor]),
      { patches: [{ offset: 132, reg: 0 }], ...(nativeInput ? { valueReg: 0 } : {}) });
    return runtimeLeg(EKUBO_ACTION_ID, p);
  },
  runtimeProjection: () => ({ allowanceSpender: EKUBO_ROUTER, prewarmQuoteCalls: [] }),
  buildFragment(input) {
    const { descriptor, route, exactEvidence: evidence } = input;
    assertRoute(descriptor, route);
    runtimeExecutor(input.executor, EKUBO_ROUTER);
    const nativeInput = descriptor.poolKey.token0 === ethers.ZeroAddress && !route.isToken1;
    if (nativeInput && input.amountIn >= (1n << 96n)) throw new Error("ekubo native input exceeds CALL_VALUE uint96");
    assertSource(evidence.source, evidence.source);
    if (input.amountIn <= 0n || input.amountIn > EKUBO_MAX_EXACT_INPUT || input.minAmountOut <= 0n ||
        input.minAmountOut > input.quotedAmountOut || evidence.kind !== "ekubo-router-exact-input" ||
        evidence.binding !== route.bindingRef.fingerprint || evidence.routeKey !== route.routeKey ||
        evidence.amountIn !== input.amountIn || evidence.amountOut !== input.quotedAmountOut || evidence.amountOut <= 0n ||
        !same(evidence.executor, input.executor)) throw new Error("ekubo incompatible exact execution evidence");
    return { requirements: nativeInput ? [] : [{ kind: "approve" as const, token: route.tokenIn, spender: EKUBO_ROUTER, amount: MAX_UINT }],
      nodes: [{ adapterId: EKUBO_ACTION_ID, target: EKUBO_ROUTER, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
        amount: input.amountIn, params: { ...descriptor.poolKey, poolId: descriptor.poolId,
          bindingHash: createEkuboPoolKeyBinding(descriptor.poolKey).hash, isToken1: route.isToken1,
          amountOutMin: input.minAmountOut, receiver: input.executor }, children: [] }] };
  },
  // The router is not pool custody. Core holds balances for many independent
  // pools; only the executor's two route-token deltas are the generic effects.
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<EkuboDescriptor, EkuboRoute, EkuboExactEvidence>;
