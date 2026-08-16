import { ADDR } from "../../../../shared/constants/addresses.js";
import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { ETHERTOKEN_NATIVE_INTERFACE } from "./shared.js";
import type { EtherTokenNativeRedeemCandidate } from "./types.js";
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";

const WITHDRAW_PATTERN_ID = "ethertoken-withdraw-call";

/**
 * EtherToken-compatible withdrawals emit a family-specific Destruction event.
 * Candidate provenance for the observed lane; admission still requires the
 * ERC20 surface and an active state-override delta proof.
 */
const ETHERTOKEN_DESTRUCTION_EVENT_TOPIC =
  "0x9a1b418bc061a5d80270261562e6986a35d995f8051145f277be16103abd3453";

export const etherTokenNativeRedeemDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["observed-call"],
  candidateSources: ["observed-interaction"],
  callPatterns: [{
    id: WITHDRAW_PATTERN_ID,
    selector: ETHERTOKEN_NATIVE_INTERFACE.getFunction("withdraw")!
      .selector as `0x${string}`,
    signature: "withdraw(uint256)",
    candidateAddress: { from: "call-target" },
    argumentProjection: [{ index: 0, type: "uint256", name: "amount" }],
  }],
  logPatterns: [{
    id: "ethertoken-destruction-log",
    topic: ETHERTOKEN_DESTRUCTION_EVENT_TOPIC as `0x${string}`,
    signature: "Destruction(address,uint256)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (
      observation.kind !== "call" ||
      matchedPatternId !== WITHDRAW_PATTERN_ID
    ) return null;
    try {
      const token = canonicalAddress(observation.target);
      const observedAmount = BigInt(
        ETHERTOKEN_NATIVE_INTERFACE.decodeFunctionData(
          "withdraw",
          observation.data,
        )[0],
      );
      if (observedAmount <= 0n || sameAddress(token, ADDR.WETH)) return null;
      return Object.freeze({
        candidateKind: "ethertoken-native-redeem-token" as const,
        token,
        observedAmount,
      });
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.token),
  nominate: createTxEvidenceNomination({
    opaqueLabels: Object.freeze([
      "ethertoken-native-redeem",
      "protocol:ethertoken-native-redeem",
      "ethertoken-native-redeem-token",
    ]),
    callPatterns: Object.freeze([{
      id: "ethertoken-native-withdraw-call",
      selector: ETHERTOKEN_NATIVE_INTERFACE.getFunction("withdraw")!
        .selector as `0x${string}`,
      signature: "withdraw(address,uint256)",
      candidateAddress: Object.freeze({ from: "call-target" as const }),
    }]),
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "no reverse-binding registry declared (explicit unsupported)",
  ),
} satisfies DiscoverySemantics<EtherTokenNativeRedeemCandidate>;