import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { Interface } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { address, MODULE, SET, TOKEN, uint, WAD } from "./codec.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import type { Descriptor, Evidence, Route } from "./types.js";
const SUBSCRIPT = new Interface(["function execSubscript(bytes)"]);
export const execution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertRoute(d, r);
    const actor = runtimeExecutor(executor, d.set, d.module, d.controller, ...d.components);
    // Each invocation has <=125 instructions and r4..r11 for eight receipts.
    // Parent thresholds stay live across the existing executor-only self call;
    // only the innermost invocation redeems. No basket component is truncated.
    // Construct from inside out, so the existing 64KiB check bounds the entire
    // nested payload. Oversize fails closed; it never silently selects Exact.
    let nested: RuntimeAmountProgram | undefined;
    for (let first = Math.floor((d.components.length - 1) / 8) * 8; first >= 0; first -= 8) {
      const end = Math.min(first + 8, d.components.length), p = new RuntimeAmountProgram();
      p.call(d.set, SET.encodeFunctionData("getComponents"), { static: true })
        .load(2, 32).constant(3, BigInt(d.components.length)).equal(2, 3);
      for (let n = first; n < end; n++)
        p.load(2, 64 + 32 * n).constant(3, BigInt(d.components[n])).equal(2, 3);
      p.constant(1, WAD).constant(15, (1n << 255n) - 1n);
      p.call(d.set, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(14, 0);
      for (let n = first; n < end; n++) {
        const token = d.components[n], threshold = 4 + n - first;
        // Real units are read before redemption, already multiplier-adjusted.
        // Checked multiplication and floor division match BasicIssuance redeem.
        p.call(d.set, SET.encodeFunctionData("getDefaultPositionRealUnit", [token]), { static: true })
          .load(2, 0).math("sub", 3, 15, 2)
          .math("mul", 2, 0, 2).math("div", 2, 2, 1)
          .call(token, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true })
          .load(threshold, 0).math("add", threshold, threshold, 2);
      }
      if (nested) {
        // execSubscript(bytes): script starts at 68, its 0x0e amount at 69.
        // Ordinary self call, NOT a protocol callback: no callback scope opened.
        p.call(actor, SUBSCRIPT.encodeFunctionData("execSubscript", [runtimeProgramScript(nested.bytes())]),
          { patches: [{ offset: 69, reg: 0 }] });
      } else {
        // Bound BasicIssuance entry point retains native eligibility/transfer
        // checks and burns caller Set. No approvals, fees or output routing added.
        p.call(d.module, MODULE.encodeFunctionData("redeem", [d.set, 0n, actor]),
          { patches: [{ offset: 36, reg: 0 }] });
      }
      p.call(d.set, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true })
        .load(2, 0).math("sub", 2, 14, 2).equal(2, 0);
      for (let n = first; n < end; n++)
        p.call(d.components[n], TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true })
          .load(2, 0).math("sub", 2, 2, 4 + n - first);
      nested = p;
    }
    // Thresholds guard EVERY basket receipt, including non-route components.
    // They never become the next hop's input: runtime-amount-flow measures the
    // actual receipt independently. Old inventory cannot cover an underpayment.
    if (!nested) throw new Error("set-redemption empty runtime basket");
    return runtimeLeg(ACTION, nested);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(i) {
    const d = i.descriptor, r = i.route, e = i.exactEvidence; assertRoute(d, r);
    uint(i.amountIn); uint(i.quotedAmountOut); uint(i.minAmountOut);
    if (!i.amountIn || !i.minAmountOut || i.minAmountOut > i.quotedAmountOut || e.kind !== "set-redemption-local-quote" ||
      e.binding !== r.bindingRef.fingerprint || e.routeKey !== r.routeKey || e.amountIn !== i.amountIn || e.executor !== address(i.executor) ||
      e.outputs.length !== d.components.length || e.outputs.some(v => uint(v) !== v) || e.outputs[d.components.indexOf(r.component)] !== i.quotedAmountOut)
      throw new Error("set-redemption execution evidence mismatch");
    return { requirements: [], nodes: [{ adapterId: ACTION, target: d.module, tokenIn: d.set, tokenOut: r.component, amount: i.amountIn, params: {}, children: [] },
      ...d.components.flatMap((t, n) => e.outputs[n] > 0n ? [{ adapterId: "assert-balance", target: t, tokenIn: t, tokenOut: t,
        amount: e.outputs[n], params: {}, children: [] }] : [])] };
  },
  expectedEffects: ({ descriptor: d, route: r }) => { assertRoute(d, r); return [
    { kind: "token-delta", token: d.set, account: "executor", direction: "decrease" },
    { kind: "total-supply-delta", token: d.set, direction: "decrease" },
    ...d.components.map(token => ({ kind: "token-delta" as const, token, account: "executor" as const, direction: "increase" as const })),
  ]; },
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
