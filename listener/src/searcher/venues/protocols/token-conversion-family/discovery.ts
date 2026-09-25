import { explicitReverseBindingUnsupported, type DiscoverySemantics } from "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { ABI, nonzero, positiveAmount } from "./variants.js";
import { XWIN_ABI } from "./xwin.js";
import type { ConversionCandidate } from "./types.js";

export const discovery = {
  evidenceChannel: "nominate", sources: ["observed-call", "address-surface"],
  callPatterns: [...["mint", "redeem"].map(name => ({
    id: `token-conversion-${name}`, selector: ABI.getFunction(name)!.selector as `0x${string}`,
    signature: `${name}(uint256)`, candidateAddress: { from: "call-target" as const },
  })), ...["deposit", "withdraw"].map(name => ({
    id: `token-conversion-${name}`, selector: XWIN_ABI.getFunction(name)!.selector as `0x${string}`,
    signature: `${name}(uint256,uint32)`, candidateAddress: { from: "call-target" as const },
  }))],
  addressSurfaces: [{ id: "token-conversion-surface", kind: "interface", fingerprint: "token-conversion:btb-bear-v1" },
    { id: "token-conversion-xwin-surface", kind: "interface", fingerprint: "token-conversion:xwin-allocations-v1" }],
  decodeCandidate({ observation, matchedPatternId }): ConversionCandidate | null {
    if (observation.kind === "call" && ["token-conversion-mint", "token-conversion-redeem"].includes(matchedPatternId)) {
      try {
        if (observation.data.length !== 74) return null;
        const parsed = ABI.parseTransaction({ data: observation.data });
        if (!parsed || matchedPatternId !== `token-conversion-${parsed.name}`) return null;
        positiveAmount(BigInt(parsed.args[0]));
        return Object.freeze({ candidateKind: "token-conversion" as const, target: nonzero(observation.target), variantHint: "btb-bear-v1" as const });
      } catch { return null; }
    }
    if (observation.kind === "call" && ["token-conversion-deposit", "token-conversion-withdraw"].includes(matchedPatternId)) {
      try {
        if (observation.data.length !== 138) return null;
        const parsed = XWIN_ABI.parseTransaction({ data: observation.data });
        if (!parsed || matchedPatternId !== `token-conversion-${parsed.name}` ||
            XWIN_ABI.encodeFunctionData(parsed.name, parsed.args).toLowerCase() !== observation.data.toLowerCase()) return null;
        positiveAmount(BigInt(parsed.args[0]));
        return Object.freeze({ candidateKind: "token-conversion" as const, target: nonzero(observation.target), variantHint: "xwin-allocations-v1" as const });
      } catch { return null; }
    }
    if (observation.kind === "address-surface" && ["token-conversion-surface", "token-conversion-xwin-surface"].includes(matchedPatternId)) {
      // Nomination/fallback advertises candidate interfaces, not a proven
      // variant. Production re-observation may select either surface first.
      // Leave both typed identity proofs applicable; only runtime evidence
      // may choose the variant. Observed, decoded calls still carry hints.
      try { return Object.freeze({ candidateKind: "token-conversion" as const, target: nonzero(observation.address) }); }
      catch { return null; }
    }
    return null;
  },
  candidateKey: candidate => candidate.target.toLowerCase(),
  nominate: createAddressSurfaceNomination({ opaqueLabels: ["token-conversion"], interfaceFingerprints: ["token-conversion:btb-bear-v1", "token-conversion:xwin-allocations-v1"] }),
  reverseBinding: explicitReverseBindingUnsupported("standalone code/immutable proof; no factory creation claim"),
} satisfies DiscoverySemantics<ConversionCandidate>;
