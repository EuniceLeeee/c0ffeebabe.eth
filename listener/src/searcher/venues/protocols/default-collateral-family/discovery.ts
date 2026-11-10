import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import { createAddressSurfaceNomination } from
  "../../address-surface-nomination.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import {
  DEFAULT_COLLATERAL_INTERFACE,
  DEFAULT_COLLATERAL_WITHDRAW_SELECTOR,
  DEFAULT_COLLATERAL_WITHDRAW_SIGNATURE,
  DEFAULT_COLLATERAL_WITHDRAW_TOPIC,
} from "./codec.js";
import type { DefaultCollateralCandidate } from "./types.js";

const WITHDRAW_CALL_PATTERN_ID = "default-collateral-withdraw-call";
const WITHDRAW_LOG_PATTERN_ID = "default-collateral-withdraw-log";
const SURFACE_ID = "default-collateral-surface";
export const DEFAULT_COLLATERAL_SURFACE_FINGERPRINT =
  "default-collateral-share-vault-v1";

/**
 * The verified implementation emits no ERC4626 event. Its redeem is visible
 * as an observed `withdraw(address,uint256)` call (selector 0xf3fef3a3) and as
 * its own `Withdraw(address indexed receiver,address indexed owner,uint256
 * amount)` log. Both nominate the emitting/called contract; identity (clone +
 * pinned implementation/asset runtime hashes + same-state delta) decides
 * admission, so unrelated emitters of the same selector/topic are rejected
 * rather than trusted by address.
 */
export const defaultCollateralDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["observed-call", "landed-log", "address-surface"],
  callPatterns: [{
    id: WITHDRAW_CALL_PATTERN_ID,
    selector: DEFAULT_COLLATERAL_WITHDRAW_SELECTOR as `0x${string}`,
    signature: DEFAULT_COLLATERAL_WITHDRAW_SIGNATURE,
    candidateAddress: { from: "call-target" as const },
  }],
  logPatterns: [{
    id: WITHDRAW_LOG_PATTERN_ID,
    topic: DEFAULT_COLLATERAL_WITHDRAW_TOPIC as `0x${string}`,
    signature: "Withdraw(address,address,uint256)",
  }],
  addressSurfaces: [{
    id: SURFACE_ID,
    kind: "interface" as const,
    fingerprint: DEFAULT_COLLATERAL_SURFACE_FINGERPRINT,
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (
        observation.kind === "call" &&
        matchedPatternId === WITHDRAW_CALL_PATTERN_ID
      ) {
        const args = DEFAULT_COLLATERAL_INTERFACE.decodeFunctionData(
          "withdraw",
          observation.data,
        );
        const shares = BigInt(args[1]);
        if (
          shares <= 0n ||
          DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData(
            "withdraw",
            args,
          ).toLowerCase() !== observation.data.toLowerCase()
        ) {
          return null;
        }
        return Object.freeze({
          candidateKind: "default-collateral-share-vault" as const,
          vault: canonicalAddress(observation.target),
        });
      }
      if (
        observation.kind === "log" &&
        matchedPatternId === WITHDRAW_LOG_PATTERN_ID
      ) {
        if (observation.topics.length !== 3) return null;
        const parsed = DEFAULT_COLLATERAL_INTERFACE.parseLog({
          topics: [...observation.topics],
          data: observation.data,
        });
        if (parsed === null || BigInt(parsed.args.amount) <= 0n) return null;
        return Object.freeze({
          candidateKind: "default-collateral-share-vault" as const,
          vault: canonicalAddress(observation.address),
        });
      }
      if (
        observation.kind === "address-surface" &&
        matchedPatternId === SURFACE_ID
      ) {
        return Object.freeze({
          candidateKind: "default-collateral-share-vault" as const,
          vault: canonicalAddress(observation.address),
        });
      }
      return null;
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.vault),
  nominate: createAddressSurfaceNomination({
    opaqueLabels: Object.freeze([
      "default-collateral",
      "protocol:default-collateral",
    ]),
    interfaceFingerprints: Object.freeze([
      DEFAULT_COLLATERAL_SURFACE_FINGERPRINT,
    ]),
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "EIP-1167 clone + pinned implementation/asset runtime code hashes + " +
      "same-state withdraw behavior; no factory-creation claim",
  ),
} satisfies DiscoverySemantics<DefaultCollateralCandidate>;
