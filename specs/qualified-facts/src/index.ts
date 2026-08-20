import {
  arraySchema,
  assertPlainObject,
  canonicalJsonSchema,
  decodeCanonicalJson,
  deepFreeze,
  defineSchemaManifest,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  hashSchema,
  literalSchema,
  nullableSchema,
  nonEmptyStringSchema,
  objectSchema,
  refineSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  CORE_SCHEMA_MANIFESTS,
  hashProcessAnchor,
  type ProcessAnchorV1,
  type ProductionReceiptV1,
  type ReadOnlyArtifactRefV1,
  type SchemaRef,
} from "../../core-envelope/src/index.ts";
import {
  ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS,
  type ArtifactResolutionClaimV1,
} from "../../artifact-resolution/src/index.ts";

export type { Hash } from "../../../packages/canonical-codec/src/index.ts";
export type { ProcessAnchorV1, ProductionReceiptV1, ReadOnlyArtifactRefV1, SchemaRef } from "../../core-envelope/src/index.ts";

const schemaRefSchema = CORE_SCHEMA_MANIFESTS.schemaRef.schema;
const artifactRefSchema = CORE_SCHEMA_MANIFESTS.readOnlyArtifactRef.schema;

const observationLineageContextSchema = objectSchema({
  productionReceipt: nullableSchema(CORE_SCHEMA_MANIFESTS.productionReceipt.schema),
  acquisitionArtifact: nullableSchema(CORE_SCHEMA_MANIFESTS.semanticArtifact.schema),
  artifactClaims: arraySchema(ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.artifactResolutionClaim.schema),
});

const observationStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.qualified-observation"),
  observationId: hashSchema,
  payloadHash: hashSchema,
  observationSchema: schemaRefSchema,
  observerImplementationDigest: hashSchema,
  observerQualificationId: hashSchema,
  qualificationRegistryRoot: hashSchema,
  anchorPolicyDigest: hashSchema,
  observedClaimIds: arraySchema(hashSchema),
  rawArtifactRefs: arraySchema(artifactRefSchema),
  acquisitionProductionReceiptId: hashSchema,
  canonicalFacts: canonicalJsonSchema,
  canonicalFactsHash: hashSchema,
});

const snapshotStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.qualified-fact-snapshot"),
  snapshotId: hashSchema,
  payloadHash: hashSchema,
  claimSetRoot: hashSchema,
  observationSetRoot: hashSchema,
  rawArtifactSetRoot: hashSchema,
  qualificationRegistryRoot: hashSchema,
  orderedClaimIds: arraySchema(hashSchema),
  orderedObservationIds: arraySchema(hashSchema),
  orderedRawArtifactRefIds: arraySchema(hashSchema),
});

const queryStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.acceptance-query"),
  queryId: hashSchema,
  payloadHash: hashSchema,
  predicateSpecDigest: hashSchema,
  qualificationRegistryRoot: hashSchema,
  subjectArtifactRoot: hashSchema,
  qualifiedFactSnapshotId: hashSchema,
  processAnchorHash: hashSchema,
  correlationId: nullableSchema(nonEmptyStringSchema),
});

export type QualifiedObservationEnvelopeV1 = Infer<typeof observationStructuralSchema>;
export type QualifiedFactSnapshotV1 = Infer<typeof snapshotStructuralSchema>;
export type AcceptanceQueryV1 = Infer<typeof queryStructuralSchema>;

function h0(): Hash { return `0x${"0".repeat(64)}` as Hash; }

function assertStrictlySortedUnique(values: readonly string[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      throw new TypeError(`${path} must be strictly sorted and unique`);
    }
  }
}

function canonicalFactsHash(facts: QualifiedObservationEnvelopeV1["canonicalFacts"]): Hash {
  return hashDomain("aloha/qualified-observation/canonical-facts/v1", facts);
}

function rawArtifactIds(refs: readonly ReadOnlyArtifactRefV1[]): readonly Hash[] {
  return refs.map((ref) => ref.artifactRefId);
}

