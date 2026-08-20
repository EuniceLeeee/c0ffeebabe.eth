import {
  decodeCanonicalJson,
  decimalStringSchema,
  defineSchemaManifest,
  enumSchema,
  encodeCanonicalBytes,
  assertPlainObject,
  hashDomain,
  hashSchema,
  literalSchema,
  nullableSchema,
  nonEmptyStringSchema,
  objectSchema,
  refineSchema,
  sha256Hex,
  stringSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";
import type { ReadOnlyArtifactRefV1, SchemaRef } from "../../core-envelope/src/index.ts";

export type { Hash } from "../../../packages/canonical-codec/src/index.ts";

const OUTCOMES = ["resolved", "missing", "mismatch", "lease-invalid"] as const;
export type ArtifactResolutionOutcome = (typeof OUTCOMES)[number];

const policyStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.artifact-resolver-policy"),
  policyHash: hashSchema,
  allowedLocatorKind: literalSchema("content-object"),
  digestAlgorithm: literalSchema("sha256"),
  maxByteLength: decimalStringSchema,
  requireExactLengthMediaAndSchema: literalSchema(true),
  minimumRemainingStoreEpochs: decimalStringSchema,
  failureOutcome: literalSchema("invalid"),
});

const leaseStructuralSchema = objectSchema({
  receiptId: hashSchema,
  storeIdentityHash: hashSchema,
  objectKey: hashSchema,
  contentSha256: hashSchema,
  validFromStoreEpoch: decimalStringSchema,
  validThroughStoreEpoch: decimalStringSchema,
  issuerId: nonEmptyStringSchema,
  issuerQualificationId: hashSchema,
  qualificationRegistryRoot: hashSchema,
});

const resolutionStructuralSchema = objectSchema({
  resultId: hashSchema,
  artifactRefId: hashSchema,
  resolverPolicyHash: hashSchema,
  resolverImplementationDigest: hashSchema,
  resolverQualificationId: hashSchema,
  qualificationRegistryRoot: hashSchema,
  resolvedAtStoreEpoch: decimalStringSchema,
  // Bytes are represented as canonical lowercase 0x-prefixed hex in the
  // wire object. The I/O adapter keeps the Uint8Array out-of-band.
  bytes: nullableSchema(stringSchema),
  observedContentSha256: nullableSchema(hashSchema),
  observedByteLength: nullableSchema(decimalStringSchema),
  outcome: enumSchema(OUTCOMES),
});

export type ResolverPolicyV1 = Infer<typeof policyStructuralSchema>;
export type RetentionLeaseReceiptV1 = Infer<typeof leaseStructuralSchema>;
export type ArtifactResolutionResultV1 = Infer<typeof resolutionStructuralSchema>;

function policyPayload(value: ResolverPolicyV1): object {
  const { policyHash: _policyHash, ...payload } = value;
  return payload;
}
function leasePayload(value: RetentionLeaseReceiptV1): object {
  const { receiptId: _receiptId, ...payload } = value;
  return payload;
}
function resolutionPayload(value: ArtifactResolutionResultV1): object {
  const { resultId: _resultId, ...payload } = value;
  return payload;
}

function refinePolicy(value: ResolverPolicyV1, path: string): ResolverPolicyV1 {
  if (BigInt(value.maxByteLength) <= 0n) {
    throw new TypeError(`maxByteLength must be positive at ${path}.maxByteLength`);
  }
  const expected = hashDomain("aloha/artifact-resolver-policy/v1", policyPayload(value));
  if (value.policyHash !== expected) {
    throw new TypeError(`policyHash does not match policy at ${path}.policyHash`);
  }
  return value;
}

function refineLease(value: RetentionLeaseReceiptV1, path: string): RetentionLeaseReceiptV1 {
  if (BigInt(value.validThroughStoreEpoch) < BigInt(value.validFromStoreEpoch)) {
    throw new TypeError(`lease interval is reversed at ${path}`);
  }
  const expected = hashDomain("aloha/retention-lease-receipt/v1", leasePayload(value));
  if (value.receiptId !== expected) {
    throw new TypeError(`receiptId does not match lease payload at ${path}.receiptId`);
  }
  return value;
}

