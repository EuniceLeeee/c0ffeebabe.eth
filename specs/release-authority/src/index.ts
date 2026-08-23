import {
  decodeCanonicalJson,
  defineSchema,
  defineSchemaManifest,
  deepFreeze,
  encodeCanonicalBytes,
  hashDomain,
  hashSchema,
  gitSha40Schema,
  literalSchema,
  nonEmptyStringSchema,
  objectSchema,
  type CodecSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";

/**
 * This package is a wire contract only.  It does not load GateCore,
 * acceptance code, a scheduler, a registry, or a signer.  The deployment
 * resolver verifies the external signature and returns an opaque capability
 * to the candidate runtime.
 */

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const ZERO_COMMIT = "0".repeat(40);

function fixedHexSchema(byteLength: number, kind: string): CodecSchema<string> {
  const pattern = new RegExp(`^0x[0-9a-f]{${byteLength * 2}}$`);
  return defineSchema({ kind, byteLength }, (value, path = "$") => {
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new TypeError(`expected lowercase ${byteLength}-byte 0x hex at ${path}`);
    }
    return value;
  });
}

const signatureHexSchema = fixedHexSchema(64, "runtime-release-binding-ed25519-signature");
const publicKeyHexSchema = fixedHexSchema(32, "runtime-release-binding-ed25519-public-key");

const runtimeReleaseSignerPinSchema = objectSchema({
  signerKeyId: hashSchema,
  publicKeyHex: publicKeyHexSchema,
});

const acceptanceCertificateRefSchema = objectSchema({
  certificateId: hashSchema,
  payloadHash: hashSchema,
  verdict: literalSchema("pass"),
});

/** Exact scheduler registry leaf material.  Keep this wire shape and domain
 * shared; runtime release binding must never invent a second executor leaf
 * identity that merely looks like the qualified registry. */
const qualifiedExecutorRegistryEntrySchema = objectSchema({
  executorKind: nonEmptyStringSchema,
  engineBuildFingerprint: hashSchema,
  executableFingerprint: hashSchema,
  closureFingerprint: hashSchema,
  protocolFingerprint: hashSchema,
  schemaFingerprint: hashSchema,
  releaseRoleManifestRoot: hashSchema,
  candidateCommit: gitSha40Schema,
});

const selectedExecutorSchema = qualifiedExecutorRegistryEntrySchema;

/** Narrow worker lease projection.  Runtime workers never receive the full
 * signed release binding or its certificate; the release owner derives this
 * exact projection from a verified binding and stamps a fresh worker epoch. */
const runtimeReleaseExecutorLeaseSchema = objectSchema({
  bindingId: hashSchema,
  releaseProvenanceHash: hashSchema,
  executorAuthorityRoot: hashSchema,
  qualifiedExecutorRegistryRoot: hashSchema,
  selectedExecutorLeafHash: hashSchema,
  executorKind: nonEmptyStringSchema,
  engineBuildFingerprint: hashSchema,
  executableFingerprint: hashSchema,
  closureFingerprint: hashSchema,
  protocolFingerprint: hashSchema,
  schemaFingerprint: hashSchema,
  releaseRoleManifestRoot: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  qualificationEpoch: nonEmptyStringSchema,
  predicateCompositionRootDigest: hashSchema,
  gateCoreRuntimeClosureDigest: hashSchema,
  gateCoreImplementationClosureDigest: hashSchema,
  frameworkAuthorityRoot: hashSchema,
  releaseAuthorityRoot: hashSchema,
  workerEpoch: nonEmptyStringSchema,
  executorSessionHash: hashSchema,
});

