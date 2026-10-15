import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, runtimeExactApproval, runtimeClearApproval, RUNTIME_ERC20 } from "../../runtime-execution.js";
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
    const request = input.settlement, nativePair = d.poolKey.token0 === ethers.ZeroAddress;
    if (request && (request.kind !== "direct-output")) return null;
    const recipient = request ? runtimeExecutor(request.recipient, EKUBO_ROUTER, r.tokenIn, r.tokenOut) : executor;
    const nativeInput = nativePair && !r.isToken1;
    // Native output is received by the actor and delivered as measured WETH by
    // the common issuer. A raw Family call cannot bypass that boundary.
    if (request && nativePair && r.isToken1 && !same(recipient, executor)) return null;
    const nativeDirect = nativePair && request !== undefined;
    const erc20Direct = !nativePair && request !== undefined;
    const external = !same(recipient, executor);
    const actorBalance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [executor]);
    const receiverBalance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [recipient]);
    const p = new RuntimeAmountProgram().constant(1, 127n).math("shr", 2, 0, 1).constant(3, 0n).equal(2, 3);
    if (nativeDirect || erc20Direct) p.constant(4, 1n).math("sub", 5, 0, 4);
    if (erc20Direct) {
      p.call(r.tokenIn, actorBalance, { static: true }).load(6, 0).math("sub", 5, 6, 0)
        .call(r.tokenOut, actorBalance, { static: true }).load(7, 0).nativeBalance(10);
      if (external) p.call(r.tokenIn, receiverBalance, { static: true }).load(8, 0)
        .call(r.tokenOut, receiverBalance, { static: true }).load(9, 0);
    }
    if (!nativeInput) {
      if (nativeDirect || erc20Direct) runtimeExactApproval(p, r.tokenIn, EKUBO_ROUTER);
      else p.allowance(r.tokenIn, EKUBO_ROUTER, 0, MAX_UINT);
    }
    p.call(EKUBO_ROUTER, ekuboRouterIface.encodeFunctionData("swap", [d.poolKey, r.isToken1, 0n, 0n, 0n, 1n, recipient]),
      { patches: [{ offset: 132, reg: 0 }], ...(nativeInput ? { valueReg: 0 } : {}) });
    if (erc20Direct) {
      // Router returns delta0 in the high signed int128 and delta1 in the low.
      p.load(11, 0).constant(1, 128n).math("shr", 12, 11, 1)
        .constant(1, (1n << 128n) - 1n).math("and", 11, 11, 1)
        .equal(r.isToken1 ? 11 : 12, 0)
        .constant(1, 1n << 128n).math("sub", 12, 1, r.isToken1 ? 12 : 11)
        .constant(1, 127n).math("shr", 13, 12, 1).constant(1, 0n).equal(13, 1)
        .constant(1, 1n).math("sub", 13, 12, 1);
    }
    if ((nativeDirect || erc20Direct) && !nativeInput) {
      runtimeClearApproval(p, r.tokenIn, EKUBO_ROUTER);
      const approval = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);
      p.call(r.tokenIn, approval.encodeFunctionData("allowance", [executor, EKUBO_ROUTER]), { static: true })
        .load(4, 0).constant(5, 0n).equal(4, 5);
    }
    if (erc20Direct) {
      // Check actual token receipts independently of the Router return word.
      // The deployed Router enforces full fill; these guards also protect
      // against token effects consuming inventory or crediting another actor.
      p.call(r.tokenIn, actorBalance, { static: true }).load(4, 0).math("sub", 4, 6, 4).equal(4, 0);
      if (external) p.call(r.tokenOut, actorBalance, { static: true }).load(4, 0).equal(4, 7)
        .call(r.tokenIn, receiverBalance, { static: true }).load(4, 0).equal(4, 8)
        .call(r.tokenOut, receiverBalance, { static: true }).load(4, 0).math("sub", 4, 4, 9);
      else p.call(r.tokenOut, actorBalance, { static: true }).load(4, 0).math("sub", 4, 4, 7);
      p.equal(4, 12).nativeBalance(4).equal(4, 10);
    }
    return { ...runtimeLeg(EKUBO_ACTION_ID, p), settlement: { directOutput: true as const },
      ...(request ? { settlementRequest: request } : {}) };
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
