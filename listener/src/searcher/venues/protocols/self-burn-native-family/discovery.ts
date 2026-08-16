import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { SELF_BURN_NATIVE_TOKEN_INTERFACE } from "./shared.js";
import type { SelfBurnNativeCandidate } from "./types.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";

const TRANSFER_SELF_PATTERN_ID = "self-burn-transfer-self";
const PROXY_SHORTLIST_PATTERN_ID = "self-burn-proxy-shortlist";

/**
 * Self-burn receipts emit a family-specific Destruction event. Candidate
 * provenance for the observed lane; admission still requires the ERC20
 * surface and an active state-override delta proof.
 */
const SELF_BURN_NATIVE_EVENT_TOPIC =
  "0x5dd085b6070b4cae004f84daafd199fd55b0bdfa11c3a802baffe89c2419d8c2";

export const selfBurnNativeDiscovery = {
  evidenceChannel: "nominate" as const,
  sources: ["observed-call", "address-surface"],
  candidateSources: ["dex-token-domain", "observed-interaction"],
  callPatterns: [{
    id: TRANSFER_SELF_PATTERN_ID,
    selector: SELF_BURN_NATIVE_TOKEN_INTERFACE.getFunction("transfer")!
      .selector as `0x${string}`,
    signature: "transfer(address,uint256)",
    candidateAddress: { from: "call-target" },
    argumentProjection: [
      { index: 0, type: "address", name: "recipient" },
      { index: 1, type: "uint256", name: "amount" },
    ],
  }],
  logPatterns: [{
    id: "self-burn-destruction-log",
    topic: SELF_BURN_NATIVE_EVENT_TOPIC as `0x${string}`,
    signature: "Destruction(address,uint256)",
  }],
  addressSurfaces: [{
    id: PROXY_SHORTLIST_PATTERN_ID,
    kind: "proxy-implementation" as const,
    fingerprint: "self-burn-native-eip1967-shortlist-v1",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (
        observation.kind === "call" &&
        matchedPatternId === TRANSFER_SELF_PATTERN_ID
      ) {
        const token = canonicalAddress(observation.target);
        const decoded = SELF_BURN_NATIVE_TOKEN_INTERFACE.decodeFunctionData(
          "transfer",
          observation.data,
        );
        const recipient = canonicalAddress(String(decoded[0]));
        const observedAmount = BigInt(decoded[1]);
        if (!sameAddress(token, recipient) || observedAmount <= 0n) return null;
        return Object.freeze({
          candidateKind: "self-burn-native-token" as const,
          token,
          observedAmount,
        });
      }
      if (
        observation.kind === "address-surface" &&
        matchedPatternId === PROXY_SHORTLIST_PATTERN_ID
      ) {
        return Object.freeze({
          candidateKind: "self-burn-native-token" as const,
          token: canonicalAddress(observation.address),
          observedAmount: null,
        });
      }
    } catch {
      return null;
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.token),
  nominate: createAddressSurfaceNomination({
    opaqueLabels: Object.freeze(["self-burn-native", "protocol:self-burn-native"]),
    interfaceFingerprints: Object.freeze([]),
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "no reverse-binding registry declared (explicit unsupported)",
  ),
} satisfies DiscoverySemantics<SelfBurnNativeCandidate>;