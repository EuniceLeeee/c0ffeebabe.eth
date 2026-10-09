import type {
  CallPattern,
  DiscoverySemantics,
  LogPattern,
} from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import { yieldBasisLtNomination } from "./nomination.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import {
  LT_DEPOSIT_SELECTOR,
  LT_DEPOSIT_RECEIVER_SELECTOR,
  LT_DEPOSIT_CALL_PATTERN_ID,
  LT_DEPOSIT_RECEIVER_CALL_PATTERN_ID,
  LT_DEPOSIT_LOG_PATTERN_ID,
  LT_DEPOSIT_TOPIC,
  LT_EMERGENCY_WITHDRAW_SELECTOR,
  LT_INTERFACE,
  LT_SURFACE_PATTERN_ID,
  LT_WITHDRAW_CALL_PATTERN_ID,
  LT_WITHDRAW_LOG_PATTERN_ID,
  LT_WITHDRAW_RECEIVER_CALL_PATTERN_ID,
  LT_WITHDRAW_RECEIVER_SELECTOR,
  LT_WITHDRAW_SELECTOR,
  LT_WITHDRAW_TOPIC,
} from "./abi.js";
import type { YieldBasisLtCandidate } from "./types.js";

/**
 * Observed redemption entry points. Both nominate the same candidate (the LT
 * address) and nothing more:
 *   - `withdraw(uint256,uint256)` is the ROUTED single-asset direction;
 *   - `withdraw(uint256,uint256,address)` is the identical call with an explicit
 *     receiver, kept as OBSERVED evidence so a landed 3-argument redemption
 *     still materializes this LT. Routes are projected from the descriptor, not
 *     from an observation, so it can never become a second routed leg.
 *
 * Ordinary deposits also nominate the LT, but only a successful guarded
 * identity program may enable the deposit route. Emergency withdrawal remains
 * unsupported. Observation alone never grants a direction.
 */
const CALL_PATTERNS: readonly CallPattern[] = Object.freeze([
  Object.freeze({ id: LT_DEPOSIT_CALL_PATTERN_ID, selector: LT_DEPOSIT_SELECTOR,
    signature: "deposit(uint256,uint256,uint256)", candidateAddress: Object.freeze({ from: "call-target" as const }) }),
  Object.freeze({ id: LT_DEPOSIT_RECEIVER_CALL_PATTERN_ID, selector: LT_DEPOSIT_RECEIVER_SELECTOR,
    signature: "deposit(uint256,uint256,uint256,address)", candidateAddress: Object.freeze({ from: "call-target" as const }) }),
  Object.freeze({
    id: LT_WITHDRAW_CALL_PATTERN_ID,
    selector: LT_WITHDRAW_SELECTOR,
    signature: "withdraw(uint256,uint256)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
  }),
  Object.freeze({
    id: LT_WITHDRAW_RECEIVER_CALL_PATTERN_ID,
    selector: LT_WITHDRAW_RECEIVER_SELECTOR,
    signature: "withdraw(uint256,uint256,address)",
    candidateAddress: Object.freeze({ from: "call-target" as const }),
  }),
]);

/**
 * The LT's own `Withdraw(sender, receiver, owner, assets, shares)` event. It is
 * emitted by `withdraw` and by `emergency_withdraw` alike; because a nomination
 * only claims an address (identity still has to reverse-prove the LevAMM/pool
 * binding plus a live redemption surface), the shared topic is safe discovery
 * evidence and never an admission.
 */
const LOG_PATTERNS: readonly LogPattern[] = Object.freeze([
  Object.freeze({ id: LT_DEPOSIT_LOG_PATTERN_ID, topic: LT_DEPOSIT_TOPIC as `0x${string}`,
    signature: "Deposit(address,address,uint256,uint256)" }),
  Object.freeze({
    id: LT_WITHDRAW_LOG_PATTERN_ID,
    topic: LT_WITHDRAW_TOPIC as `0x${string}`,
    signature: "Withdraw(address,address,address,uint256,uint256)",
  }),
]);

/** Selectors that must never appear in this family's patterns or actions. */
export const YIELDBASIS_EXCLUDED_SELECTORS: readonly string[] = Object.freeze([
  LT_EMERGENCY_WITHDRAW_SELECTOR.toLowerCase(),
]);

export const yieldBasisLtDiscovery: DiscoverySemantics<
  YieldBasisLtCandidate
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
    id: LT_SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "yieldbasis-lt-levamm-surface-v1",
  })]),
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (
        observation.kind === "call" &&
        (matchedPatternId === LT_WITHDRAW_CALL_PATTERN_ID ||
          matchedPatternId === LT_WITHDRAW_RECEIVER_CALL_PATTERN_ID ||
          matchedPatternId === LT_DEPOSIT_CALL_PATTERN_ID || matchedPatternId === LT_DEPOSIT_RECEIVER_CALL_PATTERN_ID)
      ) {
        const name = matchedPatternId === LT_WITHDRAW_CALL_PATTERN_ID
          ? "withdraw(uint256,uint256)"
          : matchedPatternId === LT_WITHDRAW_RECEIVER_CALL_PATTERN_ID ? "withdraw(uint256,uint256,address)"
          : matchedPatternId === LT_DEPOSIT_CALL_PATTERN_ID ? "deposit(uint256,uint256,uint256)"
          : "deposit(uint256,uint256,uint256,address)";
        // Decode to prove the payload really is a supported redemption call.
        LT_INTERFACE.decodeFunctionData(name, observation.data);
        return Object.freeze({
          candidateKind: "yieldbasis-lt" as const,
          lt: canonicalAddress(observation.target),
        });
      }
      if (
        observation.kind === "log" &&
        ((matchedPatternId === LT_WITHDRAW_LOG_PATTERN_ID && observation.topics[0]?.toLowerCase() === LT_WITHDRAW_TOPIC) ||
          (matchedPatternId === LT_DEPOSIT_LOG_PATTERN_ID && observation.topics[0]?.toLowerCase() === LT_DEPOSIT_TOPIC))
      ) {
        LT_INTERFACE.decodeEventLog(
          matchedPatternId === LT_WITHDRAW_LOG_PATTERN_ID ? "Withdraw" : "Deposit",
          observation.data,
          [...observation.topics],
        );
        return Object.freeze({
          candidateKind: "yieldbasis-lt" as const,
          lt: canonicalAddress(observation.address),
        });
      }
      if (
        observation.kind === "address-surface" &&
        matchedPatternId === LT_SURFACE_PATTERN_ID
      ) {
        return Object.freeze({
          candidateKind: "yieldbasis-lt" as const,
          lt: canonicalAddress(observation.address),
        });
      }
    } catch {
      return null;
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.lt),
  nominate: yieldBasisLtNomination,
  reverseBinding: explicitReverseBindingUnsupported(
    "no factory() exists on a Yield Basis LT; admission is the chain-proven " +
      "mutual reference performed by the identity variant " +
      "(amm().LT_CONTRACT() == lt, amm().COLLATERAL() == CRYPTOPOOL(), " +
      "CRYPTOPOOL().coins() == [STABLECOIN(), ASSET_TOKEN()])",
  ),
};
