import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { lower, POOL } from "./codec.js";
import type { Candidate } from "./types.js";
export const EVENTS = ["NewMarketOrder", "DealWithPool", "OrderChanged"] as const;
export function decodeEvent(o: { topics: readonly string[]; data: string }) {
  const name = EVENTS.find(n => POOL.getEvent(n)!.topicHash === o.topics[0]?.toLowerCase());
  if (!name || o.topics.length !== 1 || !/^0x[0-9a-f]{64}$/i.test(o.data)) return null;
  const word = BigInt(o.data);
  if ((word & 255n) > 1n) return null;
  return { name, buy: (word & 1n) === 1n, word };
}
export const discovery = {
  evidenceChannel: "nominate", sources: ["landed-log", "observed-call", "address-surface"],
  logPatterns: EVENTS.map(n => ({ id: `oneswap-${n}`, topic: POOL.getEvent(n)!.topicHash as `0x${string}`, signature: POOL.getEvent(n)!.format("sighash") })),
  callPatterns: [{ id: "oneswap-market-order", selector: POOL.getFunction("addMarketOrder")!.selector as `0x${string}`,
    signature: POOL.getFunction("addMarketOrder")!.format("sighash"), candidateAddress: { from: "call-target" } }],
  addressSurfaces: [{ id: "oneswap-interface", kind: "interface", fingerprint: "oneswap-amm-orderbook-v1" }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      if (o.kind === "address-surface" && id === "oneswap-interface") return { candidateKind: "oneswap", pool: lower(o.address) };
      if (o.kind === "log") {
        const e = decodeEvent(o);
        if (e && id === `oneswap-${e.name}`) return { candidateKind: "oneswap", pool: lower(o.address) };
      }
      if (o.kind === "call" && id === "oneswap-market-order") {
        const decoded = POOL.decodeFunctionData("addMarketOrder", o.data);
        if (POOL.encodeFunctionData("addMarketOrder", decoded).toLowerCase() === o.data.toLowerCase()) return { candidateKind: "oneswap", pool: lower(o.target) };
      }
    } catch { return null; }
    return null;
  },
  candidateKey: c => lower(c.pool),
  nominate: createAddressSurfaceNomination({ opaqueLabels: ["oneswap", "oneswap-market-order", "custom-swap:oneswap"], interfaceFingerprints: ["oneswap-amm-orderbook-v1"] }),
  reverseBinding: { kind: "explicitly-unsupported", reason: "Pool-targeted logs/calls carry complete candidates; identity proves both factory registration directions." },
} satisfies DiscoverySemantics<Candidate>;
