import assert from "node:assert/strict";
import { ethers } from "ethers";
import { EXECUTION, DISCOVERY_MODES, executionFunction, lower } from "../codec.js";
import { curveReadyTargetHasSwap } from "./historical-ready.js";
/** A historical nomination is provenance, not execution acceptance. A successful
 * nested call can be rolled back by an ancestor while the top-level tx succeeds.
 * Current production strict identity and the new actual execution remain required. */
export function recipientNomination(receipt: any, pool: string, trace?: any) {
  assert.equal(BigInt(receipt.status), 1n); const target = lower(pool);
  if (curveReadyTargetHasSwap(receipt.logs, target, ["curve-plain"])) return { kind: "committed-swap-log", transaction: receipt.transactionHash, target };
  assert(trace && lower(trace.from) === lower(receipt.from) && lower(trace.to) === lower(receipt.to) && !trace.error, "trace/receipt root mismatch");
  const matches: any[] = [];
  const visit = (node: any, path: number[], ancestorErrors: { path: number[]; error: string }[]) => {
    if (node.type === "CALL" && node.to && lower(node.to) === target && !node.error) {
      for (const mode of DISCOVERY_MODES) {
        const iface = EXECUTION[mode], fn = executionFunction(mode), selector = iface.getFunction(fn)!.selector;
        if (!node.input?.startsWith(selector)) continue;
        try {
          const args = iface.decodeFunctionData(fn, node.input);
          if (iface.encodeFunctionData(fn, args).toLowerCase() !== node.input.toLowerCase()) continue;
          if (args[0] < 0n || args[0] >= 8n || args[1] < 0n || args[1] >= 8n || args[0] === args[1] || args[2] <= 0n) continue;
          matches.push({ path, from: lower(node.from), to: target, input: node.input, output: node.output ?? "0x", mode, i: Number(args[0]), j: Number(args[1]), amountIn: BigInt(args[2]).toString(), ancestorReverted: ancestorErrors.length > 0, ancestorErrors }); break;
        } catch { /* Not this declared ABI; no candidate or execution is synthesized. */ }
      }
    }
    const errors = node.error ? [...ancestorErrors, { path, error: String(node.error) }] : ancestorErrors;
    (node.calls ?? []).forEach((child: any, index: number) => visit(child, [...path, index], errors));
  };
  visit(trace, [], []); assert(matches.length > 0, "no successful declared historical pool call");
  return { kind: "observed-call-nomination", transaction: receipt.transactionHash, target, calls: matches,
    originalPersistentSwapProven: false, claim: "Call provenance only; ancestor rollback is retained. This is not original opportunity success." };
}
