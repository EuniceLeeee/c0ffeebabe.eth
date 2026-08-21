import {
  arraySchema,
  assertPlainObject,
  canonicalJsonSchema,
  decodeCanonicalJson,
  decimalStringSchema,
  deepFreeze,
  defineSchema,
  defineSchemaManifest,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  enumSchema,
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

const invocationSignatureHexSchema = defineSchema<string>(
  { kind: "ed25519-signature-hex", byteLength: 64 },
  (value, path = "$") => {
    if (typeof value !== "string" || !/^0x[0-9a-f]{128}$/.test(value)) {
      throw new TypeError(`expected lowercase 64-byte 0x signature hex at ${path}`);
    }
    return value;
  },
);

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

/*
 * Process/store observations are deliberately not QualifiedObservationEnvelopeV1.
 * They have no acquisition receipt or semantic-artifact recursion: each is a
 * small, content-addressed core sidecar whose canonical facts are joined to
 * the process/store pointer by GateCore.  The three kinds have distinct
 * schemas so a raw-artifact observer certificate cannot be reused for them.
 */
const sidecarCommonFields = {
  schemaVersion: literalSchema(1),
  observationId: hashSchema,
  payloadHash: hashSchema,
  observationSchema: schemaRefSchema,
  observerImplementationDigest: hashSchema,
  observerQualificationId: hashSchema,
  qualificationRegistryRoot: hashSchema,
  anchorPolicyDigest: hashSchema,
  roleId: nonEmptyStringSchema,
  canonicalFactsHash: hashSchema,
} as const;

const processSidecarFactsSchema = objectSchema({
  receiptId: hashSchema,
  processAnchorHash: hashSchema,
  logRangeArtifactRefId: hashSchema,
  rawBoundaryArtifactRefId: hashSchema,
});
const storeSidecarFactsSchema = objectSchema({
  storeIdentityHash: hashSchema,
  currentStoreEpoch: decimalStringSchema,
  rawArtifactRefId: hashSchema,
});
const storeEpochRawFactsSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.store-epoch-raw-facts"),
  storeIdentityHash: hashSchema,
  currentStoreEpoch: decimalStringSchema,
});

const acquisitionProcessObservationStructuralSchema = objectSchema({
  ...sidecarCommonFields,
  kind: literalSchema("aloha.acquisition-process-observation"),
  canonicalFacts: processSidecarFactsSchema,
});
const targetProcessObservationStructuralSchema = objectSchema({
  ...sidecarCommonFields,
  kind: literalSchema("aloha.target-process-observation"),
  canonicalFacts: processSidecarFactsSchema,
});
const storeEpochObservationStructuralSchema = objectSchema({
  ...sidecarCommonFields,
  kind: literalSchema("aloha.store-epoch-observation"),
  canonicalFacts: storeSidecarFactsSchema,
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

const observerInvocationBindingSchema = objectSchema({
  kind: enumSchema(["semantic-artifact", "production-receipt"] as const),
  objectId: hashSchema,
  rawArtifactRefId: hashSchema,
  canonicalBytesSha256: hashSchema,
  byteLength: decimalStringSchema,
});

const signedObserverInvocationSnapshotStructuralSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.signed-observer-invocation-snapshot"),
  attestationId: hashSchema,
  payloadHash: hashSchema,
  registryRoot: hashSchema,
  registryEpoch: decimalStringSchema,
  observerQualificationId: hashSchema,
  roleId: nonEmptyStringSchema,
  keyId: hashSchema,
  audienceHash: hashSchema,
  invocationNonce: hashSchema,
  issuedAtUnixNs: decimalStringSchema,
  expiresAtUnixNs: decimalStringSchema,
  acceptanceQueryId: hashSchema,
  qualifiedFactSnapshotId: hashSchema,
  semanticArtifactBindings: arraySchema(observerInvocationBindingSchema),
  semanticArtifactSetRoot: hashSchema,
  productionReceiptBindings: arraySchema(observerInvocationBindingSchema),
  productionReceiptSetRoot: hashSchema,
  bindingSetRoot: hashSchema,
  signatureAlgorithm: literalSchema("ed25519"),
  signatureHex: invocationSignatureHexSchema,
});

