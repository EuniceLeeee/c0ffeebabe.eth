import {
  encodeCanonicalBytes,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  literalSchema,
  objectSchema,
  type Hash,
} from "../../canonical-codec/src/index.ts";

export const RUNTIME_AUTHORITY_BINDING_DOMAINS_V1 = Object.freeze({
  signedRelease: "aloha/runtime-authority/signed-release-binding/v1",
} as const);

export type RuntimeAuthorityClassV1 = "signed-release";

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

export type RuntimeAuthorityInputV1 = SignedReleaseRuntimeAuthorityInputV1;

export type RuntimeAuthorityDescriptorV1 = SignedReleaseRuntimeAuthorityDescriptorV1;

/*
 * These descriptors are deliberately plain, cloneable facts. They carry no
 * process-local brand, callback, issuer, or authority method. `authorityClass`
 * is the exact wire discriminator; the class-specific /v1 hash domain is the
 * schema/version identity, so redundant kind/schemaVersion fields are omitted.
 */

/** The only authority fact visible to the shared startup state machine. */
export interface RuntimeAuthorityProjectionV1 {
  readonly authorityClass: "signed-release";
  readonly authorityBindingHash: Hash;
  readonly implementationCommit: string;
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

export const runtimeAuthorityProjectionSchemaV1 = objectSchema({
  authorityClass: literalSchema("signed-release"),
  authorityBindingHash: hashSchema,
  implementationCommit: gitSha40Schema,
});

function decodeInput(value: unknown, path: string): RuntimeAuthorityInputV1 {
  return Object.freeze(signedReleaseInputSchema.decode(value, path));
}

function bindingHash(input: RuntimeAuthorityInputV1): Hash {
  return hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAINS_V1.signedRelease, input);
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

/** Exact-decode and verify the signed authority binding hash. */
export function decodeRuntimeAuthorityDescriptorV1(value: unknown): RuntimeAuthorityDescriptorV1 {
  const decoded = signedReleaseDescriptorSchema.decode(value, "runtimeAuthority.descriptor");
  const { authorityBindingHash, ...input } = decoded;
  if (authorityBindingHash !== bindingHash(input)) {
    throw new TypeError("runtime authority binding hash mismatch");
  }
  return Object.freeze(decoded);
}

export function decodeSignedReleaseRuntimeAuthorityDescriptorV1(
  value: unknown,
): SignedReleaseRuntimeAuthorityDescriptorV1 {
  return decodeRuntimeAuthorityDescriptorV1(value);
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
