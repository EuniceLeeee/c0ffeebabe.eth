import {
  encodeCanonicalBytes,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  objectSchema,
  type Hash,
} from "../../canonical-codec/src/index.ts";

export const RUNTIME_AUTHORITY_BINDING_DOMAIN_V1 =
  "aloha/runtime-authority/binding/v1" as const;

/** Cloneable identity of the exact implementation admitted to this process. */
export interface RuntimeAuthorityInputV1 {
  readonly runtimeBindingId: Hash;
  readonly implementationCommit: string;
}

export interface RuntimeAuthorityDescriptorV1 extends RuntimeAuthorityInputV1 {
  readonly authorityBindingHash: Hash;
}

/** The only authority fact visible to generic runtime packages. */
export interface RuntimeAuthorityProjectionV1 {
  readonly authorityBindingHash: Hash;
  readonly implementationCommit: string;
}

export interface CurrentRuntimeAuthoritySnapshotV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
}

export interface CurrentRuntimeAuthorityPortV1 {
  readCurrent(): CurrentRuntimeAuthoritySnapshotV1;
}

const inputSchema = objectSchema({
  runtimeBindingId: hashSchema,
  implementationCommit: gitSha40Schema,
});

const descriptorSchema = objectSchema({
  runtimeBindingId: hashSchema,
  implementationCommit: gitSha40Schema,
  authorityBindingHash: hashSchema,
});

export const runtimeAuthorityProjectionSchemaV1 = objectSchema({
  authorityBindingHash: hashSchema,
  implementationCommit: gitSha40Schema,
});

function bindingHash(input: RuntimeAuthorityInputV1): Hash {
  return hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAIN_V1, input);
}

export function runtimeAuthorityBindingHashV1(value: unknown): Hash {
  return bindingHash(inputSchema.decode(value, "runtimeAuthority.input"));
}

export function createRuntimeAuthorityDescriptorV1(
  value: RuntimeAuthorityInputV1,
): RuntimeAuthorityDescriptorV1 {
  const input = inputSchema.decode(value, "runtimeAuthority.input");
  return Object.freeze(descriptorSchema.decode({
    ...input,
    authorityBindingHash: bindingHash(input),
  }));
}

export function decodeRuntimeAuthorityDescriptorV1(
  value: unknown,
): RuntimeAuthorityDescriptorV1 {
  const decoded = descriptorSchema.decode(value, "runtimeAuthority.descriptor");
  const { authorityBindingHash, ...input } = decoded;
  if (authorityBindingHash !== bindingHash(input)) {
    throw new TypeError("runtime authority binding hash mismatch");
  }
  return Object.freeze(decoded);
}

export function encodeRuntimeAuthorityDescriptorV1(
  value: RuntimeAuthorityDescriptorV1,
): Uint8Array {
  return encodeCanonicalBytes(decodeRuntimeAuthorityDescriptorV1(value));
}

export function decodeRuntimeAuthorityProjectionV1(
  value: unknown,
): RuntimeAuthorityProjectionV1 {
  return Object.freeze(runtimeAuthorityProjectionSchemaV1.decode(
    value,
    "runtimeAuthority.projection",
  ));
}

export function projectRuntimeAuthorityDescriptorV1(
  value: RuntimeAuthorityDescriptorV1,
): RuntimeAuthorityProjectionV1 {
  const descriptor = decodeRuntimeAuthorityDescriptorV1(value);
  return decodeRuntimeAuthorityProjectionV1({
    authorityBindingHash: descriptor.authorityBindingHash,
    implementationCommit: descriptor.implementationCommit,
  });
}