export type QualifiedObservationEnvelopeV1 = Infer<typeof observationStructuralSchema>;
export type AcquisitionProcessObservationEnvelopeV1 = Infer<typeof acquisitionProcessObservationStructuralSchema>;
export type TargetProcessObservationEnvelopeV1 = Infer<typeof targetProcessObservationStructuralSchema>;
export type StoreEpochObservationEnvelopeV1 = Infer<typeof storeEpochObservationStructuralSchema>;
export type StoreEpochRawFactsV1 = Infer<typeof storeEpochRawFactsSchema>;
export type QualifiedSidecarObservationV1 = AcquisitionProcessObservationEnvelopeV1 | TargetProcessObservationEnvelopeV1 | StoreEpochObservationEnvelopeV1;
export type QualifiedFactSnapshotV1 = Infer<typeof snapshotStructuralSchema>;
export type AcceptanceQueryV1 = Infer<typeof queryStructuralSchema>;
export type SignedObserverInvocationSnapshotV1 = Infer<typeof signedObserverInvocationSnapshotStructuralSchema>;
export type ObserverInvocationBindingV1 = Infer<typeof observerInvocationBindingSchema>;

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
function signedObserverInvocationPayload(value: SignedObserverInvocationSnapshotV1): object {
  const { attestationId: _attestationId, payloadHash: _payloadHash, signatureHex: _signatureHex, ...payload } = value;
  return payload;
}

function payloadHash(domainKind: string, payload: object): Hash {
  return hashDomain(`${domainKind}/payload/v1`, payload);
}
function objectId(domainKind: string, payloadDigest: Hash): Hash {
  return hashDomain(`${domainKind}/id/v1`, payloadDigest);
}

function bindingRoot(domain: string, bindings: readonly ObserverInvocationBindingV1[]): Hash {
  return hashDomain(domain, bindings);
}

function bindingSetRoot(
  semanticArtifactSetRoot: Hash,
  productionReceiptSetRoot: Hash,
): Hash {
  return hashDomain("aloha/signed-observer-invocation-snapshot/binding-set/v1", {
    semanticArtifactSetRoot,
    productionReceiptSetRoot,
  });
}

export function hashSemanticArtifactBindingSetRoot(bindings: readonly ObserverInvocationBindingV1[]): Hash {
  assertStrictlySortedUnique(bindings.map((binding) => binding.objectId), "semanticArtifactBindings");
  if (bindings.some((binding) => binding.kind !== "semantic-artifact")) throw new TypeError("semantic artifact binding set contains a non-semantic binding");
  if (bindings.some((binding) => BigInt(binding.byteLength) === 0n)) throw new TypeError("semantic artifact binding byteLength must be positive");
  if (new Set(bindings.map((binding) => binding.rawArtifactRefId)).size !== bindings.length) throw new TypeError("semantic artifact bindings reuse a raw artifact ref");
  return bindingRoot("aloha/signed-observer-invocation-snapshot/semantic-artifact-set/v1", bindings);
}

export function hashProductionReceiptBindingSetRoot(bindings: readonly ObserverInvocationBindingV1[]): Hash {
  assertStrictlySortedUnique(bindings.map((binding) => binding.objectId), "productionReceiptBindings");
  if (bindings.some((binding) => binding.kind !== "production-receipt")) throw new TypeError("production receipt binding set contains a non-receipt binding");
  if (bindings.some((binding) => BigInt(binding.byteLength) === 0n)) throw new TypeError("production receipt binding byteLength must be positive");
  if (new Set(bindings.map((binding) => binding.rawArtifactRefId)).size !== bindings.length) throw new TypeError("production receipt bindings reuse a raw artifact ref");
  return bindingRoot("aloha/signed-observer-invocation-snapshot/production-receipt-set/v1", bindings);
}

