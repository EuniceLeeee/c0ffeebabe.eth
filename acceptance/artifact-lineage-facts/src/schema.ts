import {
  assertDecimalString,
  assertExactKeys,
  assertPlainObject,
  decodeCanonicalJson,
  decimalStringSchema,
  defineSchema,
  defineSchemaManifest,
  encodeCanonicalBytes,
  hashDomain,
  hashSchema,
  literalSchema,
  nullableSchema,
  objectSchema,
  refineSchema,
  readOwnEnumerableDataProperty,
  sha256Hex,
  stringSchema,
  type CanonicalJsonObject,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  CORE_SCHEMA_MANIFESTS,
  type ReadOnlyArtifactLocatorV1,
  type ReadOnlyArtifactRefV1,
  type SchemaRef,
} from "../../../specs/core-envelope/src/index.ts";
import {
  ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS,
  decodeArtifactBytes,
  encodeArtifactBytes,
} from "../../../specs/artifact-resolution/src/index.ts";

export type { Hash, ReadOnlyArtifactLocatorV1, ReadOnlyArtifactRefV1, SchemaRef };

export type ArtifactLineageCodecInput = string | Uint8Array | object;
export type ArtifactLineageVerdict = "pass" | "fail" | "invalid";

const CLAIM_PAYLOAD_DOMAIN = "aloha/artifact-lineage-claim/payload/v2";
const OBSERVATION_PAYLOAD_DOMAIN = "aloha/artifact-lineage-observation/payload/v2";
const OBSERVATION_ID_DOMAIN = "aloha/artifact-lineage-observation/id/v2";

function parseInput(value: ArtifactLineageCodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

function preflightClaimMirrorBudget(
  value: unknown,
  path = "$",
  shape: "structural" | "payload" = "structural",
): void {
  assertPlainObject(value, path);
  assertExactKeys(
    value,
    shape === "structural" ? [...Object.keys(claimFields), "claimId"] : Object.keys(claimFields),
    path,
  );
  const policy = resolverPolicySchema.decode(
    readOwnEnumerableDataProperty(value, "resolverPolicy", path),
    `${path}.resolverPolicy`,
  );
  const maxByteLength = BigInt(policy.maxByteLength);
  const resolution = readOwnEnumerableDataProperty(value, "resolutionClaim", path);
  assertPlainObject(resolution, `${path}.resolutionClaim`);
  assertExactKeys(
    resolution,
    ["claimId", "artifactRefId", "resolverPolicyHash", "observedMirror", "outcome"],
    `${path}.resolutionClaim`,
  );
  const mirror = readOwnEnumerableDataProperty(
    resolution,
    "observedMirror",
    `${path}.resolutionClaim`,
  );
  if (mirror === null) return;
  assertPlainObject(mirror, `${path}.resolutionClaim.observedMirror`);
  assertExactKeys(
    mirror,
    ["storeIdentityHash", "objectKey", "bytes", "contentSha256", "byteLength", "mediaType", "schema"],
    `${path}.resolutionClaim.observedMirror`,
  );
  const bytes = readOwnEnumerableDataProperty(
    mirror,
    "bytes",
    `${path}.resolutionClaim.observedMirror`,
  );
  const byteLength = assertDecimalString(
    readOwnEnumerableDataProperty(
      mirror,
      "byteLength",
      `${path}.resolutionClaim.observedMirror`,
    ),
    `${path}.resolutionClaim.observedMirror.byteLength`,
  );
  if (typeof bytes !== "string") {
    throw new TypeError(`mirror bytes must be a string at ${path}.resolutionClaim.observedMirror.bytes`);
  }
  // This bound is checked before hex validation, byte allocation or hashing.
  if (BigInt(byteLength) > maxByteLength || BigInt(Math.max(0, bytes.length - 2)) > maxByteLength * 2n) {
    throw new TypeError(`mirror bytes exceed resolver policy before decode at ${path}.resolutionClaim.observedMirror.bytes`);
  }
}

function payloadWithout<T extends object>(value: T, fields: readonly string[]): CanonicalJsonObject {
  const output: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of fields) delete output[field];
  return output as CanonicalJsonObject;
}

