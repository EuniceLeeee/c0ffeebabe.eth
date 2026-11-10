import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { ORIGIN_OUSD_VAULT_INTERFACE } from "./codec.js";
import type { OriginOusdCandidate } from "./types.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";

const MINT_PATTERN_ID = "origin-ousd-mint-call";
const SURFACE_ID = "origin-ousd-vault-surface";
const SURFACE_FINGERPRINT = "origin-ousd-vault-mint-v1";

/**
 * The vault emits no mint event of its own; the only on-chain trace is the
 * `mint(uint256)` call (direct in the sample bundle) plus the OUSD Transfer
 * mint log. Discovery nominates every observed `mint(uint256)` call target and
 * the identity proof rejects everything that is not this vault proxy. The
 * address-surface lane keeps tx-bound nomination available for live use.
 */
export const originOusdDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["observed-call", "address-surface"],
  callPatterns: [{
    id: MINT_PATTERN_ID,
    selector: ORIGIN_OUSD_VAULT_INTERFACE.getFunction("mint")!.selector as `0x${string}`,
    signature: "mint(uint256)",
    candidateAddress: { from: "call-target" as const },
  }],
  addressSurfaces: [{
    id: SURFACE_ID,
    kind: "interface",
    fingerprint: SURFACE_FINGERPRINT,
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (observation.kind === "call" && matchedPatternId === MINT_PATTERN_ID) {
      let amount: bigint;
      try {
        amount = BigInt(ORIGIN_OUSD_VAULT_INTERFACE.decodeFunctionData(
          "mint",
          observation.data,
        )[0]);
      } catch {
        return null;
      }
      if (amount <= 0n) return null;
      return Object.freeze({
        candidateKind: "origin-ousd-vault" as const,
        target: canonicalAddress(observation.target),
      });
    }
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === SURFACE_ID
    ) {
      return Object.freeze({
        candidateKind: "origin-ousd-vault" as const,
        target: canonicalAddress(observation.address),
      });
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.target),
  nominate: createAddressSurfaceNomination({
    opaqueLabels: Object.freeze(["origin-ousd", "protocol:origin-ousd"]),
    interfaceFingerprints: Object.freeze([SURFACE_FINGERPRINT]),
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "no reverse-binding registry declared (explicit unsupported)",
  ),
} satisfies DiscoverySemantics<OriginOusdCandidate>;
