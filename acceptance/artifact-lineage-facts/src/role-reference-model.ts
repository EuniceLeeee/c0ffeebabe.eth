import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertPlainObject,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

/*
 * Clean-room qualification oracle for the non-raw roles.  It intentionally
 * does not import qualified-facts, core-envelope, GateCore, or the live
 * artifact-lineage predicate.  The qualification runner may use those
 * packages to manufacture wire cases, but this file only re-derives the
 * public wire contract from canonical/hash primitives.
 */

export type RoleOracleVerdict = "pass" | "fail" | "invalid";

export type SidecarOracleReasonCode =
  | "sidecar-decode-failed"
  | "sidecar-identity-mismatch"
  | "sidecar-role-mismatch"
  | "sidecar-facts-mismatch"
  | "sidecar-set-mismatch";

export type InvocationOracleReasonCode =
  | "invocation-decode-failed"
  | "invocation-identity-mismatch"
  | "invocation-role-mismatch"
  | "invocation-key-mismatch"
  | "invocation-time-mismatch"
  | "invocation-signature-mismatch"
  | "invocation-binding-mismatch"
  | "invocation-set-mismatch";

export interface RoleOracleResult<R extends string = string> {
  readonly roleId: R;
  readonly verdict: RoleOracleVerdict;
  readonly reasons: readonly string[];
}

export interface OracleSchemaRef {
  readonly id: string;
  readonly version: string;
  readonly schemaHash: Hash;
}

export interface SidecarOracleMetadata {
  readonly kind: "aloha.acquisition-process-observation" | "aloha.target-process-observation" | "aloha.store-epoch-observation";
  readonly roleId: string;
  readonly observationSchema: OracleSchemaRef;
  readonly observerImplementationDigest: Hash;
  readonly observerQualificationId: Hash;
  readonly qualificationRegistryRoot: Hash;
  readonly anchorPolicyDigest: Hash;
}

export interface SidecarOracleContext {
  readonly metadata: SidecarOracleMetadata;
  readonly expectedCanonicalFacts: Readonly<Record<string, unknown>>;
  readonly expectedObservationIds: readonly Hash[];
  readonly sidecars: readonly unknown[];
}

interface DecodedSidecar {
  readonly schemaVersion: 1;
  readonly kind: SidecarOracleMetadata["kind"];
  readonly observationId: Hash;
  readonly payloadHash: Hash;
  readonly observationSchema: OracleSchemaRef;
  readonly observerImplementationDigest: Hash;
  readonly observerQualificationId: Hash;
  readonly qualificationRegistryRoot: Hash;
  readonly anchorPolicyDigest: Hash;
  readonly roleId: string;
  readonly canonicalFactsHash: Hash;
  readonly canonicalFacts: Readonly<Record<string, unknown>>;
}

function oracleObject(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  assertPlainObject(value, path);
  assertExactKeys(value, keys, path);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = readOwnEnumerableDataProperty(value, key, `${path}.${key}`);
  }
  return result;
}

function oracleSchemaRef(value: unknown, path: string): OracleSchemaRef {
  const object = oracleObject(value, ["id", "version", "schemaHash"], path);
  if (typeof object.id !== "string" || object.id.length === 0 || typeof object.version !== "string" || object.version.length === 0) {
    throw new TypeError(`schema ref invalid at ${path}`);
  }
  return { id: object.id, version: object.version, schemaHash: assertHash(object.schemaHash, `${path}.schemaHash`) };
}

function sidecarDomain(kind: SidecarOracleMetadata["kind"]): string {
  return kind;
}