const runtimeReleaseBindingPayloadFields = {
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.runtime-release-binding"),
  acceptanceCertificate: acceptanceCertificateRefSchema,
  releaseAuthorityApprovalId: hashSchema,
  releaseAuthorityApprovalPayloadHash: hashSchema,
  authorityPinDigest: hashSchema,
  externalTrustAnchorRoot: hashSchema,
  externalIssuerKeySetRoot: hashSchema,
  qualificationRegistryApprovalId: hashSchema,
  qualificationRegistryRoot: hashSchema,
  qualificationEpoch: nonEmptyStringSchema,
  qualificationAudienceHash: hashSchema,
  predicateCompositionRootDigest: hashSchema,
  gateCoreRuntimeClosureDigest: hashSchema,
  gateCoreImplementationClosureDigest: hashSchema,
  qualifiedExecutorRegistryRoot: hashSchema,
  selectedExecutorLeafHash: hashSchema,
  selectedExecutor: selectedExecutorSchema,
  releaseRoleManifestRoot: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  workerEpoch: nonEmptyStringSchema,
  executorSessionHash: hashSchema,
  frameworkAuthorityRoot: hashSchema,
  executorAuthorityRoot: hashSchema,
  releaseAuthorityRoot: hashSchema,
  attestationProofIssuerKeyId: hashSchema,
  /** Current key authorized to issue checkpoint candidate-partition proofs. */
  candidatePartitionProofIssuerKeyId: hashSchema,
} as const;

const runtimeReleaseBindingPayloadSchema = objectSchema(runtimeReleaseBindingPayloadFields);

const runtimeReleaseBindingSchema = objectSchema({
  ...runtimeReleaseBindingPayloadFields,
  bindingId: hashSchema,
  payloadHash: hashSchema,
  signatureAlgorithm: literalSchema("ed25519"),
  signerKeyId: hashSchema,
  signatureHex: signatureHexSchema,
});

export type AcceptanceCertificateReferenceV1 = Infer<typeof acceptanceCertificateRefSchema>;
export type QualifiedExecutorRegistryEntryV1 = Infer<typeof qualifiedExecutorRegistryEntrySchema>;
export type QualifiedExecutorSelectionV1 = QualifiedExecutorRegistryEntryV1;
export type RuntimeReleaseBindingPayloadV1 = Infer<typeof runtimeReleaseBindingPayloadSchema>;
export type RuntimeReleaseBindingV1 = Infer<typeof runtimeReleaseBindingSchema>;
export type RuntimeReleaseSignerPinV1 = Infer<typeof runtimeReleaseSignerPinSchema>;
export type RuntimeReleaseExecutorLeaseV1 = Infer<typeof runtimeReleaseExecutorLeaseSchema>;

export type RuntimeReleaseBindingCodecInput = string | Uint8Array | object;

export const RELEASE_AUTHORITY_SCHEMA_MANIFESTS = Object.freeze({
  runtimeReleaseBinding: defineSchemaManifest(
    "aloha.runtime-release-binding",
    "1.0.0",
    defineSchema(
      { kind: "aloha.runtime-release-binding-v1", fields: runtimeReleaseBindingSchema.descriptor },
      (value, path = "$") => checkRuntimeReleaseBinding(runtimeReleaseBindingSchema.decode(value, path), path),
    ),
  ),
});

export const RELEASE_AUTHORITY_DOMAINS = Object.freeze({
  payload: "aloha/runtime-release-binding/payload/v1",
  id: "aloha/runtime-release-binding/id/v1",
  signing: "aloha/runtime-release-binding/signing/v1",
  provenance: "aloha/runtime-release-provenance/v1",
});

export function decodeRuntimeReleaseSignerPinV1(value: object): RuntimeReleaseSignerPinV1 {
  const decoded = runtimeReleaseSignerPinSchema.decode(value);
  requireNonZeroHash(decoded.signerKeyId, "runtimeReleaseSignerPin.signerKeyId");
  return deepFreeze(decoded);
}

export function decodeQualifiedExecutorRegistryEntryV1(
  value: RuntimeReleaseBindingCodecInput,
): QualifiedExecutorRegistryEntryV1 {
  return qualifiedExecutorRegistryEntrySchema.decode(parseInput(value));
}

export function decodeRuntimeReleaseExecutorLeaseV1(value: RuntimeReleaseBindingCodecInput): RuntimeReleaseExecutorLeaseV1 {
  return runtimeReleaseExecutorLeaseSchema.decode(parseInput(value));
}

export function hashRuntimeReleaseExecutorLeaseV1(value: RuntimeReleaseExecutorLeaseV1): Hash {
  return hashDomain("aloha/runtime-release-executor-lease/v1", decodeRuntimeReleaseExecutorLeaseV1(value));
}

export function normalizeQualifiedExecutorRegistryEntryV1(
  value: QualifiedExecutorRegistryEntryV1,
): QualifiedExecutorRegistryEntryV1 {
  return qualifiedExecutorRegistryEntrySchema.normalize(value);
}