export function hashObserverInvocationBindingSetRoot(
  semanticArtifactSetRoot: Hash,
  productionReceiptSetRoot: Hash,
): Hash {
  return bindingSetRoot(semanticArtifactSetRoot, productionReceiptSetRoot);
}

function signedObserverInvocationAttestationId(payloadDigest: Hash, signatureHex: string): Hash {
  return hashDomain("aloha/signed-observer-invocation-snapshot/id/v1", { payloadHash: payloadDigest, signatureHex });
}

function checkSignedObserverInvocationSnapshot(
  value: SignedObserverInvocationSnapshotV1,
  path: string,
): SignedObserverInvocationSnapshotV1 {
  const zero = `0x${"0".repeat(64)}` as Hash;
  if (value.invocationNonce === zero) throw new TypeError(`invocationNonce must be non-zero at ${path}`);
  if (BigInt(value.issuedAtUnixNs) >= BigInt(value.expiresAtUnixNs)) {
    throw new TypeError(`invocation validity interval must be strictly positive at ${path}`);
  }
  const semanticArtifactSetRoot = hashSemanticArtifactBindingSetRoot(value.semanticArtifactBindings);
  const productionReceiptSetRoot = hashProductionReceiptBindingSetRoot(value.productionReceiptBindings);
  const allBindings = [...value.semanticArtifactBindings, ...value.productionReceiptBindings];
  const bindingPairs = allBindings.map((binding) => `${binding.kind}\u0000${binding.objectId}`);
  const rawArtifactRefIds = allBindings.map((binding) => binding.rawArtifactRefId);
  if (new Set(bindingPairs).size !== bindingPairs.length) throw new TypeError(`duplicate observer invocation binding at ${path}`);
  if (new Set(rawArtifactRefIds).size !== rawArtifactRefIds.length) throw new TypeError(`raw artifact ref is reused by multiple observer invocation bindings at ${path}`);
  for (const binding of allBindings) {
    if (BigInt(binding.byteLength) === 0n) throw new TypeError(`observer invocation binding byteLength must be positive at ${path}`);
  }
  const expectedBindingSetRoot = bindingSetRoot(semanticArtifactSetRoot, productionReceiptSetRoot);
  if (value.semanticArtifactSetRoot !== semanticArtifactSetRoot) throw new TypeError(`semantic artifact binding root mismatch at ${path}`);
  if (value.productionReceiptSetRoot !== productionReceiptSetRoot) throw new TypeError(`production receipt binding root mismatch at ${path}`);
  if (value.bindingSetRoot !== expectedBindingSetRoot) throw new TypeError(`invocation binding root mismatch at ${path}`);
  const expectedPayloadHash = payloadHash("aloha.signed-observer-invocation-snapshot", signedObserverInvocationPayload(value));
  const expectedAttestationId = signedObserverInvocationAttestationId(expectedPayloadHash, value.signatureHex);
  if (value.payloadHash !== expectedPayloadHash) throw new TypeError(`signed observer invocation payloadHash mismatch at ${path}`);
  if (value.attestationId !== expectedAttestationId) throw new TypeError(`signed observer invocation attestationId mismatch at ${path}`);
  return deepFreeze(value);
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

function refineSidecarObservation<T extends QualifiedSidecarObservationV1>(
  value: T,
  path: string,
  domainKind: string,
): T {
  if (value.observationSchema.id !== value.kind) {
    throw new TypeError(`sidecar observation schema does not match kind at ${path}`);
  }
  if (value.canonicalFactsHash !== canonicalFactsHash(value.canonicalFacts)) {
    throw new TypeError(`canonicalFactsHash does not match facts at ${path}`);
  }
  const { observationId: _observationId, payloadHash: _payloadHash, ...payload } = value;
  const expectedPayloadHash = payloadHash(domainKind, payload);
  const expectedId = objectId(domainKind, expectedPayloadHash);
  if (value.payloadHash !== expectedPayloadHash || value.observationId !== expectedId) {
    throw new TypeError(`sidecar observation payloadHash/observationId mismatch at ${path}`);
  }
  return value;
}

const acquisitionProcessObservationSchema = refineSchema(
  acquisitionProcessObservationStructuralSchema,
  "aloha.acquisition-process-observation.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.acquisition-process-observation.refinement.v1",
    version: "1.0.0",
    rules: ["canonical-facts-hash", "payload-and-id"],
  }),
  (value, path) => refineSidecarObservation(value, path, "aloha.acquisition-process-observation"),
);
const targetProcessObservationSchema = refineSchema(
  targetProcessObservationStructuralSchema,
  "aloha.target-process-observation.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.target-process-observation.refinement.v1",
    version: "1.0.0",
    rules: ["canonical-facts-hash", "payload-and-id"],
  }),
  (value, path) => refineSidecarObservation(value, path, "aloha.target-process-observation"),
);
const storeEpochObservationSchema = refineSchema(
  storeEpochObservationStructuralSchema,
  "aloha.store-epoch-observation.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.store-epoch-observation.refinement.v1",
    version: "1.0.0",
    rules: ["canonical-facts-hash", "payload-and-id"],
  }),
  (value, path) => refineSidecarObservation(value, path, "aloha.store-epoch-observation"),
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
const signedObserverInvocationSnapshotSchema = refineSchema(
  signedObserverInvocationSnapshotStructuralSchema,
  "aloha.signed-observer-invocation-snapshot.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.signed-observer-invocation-snapshot.refinement.v1",
    version: "1.0.0",
    rules: ["payload-excludes-attestation-and-signature", "attestation-binds-payload-and-signature", "nonzero-nonce", "strict-positive-time-window"],
  }),
  checkSignedObserverInvocationSnapshot,
);

