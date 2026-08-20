import {
  decodeReadOnlyArtifactRef,
  type ReadOnlyArtifactRefV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createArtifactResolutionResult,
  decodeRetentionLeaseReceipt,
  decodeResolverPolicy,
  type ArtifactResolutionResultV1,
  type IssuerQualificationRegistry,
  type LeaseStore,
  type ReadOnlyContentStore,
  type ResolverPolicyV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import type { Hash, RetentionLeaseReceiptV1 } from "../../../specs/artifact-resolution/src/index.ts";
import { hashProcessAnchor, type ProductionReceiptV1 } from "../../../specs/core-envelope/src/index.ts";
import { encodeCanonicalJson, sha256Hex } from "../../../packages/canonical-codec/src/index.ts";

export interface ResolvedArtifact {
  readonly result: ArtifactResolutionResultV1;
  readonly bytes?: Uint8Array;
}

export interface ArtifactResolverDependencies {
  readonly contentStore: ReadOnlyContentStore;
  readonly leaseStore: LeaseStore;
  readonly issuerRegistry: IssuerQualificationRegistry;
  readonly resolverImplementationDigest: Hash;
  readonly resolverQualificationId: Hash;
  readonly qualificationRegistryRoot: Hash;
}

function hex(bytes: Uint8Array): string {
  let output = "0x";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

type ObservedFields = {
  readonly bytes: string | null;
  readonly observedContentSha256: Hash | null;
  readonly observedByteLength: string | null;
};

function emptyObserved(): ObservedFields {
  return {
    bytes: null,
    observedContentSha256: null,
    observedByteLength: null,
  } as const;
}

function makeResult(
  ref: ReadOnlyArtifactRefV1,
  policy: ResolverPolicyV1,
  deps: ArtifactResolverDependencies,
  resolvedAtStoreEpoch: string,
  outcome: ArtifactResolutionResultV1["outcome"],
  observed: Partial<ReturnType<typeof emptyObserved>> = {},
): ArtifactResolutionResultV1 {
  return createArtifactResolutionResult({
    artifactRefId: ref.artifactRefId,
    resolverPolicyHash: policy.policyHash,
    resolverImplementationDigest: deps.resolverImplementationDigest,
    resolverQualificationId: deps.resolverQualificationId,
    qualificationRegistryRoot: deps.qualificationRegistryRoot,
    resolvedAtStoreEpoch,
    outcome,
    ...emptyObserved(),
    ...observed,
  });
}

function leaseCovers(
  lease: RetentionLeaseReceiptV1,
  currentEpoch: string,
  minimumRemaining: string,
): boolean {
  const current = BigInt(currentEpoch);
  const from = BigInt(lease.validFromStoreEpoch);
  const through = BigInt(lease.validThroughStoreEpoch);
  return current >= from && current <= through && through - current >= BigInt(minimumRemaining);
}

export async function resolveArtifact(
  rawRef: ReadOnlyArtifactRefV1,
  rawPolicy: ResolverPolicyV1,
  dependencies: ArtifactResolverDependencies,
): Promise<ResolvedArtifact> {
  const ref = decodeReadOnlyArtifactRef(rawRef);
  const policy = decodeResolverPolicy(rawPolicy);
  const currentEpoch = await dependencies.leaseStore.currentEpoch(
    ref.immutableMirrorLocator.storeIdentityHash,
  );
  if (ref.resolverPolicyHash !== policy.policyHash) {
    return { result: makeResult(ref, policy, dependencies, currentEpoch, "mismatch") };
  }
  if (ref.immutableMirrorLocator.kind !== policy.allowedLocatorKind) {
    return { result: makeResult(ref, policy, dependencies, currentEpoch, "mismatch") };
  }
  if (BigInt(ref.byteLength) > BigInt(policy.maxByteLength)) {
    return { result: makeResult(ref, policy, dependencies, currentEpoch, "mismatch") };
  }

  const mirror = ref.immutableMirrorLocator;
  if (mirror.storeIdentityHash !== dependencies.contentStore.storeIdentityHash) {
    return { result: makeResult(ref, policy, dependencies, currentEpoch, "mismatch") };
  }
  const blob = await dependencies.contentStore.readImmutableMirror(mirror);
  if (blob === null) {
    return { result: makeResult(ref, policy, dependencies, currentEpoch, "missing") };
  }
  const observed = {
    observedContentSha256: sha256Hex(blob.bytes),
    observedByteLength: String(blob.bytes.byteLength),
  } as const;
  if (
    blob.storeIdentityHash !== mirror.storeIdentityHash ||
    blob.objectKey !== mirror.objectKey ||
    observed.observedContentSha256 !== ref.contentSha256 ||
    observed.observedByteLength !== ref.byteLength ||
    blob.mediaType !== ref.mediaType ||
    encodeCanonicalJson(blob.schema) !== encodeCanonicalJson(ref.schema)
  ) {
    return { result: makeResult(ref, policy, dependencies, currentEpoch, "mismatch") };
  }

  const rawLease = await dependencies.leaseStore.getLease(
    mirror.storeIdentityHash,
    mirror.objectKey,
    ref.contentSha256,
  );
  let lease: RetentionLeaseReceiptV1 | null = null;
  if (rawLease !== null) {
    try {
      lease = decodeRetentionLeaseReceipt(rawLease as object);
    } catch {
      lease = null;
    }
  }
  if (
    lease === null ||
    lease.receiptId !== ref.retentionLeaseReceiptId ||
    lease.storeIdentityHash !== mirror.storeIdentityHash ||
    lease.objectKey !== mirror.objectKey ||
    lease.contentSha256 !== ref.contentSha256 ||
    lease.qualificationRegistryRoot !== dependencies.qualificationRegistryRoot ||
    !leaseCovers(lease, currentEpoch, policy.minimumRemainingStoreEpochs)
  ) {
    return { result: makeResult(ref, policy, dependencies, currentEpoch, "lease-invalid") };
  }
  const issuer = await dependencies.issuerRegistry.currentIssuerQualification(
    lease.issuerQualificationId,
    lease.qualificationRegistryRoot,
  );
  if (
    issuer === null ||
    !issuer.current ||
    issuer.issuerId !== lease.issuerId ||
    issuer.issuerQualificationId !== lease.issuerQualificationId ||
    issuer.qualificationRegistryRoot !== lease.qualificationRegistryRoot
  ) {
    return { result: makeResult(ref, policy, dependencies, currentEpoch, "lease-invalid") };
  }
  const result = makeResult(ref, policy, dependencies, currentEpoch, "resolved", {
    ...observed,
    bytes: hex(blob.bytes),
  });
  return { result, bytes: blob.bytes };
}

export async function resolveArtifacts(
  refs: readonly ReadOnlyArtifactRefV1[],
  policy: ResolverPolicyV1,
  dependencies: ArtifactResolverDependencies,
): Promise<readonly ResolvedArtifact[]> {
  const output: ResolvedArtifact[] = [];
  for (const ref of refs) output.push(await resolveArtifact(ref, policy, dependencies));
  return output;
}

/** The receipt is deliberately a separate object; this helper only binds its process anchor. */
export function receiptProcessAnchorHash(receipt: ProductionReceiptV1): Hash {
  return hashProcessAnchor(receipt.producer);
}
