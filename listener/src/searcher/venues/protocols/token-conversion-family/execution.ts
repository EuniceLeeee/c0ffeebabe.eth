import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, runtimeExactApproval, runtimeClearApproval } from "../../runtime-execution.js";
import { ABI } from "./variants.js";
import { XWIN_ABI, XWIN_SLIPPAGE } from "./xwin.js";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { sameAddress } from "../standard-family/common.js";
import { assertInvocation } from "./binding.js";
import { positiveAmount } from "./variants.js";
import type { ConversionDescriptor, ConversionRoute, ConversionExactEvidence } from "./types.js";
export const execution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertInvocation(d, r); runtimeExecutor(executor, d.target, d.asset);
    if (d.variant === "xwin-allocations-v1") {
      runtimeExecutor(executor, d.proxyAdmin);
      if (!input.transactionOrigin) throw new Error("xWin runtime requires transaction origin");
      runtimeExecutor(input.transactionOrigin);
    }
    const p = new RuntimeAmountProgram(), mint = r.direction === "mint";
    if (mint) runtimeExactApproval(p, r.tokenIn, d.target);
    const data = d.variant === "btb-bear-v1" ? ABI.encodeFunctionData(r.direction, [0n])
      : XWIN_ABI.encodeFunctionData(mint ? "deposit" : "withdraw", [0n, XWIN_SLIPPAGE]);
    p.call(d.target, data, { patches: [{ offset: 4, reg: 0 }] });
    if (mint) runtimeClearApproval(p, r.tokenIn, d.target);
    return runtimeLeg(r.adapterId, p);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(i) {
    assertInvocation(i.descriptor, i.route); positiveAmount(i.amountIn); positiveAmount(i.quotedAmountOut);
    const e = i.exactEvidence;
    // The central execution issuer validates the exact handle's canonical
    // source/session before exposing its evidence to this Family slot.
    if (e.kind !== "token-conversion-balance-quote" || e.direction !== i.route.direction ||
        e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut || !sameAddress(e.executor, i.executor) ||
        e.bindingFingerprint !== i.route.bindingRef.fingerprint) throw new Error("conversion execution evidence mismatch");
    return { requirements: [], nodes: [{ adapterId: i.route.adapterId, target: i.descriptor.target,
      tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut, amount: i.amountIn,
      params: { variant: i.descriptor.variant }, children: [] }] };
  },
  expectedEffects: ({ route }) => [
    { kind: "token-delta", token: route.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: route.tokenOut, account: "executor", direction: "increase" },
  ],
} satisfies ExecutionSemantics<ConversionDescriptor, ConversionRoute, ConversionExactEvidence>;