export const QUALIFIED_FACT_SCHEMA_MANIFESTS = Object.freeze({
  observation: defineSchemaManifest("aloha.qualified-observation", "1.0.0", observationSchema),
  acquisitionProcessObservation: defineSchemaManifest("aloha.acquisition-process-observation", "1.0.0", acquisitionProcessObservationSchema),
  targetProcessObservation: defineSchemaManifest("aloha.target-process-observation", "1.0.0", targetProcessObservationSchema),
  storeEpochObservation: defineSchemaManifest("aloha.store-epoch-observation", "1.0.0", storeEpochObservationSchema),
  storeEpochRawFacts: defineSchemaManifest("aloha.store-epoch-raw-facts", "1.0.0", storeEpochRawFactsSchema),
  snapshot: defineSchemaManifest("aloha.qualified-fact-snapshot", "1.0.0", snapshotSchema),
  acceptanceQuery: defineSchemaManifest("aloha.acceptance-query", "1.0.0", querySchema),
  signedObserverInvocationSnapshot: defineSchemaManifest("aloha.signed-observer-invocation-snapshot", "1.0.0", signedObserverInvocationSnapshotSchema),
});

export function recomputeQualifiedObservationPayloadHash(value: QualifiedObservationEnvelopeV1): Hash {
  return payloadHash("aloha.qualified-observation", observationPayload(observationStructuralSchema.decode(value)));
}
export function recomputeQualifiedObservationId(value: QualifiedObservationEnvelopeV1): Hash {
  return objectId("aloha.qualified-observation", recomputeQualifiedObservationPayloadHash(value));
}
function recomputeSidecarPayloadHash<T extends QualifiedSidecarObservationV1>(
  value: T,
  schema: { decode(value: unknown): T },
  domainKind: string,
): Hash {
  const decoded = schema.decode(value);
  const { observationId: _observationId, payloadHash: _payloadHash, ...payload } = decoded;
  return payloadHash(domainKind, payload);
}
export function recomputeAcquisitionProcessObservationPayloadHash(value: AcquisitionProcessObservationEnvelopeV1): Hash {
  return recomputeSidecarPayloadHash(value, acquisitionProcessObservationStructuralSchema, "aloha.acquisition-process-observation");
}
export function recomputeAcquisitionProcessObservationId(value: AcquisitionProcessObservationEnvelopeV1): Hash {
  return objectId("aloha.acquisition-process-observation", recomputeAcquisitionProcessObservationPayloadHash(value));
}
export function recomputeTargetProcessObservationPayloadHash(value: TargetProcessObservationEnvelopeV1): Hash {
  return recomputeSidecarPayloadHash(value, targetProcessObservationStructuralSchema, "aloha.target-process-observation");
}
export function recomputeTargetProcessObservationId(value: TargetProcessObservationEnvelopeV1): Hash {
  return objectId("aloha.target-process-observation", recomputeTargetProcessObservationPayloadHash(value));
}
export function recomputeStoreEpochObservationPayloadHash(value: StoreEpochObservationEnvelopeV1): Hash {
  return recomputeSidecarPayloadHash(value, storeEpochObservationStructuralSchema, "aloha.store-epoch-observation");
}
export function recomputeStoreEpochObservationId(value: StoreEpochObservationEnvelopeV1): Hash {
  return objectId("aloha.store-epoch-observation", recomputeStoreEpochObservationPayloadHash(value));
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
export function recomputeSignedObserverInvocationSnapshotPayloadHash(value: SignedObserverInvocationSnapshotV1): Hash {
  return payloadHash("aloha.signed-observer-invocation-snapshot", signedObserverInvocationPayload(signedObserverInvocationSnapshotStructuralSchema.decode(value)));
}
export function recomputeSignedObserverInvocationSnapshotId(value: SignedObserverInvocationSnapshotV1): Hash {
  const decoded = signedObserverInvocationSnapshotStructuralSchema.decode(value);
  return signedObserverInvocationAttestationId(recomputeSignedObserverInvocationSnapshotPayloadHash(decoded), decoded.signatureHex);
}

function parse(value: string | Uint8Array | object): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}
export function decodeQualifiedObservation(value: string | Uint8Array | object): QualifiedObservationEnvelopeV1 {
  return observationSchema.decode(parse(value));
}
export function decodeAcquisitionProcessObservation(value: string | Uint8Array | object): AcquisitionProcessObservationEnvelopeV1 {
  return acquisitionProcessObservationSchema.decode(parse(value));
}
export function decodeTargetProcessObservation(value: string | Uint8Array | object): TargetProcessObservationEnvelopeV1 {
  return targetProcessObservationSchema.decode(parse(value));
}
export function decodeStoreEpochObservation(value: string | Uint8Array | object): StoreEpochObservationEnvelopeV1 {
  return storeEpochObservationSchema.decode(parse(value));
}
export function decodeStoreEpochRawFacts(value: string | Uint8Array | object): StoreEpochRawFactsV1 {
  return storeEpochRawFactsSchema.decode(parse(value));
}
export function decodeQualifiedFactSnapshot(value: string | Uint8Array | object): QualifiedFactSnapshotV1 {
  return snapshotSchema.decode(parse(value));
}
export function decodeAcceptanceQuery(value: string | Uint8Array | object): AcceptanceQueryV1 {
  return querySchema.decode(parse(value));
}
export function decodeSignedObserverInvocationSnapshot(value: string | Uint8Array | object): SignedObserverInvocationSnapshotV1 {
  return signedObserverInvocationSnapshotSchema.decode(parse(value));
}
export function encodeQualifiedObservation(value: QualifiedObservationEnvelopeV1): Uint8Array {
  return encodeCanonicalBytes(observationSchema.decode(value));
}
export function encodeAcquisitionProcessObservation(value: AcquisitionProcessObservationEnvelopeV1): Uint8Array {
  return encodeCanonicalBytes(acquisitionProcessObservationSchema.decode(value));
}
export function encodeTargetProcessObservation(value: TargetProcessObservationEnvelopeV1): Uint8Array {
  return encodeCanonicalBytes(targetProcessObservationSchema.decode(value));
}
export function encodeStoreEpochObservation(value: StoreEpochObservationEnvelopeV1): Uint8Array {
  return encodeCanonicalBytes(storeEpochObservationSchema.decode(value));
}
export function encodeStoreEpochRawFacts(value: StoreEpochRawFactsV1): Uint8Array {
  return encodeCanonicalBytes(storeEpochRawFactsSchema.decode(value));
}
export function encodeQualifiedFactSnapshot(value: QualifiedFactSnapshotV1): Uint8Array {
  return encodeCanonicalBytes(snapshotSchema.decode(value));
}
export function encodeAcceptanceQuery(value: AcceptanceQueryV1): Uint8Array {
  return encodeCanonicalBytes(querySchema.decode(value));
}
export function encodeSignedObserverInvocationSnapshot(value: SignedObserverInvocationSnapshotV1): Uint8Array {
  return encodeCanonicalBytes(signedObserverInvocationSnapshotSchema.decode(value));
}

