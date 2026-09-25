import { explicitReverseBindingUnsupported, type DiscoverySemantics, type UnifiedObservation } from "../../adapter-family-plugin.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";
import { POOL, lower, nonzero } from "./codec.js";
import type { MooniswapCandidate } from "./types.js";

export const SWAPPED_ID = "mooniswap-swapped";
export const SWAPPED_TOPIC = POOL.getEvent("Swapped")!.topicHash as `0x${string}`;
const callPatterns = ["swapFor", "swap"].map(name => ({ id: `mooniswap-${name}`,
  selector: POOL.getFunction(name)!.selector as `0x${string}`, signature: POOL.getFunction(name)!.format("sighash"),
  candidateAddress: { from: "call-target" as const } }));
export function decodeSwapped(log: { address: string; topics: readonly string[]; data: string }) {
  try {
    if (log.topics.length !== 4 || log.topics[0].toLowerCase() !== SWAPPED_TOPIC.toLowerCase()) return null;
    const args = POOL.decodeEventLog("Swapped", log.data, [...log.topics]);
    const encoded = POOL.encodeEventLog(POOL.getEvent("Swapped")!, [...args]);
    if (encoded.data.toLowerCase() !== log.data.toLowerCase() || encoded.topics.some((t, i) => t.toLowerCase() !== log.topics[i].toLowerCase())) return null;
    const tokenIn = nonzero(String(args.srcToken)), tokenOut = nonzero(String(args.dstToken));
    if (tokenIn === tokenOut || BigInt(args.amount) <= 0n || BigInt(args.result) <= 0n) return null;
    return { pool: nonzero(log.address), sender: nonzero(String(args.sender)), receiver: nonzero(String(args.receiver)),
      tokenIn, tokenOut, amountIn: BigInt(args.amount), amountOut: BigInt(args.result),
      additionBalance: BigInt(args.srcAdditionBalance), removalBalance: BigInt(args.dstRemovalBalance), referral: lower(String(args.referral)) };
  } catch { return null; }
}
export function decodeSwapCall(observation: UnifiedObservation) {
  if (observation.kind !== "call") return null;
  try {
    const parsed = POOL.parseTransaction({ data: observation.data });
    if (!parsed || !["swap", "swapFor"].includes(parsed.name) ||
        POOL.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() !== observation.data.toLowerCase()) return null;
    const tokenIn = nonzero(String(parsed.args.src)), tokenOut = nonzero(String(parsed.args.dst));
    if (tokenIn === tokenOut || BigInt(parsed.args.amount) <= 0n) return null;
    if (parsed.name === "swapFor") nonzero(String(parsed.args.receiver));
    return { pool: nonzero(observation.target), tokenIn, tokenOut, amountIn: BigInt(parsed.args.amount), method: parsed.name };
  } catch { return null; }
}
export const mooniswapDiscovery = {
  evidenceChannel: "nominate", sources: ["observed-call", "landed-log"], candidateSources: ["observed-interaction"],
  txSeedNominations: true, callPatterns,
  logPatterns: [{ id: SWAPPED_ID, topic: SWAPPED_TOPIC, signature: "Swapped(address,address,address,address,uint256,uint256,uint256,uint256,address)" }],
  nominate: createTxEvidenceNomination({ opaqueLabels: ["mooniswap"], callPatterns }),
  reverseBinding: explicitReverseBindingUnsupported("Verified standalone runtime and immutable tokens; no factory CREATE ancestry claim"),
  decodeCandidate({ observation, matchedPatternId }) {
    if (observation.kind === "log" && matchedPatternId === SWAPPED_ID) {
      const swap = decodeSwapped(observation);
      return swap ? { candidateKind: "mooniswap" as const, pool: swap.pool } : null;
    }
    const pattern = callPatterns.find(p => p.id === matchedPatternId);
    const swap = pattern && observation.kind === "call" && observation.data.slice(0, 10).toLowerCase() === pattern.selector
      ? decodeSwapCall(observation) : null;
    return swap ? { candidateKind: "mooniswap" as const, pool: swap.pool } : null;
  },
  candidateKey: candidate => lower(candidate.pool),
} satisfies DiscoverySemantics<MooniswapCandidate>;
