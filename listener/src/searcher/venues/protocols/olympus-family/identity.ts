import { ethers } from "ethers";
import type { IdentitySemantics, IdentityVariant } from "../../adapter-family-plugin.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  assertSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeUint,
  lowerAddress,
  requireRuntimeCode,
  sameAddress,
  successfulResult,
} from "../standard-family/common.js";
import { OLYMPUS_ERC20_INTERFACE, OLYMPUS_INTERFACE,
  OLYMPUS_GOHM_DECIMALS, OLYMPUS_OHM_DECIMALS } from "./codec.js";
import { OLYMPUS_FAMILY_ID, OLYMPUS_LINEAGE_ID } from "./manifest.js";
import type { OlympusCandidate, OlympusIdentity, OlympusIdentityEvidence } from "./types.js";

/**
 * Runtime code pinned at the landed sample's block (26184922). The staking
 * deployment is not a proxy (its EIP-1967 implementation word is zero), so
 * the runtime code hash identifies the Olympus V3 staking implementation.
 * gOHM and OHM are the exact tokens the staking contract exposes; their
 * code hashes and decimal scales are part of the verified descriptor.
 */
export const OLYMPUS_STAKING_CODE_HASH =
  "0x6c1ff3d80434554eea4896f01540b4f810e10ef4e5e68de15de530672bb9176a";
export const OLYMPUS_GOHM_CODE_HASH =
  "0x09cabd71e420dac57ffa1cc568893a32b683d2f98076570c1756e1ec14d13bb9";
export const OLYMPUS_OHM_CODE_HASH =
  "0xbbfa9eba3c06791a338705ffc5b6566e8b1cc70a570fc7ab798d71af4dc8bcdd";

type Proof = OlympusIdentityEvidence;

function surfaceRequests(candidate: OlympusCandidate) {
  return Object.freeze([
    codeRequest("olympus-staking-code", candidate.target),
    callRequest(
      "olympus-ohm",
      candidate.target,
      OLYMPUS_INTERFACE.encodeFunctionData("OHM"),
    ),
    callRequest(
      "olympus-gohm",
      candidate.target,
      OLYMPUS_INTERFACE.encodeFunctionData("gOHM"),
    ),
  ]);
}

function tokenRequests(proof: Proof) {
  return Object.freeze([
    codeRequest("olympus-gohm-code", proof.gOHM),
    codeRequest("olympus-ohm-code", proof.OHM),
    callRequest(
      "olympus-gohm-decimals",
      proof.gOHM,
      OLYMPUS_ERC20_INTERFACE.encodeFunctionData("decimals"),
    ),
    callRequest(
      "olympus-ohm-decimals",
      proof.OHM,
      OLYMPUS_ERC20_INTERFACE.encodeFunctionData("decimals"),
    ),
  ]);
}

