import { explicitReverseBindingUnsupported, type DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { ABI, address, uint } from "./codec.js";
import type { Candidate } from "./types.js";
export const discovery = {
  evidenceChannel: "nominate", txSeedNominations: true, sources: ["observed-call", "landed-log", "address-surface"],
  callPatterns: ["sellGem", "buyGem"].map(fn => ({ id: `psv-${fn}`, selector: ABI.getFunction(fn)!.selector as `0x${string}`,
    signature: `${fn}(address,uint256)`, candidateAddress: { from: "call-target" as const } })),
  logPatterns: [{ id: "psv-swap", topic: ABI.getEvent("Swap")!.topicHash as `0x${string}`,
    signature: "Swap(address,address,address,address,uint256,uint256,uint256)" }],
  addressSurfaces: [{ id: "psv-surface", kind: "interface", fingerprint: "psv:uups-exact-input" }],
  decodeCandidate({ observation: o, matchedPatternId: id }) {
    try {
      if (o.kind === "call" && ["psv-sellGem", "psv-buyGem"].includes(id)) {
        const fn = id.slice(4), a = ABI.decodeFunctionData(fn, o.data); address(a[0]);
        if (!uint(a[1]) || ABI.encodeFunctionData(fn, a).toLowerCase() !== o.data.toLowerCase()) return null;
        return { candidateKind: "psv" as const, target: address(o.target) };
      }
      if (o.kind === "log" && id === "psv-swap") {
        const e = ABI.decodeEventLog("Swap", o.data, [...o.topics]);
        if (!uint(e.amountIn) || !uint(e.amountOut) || address(e.tokenIn) === address(e.tokenOut)) return null;
        return { candidateKind: "psv" as const, target: address(o.address) };
      }
      if (o.kind === "address-surface" && id === "psv-surface") return { candidateKind: "psv" as const, target: address(o.address) };
      return null;
    } catch { return null; }
  },
  candidateKey: c => address(c.target),
  nominate: createAddressSurfaceNomination({ opaqueLabels: ["psv"], interfaceFingerprints: ["psv:uups-exact-input"] }),
  reverseBinding: explicitReverseBindingUnsupported("standalone source-bound UUPS vault; no factory-creation claim"),
} satisfies DiscoverySemantics<Candidate>;
