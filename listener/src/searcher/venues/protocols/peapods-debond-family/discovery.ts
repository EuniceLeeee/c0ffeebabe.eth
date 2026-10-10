import { explicitReverseBindingUnsupported, type DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { ABI, address, uint } from "./codec.js";
import type { Candidate } from "./types.js";
export const SURFACE = "peapods:weighted-debond";
export const discovery = {
  evidenceChannel: "nominate", txSeedNominations: true, sources: ["observed-call", "landed-log", "address-surface"],
  callPatterns: [{ id: "peapods-debond-call", selector: ABI.getFunction("debond")!.selector as `0x${string}`,
    signature: "debond(uint256,address[],uint8[])", candidateAddress: { from: "call-target" } }],
  logPatterns: [{ id: "peapods-debond-log", topic: ABI.getEvent("Debond")!.topicHash as `0x${string}`,
    signature: "Debond(address,uint256)" }],
  addressSurfaces: [{ id: "peapods-debond-surface", kind: "interface", fingerprint: SURFACE }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      if (o.kind === "call" && id === "peapods-debond-call") {
        const args = ABI.decodeFunctionData("debond", o.data);
        if (!uint(args[0]) || ABI.encodeFunctionData("debond", args).toLowerCase() !== o.data.toLowerCase()) return null;
        return { candidateKind: "peapods-debond" as const, pod: address(o.target) };
      }
      if (o.kind === "log" && id === "peapods-debond-log") {
        const event = ABI.decodeEventLog("Debond", o.data, [...o.topics]);
        if (!uint(event.amountDebonded)) return null;
        return { candidateKind: "peapods-debond" as const, pod: address(o.address) };
      }
      if (o.kind === "address-surface" && id === "peapods-debond-surface")
        return { candidateKind: "peapods-debond" as const, pod: address(o.address) };
      return null;
    } catch { return null; }
  },
  candidateKey: c => address(c.pod),
  nominate: createAddressSurfaceNomination({ opaqueLabels: ["peapods-debond"], interfaceFingerprints: [SURFACE] }),
  reverseBinding: explicitReverseBindingUnsupported("source runtime and reciprocal staking index binding; no factory-creation claim"),
} satisfies DiscoverySemantics<Candidate>;
