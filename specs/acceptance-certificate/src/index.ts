import {
  arraySchema,
  decodeCanonicalJson,
  defineSchema,
  defineSchemaManifest,
  encodeCanonicalBytes,
  enumSchema,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  literalSchema,
  objectSchema,
  refineSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";

const structuralSchema = objectSchema({
  schemaVersion: literalSchema(1), kind: literalSchema("aloha.acceptance-certificate"),
  certificateId: hashSchema, payloadHash: hashSchema, acceptanceQueryId: hashSchema,
  subjectArtifactRoot: hashSchema, claimSetRoot: hashSchema, observationSetRoot: hashSchema,
  rawArtifactSetRoot: hashSchema, qualificationRegistryRoot: hashSchema,
  externalTrustAnchorRoot: hashSchema, externalIssuerKeySetRoot: hashSchema,
  qualificationRegistryApprovalId: hashSchema, releaseAuthorityApprovalId: hashSchema,
  authorityPinDigest: hashSchema, qualificationAudienceHash: hashSchema,
  releaseRoleManifestRoot: hashSchema, candidateReleaseCommit: gitSha40Schema,
  predicateSpecDigest: hashSchema, predicateProgramDescriptorDigest: hashSchema,
  oracleProgramDescriptorDigest: hashSchema, predicateCompositionLeafDigest: hashSchema,
  predicateCompositionRootDigest: hashSchema, predicateImplementationClosureDigest: hashSchema,
  predicateImplementationExportDigest: hashSchema, oracleImplementationClosureDigest: hashSchema,
  oracleImplementationExportDigest: hashSchema, gateCoreImplementationClosureDigest: hashSchema,
  gateCoreRuntimeClosureDigest: hashSchema, verifierQualificationId: hashSchema,
  observerQualificationIds: arraySchema(hashSchema), signedInvocationAttestationId: hashSchema,
  invocationBindingSetRoot: hashSchema, reasonSetRoot: hashSchema,
  verdict: enumSchema(["pass", "fail", "invalid"] as const),
});

export type AcceptanceCertificateV1 = Infer<typeof structuralSchema>;

function payload(value: AcceptanceCertificateV1): Record<string, unknown> {
  const { certificateId: _certificateId, payloadHash: _payloadHash, ...rest } = value;
  return rest;
}

function payloadHash(value: AcceptanceCertificateV1): Hash {
  return hashDomain("aloha.acceptance-certificate/payload/v1", payload(value));
}

const schema = refineSchema(
  structuralSchema,
  "aloha.acceptance-certificate.refinement.v1",
  hashDomain("aloha/schema-refinement-spec/v1", {
    id: "aloha.acceptance-certificate.refinement.v1",
    version: "1.0.0",
    rules: ["sorted-observer-ids", "payload-hash", "certificate-id"],
  }),
  (value, path) => {
    for (let index = 1; index < value.observerQualificationIds.length; index += 1) {
      if (value.observerQualificationIds[index - 1]! >= value.observerQualificationIds[index]!) {
        throw new TypeError(`observerQualificationIds must be strictly sorted at ${path}`);
      }
    }
    const expectedPayloadHash = payloadHash(value as AcceptanceCertificateV1);
    const expectedCertificateId = hashDomain("aloha.acceptance-certificate/id/v1", expectedPayloadHash);
    if (value.payloadHash !== expectedPayloadHash || value.certificateId !== expectedCertificateId) {
      throw new TypeError(`acceptance certificate identity mismatch at ${path}`);
    }
    return value;
  },
);

export const ACCEPTANCE_CERTIFICATE_SCHEMA_MANIFEST = defineSchemaManifest(
  "aloha.acceptance-certificate", "1.0.0",
  defineSchema({ kind: "aloha.acceptance-certificate-v1", fields: schema.descriptor }, (value, path = "$") => schema.decode(value, path)),
);

function parse(value: string | Uint8Array | object): unknown {
  if (typeof value === "string" || ArrayBuffer.isView(value)) return decodeCanonicalJson(value as string | Uint8Array);
  return value;
}

export function decodeAcceptanceCertificateV1(value: string | Uint8Array | object): AcceptanceCertificateV1 {
  return schema.decode(parse(value));
}

export function acceptanceCertificatePayloadHash(value: AcceptanceCertificateV1): Hash {
  return payloadHash(decodeAcceptanceCertificateV1(value));
}

export function acceptanceCertificateId(value: AcceptanceCertificateV1): Hash {
  return hashDomain("aloha.acceptance-certificate/id/v1", acceptanceCertificatePayloadHash(value));
}

export function encodeAcceptanceCertificateV1(value: AcceptanceCertificateV1): Uint8Array {
  return encodeCanonicalBytes(schema.decode(value));
}

export type AcceptanceCertificateDraftV1 = Omit<AcceptanceCertificateV1, "certificateId" | "payloadHash">;

export function createAcceptanceCertificateV1(draft: AcceptanceCertificateDraftV1): AcceptanceCertificateV1 {
  const intermediate = { ...draft, certificateId: `0x${"0".repeat(64)}`, payloadHash: `0x${"0".repeat(64)}` } as AcceptanceCertificateV1;
  const expectedPayloadHash = payloadHash(intermediate);
  return schema.decode({
    ...intermediate,
    payloadHash: expectedPayloadHash,
    certificateId: hashDomain("aloha.acceptance-certificate/id/v1", expectedPayloadHash),
  });
}
