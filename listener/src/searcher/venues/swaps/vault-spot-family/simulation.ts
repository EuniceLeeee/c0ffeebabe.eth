import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import type { AdapterRequest, AdapterRequestResult, RequestRequirements } from "../../adapter-request-program.js";
import { returnedResult } from "../../protocols/standard-family/common.js";
import { ABI, address, amount } from "./codec.js";
import { swapProgram } from "./runtime.js";
import { decodeSwapLog } from "./discovery.js";
import type { Descriptor, Route } from "./types.js";
export const simulationRequirements: RequestRequirements = { transports: ["effect-delta-simulation"], caller: "executor",
  effects: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] };
export function simulationRequest(d: Descriptor, r: Route, input: bigint, executor: string): AdapterRequest {
  amount(input); const caller = { kind: "executor" as const };
  return { id: "spot-exact", kind: "effect-delta-simulation", call: { caller, executionMode: "executor-program", to: executor,
    data: ABI.encodeFunctionData("execSubscript", [runtimeProgramScript(swapProgram(d.vault, r.tokenIn, r.tokenOut, executor, 1n).bytes(), input)]) },
    overrideIntent: { caller, tokenBalances: [{ token: r.tokenIn, amount: input }] },
    observeTokenBalances: [r.tokenIn, r.tokenOut].flatMap(token => [{ token, account: caller }, { token, account: d.vault }]),
    observeTotalSupplies: [r.tokenIn, r.tokenOut], observe: simulationRequirements.effects! };
}
export function decodeReceipt(rs: readonly AdapterRequestResult[], d: Descriptor, r: Route, input: bigint, executor: string): bigint {
  const result = returnedResult(rs, "spot-exact"), e = result.effects;
  if (!e || e.tokenDeltas?.length !== 4 || e.totalSupplyDeltas?.length !== 2 || e.nativeDeltas?.length !== 1)
    throw new Error("vault-spot missing effect scope");
  const actor = address(executor), delta = (token: string, account: string) => {
    const found = e.tokenDeltas!.filter(x => address(x.token) === token && address(x.account) === account);
    if (found.length !== 1) throw new Error("vault-spot duplicate or missing balance"); return found[0].delta;
  };
  const out = amount(delta(r.tokenOut, actor));
  if (delta(r.tokenIn, actor) !== -input || delta(r.tokenIn, d.vault) !== input || delta(r.tokenOut, d.vault) !== -out ||
      [r.tokenIn, r.tokenOut].some(t => e.totalSupplyDeltas!.filter(x => address(x.token) === t && x.delta === 0n).length !== 1) ||
      address(e.nativeDeltas[0].account) !== actor || e.nativeDeltas[0].delta !== 0n) throw new Error("vault-spot debit/credit/native/supply mismatch");
  const logs = (e.logs ?? []).filter(l => address(l.address) === d.vault).map(decodeSwapLog).filter(x => x !== null);
  if (logs.length !== 1 || logs[0].account !== actor || logs[0].tokenIn !== r.tokenIn || logs[0].tokenOut !== r.tokenOut ||
      logs[0].amountIn !== input || logs[0].amountOut !== out) throw new Error("vault-spot event mismatch");
  return out;
}
