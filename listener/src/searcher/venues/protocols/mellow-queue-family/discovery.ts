import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { MELLOW_QUEUE_INTERFACE } from "./abi.js";
import type { MellowQueueCandidate, MellowQueueKind } from "./types.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";

const DEPOSIT_PATTERN_ID = "mellow-deposit-call";
const REDEEM_PATTERN_ID = "mellow-redeem-call";

export const mellowQueueDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["observed-call" as const],
  candidateSources: ["observed-interaction" as const],
  callPatterns: [{
    id: DEPOSIT_PATTERN_ID,
    selector: MELLOW_QUEUE_INTERFACE.getFunction("deposit")!.selector as `0x${string}`,
    signature: "deposit(uint224,address,bytes32[])",
    candidateAddress: { from: "call-target" as const },
    argumentProjection: [{ index: 0, type: "uint256", name: "assets" }],
  }, {
    id: REDEEM_PATTERN_ID,
    selector: MELLOW_QUEUE_INTERFACE.getFunction("redeem")!.selector as `0x${string}`,
    signature: "redeem(uint256,address)",
    candidateAddress: { from: "call-target" as const },
    argumentProjection: [{ index: 0, type: "uint256", name: "shares" }],
  }],
  logPatterns: [{
    id: "mellow-deposited-log",
    topic: MELLOW_QUEUE_INTERFACE.getEvent("Deposited")!.topicHash as `0x${string}`,
    signature: "Deposited(address,address,uint224,uint256,uint256)",
  }, {
    id: "mellow-redeemed-log",
    topic: MELLOW_QUEUE_INTERFACE.getEvent("Redeemed")!.topicHash as `0x${string}`,
    signature: "Redeemed(address,uint256,uint256,uint256)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (observation.kind !== "call") return null;
    const kind: MellowQueueKind | null =
      matchedPatternId === DEPOSIT_PATTERN_ID ? "deposit"
        : matchedPatternId === REDEEM_PATTERN_ID ? "redeem"
          : null;
    if (kind === null) return null;
    try {
      const queue = canonicalAddress(observation.target);
      if (kind === "deposit") {
        MELLOW_QUEUE_INTERFACE.decodeFunctionData("deposit", observation.data);
      } else {
        MELLOW_QUEUE_INTERFACE.decodeFunctionData("redeem", observation.data);
      }
      return Object.freeze({ candidateKind: "mellow-queue" as const, queue, kind });
    } catch {
      return null;
    }
  },
  candidateKey: (candidate: MellowQueueCandidate) => lowerAddress(candidate.queue),
  nominate: createTxEvidenceNomination({
    opaqueLabels: Object.freeze([
      "mellow-queue",
      "protocol:mellow-queue",
    ]),
    callPatterns: Object.freeze([{
      id: "mellow-deposit-nomination",
      selector: MELLOW_QUEUE_INTERFACE.getFunction("deposit")!.selector as `0x${string}`,
      signature: "deposit(uint224,address,bytes32[])",
      candidateAddress: Object.freeze({ from: "call-target" as const }),
    }, {
      id: "mellow-redeem-nomination",
      selector: MELLOW_QUEUE_INTERFACE.getFunction("redeem")!.selector as `0x${string}`,
      signature: "redeem(uint256,address)",
      candidateAddress: Object.freeze({ from: "call-target" as const }),
    }]),
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "no reverse-binding registry declared (explicit unsupported)",
  ),
} satisfies DiscoverySemantics<MellowQueueCandidate>;
