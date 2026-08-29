import { types as nodeTypes } from "node:util";
import {
  CANONICAL_LIMITS,
  arraySchema,
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertPlainObject,
  decodeCanonicalJson,
  decimalStringSchema,
  defineSchemaManifest,
  encodeCanonicalBytes,
  enumSchema,
  hashDomain,
  hashSchema,
  literalSchema,
  nonEmptyStringSchema,
  nullableSchema,
  objectSchema,
  readOwnEnumerableDataProperty,
  refineSchema,
  sha256Hex,
  stringSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  CORE_SCHEMA_MANIFESTS,
  type SchemaRef,
} from "../../core-envelope/src/index.ts";

export type { Hash } from "../../../packages/canonical-codec/src/index.ts";

const CLAIM_OUTCOMES = [
  "content-observed",
  "missing",
  "content-mismatch",
] as const;

export type ArtifactResolutionClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

const schemaRefSchema = CORE_SCHEMA_MANIFESTS.schemaRef.schema;

/**
 * A chunk hex string is strictly smaller than the canonical string ceiling.
 * The size is part of the artifact-bytes wire contract, not a tuning hint.
 */
export const ARTIFACT_BYTES_CHUNK_BYTE_LENGTH = 65_534;
/** Maximum inline mirror payload that still fits inside one 1 MiB canonical claim envelope. */
export const ARTIFACT_MIRROR_MAX_DECODED_BYTES = 500_000;

const artifactBytesChunkStructuralSchema = objectSchema({
  index: decimalStringSchema,
  bytes: stringSchema,
});

const artifactBytesStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.canonical-artifact-bytes"),
  byteLength: decimalStringSchema,
  contentSha256: hashSchema,
  chunks: arraySchema(artifactBytesChunkStructuralSchema),
});

export type ArtifactBytesChunkV1 = Infer<typeof artifactBytesChunkStructuralSchema>;
export type ArtifactBytesV1 = Infer<typeof artifactBytesStructuralSchema>;

