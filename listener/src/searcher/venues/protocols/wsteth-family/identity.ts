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
import { WSTETH_INTERFACE, WSTETH_SAMPLE } from "./codec.js";
import { WSTETH_FAMILY_ID, WSTETH_LINEAGE_ID } from "./manifest.js";
import type {
  WstethCandidate,
  WstethIdentity,
  WstethIdentityEvidence,
} from "./types.js";

export const wstethIdentity = {
  variants: [{
    id: "steth-active-binding",
    kind: "standalone-contract" as const,
    lineageId: WSTETH_LINEAGE_ID,
    applies: (candidate: WstethCandidate) =>
      candidate.candidateKind === "wsteth-converter",
    requirements: () => ({ transports: ["get-code" as const, "eth-call" as const] }),
    buildRequests: ({ candidate }) => Object.freeze([
      codeRequest("identity-code", candidate.target),
      callRequest(
        "identity-steth",
        candidate.target,
        WSTETH_INTERFACE.encodeFunctionData("stETH"),
      ),
      callRequest(
        "identity-wrap",
        candidate.target,
        WSTETH_INTERFACE.encodeFunctionData("getWstETHByStETH", [WSTETH_SAMPLE]),
      ),
      callRequest(
        "identity-unwrap",
        candidate.target,
        WSTETH_INTERFACE.encodeFunctionData("getStETHByWstETH", [WSTETH_SAMPLE]),
      ),
    ]),
    decode: ({ results }) => {
      const successful = results.map((result) => {
        if (!result.ok) {
          throw new Error(`wstETH identity unresolved: ${result.failure}`);
        }
        return result;
      });
      assertSameSource(successful);
      const code = requireRuntimeCode(results, "identity-code");
      return Object.freeze({
        codeHash: ethers.keccak256(code),
        steth: decodeAddress(
          WSTETH_INTERFACE,
          "stETH",
          results,
          "identity-steth",
        ),
        wrapSampleOut: decodeUint(
          WSTETH_INTERFACE,
          "getWstETHByStETH",
          results,
          "identity-wrap",
        ),
        unwrapSampleOut: decodeUint(
          WSTETH_INTERFACE,
          "getStETHByWstETH",
          results,
          "identity-unwrap",
        ),
      }) satisfies WstethIdentityEvidence;
    },
    decide: ({ candidate, evidence }) => {
      if (evidence === undefined) return { status: "continue" as const };
      const proof = evidence as WstethIdentityEvidence;
      if (
        !sameAddress(proof.steth, ADDR.STETH) ||
        proof.wrapSampleOut <= 0n ||
        proof.unwrapSampleOut <= 0n
      ) {
        return {
          status: "rejected" as const,
          reason: "wsteth_active_binding_failed",
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: WSTETH_FAMILY_ID,
          lineageId: WSTETH_LINEAGE_ID,
          subject: canonicalAddress(candidate.target),
          provenance: Object.freeze([Object.freeze({
            kind: "steth-active-conversion-proof",
            subject: canonicalAddress(candidate.target),
            evidenceHash: hashCanonical({
              codeHash: proof.codeHash,
              steth: lowerAddress(proof.steth),
              wrapSampleOut: proof.wrapSampleOut,
              unwrapSampleOut: proof.unwrapSampleOut,
            }),
          })]),
          steth: proof.steth,
          wrapSampleOut: proof.wrapSampleOut,
          unwrapSampleOut: proof.unwrapSampleOut,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<WstethCandidate, WstethIdentity>;
