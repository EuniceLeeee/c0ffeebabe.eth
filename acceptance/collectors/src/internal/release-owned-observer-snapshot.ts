import { resolve } from "node:path";
import {
  assertExactKeys,
  hashDomain,
  readOwnEnumerableDataProperty,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  type RuntimeReleaseBindingV1,
} from "../../../../specs/release-authority/src/index.ts";
import { createResolverPolicy } from "../../../../specs/artifact-resolution/src/index.ts";
import { ContentAddressedObserverSinkV1 } from "../content-addressed-sink.ts";

interface ReleaseOwnedObserverSnapshotInputV1 {
  readonly binding: RuntimeReleaseBindingV1;
  readonly sourceDirectory: string;
  readonly snapshotDirectory: string;
}

/** Fixed read-only projection of the release-owned observer store. The
 * physical directory may be a root-owned frozen copy, but its logical store
 * identity remains bound to the original release-owned source directory. */
export function issueReleaseOwnedObserverSnapshotSinkV1(
  input: ReleaseOwnedObserverSnapshotInputV1,
): ContentAddressedObserverSinkV1 {
  assertExactKeys(input, ["binding", "sourceDirectory", "snapshotDirectory"], "releaseOwnedObserverSnapshot");
  const binding = decodeRuntimeReleaseBindingV1(
    readOwnEnumerableDataProperty(input, "binding", "releaseOwnedObserverSnapshot") as RuntimeReleaseBindingV1,
  );
  const sourceDirectory = readOwnEnumerableDataProperty(
    input,
    "sourceDirectory",
    "releaseOwnedObserverSnapshot",
  );
  const snapshotDirectory = readOwnEnumerableDataProperty(
    input,
    "snapshotDirectory",
    "releaseOwnedObserverSnapshot",
  );
  if (typeof sourceDirectory !== "string" || resolve(sourceDirectory) !== sourceDirectory
    || typeof snapshotDirectory !== "string" || resolve(snapshotDirectory) !== snapshotDirectory) {
    throw new TypeError("release-owned observer snapshot directories must be canonical and absolute");
  }
  const observedStoreEpoch = BigInt(binding.bindingId).toString(10);
  const storeIdentityHash = hashDomain("aloha/release-owned-observer-store-authority/v1", {
    bindingId: binding.bindingId,
    releaseAuthorityApprovalId: binding.releaseAuthorityApprovalId,
    qualificationRegistryRoot: binding.qualificationRegistryRoot,
    predicateCompositionRootDigest: binding.predicateCompositionRootDigest,
    releaseRoleManifestRoot: binding.releaseRoleManifestRoot,
    candidateReleaseCommit: binding.candidateReleaseCommit,
    directory: sourceDirectory,
    observedStoreEpoch,
  });
  return new ContentAddressedObserverSinkV1({
    directory: snapshotDirectory,
    storeIdentityHash,
    readOnly: true,
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
      issuerQualificationId: binding.releaseAuthorityApprovalId,
      qualificationRegistryRoot: binding.qualificationRegistryRoot,
    },
  });
}
