import { AbiCoder, Interface, getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { runtimeSettlementFlowHash } from "../../adapters/runtime-amount-program.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { ResolvedPlan } from "../solver/solver.js";
import { validateEthSimulateV1ExecutionInput, type EthSimulateV1ExecutionInput } from "./eth-simulate-v1.js";

export const HOP_DIAGNOSTIC_SLOT = keccak256(toUtf8Bytes("BotVM.runtime.hop.diagnostic.key.v1"));
const ABI = new Interface(["error RuntimeHopFailed(uint256 hop,address target,bytes32 flowHash,bytes reason,bytes32 proof)"]);

/** Compatibility detection only. Production freezes the locally built executor
 * code at startup; a remote contract/selector is never the code authority. */
export function supportsHopDiagnostics(code: string): boolean {
  return code.toLowerCase().includes(HOP_DIAGNOSTIC_SLOT.slice(2));
}

export interface DirectRevertEvidence {
  readonly executionInput: EthSimulateV1ExecutionInput;
  readonly returnData: string;
  readonly errorData?: string;
  readonly gasUsed: string;
}

/** Only our authenticated hop envelope is interpreted. Pool/token/funding
 * revert bytes inside `reason` are opaque, including lookalike custom errors.
 * The flow hash binds P, every leg and the return floors to the original plan. */
export function directRevertedRuntimeHop(plan: ResolvedPlan, edges: readonly TokenEdge[], saved: DirectRevertEvidence): {
  hopIndex: number; callTarget: string; rawReason: string;
} | null {
  try {
    // Rebuild the canonical snapshot: the route witness must bind the actual
    // calldata and simulation payload, not only a parallel scriptHex field.
    const input = validateEthSimulateV1ExecutionInput(saved.executionInput);
    if ((input.schemaVersion !== 4 && input.schemaVersion !== 6) || !input.diagnosticKey || /^0x0{64}$/i.test(input.diagnosticKey) || !input.executorRuntimeCode ||
        !supportsHopDiagnostics(input.executorRuntimeCode.code)) return null;
    // Providers may put bytes in either field. Conflicting nonempty results
    // cannot supply a trustworthy attribution.
    if (saved.errorData && saved.errorData !== "0x" && saved.returnData !== "0x" &&
        saved.errorData.toLowerCase() !== saved.returnData.toLowerCase()) return null;
    const bytes = saved.returnData === "0x" ? saved.errorData : saved.returnData;
    if (!bytes) return null;
    const flows: ResolvedPlan["root"][] = [];
    const visit = (node: ResolvedPlan["root"]): void => {
      if (node.adapterId === "runtime-amount-flow") flows.push(node);
      node.children.forEach(visit);
    };
    visit(plan.root);
    const flow = flows[0];
    if (flows.length !== 1 || !flow || flow.amount !== plan.flashAmount || typeof flow.params.legs !== "string") return null;
    const legs = JSON.parse(flow.params.legs) as { tokenIn: string; tokenOut: string; program: string }[];
    if (!Array.isArray(legs) || legs.length !== edges.length || legs.some((leg, i) =>
      leg.tokenIn.toLowerCase() !== edges[i]!.tokenIn.toLowerCase() ||
      leg.tokenOut.toLowerCase() !== edges[i]!.tokenOut.toLowerCase())) return null;
    const script = compilePlan(flow, input.executor);
    const settlement = typeof flow.params.settlementProgram === "string";
    if (script[0] !== (settlement ? 14 : 12) || typeof flow.params.minimumReturn !== "bigint" ||
        hexlify(compilePlan(plan.root, input.executor)) !== input.scriptHex.toLowerCase()) return null;
    const expectedFlow = settlement
      ? runtimeSettlementFlowHash(flow.amount, flow.params.minimumReturn, legs)
      : keccak256(script.slice(4));
    const decode = (raw: string) => {
      try {
        const decoded = ABI.parseError(raw);
        if (!decoded || ABI.encodeErrorResult(decoded.fragment, decoded.args).toLowerCase() !== raw.toLowerCase()) return null;
        const [hop, target, flowHash, reason, proof] = decoded.args;
        if (hop < 0n || hop >= BigInt(edges.length) || flowHash.toLowerCase() !== expectedFlow || getBytes(target).length !== 20) return null;
        const expected = keccak256(AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "uint256", "address", "bytes32", "bytes32"],
          [input.diagnosticKey, hop, target, flowHash, keccak256(reason)],
        ));
        if (expected !== proof.toLowerCase()) return null;
        return { hopIndex: Number(hop), callTarget: target.toLowerCase(), rawReason: reason.toLowerCase() };
      } catch { return null; }
    };
    let result = decode(bytes);
    if (!result) return null;
    if (settlement) {
      // Only independently authenticated nested envelopes may move attribution
      // into a callback's prefix. External lookalike errors remain opaque.
      for (let depth = 0; depth < 8; depth++) {
        const child = decode(result.rawReason);
        if (!child) break;
        result = child;
        if (depth === 7 && decode(result.rawReason)) return null;
      }
      // A deferred venue may replace the callback's error. Its outer failure
      // alone cannot prove whether that venue or an upstream payment failed.
      // Preserve the original response; reject the route, not a guessed pool.
      if (result.hopIndex === edges.length - 1) return null;
    }
    return result;
  } catch { return null; }
}