const variant: IdentityVariant<OlympusCandidate, OlympusIdentity, unknown> = {
  id: "olympus-staking-v3-unstake",
  kind: "standalone-contract",
  lineageId: OLYMPUS_LINEAGE_ID,
  applies: () => true,
  requirements(input) {
    const proof = input.evidence as Proof | undefined;
    return proof?.phase === "complete"
      ? { transports: [] }
      : { transports: ["get-code" as const, "eth-call" as const] };
  },
  buildRequests(input) {
    const proof = input.evidence as Proof | undefined;
    if (proof === undefined) return surfaceRequests(input.candidate);
    return proof.phase === "surface" ? tokenRequests(proof) : Object.freeze([]);
  },
  decode({ step, results }) {
    const proof = step.evidence as Proof | undefined;
    if (proof === undefined) {
      for (const result of results) if (!result.ok) throw new RequiredAdapterRequestError(result);
      const source = assertSameSource(results.map(result => successfulResult(results, result.id)));
      return Object.freeze({
        phase: "surface" as const,
        source,
        staking: canonicalAddress(step.candidate.target),
        stakingCodeHash: ethers.keccak256(
          requireRuntimeCode(results, "olympus-staking-code"),
        ),
        gOHM: decodeAddress(OLYMPUS_INTERFACE, "gOHM", results, "olympus-gohm"),
        OHM: decodeAddress(OLYMPUS_INTERFACE, "OHM", results, "olympus-ohm"),
      }) satisfies Proof;
    }
    if (proof.phase !== "surface") {
      throw new Error("Olympus unexpected identity phase");
    }
    for (const result of results) {
      assertSource(successfulResult(results, result.id).source, proof.source);
    }
    return Object.freeze({
      phase: "complete" as const,
      source: proof.source,
      staking: proof.staking,
      stakingCodeHash: proof.stakingCodeHash,
      gOHM: proof.gOHM,
      OHM: proof.OHM,
      gOhmCodeHash: ethers.keccak256(
        requireRuntimeCode(results, "olympus-gohm-code"),
      ),
      ohmCodeHash: ethers.keccak256(
        requireRuntimeCode(results, "olympus-ohm-code"),
      ),
      gOhmDecimals: decodeUint(
        OLYMPUS_ERC20_INTERFACE,
        "decimals",
        results,
        "olympus-gohm-decimals",
      ),
      ohmDecimals: decodeUint(
        OLYMPUS_ERC20_INTERFACE,
        "decimals",
        results,
        "olympus-ohm-decimals",
      ),
    }) satisfies Proof;
  },
  decide(input) {
    const proof = input.evidence as Proof | undefined;
    if (proof === undefined) return { status: "continue" };
    if (proof.phase !== "complete") return { status: "continue" };
    const rejected = (reason: string, ids: readonly string[]) =>
      ({ status: "chain-proven-rejected" as const, reasonCode: reason, evidenceRequestIds: ids });
    if (proof.stakingCodeHash.toLowerCase() !== OLYMPUS_STAKING_CODE_HASH) {
      return rejected("olympus_staking_code_not_matched", ["olympus-staking-code"]);
    }
    if (proof.gOhmCodeHash?.toLowerCase() !== OLYMPUS_GOHM_CODE_HASH) {
      return rejected("olympus_gohm_code_not_matched", ["olympus-gohm-code"]);
    }
    if (proof.ohmCodeHash?.toLowerCase() !== OLYMPUS_OHM_CODE_HASH) {
      return rejected("olympus_ohm_code_not_matched", ["olympus-ohm-code"]);
    }
    if (proof.gOhmDecimals !== OLYMPUS_GOHM_DECIMALS ||
        proof.ohmDecimals !== OLYMPUS_OHM_DECIMALS) {
      return rejected("olympus_token_decimals_not_matched",
        ["olympus-gohm-decimals", "olympus-ohm-decimals"]);
    }
    const staking = canonicalAddress(proof.staking);
    const gOHM = canonicalAddress(proof.gOHM);
    const OHM = canonicalAddress(proof.OHM);
    if (sameAddress(gOHM, OHM) || sameAddress(gOHM, staking) || sameAddress(OHM, staking) ||
        sameAddress(gOHM, ethers.ZeroAddress) || sameAddress(OHM, ethers.ZeroAddress)) {
      return rejected("olympus_token_surface_alias",
        ["olympus-gohm", "olympus-ohm"]);
    }
    return {
      status: "verified" as const,
      identity: Object.freeze({
        familyId: OLYMPUS_FAMILY_ID,
        lineageId: OLYMPUS_LINEAGE_ID,
        subject: staking,
        provenance: Object.freeze([Object.freeze({
          kind: "olympus-staking-v3-code-and-token-proof",
          subject: staking,
          evidenceHash: hashCanonical({
            stakingCodeHash: proof.stakingCodeHash.toLowerCase(),
            gOhmCodeHash: proof.gOhmCodeHash!.toLowerCase(),
            ohmCodeHash: proof.ohmCodeHash!.toLowerCase(),
            gOHM: lowerAddress(gOHM),
            OHM: lowerAddress(OHM),
            gOhmDecimals: proof.gOhmDecimals!.toString(),
            ohmDecimals: proof.ohmDecimals!.toString(),
          }),
        })]),
        gOHM,
        OHM,
        gOhmDecimals: OLYMPUS_GOHM_DECIMALS,
        ohmDecimals: OLYMPUS_OHM_DECIMALS,
      }),
    };
  },
};

export const olympusIdentity: IdentitySemantics<OlympusCandidate, OlympusIdentity> = {
  variants: [variant],
  identityKey: identity => lowerAddress(identity.subject),
};