function decodeHexChunk(value: string, path: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new TypeError(`artifact byte chunk must be lowercase even-length hex at ${path}`);
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

/** Codec for contracts whose wire field is explicitly a single bounded hex string, never a mirror. */
export function decodeArtifactHexBytes(value: unknown, path = "$"): Uint8Array {
  if (typeof value !== "string" || value.length > CANONICAL_LIMITS.maxStringCodeUnits) {
    throw new TypeError(`artifact hex bytes must be a bounded string at ${path}`);
  }
  return decodeHexChunk(value, path);
}

function assertConcreteArtifactBytes(bytes: Uint8Array): void {
  if (
    !ArrayBuffer.isView(bytes)
    || Object.getPrototypeOf(bytes) !== Uint8Array.prototype
    || Object.getOwnPropertyDescriptor(bytes, "length") !== undefined
  ) {
    throw new TypeError("artifact bytes must be a concrete Uint8Array");
  }
}

export function encodeArtifactHexBytes(bytes: Uint8Array): string {
  assertConcreteArtifactBytes(bytes);
  const encodedLength = 2 + bytes.byteLength * 2;
  if (encodedLength > CANONICAL_LIMITS.maxStringCodeUnits) {
    throw new TypeError("artifact hex bytes exceed canonical string bound");
  }
  let output = "0x";
  for (let index = 0; index < bytes.length; index += 1) {
    output += bytes[index]!.toString(16).padStart(2, "0");
  }
  return output;
}

/** Validate the exact chunk envelope and return its decoded byte count without allocating it. */
export function preflightArtifactBytesByteLength(value: unknown, path = "$"): bigint {
  assertPlainObject(value, path);
  assertExactKeys(value, ["schemaVersion", "kind", "byteLength", "contentSha256", "chunks"], path);
  if (readOwnEnumerableDataProperty(value, "schemaVersion", path) !== 1) {
    throw new TypeError(`artifact bytes schemaVersion is invalid at ${path}.schemaVersion`);
  }
  if (readOwnEnumerableDataProperty(value, "kind", path) !== "aloha.canonical-artifact-bytes") {
    throw new TypeError(`artifact bytes kind is invalid at ${path}.kind`);
  }
  const declaredByteLength = BigInt(assertDecimalString(
    readOwnEnumerableDataProperty(value, "byteLength", path),
    `${path}.byteLength`,
  ));
  assertHash(readOwnEnumerableDataProperty(value, "contentSha256", path), `${path}.contentSha256`);
  if (declaredByteLength > BigInt(ARTIFACT_MIRROR_MAX_DECODED_BYTES)) {
    throw new TypeError(`artifact bytes exceed mirror decoded-byte bound at ${path}.byteLength`);
  }
  const chunksValue = readOwnEnumerableDataProperty(value, "chunks", path);
  const chunksPath = `${path}.chunks`;
  if (!Array.isArray(chunksValue) || nodeTypes.isProxy(chunksValue)) {
    throw new TypeError(`artifact byte chunks must be a concrete array at ${chunksPath}`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(chunksValue, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new TypeError(`artifact byte chunks length is invalid at ${chunksPath}`);
  }
  const expectedChunkCount = declaredByteLength === 0n ? 0 : Number(
    (declaredByteLength + BigInt(ARTIFACT_BYTES_CHUNK_BYTE_LENGTH) - 1n)
    / BigInt(ARTIFACT_BYTES_CHUNK_BYTE_LENGTH),
  );
  if (lengthDescriptor.value !== expectedChunkCount) {
    throw new TypeError(`artifact byte chunk count does not match byteLength at ${chunksPath}`);
  }
  const chunkKeys = Reflect.ownKeys(chunksValue);
  if (chunkKeys.length !== expectedChunkCount + 1
    || chunkKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)
      || Number(key) >= expectedChunkCount))) {
    throw new TypeError(`artifact byte chunks contain sparse or extra properties at ${chunksPath}`);
  }
  let decodedByteLength = 0;
  for (let position = 0; position < expectedChunkCount; position += 1) {
    const chunkPath = `${path}.chunks[${position}]`;
    const descriptor = Object.getOwnPropertyDescriptor(chunksValue, String(position));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`artifact byte chunk must be an enumerable data item at ${chunkPath}`);
    }
    const chunk = descriptor.value;
    assertPlainObject(chunk, chunkPath);
    assertExactKeys(chunk, ["index", "bytes"], chunkPath);
    const index = assertDecimalString(
      readOwnEnumerableDataProperty(chunk, "index", chunkPath),
      `${chunkPath}.index`,
    );
    if (index !== String(position)) {
      throw new TypeError(`artifact byte chunk index is not canonical at ${chunkPath}.index`);
    }
    const bytes = readOwnEnumerableDataProperty(chunk, "bytes", chunkPath);
    if (typeof bytes !== "string" || bytes.length >= CANONICAL_LIMITS.maxStringCodeUnits
      || !/^0x(?:[0-9a-f]{2})*$/.test(bytes)) {
      throw new TypeError(`artifact byte chunk must be canonical lowercase even-length hex at ${chunkPath}.bytes`);
    }
    const chunkByteLength = (bytes.length - 2) / 2;
    const isFinal = position === expectedChunkCount - 1;
    if ((!isFinal && chunkByteLength !== ARTIFACT_BYTES_CHUNK_BYTE_LENGTH)
      || (isFinal && (chunkByteLength === 0 || chunkByteLength > ARTIFACT_BYTES_CHUNK_BYTE_LENGTH))) {
      throw new TypeError(`artifact byte chunk length is not canonical at ${chunkPath}.bytes`);
    }
    decodedByteLength += chunkByteLength;
    if (decodedByteLength > ARTIFACT_MIRROR_MAX_DECODED_BYTES) {
      throw new TypeError(`artifact bytes exceed mirror decoded-byte bound at ${path}.chunks`);
    }
  }
  if (BigInt(decodedByteLength) !== declaredByteLength) {
    throw new TypeError(`artifact byteLength does not match chunks at ${path}.byteLength`);
  }
  return declaredByteLength;
}

function decodeValidatedArtifactBytes(value: ArtifactBytesV1, path: string): Uint8Array {
  const decodedByteLength = Number(preflightArtifactBytesByteLength(value, path));
  const decodedChunks = value.chunks.map((chunk, position) =>
    decodeHexChunk(chunk.bytes, `${path}.chunks[${position}].bytes`));

  const output = new Uint8Array(decodedByteLength);
  let offset = 0;
  for (const chunk of decodedChunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (sha256Hex(output) !== value.contentSha256) {
    throw new TypeError(`artifact contentSha256 does not match chunks at ${path}.contentSha256`);
  }
  return output;
}

const artifactBytesSchema = refineSchema(
  artifactBytesStructuralSchema,
  "aloha.canonical-artifact-bytes.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.canonical-artifact-bytes.refinement.v1",
    version: "1.0.0",
    rules: [
      "single-wire-shape",
      "empty-bytes-have-zero-chunks",
      "chunk-index-matches-array-position",
      `non-final-chunks-exactly-${ARTIFACT_BYTES_CHUNK_BYTE_LENGTH}-bytes`,
      `final-chunk-one-through-${ARTIFACT_BYTES_CHUNK_BYTE_LENGTH}-bytes`,
      `max-inline-decoded-bytes-${ARTIFACT_MIRROR_MAX_DECODED_BYTES}`,
      "chunks-lowercase-even-length-hex",
      "byte-length-matches-chunks",
      "content-sha256-matches-chunks",
      "decoded-bytes-within-inline-mirror-bound",
    ],
  }),
  (value, path) => {
    decodeValidatedArtifactBytes(value, path);
    return value;
  },
);

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

