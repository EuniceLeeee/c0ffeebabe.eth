import {
  encodeCanonicalBytes,
  enumSchema,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  literalSchema,
  objectSchema,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../canonical-codec/src/index.ts";

export const RUNTIME_AUTHORITY_BINDING_DOMAINS_V1 = Object.freeze({
  signedRelease: "aloha/runtime-authority/signed-release-binding/v1",
  unsignedDryRun: "aloha/runtime-authority/unsigned-dry-run-binding/v1",
} as const);

export type RuntimeAuthorityClassV1 = "signed-release" | "unsigned-dry-run";

export interface SignedReleaseRuntimeAuthorityInputV1 {
  readonly authorityClass: "signed-release";
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly implementationCommit: string;
}

export interface SignedReleaseRuntimeAuthorityDescriptorV1
  extends SignedReleaseRuntimeAuthorityInputV1 {
  readonly authorityBindingHash: Hash;
}

export interface UnsignedDryRunRuntimeAuthorityInputV1 {
  readonly authorityClass: "unsigned-dry-run";
  readonly runtimeBindingId: Hash;
  readonly implementationCommit: string;
}

export interface UnsignedDryRunRuntimeAuthorityDescriptorV1
  extends UnsignedDryRunRuntimeAuthorityInputV1 {
  readonly authorityBindingHash: Hash;
}

export type RuntimeAuthorityInputV1 =
  | SignedReleaseRuntimeAuthorityInputV1
  | UnsignedDryRunRuntimeAuthorityInputV1;

export type RuntimeAuthorityDescriptorV1 =
  | SignedReleaseRuntimeAuthorityDescriptorV1
  | UnsignedDryRunRuntimeAuthorityDescriptorV1;

/*
 * These descriptors are deliberately plain, cloneable facts. They carry no
 * process-local brand, callback, issuer, or authority method. `authorityClass`
 * is the exact wire discriminator; the class-specific /v1 hash domain is the
 * schema/version identity, so redundant kind/schemaVersion fields are omitted.
 */

/** The only authority fact visible to the shared startup state machine. */
export interface RuntimeAuthorityProjectionV1 {
  readonly authorityClass: RuntimeAuthorityClassV1;
  readonly authorityBindingHash: Hash;
  readonly implementationCommit: string;
}

/** Neutral read-only fence shared by Ready/startup and both bootstrap modes. */
export type RuntimeReleaseProvenanceHashV1 = Hash | null;

export interface CurrentRuntimeAuthoritySnapshotV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  /** Present only for an externally signed release. */
  readonly releaseProvenanceHash: RuntimeReleaseProvenanceHashV1;
}

export interface CurrentRuntimeAuthorityPortV1 {
  readCurrent(): CurrentRuntimeAuthoritySnapshotV1;
}

const signedReleaseInputSchema = objectSchema({
  authorityClass: literalSchema("signed-release"),
  runtimeBindingId: hashSchema,
  releaseProvenanceHash: hashSchema,
  implementationCommit: gitSha40Schema,
});

const signedReleaseDescriptorSchema = objectSchema({
  authorityClass: literalSchema("signed-release"),
  runtimeBindingId: hashSchema,
  releaseProvenanceHash: hashSchema,
  implementationCommit: gitSha40Schema,
  authorityBindingHash: hashSchema,
});

const unsignedDryRunInputSchema = objectSchema({
  authorityClass: literalSchema("unsigned-dry-run"),
  runtimeBindingId: hashSchema,
  implementationCommit: gitSha40Schema,
});

const unsignedDryRunDescriptorSchema = objectSchema({
  authorityClass: literalSchema("unsigned-dry-run"),
  runtimeBindingId: hashSchema,
  implementationCommit: gitSha40Schema,
  authorityBindingHash: hashSchema,
});

const runtimeAuthorityClassSchema = enumSchema(["signed-release", "unsigned-dry-run"] as const);

export const runtimeAuthorityProjectionSchemaV1 = objectSchema({
  authorityClass: runtimeAuthorityClassSchema,
  authorityBindingHash: hashSchema,
  implementationCommit: gitSha40Schema,
});

function authorityClass(value: unknown, path: string): RuntimeAuthorityClassV1 {
  return runtimeAuthorityClassSchema.decode(
    readOwnEnumerableDataProperty(value, "authorityClass", path),
    `${path}.authorityClass`,
  );
}