function root(domain: string, ids: readonly Hash[]): Hash {
  return hashDomain(domain, ids);
}

function observationPayload(value: QualifiedObservationEnvelopeV1): object {
  const { observationId: _observationId, payloadHash: _payloadHash, ...payload } = value;
  return payload;
}
function snapshotPayload(value: QualifiedFactSnapshotV1): object {
  const { snapshotId: _snapshotId, payloadHash: _payloadHash, ...payload } = value;
  return payload;
}
function queryPayload(value: AcceptanceQueryV1): object {
  const { queryId: _queryId, payloadHash: _payloadHash, ...payload } = value;
  return payload;
}

function payloadHash(domainKind: string, payload: object): Hash {
  return hashDomain(`${domainKind}/payload/v1`, payload);
}
function objectId(domainKind: string, payloadDigest: Hash): Hash {
  return hashDomain(`${domainKind}/id/v1`, payloadDigest);
}

function refineObservation(value: QualifiedObservationEnvelopeV1, path: string): QualifiedObservationEnvelopeV1 {
  assertStrictlySortedUnique(value.observedClaimIds, `${path}.observedClaimIds`);
  const ids = rawArtifactIds(value.rawArtifactRefs);
  assertStrictlySortedUnique(ids, `${path}.rawArtifactRefs`);
  if (value.canonicalFactsHash !== canonicalFactsHash(value.canonicalFacts)) {
    throw new TypeError(`canonicalFactsHash does not match facts at ${path}`);
  }
  const expectedPayloadHash = payloadHash("aloha.qualified-observation", observationPayload(value));
  const expectedId = objectId("aloha.qualified-observation", expectedPayloadHash);
  if (value.payloadHash !== expectedPayloadHash || value.observationId !== expectedId) {
    throw new TypeError(`observation payloadHash/observationId mismatch at ${path}`);
  }
  return value;
}

function refineSnapshot(value: QualifiedFactSnapshotV1, path: string): QualifiedFactSnapshotV1 {
  assertStrictlySortedUnique(value.orderedClaimIds, `${path}.orderedClaimIds`);
  assertStrictlySortedUnique(value.orderedObservationIds, `${path}.orderedObservationIds`);
  assertStrictlySortedUnique(value.orderedRawArtifactRefIds, `${path}.orderedRawArtifactRefIds`);
  const expectedRoots = {
    claimSetRoot: root("aloha/qualified-fact-snapshot/claim-set-root/v1", value.orderedClaimIds),
    observationSetRoot: root("aloha/qualified-fact-snapshot/observation-set-root/v1", value.orderedObservationIds),
    rawArtifactSetRoot: root("aloha/qualified-fact-snapshot/raw-artifact-set-root/v1", value.orderedRawArtifactRefIds),
  };
  if (
    value.claimSetRoot !== expectedRoots.claimSetRoot ||
    value.observationSetRoot !== expectedRoots.observationSetRoot ||
    value.rawArtifactSetRoot !== expectedRoots.rawArtifactSetRoot
  ) {
    throw new TypeError(`snapshot set roots do not match ordered IDs at ${path}`);
  }
  const expectedPayloadHash = payloadHash("aloha.qualified-fact-snapshot", snapshotPayload(value));
  const expectedId = objectId("aloha.qualified-fact-snapshot", expectedPayloadHash);
  if (value.payloadHash !== expectedPayloadHash || value.snapshotId !== expectedId) {
    throw new TypeError(`snapshot payloadHash/snapshotId mismatch at ${path}`);
  }
  return value;
}

function refineQuery(value: AcceptanceQueryV1, path: string): AcceptanceQueryV1 {
  const expectedPayloadHash = payloadHash("aloha.acceptance-query", queryPayload(value));
  const expectedId = objectId("aloha.acceptance-query", expectedPayloadHash);
  if (value.payloadHash !== expectedPayloadHash || value.queryId !== expectedId) {
    throw new TypeError(`query payloadHash/queryId mismatch at ${path}`);
  }
  return value;
}

