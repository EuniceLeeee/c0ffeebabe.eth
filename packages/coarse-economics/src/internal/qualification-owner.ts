import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  hashDomain,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type {
  CoarseEdgeProjectionV1,
  CoarseOutputUpperBoundV1,
  CoarseProjectionCapabilityV1,
} from "../index.ts";

export type QualifiedCoarseProjectionOwnerCapabilityV1 = object;

export interface CoarseProjectionOwnerDescriptorV1 {
  readonly ownerRef: Hash;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly schemaRef: Hash;
  readonly interpreterHash: Hash;
  readonly implementationHash: Hash;
  readonly boundVerifierHash: Hash;
}

export interface CoarseProjectionOwnerExecutionPortV1 {
  readonly read: (capability: CoarseProjectionCapabilityV1) => Readonly<{
    readonly projection: CoarseEdgeProjectionV1;
    readonly boundProofCapability: object | null;
  }>;
  readonly verifyConservativeBound: (capability: object, input: Readonly<{
    readonly projectionId: Hash;
    readonly proofProgramRef: Hash;
    readonly proofRoot: Hash;
    readonly inputCapacityUpperBound: string;
    readonly outputUpperBound: CoarseOutputUpperBoundV1;
    readonly stateFactsRoot: Hash;
  }>) => Readonly<{ readonly verificationFactRoot: Hash }>;
}

export interface QualifiedCoarseProjectionOwnerStateV1 {
  readonly releaseMembershipRoot: Hash;
  readonly descriptor: CoarseProjectionOwnerDescriptorV1;
  readonly qualificationLeafDigest: Hash;
  readonly port: CoarseProjectionOwnerExecutionPortV1;
}

const owners = new WeakMap<object, QualifiedCoarseProjectionOwnerStateV1>();
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;

function qualifiedHash(value: unknown, path: string): Hash {
  const result = assertHash(value, path);
  if (result === ZERO_HASH) throw new TypeError(`${path} must be non-zero`);
  return result;
}

/** Release-owner-only qualification. The leaf depends only on this owner and
 * its verifier implementation, never on unrelated Family membership. */
export function issueQualifiedCoarseProjectionOwnerCapabilityV1(input: {
  readonly releaseMembershipRoot: Hash;
  readonly descriptor: CoarseProjectionOwnerDescriptorV1;
  readonly port: CoarseProjectionOwnerExecutionPortV1;
}): QualifiedCoarseProjectionOwnerCapabilityV1 {
  assertPlainObject(input.descriptor, "coarseOwner.descriptor");
  assertExactKeys(input.descriptor, [
    "ownerRef", "capabilityId", "capabilityVersion", "schemaRef", "interpreterHash",
    "implementationHash", "boundVerifierHash",
  ], "coarseOwner.descriptor");
  const releaseMembershipRoot = qualifiedHash(input.releaseMembershipRoot, "coarseOwner.releaseMembershipRoot");
  const descriptor = Object.freeze({
    ownerRef: qualifiedHash(input.descriptor.ownerRef, "coarseOwner.ownerRef"),
    capabilityId: assertNonEmptyString(input.descriptor.capabilityId, "coarseOwner.capabilityId"),
    capabilityVersion: assertNonEmptyString(input.descriptor.capabilityVersion, "coarseOwner.capabilityVersion"),
    schemaRef: qualifiedHash(input.descriptor.schemaRef, "coarseOwner.schemaRef"),
    interpreterHash: qualifiedHash(input.descriptor.interpreterHash, "coarseOwner.interpreterHash"),
    implementationHash: qualifiedHash(input.descriptor.implementationHash, "coarseOwner.implementationHash"),
    boundVerifierHash: qualifiedHash(input.descriptor.boundVerifierHash, "coarseOwner.boundVerifierHash"),
  });
  if (input.port === null || typeof input.port !== "object" || typeof input.port.read !== "function" || typeof input.port.verifyConservativeBound !== "function") {
    throw new TypeError("qualified coarse projection execution port is required");
  }
  const port: CoarseProjectionOwnerExecutionPortV1 = Object.freeze({
    read: input.port.read,
    verifyConservativeBound: input.port.verifyConservativeBound,
  });
  const qualificationLeafDigest = hashDomain("aloha/coarse-owner-qualification-leaf/v1", descriptor);
  const capability = Object.freeze(Object.create(null)) as QualifiedCoarseProjectionOwnerCapabilityV1;
  owners.set(capability, Object.freeze({ releaseMembershipRoot, descriptor, qualificationLeafDigest, port }));
  return capability;
}

export function readQualifiedCoarseProjectionOwnerStateV1(value: unknown): QualifiedCoarseProjectionOwnerStateV1 {
  if (value === null || typeof value !== "object") throw new TypeError("qualified coarse owner capability is invalid");
  const state = owners.get(value);
  if (state === undefined) throw new TypeError("qualified coarse owner capability was not issued");
  return state;
}