export function hashQualifiedExecutorRegistryEntry(entry: QualifiedExecutorRegistryEntryV1): Hash {
  return hashDomain("aloha/qualified-executor-registry/v1", decodeQualifiedExecutorRegistryEntryV1(entry));
}

export function hashQualifiedExecutorRegistryRoot(entries: readonly QualifiedExecutorRegistryEntryV1[]): Hash {
  const normalized = entries.map(decodeQualifiedExecutorRegistryEntryV1);
  const leaves = normalized.map(hashQualifiedExecutorRegistryEntry);
  for (let index = 1; index < leaves.length; index += 1) {
    if (leaves[index - 1]! >= leaves[index]!) throw new TypeError("qualified executor registry entries must be strictly sorted and unique by leaf root");
  }
  return hashDomain("aloha/qualified-executor-registry-root/v1", { entries: normalized, leafRoots: leaves });
}

function payloadWithoutIdentity(value: RuntimeReleaseBindingV1): RuntimeReleaseBindingPayloadV1 {
  const {
    bindingId: _bindingId,
    payloadHash: _payloadHash,
    signatureAlgorithm: _signatureAlgorithm,
    signerKeyId: _signerKeyId,
    signatureHex: _signatureHex,
    ...payload
  } = value;
  return runtimeReleaseBindingPayloadSchema.decode(payload);
}

function requireNonZeroHash(value: Hash, path: string): void {
  if (value === ZERO_HASH) throw new TypeError(`hash must be non-zero at ${path}`);
}

function checkRuntimeReleaseBinding(value: RuntimeReleaseBindingV1, path: string): RuntimeReleaseBindingV1 {
  const selected = value.selectedExecutor;
  const selectedLeaf = hashQualifiedExecutorRegistryEntry(selected);
  if (value.selectedExecutorLeafHash !== selectedLeaf) {
    throw new TypeError(`selected executor leaf mismatch at ${path}.selectedExecutorLeafHash`);
  }
  if (
    selected.releaseRoleManifestRoot !== value.releaseRoleManifestRoot
    || selected.candidateCommit !== value.candidateReleaseCommit
  ) throw new TypeError(`selected executor release binding mismatch at ${path}`);
  if (value.candidateReleaseCommit === ZERO_COMMIT) {
    throw new TypeError(`candidate release commit must be non-zero at ${path}.candidateReleaseCommit`);
  }
  const hashFields: readonly [string, Hash][] = [
    ["acceptanceCertificate.certificateId", value.acceptanceCertificate.certificateId],
    ["acceptanceCertificate.payloadHash", value.acceptanceCertificate.payloadHash],
    ["releaseAuthorityApprovalId", value.releaseAuthorityApprovalId],
    ["releaseAuthorityApprovalPayloadHash", value.releaseAuthorityApprovalPayloadHash],
    ["authorityPinDigest", value.authorityPinDigest],
    ["externalTrustAnchorRoot", value.externalTrustAnchorRoot],
    ["externalIssuerKeySetRoot", value.externalIssuerKeySetRoot],
    ["qualificationRegistryApprovalId", value.qualificationRegistryApprovalId],
    ["qualificationRegistryRoot", value.qualificationRegistryRoot],
    ["qualificationAudienceHash", value.qualificationAudienceHash],
    ["predicateCompositionRootDigest", value.predicateCompositionRootDigest],
    ["gateCoreRuntimeClosureDigest", value.gateCoreRuntimeClosureDigest],
    ["gateCoreImplementationClosureDigest", value.gateCoreImplementationClosureDigest],
    ["qualifiedExecutorRegistryRoot", value.qualifiedExecutorRegistryRoot],
    ["selectedExecutorLeafHash", value.selectedExecutorLeafHash],
    ["releaseRoleManifestRoot", value.releaseRoleManifestRoot],
    ["executorSessionHash", value.executorSessionHash],
    ["frameworkAuthorityRoot", value.frameworkAuthorityRoot],
    ["executorAuthorityRoot", value.executorAuthorityRoot],
    ["releaseAuthorityRoot", value.releaseAuthorityRoot],
    ["attestationProofIssuerKeyId", value.attestationProofIssuerKeyId],
    ["candidatePartitionProofIssuerKeyId", value.candidatePartitionProofIssuerKeyId],
    ["signerKeyId", value.signerKeyId],
    ["bindingId", value.bindingId],
    ["payloadHash", value.payloadHash],
  ];
  for (const [field, hash] of hashFields) requireNonZeroHash(hash, `${path}.${field}`);
  if (value.acceptanceCertificate.verdict !== "pass") {
    throw new TypeError(`runtime release binding requires acceptance verdict pass at ${path}`);
  }
  const expectedPayload = hashDomain(RELEASE_AUTHORITY_DOMAINS.payload, payloadWithoutIdentity(value));
  if (value.payloadHash !== expectedPayload) throw new TypeError(`runtime release binding payloadHash mismatch at ${path}`);
  const expectedId = hashDomain(RELEASE_AUTHORITY_DOMAINS.id, { payloadHash: expectedPayload });
  if (value.bindingId !== expectedId) throw new TypeError(`runtime release binding bindingId mismatch at ${path}`);
  if (value.signatureHex === `0x${"00".repeat(64)}`) throw new TypeError(`runtime release binding signature must not be zero at ${path}`);
  return deepFreeze(value);
}

