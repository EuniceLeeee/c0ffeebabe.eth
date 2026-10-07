import { ethers } from "ethers";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg } from "../../runtime-execution.js";
import { ACTION } from "./manifest.js";
import { BPS, VAULT, STRATEGY, TOKEN, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import { assertActor } from "./state.js";
import type { Descriptor, Evidence, Route } from "./types.js";
// Construction depends ONLY on the verified route and actor. All amount/state
// operations below are VM instructions, never provider calls or offchain Exact.
export function withdrawProgram(d: Descriptor, executor: string, minimum?: bigint) {
  const actor = assertActor(d, executor), p = new RuntimeAmountProgram();
  for (const [target, abi, getter, expected] of [
    [d.vault, VAULT, "token", d.asset], [d.vault, VAULT, "strategy", d.strategy],
    [d.strategy, STRATEGY, "vault", d.vault], [d.strategy, STRATEGY, "want", d.asset],
    [d.strategy, STRATEGY, "LOCKER", d.locker],
  ] as const) p.call(target, abi.encodeFunctionData(getter), { static: true }).load(1, 0).constant(2, BigInt(expected)).equal(1, 2);
  p.call(d.vault, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(14, 0)
    .call(d.asset, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(13, 0)
    .call(d.vault, VAULT.encodeFunctionData("balance"), { static: true }).load(1, 0)
    .call(d.vault, VAULT.encodeFunctionData("totalSupply"), { static: true }).load(2, 0)
    .math("mul", 3, 1, 0).math("div", 3, 3, 2)
    .call(d.asset, TOKEN.encodeFunctionData("balanceOf", [d.vault]), { static: true }).load(4, 0)
    .call(d.asset, TOKEN.encodeFunctionData("balanceOf", [d.strategy]), { static: true }).load(5, 0)
    .math("add", 4, 4, 5).math("sub", 4, 4, 3)
    .call(d.vault, VAULT.encodeFunctionData("withdrawalFee"), { static: true }).load(5, 0)
    .constant(6, 200n).math("sub", 6, 6, 5)
    .math("mul", 5, 3, 5).constant(6, BPS).math("div", 5, 5, 6)
    .math("sub", 3, 3, 5).math("add", 12, 13, 3);
  // gross <= V+W is checked above: never enter unimplemented locker-unlock.
  // Native call retains branch-specific pause, SafeMath, fee-share mint,
  // caller balance and transparent-proxy restrictions. It returns NO amount.
  p.call(d.vault, VAULT.encodeFunctionData("withdraw", [0n]), { patches: [{ offset: 4, reg: 0 }] })
    .call(d.vault, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0)
    .math("sub", 1, 14, 1).equal(1, 0)
    .call(d.asset, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0)
    .math("sub", 2, 1, 12);
  if (minimum !== undefined) p.constant(2, uint(minimum)).math("add", 2, 13, 2).math("sub", 2, 1, 2);
  // The enclosing production runtime-amount-flow independently measures AURA
  // after-before for the next leg; neither this threshold nor old inventory is input.
  return p;
}
export const execution = {
  buildRuntimeLeg({ descriptor: d, route: r, executor }) { assertRoute(d, r); return runtimeLeg(ACTION, withdrawProgram(d, executor)); },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(i) {
    const d = i.descriptor, r = i.route, e = i.exactEvidence; assertRoute(d, r);
    const actor = assertActor(d, i.executor); uint(i.amountIn); uint(i.quotedAmountOut); uint(i.minAmountOut);
    // Canonical source/generation and the sealed Exact handle are checked by
    // the existing execution issuer; no consumer-provided source authority.
    if (!i.amountIn || !i.quotedAmountOut || !i.minAmountOut || i.minAmountOut > i.quotedAmountOut ||
        e.kind !== "badger-sett-liquid-local" || e.fingerprint !== r.bindingRef.fingerprint || e.routeKey !== r.routeKey ||
        e.executor !== actor || e.amountIn !== i.amountIn || e.amountOut !== i.quotedAmountOut) throw new Error("badger-sett execution evidence mismatch");
    return { requirements: [], nodes: [{ adapterId: ACTION, target: d.vault, tokenIn: d.vault, tokenOut: d.asset, amount: i.amountIn,
      params: { runtimeAmountProgram: ethers.hexlify(withdrawProgram(d, actor, i.minAmountOut).bytes()) }, children: [] }] };
  },
  expectedEffects: ({ descriptor: d, route: r }) => { assertRoute(d, r); return [
    { kind: "token-delta", token: d.vault, account: "executor", direction: "decrease" },
    { kind: "token-delta", token: d.asset, account: "executor", direction: "increase" },
  ]; },
} satisfies ExecutionSemantics<Descriptor, Route, Evidence>;