function refineResolution(value: ArtifactResolutionResultV1, path: string): ArtifactResolutionResultV1 {
  const hasObserved = value.bytes !== null || value.observedContentSha256 !== null || value.observedByteLength !== null;
  if (value.outcome === "resolved") {
    if (!hasObserved || value.bytes === null || value.observedContentSha256 === null || value.observedByteLength === null) {
      throw new TypeError(`resolved result must carry bytes/hash/length at ${path}`);
    }
    if (!/^0x(?:[0-9a-f]{2})*$/.test(value.bytes)) {
      throw new TypeError(`resolved bytes must be lowercase even-length hex at ${path}.bytes`);
    }
    const bytes = decodeResolutionBytes(value.bytes);
    if (String(bytes.byteLength) !== value.observedByteLength) {
      throw new TypeError(`resolved byte length does not match bytes at ${path}`);
    }
    if (sha256Hex(bytes) !== value.observedContentSha256) {
      throw new TypeError(`resolved content hash does not match bytes at ${path}`);
    }
  } else if (hasObserved) {
    throw new TypeError(`non-resolved result cannot carry observed bytes/hash/length at ${path}`);
  }
  const expected = hashDomain("aloha/artifact-resolution-result/v1", resolutionPayload(value));
  if (value.resultId !== expected) {
    throw new TypeError(`resultId does not match result payload at ${path}.resultId`);
  }
  return value;
}

const policySchema = refineSchema(
  policyStructuralSchema,
  "aloha.artifact-resolver-policy.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.artifact-resolver-policy.refinement.v1",
    version: "1.0.0",
    rules: ["positive-max-byte-length", "policy-hash"],
  }),
  refinePolicy,
);
const leaseSchema = refineSchema(
  leaseStructuralSchema,
  "aloha.retention-lease-receipt.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.retention-lease-receipt.refinement.v1",
    version: "1.0.0",
    rules: ["ordered-lease-interval", "receipt-id"],
  }),
  refineLease,
);
const resolutionSchema = refineSchema(
  resolutionStructuralSchema,
  "aloha.artifact-resolution-result.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.artifact-resolution-result.refinement.v1",
    version: "1.0.0",
    rules: ["resolved-bytes-present", "lowercase-hex-byte-hash-and-length", "non-resolved-observed-fields-null", "result-id"],
  }),
  refineResolution,
);

export const ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS = Object.freeze({
  resolverPolicy: defineSchemaManifest("aloha.artifact-resolver-policy", "1.0.0", policySchema),
  retentionLeaseReceipt: defineSchemaManifest("aloha.retention-lease-receipt", "1.0.0", leaseSchema),
  artifactResolutionResult: defineSchemaManifest("aloha.artifact-resolution-result", "1.0.0", resolutionSchema),
});

export function recomputeResolverPolicyHash(value: ResolverPolicyV1): Hash {
  return hashDomain("aloha/artifact-resolver-policy/v1", policyPayload(policyStructuralSchema.decode(value)));
}
export function recomputeRetentionLeaseReceiptId(value: RetentionLeaseReceiptV1): Hash {
  return hashDomain("aloha/retention-lease-receipt/v1", leasePayload(leaseStructuralSchema.decode(value)));
}
export function recomputeArtifactResolutionResultId(value: ArtifactResolutionResultV1): Hash {
  return hashDomain("aloha/artifact-resolution-result/v1", resolutionPayload(resolutionStructuralSchema.decode(value)));
}

function parse(value: string | Uint8Array | object): unknown {
  return typeof value === "string" || value instanceof Uint8Array ? decodeCanonicalJson(value) : value;
}
export function decodeResolverPolicy(value: string | Uint8Array | object): ResolverPolicyV1 {
  return policySchema.decode(parse(value));
}
export function decodeRetentionLeaseReceipt(value: string | Uint8Array | object): RetentionLeaseReceiptV1 {
  return leaseSchema.decode(parse(value));
}
export function decodeArtifactResolutionResult(value: string | Uint8Array | object): ArtifactResolutionResultV1 {
  return resolutionSchema.decode(parse(value));
}
export function encodeResolverPolicy(value: ResolverPolicyV1): Uint8Array {
  return encodeCanonicalBytes(policySchema.decode(value));
}
export function encodeRetentionLeaseReceipt(value: RetentionLeaseReceiptV1): Uint8Array {
  return encodeCanonicalBytes(leaseSchema.decode(value));
}
export function encodeArtifactResolutionResult(value: ArtifactResolutionResultV1): Uint8Array {
  return encodeCanonicalBytes(resolutionSchema.decode(value));
}