function decodeInput(value: unknown, path: string): RuntimeAuthorityInputV1 {
  return authorityClass(value, path) === "signed-release"
    ? Object.freeze(signedReleaseInputSchema.decode(value, path))
    : Object.freeze(unsignedDryRunInputSchema.decode(value, path));
}

function bindingHash(input: RuntimeAuthorityInputV1): Hash {
  return input.authorityClass === "signed-release"
    ? hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAINS_V1.signedRelease, input)
    : hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAINS_V1.unsignedDryRun, input);
}

/** Hash an exact descriptor input under its authority-class-specific domain. */
export function runtimeAuthorityBindingHashV1(value: unknown): Hash {
  return bindingHash(decodeInput(value, "runtimeAuthority.input"));
}

export function createSignedReleaseRuntimeAuthorityDescriptorV1(
  value: SignedReleaseRuntimeAuthorityInputV1,
): SignedReleaseRuntimeAuthorityDescriptorV1 {
  const input = signedReleaseInputSchema.decode(value, "runtimeAuthority.signedRelease");
  return Object.freeze(signedReleaseDescriptorSchema.decode({
    ...input,
    authorityBindingHash: bindingHash(input),
  }));
}

export function createUnsignedDryRunRuntimeAuthorityDescriptorV1(
  value: UnsignedDryRunRuntimeAuthorityInputV1,
): UnsignedDryRunRuntimeAuthorityDescriptorV1 {
  const input = unsignedDryRunInputSchema.decode(value, "runtimeAuthority.unsignedDryRun");
  return Object.freeze(unsignedDryRunDescriptorSchema.decode({
    ...input,
    authorityBindingHash: bindingHash(input),
  }));
}

/** Exact-decode and verify the class-specific authority binding hash. */
export function decodeRuntimeAuthorityDescriptorV1(value: unknown): RuntimeAuthorityDescriptorV1 {
  const decoded = authorityClass(value, "runtimeAuthority.descriptor") === "signed-release"
    ? signedReleaseDescriptorSchema.decode(value, "runtimeAuthority.descriptor")
    : unsignedDryRunDescriptorSchema.decode(value, "runtimeAuthority.descriptor");
  const { authorityBindingHash, ...input } = decoded;
  if (authorityBindingHash !== bindingHash(input)) {
    throw new TypeError("runtime authority binding hash mismatch");
  }
  return Object.freeze(decoded);
}

export function decodeSignedReleaseRuntimeAuthorityDescriptorV1(
  value: unknown,
): SignedReleaseRuntimeAuthorityDescriptorV1 {
  const descriptor = decodeRuntimeAuthorityDescriptorV1(value);
  if (descriptor.authorityClass !== "signed-release") {
    throw new TypeError("runtime authority descriptor is not signed-release");
  }
  return descriptor;
}

export function decodeUnsignedDryRunRuntimeAuthorityDescriptorV1(
  value: unknown,
): UnsignedDryRunRuntimeAuthorityDescriptorV1 {
  const descriptor = decodeRuntimeAuthorityDescriptorV1(value);
  if (descriptor.authorityClass !== "unsigned-dry-run") {
    throw new TypeError("runtime authority descriptor is not unsigned-dry-run");
  }
  return descriptor;
}

export function encodeRuntimeAuthorityDescriptorV1(
  value: RuntimeAuthorityDescriptorV1,
): Uint8Array {
  return encodeCanonicalBytes(decodeRuntimeAuthorityDescriptorV1(value));
}

export function decodeRuntimeAuthorityProjectionV1(
  value: unknown,
): RuntimeAuthorityProjectionV1 {
  return Object.freeze(runtimeAuthorityProjectionSchemaV1.decode(value, "runtimeAuthority.projection"));
}

/** Drop class-private facts before crossing into a generic runtime core. */
export function projectRuntimeAuthorityDescriptorV1(
  value: RuntimeAuthorityDescriptorV1,
): RuntimeAuthorityProjectionV1 {
  const descriptor = decodeRuntimeAuthorityDescriptorV1(value);
  return decodeRuntimeAuthorityProjectionV1({
    authorityClass: descriptor.authorityClass,
    authorityBindingHash: descriptor.authorityBindingHash,
    implementationCommit: descriptor.implementationCommit,
  });
}