function decodeSidecar(value: unknown, path: string): DecodedSidecar {
  const object = oracleObject(value, [
    "schemaVersion", "kind", "observationId", "payloadHash", "observationSchema",
    "observerImplementationDigest", "observerQualificationId", "qualificationRegistryRoot",
    "anchorPolicyDigest", "roleId", "canonicalFactsHash", "canonicalFacts",
  ], path);
  if (object.schemaVersion !== 1) throw new TypeError(`sidecar schemaVersion invalid at ${path}`);
  if (object.kind !== "aloha.acquisition-process-observation" && object.kind !== "aloha.target-process-observation" && object.kind !== "aloha.store-epoch-observation") {
    throw new TypeError(`sidecar kind invalid at ${path}`);
  }
  const factsKeys = object.kind === "aloha.store-epoch-observation"
    ? ["storeIdentityHash", "currentStoreEpoch", "rawArtifactRefId"]
    : ["receiptId", "processAnchorHash", "logRangeArtifactRefId", "rawBoundaryArtifactRefId"];
  const facts = oracleObject(object.canonicalFacts, factsKeys, `${path}.canonicalFacts`);
  for (const key of factsKeys) {
    if (key === "currentStoreEpoch") assertDecimalString(facts[key], `${path}.canonicalFacts.${key}`);
    else assertHash(facts[key], `${path}.canonicalFacts.${key}`);
  }
  const decoded: DecodedSidecar = {
    schemaVersion: 1,
    kind: object.kind,
    observationId: assertHash(object.observationId, `${path}.observationId`),
    payloadHash: assertHash(object.payloadHash, `${path}.payloadHash`),
    observationSchema: oracleSchemaRef(object.observationSchema, `${path}.observationSchema`),
    observerImplementationDigest: assertHash(object.observerImplementationDigest, `${path}.observerImplementationDigest`),
    observerQualificationId: assertHash(object.observerQualificationId, `${path}.observerQualificationId`),
    qualificationRegistryRoot: assertHash(object.qualificationRegistryRoot, `${path}.qualificationRegistryRoot`),
    anchorPolicyDigest: assertHash(object.anchorPolicyDigest, `${path}.anchorPolicyDigest`),
    roleId: typeof object.roleId === "string" && object.roleId.length > 0 ? object.roleId : (() => { throw new TypeError(`roleId invalid at ${path}`); })(),
    canonicalFactsHash: assertHash(object.canonicalFactsHash, `${path}.canonicalFactsHash`),
    canonicalFacts: facts,
  };
  const expectedFactsHash = hashDomain("aloha/qualified-observation/canonical-facts/v1", decoded.canonicalFacts);
  if (decoded.canonicalFactsHash !== expectedFactsHash) throw new TypeError(`canonicalFactsHash mismatch at ${path}`);
  const payload = { ...decoded } as Record<string, unknown>;
  delete payload.observationId;
  delete payload.payloadHash;
  delete payload.canonicalFacts;
  payload.canonicalFacts = decoded.canonicalFacts;
  const expectedPayloadHash = hashDomain(`${sidecarDomain(decoded.kind)}/payload/v1`, payload);
  if (decoded.payloadHash !== expectedPayloadHash) throw new TypeError(`payloadHash mismatch at ${path}`);
  if (decoded.observationId !== hashDomain(`${sidecarDomain(decoded.kind)}/id/v1`, expectedPayloadHash)) {
    throw new TypeError(`observationId mismatch at ${path}`);
  }
  return decoded;
}

function sidecarFactsMatch(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  return encodeCanonicalJson(actual) === encodeCanonicalJson(expected);
}

export function evaluateSidecarOracle(
  context: SidecarOracleContext,
): RoleOracleResult {
  const roleId = context.metadata.roleId;
  let decoded: DecodedSidecar;
  try {
    const values = context.sidecars;
    if (!Array.isArray(values) || values.length === 0) throw new TypeError("sidecar set missing");
    const decodedValues = values.map((value, index) => decodeSidecar(value, `$.sidecars[${index}]`));
    const actualIds = decodedValues.map((value) => value.observationId).sort();
    const expectedIds = [...context.expectedObservationIds].sort();
    if (encodeCanonicalJson(actualIds) !== encodeCanonicalJson(expectedIds)) {
      return { roleId, verdict: "invalid", reasons: ["sidecar-set-mismatch"] };
    }
    decoded = decodedValues.find((value) => value.kind === context.metadata.kind) ?? (() => { throw new TypeError("sidecar kind missing"); })();
  } catch {
    return { roleId, verdict: "invalid", reasons: ["sidecar-decode-failed"] };
  }
  if (
    decoded.kind !== context.metadata.kind ||
    decoded.roleId !== context.metadata.roleId ||
    encodeCanonicalJson(decoded.observationSchema) !== encodeCanonicalJson(context.metadata.observationSchema) ||
    decoded.observerImplementationDigest !== context.metadata.observerImplementationDigest ||
    decoded.observerQualificationId !== context.metadata.observerQualificationId ||
    decoded.qualificationRegistryRoot !== context.metadata.qualificationRegistryRoot ||
    decoded.anchorPolicyDigest !== context.metadata.anchorPolicyDigest
  ) {
    return { roleId, verdict: "invalid", reasons: ["sidecar-role-mismatch"] };
  }
  if (!sidecarFactsMatch(decoded.canonicalFacts, context.expectedCanonicalFacts)) {
    return { roleId, verdict: "fail", reasons: ["sidecar-facts-mismatch"] };
  }
  return { roleId, verdict: "pass", reasons: [] };
}