export type ResolverPolicyDraft = Omit<ResolverPolicyV1, "policyHash">;
export type RetentionLeaseReceiptDraft = Omit<RetentionLeaseReceiptV1, "receiptId">;
export type ArtifactResolutionResultDraft = Omit<ArtifactResolutionResultV1, "resultId">;

function copyDraftData(
  draft: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
): Record<string, unknown> {
  assertPlainObject(draft, "$.draft");
  const allowed = new Set(allowedFields);
  const copied: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(draft)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`unknown draft field ${typeof key === "string" ? key : "symbol"}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(draft, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`draft field ${key} must be an enumerable data property`);
    }
    copied[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(copied, key)) {
      throw new TypeError(`missing draft field ${key}`);
    }
  }
  return copied;
}

export function createResolverPolicy(draft: ResolverPolicyDraft): ResolverPolicyV1 {
  const data = copyDraftData(
    draft,
    ["schemaVersion", "kind", "allowedLocatorKind", "digestAlgorithm", "maxByteLength", "requireExactLengthMediaAndSchema", "minimumRemainingStoreEpochs", "failureOutcome"],
    ["schemaVersion", "kind", "allowedLocatorKind", "digestAlgorithm", "maxByteLength", "requireExactLengthMediaAndSchema", "minimumRemainingStoreEpochs", "failureOutcome"],
  );
  const withoutHash = { ...data, policyHash: h0() } as ResolverPolicyV1;
  return policySchema.decode({ ...withoutHash, policyHash: recomputeResolverPolicyHash(withoutHash) });
}
export function createRetentionLeaseReceipt(draft: RetentionLeaseReceiptDraft): RetentionLeaseReceiptV1 {
  const data = copyDraftData(
    draft,
    ["storeIdentityHash", "objectKey", "contentSha256", "validFromStoreEpoch", "validThroughStoreEpoch", "issuerId", "issuerQualificationId", "qualificationRegistryRoot"],
    ["storeIdentityHash", "objectKey", "contentSha256", "validFromStoreEpoch", "validThroughStoreEpoch", "issuerId", "issuerQualificationId", "qualificationRegistryRoot"],
  );
  const withoutId = { ...data, receiptId: h0() } as RetentionLeaseReceiptV1;
  return leaseSchema.decode({ ...withoutId, receiptId: recomputeRetentionLeaseReceiptId(withoutId) });
}
export function createArtifactResolutionResult(draft: ArtifactResolutionResultDraft): ArtifactResolutionResultV1 {
  const data = copyDraftData(
    draft,
    ["artifactRefId", "resolverPolicyHash", "resolverImplementationDigest", "resolverQualificationId", "qualificationRegistryRoot", "resolvedAtStoreEpoch", "bytes", "observedContentSha256", "observedByteLength", "outcome"],
    ["artifactRefId", "resolverPolicyHash", "resolverImplementationDigest", "resolverQualificationId", "qualificationRegistryRoot", "resolvedAtStoreEpoch", "bytes", "observedContentSha256", "observedByteLength", "outcome"],
  );
  const withoutId = { ...data, resultId: h0() } as ArtifactResolutionResultV1;
  return resolutionSchema.decode({ ...withoutId, resultId: recomputeArtifactResolutionResultId(withoutId) });
}
function h0(): Hash { return `0x${"0".repeat(64)}` as Hash; }

export function decodeResolutionBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new TypeError("resolution bytes must be lowercase even-length hex");
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

export interface ImmutableMirrorBlob {
  readonly storeIdentityHash: Hash;
  readonly objectKey: Hash;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly schema: SchemaRef | null;
}
export interface ReadOnlyContentStore {
  readonly storeIdentityHash: Hash;
  readImmutableMirror(locator: ReadOnlyArtifactRefV1["immutableMirrorLocator"]): Promise<ImmutableMirrorBlob | null>;
}
export interface LeaseStore {
  getLease(storeIdentityHash: Hash, objectKey: Hash, contentSha256: Hash): Promise<unknown | null>;
  currentEpoch(storeIdentityHash: Hash): Promise<string>;
}
export interface IssuerQualificationRegistry {
  currentIssuerQualification(
    issuerQualificationId: Hash,
    qualificationRegistryRoot: Hash,
  ): Promise<{
    readonly issuerId: string;
    readonly issuerQualificationId: Hash;
    readonly qualificationRegistryRoot: Hash;
    readonly current: boolean;
  } | null>;
}
