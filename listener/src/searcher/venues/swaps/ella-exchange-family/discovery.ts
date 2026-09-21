import { ethers } from "ethers";
import type { DiscoverySemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { POOL, lower, same } from "./codec.js";
import { ELLA_SURFACE, createEllaNomination, reverseBindElla } from "./nomination.js";
import type { EllaCandidate } from "./types.js";

export const BOUGHT_ID = "ella-bought", SURFACE_ID = "ella-native-base";
export const BOUGHT_TOPIC = POOL.getEvent("Bought")!.topicHash as `0x${string}`;
const callPatterns = ["swapBase1", "swap1"].map(name => ({ id: `ella-${name}`,
  selector: POOL.getFunction(name)!.selector as `0x${string}`,
  signature: POOL.getFunction(name)!.format("sighash"), candidateAddress: { from: "call-target" as const } }));
const logPatterns = [{ id: BOUGHT_ID, topic: BOUGHT_TOPIC, signature: POOL.getEvent("Bought")!.format("sighash") }];
const nomination = createEllaNomination({ opaqueLabels: ["ella-exchange"], callPatterns, logPatterns });
export function decodeBought(observation: UnifiedObservation) {
  if (observation.kind !== "log" || observation.topics.length !== 1 || observation.topics[0].toLowerCase() !== BOUGHT_TOPIC.toLowerCase() ||
      !ethers.isHexString(observation.data, 192)) return null;
  try {
    const data = POOL.decodeEventLog("Bought", observation.data, observation.topics);
    if (POOL.encodeEventLog(POOL.getEvent("Bought")!, data).data.toLowerCase() !== observation.data.toLowerCase() ||
        !same(data.exchange, observation.address) || data.price <= 0n || data.amountIn <= 0n) return null;
    // Bought reports GROSS output, not recipient net output. It is nomination
    // evidence only; the six swap variants share this event and its boolean.
    return { pool: ethers.getAddress(observation.address), price: BigInt(data.price),
      grossOut: BigInt(data.grossOut), amountIn: BigInt(data.amountIn), isBuy: Boolean(data.isBuy) };
  } catch { return null; }
}
export const ellaDiscovery = {
  evidenceChannel: "nominate", sources: ["landed-log", "observed-call"], txSeedNominations: true,
  callPatterns, logPatterns,
  addressSurfaces: [{ id: SURFACE_ID, kind: "interface", fingerprint: ELLA_SURFACE }],
  decodeCandidate({ observation, matchedPatternId }) {
    let pool: string;
    if (observation.kind === "address-surface" && matchedPatternId === SURFACE_ID && observation.interfaceFingerprints?.includes(ELLA_SURFACE)) pool = observation.address;
    else if (observation.kind === "log" && matchedPatternId === BOUGHT_ID) {
      const data = decodeBought(observation); if (!data) return null; pool = data.pool;
    } else if (observation.kind === "call") {
      const pattern = callPatterns.find(p => p.id === matchedPatternId && observation.data.slice(0, 10).toLowerCase() === p.selector);
      if (!pattern) return null;
      try {
        const values = POOL.decodeFunctionData(pattern.signature, observation.data);
        if (POOL.encodeFunctionData(pattern.signature, values).toLowerCase() !== observation.data.toLowerCase()) return null;
      } catch { return null; }
      pool = observation.target;
    } else return null;
    return { candidateKind: "ella-exchange", pool: ethers.getAddress(pool) };
  },
  candidateKey: candidate => lower(candidate.pool),
  instanceNominationKey: candidate => lower(String((candidate as Record<string, unknown>).pool ?? (candidate as Record<string, unknown>).address)),
  nominate: { nominate(input) { return nomination.nominate({ ...input, provider: { ...input.provider,
    async getTransactionReceipt(hash) {
      const r = await input.provider.getTransactionReceipt(hash);
      return typeof r?.blockNumber === "number" && r.blockNumber >= 0 && r.blockNumber <= input.source.number ? r : null;
    },
  } }); } },
  reverseBinding: { kind: "implementation", reverseBinding: reverseBindElla },
} satisfies DiscoverySemantics<EllaCandidate>;