const schemaRefSchema = CORE_SCHEMA_MANIFESTS.schemaRef.schema;
const locatorSchema = CORE_SCHEMA_MANIFESTS.readOnlyArtifactLocator.schema;
const artifactRefSchema = CORE_SCHEMA_MANIFESTS.readOnlyArtifactRef.schema;
const resolverPolicySchema = ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.resolverPolicy.schema;
const leaseSchema = ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.retentionLeaseReceipt.schema;
const resolutionClaimSchema = ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.artifactResolutionClaim.schema;

/** Canonical wire bytes are immutable lowercase hex, never a caller-owned view. */
export const artifactLineageBytesSchema = defineSchema<string>(
  { kind: "artifact-bytes-hex" },
  (value, path = "$") => {
    if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
      throw new TypeError(`artifact bytes must be lowercase even-length hex at ${path}`);
    }
    return value;
  },
);

const claimFields = {
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.artifact-lineage-claim"),
  artifactRef: artifactRefSchema,
  resolverPolicy: resolverPolicySchema,
  resolutionClaim: resolutionClaimSchema,
  retentionLease: leaseSchema,
  observedStoreEpoch: decimalStringSchema,
} as const;

const claimPayloadSchema = objectSchema(claimFields);
const claimStructuralSchema = objectSchema({ ...claimFields, claimId: hashSchema });

export interface ArtifactLineageClaimV1 extends Infer<typeof claimStructuralSchema> {}

function refineClaim(value: ArtifactLineageClaimV1, path: string): ArtifactLineageClaimV1 {
  if (value.artifactRef.resolverPolicyHash !== value.resolverPolicy.policyHash) {
    throw new TypeError(`artifact ref policy does not match resolver policy at ${path}`);
  }
  if (value.resolutionClaim.artifactRefId !== value.artifactRef.artifactRefId) {
    throw new TypeError(`resolution claim artifactRefId does not match ref at ${path}`);
  }
  if (value.resolutionClaim.resolverPolicyHash !== value.resolverPolicy.policyHash) {
    throw new TypeError(`resolution claim policy does not match resolver policy at ${path}`);
  }
  const lease = value.retentionLease;
  const mirror = value.artifactRef.immutableMirrorLocator;
  if (
    lease.storeIdentityHash !== mirror.storeIdentityHash ||
    lease.objectKey !== mirror.objectKey ||
    lease.contentSha256 !== value.artifactRef.contentSha256 ||
    value.artifactRef.retentionLeaseReceiptId !== lease.receiptId
  ) {
    throw new TypeError(`retention lease subject does not match artifact ref at ${path}`);
  }
  const expected = hashDomain(CLAIM_PAYLOAD_DOMAIN, payloadWithout(value, ["claimId"]));
  if (value.claimId !== expected) {
    throw new TypeError(`claimId does not match artifact-lineage claim at ${path}.claimId`);
  }
  return value;
}

const CLAIM_REFINEMENT_SPEC_DIGEST = hashDomain("aloha/schema-refinement-spec/v1", {
  id: "aloha.artifact-lineage-claim.refinement.v2",
  version: "2.0.0",
  rules: [
    "artifact-ref-policy-hash",
    "resolution-claim-ref-and-policy",
    "retention-lease-subject",
    "claim-id-matches-payload",
  ],
});

const artifactLineageClaimSemanticSchema = refineSchema(
  claimStructuralSchema,
  "aloha.artifact-lineage-claim.refinement.v2",
  CLAIM_REFINEMENT_SPEC_DIGEST,
  refineClaim,
);

const CLAIM_BUDGET_PREFLIGHT_SPEC_DIGEST = hashDomain("aloha/schema-refinement-spec/v1", {
  id: "aloha.artifact-lineage-claim.resource-preflight.v1",
  version: "1.0.0",
  rules: [
    "resolver-policy-before-mirror-binary-decode",
    "declared-byte-length-within-policy",
    "wire-hex-length-within-policy",
  ],
});

