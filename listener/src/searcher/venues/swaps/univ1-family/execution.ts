import { directRecipientLeg } from "./recipient.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, runtimeWrapReceipt, runtimeExactApproval, runtimeClearApproval } from "../../runtime-execution.js";
import { POOL, WRAP } from "./codec.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { lower, MAX_UINT, sourceEqual, WETH } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import type { Descriptor, Evidence, Route } from "./types.js";
export const execution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertRoute(d, r); runtimeExecutor(executor, d.pool, d.issuer, d.token);
    const request = input.settlement;
    if (request?.kind === "quote-output" || request?.kind === "deferred-input") return null;
    if (request?.kind === "direct-output") return directRecipientLeg(d, r, executor, request);
    const p = new RuntimeAmountProgram();
    if (r.buy) {
      p.call(WETH, WRAP.encodeFunctionData("withdraw", [0n]), { patches: [{ offset: 4, reg: 0 }] })
        .call(d.pool, POOL.encodeFunctionData("ethToTokenSwapInput", [1n, MAX_UINT]), { valueReg: 0 });
    } else {
      // UNI and similar tokens store a finite-width allowance. An unlimited
      // uint256 grant is not an exact readback; use the existing temporary
      // register-sized approval primitive instead of weakening the VM check.
      runtimeExactApproval(p, r.tokenIn, d.pool);
      p.nativeBalance(13)
        .call(d.pool, POOL.encodeFunctionData("tokenToEthSwapInput", [0n, 1n, MAX_UINT]), { patches: [{ offset: 4, reg: 0 }] });
      runtimeWrapReceipt(p, WETH);
      runtimeClearApproval(p, r.tokenIn, d.pool);
    }
    return { ...runtimeLeg(ACTION, p), settlement: { directOutput: true } };
  },
  runtimeProjection: () => ({ allowanceSpender: null, prewarmQuoteCalls: [] }),
  buildFragment(i) {
    assertRoute(i.descriptor, i.route);
    const e = i.exactEvidence; sourceEqual(e.source, e.source);
    if (e.kind !== "univ1-execution-math" || e.binding !== i.route.bindingRef.fingerprint || e.routeKey !== i.route.routeKey ||
        e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut || e.executor !== lower(i.executor) ||
        i.amountIn <= 0n || i.quotedAmountOut <= 0n || i.minAmountOut <= 0n || i.minAmountOut > i.quotedAmountOut ||
        [i.descriptor.issuer, i.descriptor.pool, i.descriptor.token].includes(lower(i.executor))) throw new Error("univ1 incompatible execution evidence");
    return { requirements: i.route.buy ? [] : [{ kind: "approve" as const, token: i.descriptor.token, spender: i.descriptor.pool, amount: i.amountIn }],
      nodes: [{ adapterId: ACTION, target: i.descriptor.pool, tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut, amount: i.amountIn,
        params: { buy: i.route.buy, amountOut: i.minAmountOut, executor: i.executor }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
