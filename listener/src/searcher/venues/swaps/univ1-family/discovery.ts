import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { lower, POOL } from "./codec.js";
import type { Candidate } from "./types.js";
export const EVENTS = ["TokenPurchase", "EthPurchase"] as const;
const CALLS = ["ethToTokenSwapInput", "ethToTokenSwapOutput", "tokenToEthSwapInput", "tokenToEthSwapOutput"] as const;
export const discovery = {
  evidenceChannel: "nominate", sources: ["landed-log", "observed-call", "address-surface"],
  logPatterns: EVENTS.map(name => ({ id: `univ1-${name}`, topic: POOL.getEvent(name)!.topicHash as `0x${string}`,
    signature: POOL.getEvent(name)!.format("sighash") })),
  callPatterns: CALLS.map(name => ({ id: `univ1-${name}`, selector: POOL.getFunction(name)!.selector as `0x${string}`,
    signature: POOL.getFunction(name)!.format("sighash"), candidateAddress: { from: "call-target" as const } })),
  addressSurfaces: [{ id: "univ1-interface", kind: "interface", fingerprint: "univ1-exchange-v1" }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      if (o.kind === "address-surface" && id === "univ1-interface") return { candidateKind: "univ1-exchange", pool: lower(o.address) };
      if (o.kind === "log") {
        const name = EVENTS.find(n => id === `univ1-${n}`);
        if (!name || o.topics.length !== 4 || o.data !== "0x" || o.topics[0].toLowerCase() !== POOL.getEvent(name)!.topicHash) return null;
        POOL.decodeEventLog(name, o.data, [...o.topics]);
        return { candidateKind: "univ1-exchange", pool: lower(o.address) };
      }
      if (o.kind === "call") {
        const name = CALLS.find(n => id === `univ1-${n}`);
        if (!name) return null;
        const decoded = POOL.decodeFunctionData(name, o.data);
        if (POOL.encodeFunctionData(name, decoded).toLowerCase() !== o.data.toLowerCase()) return null;
        // Exact-out is nomination evidence only; no observed amount enters Exact.
        return { candidateKind: "univ1-exchange", pool: lower(o.target) };
      }
    } catch { return null; }
    return null;
  },
  candidateKey: c => lower(c.pool),
  nominate: createAddressSurfaceNomination({ opaqueLabels: ["univ1-exchange", "univ1-exact-input", "custom-swap:uniswap-v1"],
    interfaceFingerprints: ["univ1-exchange-v1"] }),
  reverseBinding: { kind: "explicitly-unsupported", reason: "Exchange-address events and calls carry the complete candidate; identity reverse-verifies factory membership." },
} satisfies DiscoverySemantics<Candidate>;