/** Manifest-visible schema: no caller can bypass the resource preflight. */
export const artifactLineageClaimSchema = defineSchema<ArtifactLineageClaimV1>(
  {
    kind: "preflight-bounded",
    preflightId: "aloha.artifact-lineage-claim.resource-preflight.v1",
    preflightSpecDigest: CLAIM_BUDGET_PREFLIGHT_SPEC_DIGEST,
    base: artifactLineageClaimSemanticSchema.descriptor,
  },
  (value, path = "$") => {
    preflightClaimMirrorBudget(value, path);
    return artifactLineageClaimSemanticSchema.decode(value, path);
  },
);

const observationFields = {
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.artifact-lineage-observation"),
  artifactRefId: hashSchema,
  locator: locatorSchema,
  immutableMirrorLocator: objectSchema({
    kind: literalSchema("content-object"),
    storeIdentityHash: hashSchema,
    objectKey: hashSchema,
  }),
  rawBytes: nullableSchema(artifactLineageBytesSchema),
  contentSha256: nullableSchema(hashSchema),
  byteLength: nullableSchema(decimalStringSchema),
  mediaType: nullableSchema(stringSchema),
  schema: nullableSchema(schemaRefSchema),
  observedStoreEpoch: decimalStringSchema,
} as const;

const observationPayloadSchema = objectSchema(observationFields);
const observationStructuralSchema = objectSchema({
  ...observationFields,
  observationId: hashSchema,
  payloadHash: hashSchema,
});

export interface ArtifactLineageObservationV1 extends Infer<typeof observationStructuralSchema> {}

function refineObservation(
  value: ArtifactLineageObservationV1,
  path: string,
): ArtifactLineageObservationV1 {
  const empty = value.rawBytes === null;
  if (empty !== (value.contentSha256 === null && value.byteLength === null && value.mediaType === null)) {
    throw new TypeError(`raw observation sidecars must be all-null or all-present at ${path}`);
  }
  const expectedPayloadHash = hashDomain(
    OBSERVATION_PAYLOAD_DOMAIN,
    payloadWithout(value, ["observationId", "payloadHash"]),
  );
  if (value.payloadHash !== expectedPayloadHash) {
    throw new TypeError(`observation payloadHash does not match at ${path}.payloadHash`);
  }
  if (value.observationId !== hashDomain(OBSERVATION_ID_DOMAIN, expectedPayloadHash)) {
    throw new TypeError(`observationId does not match at ${path}.observationId`);
  }
  return value;
}

const OBSERVATION_REFINEMENT_SPEC_DIGEST = hashDomain("aloha/schema-refinement-spec/v1", {
  id: "aloha.artifact-lineage-observation.refinement.v2",
  version: "2.0.0",
  rules: [
    "raw-bytes-sidecars-all-null-or-all-present",
    "observation-payload-hash",
    "observation-id-matches-payload-hash",
  ],
});

export const artifactLineageObservationSchema = refineSchema(
  observationStructuralSchema,
  "aloha.artifact-lineage-observation.refinement.v2",
  OBSERVATION_REFINEMENT_SPEC_DIGEST,
  refineObservation,
);

export interface ArtifactLineageRawFactsInputV1 extends Infer<typeof rawFactsSchema> {}

const rawFactsSchema = objectSchema({
  rawBytes: nullableSchema(artifactLineageBytesSchema),
  locator: locatorSchema,
  immutableMirrorLocator: objectSchema({
    kind: literalSchema("content-object"),
    storeIdentityHash: hashSchema,
    objectKey: hashSchema,
  }),
  mediaType: stringSchema,
  schema: nullableSchema(schemaRefSchema),
  observedStoreEpoch: decimalStringSchema,
});

export interface ArtifactLineageFactBundleV1 extends Infer<typeof artifactLineageFactBundleSchema> {}

