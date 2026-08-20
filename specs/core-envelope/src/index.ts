import {
  decodeCanonicalJson,
  defineSchema,
  defineSchemaManifest,
  enumSchema,
  encodeCanonicalBytes,
  hashDomain,
  objectSchema,
  refineSchema,
  arraySchema,
  nullableSchema,
  canonicalObjectSchema,
  decimalStringSchema,
  gitSha40Schema,
  hashSchema,
  literalSchema,
  nonEmptyStringSchema,
  readOwnEnumerableDataProperty,
  semVerSchema,
  stringSchema,
  type Infer,
  type CanonicalJsonObject,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

export type { CanonicalJsonObject, Hash } from "../../../packages/canonical-codec/src/index.ts";
export type DecimalString = string;
export type SemVer = string;
export type GitSha40 = string;
export type BlockHash = Hash;

/** Closed, protocol-neutral machine reason catalog. Extensions carry any domain-specific detail. */
export const STABLE_REASON_CODES = [
  "abort",
  "chain-rejected",
  "deadline",
  "evidence-write-failed",
  "failed-closed",
  "hash-mismatch",
  "invalid-program",
  "invalid-schema",
  "lease-invalid",
  "missing-observation",
  "not-ready",
  "plugin-error",
  "qualification-missing",
  "queue-full",
  "reorg",
  "resource-limit",
  "simulation-reverted",
  "source-stale",
  "transport-error",
  "unknown-capability",
  "unknown",
] as const;
export type StableReasonCode = (typeof STABLE_REASON_CODES)[number];

export type CoreCodecInput = string | Uint8Array | object;

function parseInput(value: CoreCodecInput): unknown {
  if (typeof value === "string") {
    return decodeCanonicalJson(value);
  }
  if (ArrayBuffer.isView(value)) {
    return decodeCanonicalJson(value as Uint8Array);
  }
  return value;
}

/*
 * These executable descriptors are the sole field authority for the core
 * envelopes. Refinements below (identity hashes and cross-field relations)
 * deliberately sit outside the structural schema.
 */
const schemaRefSchema = objectSchema({
  id: nonEmptyStringSchema,
  version: semVerSchema,
  schemaHash: hashSchema,
});

const sourceAnchorSchema = objectSchema({
  chainId: decimalStringSchema,
  number: decimalStringSchema,
  hash: hashSchema,
  stateRoot: hashSchema,
});

const processAnchorSchema = objectSchema({
  systemId: nonEmptyStringSchema,
  commitSha: gitSha40Schema,
  executableHash: hashSchema,
  deploymentManifestHash: hashSchema,
  serviceIdentityHash: hashSchema,
  pid: decimalStringSchema,
  processStartTicks: decimalStringSchema,
  bootIdHash: hashSchema,
});

const fileRangeLocatorSchema = objectSchema({
  kind: literalSchema("file-range"),
  systemId: nonEmptyStringSchema,
  bootIdHash: hashSchema,
  device: decimalStringSchema,
  inode: decimalStringSchema,
  startInclusive: decimalStringSchema,
  endExclusive: decimalStringSchema,
});

const checkpointRecordLocatorSchema = objectSchema({
  kind: literalSchema("checkpoint-record"),
  storeIdentityHash: hashSchema,
  namespaceHash: hashSchema,
  keyHash: hashSchema,
  revision: decimalStringSchema,
  recordHash: hashSchema,
});

const chainObjectLocatorSchema = objectSchema({
  kind: literalSchema("chain-object"),
  chainId: decimalStringSchema,
  blockNumber: decimalStringSchema,
  blockHash: hashSchema,
  objectKind: enumSchema(["header", "transaction", "receipt", "state-proof", "logs"] as const),
  objectKeyHash: hashSchema,
});

const contentObjectLocatorSchema = objectSchema({
  kind: literalSchema("content-object"),
  storeIdentityHash: hashSchema,
  objectKey: hashSchema,
});

const jsonPointerLocatorSchema = objectSchema({
  kind: literalSchema("json-pointer"),
  parentLocatorId: hashSchema,
  pointer: stringSchema,
});

const locatorSchema = defineSchema(
  {
    kind: "union",
    variants: [
      fileRangeLocatorSchema.descriptor,
      checkpointRecordLocatorSchema.descriptor,
      chainObjectLocatorSchema.descriptor,
      contentObjectLocatorSchema.descriptor,
      jsonPointerLocatorSchema.descriptor,
    ],
  },
  (value, path = "$") => {
    switch (readOwnEnumerableDataProperty(value, "kind", path)) {
      case "file-range": return fileRangeLocatorSchema.decode(value, path);
      case "checkpoint-record": return checkpointRecordLocatorSchema.decode(value, path);
      case "chain-object": return chainObjectLocatorSchema.decode(value, path);
      case "content-object": return contentObjectLocatorSchema.decode(value, path);
      case "json-pointer": return jsonPointerLocatorSchema.decode(value, path);
      default: throw new TypeError(`unknown locator kind at ${path}.kind`);
    }
  },
);

const artifactRefStructuralSchema = objectSchema({
  artifactRefId: hashSchema,
  locatorId: hashSchema,
  locator: locatorSchema,
  immutableMirrorLocatorId: hashSchema,
  immutableMirrorLocator: contentObjectLocatorSchema,
  contentSha256: hashSchema,
  byteLength: decimalStringSchema,
  mediaType: nonEmptyStringSchema,
  schema: nullableSchema(schemaRefSchema),
  resolverPolicyHash: hashSchema,
  retentionLeaseReceiptId: hashSchema,
});

/*
 * Creator inputs are a separate exact schema.  In particular, derived IDs are
 * intentionally absent: accepting them and overwriting them after a spread
 * would both read an attacker-controlled object too early and make a typo in
 * a caller-supplied identity look harmless.
 */
const artifactRefDraftSchema = objectSchema({
  locator: locatorSchema,
  immutableMirrorLocator: contentObjectLocatorSchema,
  contentSha256: hashSchema,
  byteLength: decimalStringSchema,
  mediaType: nonEmptyStringSchema,
  schema: nullableSchema(schemaRefSchema),
  resolverPolicyHash: hashSchema,
  retentionLeaseReceiptId: hashSchema,
});

const artifactRefRefinementSpecDigest = hashDomain(
  "aloha/schema-refinement-spec/v1",
  {
    id: "core.read-only-artifact-ref.refinement.v1",
    version: "1.0.0",
    rules: [
      "locator-ids-match-payloads",
      "immutable-mirror-object-key-equals-content-sha256",
      "file-range-length-equals-byte-length",
      "artifact-ref-id-matches-payload",
    ],
  },
);

const artifactRefSchema = refineSchema(
  artifactRefStructuralSchema,
  "core.read-only-artifact-ref.refinement.v1",
  artifactRefRefinementSpecDigest,
  (value, path) => refineArtifactRef(value, path, true),
);

const semanticArtifactStructuralSchema = objectSchema({
  schema: schemaRefSchema,
  artifactId: hashSchema,
  inputArtifactIds: arraySchema(hashSchema),
  dependencyClosureRoot: hashSchema,
  canonicalPayloadHash: hashSchema,
});

const semanticArtifactDraftSchema = objectSchema({
  schema: schemaRefSchema,
  inputArtifactIds: arraySchema(hashSchema),
  dependencyClosureRoot: hashSchema,
  canonicalPayloadHash: hashSchema,
});

const semanticArtifactRefinementSpecDigest = hashDomain(
  "aloha/schema-refinement-spec/v1",
  {
    id: "core.semantic-artifact.refinement.v1",
    version: "1.0.0",
    rules: ["artifact-id-matches-semantic-payload"],
  },
);

const semanticArtifactSchema = refineSchema(
  semanticArtifactStructuralSchema,
  "core.semantic-artifact.refinement.v1",
  semanticArtifactRefinementSpecDigest,
  (value, path) => refineSemanticArtifact(value, path, true),
);

const productionReceiptStructuralSchema = objectSchema({
  receiptId: hashSchema,
  artifactId: hashSchema,
  producer: processAnchorSchema,
  logRangeArtifactRef: artifactRefSchema,
  sourceAnchorHash: hashSchema,
  startedMonotonicNs: decimalStringSchema,
  finishedMonotonicNs: decimalStringSchema,
  durationUs: decimalStringSchema,
  rawBoundaryArtifactRef: artifactRefSchema,
  semanticConfigDigest: hashSchema,
  resourceMetricsHash: hashSchema,
});

const productionReceiptDraftSchema = objectSchema({
  artifactId: hashSchema,
  producer: processAnchorSchema,
  logRangeArtifactRef: artifactRefSchema,
  sourceAnchorHash: hashSchema,
  startedMonotonicNs: decimalStringSchema,
  finishedMonotonicNs: decimalStringSchema,
  durationUs: decimalStringSchema,
  rawBoundaryArtifactRef: artifactRefSchema,
  semanticConfigDigest: hashSchema,
  resourceMetricsHash: hashSchema,
});

const productionReceiptRefinementSpecDigest = hashDomain(
  "aloha/schema-refinement-spec/v1",
  {
    id: "core.production-receipt.refinement.v1",
    version: "1.0.0",
    rules: [
      "finished-monotonic-time-not-before-started",
      "log-and-boundary-artifact-refs-are-distinct",
      "log-primary-locator-is-file-range",
      "log-system-and-boot-match-producer",
      "receipt-id-matches-payload",
    ],
  },
);

const productionReceiptSchema = refineSchema(
  productionReceiptStructuralSchema,
  "core.production-receipt.refinement.v1",
  productionReceiptRefinementSpecDigest,
  (value, path) => refineProductionReceipt(value, path, true),
);

export type SchemaRef = Infer<typeof schemaRefSchema>;
export type SourceAnchor = Infer<typeof sourceAnchorSchema>;
export type ProcessAnchorV1 = Infer<typeof processAnchorSchema>;
export type ReadOnlyArtifactLocatorV1 = Infer<typeof locatorSchema>;
export type ReadOnlyArtifactRefV1 = Infer<typeof artifactRefStructuralSchema>;
export type SemanticArtifactV1 = Infer<typeof semanticArtifactStructuralSchema>;
export type ProductionReceiptV1 = Infer<typeof productionReceiptStructuralSchema>;

export const CORE_SCHEMA_MANIFESTS = Object.freeze({
  schemaRef: defineSchemaManifest("aloha.schema-ref", "1.0.0", schemaRefSchema),
  sourceAnchor: defineSchemaManifest("aloha.source-anchor", "1.0.0", sourceAnchorSchema),
  processAnchor: defineSchemaManifest("aloha.process-anchor", "1.0.0", processAnchorSchema),
  readOnlyArtifactLocator: defineSchemaManifest("aloha.read-only-artifact-locator", "1.0.0", locatorSchema),
  readOnlyArtifactRef: defineSchemaManifest("aloha.read-only-artifact-ref", "1.0.0", artifactRefSchema),
  semanticArtifact: defineSchemaManifest("aloha.semantic-artifact", "1.0.0", semanticArtifactSchema),
  productionReceipt: defineSchemaManifest("aloha.production-receipt", "1.0.0", productionReceiptSchema),
});

function parseSchemaRef(value: unknown, path = "$"): SchemaRef {
  return schemaRefSchema.decode(value, path);
}

export function decodeSchemaRef(value: CoreCodecInput): SchemaRef {
  return parseSchemaRef(parseInput(value));
}

export function encodeSchemaRef(value: SchemaRef): Uint8Array {
  return encodeCanonicalBytes(parseSchemaRef(value));
}

function parseSourceAnchor(value: unknown, path = "$"): SourceAnchor {
  return sourceAnchorSchema.decode(value, path);
}

export function decodeSourceAnchor(value: CoreCodecInput): SourceAnchor {
  return parseSourceAnchor(parseInput(value));
}

export function encodeSourceAnchor(value: SourceAnchor): Uint8Array {
  return encodeCanonicalBytes(parseSourceAnchor(value));
}

export function hashSourceAnchor(value: SourceAnchor): Hash {
  return hashDomain("aloha/source-anchor/v1", parseSourceAnchor(value));
}

function parseProcessAnchor(value: unknown, path = "$"): ProcessAnchorV1 {
  return processAnchorSchema.decode(value, path);
}

export function decodeProcessAnchor(value: CoreCodecInput): ProcessAnchorV1 {
  return parseProcessAnchor(parseInput(value));
}

export function encodeProcessAnchor(value: ProcessAnchorV1): Uint8Array {
  return encodeCanonicalBytes(parseProcessAnchor(value));
}

export function hashProcessAnchor(value: ProcessAnchorV1): Hash {
  return hashDomain("aloha/process-anchor/v1", parseProcessAnchor(value));
}

function parseLocator(
  value: unknown,
  path = "$",
): ReadOnlyArtifactLocatorV1 {
  return locatorSchema.decode(value, path);
}

export function decodeReadOnlyArtifactLocator(
  value: CoreCodecInput,
): ReadOnlyArtifactLocatorV1 {
  return parseLocator(parseInput(value));
}

export function encodeReadOnlyArtifactLocator(
  value: ReadOnlyArtifactLocatorV1,
): Uint8Array {
  return encodeCanonicalBytes(parseLocator(value));
}

export function recomputeReadOnlyArtifactLocatorId(
  value: ReadOnlyArtifactLocatorV1,
): Hash {
  return hashDomain(
    "aloha/read-only-artifact-locator/v1",
    parseLocator(value),
  );
}

export const hashReadOnlyArtifactLocator = recomputeReadOnlyArtifactLocatorId;

function artifactRefPayload(value: ReadOnlyArtifactRefV1): CanonicalJsonObject {
  return {
    locatorId: value.locatorId,
    immutableMirrorLocatorId: value.immutableMirrorLocatorId,
    contentSha256: value.contentSha256,
    byteLength: value.byteLength,
    mediaType: value.mediaType,
    schema: value.schema,
    resolverPolicyHash: value.resolverPolicyHash,
    retentionLeaseReceiptId: value.retentionLeaseReceiptId,
  };
}

export function recomputeReadOnlyArtifactRefId(
  value: ReadOnlyArtifactRefV1,
): Hash {
  const parsed = parseArtifactRef(value, false);
  return hashDomain(
    "aloha/read-only-artifact-ref/v1",
    artifactRefPayload({
      ...parsed,
      locatorId: recomputeReadOnlyArtifactLocatorId(parsed.locator),
      immutableMirrorLocatorId: recomputeReadOnlyArtifactLocatorId(
        parsed.immutableMirrorLocator,
      ),
    }),
  );
}

function parseArtifactRef(
  value: unknown,
  verifyIdentity = true,
  path = "$",
): ReadOnlyArtifactRefV1 {
  const parsed = artifactRefStructuralSchema.decode(value, path);
  return refineArtifactRef(parsed, path, verifyIdentity);
}

function refineArtifactRef(
  parsed: ReadOnlyArtifactRefV1,
  path: string,
  verifyIdentity: boolean,
): ReadOnlyArtifactRefV1 {
  const locatorId = recomputeReadOnlyArtifactLocatorId(parsed.locator);
  const mirrorId = recomputeReadOnlyArtifactLocatorId(parsed.immutableMirrorLocator);
  if (parsed.immutableMirrorLocator.objectKey !== parsed.contentSha256) {
    throw new TypeError(
      `immutable mirror objectKey must equal contentSha256 at ${path}.immutableMirrorLocator.objectKey`,
    );
  }
  if (parsed.locator.kind === "file-range") {
    const start = BigInt(parsed.locator.startInclusive);
    const end = BigInt(parsed.locator.endExclusive);
    const length = BigInt(parsed.byteLength);
    if (end < start || end - start !== length) {
      throw new TypeError(`file-range length does not equal byteLength at ${path}.locator`);
    }
  }
  if (verifyIdentity && parsed.locatorId !== locatorId) {
    throw new TypeError(`locatorId does not match locator at ${path}.locatorId`);
  }
  if (verifyIdentity && parsed.immutableMirrorLocatorId !== mirrorId) {
    throw new TypeError(
      `immutableMirrorLocatorId does not match locator at ${path}.immutableMirrorLocatorId`,
    );
  }
  const artifactRefId = hashDomain(
    "aloha/read-only-artifact-ref/v1",
    artifactRefPayload({
      ...parsed,
      locatorId,
      immutableMirrorLocatorId: mirrorId,
    }),
  );
  if (verifyIdentity && parsed.artifactRefId !== artifactRefId) {
    throw new TypeError(`artifactRefId does not match content at ${path}.artifactRefId`);
  }
  return parsed;
}

export function decodeReadOnlyArtifactRef(
  value: CoreCodecInput,
): ReadOnlyArtifactRefV1 {
  return parseArtifactRef(parseInput(value));
}

export function encodeReadOnlyArtifactRef(
  value: ReadOnlyArtifactRefV1,
): Uint8Array {
  return encodeCanonicalBytes(parseArtifactRef(value));
}

export type ReadOnlyArtifactRefDraft = Infer<typeof artifactRefDraftSchema>;

export function createReadOnlyArtifactRef(
  draft: ReadOnlyArtifactRefDraft,
): ReadOnlyArtifactRefV1 {
  const parsedDraft = artifactRefDraftSchema.decode(draft);
  const locatorId = recomputeReadOnlyArtifactLocatorId(parsedDraft.locator);
  const immutableMirrorLocatorId = recomputeReadOnlyArtifactLocatorId(
    parsedDraft.immutableMirrorLocator,
  );
  const withoutId = {
    ...parsedDraft,
    locatorId,
    immutableMirrorLocatorId,
    artifactRefId: "0x" + "0".repeat(64),
  } as ReadOnlyArtifactRefV1;
  const artifactRefId = hashDomain(
    "aloha/read-only-artifact-ref/v1",
    artifactRefPayload(withoutId),
  );
  return parseArtifactRef({ ...withoutId, artifactRefId });
}

function semanticArtifactPayload(
  value: SemanticArtifactV1,
): CanonicalJsonObject {
  return {
    schema: value.schema,
    inputArtifactIds: value.inputArtifactIds,
    dependencyClosureRoot: value.dependencyClosureRoot,
    canonicalPayloadHash: value.canonicalPayloadHash,
  };
}

export function recomputeSemanticArtifactId(
  value: SemanticArtifactV1,
): Hash {
  const parsed = parseSemanticArtifact(value, false);
  return hashDomain(
    "aloha/semantic-artifact/v1",
    semanticArtifactPayload(parsed),
  );
}

function parseSemanticArtifact(
  value: unknown,
  verifyIdentity = true,
  path = "$",
): SemanticArtifactV1 {
  const parsed = semanticArtifactStructuralSchema.decode(value, path);
  return refineSemanticArtifact(parsed, path, verifyIdentity);
}

function refineSemanticArtifact(
  parsed: SemanticArtifactV1,
  path: string,
  verifyIdentity: boolean,
): SemanticArtifactV1 {
  const artifactId = hashDomain(
    "aloha/semantic-artifact/v1",
    semanticArtifactPayload(parsed),
  );
  if (verifyIdentity && parsed.artifactId !== artifactId) {
    throw new TypeError(`artifactId does not match semantic payload at ${path}.artifactId`);
  }
  return parsed;
}

export function decodeSemanticArtifact(value: CoreCodecInput): SemanticArtifactV1 {
  return parseSemanticArtifact(parseInput(value));
}

export function encodeSemanticArtifact(value: SemanticArtifactV1): Uint8Array {
  return encodeCanonicalBytes(parseSemanticArtifact(value));
}

export type SemanticArtifactDraft = Infer<typeof semanticArtifactDraftSchema>;

export function createSemanticArtifact(
  draft: SemanticArtifactDraft,
): SemanticArtifactV1 {
  const parsedDraft = semanticArtifactDraftSchema.decode(draft);
  const withoutId = {
    ...parsedDraft,
    artifactId: "0x" + "0".repeat(64),
  } as SemanticArtifactV1;
  const artifactId = hashDomain(
    "aloha/semantic-artifact/v1",
    semanticArtifactPayload(withoutId),
  );
  return parseSemanticArtifact({ ...withoutId, artifactId });
}

function parseProductionReceipt(
  value: unknown,
  verifyIdentity = true,
  path = "$",
): ProductionReceiptV1 {
  const parsed = productionReceiptStructuralSchema.decode(value, path);
  return refineProductionReceipt(parsed, path, verifyIdentity);
}

function refineProductionReceipt(
  parsed: ProductionReceiptV1,
  path: string,
  verifyIdentity: boolean,
): ProductionReceiptV1 {
  if (BigInt(parsed.finishedMonotonicNs) < BigInt(parsed.startedMonotonicNs)) {
    throw new TypeError(`finishedMonotonicNs precedes startedMonotonicNs at ${path}`);
  }
  if (parsed.logRangeArtifactRef.artifactRefId === parsed.rawBoundaryArtifactRef.artifactRefId) {
    throw new TypeError(`log and boundary artifact refs must be independent at ${path}`);
  }
  if (parsed.logRangeArtifactRef.locator.kind !== "file-range") {
    throw new TypeError(`log artifact primary locator must be a file-range at ${path}.logRangeArtifactRef.locator`);
  }
  if (
    parsed.logRangeArtifactRef.locator.systemId !== parsed.producer.systemId ||
    parsed.logRangeArtifactRef.locator.bootIdHash !== parsed.producer.bootIdHash
  ) {
    throw new TypeError(`log artifact process/boot anchor does not match producer at ${path}.logRangeArtifactRef.locator`);
  }
  const receiptId = hashDomain(
    "aloha/production-receipt/v1",
    productionReceiptPayload(parsed),
  );
  if (verifyIdentity && parsed.receiptId !== receiptId) {
    throw new TypeError(`receiptId does not match receipt payload at ${path}.receiptId`);
  }
  return parsed;
}

function productionReceiptPayload(
  value: ProductionReceiptV1,
): CanonicalJsonObject {
  return {
    artifactId: value.artifactId,
    producer: value.producer,
    logRangeArtifactRef: value.logRangeArtifactRef,
    sourceAnchorHash: value.sourceAnchorHash,
    startedMonotonicNs: value.startedMonotonicNs,
    finishedMonotonicNs: value.finishedMonotonicNs,
    durationUs: value.durationUs,
    rawBoundaryArtifactRef: value.rawBoundaryArtifactRef,
    semanticConfigDigest: value.semanticConfigDigest,
    resourceMetricsHash: value.resourceMetricsHash,
  };
}

export function recomputeProductionReceiptId(
  value: ProductionReceiptV1,
): Hash {
  const parsed = parseProductionReceipt(value, false);
  return hashDomain(
    "aloha/production-receipt/v1",
    productionReceiptPayload(parsed),
  );
}

export function decodeProductionReceipt(
  value: CoreCodecInput,
): ProductionReceiptV1 {
  return parseProductionReceipt(parseInput(value));
}

export function encodeProductionReceipt(
  value: ProductionReceiptV1,
): Uint8Array {
  return encodeCanonicalBytes(parseProductionReceipt(value));
}

export type ProductionReceiptDraft = Infer<typeof productionReceiptDraftSchema>;

export function createProductionReceipt(
  draft: ProductionReceiptDraft,
): ProductionReceiptV1 {
  const parsedDraft = productionReceiptDraftSchema.decode(draft);
  const withoutId = {
    ...parsedDraft,
    receiptId: "0x" + "0".repeat(64),
  } as ProductionReceiptV1;
  const receiptId = hashDomain(
    "aloha/production-receipt/v1",
    productionReceiptPayload(withoutId),
  );
  return parseProductionReceipt({ ...withoutId, receiptId });
}

export const recomputeArtifactRefId = recomputeReadOnlyArtifactRefId;
export const recomputeLocatorId = recomputeReadOnlyArtifactLocatorId;
export const recomputeArtifactId = recomputeSemanticArtifactId;
export const recomputeReceiptId = recomputeProductionReceiptId;

export function assertStableReasonCode(
  value: unknown,
  path = "$",
): StableReasonCode {
  if (
    typeof value !== "string" ||
    !(STABLE_REASON_CODES as readonly string[]).includes(value)
  ) {
    throw new TypeError(`unknown stable reason code at ${path}`);
  }
  return value as StableReasonCode;
}