const observedMirrorStructuralSchema = objectSchema({
  storeIdentityHash: hashSchema,
  objectKey: hashSchema,
  bytes: artifactBytesSchema,
  contentSha256: hashSchema,
  byteLength: decimalStringSchema,
  mediaType: nonEmptyStringSchema,
  schema: nullableSchema(schemaRefSchema),
});

export type ObservedImmutableMirrorV1 = Infer<typeof observedMirrorStructuralSchema>;

function refineObservedMirror(
  value: ObservedImmutableMirrorV1,
  path: string,
): ObservedImmutableMirrorV1 {
  if (value.bytes.byteLength !== value.byteLength) {
    throw new TypeError(`outer byteLength does not match artifact bytes at ${path}.byteLength`);
  }
  if (value.bytes.contentSha256 !== value.contentSha256) {
    throw new TypeError(`outer contentSha256 does not match artifact bytes at ${path}.contentSha256`);
  }
  return value;
}

const observedMirrorSchema = refineSchema(
  observedMirrorStructuralSchema,
  "aloha.observed-immutable-mirror.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.observed-immutable-mirror.refinement.v1",
    version: "1.0.0",
    rules: [
      "bytes-use-canonical-chunked-wire-shape",
      "byte-length-matches-bytes",
      "content-sha256-matches-bytes",
      "media-type-non-empty",
      "schema-exact-or-null",
    ],
  }),
  refineObservedMirror,
);

const claimStructuralSchema = objectSchema({
  claimId: hashSchema,
  artifactRefId: hashSchema,
  resolverPolicyHash: hashSchema,
  observedMirror: nullableSchema(observedMirrorSchema),
  outcome: enumSchema(CLAIM_OUTCOMES),
});

export type ResolverPolicyV1 = Infer<typeof policyStructuralSchema>;
export type RetentionLeaseReceiptV1 = Infer<typeof leaseStructuralSchema>;
export type ArtifactResolutionClaimV1 = Infer<typeof claimStructuralSchema>;

function policyPayload(value: ResolverPolicyV1): object {
  const { policyHash: _policyHash, ...payload } = value;
  return payload;
}

function leasePayload(value: RetentionLeaseReceiptV1): object {
  const { receiptId: _receiptId, ...payload } = value;
  return payload;
}

function claimPayload(value: ArtifactResolutionClaimV1): object {
  const { claimId: _claimId, ...payload } = value;
  return payload;
}

function refinePolicy(value: ResolverPolicyV1, path: string): ResolverPolicyV1 {
  if (BigInt(value.maxByteLength) <= 0n) {
    throw new TypeError(`maxByteLength must be positive at ${path}.maxByteLength`);
  }
  const expected = hashDomain(
    "aloha/artifact-resolver-policy/v1",
    policyPayload(value),
  );
  if (value.policyHash !== expected) {
    throw new TypeError(`policyHash does not match policy at ${path}.policyHash`);
  }
  return value;
}

function refineLease(
  value: RetentionLeaseReceiptV1,
  path: string,
): RetentionLeaseReceiptV1 {
  if (BigInt(value.validThroughStoreEpoch) < BigInt(value.validFromStoreEpoch)) {
    throw new TypeError(`lease interval is reversed at ${path}`);
  }
  const expected = hashDomain(
    "aloha/retention-lease-receipt/v1",
    leasePayload(value),
  );
  if (value.receiptId !== expected) {
    throw new TypeError(`receiptId does not match lease payload at ${path}.receiptId`);
  }
  return value;
}