export interface InvocationBindingOracleFacts {
  readonly kind: "semantic-artifact" | "production-receipt";
  readonly objectId: Hash;
  readonly rawArtifactRefId: Hash;
  readonly canonicalBytesSha256: Hash;
  readonly byteLength: string;
  readonly mediaType: string;
  readonly schema: OracleSchemaRef;
  readonly receiptRawArtifactRefIds?: readonly Hash[];
}

export interface InvocationOracleContext {
  readonly roleId: string;
  readonly observationSchema: OracleSchemaRef;
  readonly observerQualificationId: Hash;
  readonly observerImplementationDigest: Hash;
  readonly registryRoot: Hash;
  readonly registryEpoch: string;
  readonly keyId: Hash;
  readonly publicKeyHex: `0x${string}`;
  readonly audienceHash: Hash;
  readonly acceptanceQueryId: Hash;
  readonly qualifiedFactSnapshotId: Hash;
  readonly nowUnixNs: string;
  readonly maxInvocationTtlUnixNs: string;
  readonly expectedIssuedAtUnixNs: string;
  readonly expectedExpiresAtUnixNs: string;
  readonly expectedSemanticArtifactBindings: readonly InvocationBindingOracleFacts[];
  readonly expectedProductionReceiptBindings: readonly InvocationBindingOracleFacts[];
  readonly observedSemanticArtifactBindings?: readonly InvocationBindingOracleFacts[];
  readonly observedProductionReceiptBindings?: readonly InvocationBindingOracleFacts[];
  readonly subjectInputArtifactRefIds: readonly Hash[];
  readonly expectedObservationIds?: readonly Hash[];
  readonly revoked?: boolean;
  readonly keyEpochValid?: boolean;
  readonly observerLocatorCapable?: boolean;
}

interface DecodedBinding {
  readonly kind: "semantic-artifact" | "production-receipt";
  readonly objectId: Hash;
  readonly rawArtifactRefId: Hash;
  readonly canonicalBytesSha256: Hash;
  readonly byteLength: string;
}

interface DecodedInvocation {
  readonly schemaVersion: 1;
  readonly kind: "aloha.signed-observer-invocation-snapshot";
  readonly signatureAlgorithm: "ed25519";
  readonly attestationId: Hash;
  readonly payloadHash: Hash;
  readonly registryRoot: Hash;
  readonly registryEpoch: string;
  readonly observerQualificationId: Hash;
  readonly roleId: string;
  readonly keyId: Hash;
  readonly audienceHash: Hash;
  readonly invocationNonce: Hash;
  readonly issuedAtUnixNs: string;
  readonly expiresAtUnixNs: string;
  readonly acceptanceQueryId: Hash;
  readonly qualifiedFactSnapshotId: Hash;
  readonly semanticArtifactBindings: readonly DecodedBinding[];
  readonly semanticArtifactSetRoot: Hash;
  readonly productionReceiptBindings: readonly DecodedBinding[];
  readonly productionReceiptSetRoot: Hash;
  readonly bindingSetRoot: Hash;
  readonly signatureHex: string;
}

