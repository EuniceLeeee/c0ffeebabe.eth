import { ethers } from "ethers";
import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { lower, POOL } from "./codec.js";
import type { Candidate } from "./types.js";
export const EVENTS = ["Swap", "AddLiquidity", "RemoveLiquidity"] as const;
export function decodeEvent(o: { topics: readonly string[]; data: string }): { name: typeof EVENTS[number]; payload: Record<string, string | bigint> } | null {
  try {
    const name = EVENTS.find(n => POOL.getEvent(n)!.topicHash === o.topics[0]?.toLowerCase());
    if (!name) return null;
    const fragment = POOL.getEvent(name)!, value = POOL.decodeEventLog(fragment, o.data, [...o.topics]);
    const encoded = POOL.encodeEventLog(fragment, value);
    if (encoded.data.toLowerCase() !== o.data.toLowerCase() || encoded.topics.length !== o.topics.length ||
        encoded.topics.some((t, i) => t.toLowerCase() !== o.topics[i].toLowerCase())) return null;
    return { name, payload: name === "Swap"
      ? { tokenIn: lower(value[0]), amountIn: BigInt(value[1]), amountOut: BigInt(value[2]), recipient: lower(value[3]) }
      : { account: lower(value[0]), value1: BigInt(value[1]), value2: BigInt(value[2]), value3: BigInt(value[3]) } };
  } catch { return null; }
}
export const discovery = {
  evidenceChannel: "nominate", sources: ["landed-log", "observed-call", "address-surface"],
  logPatterns: EVENTS.map(n => ({ id: `precision-pool-${n}`, topic: POOL.getEvent(n)!.topicHash as `0x${string}`, signature: POOL.getEvent(n)!.format("sighash") })),
  callPatterns: [{ id: "precision-pool-exact-in", selector: POOL.getFunction("swapExactIn")!.selector as `0x${string}`,
    signature: POOL.getFunction("swapExactIn")!.format("sighash"), candidateAddress: { from: "call-target" } }],
  addressSurfaces: [{ id: "precision-pool-interface", kind: "interface", fingerprint: "precision-pool-direct-v1" }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      let pool: string | undefined;
      if (o.kind === "address-surface" && id === "precision-pool-interface") pool = o.address;
      if (o.kind === "log") { const e = decodeEvent(o); if (e && id === `precision-pool-${e.name}`) pool = o.address; }
      if (o.kind === "call" && id === "precision-pool-exact-in") {
        const value = POOL.decodeFunctionData("swapExactIn", o.data);
        if (POOL.encodeFunctionData("swapExactIn", value).toLowerCase() === o.data.toLowerCase()) pool = o.target;
      }
      return pool && lower(pool) !== ethers.ZeroAddress ? { candidateKind: "precision-pool", pool: lower(pool) } : null;
    } catch { return null; }
  },
  candidateKey: c => lower(c.pool),
  nominate: createAddressSurfaceNomination({ opaqueLabels: ["precision-pool", "precision-pool-swap", "custom-swap:precision-pool"], interfaceFingerprints: ["precision-pool-direct-v1"] }),
  reverseBinding: { kind: "explicitly-unsupported", reason: "Pool-targeted events/calls carry complete candidates; identity verifies full Market CREATE2 and factory registration." },
} satisfies DiscoverySemantics<Candidate>;
