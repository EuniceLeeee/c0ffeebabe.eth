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
import { GOLDX_INTERFACE } from "./codec.js";
import { GOLDX_FAMILY_ID, GOLDX_LINEAGE_ID } from "./manifest.js";
import type {
  GoldxCandidate,
  GoldxIdentity,
  GoldxIdentityEvidence,
} from "./types.js";

export const goldxIdentity = {
  variants: [{
    id: "active-unit-mint",
    kind: "standalone-contract" as const,
    lineageId: GOLDX_LINEAGE_ID,
    applies: () => true,
    requirements: () => ({ transports: ["get-code" as const, "eth-call" as const] }),
    buildRequests: ({ candidate }) => Object.freeze([
      codeRequest("identity-code", candidate.target),
      callRequest(
        "identity-unit",
        candidate.target,
        GOLDX_INTERFACE.encodeFunctionData("unit"),
      ),
    ]),
    decode: ({ results }) => {
      const successful = results.map((result) => {
        if (!result.ok) {
          throw new Error(`GOLDx identity unresolved: ${result.failure}`);
        }
        return result;
      });
      assertSameSource(successful);
      const code = requireRuntimeCode(results, "identity-code");
      return Object.freeze({
        codeHash: ethers.keccak256(code),
        unit: decodeUint(
          GOLDX_INTERFACE,
          "unit",
          results,
          "identity-unit",
        ),
      }) satisfies GoldxIdentityEvidence;
    },
    decide: ({ candidate, evidence }) => {
      if (evidence === undefined) return { status: "continue" as const };
      const proof = evidence as GoldxIdentityEvidence;
      if (proof.unit <= 0n) {
        return { status: "rejected" as const, reason: "goldx_unit_inactive" };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: GOLDX_FAMILY_ID,
          lineageId: GOLDX_LINEAGE_ID,
          subject: canonicalAddress(candidate.target),
          provenance: Object.freeze([Object.freeze({
            kind: "goldx-active-unit-proof",
            subject: canonicalAddress(candidate.target),
            evidenceHash: hashCanonical({
              codeHash: proof.codeHash,
              unit: proof.unit,
            }),
          })]),
          unit: proof.unit,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<GoldxCandidate, GoldxIdentity>;