/** The exact bytes an external Ed25519 signer must sign for this invocation. */
export function observerInvocationSigningBytes(value: SignedObserverInvocationSnapshotV1): Uint8Array {
  const decoded = signedObserverInvocationSnapshotSchema.decode(value);
  return encodeCanonicalBytes({
    domain: "aloha/signed-observer-invocation",
    version: 1,
    keyId: decoded.keyId,
    registryRoot: decoded.registryRoot,
    payloadHash: decoded.payloadHash,
  });
}

export type QualifiedObservationDraft = Omit<QualifiedObservationEnvelopeV1, "observationId" | "payloadHash" | "canonicalFactsHash">;
export type QualifiedSidecarObservationDraft = Omit<QualifiedSidecarObservationV1, "observationId" | "payloadHash" | "canonicalFactsHash">;
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

function createSidecarObservation<T extends QualifiedSidecarObservationV1>(
  draft: Omit<T, "observationId" | "payloadHash" | "canonicalFactsHash">,
  schema: { decode(value: unknown): T },
  domainKind: string,
): T {
  const data = copyDraftData(
    draft,
    ["schemaVersion", "kind", "observationSchema", "observerImplementationDigest", "observerQualificationId", "qualificationRegistryRoot", "anchorPolicyDigest", "roleId", "canonicalFacts"],
    ["schemaVersion", "kind", "observationSchema", "observerImplementationDigest", "observerQualificationId", "qualificationRegistryRoot", "anchorPolicyDigest", "roleId", "canonicalFacts"],
  );
  const withoutHashes = {
    ...data,
    canonicalFactsHash: canonicalFactsHash(data.canonicalFacts as T["canonicalFacts"]),
    payloadHash: h0(),
    observationId: h0(),
  } as T;
  const { observationId: _observationId, payloadHash: _payloadHash, ...payload } = withoutHashes;
  const ph = payloadHash(domainKind, payload);
  return schema.decode({
    ...withoutHashes,
    payloadHash: ph,
    observationId: objectId(domainKind, ph),
  });
}

