import { ethers } from "ethers";
import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import {
  METAFACTORY_INTERFACE,
  METAFACTORY_REDEEM_SIGNATURE,
  METAFACTORY_REDEEM_TOPIC,
} from "./codec.js";
import { METAFACTORY_ACTION_ID } from "./manifest.js";
import type { MetafactoryCandidate } from "./types.js";

export const METAFACTORY_CALL_PATTERN_ID = "metafactory-compost-redeem-call";
export const METAFACTORY_LOG_PATTERN_ID = "metafactory-redeem-log";

const COMPOST_AND_REDEEM = METAFACTORY_INTERFACE.getFunction("compostAndRedeem")!;

const callPatterns = Object.freeze([Object.freeze({
  id: METAFACTORY_CALL_PATTERN_ID,
  selector: COMPOST_AND_REDEEM.selector as `0x${string}`,
  signature: "compostAndRedeem(uint256,address)",
  candidateAddress: Object.freeze({ from: "call-target" as const }),
  argumentProjection: Object.freeze([
    Object.freeze({ index: 0, type: "uint256", name: "amount" }),
    Object.freeze({ index: 1, type: "address", name: "passportRecipient" }),
  ]),
})]);

const logPatterns = Object.freeze([Object.freeze({
  id: METAFACTORY_LOG_PATTERN_ID,
  topic: METAFACTORY_REDEEM_TOPIC as `0x${string}`,
  signature: METAFACTORY_REDEEM_SIGNATURE,
})]);

export const metafactoryDiscovery = {
  evidenceChannel: "nominate" as const,
  sources: ["observed-call", "landed-log"],
  candidateSources: ["observed-interaction"],
  txSeedNominations: true,
  callPatterns,
  logPatterns,
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (observation.kind === "call") {
        if (matchedPatternId !== METAFACTORY_CALL_PATTERN_ID) return null;
        if (
          observation.data.slice(0, 10).toLowerCase() !==
          COMPOST_AND_REDEEM.selector.toLowerCase()
        ) return null;
        const parsed = METAFACTORY_INTERFACE.parseTransaction({
          data: observation.data,
        });
        if (
          parsed === null ||
          parsed.name !== "compostAndRedeem" ||
          METAFACTORY_INTERFACE.encodeFunctionData(
            parsed.fragment, parsed.args).toLowerCase() !==
            observation.data.toLowerCase()
        ) return null;
        const amount = BigInt(parsed.args[0]);
        if (amount <= 0n) return null;
        const target = canonicalAddress(observation.target);
        if (sameAddress(target, ethers.ZeroAddress)) return null;
        return Object.freeze({
          candidateKind: "metafactory-composter" as const,
          target,
          observedAmount: amount,
        }) satisfies MetafactoryCandidate;
      }
      if (observation.kind === "log") {
        if (matchedPatternId !== METAFACTORY_LOG_PATTERN_ID) return null;
        if (
          observation.topics.length !== 2 ||
          observation.topics[0].toLowerCase() !== METAFACTORY_REDEEM_TOPIC
        ) return null;
        const decoded = METAFACTORY_INTERFACE.decodeEventLog(
          "Redeem",
          observation.data,
          [...observation.topics],
        );
        // ethers returns every event argument in declaration order, including
        // the indexed user, so read the named fields instead of positions.
        const tokensComposted = BigInt(decoded.tokensComposted);
        const ethRedeemed = BigInt(decoded.ethRedeemed);
        if (tokensComposted <= 0n || ethRedeemed <= 0n) return null;
        const target = canonicalAddress(observation.address);
        if (sameAddress(target, ethers.ZeroAddress)) return null;
        // The topic-1 user is the redeeming caller, not the instance; the
        // composter emitter is the instance subject.
        return Object.freeze({
          candidateKind: "metafactory-composter" as const,
          target,
          observedAmount: tokensComposted,
        }) satisfies MetafactoryCandidate;
      }
      return null;
    } catch {
      return null;
    }
  },
  candidateKey: (candidate: MetafactoryCandidate) => lowerAddress(candidate.target),
  nominate: createTxEvidenceNomination({
    opaqueLabels: Object.freeze([
      "metafactory",
      "protocol:metafactory",
      METAFACTORY_ACTION_ID,
      "metafactory-composter",
    ]),
    callPatterns,
    logPatterns,
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "Standalone composter runtime proof; no factory or registry creation claim",
  ),
} satisfies DiscoverySemantics<MetafactoryCandidate>;
