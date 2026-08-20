import { types as nodeTypes } from "node:util";
import {
  assertExactKeys,
  encodeCanonicalJson,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  decodeReadOnlyArtifactRef,
  decodeSchemaRef,
  type ReadOnlyArtifactRefV1,
  type SchemaRef,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  decodeResolverPolicy,
  encodeArtifactBytes,
  type ArtifactResolutionClaimV1,
  type ObservedImmutableMirrorV1,
  type ResolverPolicyV1,
} from "../../../specs/artifact-resolution/src/index.ts";

export interface ImmutableMirrorRead {
  readonly storeIdentityHash: Hash;
  readonly objectKey: Hash;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly schema: SchemaRef | null;
}

export interface ReadOnlyContentStore {
  readImmutableMirror(
    locator: ReadOnlyArtifactRefV1["immutableMirrorLocator"],
  ): Promise<ImmutableMirrorRead | null>;
}

export interface ArtifactResolverIO {
  readonly contentStore: ReadOnlyContentStore;
}

function isConcreteUint8Array(value: unknown): value is Uint8Array {
  return (
    typeof value === "object" &&
    value !== null &&
    !nodeTypes.isProxy(value) &&
    ArrayBuffer.isView(value) &&
    Object.getPrototypeOf(value) === Uint8Array.prototype &&
    Object.getOwnPropertyDescriptor(value, "length") === undefined
  );
}

function normalizeMirror(
  raw: unknown,
  maxByteLength: bigint,
): ObservedImmutableMirrorV1 | null {
  assertExactKeys(
    raw,
    ["storeIdentityHash", "objectKey", "bytes", "mediaType", "schema"],
    "$.immutableMirrorRead",
  );
  const rawBytes = readOwnEnumerableDataProperty(
    raw,
    "bytes",
    "$.immutableMirrorRead",
  );
  if (!isConcreteUint8Array(rawBytes)) {
    throw new TypeError("immutable mirror bytes must be a concrete Uint8Array");
  }
  if (BigInt(rawBytes.length) > maxByteLength) return null;
  const bytes = new Uint8Array(rawBytes.length);
  for (let index = 0; index < rawBytes.length; index += 1) {
    bytes[index] = rawBytes[index]!;
  }
  const rawSchema = readOwnEnumerableDataProperty(
    raw,
    "schema",
    "$.immutableMirrorRead",
  );
  if (rawSchema !== null && (typeof rawSchema !== "object" || rawSchema === null)) {
    throw new TypeError("immutable mirror schema must be an exact SchemaRef or null");
  }
  const schema = rawSchema === null
    ? null
    : decodeSchemaRef(rawSchema as object);
  return createObservedImmutableMirror({
    storeIdentityHash: readOwnEnumerableDataProperty(
      raw,
      "storeIdentityHash",
      "$.immutableMirrorRead",
    ) as Hash,
    objectKey: readOwnEnumerableDataProperty(
      raw,
      "objectKey",
      "$.immutableMirrorRead",
    ) as Hash,
    bytes: encodeArtifactBytes(bytes),
    mediaType: readOwnEnumerableDataProperty(
      raw,
      "mediaType",
      "$.immutableMirrorRead",
    ) as string,
    schema,
  });
}

function mirrorMatches(
  ref: ReadOnlyArtifactRefV1,
  mirror: ObservedImmutableMirrorV1,
): boolean {
  return (
    mirror.storeIdentityHash === ref.immutableMirrorLocator.storeIdentityHash &&
    mirror.objectKey === ref.immutableMirrorLocator.objectKey &&
    mirror.contentSha256 === ref.contentSha256 &&
    mirror.byteLength === ref.byteLength &&
    mirror.mediaType === ref.mediaType &&
    encodeCanonicalJson(mirror.schema) === encodeCanonicalJson(ref.schema)
  );
}

function createClaim(
  ref: ReadOnlyArtifactRefV1,
  policy: ResolverPolicyV1,
  observedMirror: ObservedImmutableMirrorV1 | null,
  outcome: ArtifactResolutionClaimV1["outcome"],
): ArtifactResolutionClaimV1 {
  return createArtifactResolutionClaim({
    artifactRefId: ref.artifactRefId,
    resolverPolicyHash: policy.policyHash,
    observedMirror,
    outcome,
  });
}

/**
 * Reads immutable content and emits an untrusted, fully self-contained claim.
 * Qualification, lease currentness and acceptance belong exclusively to
 * GateCore and are deliberately absent from this package.
 */
export async function resolveArtifactClaim(
  rawRef: ReadOnlyArtifactRefV1,
  rawPolicy: ResolverPolicyV1,
  io: ArtifactResolverIO,
): Promise<ArtifactResolutionClaimV1> {
  const ref = decodeReadOnlyArtifactRef(rawRef);
  const policy = decodeResolverPolicy(rawPolicy);
  if (
    ref.resolverPolicyHash !== policy.policyHash ||
    BigInt(ref.byteLength) > BigInt(policy.maxByteLength)
  ) {
    return createClaim(ref, policy, null, "content-mismatch");
  }

  const rawMirror = await io.contentStore.readImmutableMirror(
    ref.immutableMirrorLocator,
  );
  if (rawMirror === null) {
    return createClaim(ref, policy, null, "missing");
  }
  const mirror = normalizeMirror(rawMirror, BigInt(policy.maxByteLength));
  if (mirror === null) {
    return createClaim(ref, policy, null, "content-mismatch");
  }
  return createClaim(
    ref,
    policy,
    mirror,
    mirrorMatches(ref, mirror) ? "content-observed" : "content-mismatch",
  );
}

export async function resolveArtifactClaims(
  refs: readonly ReadOnlyArtifactRefV1[],
  policy: ResolverPolicyV1,
  io: ArtifactResolverIO,
): Promise<readonly ArtifactResolutionClaimV1[]> {
  const claims: ArtifactResolutionClaimV1[] = [];
  for (const ref of refs) {
    claims.push(await resolveArtifactClaim(ref, policy, io));
  }
  return Object.freeze(claims);
}
