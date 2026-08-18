import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeUint,
  lowerAddress,
  requireRuntimeCode,
} from "../standard-family/common.js";
import { ROCKSOLID_INTERFACE, ROCKSOLID_SAMPLE } from "./codec.js";
import {
  ROCKSOLID_FAMILY_ID,
  ROCKSOLID_LINEAGE_ID,
} from "./manifest.js";
import type {
  RocksolidCandidate,
  RocksolidIdentity,
  RocksolidIdentityEvidence,
} from "./types.js";

export const rocksolidIdentity = {
  variants: [{
    id: "active-sync-deposit",
    kind: "standalone-contract" as const,
    lineageId: ROCKSOLID_LINEAGE_ID,
    applies: () => true,
    requirements: () => ({ transports: ["get-code" as const, "eth-call" as const] }),
    buildRequests: ({ candidate }) => Object.freeze([
      codeRequest("identity-code", candidate.target),
      callRequest(
        "identity-convert",
        candidate.target,
        ROCKSOLID_INTERFACE.encodeFunctionData(
          "convertToShares",
          [ROCKSOLID_SAMPLE],
        ),
      ),
    ]),
    decode: ({ results }) => {
      const successful = results.map((result) => {
        if (!result.ok) {
          throw new Error(`RockSolid identity unresolved: ${result.failure}`);
        }
        return result;
      });
      assertSameSource(successful);
      const code = requireRuntimeCode(results, "identity-code");
      return Object.freeze({
        codeHash: ethers.keccak256(code),
        sampleShares: decodeUint(
          ROCKSOLID_INTERFACE,
          "convertToShares",
          results,
          "identity-convert",
        ),
      }) satisfies RocksolidIdentityEvidence;
    },
    decide: ({ candidate, evidence }) => {
      if (evidence === undefined) return { status: "continue" as const };
      const proof = evidence as RocksolidIdentityEvidence;
      if (proof.sampleShares <= 0n) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "rocksolid_active_quote_failed",
              evidenceRequestIds: ["active-sync-deposit"],
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: ROCKSOLID_FAMILY_ID,
          lineageId: ROCKSOLID_LINEAGE_ID,
          subject: canonicalAddress(candidate.target),
          provenance: Object.freeze([Object.freeze({
            kind: "rocksolid-active-convert-proof",
            subject: canonicalAddress(candidate.target),
            evidenceHash: hashCanonical({
              codeHash: proof.codeHash,
              sampleShares: proof.sampleShares,
            }),
          })]),
          sampleShares: proof.sampleShares,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<RocksolidCandidate, RocksolidIdentity>;