const runtimeReleaseBindingCheckedSchema = RELEASE_AUTHORITY_SCHEMA_MANIFESTS.runtimeReleaseBinding.schema;

function parseInput(value: RuntimeReleaseBindingCodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

function bindingCore(value: RuntimeReleaseBindingV1 | RuntimeReleaseBindingPayloadV1): RuntimeReleaseBindingPayloadV1 {
  if ("bindingId" in value) return payloadWithoutIdentity(runtimeReleaseBindingSchema.decode(value));
  return runtimeReleaseBindingPayloadSchema.decode(value);
}

function bindingHashes(core: RuntimeReleaseBindingPayloadV1): { readonly payloadHash: Hash; readonly bindingId: Hash } {
  const payloadHash = hashDomain(RELEASE_AUTHORITY_DOMAINS.payload, core);
  return {
    payloadHash,
    bindingId: hashDomain(RELEASE_AUTHORITY_DOMAINS.id, { payloadHash }),
  };
}

export function decodeRuntimeReleaseBindingV1(value: RuntimeReleaseBindingCodecInput): RuntimeReleaseBindingV1 {
  return runtimeReleaseBindingCheckedSchema.decode(parseInput(value));
}

export function encodeRuntimeReleaseBindingV1(value: RuntimeReleaseBindingV1): Uint8Array {
  return encodeCanonicalBytes(runtimeReleaseBindingCheckedSchema.decode(value));
}

export function createRuntimeReleaseBindingV1(
  input: RuntimeReleaseBindingPayloadV1,
  signerKeyId: Hash,
  signatureHex: string,
): RuntimeReleaseBindingV1 {
  const core = runtimeReleaseBindingPayloadSchema.decode(input);
  const signature = signatureHexSchema.decode(signatureHex);
  const normalizedSignerKeyId = hashSchema.decode(signerKeyId);
  const { payloadHash, bindingId } = bindingHashes(core);
  return runtimeReleaseBindingCheckedSchema.decode({
    ...core,
    bindingId,
    payloadHash,
    signatureAlgorithm: "ed25519",
    signerKeyId: normalizedSignerKeyId,
    signatureHex: signature,
  });
}

export function recomputeRuntimeReleaseBindingPayloadHash(value: RuntimeReleaseBindingV1): Hash {
  return bindingHashes(bindingCore(decodeRuntimeReleaseBindingV1(value))).payloadHash;
}

export function recomputeRuntimeReleaseBindingId(value: RuntimeReleaseBindingV1): Hash {
  return bindingHashes(bindingCore(decodeRuntimeReleaseBindingV1(value))).bindingId;
}

/** Exact bytes signed by the external runtime-release authority. */
export function runtimeReleaseBindingSigningBytes(
  value: RuntimeReleaseBindingV1 | RuntimeReleaseBindingPayloadV1,
  signerKeyId?: Hash,
): Uint8Array {
  const core = bindingCore(value);
  const { payloadHash, bindingId } = bindingHashes(core);
  const keyId = signerKeyId ?? ("signerKeyId" in value ? value.signerKeyId : null);
  if (keyId === null) throw new TypeError("runtime release binding signerKeyId is required for signing bytes");
  return encodeCanonicalBytes({
    domain: RELEASE_AUTHORITY_DOMAINS.signing,
    version: 1,
    bindingId,
    payloadHash,
    signerKeyId: hashSchema.decode(keyId),
    ...core,
    kind: "aloha.runtime-release-binding",
  });
}

export function runtimeReleaseBindingProvenanceHash(value: RuntimeReleaseBindingV1): Hash {
  const decoded = decodeRuntimeReleaseBindingV1(value);
  return hashDomain(RELEASE_AUTHORITY_DOMAINS.provenance, decoded);
}

/** Derive the exact worker-facing projection from an already verified release.
 * This is the only schema owner allowed to choose projection fields. */
export function createRuntimeReleaseExecutorLeaseV1(
  value: RuntimeReleaseBindingV1,
  workerEpoch: string,
  executorSessionHash: Hash,
): RuntimeReleaseExecutorLeaseV1 {
  const binding = decodeRuntimeReleaseBindingV1(value);
  const epoch = nonEmptyStringSchema.decode(workerEpoch);
  const session = hashSchema.decode(executorSessionHash);
  return decodeRuntimeReleaseExecutorLeaseV1({
    bindingId: binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    executorAuthorityRoot: binding.executorAuthorityRoot,
    qualifiedExecutorRegistryRoot: binding.qualifiedExecutorRegistryRoot,
    selectedExecutorLeafHash: binding.selectedExecutorLeafHash,
    executorKind: binding.selectedExecutor.executorKind,
    engineBuildFingerprint: binding.selectedExecutor.engineBuildFingerprint,
    executableFingerprint: binding.selectedExecutor.executableFingerprint,
    closureFingerprint: binding.selectedExecutor.closureFingerprint,
    protocolFingerprint: binding.selectedExecutor.protocolFingerprint,
    schemaFingerprint: binding.selectedExecutor.schemaFingerprint,
    releaseRoleManifestRoot: binding.releaseRoleManifestRoot,
    candidateReleaseCommit: binding.candidateReleaseCommit,
    qualificationEpoch: binding.qualificationEpoch,
    predicateCompositionRootDigest: binding.predicateCompositionRootDigest,
    gateCoreRuntimeClosureDigest: binding.gateCoreRuntimeClosureDigest,
    gateCoreImplementationClosureDigest: binding.gateCoreImplementationClosureDigest,
    frameworkAuthorityRoot: binding.frameworkAuthorityRoot,
    releaseAuthorityRoot: binding.releaseAuthorityRoot,
    workerEpoch: epoch,
    executorSessionHash: session,
  });
}

/** Neutral resolver contract; it never mints or derives release authority. */
export type RuntimeReleaseResolutionCapabilityV1 = object;

export interface RuntimeReleaseResolutionPortV1 {
  resolve(capability: RuntimeReleaseResolutionCapabilityV1): RuntimeReleaseBindingV1;
}

/**
 * Narrow current-release consumer for ReadyGeneration.  It exposes no raw
 * resolver, signer, rotation, or generic authority capability; the runtime
 * release owner supplies the process-local implementation.
 */
export interface RuntimeReleaseReadyBindingPortV1 {
  currentProvenanceHash(): Hash;
}

/**
 * The runtime release authority owns every usable downstream composition.
 * These contracts intentionally carry only opaque objects: Attestation must
 * consume the exact process-local binding issued by the runtime authority,
 * never a raw RuntimeReleaseBinding or a structural resolver supplied by a
 * caller.
 */
export type RuntimeReleaseAttestationCompositionCapabilityV1 = object;

export interface RuntimeReleaseAttestationCompositionResolvedV1 {
  readonly provenance: {
    readonly runtimeBinding: RuntimeReleaseBindingV1;
  };
}

export interface RuntimeReleaseAttestationCompositionResolutionPortV1 {
  resolve(
    capability: RuntimeReleaseAttestationCompositionCapabilityV1,
  ): RuntimeReleaseAttestationCompositionResolvedV1;
}

export interface RuntimeReleaseAttestationCompositionBindingV1 {
  readonly capability: RuntimeReleaseAttestationCompositionCapabilityV1;
  readonly resolver: RuntimeReleaseAttestationCompositionResolutionPortV1;
}