function refineClaim(
  value: ArtifactResolutionClaimV1,
  path: string,
): ArtifactResolutionClaimV1 {
  if (value.outcome === "content-observed" && value.observedMirror === null) {
    throw new TypeError(`content-observed claim requires observedMirror at ${path}`);
  }
  if (value.outcome === "missing" && value.observedMirror !== null) {
    throw new TypeError(`missing claim cannot carry observedMirror at ${path}`);
  }
  const expected = hashDomain(
    "aloha/artifact-resolution-claim/v1",
    claimPayload(value),
  );
  if (value.claimId !== expected) {
    throw new TypeError(`claimId does not match claim payload at ${path}.claimId`);
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

const claimSchema = refineSchema(
  claimStructuralSchema,
  "aloha.artifact-resolution-claim.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.artifact-resolution-claim.refinement.v1",
    version: "1.0.0",
    rules: [
      "content-observed-requires-mirror",
      "missing-forbids-mirror",
      "claim-id-matches-payload",
    ],
  }),
  refineClaim,
);

export const ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS = Object.freeze({
  resolverPolicy: defineSchemaManifest(
    "aloha.artifact-resolver-policy",
    "1.0.0",
    policySchema,
  ),
  retentionLeaseReceipt: defineSchemaManifest(
    "aloha.retention-lease-receipt",
    "1.0.0",
    leaseSchema,
  ),
  observedImmutableMirror: defineSchemaManifest(
    "aloha.observed-immutable-mirror",
    "1.0.0",
    observedMirrorSchema,
  ),
  artifactResolutionClaim: defineSchemaManifest(
    "aloha.artifact-resolution-claim",
    "1.0.0",
    claimSchema,
  ),
});

type CodecInput = string | Uint8Array | object;