const observationSchema = refineSchema(
  observationStructuralSchema,
  "aloha.qualified-observation.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.qualified-observation.refinement.v1",
    version: "1.0.0",
    rules: ["strict-claim-and-raw-order", "canonical-facts-hash", "payload-and-id"],
  }),
  refineObservation,
);
const snapshotSchema = refineSchema(
  snapshotStructuralSchema,
  "aloha.qualified-fact-snapshot.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.qualified-fact-snapshot.refinement.v1",
    version: "1.0.0",
    rules: ["strict-ordered-sets", "set-roots", "payload-and-id"],
  }),
  refineSnapshot,
);
const querySchema = refineSchema(
  queryStructuralSchema,
  "aloha.acceptance-query.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.acceptance-query.refinement.v1",
    version: "1.0.0",
    rules: ["payload-and-id-binds-registry-subject-snapshot-anchor-correlation"],
  }),
  refineQuery,
);

export const QUALIFIED_FACT_SCHEMA_MANIFESTS = Object.freeze({
  observation: defineSchemaManifest("aloha.qualified-observation", "1.0.0", observationSchema),
  snapshot: defineSchemaManifest("aloha.qualified-fact-snapshot", "1.0.0", snapshotSchema),
  acceptanceQuery: defineSchemaManifest("aloha.acceptance-query", "1.0.0", querySchema),
});

export function recomputeQualifiedObservationPayloadHash(value: QualifiedObservationEnvelopeV1): Hash {
  return payloadHash("aloha.qualified-observation", observationPayload(observationStructuralSchema.decode(value)));
}
export function recomputeQualifiedObservationId(value: QualifiedObservationEnvelopeV1): Hash {
  return objectId("aloha.qualified-observation", recomputeQualifiedObservationPayloadHash(value));
}
export function recomputeQualifiedFactSnapshotPayloadHash(value: QualifiedFactSnapshotV1): Hash {
  return payloadHash("aloha.qualified-fact-snapshot", snapshotPayload(snapshotStructuralSchema.decode(value)));
}
export function recomputeQualifiedFactSnapshotId(value: QualifiedFactSnapshotV1): Hash {
  return objectId("aloha.qualified-fact-snapshot", recomputeQualifiedFactSnapshotPayloadHash(value));
}
export function recomputeAcceptanceQueryPayloadHash(value: AcceptanceQueryV1): Hash {
  return payloadHash("aloha.acceptance-query", queryPayload(queryStructuralSchema.decode(value)));
}
export function recomputeAcceptanceQueryId(value: AcceptanceQueryV1): Hash {
  return objectId("aloha.acceptance-query", recomputeAcceptanceQueryPayloadHash(value));
}

function parse(value: string | Uint8Array | object): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}
export function decodeQualifiedObservation(value: string | Uint8Array | object): QualifiedObservationEnvelopeV1 {
  return observationSchema.decode(parse(value));
}
export function decodeQualifiedFactSnapshot(value: string | Uint8Array | object): QualifiedFactSnapshotV1 {
  return snapshotSchema.decode(parse(value));
}
export function decodeAcceptanceQuery(value: string | Uint8Array | object): AcceptanceQueryV1 {
  return querySchema.decode(parse(value));
}
export function encodeQualifiedObservation(value: QualifiedObservationEnvelopeV1): Uint8Array {
  return encodeCanonicalBytes(observationSchema.decode(value));
}
export function encodeQualifiedFactSnapshot(value: QualifiedFactSnapshotV1): Uint8Array {
  return encodeCanonicalBytes(snapshotSchema.decode(value));
}
export function encodeAcceptanceQuery(value: AcceptanceQueryV1): Uint8Array {
  return encodeCanonicalBytes(querySchema.decode(value));
}

