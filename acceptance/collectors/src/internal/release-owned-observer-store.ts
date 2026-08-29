import { resolve } from "node:path";
import {
  assertExactKeys,
  assertHash,
  hashDomain,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { createResolverPolicy } from "../../../../specs/artifact-resolution/src/index.ts";
import { ContentAddressedObserverSinkV1 } from "../content-addressed-sink.ts";

export type ReleaseOwnedObserverStoreCapabilityV1 = object;

interface ReleaseOwnedObserverStoreAuthorityV1 {
  readonly bindingId: Hash;
  readonly releaseAuthorityApprovalId: Hash;
  readonly qualificationRegistryRoot: Hash;
  readonly predicateCompositionRootDigest: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly candidateReleaseCommit: string;
}

interface ReleaseOwnedObserverStoreInputV1 {
  readonly directory: string;
  readonly observedStoreEpoch: string;
  readonly authority: ReleaseOwnedObserverStoreAuthorityV1;
}

interface ReleaseOwnedObserverStoreStateV1 {
  readonly sink: ContentAddressedObserverSinkV1;
  readonly observedStoreEpoch: string;
  readonly authority: ReleaseOwnedObserverStoreAuthorityV1;
  readonly storeAuthorityRoot: Hash;
}

const stores = new WeakMap<object, ReleaseOwnedObserverStoreStateV1>();

function decimal(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${path} must be a canonical decimal`);
  }
  return value;
}

function decodeAuthority(value: unknown): ReleaseOwnedObserverStoreAuthorityV1 {
  assertExactKeys(value, [
    "bindingId",
    "releaseAuthorityApprovalId",
    "qualificationRegistryRoot",
    "predicateCompositionRootDigest",
    "releaseRoleManifestRoot",
    "candidateReleaseCommit",
  ], "releaseOwnedObserverStore.authority");
  const candidateReleaseCommit = readOwnEnumerableDataProperty(
    value, "candidateReleaseCommit", "releaseOwnedObserverStore.authority",
  );
  if (typeof candidateReleaseCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(candidateReleaseCommit)
    || candidateReleaseCommit === "0".repeat(40)) {
    throw new TypeError("release-owned observer store candidate commit is invalid");
  }
  const authority = Object.freeze({
    bindingId: assertHash(readOwnEnumerableDataProperty(value, "bindingId", "releaseOwnedObserverStore.authority"), "releaseOwnedObserverStore.authority.bindingId"),
    releaseAuthorityApprovalId: assertHash(readOwnEnumerableDataProperty(value, "releaseAuthorityApprovalId", "releaseOwnedObserverStore.authority"), "releaseOwnedObserverStore.authority.releaseAuthorityApprovalId"),
    qualificationRegistryRoot: assertHash(readOwnEnumerableDataProperty(value, "qualificationRegistryRoot", "releaseOwnedObserverStore.authority"), "releaseOwnedObserverStore.authority.qualificationRegistryRoot"),
    predicateCompositionRootDigest: assertHash(readOwnEnumerableDataProperty(value, "predicateCompositionRootDigest", "releaseOwnedObserverStore.authority"), "releaseOwnedObserverStore.authority.predicateCompositionRootDigest"),
    releaseRoleManifestRoot: assertHash(readOwnEnumerableDataProperty(value, "releaseRoleManifestRoot", "releaseOwnedObserverStore.authority"), "releaseOwnedObserverStore.authority.releaseRoleManifestRoot"),
    candidateReleaseCommit,
  });
  if (Object.entries(authority).some(([key, entry]) => key !== "candidateReleaseCommit" && entry === `0x${"0".repeat(64)}`)) {
    throw new TypeError("release-owned observer store authority contains a zero hash");
  }
  return authority;
}

/** Internal owner seam. Boundary CI permits exactly the runtime-release
 * predicate-material owner to import this issuer; no public collector barrel
 * re-exports it. */
export function issueReleaseOwnedObserverStoreV1(
  input: ReleaseOwnedObserverStoreInputV1,
): ReleaseOwnedObserverStoreCapabilityV1 {
  assertExactKeys(input, ["directory", "observedStoreEpoch", "authority"], "releaseOwnedObserverStore");
  const directoryValue = readOwnEnumerableDataProperty(input, "directory", "releaseOwnedObserverStore");
  const epochValue = readOwnEnumerableDataProperty(input, "observedStoreEpoch", "releaseOwnedObserverStore");
  const authorityValue = readOwnEnumerableDataProperty(input, "authority", "releaseOwnedObserverStore");
  if (typeof directoryValue !== "string" || directoryValue.includes("\0") || !directoryValue.startsWith("/") || resolve(directoryValue) !== directoryValue) {
    throw new TypeError("release-owned observer store directory must be canonical and absolute");
  }
  const observedStoreEpoch = decimal(epochValue, "releaseOwnedObserverStore.observedStoreEpoch");
  const authority = decodeAuthority(authorityValue);
  const storeAuthorityRoot = hashDomain("aloha/release-owned-observer-store-authority/v1", {
    ...authority,
    directory: directoryValue,
    observedStoreEpoch,
  });
  const sink = new ContentAddressedObserverSinkV1({
    directory: directoryValue,
    storeIdentityHash: storeAuthorityRoot,
    resolverPolicy: createResolverPolicy({
      schemaVersion: 1,
      kind: "aloha.artifact-resolver-policy",
      allowedLocatorKind: "content-object",
      digestAlgorithm: "sha256",
      maxByteLength: "33554432",
      requireExactLengthMediaAndSchema: true,
      minimumRemainingStoreEpochs: "0",
      failureOutcome: "invalid",
    }),
    lease: {
      validFromStoreEpoch: observedStoreEpoch,
      validThroughStoreEpoch: observedStoreEpoch,
      issuerId: "aloha.runtime-release.artifact-observer-store.v1",
      issuerQualificationId: authority.releaseAuthorityApprovalId,
      qualificationRegistryRoot: authority.qualificationRegistryRoot,
    },
  });
  const capability = Object.freeze(Object.create(null)) as object;
  stores.set(capability, Object.freeze({ sink, observedStoreEpoch, authority, storeAuthorityRoot }));
  return capability;
}

export function readReleaseOwnedObserverStoreV1(
  capability: ReleaseOwnedObserverStoreCapabilityV1,
): Readonly<ReleaseOwnedObserverStoreStateV1> {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("release-owned observer store capability is invalid");
  }
  const state = stores.get(capability);
  if (state === undefined) {
    throw new TypeError("release-owned observer store capability was not issued");
  }
  return state;
}
