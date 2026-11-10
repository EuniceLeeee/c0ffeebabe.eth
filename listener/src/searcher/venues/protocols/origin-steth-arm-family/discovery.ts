import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import {
  ORIGIN_STETH_ARM_INTERFACE,
  ORIGIN_STETH_ARM_SWAP_SELECTOR,
  ORIGIN_STETH_ARM_SWAP_SIGNATURE,
} from "./codec.js";
import type { OriginStethArmCandidate } from "./types.js";
import { createAddressSurfaceNomination } from
  "../../address-surface-nomination.js";

const SWAP_PATTERN_ID = "origin-steth-arm-swap-call";
const SURFACE_ID = "origin-steth-arm-surface";
const SURFACE_FINGERPRINT = "origin-steth-arm-swap-v1";

/**
 * The ARM swap emits no event of its own; the only on-chain trace is the
 * `swapExactTokensForTokens(address,address,uint256,uint256,address)` call
 * (selector 0x6c08c57e) from the executor to the ARM proxy. Discovery
 * nominates every observed call target of that selector, and identity rejects
 * everything whose proxy/implementation code hash, stETH/WETH code hashes or
 * same-block swap behavior does not match this verified deployment.
 */
export const originStethArmDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["observed-call", "address-surface"],
  callPatterns: [{
    id: SWAP_PATTERN_ID,
    selector: ORIGIN_STETH_ARM_SWAP_SELECTOR as `0x${string}`,
    signature: ORIGIN_STETH_ARM_SWAP_SIGNATURE,
    candidateAddress: { from: "call-target" as const },
  }],
  addressSurfaces: [{
    id: SURFACE_ID,
    kind: "interface",
    fingerprint: SURFACE_FINGERPRINT,
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (observation.kind === "call" && matchedPatternId === SWAP_PATTERN_ID) {
      let amountIn: bigint;
      try {
        amountIn = BigInt(ORIGIN_STETH_ARM_INTERFACE.decodeFunctionData(
          "swapExactTokensForTokens",
          observation.data,
        )[2]);
      } catch {
        return null;
      }
      if (amountIn <= 0n) return null;
      return Object.freeze({
        candidateKind: "origin-steth-arm" as const,
        target: canonicalAddress(observation.target),
      });
    }
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === SURFACE_ID
    ) {
      return Object.freeze({
        candidateKind: "origin-steth-arm" as const,
        target: canonicalAddress(observation.address),
      });
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.target),
  nominate: createAddressSurfaceNomination({
    opaqueLabels: Object.freeze([
      "origin-steth-arm",
      "protocol:origin-steth-arm",
    ]),
    interfaceFingerprints: Object.freeze([SURFACE_FINGERPRINT]),
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "no reverse-binding registry declared (explicit unsupported)",
  ),
} satisfies DiscoverySemantics<OriginStethArmCandidate>;
