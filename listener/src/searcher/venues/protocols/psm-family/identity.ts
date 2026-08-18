import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeUint,
  lowerAddress,
  requireRuntimeCode,
  sameAddress,
} from "../standard-family/common.js";
import { PSM_INTERFACE, PSM_WAD } from "./codec.js";
import { PSM_FAMILY_ID, PSM_LINEAGE_ID } from "./manifest.js";
import type {
  PsmCandidate,
  PsmIdentity,
  PsmIdentityEvidence,
} from "./types.js";

export const psmIdentity = {
  variants: [{
    id: "lite-active-pair",
    kind: "standalone-contract" as const,
    lineageId: PSM_LINEAGE_ID,
    applies: () => true,
    requirements: () => ({ transports: ["get-code" as const, "eth-call" as const] }),
    buildRequests: ({ candidate }) => Object.freeze([
      codeRequest("identity-code", candidate.target),
      callRequest(
        "identity-gem",
        candidate.target,
        PSM_INTERFACE.encodeFunctionData("gem"),
      ),
      callRequest(
        "identity-dai",
        candidate.target,
        PSM_INTERFACE.encodeFunctionData("dai"),
      ),
      callRequest(
        "identity-tin",
        candidate.target,
        PSM_INTERFACE.encodeFunctionData("tin"),
      ),
      callRequest(
        "identity-tout",
        candidate.target,
        PSM_INTERFACE.encodeFunctionData("tout"),
      ),
    ]),
    decode: ({ results }) => {
      const successful = results.map((result) => {
        if (!result.ok) {
          throw new Error(`PSM identity unresolved: ${result.failure}`);
        }
        return result;
      });
      assertSameSource(successful);
      const code = requireRuntimeCode(results, "identity-code");
      return Object.freeze({
        codeHash: ethers.keccak256(code),
        gem: decodeAddress(PSM_INTERFACE, "gem", results, "identity-gem"),
        dai: decodeAddress(PSM_INTERFACE, "dai", results, "identity-dai"),
        tin: decodeUint(PSM_INTERFACE, "tin", results, "identity-tin"),
        tout: decodeUint(PSM_INTERFACE, "tout", results, "identity-tout"),
      }) satisfies PsmIdentityEvidence;
    },
    decide: ({ candidate, evidence }) => {
      if (evidence === undefined) return { status: "continue" as const };
      const proof = evidence as PsmIdentityEvidence;
      if (
        !sameAddress(proof.gem, ADDR.USDC) ||
        !sameAddress(proof.dai, ADDR.DAI) ||
        proof.tin < 0n ||
        proof.tin > PSM_WAD ||
        proof.tout < 0n ||
        proof.tout > PSM_WAD
      ) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "psm_active_pair_failed",
              evidenceRequestIds: ["lite-active-pair"],
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: PSM_FAMILY_ID,
          lineageId: PSM_LINEAGE_ID,
          subject: canonicalAddress(candidate.target),
          provenance: Object.freeze([Object.freeze({
            kind: "lite-psm-active-pair-proof",
            subject: canonicalAddress(candidate.target),
            evidenceHash: hashCanonical({
              codeHash: proof.codeHash,
              gem: lowerAddress(proof.gem),
              dai: lowerAddress(proof.dai),
              tin: proof.tin,
              tout: proof.tout,
            }),
          })]),
          gem: proof.gem,
          dai: proof.dai,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<PsmCandidate, PsmIdentity>;