export type QualifiedObservationDraft = Omit<QualifiedObservationEnvelopeV1, "observationId" | "payloadHash" | "canonicalFactsHash">;
export type QualifiedFactSnapshotDraft = Omit<QualifiedFactSnapshotV1, "snapshotId" | "payloadHash" | "claimSetRoot" | "observationSetRoot" | "rawArtifactSetRoot">;
export type AcceptanceQueryDraft = Omit<AcceptanceQueryV1, "queryId" | "payloadHash">;

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

export function createQualifiedObservation(draft: QualifiedObservationDraft): QualifiedObservationEnvelopeV1 {
  const data = copyDraftData(
    draft,
    ["schemaVersion", "kind", "observationSchema", "observerImplementationDigest", "observerQualificationId", "qualificationRegistryRoot", "anchorPolicyDigest", "observedClaimIds", "rawArtifactRefs", "acquisitionProductionReceiptId", "canonicalFacts"],
    ["schemaVersion", "kind", "observationSchema", "observerImplementationDigest", "observerQualificationId", "qualificationRegistryRoot", "anchorPolicyDigest", "observedClaimIds", "rawArtifactRefs", "acquisitionProductionReceiptId", "canonicalFacts"],
  );
  const withoutHashes = {
    ...data,
    canonicalFactsHash: canonicalFactsHash(data.canonicalFacts as QualifiedObservationEnvelopeV1["canonicalFacts"]),
    payloadHash: h0(),
    observationId: h0(),
  } as QualifiedObservationEnvelopeV1;
  const ph = recomputeQualifiedObservationPayloadHash(withoutHashes);
  return observationSchema.decode({
    ...withoutHashes,
    payloadHash: ph,
    observationId: objectId("aloha.qualified-observation", ph),
  });
}
export function createQualifiedFactSnapshot(draft: QualifiedFactSnapshotDraft): QualifiedFactSnapshotV1 {
  const data = copyDraftData(
    draft,
    ["schemaVersion", "kind", "qualificationRegistryRoot", "orderedClaimIds", "orderedObservationIds", "orderedRawArtifactRefIds"],
    ["schemaVersion", "kind", "qualificationRegistryRoot", "orderedClaimIds", "orderedObservationIds", "orderedRawArtifactRefIds"],
  );
  const withoutHashes = {
    ...data,
    claimSetRoot: root("aloha/qualified-fact-snapshot/claim-set-root/v1", data.orderedClaimIds as readonly Hash[]),
    observationSetRoot: root("aloha/qualified-fact-snapshot/observation-set-root/v1", data.orderedObservationIds as readonly Hash[]),
    rawArtifactSetRoot: root("aloha/qualified-fact-snapshot/raw-artifact-set-root/v1", data.orderedRawArtifactRefIds as readonly Hash[]),
    payloadHash: h0(),
    snapshotId: h0(),
  } as QualifiedFactSnapshotV1;
  const ph = recomputeQualifiedFactSnapshotPayloadHash(withoutHashes);
  return snapshotSchema.decode({
    ...withoutHashes,
    payloadHash: ph,
    snapshotId: objectId("aloha.qualified-fact-snapshot", ph),
  });
}
export function createAcceptanceQuery(draft: AcceptanceQueryDraft): AcceptanceQueryV1 {
  const data = copyDraftData(
    draft,
    ["schemaVersion", "kind", "predicateSpecDigest", "qualificationRegistryRoot", "subjectArtifactRoot", "qualifiedFactSnapshotId", "processAnchorHash", "correlationId"],
    ["schemaVersion", "kind", "predicateSpecDigest", "qualificationRegistryRoot", "subjectArtifactRoot", "qualifiedFactSnapshotId", "processAnchorHash", "correlationId"],
  );
  const withoutHashes = { ...data, payloadHash: h0(), queryId: h0() } as AcceptanceQueryV1;
  const ph = recomputeAcceptanceQueryPayloadHash(withoutHashes);
  return querySchema.decode({
    ...withoutHashes,
    payloadHash: ph,
    queryId: objectId("aloha.acceptance-query", ph),
  });
}

