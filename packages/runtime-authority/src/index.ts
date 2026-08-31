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
  advisoryObservation: "aloha/runtime-authority/advisory-observation-binding/v1",
} as const);

export type RuntimeAuthorityClassV1 = "signed-release" | "advisory-observation";

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

export interface AdvisoryObservationRuntimeAuthorityInputV1 {
  readonly authorityClass: "advisory-observation";
  readonly observationInstanceId: Hash;
  readonly artifactClosureRoot: Hash;
  readonly implementationCommit: string;
}

export interface AdvisoryObservationRuntimeAuthorityDescriptorV1
  extends AdvisoryObservationRuntimeAuthorityInputV1 {
  readonly authorityBindingHash: Hash;
}

export type RuntimeAuthorityInputV1 =
  | SignedReleaseRuntimeAuthorityInputV1
  | AdvisoryObservationRuntimeAuthorityInputV1;

export type RuntimeAuthorityDescriptorV1 =
  | SignedReleaseRuntimeAuthorityDescriptorV1
  | AdvisoryObservationRuntimeAuthorityDescriptorV1;

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

const advisoryObservationInputSchema = objectSchema({
  authorityClass: literalSchema("advisory-observation"),
  observationInstanceId: hashSchema,
  artifactClosureRoot: hashSchema,
  implementationCommit: gitSha40Schema,
});

const advisoryObservationDescriptorSchema = objectSchema({
  authorityClass: literalSchema("advisory-observation"),
  observationInstanceId: hashSchema,
  artifactClosureRoot: hashSchema,
  implementationCommit: gitSha40Schema,
  authorityBindingHash: hashSchema,
});

export const runtimeAuthorityProjectionSchemaV1 = objectSchema({
  authorityClass: enumSchema(["signed-release", "advisory-observation"] as const),
  authorityBindingHash: hashSchema,
  implementationCommit: gitSha40Schema,
});

function decodeInput(value: unknown, path: string): RuntimeAuthorityInputV1 {
  const authorityClass = readOwnEnumerableDataProperty(value, "authorityClass", path);
  if (authorityClass === "signed-release") {
    return Object.freeze(signedReleaseInputSchema.decode(value, path));
  }
  if (authorityClass === "advisory-observation") {
    return Object.freeze(advisoryObservationInputSchema.decode(value, path));
  }
  throw new TypeError(`invalid runtime authority class at ${path}.authorityClass`);
}

function bindingHash(input: RuntimeAuthorityInputV1): Hash {
  return input.authorityClass === "signed-release"
    ? hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAINS_V1.signedRelease, input)
    : hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAINS_V1.advisoryObservation, input);
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

export function createAdvisoryObservationRuntimeAuthorityDescriptorV1(
  value: AdvisoryObservationRuntimeAuthorityInputV1,
): AdvisoryObservationRuntimeAuthorityDescriptorV1 {
  const input = advisoryObservationInputSchema.decode(value, "runtimeAuthority.advisoryObservation");
  return Object.freeze(advisoryObservationDescriptorSchema.decode({
    ...input,
    authorityBindingHash: bindingHash(input),
  }));
}

/** Exact-decode and verify the class-specific authority binding hash. */
export function decodeRuntimeAuthorityDescriptorV1(value: unknown): RuntimeAuthorityDescriptorV1 {
  const authorityClass = readOwnEnumerableDataProperty(value, "authorityClass", "runtimeAuthority.descriptor");
  const decoded = authorityClass === "signed-release"
    ? signedReleaseDescriptorSchema.decode(value, "runtimeAuthority.descriptor")
    : authorityClass === "advisory-observation"
      ? advisoryObservationDescriptorSchema.decode(value, "runtimeAuthority.descriptor")
      : null;
  if (decoded === null) {
    throw new TypeError("invalid runtime authority class at runtimeAuthority.descriptor.authorityClass");
  }
  const { authorityBindingHash, ...input } = decoded;
  if (authorityBindingHash !== bindingHash(input as RuntimeAuthorityInputV1)) {
    throw new TypeError("runtime authority binding hash mismatch");
  }
  return Object.freeze(decoded) as RuntimeAuthorityDescriptorV1;
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

export function decodeAdvisoryObservationRuntimeAuthorityDescriptorV1(
  value: unknown,
): AdvisoryObservationRuntimeAuthorityDescriptorV1 {
  const descriptor = decodeRuntimeAuthorityDescriptorV1(value);
  if (descriptor.authorityClass !== "advisory-observation") {
    throw new TypeError("runtime authority descriptor is not advisory-observation");
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
