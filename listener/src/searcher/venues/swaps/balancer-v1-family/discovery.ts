import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { nonzero, POOL } from "./codec.js";
import type { Candidate } from "./types.js";
export const SWAP_PATTERN = "balancer-v1-LOG_SWAP";
const CALLS = ["swapExactAmountIn", "swapExactAmountOut"] as const;
export function decodeSwapLog(o: { topics: readonly string[]; data: string }) {
  try {
    if (o.topics.length !== 4 || o.topics[0].toLowerCase() !== POOL.getEvent("LOG_SWAP")!.topicHash) return null;
    const a = POOL.decodeEventLog("LOG_SWAP", o.data, [...o.topics]);
    const encoded = POOL.encodeEventLog(POOL.getEvent("LOG_SWAP")!, a);
    if (encoded.data.toLowerCase() !== o.data.toLowerCase() || encoded.topics.some((t, i) => t.toLowerCase() !== o.topics[i].toLowerCase())) return null;
    const tokenIn = nonzero(a[1]), tokenOut = nonzero(a[2]);
    return tokenIn === tokenOut ? null : { tokenIn, tokenOut, amountIn: BigInt(a[3]), amountOut: BigInt(a[4]) };
  } catch { return null; }
}
export const discovery = {
  evidenceChannel: "nominate", sources: ["landed-log", "observed-call", "address-surface"],
  logPatterns: [{ id: SWAP_PATTERN, topic: POOL.getEvent("LOG_SWAP")!.topicHash as `0x${string}`, signature: POOL.getEvent("LOG_SWAP")!.format("sighash") }],
  callPatterns: CALLS.map(n => ({ id: `balancer-v1-${n}`, selector: POOL.getFunction(n)!.selector as `0x${string}`,
    signature: POOL.getFunction(n)!.format("sighash"), candidateAddress: { from: "call-target" as const } })),
  addressSurfaces: [{ id: "balancer-v1-interface", kind: "interface", fingerprint: "balancer-v1-bpool-v1" }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      if (o.kind === "address-surface" && id === "balancer-v1-interface") return { candidateKind: "balancer-v1-pool", pool: nonzero(o.address) };
      if (o.kind === "log" && id === SWAP_PATTERN && decodeSwapLog(o)) return { candidateKind: "balancer-v1-pool", pool: nonzero(o.address) };
      if (o.kind === "call") {
        const n = CALLS.find(n => id === `balancer-v1-${n}`); if (!n) return null;
        const decoded = POOL.decodeFunctionData(n, o.data);
        if (POOL.encodeFunctionData(n, decoded).toLowerCase() !== o.data.toLowerCase()) return null;
        if (nonzero(decoded[0]) === nonzero(decoded[2])) return null;
        // Exact-out is discovery evidence only, not an exposed quote mode.
        return { candidateKind: "balancer-v1-pool", pool: nonzero(o.target) };
      }
    } catch { return null; }
    return null;
  },
  candidateKey: c => nonzero(c.pool),
  nominate: createAddressSurfaceNomination({ opaqueLabels: ["balancer-v1", "balancer-v1-swap"], interfaceFingerprints: ["balancer-v1-bpool-v1"] }),
  reverseBinding: { kind: "explicitly-unsupported", reason: "BPool events/calls contain the complete candidate address; identity verifies factory creation membership." },
} satisfies DiscoverySemantics<Candidate>;