export function computeObserverSemanticConfigDigest(value: Pick<
  QualifiedObservationEnvelopeV1,
  "observerImplementationDigest" | "observerQualificationId" | "qualificationRegistryRoot" | "anchorPolicyDigest" | "observationSchema"
>): Hash {
  return hashDomain("aloha/qualified-observation/semantic-config/v1", {
    observerImplementationDigest: value.observerImplementationDigest,
    observerQualificationId: value.observerQualificationId,
    qualificationRegistryRoot: value.qualificationRegistryRoot,
    anchorPolicyDigest: value.anchorPolicyDigest,
    observationSchema: value.observationSchema,
  });
}

export type QualifiedObservationLineageContext = Infer<typeof observationLineageContextSchema>;

export interface ObserverQualificationRequirementV1 {
  readonly observerQualificationId: Hash;
  readonly observerImplementationDigest: Hash;
  readonly qualificationRegistryRoot: Hash;
  readonly anchorPolicyDigest: Hash;
  readonly observationSchema: SchemaRef;
  readonly requiredLocatorKinds: readonly ReadOnlyArtifactRefV1["locator"]["kind"][];
}

export interface ArtifactResolutionRequirementV1 {
  readonly artifactRefId: Hash;
  readonly artifactClaimId: Hash;
  readonly resolverPolicyHash: Hash;
  readonly retentionLeaseReceiptId: Hash;
  readonly storeIdentityHash: Hash;
  readonly objectKey: Hash;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly mediaType: string;
  readonly schema: SchemaRef | null;
}

export interface QualifiedObservationLineageV1 {
  readonly observation: QualifiedObservationEnvelopeV1;
  readonly producerProcessAnchorHash: Hash;
  readonly observerRequirement: ObserverQualificationRequirementV1;
  readonly artifactRequirements: readonly ArtifactResolutionRequirementV1[];
}