function decodeBinding(value: unknown, path: string): DecodedBinding {
  const object = oracleObject(value, ["kind", "objectId", "rawArtifactRefId", "canonicalBytesSha256", "byteLength"], path);
  if (object.kind !== "semantic-artifact" && object.kind !== "production-receipt") throw new TypeError(`binding kind invalid at ${path}`);
  return {
    kind: object.kind,
    objectId: assertHash(object.objectId, `${path}.objectId`),
    rawArtifactRefId: assertHash(object.rawArtifactRefId, `${path}.rawArtifactRefId`),
    canonicalBytesSha256: assertHash(object.canonicalBytesSha256, `${path}.canonicalBytesSha256`),
    byteLength: assertDecimalString(object.byteLength, `${path}.byteLength`),
  };
}

function decodeInvocation(value: unknown): DecodedInvocation {
  const keys = [
    "schemaVersion", "kind", "attestationId", "payloadHash", "registryRoot", "registryEpoch",
    "observerQualificationId", "roleId", "keyId", "audienceHash", "invocationNonce",
    "issuedAtUnixNs", "expiresAtUnixNs", "acceptanceQueryId", "qualifiedFactSnapshotId",
    "semanticArtifactBindings", "semanticArtifactSetRoot", "productionReceiptBindings",
    "productionReceiptSetRoot", "bindingSetRoot", "signatureAlgorithm", "signatureHex",
  ] as const;
  const object = oracleObject(value, keys, "$.invocation");
  if (object.schemaVersion !== 1 || object.kind !== "aloha.signed-observer-invocation-snapshot" || object.signatureAlgorithm !== "ed25519") throw new TypeError("invocation literal mismatch");
  if (!Array.isArray(object.semanticArtifactBindings) || !Array.isArray(object.productionReceiptBindings)) throw new TypeError("invocation bindings invalid");
  if (typeof object.roleId !== "string" || object.roleId.length === 0 || typeof object.signatureHex !== "string" || !/^0x[0-9a-f]{128}$/.test(object.signatureHex)) throw new TypeError("invocation string field invalid");
  const issuedAtUnixNs = assertDecimalString(object.issuedAtUnixNs, "$.invocation.issuedAtUnixNs");
  const expiresAtUnixNs = assertDecimalString(object.expiresAtUnixNs, "$.invocation.expiresAtUnixNs");
  if (BigInt(issuedAtUnixNs) >= BigInt(expiresAtUnixNs)) throw new TypeError("invocation interval invalid");
  return {
    schemaVersion: 1,
    kind: "aloha.signed-observer-invocation-snapshot",
    signatureAlgorithm: "ed25519",
    attestationId: assertHash(object.attestationId, "$.invocation.attestationId"),
    payloadHash: assertHash(object.payloadHash, "$.invocation.payloadHash"),
    registryRoot: assertHash(object.registryRoot, "$.invocation.registryRoot"),
    registryEpoch: assertDecimalString(object.registryEpoch, "$.invocation.registryEpoch"),
    observerQualificationId: assertHash(object.observerQualificationId, "$.invocation.observerQualificationId"),
    roleId: object.roleId,
    keyId: assertHash(object.keyId, "$.invocation.keyId"),
    audienceHash: assertHash(object.audienceHash, "$.invocation.audienceHash"),
    invocationNonce: assertHash(object.invocationNonce, "$.invocation.invocationNonce"),
    issuedAtUnixNs,
    expiresAtUnixNs,
    acceptanceQueryId: assertHash(object.acceptanceQueryId, "$.invocation.acceptanceQueryId"),
    qualifiedFactSnapshotId: assertHash(object.qualifiedFactSnapshotId, "$.invocation.qualifiedFactSnapshotId"),
    semanticArtifactBindings: object.semanticArtifactBindings.map((entry, index) => decodeBinding(entry, `$.invocation.semanticArtifactBindings[${index}]`)),
    semanticArtifactSetRoot: assertHash(object.semanticArtifactSetRoot, "$.invocation.semanticArtifactSetRoot"),
    productionReceiptBindings: object.productionReceiptBindings.map((entry, index) => decodeBinding(entry, `$.invocation.productionReceiptBindings[${index}]`)),
    productionReceiptSetRoot: assertHash(object.productionReceiptSetRoot, "$.invocation.productionReceiptSetRoot"),
    bindingSetRoot: assertHash(object.bindingSetRoot, "$.invocation.bindingSetRoot"),
    signatureHex: object.signatureHex,
  };
}

