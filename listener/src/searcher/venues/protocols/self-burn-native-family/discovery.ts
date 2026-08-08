import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { SELF_BURN_NATIVE_TOKEN_INTERFACE } from "./shared.js";
import type { SelfBurnNativeCandidate } from "./types.js";

const TRANSFER_SELF_PATTERN_ID = "self-burn-transfer-self";
const PROXY_SHORTLIST_PATTERN_ID = "self-burn-proxy-shortlist";

export const selfBurnNativeDiscovery = {
  sources: ["observed-call", "address-surface"],
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
} satisfies DiscoverySemantics<SelfBurnNativeCandidate>;