function sameJson(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

/**
 * Validates only immutable artifact lineage and derives qualification
 * requirements. It deliberately does not decide whether any certificate is
 * current; GateCore is the sole consumer that joins these requirements to the
 * pinned registry, membership and revocation facts.
 */
export function validateQualifiedObservationLineage(
  rawValue: QualifiedObservationEnvelopeV1,
  rawContext: QualifiedObservationLineageContext,
): QualifiedObservationLineageV1 {
  const observation = observationSchema.decode(rawValue);
  const context = observationLineageContextSchema.decode(rawContext);
  const receipt: ProductionReceiptV1 | null = context.productionReceipt;
  if (receipt === null || receipt.receiptId !== observation.acquisitionProductionReceiptId) {
    throw new TypeError("acquisition production receipt is missing or mismatched");
  }
  const acquisitionArtifact = context.acquisitionArtifact;
  if (acquisitionArtifact === null) {
    throw new TypeError("acquisition semantic artifact is missing or invalid");
  }
  const exactRawIds = rawArtifactIds(observation.rawArtifactRefs);
  if (
    receipt.artifactId !== acquisitionArtifact.artifactId ||
    !sameJson(acquisitionArtifact.schema, observation.observationSchema) ||
    !sameJson(acquisitionArtifact.inputArtifactIds, exactRawIds) ||
    acquisitionArtifact.canonicalPayloadHash !== observation.canonicalFactsHash
  ) {
    throw new TypeError("acquisition artifact is not bound to this observation");
  }
  if (receipt.semanticConfigDigest !== computeObserverSemanticConfigDigest(observation)) {
    throw new TypeError("receipt semanticConfigDigest is not bound to observer configuration");
  }
  const refsById = new Map(observation.rawArtifactRefs.map((ref) => [ref.artifactRefId, ref]));
  const receiptRefs = [receipt.logRangeArtifactRef, receipt.rawBoundaryArtifactRef];
  for (const receiptRef of receiptRefs) {
    const observedRef = refsById.get(receiptRef.artifactRefId);
    if (observedRef === undefined || !sameJson(observedRef, receiptRef)) {
      throw new TypeError("receipt raw/log artifact is outside observation closure");
    }
  }
  if (context.artifactClaims.length !== observation.rawArtifactRefs.length) {
    throw new TypeError("raw artifact claim closure is incomplete");
  }
  const claimsByArtifact = new Map<string, ArtifactResolutionClaimV1>();
  for (const claim of context.artifactClaims) {
    if (claim.outcome !== "content-observed" || claim.observedMirror === null) {
      throw new TypeError("raw artifact content was not observed");
    }
    if (claimsByArtifact.has(claim.artifactRefId)) {
      throw new TypeError("duplicate raw artifact claim");
    }
    claimsByArtifact.set(claim.artifactRefId, claim);
  }
  const artifactRequirements: ArtifactResolutionRequirementV1[] = [];
  for (const ref of observation.rawArtifactRefs) {
    const claim = claimsByArtifact.get(ref.artifactRefId);
    if (claim === undefined || claim.observedMirror === null) {
      throw new TypeError("raw artifact claim is missing");
    }
    const mirror = claim.observedMirror;
    if (
      claim.resolverPolicyHash !== ref.resolverPolicyHash ||
      mirror.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash ||
      mirror.objectKey !== ref.immutableMirrorLocator.objectKey ||
      mirror.contentSha256 !== ref.contentSha256 ||
      mirror.byteLength !== ref.byteLength ||
      mirror.mediaType !== ref.mediaType ||
      !sameJson(mirror.schema, ref.schema)
    ) {
      throw new TypeError("raw artifact claim is not bound to the exact artifact ref");
    }
    artifactRequirements.push({
      artifactRefId: ref.artifactRefId,
      artifactClaimId: claim.claimId,
      resolverPolicyHash: ref.resolverPolicyHash,
      retentionLeaseReceiptId: ref.retentionLeaseReceiptId,
      storeIdentityHash: mirror.storeIdentityHash,
      objectKey: mirror.objectKey,
      contentSha256: mirror.contentSha256,
      byteLength: mirror.byteLength,
      mediaType: mirror.mediaType,
      schema: mirror.schema,
    });
  }
  const requiredLocatorKinds = [...new Set(observation.rawArtifactRefs.map((ref) => ref.locator.kind))].sort();
  return deepFreeze({
    observation,
    producerProcessAnchorHash: hashProcessAnchor(receipt.producer),
    observerRequirement: {
      observerQualificationId: observation.observerQualificationId,
      observerImplementationDigest: observation.observerImplementationDigest,
      qualificationRegistryRoot: observation.qualificationRegistryRoot,
      anchorPolicyDigest: observation.anchorPolicyDigest,
      observationSchema: observation.observationSchema,
      requiredLocatorKinds,
    },
    artifactRequirements,
  });
}

export function validateAcceptanceQueryAgainstSnapshot(
  rawQuery: AcceptanceQueryV1,
  snapshot: QualifiedFactSnapshotV1,
  processAnchor: ProcessAnchorV1,
): AcceptanceQueryV1 {
  const query = querySchema.decode(rawQuery);
  const parsedSnapshot = snapshotSchema.decode(snapshot);
  if (query.qualificationRegistryRoot !== parsedSnapshot.qualificationRegistryRoot) {
    throw new TypeError("query qualificationRegistryRoot does not match snapshot");
  }
  if (query.qualifiedFactSnapshotId !== parsedSnapshot.snapshotId) {
    throw new TypeError("query qualifiedFactSnapshotId does not match snapshot");
  }
  if (query.processAnchorHash !== hashProcessAnchor(processAnchor)) {
    throw new TypeError("query processAnchorHash does not match process anchor");
  }
  return query;
}