const artifactLineageFactBundleSchema = objectSchema({
  claim: artifactLineageClaimSchema,
  observation: artifactLineageObservationSchema,
  rawFacts: rawFactsSchema,
});

export const ARTIFACT_LINEAGE_SCHEMA_MANIFESTS = Object.freeze({
  claim: defineSchemaManifest("aloha.artifact-lineage-claim", "2.0.0", artifactLineageClaimSchema),
  observation: defineSchemaManifest("aloha.artifact-lineage-observation", "2.0.0", artifactLineageObservationSchema),
  rawFacts: defineSchemaManifest("aloha.artifact-lineage-raw-facts", "1.0.0", rawFactsSchema),
  factBundle: defineSchemaManifest("aloha.artifact-lineage-fact-bundle", "1.0.0", artifactLineageFactBundleSchema),
  artifactRef: CORE_SCHEMA_MANIFESTS.readOnlyArtifactRef,
  resolverPolicy: ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.resolverPolicy,
  retentionLease: ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.retentionLeaseReceipt,
  resolutionClaim: ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.artifactResolutionClaim,
});

function schemaRefOf(manifest: { readonly id: string; readonly version: string; readonly schemaHash: Hash }): SchemaRef {
  return { id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash };
}

export function decodeArtifactLineageClaim(value: ArtifactLineageCodecInput): ArtifactLineageClaimV1 {
  const parsed = parseInput(value);
  preflightClaimMirrorBudget(parsed);
  return artifactLineageClaimSchema.decode(parsed);
}

export function decodeArtifactLineageObservation(value: ArtifactLineageCodecInput): ArtifactLineageObservationV1 {
  return artifactLineageObservationSchema.decode(parseInput(value));
}

export function decodeArtifactLineageRawFacts(value: ArtifactLineageCodecInput): ArtifactLineageRawFactsInputV1 {
  return rawFactsSchema.decode(parseInput(value));
}

export function decodeArtifactLineageFactBundle(value: ArtifactLineageCodecInput): ArtifactLineageFactBundleV1 {
  const parsed = parseInput(value);
  assertPlainObject(parsed, "$");
  assertExactKeys(parsed, ["claim", "observation", "rawFacts"], "$");
  preflightClaimMirrorBudget(readOwnEnumerableDataProperty(parsed, "claim", "$"), "$.claim");
  return artifactLineageFactBundleSchema.decode(parsed);
}

export function encodeArtifactLineageClaim(value: ArtifactLineageClaimV1): Uint8Array {
  return encodeCanonicalBytes(decodeArtifactLineageClaim(value));
}

export function encodeArtifactLineageObservation(value: ArtifactLineageObservationV1): Uint8Array {
  return encodeCanonicalBytes(artifactLineageObservationSchema.decode(value));
}

export function encodeArtifactLineageRawFacts(value: ArtifactLineageRawFactsInputV1): Uint8Array {
  return encodeCanonicalBytes(rawFactsSchema.decode(value));
}

export function encodeArtifactLineageFactBundle(value: ArtifactLineageFactBundleV1): Uint8Array {
  return encodeCanonicalBytes(decodeArtifactLineageFactBundle(value));
}

export type ArtifactLineageClaimDraft = Omit<ArtifactLineageClaimV1, "claimId">;
export type ArtifactLineageObservationDraft = Omit<ArtifactLineageObservationV1, "observationId" | "payloadHash">;

function copyDraft<T extends object>(value: unknown, fields: readonly string[]): T {
  assertPlainObject(value, "$.draft");
  assertExactKeys(value, fields, "$.draft");
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`draft field ${field} must be an enumerable data property`);
    }
    result[field] = descriptor.value;
  }
  return result as T;
}

export function createArtifactLineageClaim(draft: ArtifactLineageClaimDraft): ArtifactLineageClaimV1 {
  const fields = [
    "schemaVersion", "kind", "artifactRef", "resolverPolicy", "resolutionClaim",
    "retentionLease", "observedStoreEpoch",
  ] as const;
  const copied = copyDraft<ArtifactLineageClaimDraft>(draft, fields);
  preflightClaimMirrorBudget(copied, "$.draft", "payload");
  const payload = claimPayloadSchema.decode(copied);
  const claimId = hashDomain(CLAIM_PAYLOAD_DOMAIN, payload);
  return decodeArtifactLineageClaim({ ...payload, claimId });
}

