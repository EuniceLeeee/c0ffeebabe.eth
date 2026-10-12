import { AbiCoder, Interface, getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";
import { compilePlan } from "../../shared/compiler/compiler.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { EthSimulateV1ExecutionInput } from "./eth-simulate-v1.js";

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
    const input = saved.executionInput;
    if (input.schemaVersion !== 4 || !input.diagnosticKey || !input.executorRuntimeCode ||
        !supportsHopDiagnostics(input.executorRuntimeCode.code)) return null;
    // Providers may put bytes in either field. Conflicting nonempty results
    // cannot supply a trustworthy attribution.
    if (saved.errorData && saved.errorData !== "0x" && saved.returnData !== "0x" &&
        saved.errorData.toLowerCase() !== saved.returnData.toLowerCase()) return null;
    const bytes = saved.returnData === "0x" ? saved.errorData : saved.returnData;
    if (!bytes) return null;
    const decoded = ABI.parseError(bytes);
    if (!decoded) return null;
    const [hop, target, flowHash, reason, proof] = decoded.args;
    if (hop < 0n || hop >= BigInt(edges.length)) return null;
    const expected = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32", "bytes32"],
      [input.diagnosticKey, hop, target, flowHash, keccak256(reason)],
    ));
    if (expected !== proof.toLowerCase()) return null;
    const flows: ResolvedPlan["root"][] = [];
    const visit = (node: ResolvedPlan["root"]): void => {
      if (node.adapterId === "runtime-amount-flow") flows.push(node);
      node.children.forEach(visit);
    };
    visit(plan.root);
    const flow = flows[0];
    if (flows.length !== 1 || !flow || flow.amount !== plan.flashAmount || typeof flow.params.legs !== "string") return null;
    const legs = JSON.parse(flow.params.legs) as { tokenIn: string; tokenOut: string }[];
    if (!Array.isArray(legs) || legs.length !== edges.length || legs.some((leg, i) =>
      leg.tokenIn.toLowerCase() !== edges[i]!.tokenIn.toLowerCase() ||
      leg.tokenOut.toLowerCase() !== edges[i]!.tokenOut.toLowerCase())) return null;
    const script = compilePlan(flow, input.executor);
    if (script[0] !== 12 || keccak256(script.slice(4)) !== flowHash.toLowerCase() ||
        hexlify(compilePlan(plan.root, input.executor)) !== input.scriptHex.toLowerCase()) return null;
    // Exact ABI encoding (no extra/trailing data) and sane call target.
    if (ABI.encodeErrorResult(decoded.fragment, decoded.args).toLowerCase() !== bytes.toLowerCase() ||
        getBytes(target).length !== 20) return null;
    return { hopIndex: Number(hop), callTarget: target.toLowerCase(), rawReason: reason.toLowerCase() };
  } catch { return null; }
}