function bindingRoot(domain: string, bindings: readonly DecodedBinding[]): Hash {
  return hashDomain(domain, bindings);
}

function invocationSigningBytes(value: DecodedInvocation): Uint8Array {
  return encodeCanonicalBytes({
    domain: "aloha/signed-observer-invocation",
    version: 1,
    keyId: value.keyId,
    registryRoot: value.registryRoot,
    payloadHash: value.payloadHash,
  });
}

function publicKey(publicKeyHex: `0x${string}`): ReturnType<typeof createPublicKey> {
  if (!/^0x[0-9a-f]{64}$/.test(publicKeyHex)) throw new TypeError("public key invalid");
  const prefix = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
  const bytes = new Uint8Array(publicKeyHex.slice(2).match(/../g)!.map((part) => Number.parseInt(part, 16)));
  return createPublicKey({ key: Buffer.from([...prefix, ...bytes]), format: "der", type: "spki" });
}

function sortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) if (values[index - 1]! >= values[index]!) return false;
  return true;
}

function sameBindings(actual: readonly DecodedBinding[], expected: readonly InvocationBindingOracleFacts[]): boolean {
  return encodeCanonicalJson(actual) === encodeCanonicalJson(expected.map(({ mediaType: _mediaType, schema: _schema, receiptRawArtifactRefIds: _receiptRawArtifactRefIds, ...binding }) => binding));
}

function sameBindingFacts(actual: readonly DecodedBinding[], expected: readonly InvocationBindingOracleFacts[]): boolean {
  return sameBindings(actual, expected) && expected.every((fact) => fact.mediaType.length > 0 && fact.schema.id.length > 0);
}

function sameBindingMetadata(actual: readonly InvocationBindingOracleFacts[], expected: readonly InvocationBindingOracleFacts[]): boolean {
  return actual.length === expected.length && actual.every((fact, index) => {
    const expectedFact = expected[index]!;
    return fact.mediaType === expectedFact.mediaType && encodeCanonicalJson(fact.schema) === encodeCanonicalJson(expectedFact.schema);
  });
}

