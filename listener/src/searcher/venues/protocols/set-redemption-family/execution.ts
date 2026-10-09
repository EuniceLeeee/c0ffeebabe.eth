import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { Interface, hexlify } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { address, MODULE, SET, TOKEN, uint, WAD } from "./codec.js";
import { ACTION } from "./manifest.js";
import { actionId, assertRoute } from "./routes.js";
import { CORE, LEGACY_SET } from "./legacy.js";
import { legacyIssueRuntime } from "./issuance.js";
import type { Descriptor, Evidence, Route } from "./types.js";
const SUBSCRIPT = new Interface(["function execSubscript(bytes)"]);
// A legacy redemption burns the entire input, or fails. It never rounds the
// supplied amount down and silently leaves shares behind. The quoted variant
// additionally guards its source-bound minima against OLD inventory.
export function legacyRuntime(d: Descriptor, actor: string, minimums?: readonly bigint[]): RuntimeAmountProgram {
  if (!d.legacy || (minimums && minimums.length !== d.components.length)) throw new Error("set-legacy runtime binding");
  let nested: RuntimeAmountProgram | undefined;
  for (let first = Math.floor((d.components.length - 1) / 7) * 7; first >= 0; first -= 7) {
    const end = Math.min(first + 7, d.components.length), p = new RuntimeAmountProgram();
    p.call(d.set, LEGACY_SET.encodeFunctionData("getComponents"), { static: true }).load(2, 32).constant(3, BigInt(d.components.length)).equal(2, 3);
    for (let n = first; n < end; n++) p.load(2, 64 + 32 * n).constant(3, BigInt(d.components[n])).equal(2, 3);
    p.call(d.set, LEGACY_SET.encodeFunctionData("naturalUnit"), { static: true }).load(1, 0)
      .math("div", 12, 0, 1).math("mul", 2, 12, 1).equal(2, 0)
      .call(d.set, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(14, 0);
    for (let n = first; n < end; n++) {
      if (minimums) p.constant(2, minimums[n]);
      else p.call(d.set, LEGACY_SET.encodeFunctionData("getUnits"), { static: true })
        .load(2, 32).constant(3, BigInt(d.components.length)).equal(2, 3).load(2, 64 + 32 * n).math("mul", 2, 12, 2);
      p.call(d.components[n], TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true })
        .load(4 + n - first, 0).math("add", 4 + n - first, 4 + n - first, 2);
    }
    if (nested) p.call(actor, SUBSCRIPT.encodeFunctionData("execSubscript", [runtimeProgramScript(nested.bytes())]), { patches: [{ offset: 69, reg: 0 }] });
    else p.call(d.module, CORE.encodeFunctionData("redeemAndWithdrawTo", [d.set, actor, 0n, 0n]), { patches: [{ offset: 68, reg: 0 }] });
    p.call(d.set, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(2, 0).math("sub", 2, 14, 2).equal(2, 0);
    for (let n = first; n < end; n++) p.call(d.components[n], TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true })
      .load(2, 0).math("sub", 2, 2, 4 + n - first);
    nested = p;
  }
  if (!nested) throw new Error("set-legacy empty runtime basket");
  return nested;
}
export const execution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertRoute(d, r);
    const actor = runtimeExecutor(executor, d.set, d.module, d.controller, ...d.components);
    if (r.issue) {
      runtimeExecutor(actor, d.legacy!.factory, d.legacy!.vault, d.legacy!.issuance!.transferProxy);
      return runtimeLeg(actionId(d, r), legacyIssueRuntime(d, actor));
    }
    if (d.legacy) {
      runtimeExecutor(actor, d.legacy.factory, d.legacy.vault);
      return runtimeLeg(actionId(d), legacyRuntime(d, actor));
    }
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
    if (d.legacy) {
      const actor = runtimeExecutor(i.executor, d.set, d.module, d.controller, d.legacy.factory, d.legacy.vault, ...d.components,
        ...(d.legacy.issuance ? [d.legacy.issuance.transferProxy] : []));
      return { requirements: [], nodes: [{ adapterId: actionId(d, r), target: d.module, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amount: i.amountIn,
        params: { runtimeAmountProgram: hexlify((r.issue ? legacyIssueRuntime(d, actor, i.quotedAmountOut) : legacyRuntime(d, actor, e.outputs)).bytes()) }, children: [] }] };
    }
    return { requirements: [], nodes: [{ adapterId: ACTION, target: d.module, tokenIn: d.set, tokenOut: r.component, amount: i.amountIn, params: {}, children: [] },
      ...d.components.flatMap((t, n) => e.outputs[n] > 0n ? [{ adapterId: "assert-balance", target: t, tokenIn: t, tokenOut: t,
        amount: e.outputs[n], params: {}, children: [] }] : [])] };
  },
  expectedEffects: ({ descriptor: d, route: r }) => { assertRoute(d, r); if (r.issue) return [
    { kind: "token-delta", token: r.tokenIn, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: r.tokenOut, account: "executor", direction: "increase" },
    { kind: "total-supply-delta", token: d.set, direction: "increase" },
  ]; return [
    { kind: "token-delta", token: d.set, account: "executor", direction: "decrease" },
    { kind: "total-supply-delta", token: d.set, direction: "decrease" },
    ...d.components.map(token => ({ kind: "token-delta" as const, token, account: "executor" as const, direction: "increase" as const })),
  ]; },
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