function parse(value: CodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

export function decodeResolverPolicy(value: CodecInput): ResolverPolicyV1 {
  return policySchema.decode(parse(value));
}

export function decodeRetentionLeaseReceipt(
  value: CodecInput,
): RetentionLeaseReceiptV1 {
  return leaseSchema.decode(parse(value));
}

export function decodeObservedImmutableMirror(
  value: CodecInput,
): ObservedImmutableMirrorV1 {
  return observedMirrorSchema.decode(parse(value));
}

export function decodeArtifactResolutionClaim(
  value: CodecInput,
): ArtifactResolutionClaimV1 {
  return claimSchema.decode(parse(value));
}

export function encodeResolverPolicy(value: ResolverPolicyV1): Uint8Array {
  return encodeCanonicalBytes(policySchema.decode(value));
}

export function encodeRetentionLeaseReceipt(
  value: RetentionLeaseReceiptV1,
): Uint8Array {
  return encodeCanonicalBytes(leaseSchema.decode(value));
}

export function encodeObservedImmutableMirror(
  value: ObservedImmutableMirrorV1,
): Uint8Array {
  return encodeCanonicalBytes(observedMirrorSchema.decode(value));
}

export function encodeArtifactResolutionClaim(
  value: ArtifactResolutionClaimV1,
): Uint8Array {
  return encodeCanonicalBytes(claimSchema.decode(value));
}

export function recomputeResolverPolicyHash(value: ResolverPolicyV1): Hash {
  return hashDomain(
    "aloha/artifact-resolver-policy/v1",
    policyPayload(policyStructuralSchema.decode(value)),
  );
}

export function recomputeRetentionLeaseReceiptId(
  value: RetentionLeaseReceiptV1,
): Hash {
  return hashDomain(
    "aloha/retention-lease-receipt/v1",
    leasePayload(leaseStructuralSchema.decode(value)),
  );
}

export function recomputeArtifactResolutionClaimId(
  value: ArtifactResolutionClaimV1,
): Hash {
  return hashDomain(
    "aloha/artifact-resolution-claim/v1",
    claimPayload(claimStructuralSchema.decode(value)),
  );
}

export type ResolverPolicyDraft = Omit<ResolverPolicyV1, "policyHash"> & {
  readonly policyHash?: Hash;
};

export type RetentionLeaseReceiptDraft = Omit<
  RetentionLeaseReceiptV1,
  "receiptId"
> & {
  readonly receiptId?: Hash;
};

export type ObservedImmutableMirrorDraft = Omit<
  ObservedImmutableMirrorV1,
  "contentSha256" | "byteLength"
> & {
  readonly contentSha256?: Hash;
  readonly byteLength?: string;
};

export type ArtifactResolutionClaimDraft = Omit<
  ArtifactResolutionClaimV1,
  "claimId"
> & {
  readonly claimId?: Hash;
};

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
      throw new TypeError(
        `unknown draft field ${typeof key === "string" ? key : "symbol"}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(draft, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new TypeError(
        `draft field ${key} must be an enumerable data property`,
      );
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

export function createResolverPolicy(
  draft: ResolverPolicyDraft,
): ResolverPolicyV1 {
  const data = copyDraftData(
    draft,
    [
      "schemaVersion",
      "kind",
      "policyHash",
      "allowedLocatorKind",
      "digestAlgorithm",
      "maxByteLength",
      "requireExactLengthMediaAndSchema",
      "minimumRemainingStoreEpochs",
      "failureOutcome",
    ],
    [
      "schemaVersion",
      "kind",
      "allowedLocatorKind",
      "digestAlgorithm",
      "maxByteLength",
      "requireExactLengthMediaAndSchema",
      "minimumRemainingStoreEpochs",
      "failureOutcome",
    ],
  );
  const withoutHash = { ...data, policyHash: zeroHash() } as ResolverPolicyV1;
  return policySchema.decode({
    ...withoutHash,
    policyHash: recomputeResolverPolicyHash(withoutHash),
  });
}

export function createRetentionLeaseReceipt(
  draft: RetentionLeaseReceiptDraft,
): RetentionLeaseReceiptV1 {
  const data = copyDraftData(
    draft,
    [
      "receiptId",
      "storeIdentityHash",
      "objectKey",
      "contentSha256",
      "validFromStoreEpoch",
      "validThroughStoreEpoch",
      "issuerId",
      "issuerQualificationId",
      "qualificationRegistryRoot",
    ],
    [
      "storeIdentityHash",
      "objectKey",
      "contentSha256",
      "validFromStoreEpoch",
      "validThroughStoreEpoch",
      "issuerId",
      "issuerQualificationId",
      "qualificationRegistryRoot",
    ],
  );
  const withoutId = { ...data, receiptId: zeroHash() } as RetentionLeaseReceiptV1;
  return leaseSchema.decode({
    ...withoutId,
    receiptId: recomputeRetentionLeaseReceiptId(withoutId),
  });
}

export function createObservedImmutableMirror(
  draft: ObservedImmutableMirrorDraft,
): ObservedImmutableMirrorV1 {
  const data = copyDraftData(
    draft,
    [
      "storeIdentityHash",
      "objectKey",
      "bytes",
      "contentSha256",
      "byteLength",
      "mediaType",
      "schema",
    ],
    ["storeIdentityHash", "objectKey", "bytes", "mediaType", "schema"],
  );
  const bytes = decodeArtifactBytes(data.bytes, "$.draft.bytes");
  return observedMirrorSchema.decode({
    ...data,
    contentSha256: sha256Hex(bytes),
    byteLength: String(bytes.byteLength),
  });
}

export function createArtifactResolutionClaim(
  draft: ArtifactResolutionClaimDraft,
): ArtifactResolutionClaimV1 {
  const data = copyDraftData(
    draft,
    [
      "claimId",
      "artifactRefId",
      "resolverPolicyHash",
      "observedMirror",
      "outcome",
    ],
    ["artifactRefId", "resolverPolicyHash", "observedMirror", "outcome"],
  );
  const withoutId = {
    ...data,
    claimId: zeroHash(),
  } as ArtifactResolutionClaimV1;
  return claimSchema.decode({
    ...withoutId,
    claimId: recomputeArtifactResolutionClaimId(withoutId),
  });
}

export function decodeArtifactBytes(
  value: unknown,
  path = "$",
): Uint8Array {
  const decoded = artifactBytesStructuralSchema.decode(value, path);
  return decodeValidatedArtifactBytes(decoded, path);
}

export function encodeArtifactBytes(bytes: Uint8Array): ArtifactBytesV1 {
  assertConcreteArtifactBytes(bytes);
  if (bytes.byteLength > ARTIFACT_MIRROR_MAX_DECODED_BYTES) {
    throw new TypeError("artifact bytes exceed mirror decoded-byte bound");
  }
  const chunks: Array<{ readonly index: string; readonly bytes: string }> = [];
  for (let offset = 0, index = 0; offset < bytes.length; offset += ARTIFACT_BYTES_CHUNK_BYTE_LENGTH, index += 1) {
    const end = Math.min(offset + ARTIFACT_BYTES_CHUNK_BYTE_LENGTH, bytes.length);
    let encoded = "0x";
    for (let position = offset; position < end; position += 1) {
      encoded += bytes[position]!.toString(16).padStart(2, "0");
    }
    chunks.push({ index: String(index), bytes: encoded });
  }
  return artifactBytesStructuralSchema.normalize({
    schemaVersion: 1,
    kind: "aloha.canonical-artifact-bytes",
    byteLength: String(bytes.byteLength),
    contentSha256: sha256Hex(bytes),
    chunks,
  });
}

function zeroHash(): Hash {
  return `0x${"0".repeat(64)}` as Hash;
}

export type { SchemaRef };
