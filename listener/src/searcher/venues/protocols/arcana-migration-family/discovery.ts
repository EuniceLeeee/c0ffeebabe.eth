import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from "../../adapter-family-plugin.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import { ARCANA_SOURCE_INTERFACE } from "./abi.js";
import type { ArcanaCandidate } from "./types.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";

const LOCK_PATTERN_ID = "arcana-lock-and-bridge";
const MIGRATION_LOCKED_TOPIC =
  "0x22b996b24698ab9933ac009880779ea80bd5700d5294b2913b21ff6bd8be1d93";

export const arcanaMigrationDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["observed-call" as const, "landed-log" as const],
  candidateSources: ["observed-interaction" as const],
  callPatterns: [{
    id: LOCK_PATTERN_ID,
    selector: ARCANA_SOURCE_INTERFACE.getFunction("lockAndBridge")!.selector as `0x${string}`,
    signature: "lockAndBridge(bytes32,uint256,address)",
    candidateAddress: { from: "call-target" as const },
    argumentProjection: [{ index: 0, type: "bytes32", name: "tokenId" }],
  }],
  logPatterns: [{
    id: "arcana-migration-locked-log",
    topic: MIGRATION_LOCKED_TOPIC as `0x${string}`,
    signature: "MigrationLocked(bytes32,address,address,address,uint256,uint256,uint256,bytes32)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      let source: string;
      let tokenId: string;
      if (observation.kind === "call" && matchedPatternId === LOCK_PATTERN_ID) {
        const decoded = ARCANA_SOURCE_INTERFACE.decodeFunctionData("lockAndBridge", observation.data);
        source = canonicalAddress(observation.target);
        tokenId = String(decoded[0]).toLowerCase();
      } else if (observation.kind === "log" &&
        matchedPatternId === "arcana-migration-locked-log" &&
        observation.topics.length === 4 &&
        observation.topics[0].toLowerCase() === MIGRATION_LOCKED_TOPIC) {
        source = canonicalAddress(observation.address);
        tokenId = observation.topics[1]!.toLowerCase();
      } else {
        return null;
      }
      if (!/^0x[0-9a-f]{64}$/.test(tokenId)) return null;
      return Object.freeze({
        candidateKind: "arcana-migration" as const,
        source,
        tokenId,
      });
    } catch {
      return null;
    }
  },
  candidateKey: (candidate: ArcanaCandidate) =>
    `${lowerAddress(candidate.source)}:${candidate.tokenId.toLowerCase()}`,
  nominate: createTxEvidenceNomination({
    opaqueLabels: Object.freeze(["arcana-migration", "protocol:arcana-migration"]),
    callPatterns: Object.freeze([{
      id: "arcana-lock-nomination",
      selector: ARCANA_SOURCE_INTERFACE.getFunction("lockAndBridge")!.selector as `0x${string}`,
      signature: "lockAndBridge(bytes32,uint256,address)",
      candidateAddress: Object.freeze({ from: "call-target" as const }),
    }]),
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "no reverse-binding registry declared (explicit unsupported)",
  ),
} satisfies DiscoverySemantics<ArcanaCandidate>;