export function createAcquisitionProcessObservation(
  draft: Omit<AcquisitionProcessObservationEnvelopeV1, "observationId" | "payloadHash" | "canonicalFactsHash">,
): AcquisitionProcessObservationEnvelopeV1 {
  return createSidecarObservation(draft, acquisitionProcessObservationSchema, "aloha.acquisition-process-observation");
}
export function createTargetProcessObservation(
  draft: Omit<TargetProcessObservationEnvelopeV1, "observationId" | "payloadHash" | "canonicalFactsHash">,
): TargetProcessObservationEnvelopeV1 {
  return createSidecarObservation(draft, targetProcessObservationSchema, "aloha.target-process-observation");
}
export function createStoreEpochObservation(
  draft: Omit<StoreEpochObservationEnvelopeV1, "observationId" | "payloadHash" | "canonicalFactsHash">,
): StoreEpochObservationEnvelopeV1 {
  return createSidecarObservation(draft, storeEpochObservationSchema, "aloha.store-epoch-observation");
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

export type SignedObserverInvocationSnapshotDraft = Omit<SignedObserverInvocationSnapshotV1, "attestationId" | "payloadHash" | "semanticArtifactSetRoot" | "productionReceiptSetRoot" | "bindingSetRoot" | "signatureHex">;

const ZERO_SIGNATURE_HEX = `0x${"0".repeat(128)}`;

function createSignedObserverInvocationSnapshotWithSignature(
  draft: SignedObserverInvocationSnapshotDraft,
  signatureHex: string,
): SignedObserverInvocationSnapshotV1 {
  const data = copyDraftData(
    draft,
    [
      "schemaVersion", "kind", "registryRoot", "registryEpoch", "observerQualificationId", "roleId", "keyId",
      "audienceHash", "invocationNonce", "issuedAtUnixNs", "expiresAtUnixNs", "acceptanceQueryId",
      "qualifiedFactSnapshotId", "semanticArtifactBindings", "productionReceiptBindings", "signatureAlgorithm",
    ],
    [
      "schemaVersion", "kind", "registryRoot", "registryEpoch", "observerQualificationId", "roleId", "keyId",
      "audienceHash", "invocationNonce", "issuedAtUnixNs", "expiresAtUnixNs", "acceptanceQueryId",
      "qualifiedFactSnapshotId", "semanticArtifactBindings", "productionReceiptBindings", "signatureAlgorithm",
    ],
  );
  const unsigned = signedObserverInvocationSnapshotStructuralSchema.decode({
    ...data,
    semanticArtifactSetRoot: hashSemanticArtifactBindingSetRoot(data.semanticArtifactBindings as readonly ObserverInvocationBindingV1[]),
    productionReceiptSetRoot: hashProductionReceiptBindingSetRoot(data.productionReceiptBindings as readonly ObserverInvocationBindingV1[]),
    bindingSetRoot: bindingSetRoot(
      hashSemanticArtifactBindingSetRoot(data.semanticArtifactBindings as readonly ObserverInvocationBindingV1[]),
      hashProductionReceiptBindingSetRoot(data.productionReceiptBindings as readonly ObserverInvocationBindingV1[]),
    ),
    payloadHash: h0(),
    attestationId: h0(),
    signatureHex,
  });
  const ph = recomputeSignedObserverInvocationSnapshotPayloadHash(unsigned);
  return signedObserverInvocationSnapshotSchema.decode({
    ...unsigned,
    payloadHash: ph,
    attestationId: signedObserverInvocationAttestationId(ph, unsigned.signatureHex),
  });
}

/** Creates a structurally valid unsigned snapshot with an all-zero signature placeholder. */
export function createUnsignedSignedObserverInvocationSnapshot(
  draft: SignedObserverInvocationSnapshotDraft,
): SignedObserverInvocationSnapshotV1 {
  return createSignedObserverInvocationSnapshotWithSignature(draft, ZERO_SIGNATURE_HEX);
}

/** Seals a previously prepared snapshot with signature bytes supplied by an external signer. */
export function sealSignedObserverInvocationSnapshot(
  unsigned: SignedObserverInvocationSnapshotV1,
  signatureHex: string,
): SignedObserverInvocationSnapshotV1 {
  const decoded = signedObserverInvocationSnapshotStructuralSchema.decode(unsigned);
  const checkedSignature = invocationSignatureHexSchema.decode(signatureHex);
  const expectedPayloadHash = recomputeSignedObserverInvocationSnapshotPayloadHash(decoded);
  if (decoded.payloadHash !== expectedPayloadHash) throw new TypeError("cannot seal a snapshot with a mismatched payloadHash");
  return signedObserverInvocationSnapshotSchema.decode({
    ...decoded,
    signatureHex: checkedSignature,
    attestationId: signedObserverInvocationAttestationId(expectedPayloadHash, checkedSignature),
  });
}

/** Convenience wrapper for callers that already hold externally produced signature bytes. */
export function createSignedObserverInvocationSnapshot(
  draft: SignedObserverInvocationSnapshotDraft,
  signatureHex: string,
): SignedObserverInvocationSnapshotV1 {
  return sealSignedObserverInvocationSnapshot(createUnsignedSignedObserverInvocationSnapshot(draft), signatureHex);
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
