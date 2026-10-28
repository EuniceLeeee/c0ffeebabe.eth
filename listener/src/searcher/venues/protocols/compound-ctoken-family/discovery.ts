import type {
  CallPattern,
  DiscoverySemantics,
  LogPattern,
} from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import { compoundCTokenNomination } from "./nomination.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import {
  CTOKEN_INTERFACE,
  CTOKEN_REDEEM_CALL_PATTERN_ID,
  CTOKEN_REDEEM_LOG_PATTERN_ID,
  CTOKEN_REDEEM_SELECTOR,
  CTOKEN_REDEEM_TOPIC,
  CTOKEN_REDEEM_UNDERLYING_CALL_PATTERN_ID,
  CTOKEN_REDEEM_UNDERLYING_SELECTOR,
  CTOKEN_SURFACE_PATTERN_ID,
} from "./abi.js";
import type { CompoundCTokenCandidate } from "./types.js";

const CALL_PATTERNS: readonly CallPattern[] = Object.freeze([
  Object.freeze({
    id: CTOKEN_REDEEM_CALL_PATTERN_ID,
    selector: CTOKEN_REDEEM_SELECTOR,
    signature: "redeem(uint256)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
  }),
  Object.freeze({
    id: CTOKEN_REDEEM_UNDERLYING_CALL_PATTERN_ID,
    selector: CTOKEN_REDEEM_UNDERLYING_SELECTOR,
    signature: "redeemUnderlying(uint256)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
  }),
]);

const LOG_PATTERNS: readonly LogPattern[] = Object.freeze([
  Object.freeze({
    id: CTOKEN_REDEEM_LOG_PATTERN_ID,
    topic: CTOKEN_REDEEM_TOPIC as `0x${string}`,
    signature: "Redeem(address,uint256,uint256)",
  }),
]);

/**
 * Both observed redemption entry points nominate a market:
 *   - `redeem(uint256)` is the ROUTED share→underlying direction,
 *   - `redeemUnderlying(uint256)` is observed-only evidence: its argument is an
 *     underlying OUTPUT amount, so it can never be a routed leg.
 *
 * `txSeedNominations` lets the framework hand this family transaction seeds,
 * which the shared tx-evidence nomination re-materializes into real
 * receipt/trace observations. The Comptroller registry — not this pattern list
 * and not any address allowlist — decides admission.
 */
export const compoundCTokenDiscovery: DiscoverySemantics<
  CompoundCTokenCandidate
> = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: Object.freeze([
    "observed-call" as const,
    "landed-log" as const,
    "address-surface" as const,
  ]),
  candidateSources: Object.freeze([
    "dex-token-domain" as const,
    "observed-interaction" as const,
  ]),
  callPatterns: CALL_PATTERNS,
  logPatterns: LOG_PATTERNS,
  addressSurfaces: Object.freeze([Object.freeze({
    id: CTOKEN_SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "compound-v2-ctoken-comptroller-surface-v1",
  })]),
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (
        observation.kind === "call" &&
        (matchedPatternId === CTOKEN_REDEEM_CALL_PATTERN_ID ||
          matchedPatternId === CTOKEN_REDEEM_UNDERLYING_CALL_PATTERN_ID)
      ) {
        const name = matchedPatternId === CTOKEN_REDEEM_CALL_PATTERN_ID
          ? "redeem"
          : "redeemUnderlying";
        // Decode to prove the payload really is a redemption call.
        CTOKEN_INTERFACE.decodeFunctionData(name, observation.data);
        return Object.freeze({
          candidateKind: "compound-ctoken-market" as const,
          market: canonicalAddress(observation.target),
        });
      }
      if (
        observation.kind === "log" &&
        matchedPatternId === CTOKEN_REDEEM_LOG_PATTERN_ID &&
        observation.topics[0]?.toLowerCase() === CTOKEN_REDEEM_TOPIC
      ) {
        CTOKEN_INTERFACE.decodeEventLog(
          "Redeem",
          observation.data,
          [...observation.topics],
        );
        return Object.freeze({
          candidateKind: "compound-ctoken-market" as const,
          market: canonicalAddress(observation.address),
        });
      }
      if (
        observation.kind === "address-surface" &&
        matchedPatternId === CTOKEN_SURFACE_PATTERN_ID
      ) {
        return Object.freeze({
          candidateKind: "compound-ctoken-market" as const,
          market: canonicalAddress(observation.address),
        });
      }
    } catch {
      return null;
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.market),
  nominate: compoundCTokenNomination,
  reverseBinding: explicitReverseBindingUnsupported(
    "no per-instance reverse registry declared; admission is the Comptroller " +
      "markets()/getAllMarkets() chain proof performed by the identity variant",
  ),
};
