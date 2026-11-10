import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from "../../adapter-family-plugin.js";
import { canonicalAddress } from "../standard-family/common.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";
import { TELLER_INTERFACE } from "./abi.js";
import type { BoringCandidate } from "./types.js";

const CALL_ID = "boring-vault-withdraw-call";

export const boringDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["observed-call" as const],
  candidateSources: ["observed-interaction" as const],
  callPatterns: [{
    id: CALL_ID,
    selector: TELLER_INTERFACE.getFunction("bulkWithdraw")!.selector as `0x${string}`,
    signature: "bulkWithdraw(address,uint256,uint256,address)",
    candidateAddress: { from: "call-target" as const },
  }],
  decodeCandidate({ observation, matchedPatternId }: {
    readonly observation: { readonly kind: string; readonly target?: string; readonly data?: string };
    readonly matchedPatternId: string;
  }) {
    if (observation.kind !== "call" || matchedPatternId !== CALL_ID || observation.target === undefined || observation.data === undefined) return null;
    try {
      const args = TELLER_INTERFACE.decodeFunctionData("bulkWithdraw", observation.data);
      if (BigInt(args[1]) <= 0n) return null;
      return Object.freeze({ candidateKind: "boring-vault-withdraw" as const, teller: canonicalAddress(observation.target) });
    } catch {
      return null;
    }
  },
  candidateKey: (c: BoringCandidate) => c.teller.toLowerCase(),
  nominate: createTxEvidenceNomination({
    opaqueLabels: Object.freeze(["boring-vault-teller", "protocol:boring-vault-teller"]),
    callPatterns: Object.freeze([{
      id: "boring-vault-withdraw-nomination",
      selector: TELLER_INTERFACE.getFunction("bulkWithdraw")!.selector as `0x${string}`,
      signature: "bulkWithdraw(address,uint256,uint256,address)",
      candidateAddress: Object.freeze({ from: "call-target" as const }),
    }]),
  }),
  reverseBinding: explicitReverseBindingUnsupported("no factory or registry creation claim"),
} satisfies DiscoverySemantics<BoringCandidate>;