export function createArtifactLineageObservation(draft: ArtifactLineageObservationDraft): ArtifactLineageObservationV1 {
  const fields = [
    "schemaVersion", "kind", "artifactRefId", "locator", "immutableMirrorLocator", "rawBytes",
    "contentSha256", "byteLength", "mediaType", "schema", "observedStoreEpoch",
  ] as const;
  const copied = copyDraft<ArtifactLineageObservationDraft>(draft, fields);
  const payload = observationPayloadSchema.decode(copied);
  const payloadHash = hashDomain(OBSERVATION_PAYLOAD_DOMAIN, payload);
  const observationId = hashDomain(OBSERVATION_ID_DOMAIN, payloadHash);
  return artifactLineageObservationSchema.decode({ ...payload, observationId, payloadHash });
}

export interface ArtifactLineageObservationFromBytesDraft extends Omit<ArtifactLineageObservationDraft, "rawBytes" | "contentSha256" | "byteLength"> {
  readonly rawBytes: string | null;
}

export function createArtifactLineageObservationFromBytes(
  draft: ArtifactLineageObservationFromBytesDraft,
): ArtifactLineageObservationV1 {
  const fields = [
    "schemaVersion", "kind", "artifactRefId", "locator", "immutableMirrorLocator", "rawBytes",
    "mediaType", "schema", "observedStoreEpoch",
  ] as const;
  const copied = copyDraft<ArtifactLineageObservationFromBytesDraft>(draft, fields);
  const rawBytes = copied.rawBytes === null ? null : decodeArtifactBytes(copied.rawBytes, "$.draft.rawBytes");
  return createArtifactLineageObservation({
    ...copied,
    contentSha256: rawBytes === null ? null : sha256Hex(rawBytes),
    byteLength: rawBytes === null ? null : String(rawBytes.byteLength),
  });
}

export function recomputeArtifactLineageClaimId(value: ArtifactLineageClaimV1): Hash {
  preflightClaimMirrorBudget(value);
  const parsed = claimStructuralSchema.decode(value);
  return hashDomain(CLAIM_PAYLOAD_DOMAIN, payloadWithout(parsed, ["claimId"]));
}

export function recomputeArtifactLineageObservationPayloadHash(value: ArtifactLineageObservationV1): Hash {
  const parsed = observationStructuralSchema.decode(value);
  return hashDomain(OBSERVATION_PAYLOAD_DOMAIN, payloadWithout(parsed, ["observationId", "payloadHash"]));
}

export function recomputeArtifactLineageObservationId(value: ArtifactLineageObservationV1): Hash {
  return hashDomain(OBSERVATION_ID_DOMAIN, recomputeArtifactLineageObservationPayloadHash(value));
}

export type ArtifactLineageReasonCode =
  | "claim-decode-failed"
  | "observation-decode-failed"
  | "raw-shape-invalid"
  | "raw-bytes-missing"
  | "raw-bytes-hostile"
  | "raw-observation-mismatch"
  | "artifact-ref-length-mismatch"
  | "resolution-outcome-mismatch"
  | "locator-mismatch"
  | "object-key-mismatch"
  | "media-mismatch"
  | "schema-mismatch"
  | "lease-subject-mismatch"
  | "lease-out-of-range"
  | "lease-remaining-too-short"
  | "policy-mismatch"
  | "subject-content-mismatch";

export interface ArtifactLineagePredicateResult {
  readonly verdict: ArtifactLineageVerdict;
  readonly reasons: readonly ArtifactLineageReasonCode[];
  readonly claimId: Hash | null;
  readonly observationId: Hash | null;
}

export const artifactLineageSchemaRef = schemaRefOf(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.claim);
