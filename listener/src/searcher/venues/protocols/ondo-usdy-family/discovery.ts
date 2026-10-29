import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from "../../adapter-family-plugin.js";
import { canonicalAddress } from "../standard-family/common.js";
import { ONDO_MANAGER_INTERFACE } from "./abi.js";
import type { OndoCandidate } from "./types.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";

const CALL_ID = "ondo-redeem-call";
const LOG_TOPIC = ONDO_MANAGER_INTERFACE.getEvent("Redemption")!.topicHash.toLowerCase();

export const ondoDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["observed-call" as const, "landed-log" as const],
  candidateSources: ["observed-interaction" as const],
  callPatterns: [{
    id: CALL_ID,
    selector: ONDO_MANAGER_INTERFACE.getFunction("redeem")!.selector as `0x${string}`,
    signature: "redeem(uint256,address,uint256)",
    candidateAddress: { from: "call-target" as const },
  }],
  logPatterns: [{ id: "ondo-redemption-log", topic: LOG_TOPIC as `0x${string}`, signature: "Redemption(address,bytes32,uint256,address,uint256,uint256,uint256)" }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (observation.kind === "call" && matchedPatternId === CALL_ID) {
        const args = ONDO_MANAGER_INTERFACE.decodeFunctionData("redeem", observation.data);
        return Object.freeze({ candidateKind: "ondo-usdy-redeem" as const, manager: canonicalAddress(observation.target), receive: canonicalAddress(String(args[1])) });
      }
      if (observation.kind === "log" && matchedPatternId === "ondo-redemption-log" && observation.topics[0]?.toLowerCase() === LOG_TOPIC) {
        const log = ONDO_MANAGER_INTERFACE.decodeEventLog("Redemption", observation.data, [...observation.topics]);
        return Object.freeze({ candidateKind: "ondo-usdy-redeem" as const, manager: canonicalAddress(observation.address), receive: canonicalAddress(String(log.receivingToken)) });
      }
      return null;
    } catch { return null; }
  },
  candidateKey: (c: OndoCandidate) => `${c.manager.toLowerCase()}:${c.receive.toLowerCase()}`,
  nominate: createTxEvidenceNomination({
    opaqueLabels: Object.freeze(["ondo-usdy-redeem", "protocol:ondo-usdy-instant-redeem"]),
    callPatterns: Object.freeze([{ id: "ondo-redeem-nomination", selector: ONDO_MANAGER_INTERFACE.getFunction("redeem")!.selector as `0x${string}`, signature: "redeem(uint256,address,uint256)", candidateAddress: Object.freeze({ from: "call-target" as const }) }]),
  }),
  reverseBinding: explicitReverseBindingUnsupported("no factory or registry creation claim"),
} satisfies DiscoverySemantics<OndoCandidate>;
