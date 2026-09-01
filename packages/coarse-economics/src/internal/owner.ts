import {
  coarseBoundVerificationReceiptRootV1,
  decodeCoarseEdgeProjectionV1,
  qualifiedCoarseProjectionReceiptRootV1,
  type CoarseBoundVerificationV1,
  type CoarseProjectionCapabilityV1,
  type CoarseProjectionServiceV1,
  type QualifiedCoarseProjectionReceiptV1,
} from "../index.ts";
import { deepFreeze } from "../../../canonical-codec/src/index.ts";
import {
  readQualifiedCoarseProjectionOwnerStateV1,
  type QualifiedCoarseProjectionOwnerCapabilityV1,
} from "./qualification-owner.ts";
import { registerCoarseProjectionServiceV1 } from "./state.ts";

/**
 * Owner-only constructor. It accepts only a process-local release-qualified
 * owner capability. Reader, implementation, and verifier authority cannot be
 * substituted at this boundary.
 */
export function issueCoarseProjectionServiceV1(input: {
  readonly owner: QualifiedCoarseProjectionOwnerCapabilityV1;
}): CoarseProjectionServiceV1 {
  const owner = readQualifiedCoarseProjectionOwnerStateV1(input.owner);
  const service = Object.freeze(Object.create(null)) as CoarseProjectionServiceV1;
  registerCoarseProjectionServiceV1(service, (capability: object): QualifiedCoarseProjectionReceiptV1 => {
    const read = owner.port.read(capability as CoarseProjectionCapabilityV1);
    if (read === null || typeof read !== "object") throw new TypeError("qualified coarse projection owner returned an invalid result");
    const projection = decodeCoarseEdgeProjectionV1(read.projection, "coarseProjection.owner.projection");
    if (projection.ownerRef !== owner.descriptor.ownerRef) throw new TypeError("coarse projection ownerRef does not match its qualified owner");
    let boundVerification: CoarseBoundVerificationV1 | null = null;
    if (projection.conservativeOutputUpperBound !== null && projection.inputCapacityUpperBound !== null) {
      if (read.boundProofCapability === null || typeof read.boundProofCapability !== "object") {
        throw new TypeError("qualified coarse projection bound proof capability is required");
      }
      const verified = owner.port.verifyConservativeBound(read.boundProofCapability, {
        projectionId: projection.projectionId,
        proofProgramRef: projection.conservativeOutputUpperBound.proofProgramRef,
        proofRoot: projection.conservativeOutputUpperBound.proofRoot,
        inputCapacityUpperBound: projection.inputCapacityUpperBound,
        outputUpperBound: projection.conservativeOutputUpperBound,
        stateFactsRoot: projection.stateFactsRoot,
      });
      const verificationBody = deepFreeze({
        schemaVersion: 1 as const,
        kind: "aloha.coarse-bound-verification-v1" as const,
        projectionId: projection.projectionId,
        ownerRef: owner.descriptor.ownerRef,
        releaseMembershipRoot: owner.releaseMembershipRoot,
        ownerQualificationLeafDigest: owner.qualificationLeafDigest,
        proofProgramRef: projection.conservativeOutputUpperBound.proofProgramRef,
        proofRoot: projection.conservativeOutputUpperBound.proofRoot,
        inputCapacityUpperBound: projection.inputCapacityUpperBound,
        outputUpperBound: projection.conservativeOutputUpperBound,
        verifierHash: owner.descriptor.boundVerifierHash,
        verificationFactRoot: verified.verificationFactRoot,
      });
      boundVerification = deepFreeze({
        ...verificationBody,
        verificationReceiptRoot: coarseBoundVerificationReceiptRootV1(verificationBody),
      });
    } else if (read.boundProofCapability !== null) {
      throw new TypeError("qualified coarse projection returned a proof capability without a bound");
    }
    const body = deepFreeze({
      schemaVersion: 1 as const,
      kind: "aloha.qualified-coarse-projection-receipt-v1" as const,
      releaseMembershipRoot: owner.releaseMembershipRoot,
      ownerQualificationLeafDigest: owner.qualificationLeafDigest,
      ownerDescriptor: owner.descriptor,
      projection,
      boundVerification,
    });
    return deepFreeze({ ...body, receiptRoot: qualifiedCoarseProjectionReceiptRootV1(body) });
  });
  return service;
}