export function evaluateInvocationOracle(
  snapshotValue: unknown,
  context: InvocationOracleContext,
): RoleOracleResult {
  const roleId = context.roleId;
  let snapshot: DecodedInvocation;
  try {
    snapshot = decodeInvocation(snapshotValue);
  } catch {
    return { roleId, verdict: "invalid", reasons: ["invocation-decode-failed"] };
  }
  const allBindings = [...snapshot.semanticArtifactBindings, ...snapshot.productionReceiptBindings];
  const expectedAll = [...context.expectedSemanticArtifactBindings, ...context.expectedProductionReceiptBindings];
  const structuralMismatch =
    snapshot.registryRoot !== context.registryRoot ||
    snapshot.registryEpoch !== context.registryEpoch ||
    snapshot.observerQualificationId !== context.observerQualificationId ||
    snapshot.roleId !== context.roleId ||
    snapshot.keyId !== context.keyId ||
    snapshot.audienceHash !== context.audienceHash ||
    snapshot.acceptanceQueryId !== context.acceptanceQueryId ||
    snapshot.qualifiedFactSnapshotId !== context.qualifiedFactSnapshotId;
  if (structuralMismatch) return { roleId, verdict: "invalid", reasons: ["invocation-identity-mismatch"] };
  if (context.revoked || context.keyEpochValid === false || context.observerLocatorCapable === false) {
    return { roleId, verdict: "invalid", reasons: ["invocation-key-mismatch"] };
  }
  if (snapshot.invocationNonce === `0x${"0".repeat(64)}` || snapshot.issuedAtUnixNs !== context.expectedIssuedAtUnixNs || snapshot.expiresAtUnixNs !== context.expectedExpiresAtUnixNs) {
    return { roleId, verdict: "invalid", reasons: ["invocation-time-mismatch"] };
  }
  try {
    const now = BigInt(context.nowUnixNs);
    const issued = BigInt(snapshot.issuedAtUnixNs);
    const expires = BigInt(snapshot.expiresAtUnixNs);
    if (now < issued || now >= expires || expires - issued > BigInt(context.maxInvocationTtlUnixNs)) return { roleId, verdict: "invalid", reasons: ["invocation-time-mismatch"] };
  } catch {
    return { roleId, verdict: "invalid", reasons: ["invocation-time-mismatch"] };
  }
  const payload = { ...snapshot } as Record<string, unknown>;
  delete payload.attestationId;
  delete payload.payloadHash;
  delete payload.signatureHex;
  const expectedPayloadHash = hashDomain("aloha.signed-observer-invocation-snapshot/payload/v1", payload);
  const expectedAttestationId = hashDomain("aloha/signed-observer-invocation-snapshot/id/v1", { payloadHash: expectedPayloadHash, signatureHex: snapshot.signatureHex });
  if (snapshot.payloadHash !== expectedPayloadHash || snapshot.attestationId !== expectedAttestationId) return { roleId, verdict: "invalid", reasons: ["invocation-identity-mismatch"] };
  const semanticRoot = bindingRoot("aloha/signed-observer-invocation-snapshot/semantic-artifact-set/v1", snapshot.semanticArtifactBindings);
  const receiptRoot = bindingRoot("aloha/signed-observer-invocation-snapshot/production-receipt-set/v1", snapshot.productionReceiptBindings);
  const combinedRoot = hashDomain("aloha/signed-observer-invocation-snapshot/binding-set/v1", { semanticArtifactSetRoot: semanticRoot, productionReceiptSetRoot: receiptRoot });
  if (snapshot.semanticArtifactSetRoot !== semanticRoot || snapshot.productionReceiptSetRoot !== receiptRoot || snapshot.bindingSetRoot !== combinedRoot) return { roleId, verdict: "invalid", reasons: ["invocation-binding-mismatch"] };
  if (!sortedUnique(snapshot.semanticArtifactBindings.map((binding) => binding.objectId)) || !sortedUnique(snapshot.productionReceiptBindings.map((binding) => binding.objectId))) return { roleId, verdict: "invalid", reasons: ["invocation-set-mismatch"] };
  if (new Set(allBindings.map((binding) => binding.rawArtifactRefId)).size !== allBindings.length || !sameBindings(snapshot.semanticArtifactBindings, context.expectedSemanticArtifactBindings) || !sameBindings(snapshot.productionReceiptBindings, context.expectedProductionReceiptBindings)) return { roleId, verdict: "invalid", reasons: ["invocation-binding-mismatch"] };
  const observedSemantic = context.observedSemanticArtifactBindings ?? context.expectedSemanticArtifactBindings;
  const observedProduction = context.observedProductionReceiptBindings ?? context.expectedProductionReceiptBindings;
  if (!sameBindingFacts(snapshot.semanticArtifactBindings, observedSemantic) || !sameBindingFacts(snapshot.productionReceiptBindings, observedProduction) || !sameBindingMetadata(observedSemantic, context.expectedSemanticArtifactBindings) || !sameBindingMetadata(observedProduction, context.expectedProductionReceiptBindings)) return { roleId, verdict: "fail", reasons: ["invocation-binding-mismatch"] };
  const signedRawRefs = new Set(allBindings.map((binding) => binding.rawArtifactRefId));
  if (context.subjectInputArtifactRefIds.some((refId) => signedRawRefs.has(refId))) return { roleId, verdict: "invalid", reasons: ["invocation-binding-mismatch"] };
  for (const binding of observedProduction) {
    if (binding.receiptRawArtifactRefIds?.some((refId) => signedRawRefs.has(refId))) return { roleId, verdict: "invalid", reasons: ["invocation-binding-mismatch"] };
  }
  try {
    const signature = Buffer.from(snapshot.signatureHex.slice(2), "hex");
    if (!verifySignature(null, invocationSigningBytes(snapshot), publicKey(context.publicKeyHex), signature)) return { roleId, verdict: "invalid", reasons: ["invocation-signature-mismatch"] };
  } catch {
    return { roleId, verdict: "invalid", reasons: ["invocation-signature-mismatch"] };
  }
  return { roleId, verdict: "pass", reasons: [] };
}
