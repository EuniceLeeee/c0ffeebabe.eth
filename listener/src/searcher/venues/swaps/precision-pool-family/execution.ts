import { ethers } from "ethers";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { checked, lower, sourceEqual } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { executionProgram } from "./runtime-execution.js";
import type { Descriptor, Evidence, Route } from "./types.js";
export const execution = {
  buildRuntimeLeg({ descriptor: d, route: r, executor, settlement }) {
    assertRoute(d, r);
    if (settlement !== undefined && settlement.kind !== "direct-output") return null;
    const rawIn = r.zeroForOne ? d.token0 : d.token1, rawOut = r.zeroForOne ? d.token1 : d.token0;
    // The common asset boundary delivers WETH to the requested graph receiver.
    // A raw native-output operation must first return ETH to the executor.
    if (settlement && rawOut === ethers.ZeroAddress && lower(settlement.recipient) !== lower(executor)) return null;
    return { actionAdapterId: ACTION, program: ethers.hexlify(executionProgram({ pool: d.pool,
      rawIn, rawOut, executor, minimum: 1n, ...(settlement ? { recipient: settlement.recipient } : {}) })),
      settlement: { directOutput: true }, ...(settlement ? { settlementRequest: settlement } : {}) };
  },
  // The program itself grants allowance only for the raw ERC20-input branch.
  runtimeProjection: () => ({ allowanceSpender: null, prewarmQuoteCalls: [] }),
  buildFragment(i) {
    const d = i.descriptor, r = i.route, e = i.exactEvidence;
    assertRoute(d, r); sourceEqual(e.source, e.source);
    checked(i.amountIn); checked(i.quotedAmountOut); checked(i.minAmountOut);
    if (!i.amountIn || !i.minAmountOut || i.minAmountOut > i.quotedAmountOut || e.kind !== "precision-pool-chain-quote" ||
        e.routeKey !== r.routeKey || e.binding !== r.bindingRef.fingerprint || e.amountIn !== i.amountIn ||
        e.amountOut !== i.quotedAmountOut || e.executor !== lower(i.executor)) throw new Error("precision-pool incompatible execution evidence");
    return { requirements: [], nodes: [{ adapterId: ACTION, target: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amount: i.amountIn,
      params: { rawIn: r.zeroForOne ? d.token0 : d.token1, rawOut: r.zeroForOne ? d.token1 : d.token0,
        executor: lower(i.executor), minimum: i.minAmountOut }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
