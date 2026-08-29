import { types as nodeTypes } from "node:util";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { resolveSixStepReferenceValuationOracle } from "./composition/reference-valuation-oracle-composition.ts";

export type SixStepReferenceVerdict = "pass" | "fail" | "invalid";

export interface SixStepReferenceEvidenceV1 {
  readonly facts: readonly unknown[];
  readonly refs: readonly OracleReadOnlyArtifactRefV1[];
  readonly claims: readonly OracleArtifactResolutionClaimV1[];
  readonly policies: readonly OracleResolverPolicyV1[];
  readonly leases: readonly OracleRetentionLeaseReceiptV1[];
  readonly observations: readonly {
    readonly observationId: string;
    readonly rawArtifactRefs: readonly OracleReadOnlyArtifactRefV1[];
    readonly observedClaimIds: readonly string[];
  }[];
}

export interface SixStepReferenceInputV1 {
  readonly events: readonly OracleEvidenceEventV1[];
  readonly semanticArtifacts: readonly OracleSemanticArtifactV1[];
  readonly productionReceipts: readonly OracleProductionReceiptV1[];
  readonly stageFacts: readonly OracleSixStepStageFactsV1[];
  readonly evidence: SixStepReferenceEvidenceV1;
  readonly economicEvaluatorBinding: Readonly<{
    readonly schemaVersion: 1;
    readonly kind: "aloha.six-step-economic-evaluator-binding-observation-v1";
    readonly runtimeBindingId: Hash;
    readonly candidateReleaseCommit: string;
    readonly releaseProvenanceHash: Hash;
    readonly authorityRoot: Hash;
    readonly implementationHash: Hash;
    readonly policyRoot: Hash;
    readonly evaluatorExportIdentityHash: Hash;
    readonly objectiveTemplates: readonly unknown[];
    readonly actionOwners: readonly unknown[];
    readonly valuationOwners: readonly unknown[];
    readonly executorQualification: unknown;
    readonly safetyProfile: unknown;
    readonly observationRoot: Hash;
  }>;
}

export interface SixStepReferenceResultV1 {
  readonly verdict: SixStepReferenceVerdict;
  readonly reasons: readonly string[];
}

// These bounds are deliberately owned by this qualification oracle. Keeping
// them literal in this module makes the oracle compiler closure bind the wire
// contract without importing the production artifact-bytes codec.
const ORACLE_ARTIFACT_CHUNK_BYTES = 65_534;
const ORACLE_ARTIFACT_INLINE_BYTES = 500_000;
const ORACLE_ARTIFACT_KIND = "aloha.canonical-artifact-bytes";
const ORACLE_ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF = hashDomain(
  "aloha/economic-safety/revm-observation-schema-ref/v1",
  {
    workerReceipt: "aloha.qualified-final-simulation-owner-facts-v1",
    effects: "aloha.revm-effect-observation-v1",
    source: "canonical-current-source-v1",
  } as unknown as CanonicalJson,
);
const ORACLE_DECIMAL_MAX_DIGITS = 128;
const ORACLE_STRING_MAX_CODE_UNITS = 131_072;
const ORACLE_STAGE_IDS = Object.freeze([
  "universe_instance", "edge_ready_generation", "planner_consumption",
  "current_source_exact", "execution_program", "final_simulation",
] as const);
const ORACLE_STAGE_FACTS_SCHEMA_REF = Object.freeze({
  id: "aloha.six-step-stage-facts",
  version: "1.0.0",
  schemaHash: "0xc181ce3b534bd99bffad387e0998533146e8eebaa7778c7469d539dc97872eb0" as Hash,
});
const ORACLE_STAGE_INPUT_SCHEMA_REF = Object.freeze({
  id: "aloha.six-step-stage-input",
  version: "1.0.0",
  schemaHash: "0x37de1e1df9e21c45c20c58f81305c72ded7645bfb9dce84a1c1d478ee8801e11" as Hash,
});

interface OracleSchemaRefV1 {
  readonly id: string;
  readonly version: string;
  readonly schemaHash: Hash;
}

type OracleLocatorV1 =
  | Readonly<{ kind: "file-range"; systemId: string; bootIdHash: Hash; device: string; inode: string; startInclusive: string; endExclusive: string }>
  | Readonly<{ kind: "checkpoint-record"; storeIdentityHash: Hash; namespaceHash: Hash; keyHash: Hash; revision: string; recordHash: Hash }>
  | Readonly<{ kind: "chain-object"; chainId: string; blockNumber: string; blockHash: Hash; objectKind: "header" | "transaction" | "receipt" | "state-proof" | "logs"; objectKeyHash: Hash }>
  | Readonly<{ kind: "content-object"; storeIdentityHash: Hash; objectKey: Hash }>
  | Readonly<{ kind: "json-pointer"; parentLocatorId: Hash; pointer: string }>;

interface OracleReadOnlyArtifactRefV1 {
  readonly artifactRefId: Hash;
  readonly locatorId: Hash;
  readonly locator: OracleLocatorV1;
  readonly immutableMirrorLocatorId: Hash;
  readonly immutableMirrorLocator: Extract<OracleLocatorV1, { readonly kind: "content-object" }>;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly mediaType: string;
  readonly schema: OracleSchemaRefV1 | null;
  readonly resolverPolicyHash: Hash;
  readonly retentionLeaseReceiptId: Hash;
}

interface OracleProcessAnchorV1 {
  readonly systemId: string;
  readonly commitSha: string;
  readonly executableHash: Hash;
  readonly deploymentManifestHash: Hash;
  readonly serviceIdentityHash: Hash;
  readonly pid: string;
  readonly processStartTicks: string;
  readonly bootIdHash: Hash;
}

interface OracleSemanticArtifactV1 {
  readonly schema: OracleSchemaRefV1;
  readonly artifactId: Hash;
  readonly inputArtifactIds: readonly Hash[];
  readonly dependencyClosureRoot: Hash;
  readonly canonicalPayloadHash: Hash;
}

interface OracleProductionReceiptV1 {
  readonly receiptId: Hash;
  readonly artifactId: Hash;
  readonly producer: OracleProcessAnchorV1;
  readonly logRangeArtifactRef: OracleReadOnlyArtifactRefV1;
  readonly sourceAnchorHash: Hash;
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
  readonly durationUs: string;
  readonly rawBoundaryArtifactRef: OracleReadOnlyArtifactRefV1;
  readonly semanticConfigDigest: Hash;
  readonly resourceMetricsHash: Hash;
}

interface OracleWitnessV1 { readonly artifactRefId: Hash; readonly contentRoot: Hash }
interface OracleRouteBindingV1 {
  readonly edgeId: Hash;
  readonly instanceKey: string;
  readonly stage1EventId: Hash;
  readonly stage2EventId: Hash;
  readonly instancePublicationRoot: Hash;
}
interface OracleSourceAnchorV1 { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }
interface OracleCutoffV1 { readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }

type OracleSixStepStageFactsV1 =
  | Readonly<{ schemaVersion: 1; kind: "aloha.six-step-stage-facts"; stageId: "universe_instance"; candidatePartition: OracleWitnessV1; instancePublication: OracleWitnessV1; identityProof: OracleWitnessV1; sourceCoverage: OracleWitnessV1 }>
  | Readonly<{ schemaVersion: 1; kind: "aloha.six-step-stage-facts"; stageId: "edge_ready_generation"; instancePublication: OracleWitnessV1; edge: OracleWitnessV1; coverage: OracleWitnessV1; promotionRevision: string; generationId: string; attestationMode: "fresh" | "memo-reuse"; memoReuseProof: OracleWitnessV1 }>
  | Readonly<{ schemaVersion: 1; kind: "aloha.six-step-stage-facts"; stageId: "planner_consumption"; orderedInstanceBindings: readonly OracleRouteBindingV1[]; orderedInstanceBindingsRoot: Hash; routeSet: OracleWitnessV1; coarseProjection: OracleWitnessV1; admissionReceipt: OracleWitnessV1; admissionClass: "ranked" | "bounded-unranked" }>
  | Readonly<{ schemaVersion: 1; kind: "aloha.six-step-stage-facts"; stageId: "current_source_exact"; currentSource: OracleSourceAnchorV1; exactOutput: OracleWitnessV1; fallback: false }>
  | Readonly<{ schemaVersion: 1; kind: "aloha.six-step-stage-facts"; stageId: "execution_program"; program: OracleWitnessV1; callerMode: string; preCalls: OracleWitnessV1; observationPairs: OracleWitnessV1; actionOwner: OracleWitnessV1; fallback: false }>
  | Readonly<{ schemaVersion: 1; kind: "aloha.six-step-stage-facts"; stageId: "final_simulation"; finalSimulationReceipt: OracleWitnessV1; simulationSourceAnchor: OracleSourceAnchorV1; economicReceipt: OracleWitnessV1; safetyReceipt: OracleWitnessV1; dryRun: true }>;

interface OracleEvidenceEventV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.fact-evidence-event";
  readonly eventId: Hash;
  readonly source: Readonly<{ systemId: string; emitterKind: "native" | "read-only-adapter"; emitterCodeHash: Hash; rawBoundaryArtifactRef: OracleReadOnlyArtifactRefV1 }>;
  readonly runtime: Readonly<{ commitSha: string; executableHash: Hash; deploymentManifestHash: Hash; serviceIdentityHash: Hash; pid: string; processStartTicks: string; bootIdHash: Hash; logRangeArtifactRefId: Hash }>;
  readonly artifactLineage: Readonly<{ inputArtifactIds: readonly Hash[]; outputArtifactId: Hash; productionReceiptId: Hash }>;
  readonly scope:
    | Readonly<{ kind: "builder-run"; builderRunId: string; producerSessionId: null; generationId: null; generationRefreshPolicyHash: Hash }>
    | Readonly<{ kind: "ready-generation"; builderRunId: string; producerSessionId: null; generationId: string; generationRefreshPolicyHash: Hash }>
    | Readonly<{ kind: "producer-session"; builderRunId: string; producerSessionId: string; generationId: string; generationRefreshPolicyHash: Hash }>;
  readonly correlationId: string;
  readonly runSequence: string;
  readonly cutoff: OracleCutoffV1;
  readonly definitionCatalogRoot: Hash;
  readonly strategyCatalogRoot: Hash | null;
  readonly instanceCatalogRoot: Hash | null;
  readonly graphRoot: Hash | null;
  readonly familyId: string;
  readonly candidateKey: string;
  readonly familyDefinitionHash: Hash;
  readonly capabilities: readonly Readonly<{ capabilityId: string; version: string; schemaHash: Hash; interpreterHash: Hash }>[];
  readonly capabilitySetHash: Hash;
  readonly instanceKey: string | null;
  readonly stage: Readonly<{ ordinal: 1 | 2 | 3 | 4 | 5 | 6; id: (typeof ORACLE_STAGE_IDS)[number]; version: 1 }>;
  readonly parentEventIds: readonly Hash[];
  readonly parentOutputHashes: readonly Hash[];
  readonly inputSchema: OracleSchemaRefV1;
  readonly inputs: Readonly<Record<string, CanonicalJson>>;
  readonly inputHash: Hash;
  readonly factSchema: OracleSchemaRefV1;
  readonly facts: Readonly<Record<string, CanonicalJson>>;
  readonly outputHash: Hash;
  readonly outcome: "verified" | "success" | "chain_proven_rejected" | "retryable" | "invalid_program" | "policy_rejected" | "simulation_reverted" | "failed_closed";
  readonly reasonCode: OracleReasonCode | null;
  readonly latency: Readonly<{ startedMonotonicNs: string; finishedMonotonicNs: string; durationUs: string }>;
  readonly extensions: readonly Readonly<{ schema: OracleSchemaRefV1; value: CanonicalJson }>[];
}

interface OracleArtifactBytesV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.canonical-artifact-bytes";
  readonly byteLength: string;
  readonly contentSha256: Hash;
  readonly chunks: readonly { readonly index: string; readonly bytes: string }[];
}

interface OracleObservedImmutableMirrorV1 {
  readonly storeIdentityHash: Hash;
  readonly objectKey: Hash;
  readonly bytes: OracleArtifactBytesV1;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly mediaType: string;
  readonly schema: OracleSchemaRefV1 | null;
}

interface OracleArtifactResolutionClaimV1 {
  readonly claimId: Hash;
  readonly artifactRefId: Hash;
  readonly resolverPolicyHash: Hash;
  readonly observedMirror: OracleObservedImmutableMirrorV1 | null;
  readonly outcome: "content-observed" | "missing" | "content-mismatch";
}

interface OracleResolverPolicyV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.artifact-resolver-policy";
  readonly policyHash: Hash;
  readonly allowedLocatorKind: "content-object";
  readonly digestAlgorithm: "sha256";
  readonly maxByteLength: string;
  readonly requireExactLengthMediaAndSchema: true;
  readonly minimumRemainingStoreEpochs: string;
  readonly failureOutcome: "invalid";
}

interface OracleRetentionLeaseReceiptV1 {
  readonly receiptId: Hash;
  readonly storeIdentityHash: Hash;
  readonly objectKey: Hash;
  readonly contentSha256: Hash;
  readonly validFromStoreEpoch: string;
  readonly validThroughStoreEpoch: string;
  readonly issuerId: string;
  readonly issuerQualificationId: Hash;
  readonly qualificationRegistryRoot: Hash;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new TypeError(`expected plain object at ${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`expected plain object at ${path}`);
  }
  const expected = new Set(expectedKeys);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size
    || keys.some(key => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError(`expected exact object shape at ${path}`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`expected enumerable data property at ${path}.${key}`);
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function dataField(record: Readonly<Record<string, unknown>>, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`expected enumerable data property at ${path}.${key}`);
  }
  return descriptor.value;
}

/** Independent exact decoder used only by the qualification reference model. */
function decodeOracleArtifactBytes(value: unknown, path = "$"): Uint8Array {
  const envelope = exactDataRecord(
    value,
    ["schemaVersion", "kind", "byteLength", "contentSha256", "chunks"],
    path,
  );
  if (dataField(envelope, "schemaVersion", path) !== 1
    || dataField(envelope, "kind", path) !== ORACLE_ARTIFACT_KIND) {
    throw new TypeError(`invalid artifact byte envelope at ${path}`);
  }
  const byteLengthValue = dataField(envelope, "byteLength", path);
  if (typeof byteLengthValue !== "string" || byteLengthValue.length > 6
    || !/^(?:0|[1-9]\d*)$/.test(byteLengthValue)) {
    throw new TypeError(`invalid artifact byteLength at ${path}.byteLength`);
  }
  const declaredByteLength = BigInt(byteLengthValue);
  if (declaredByteLength > BigInt(ORACLE_ARTIFACT_INLINE_BYTES)) {
    throw new TypeError(`artifact bytes exceed oracle resource bound at ${path}.byteLength`);
  }
  const contentSha256 = dataField(envelope, "contentSha256", path);
  if (typeof contentSha256 !== "string" || !/^0x[0-9a-f]{64}$/.test(contentSha256)) {
    throw new TypeError(`invalid artifact content hash at ${path}.contentSha256`);
  }
  const chunks = dataField(envelope, "chunks", path);
  if (!Array.isArray(chunks) || nodeTypes.isProxy(chunks)) {
    throw new TypeError(`expected concrete chunk array at ${path}.chunks`);
  }
  const expectedChunkCount = declaredByteLength === 0n ? 0 : Number(
    (declaredByteLength + BigInt(ORACLE_ARTIFACT_CHUNK_BYTES) - 1n)
      / BigInt(ORACLE_ARTIFACT_CHUNK_BYTES),
  );
  const lengthDescriptor = Object.getOwnPropertyDescriptor(chunks, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || lengthDescriptor.value !== expectedChunkCount) {
    throw new TypeError(`invalid chunk cardinality at ${path}.chunks`);
  }
  const chunkKeys = Reflect.ownKeys(chunks);
  if (chunkKeys.length !== expectedChunkCount + 1
    || chunkKeys.some(key => key !== "length" && (typeof key !== "string"
      || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= expectedChunkCount))) {
    throw new TypeError(`sparse or extended chunk array at ${path}.chunks`);
  }

  let preflightByteLength = 0;
  for (let position = 0; position < expectedChunkCount; position += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(chunks, String(position));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`invalid chunk entry at ${path}.chunks[${position}]`);
    }
    const chunk = exactDataRecord(descriptor.value, ["index", "bytes"], `${path}.chunks[${position}]`);
    const index = dataField(chunk, "index", `${path}.chunks[${position}]`);
    const bytes = dataField(chunk, "bytes", `${path}.chunks[${position}]`);
    if (index !== String(position) || typeof bytes !== "string") {
      throw new TypeError(`invalid canonical chunk at ${path}.chunks[${position}]`);
    }
    const encodedLength = bytes.length;
    if (encodedLength < 2 || encodedLength > 2 + ORACLE_ARTIFACT_CHUNK_BYTES * 2
      || !/^0x(?:[0-9a-f]{2})*$/.test(bytes)) {
      throw new TypeError(`invalid chunk bytes at ${path}.chunks[${position}].bytes`);
    }
    const chunkByteLength = (encodedLength - 2) / 2;
    const final = position === expectedChunkCount - 1;
    if ((!final && chunkByteLength !== ORACLE_ARTIFACT_CHUNK_BYTES)
      || (final && (chunkByteLength === 0 || chunkByteLength > ORACLE_ARTIFACT_CHUNK_BYTES))) {
      throw new TypeError(`non-canonical chunk length at ${path}.chunks[${position}].bytes`);
    }
    preflightByteLength += chunkByteLength;
    if (preflightByteLength > ORACLE_ARTIFACT_INLINE_BYTES) {
      throw new TypeError(`artifact bytes exceed oracle resource bound at ${path}.chunks`);
    }
  }
  if (BigInt(preflightByteLength) !== declaredByteLength) {
    throw new TypeError(`artifact chunk length mismatch at ${path}.byteLength`);
  }

  const output = new Uint8Array(preflightByteLength);
  let offset = 0;
  for (let position = 0; position < expectedChunkCount; position += 1) {
    const chunkDescriptor = Object.getOwnPropertyDescriptor(chunks, String(position))!;
    const chunk = chunkDescriptor.value as Readonly<Record<string, unknown>>;
    const encoded = dataField(chunk, "bytes", `${path}.chunks[${position}]`) as string;
    for (let index = 2; index < encoded.length; index += 2) {
      output[offset++] = Number.parseInt(encoded.slice(index, index + 2), 16);
    }
  }
  if (sha256Hex(output) !== contentSha256) {
    throw new TypeError(`artifact content hash mismatch at ${path}.contentSha256`);
  }
  return output;
}

function oracleHash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`expected hash at ${path}`);
  }
  return value as Hash;
}

function oracleDecimal(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > ORACLE_DECIMAL_MAX_DIGITS
    || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`expected canonical decimal at ${path}`);
  }
  return value;
}

function oracleString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ORACLE_STRING_MAX_CODE_UNITS) {
    throw new TypeError(`expected bounded non-empty string at ${path}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20) throw new TypeError(`control character at ${path}`);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`unpaired surrogate at ${path}`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`unpaired surrogate at ${path}`);
    }
  }
  return value;
}

function oracleGitSha40(value: unknown, path: string): string {
  const decoded = oracleString(value, path);
  if (!/^[0-9a-f]{40}$/.test(decoded)) throw new TypeError(`expected git sha at ${path}`);
  return decoded;
}

function oracleLiteral<T extends string | number | boolean | null>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new TypeError(`expected literal at ${path}`);
  return expected;
}

function decodeOracleArray<T>(value: unknown, decode: (entry: unknown, path: string) => T, path: string): readonly T[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) throw new TypeError(`expected concrete array at ${path}`);
  const length = value.length;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some(key => key !== "length" && (typeof key !== "string"
    || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw new TypeError(`expected dense exact array at ${path}`);
  const output: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`invalid entry at ${path}[${index}]`);
    output.push(decode(descriptor.value, `${path}[${index}]`));
  }
  return Object.freeze(output);
}

function decodeOracleCanonicalValue(value: unknown, path: string): CanonicalJson {
  try {
    encodeCanonicalJson(value);
  } catch {
    throw new TypeError(`expected canonical value at ${path}`);
  }
  return value as CanonicalJson;
}

function decodeOracleCanonicalObject(value: unknown, path: string): Readonly<Record<string, CanonicalJson>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) throw new TypeError(`expected canonical object at ${path}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`expected plain object at ${path}`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`symbol key at ${path}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`non-data property at ${path}.${key}`);
  }
  decodeOracleCanonicalValue(value, path);
  return value as Readonly<Record<string, CanonicalJson>>;
}

function decodeOracleLocator(value: unknown, path: string): OracleLocatorV1 {
  if (value === null || typeof value !== "object") throw new TypeError(`expected locator at ${path}`);
  const ownStringKeys = Reflect.ownKeys(value).filter((key): key is string => typeof key === "string");
  const probe = exactDataRecord(value, ownStringKeys, path);
  const kind = dataField(probe, "kind", path);
  switch (kind) {
    case "file-range": {
      const record = exactDataRecord(value, ["kind", "systemId", "bootIdHash", "device", "inode", "startInclusive", "endExclusive"], path);
      const startInclusive = oracleDecimal(dataField(record, "startInclusive", path), `${path}.startInclusive`);
      const endExclusive = oracleDecimal(dataField(record, "endExclusive", path), `${path}.endExclusive`);
      if (BigInt(endExclusive) < BigInt(startInclusive)) throw new TypeError(`reversed file range at ${path}`);
      return Object.freeze({ kind, systemId: oracleString(dataField(record, "systemId", path), `${path}.systemId`), bootIdHash: oracleHash(dataField(record, "bootIdHash", path), `${path}.bootIdHash`), device: oracleDecimal(dataField(record, "device", path), `${path}.device`), inode: oracleDecimal(dataField(record, "inode", path), `${path}.inode`), startInclusive, endExclusive });
    }
    case "checkpoint-record": {
      const record = exactDataRecord(value, ["kind", "storeIdentityHash", "namespaceHash", "keyHash", "revision", "recordHash"], path);
      return Object.freeze({ kind, storeIdentityHash: oracleHash(dataField(record, "storeIdentityHash", path), `${path}.storeIdentityHash`), namespaceHash: oracleHash(dataField(record, "namespaceHash", path), `${path}.namespaceHash`), keyHash: oracleHash(dataField(record, "keyHash", path), `${path}.keyHash`), revision: oracleDecimal(dataField(record, "revision", path), `${path}.revision`), recordHash: oracleHash(dataField(record, "recordHash", path), `${path}.recordHash`) });
    }
    case "chain-object": {
      const record = exactDataRecord(value, ["kind", "chainId", "blockNumber", "blockHash", "objectKind", "objectKeyHash"], path);
      const objectKind = dataField(record, "objectKind", path);
      if (objectKind !== "header" && objectKind !== "transaction" && objectKind !== "receipt" && objectKind !== "state-proof" && objectKind !== "logs") throw new TypeError(`invalid object kind at ${path}`);
      return Object.freeze({ kind, chainId: oracleDecimal(dataField(record, "chainId", path), `${path}.chainId`), blockNumber: oracleDecimal(dataField(record, "blockNumber", path), `${path}.blockNumber`), blockHash: oracleHash(dataField(record, "blockHash", path), `${path}.blockHash`), objectKind, objectKeyHash: oracleHash(dataField(record, "objectKeyHash", path), `${path}.objectKeyHash`) });
    }
    case "content-object": {
      const record = exactDataRecord(value, ["kind", "storeIdentityHash", "objectKey"], path);
      return Object.freeze({ kind, storeIdentityHash: oracleHash(dataField(record, "storeIdentityHash", path), `${path}.storeIdentityHash`), objectKey: oracleHash(dataField(record, "objectKey", path), `${path}.objectKey`) });
    }
    case "json-pointer": {
      const record = exactDataRecord(value, ["kind", "parentLocatorId", "pointer"], path);
      const pointerValue = dataField(record, "pointer", path);
      return Object.freeze({ kind, parentLocatorId: oracleHash(dataField(record, "parentLocatorId", path), `${path}.parentLocatorId`), pointer: pointerValue === "" ? "" : oracleString(pointerValue, `${path}.pointer`) });
    }
    default: throw new TypeError(`unknown locator kind at ${path}.kind`);
  }
}

function decodeOracleReadOnlyArtifactRef(value: unknown, path = "$"): OracleReadOnlyArtifactRefV1 {
  const record = exactDataRecord(value, ["artifactRefId", "locatorId", "locator", "immutableMirrorLocatorId", "immutableMirrorLocator", "contentSha256", "byteLength", "mediaType", "schema", "resolverPolicyHash", "retentionLeaseReceiptId"], path);
  const locator = decodeOracleLocator(dataField(record, "locator", path), `${path}.locator`);
  const immutableMirrorLocator = decodeOracleLocator(dataField(record, "immutableMirrorLocator", path), `${path}.immutableMirrorLocator`);
  if (immutableMirrorLocator.kind !== "content-object") throw new TypeError(`invalid immutable mirror at ${path}`);
  const schemaValue = dataField(record, "schema", path);
  const decoded = Object.freeze({
    artifactRefId: oracleHash(dataField(record, "artifactRefId", path), `${path}.artifactRefId`),
    locatorId: oracleHash(dataField(record, "locatorId", path), `${path}.locatorId`), locator,
    immutableMirrorLocatorId: oracleHash(dataField(record, "immutableMirrorLocatorId", path), `${path}.immutableMirrorLocatorId`), immutableMirrorLocator,
    contentSha256: oracleHash(dataField(record, "contentSha256", path), `${path}.contentSha256`), byteLength: oracleDecimal(dataField(record, "byteLength", path), `${path}.byteLength`),
    mediaType: oracleString(dataField(record, "mediaType", path), `${path}.mediaType`), schema: schemaValue === null ? null : decodeOracleSchemaRef(schemaValue, `${path}.schema`),
    resolverPolicyHash: oracleHash(dataField(record, "resolverPolicyHash", path), `${path}.resolverPolicyHash`), retentionLeaseReceiptId: oracleHash(dataField(record, "retentionLeaseReceiptId", path), `${path}.retentionLeaseReceiptId`),
  });
  const locatorId = hashDomain("aloha/read-only-artifact-locator/v1", locator as unknown as CanonicalJson);
  const immutableMirrorLocatorId = hashDomain("aloha/read-only-artifact-locator/v1", immutableMirrorLocator as unknown as CanonicalJson);
  if (decoded.locatorId !== locatorId || decoded.immutableMirrorLocatorId !== immutableMirrorLocatorId || immutableMirrorLocator.objectKey !== decoded.contentSha256) throw new TypeError(`artifact locator binding mismatch at ${path}`);
  if (locator.kind === "file-range" && BigInt(locator.endExclusive) - BigInt(locator.startInclusive) !== BigInt(decoded.byteLength)) throw new TypeError(`file range length mismatch at ${path}`);
  const artifactRefId = hashDomain("aloha/read-only-artifact-ref/v1", { locatorId, immutableMirrorLocatorId, contentSha256: decoded.contentSha256, byteLength: decoded.byteLength, mediaType: decoded.mediaType, schema: decoded.schema, resolverPolicyHash: decoded.resolverPolicyHash, retentionLeaseReceiptId: decoded.retentionLeaseReceiptId });
  if (decoded.artifactRefId !== artifactRefId) throw new TypeError(`artifact identity mismatch at ${path}`);
  return decoded;
}

function decodeOracleSchemaRef(value: unknown, path: string): OracleSchemaRefV1 {
  const record = exactDataRecord(value, ["id", "version", "schemaHash"], path);
  const id = oracleString(dataField(record, "id", path), `${path}.id`);
  const version = oracleString(dataField(record, "version", path), `${path}.version`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new TypeError(`expected semantic version at ${path}.version`);
  }
  return Object.freeze({ id, version, schemaHash: oracleHash(dataField(record, "schemaHash", path), `${path}.schemaHash`) });
}

function decodeOracleMirror(value: unknown, path: string): OracleObservedImmutableMirrorV1 {
  const record = exactDataRecord(
    value,
    ["storeIdentityHash", "objectKey", "bytes", "contentSha256", "byteLength", "mediaType", "schema"],
    path,
  );
  const bytes = dataField(record, "bytes", path);
  const decodedBytes = decodeOracleArtifactBytes(bytes, `${path}.bytes`);
  const contentSha256 = oracleHash(dataField(record, "contentSha256", path), `${path}.contentSha256`);
  const byteLength = oracleDecimal(dataField(record, "byteLength", path), `${path}.byteLength`);
  const schemaValue = dataField(record, "schema", path);
  const schema = schemaValue === null ? null : decodeOracleSchemaRef(schemaValue, `${path}.schema`);
  if (String(decodedBytes.byteLength) !== byteLength || sha256Hex(decodedBytes) !== contentSha256) {
    throw new TypeError(`mirror outer and inner bytes do not match at ${path}`);
  }
  return Object.freeze({
    storeIdentityHash: oracleHash(dataField(record, "storeIdentityHash", path), `${path}.storeIdentityHash`),
    objectKey: oracleHash(dataField(record, "objectKey", path), `${path}.objectKey`),
    bytes: bytes as OracleArtifactBytesV1,
    contentSha256,
    byteLength,
    mediaType: oracleString(dataField(record, "mediaType", path), `${path}.mediaType`),
    schema,
  });
}

function decodeOracleArtifactResolutionClaim(value: unknown, path = "$"): OracleArtifactResolutionClaimV1 {
  const record = exactDataRecord(
    value,
    ["claimId", "artifactRefId", "resolverPolicyHash", "observedMirror", "outcome"],
    path,
  );
  const mirrorValue = dataField(record, "observedMirror", path);
  const observedMirror = mirrorValue === null ? null : decodeOracleMirror(mirrorValue, `${path}.observedMirror`);
  const outcome = dataField(record, "outcome", path);
  if (outcome !== "content-observed" && outcome !== "missing" && outcome !== "content-mismatch") {
    throw new TypeError(`invalid claim outcome at ${path}.outcome`);
  }
  if ((outcome === "content-observed" && observedMirror === null)
    || (outcome === "missing" && observedMirror !== null)) {
    throw new TypeError(`claim outcome and mirror disagree at ${path}`);
  }
  const decoded = Object.freeze({
    claimId: oracleHash(dataField(record, "claimId", path), `${path}.claimId`),
    artifactRefId: oracleHash(dataField(record, "artifactRefId", path), `${path}.artifactRefId`),
    resolverPolicyHash: oracleHash(dataField(record, "resolverPolicyHash", path), `${path}.resolverPolicyHash`),
    observedMirror,
    outcome,
  });
  if (decoded.claimId !== hashDomain("aloha/artifact-resolution-claim/v1", {
    artifactRefId: decoded.artifactRefId,
    resolverPolicyHash: decoded.resolverPolicyHash,
    observedMirror: decoded.observedMirror,
    outcome: decoded.outcome,
  })) throw new TypeError(`claim identity mismatch at ${path}.claimId`);
  return decoded;
}

function decodeOracleResolverPolicy(value: unknown, path = "$"): OracleResolverPolicyV1 {
  const record = exactDataRecord(value, [
    "schemaVersion", "kind", "policyHash", "allowedLocatorKind", "digestAlgorithm", "maxByteLength",
    "requireExactLengthMediaAndSchema", "minimumRemainingStoreEpochs", "failureOutcome",
  ], path);
  if (dataField(record, "schemaVersion", path) !== 1
    || dataField(record, "kind", path) !== "aloha.artifact-resolver-policy"
    || dataField(record, "allowedLocatorKind", path) !== "content-object"
    || dataField(record, "digestAlgorithm", path) !== "sha256"
    || dataField(record, "requireExactLengthMediaAndSchema", path) !== true
    || dataField(record, "failureOutcome", path) !== "invalid") {
    throw new TypeError(`invalid resolver policy literals at ${path}`);
  }
  const maxByteLength = oracleDecimal(dataField(record, "maxByteLength", path), `${path}.maxByteLength`);
  if (BigInt(maxByteLength) <= 0n) throw new TypeError(`non-positive policy byte bound at ${path}.maxByteLength`);
  const decoded = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.artifact-resolver-policy" as const,
    policyHash: oracleHash(dataField(record, "policyHash", path), `${path}.policyHash`),
    allowedLocatorKind: "content-object" as const,
    digestAlgorithm: "sha256" as const,
    maxByteLength,
    requireExactLengthMediaAndSchema: true as const,
    minimumRemainingStoreEpochs: oracleDecimal(dataField(record, "minimumRemainingStoreEpochs", path), `${path}.minimumRemainingStoreEpochs`),
    failureOutcome: "invalid" as const,
  });
  const { policyHash: _policyHash, ...payload } = decoded;
  if (decoded.policyHash !== hashDomain("aloha/artifact-resolver-policy/v1", payload)) {
    throw new TypeError(`resolver policy identity mismatch at ${path}.policyHash`);
  }
  return decoded;
}

function decodeOracleRetentionLeaseReceipt(value: unknown, path = "$"): OracleRetentionLeaseReceiptV1 {
  const record = exactDataRecord(value, [
    "receiptId", "storeIdentityHash", "objectKey", "contentSha256", "validFromStoreEpoch",
    "validThroughStoreEpoch", "issuerId", "issuerQualificationId", "qualificationRegistryRoot",
  ], path);
  const decoded = Object.freeze({
    receiptId: oracleHash(dataField(record, "receiptId", path), `${path}.receiptId`),
    storeIdentityHash: oracleHash(dataField(record, "storeIdentityHash", path), `${path}.storeIdentityHash`),
    objectKey: oracleHash(dataField(record, "objectKey", path), `${path}.objectKey`),
    contentSha256: oracleHash(dataField(record, "contentSha256", path), `${path}.contentSha256`),
    validFromStoreEpoch: oracleDecimal(dataField(record, "validFromStoreEpoch", path), `${path}.validFromStoreEpoch`),
    validThroughStoreEpoch: oracleDecimal(dataField(record, "validThroughStoreEpoch", path), `${path}.validThroughStoreEpoch`),
    issuerId: oracleString(dataField(record, "issuerId", path), `${path}.issuerId`),
    issuerQualificationId: oracleHash(dataField(record, "issuerQualificationId", path), `${path}.issuerQualificationId`),
    qualificationRegistryRoot: oracleHash(dataField(record, "qualificationRegistryRoot", path), `${path}.qualificationRegistryRoot`),
  });
  if (BigInt(decoded.validThroughStoreEpoch) < BigInt(decoded.validFromStoreEpoch)) {
    throw new TypeError(`reversed lease interval at ${path}`);
  }
  const { receiptId: _receiptId, ...payload } = decoded;
  if (decoded.receiptId !== hashDomain("aloha/retention-lease-receipt/v1", payload)) {
    throw new TypeError(`lease identity mismatch at ${path}.receiptId`);
  }
  return decoded;
}

function nullableHash(value: unknown, path: string): Hash | null { return value === null ? null : oracleHash(value, path); }
function nullableString(value: unknown, path: string): string | null { return value === null ? null : oracleString(value, path); }

function decodeOracleProcessAnchor(value: unknown, path: string): OracleProcessAnchorV1 {
  const record = exactDataRecord(value, ["systemId", "commitSha", "executableHash", "deploymentManifestHash", "serviceIdentityHash", "pid", "processStartTicks", "bootIdHash"], path);
  return Object.freeze({
    systemId: oracleString(dataField(record, "systemId", path), `${path}.systemId`), commitSha: oracleGitSha40(dataField(record, "commitSha", path), `${path}.commitSha`),
    executableHash: oracleHash(dataField(record, "executableHash", path), `${path}.executableHash`), deploymentManifestHash: oracleHash(dataField(record, "deploymentManifestHash", path), `${path}.deploymentManifestHash`),
    serviceIdentityHash: oracleHash(dataField(record, "serviceIdentityHash", path), `${path}.serviceIdentityHash`), pid: oracleDecimal(dataField(record, "pid", path), `${path}.pid`),
    processStartTicks: oracleDecimal(dataField(record, "processStartTicks", path), `${path}.processStartTicks`), bootIdHash: oracleHash(dataField(record, "bootIdHash", path), `${path}.bootIdHash`),
  });
}

function parseOracleInput(value: unknown): unknown {
  return ArrayBuffer.isView(value) ? decodeCanonicalJson(value as Uint8Array) : value;
}

function decodeOracleSemanticArtifact(value: unknown): OracleSemanticArtifactV1 {
  const path = "$";
  const record = exactDataRecord(parseOracleInput(value), ["schema", "artifactId", "inputArtifactIds", "dependencyClosureRoot", "canonicalPayloadHash"], path);
  const decoded = Object.freeze({
    schema: decodeOracleSchemaRef(dataField(record, "schema", path), "$.schema"), artifactId: oracleHash(dataField(record, "artifactId", path), "$.artifactId"),
    inputArtifactIds: decodeOracleArray(dataField(record, "inputArtifactIds", path), oracleHash, "$.inputArtifactIds"),
    dependencyClosureRoot: oracleHash(dataField(record, "dependencyClosureRoot", path), "$.dependencyClosureRoot"), canonicalPayloadHash: oracleHash(dataField(record, "canonicalPayloadHash", path), "$.canonicalPayloadHash"),
  });
  const expected = hashDomain("aloha/semantic-artifact/v1", { schema: decoded.schema, inputArtifactIds: decoded.inputArtifactIds, dependencyClosureRoot: decoded.dependencyClosureRoot, canonicalPayloadHash: decoded.canonicalPayloadHash });
  if (decoded.artifactId !== expected) throw new TypeError("semantic artifact identity mismatch");
  return decoded;
}

function decodeOracleProductionReceipt(value: unknown): OracleProductionReceiptV1 {
  const path = "$";
  const record = exactDataRecord(parseOracleInput(value), ["receiptId", "artifactId", "producer", "logRangeArtifactRef", "sourceAnchorHash", "startedMonotonicNs", "finishedMonotonicNs", "durationUs", "rawBoundaryArtifactRef", "semanticConfigDigest", "resourceMetricsHash"], path);
  const decoded = Object.freeze({
    receiptId: oracleHash(dataField(record, "receiptId", path), "$.receiptId"), artifactId: oracleHash(dataField(record, "artifactId", path), "$.artifactId"), producer: decodeOracleProcessAnchor(dataField(record, "producer", path), "$.producer"),
    logRangeArtifactRef: decodeOracleReadOnlyArtifactRef(dataField(record, "logRangeArtifactRef", path), "$.logRangeArtifactRef"), sourceAnchorHash: oracleHash(dataField(record, "sourceAnchorHash", path), "$.sourceAnchorHash"),
    startedMonotonicNs: oracleDecimal(dataField(record, "startedMonotonicNs", path), "$.startedMonotonicNs"), finishedMonotonicNs: oracleDecimal(dataField(record, "finishedMonotonicNs", path), "$.finishedMonotonicNs"), durationUs: oracleDecimal(dataField(record, "durationUs", path), "$.durationUs"),
    rawBoundaryArtifactRef: decodeOracleReadOnlyArtifactRef(dataField(record, "rawBoundaryArtifactRef", path), "$.rawBoundaryArtifactRef"), semanticConfigDigest: oracleHash(dataField(record, "semanticConfigDigest", path), "$.semanticConfigDigest"), resourceMetricsHash: oracleHash(dataField(record, "resourceMetricsHash", path), "$.resourceMetricsHash"),
  });
  if (BigInt(decoded.finishedMonotonicNs) < BigInt(decoded.startedMonotonicNs)
    || decoded.logRangeArtifactRef.artifactRefId === decoded.rawBoundaryArtifactRef.artifactRefId
    || decoded.logRangeArtifactRef.locator.kind !== "file-range"
    || decoded.logRangeArtifactRef.locator.systemId !== decoded.producer.systemId
    || decoded.logRangeArtifactRef.locator.bootIdHash !== decoded.producer.bootIdHash) throw new TypeError("production receipt refinement mismatch");
  const expected = hashDomain("aloha/production-receipt/v1", {
    artifactId: decoded.artifactId, producer: decoded.producer, logRangeArtifactRef: decoded.logRangeArtifactRef, sourceAnchorHash: decoded.sourceAnchorHash,
    startedMonotonicNs: decoded.startedMonotonicNs, finishedMonotonicNs: decoded.finishedMonotonicNs, durationUs: decoded.durationUs,
    rawBoundaryArtifactRef: decoded.rawBoundaryArtifactRef, semanticConfigDigest: decoded.semanticConfigDigest, resourceMetricsHash: decoded.resourceMetricsHash,
  });
  if (decoded.receiptId !== expected) throw new TypeError("production receipt identity mismatch");
  return decoded;
}

function decodeOracleWitness(value: unknown, path: string): OracleWitnessV1 {
  const record = exactDataRecord(value, ["artifactRefId", "contentRoot"], path);
  return Object.freeze({ artifactRefId: oracleHash(dataField(record, "artifactRefId", path), `${path}.artifactRefId`), contentRoot: oracleHash(dataField(record, "contentRoot", path), `${path}.contentRoot`) });
}

function decodeOracleSourceAnchor(value: unknown, path: string): OracleSourceAnchorV1 {
  const record = exactDataRecord(value, ["chainId", "number", "hash", "stateRoot"], path);
  return Object.freeze({ chainId: oracleDecimal(dataField(record, "chainId", path), `${path}.chainId`), number: oracleDecimal(dataField(record, "number", path), `${path}.number`), hash: oracleHash(dataField(record, "hash", path), `${path}.hash`), stateRoot: oracleHash(dataField(record, "stateRoot", path), `${path}.stateRoot`) });
}

function decodeOracleCutoff(value: unknown, path: string): OracleCutoffV1 {
  const record = exactDataRecord(value, ["number", "hash", "stateRoot"], path);
  return Object.freeze({ number: oracleDecimal(dataField(record, "number", path), `${path}.number`), hash: oracleHash(dataField(record, "hash", path), `${path}.hash`), stateRoot: oracleHash(dataField(record, "stateRoot", path), `${path}.stateRoot`) });
}

function decodeOracleRouteBinding(value: unknown, path: string): OracleRouteBindingV1 {
  const record = exactDataRecord(value, ["edgeId", "instanceKey", "stage1EventId", "stage2EventId", "instancePublicationRoot"], path);
  return Object.freeze({ edgeId: oracleHash(dataField(record, "edgeId", path), `${path}.edgeId`), instanceKey: oracleString(dataField(record, "instanceKey", path), `${path}.instanceKey`), stage1EventId: oracleHash(dataField(record, "stage1EventId", path), `${path}.stage1EventId`), stage2EventId: oracleHash(dataField(record, "stage2EventId", path), `${path}.stage2EventId`), instancePublicationRoot: oracleHash(dataField(record, "instancePublicationRoot", path), `${path}.instancePublicationRoot`) });
}

function decodeOracleSixStepStageFacts(value: unknown, path = "$"): OracleSixStepStageFactsV1 {
  if (value === null || typeof value !== "object") throw new TypeError(`expected stage facts at ${path}`);
  const keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === "string");
  const probe = exactDataRecord(value, keys, path);
  const stageId = dataField(probe, "stageId", path);
  const base = (record: Readonly<Record<string, unknown>>) => {
    oracleLiteral(dataField(record, "schemaVersion", path), 1, `${path}.schemaVersion`);
    oracleLiteral(dataField(record, "kind", path), "aloha.six-step-stage-facts", `${path}.kind`);
  };
  switch (stageId) {
    case "universe_instance": {
      const record = exactDataRecord(value, ["schemaVersion", "kind", "stageId", "candidatePartition", "instancePublication", "identityProof", "sourceCoverage"], path); base(record);
      return Object.freeze({ schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId, candidatePartition: decodeOracleWitness(dataField(record, "candidatePartition", path), `${path}.candidatePartition`), instancePublication: decodeOracleWitness(dataField(record, "instancePublication", path), `${path}.instancePublication`), identityProof: decodeOracleWitness(dataField(record, "identityProof", path), `${path}.identityProof`), sourceCoverage: decodeOracleWitness(dataField(record, "sourceCoverage", path), `${path}.sourceCoverage`) });
    }
    case "edge_ready_generation": {
      const record = exactDataRecord(value, ["schemaVersion", "kind", "stageId", "instancePublication", "edge", "coverage", "promotionRevision", "generationId", "attestationMode", "memoReuseProof"], path); base(record);
      const mode = dataField(record, "attestationMode", path); if (mode !== "fresh" && mode !== "memo-reuse") throw new TypeError(`invalid attestation mode at ${path}`);
      return Object.freeze({ schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId, instancePublication: decodeOracleWitness(dataField(record, "instancePublication", path), `${path}.instancePublication`), edge: decodeOracleWitness(dataField(record, "edge", path), `${path}.edge`), coverage: decodeOracleWitness(dataField(record, "coverage", path), `${path}.coverage`), promotionRevision: oracleString(dataField(record, "promotionRevision", path), `${path}.promotionRevision`), generationId: oracleString(dataField(record, "generationId", path), `${path}.generationId`), attestationMode: mode, memoReuseProof: decodeOracleWitness(dataField(record, "memoReuseProof", path), `${path}.memoReuseProof`) });
    }
    case "planner_consumption": {
      const record = exactDataRecord(value, ["schemaVersion", "kind", "stageId", "orderedInstanceBindings", "orderedInstanceBindingsRoot", "routeSet", "coarseProjection", "admissionReceipt", "admissionClass"], path); base(record);
      const admissionClass = dataField(record, "admissionClass", path); if (admissionClass !== "ranked" && admissionClass !== "bounded-unranked") throw new TypeError(`invalid admission class at ${path}`);
      return Object.freeze({ schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId, orderedInstanceBindings: decodeOracleArray(dataField(record, "orderedInstanceBindings", path), decodeOracleRouteBinding, `${path}.orderedInstanceBindings`), orderedInstanceBindingsRoot: oracleHash(dataField(record, "orderedInstanceBindingsRoot", path), `${path}.orderedInstanceBindingsRoot`), routeSet: decodeOracleWitness(dataField(record, "routeSet", path), `${path}.routeSet`), coarseProjection: decodeOracleWitness(dataField(record, "coarseProjection", path), `${path}.coarseProjection`), admissionReceipt: decodeOracleWitness(dataField(record, "admissionReceipt", path), `${path}.admissionReceipt`), admissionClass });
    }
    case "current_source_exact": {
      const record = exactDataRecord(value, ["schemaVersion", "kind", "stageId", "currentSource", "exactOutput", "fallback"], path); base(record);
      return Object.freeze({ schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId, currentSource: decodeOracleSourceAnchor(dataField(record, "currentSource", path), `${path}.currentSource`), exactOutput: decodeOracleWitness(dataField(record, "exactOutput", path), `${path}.exactOutput`), fallback: oracleLiteral(dataField(record, "fallback", path), false, `${path}.fallback`) });
    }
    case "execution_program": {
      const record = exactDataRecord(value, ["schemaVersion", "kind", "stageId", "program", "callerMode", "preCalls", "observationPairs", "actionOwner", "fallback"], path); base(record);
      return Object.freeze({ schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId, program: decodeOracleWitness(dataField(record, "program", path), `${path}.program`), callerMode: oracleString(dataField(record, "callerMode", path), `${path}.callerMode`), preCalls: decodeOracleWitness(dataField(record, "preCalls", path), `${path}.preCalls`), observationPairs: decodeOracleWitness(dataField(record, "observationPairs", path), `${path}.observationPairs`), actionOwner: decodeOracleWitness(dataField(record, "actionOwner", path), `${path}.actionOwner`), fallback: oracleLiteral(dataField(record, "fallback", path), false, `${path}.fallback`) });
    }
    case "final_simulation": {
      const record = exactDataRecord(value, ["schemaVersion", "kind", "stageId", "finalSimulationReceipt", "simulationSourceAnchor", "economicReceipt", "safetyReceipt", "dryRun"], path); base(record);
      return Object.freeze({ schemaVersion: 1, kind: "aloha.six-step-stage-facts", stageId, finalSimulationReceipt: decodeOracleWitness(dataField(record, "finalSimulationReceipt", path), `${path}.finalSimulationReceipt`), simulationSourceAnchor: decodeOracleSourceAnchor(dataField(record, "simulationSourceAnchor", path), `${path}.simulationSourceAnchor`), economicReceipt: decodeOracleWitness(dataField(record, "economicReceipt", path), `${path}.economicReceipt`), safetyReceipt: decodeOracleWitness(dataField(record, "safetyReceipt", path), `${path}.safetyReceipt`), dryRun: oracleLiteral(dataField(record, "dryRun", path), true, `${path}.dryRun`) });
    }
    default: throw new TypeError(`unknown six-step stageId at ${path}.stageId`);
  }
}

function decodeOracleSixStepEventFact(value: unknown, path = "$") {
  const record = exactDataRecord(value, ["schemaVersion", "kind", "eventArtifactRefId", "semanticArtifactRefId", "productionReceiptArtifactRefId"], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, `${path}.schemaVersion`); oracleLiteral(dataField(record, "kind", path), "aloha.six-step-event-fact", `${path}.kind`);
  return Object.freeze({ schemaVersion: 1 as const, kind: "aloha.six-step-event-fact" as const, eventArtifactRefId: oracleHash(dataField(record, "eventArtifactRefId", path), `${path}.eventArtifactRefId`), semanticArtifactRefId: oracleHash(dataField(record, "semanticArtifactRefId", path), `${path}.semanticArtifactRefId`), productionReceiptArtifactRefId: oracleHash(dataField(record, "productionReceiptArtifactRefId", path), `${path}.productionReceiptArtifactRefId`) });
}

function decodeOracleSixStepStageInput(value: unknown, path = "$") {
  const record = exactDataRecord(value, ["schemaVersion", "kind", "stageId", "rawBoundaryArtifactRefId", "orderedWitnessArtifactRefIds", "parentEventIds"], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, `${path}.schemaVersion`);
  oracleLiteral(dataField(record, "kind", path), "aloha.six-step-stage-input", `${path}.kind`);
  const stageId = dataField(record, "stageId", path);
  if (!ORACLE_STAGE_IDS.includes(stageId as never)) throw new TypeError(`invalid stage input id at ${path}.stageId`);
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.six-step-stage-input" as const,
    stageId: stageId as (typeof ORACLE_STAGE_IDS)[number],
    rawBoundaryArtifactRefId: oracleHash(dataField(record, "rawBoundaryArtifactRefId", path), `${path}.rawBoundaryArtifactRefId`),
    orderedWitnessArtifactRefIds: decodeOracleArray(dataField(record, "orderedWitnessArtifactRefIds", path), oracleHash, `${path}.orderedWitnessArtifactRefIds`),
    parentEventIds: decodeOracleArray(dataField(record, "parentEventIds", path), oracleHash, `${path}.parentEventIds`),
  });
}

function oracleWitnessArtifactRefIds(facts: OracleSixStepStageFactsV1): readonly Hash[] {
  switch (facts.stageId) {
    case "universe_instance": return [facts.candidatePartition.artifactRefId, facts.instancePublication.artifactRefId, facts.identityProof.artifactRefId, facts.sourceCoverage.artifactRefId];
    case "edge_ready_generation": return [facts.instancePublication.artifactRefId, facts.edge.artifactRefId, facts.coverage.artifactRefId, facts.memoReuseProof.artifactRefId];
    case "planner_consumption": return [facts.routeSet.artifactRefId, facts.coarseProjection.artifactRefId, facts.admissionReceipt.artifactRefId];
    case "current_source_exact": return [facts.exactOutput.artifactRefId];
    case "execution_program": return [facts.program.artifactRefId, facts.preCalls.artifactRefId, facts.observationPairs.artifactRefId, facts.actionOwner.artifactRefId];
    case "final_simulation": return [facts.finalSimulationReceipt.artifactRefId, facts.economicReceipt.artifactRefId, facts.safetyReceipt.artifactRefId];
  }
}

function decodeOracleWitnessContent(bytes: Uint8Array) {
  const path = "$"; const record = exactDataRecord(decodeCanonicalJson(bytes), ["schemaVersion", "kind", "stageId", "role", "payload"], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, "$.schemaVersion"); oracleLiteral(dataField(record, "kind", path), "aloha.six-step-evidence-witness", "$.kind");
  const stageId = dataField(record, "stageId", path); if (!ORACLE_STAGE_IDS.includes(stageId as never)) throw new TypeError("invalid witness stage");
  return Object.freeze({ schemaVersion: 1 as const, kind: "aloha.six-step-evidence-witness" as const, stageId: stageId as (typeof ORACLE_STAGE_IDS)[number], role: oracleString(dataField(record, "role", path), "$.role"), payload: decodeOracleCanonicalObject(dataField(record, "payload", path), "$.payload") });
}

function decodeOracleNativeBoundaryRecord(bytes: Uint8Array) {
  const path = "$";
  const record = exactDataRecord(decodeCanonicalJson(bytes), ["schemaVersion", "kind", "stageId", "role", "payload"], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, "$.schemaVersion");
  oracleLiteral(dataField(record, "kind", path), "aloha.six-step-native-boundary-record", "$.kind");
  const stageId = dataField(record, "stageId", path);
  if (!ORACLE_STAGE_IDS.includes(stageId as never)) throw new TypeError("invalid native boundary stage");
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.six-step-native-boundary-record" as const,
    stageId: stageId as (typeof ORACLE_STAGE_IDS)[number],
    role: oracleLiteral(dataField(record, "role", path), "raw-boundary", "$.role"),
    payload: decodeOracleCanonicalObject(dataField(record, "payload", path), "$.payload"),
  });
}

function oracleWitnessContentRoot(value: ReturnType<typeof decodeOracleWitnessContent>): Hash { return hashDomain("aloha/six-step/witness-content/v1", value as unknown as CanonicalJson); }
function oracleOrderedInstanceBindingsRoot(value: readonly OracleRouteBindingV1[]): Hash { return hashDomain("aloha/six-step/ordered-instance-bindings/v1", value as unknown as CanonicalJson); }

const ORACLE_REASON_CODE_VALUES = Object.freeze([
  "abort", "chain-rejected", "deadline", "evidence-write-failed", "failed-closed", "hash-mismatch",
  "invalid-program", "invalid-schema", "lease-invalid", "missing-observation", "not-ready", "plugin-error",
  "qualification-missing", "queue-full", "reorg", "resource-limit", "simulation-reverted", "source-stale",
  "transport-error", "unknown-capability", "unknown",
] as const);
type OracleReasonCode = (typeof ORACLE_REASON_CODE_VALUES)[number];
const ORACLE_REASON_CODES: ReadonlySet<string> = new Set(ORACLE_REASON_CODE_VALUES);

function decodeOracleEvidenceEvent(value: unknown): OracleEvidenceEventV1 {
  const path = "$";
  const record = exactDataRecord(parseOracleInput(value), [
    "schemaVersion", "kind", "eventId", "source", "runtime", "artifactLineage", "scope", "correlationId",
    "runSequence", "cutoff", "definitionCatalogRoot", "strategyCatalogRoot", "instanceCatalogRoot", "graphRoot",
    "familyId", "candidateKey", "familyDefinitionHash", "capabilities", "capabilitySetHash", "instanceKey",
    "stage", "parentEventIds", "parentOutputHashes", "inputSchema", "inputs", "inputHash", "factSchema",
    "facts", "outputHash", "outcome", "reasonCode", "latency", "extensions",
  ], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, "$.schemaVersion");
  oracleLiteral(dataField(record, "kind", path), "aloha.fact-evidence-event", "$.kind");
  const sourceRecord = exactDataRecord(dataField(record, "source", path), ["systemId", "emitterKind", "emitterCodeHash", "rawBoundaryArtifactRef"], "$.source");
  const emitterKind = dataField(sourceRecord, "emitterKind", "$.source");
  if (emitterKind !== "native" && emitterKind !== "read-only-adapter") throw new TypeError("invalid emitter kind");
  const runtimeRecord = exactDataRecord(dataField(record, "runtime", path), ["commitSha", "executableHash", "deploymentManifestHash", "serviceIdentityHash", "pid", "processStartTicks", "bootIdHash", "logRangeArtifactRefId"], "$.runtime");
  const lineageRecord = exactDataRecord(dataField(record, "artifactLineage", path), ["inputArtifactIds", "outputArtifactId", "productionReceiptId"], "$.artifactLineage");
  const scopeRecord = exactDataRecord(dataField(record, "scope", path), ["kind", "builderRunId", "producerSessionId", "generationId", "generationRefreshPolicyHash"], "$.scope");
  const scopeKind = dataField(scopeRecord, "kind", "$.scope");
  if (scopeKind !== "builder-run" && scopeKind !== "ready-generation" && scopeKind !== "producer-session") throw new TypeError("invalid scope kind");
  const producerSessionId = nullableString(dataField(scopeRecord, "producerSessionId", "$.scope"), "$.scope.producerSessionId");
  const generationId = nullableString(dataField(scopeRecord, "generationId", "$.scope"), "$.scope.generationId");
  if ((scopeKind === "builder-run" && (producerSessionId !== null || generationId !== null))
    || (scopeKind === "ready-generation" && (producerSessionId !== null || generationId === null))
    || (scopeKind === "producer-session" && (producerSessionId === null || generationId === null))) throw new TypeError("scope member mismatch");
  const stageRecord = exactDataRecord(dataField(record, "stage", path), ["ordinal", "id", "version"], "$.stage");
  const ordinal = dataField(stageRecord, "ordinal", "$.stage");
  if (ordinal !== 1 && ordinal !== 2 && ordinal !== 3 && ordinal !== 4 && ordinal !== 5 && ordinal !== 6) throw new TypeError("invalid stage ordinal");
  const stageId = dataField(stageRecord, "id", "$.stage");
  if (ORACLE_STAGE_IDS[ordinal - 1] !== stageId) throw new TypeError("stage ordinal/id mismatch");
  const outcome = dataField(record, "outcome", path);
  if (outcome !== "verified" && outcome !== "success" && outcome !== "chain_proven_rejected" && outcome !== "retryable"
    && outcome !== "invalid_program" && outcome !== "policy_rejected" && outcome !== "simulation_reverted" && outcome !== "failed_closed") throw new TypeError("invalid outcome");
  const reasonCode = dataField(record, "reasonCode", path);
  if (reasonCode !== null && (typeof reasonCode !== "string" || !ORACLE_REASON_CODES.has(reasonCode))) throw new TypeError("invalid reason code");
  const latencyRecord = exactDataRecord(dataField(record, "latency", path), ["startedMonotonicNs", "finishedMonotonicNs", "durationUs"], "$.latency");
  const capabilities = decodeOracleArray(dataField(record, "capabilities", path), (entry, entryPath) => {
    const capability = exactDataRecord(entry, ["capabilityId", "version", "schemaHash", "interpreterHash"], entryPath);
    return Object.freeze({ capabilityId: oracleString(dataField(capability, "capabilityId", entryPath), `${entryPath}.capabilityId`), version: decodeOracleSchemaRef({ id: "x", version: dataField(capability, "version", entryPath), schemaHash: "0x" + "0".repeat(64) }, entryPath).version, schemaHash: oracleHash(dataField(capability, "schemaHash", entryPath), `${entryPath}.schemaHash`), interpreterHash: oracleHash(dataField(capability, "interpreterHash", entryPath), `${entryPath}.interpreterHash`) });
  }, "$.capabilities");
  for (let index = 1; index < capabilities.length; index += 1) if (encodeCanonicalJson(capabilities[index - 1]) >= encodeCanonicalJson(capabilities[index])) throw new TypeError("capabilities not strictly sorted");
  const extensions = decodeOracleArray(dataField(record, "extensions", path), (entry, entryPath) => {
    const extension = exactDataRecord(entry, ["schema", "value"], entryPath);
    return Object.freeze({ schema: decodeOracleSchemaRef(dataField(extension, "schema", entryPath), `${entryPath}.schema`), value: decodeOracleCanonicalValue(dataField(extension, "value", entryPath), `${entryPath}.value`) });
  }, "$.extensions");
  for (let index = 1; index < extensions.length; index += 1) if (encodeCanonicalJson(extensions[index - 1]!.schema) >= encodeCanonicalJson(extensions[index]!.schema)) throw new TypeError("extensions not strictly sorted");
  const scope = scopeKind === "builder-run"
    ? Object.freeze({ kind: scopeKind, builderRunId: oracleString(dataField(scopeRecord, "builderRunId", "$.scope"), "$.scope.builderRunId"), producerSessionId: null, generationId: null, generationRefreshPolicyHash: oracleHash(dataField(scopeRecord, "generationRefreshPolicyHash", "$.scope"), "$.scope.generationRefreshPolicyHash") })
    : scopeKind === "ready-generation"
      ? Object.freeze({ kind: scopeKind, builderRunId: oracleString(dataField(scopeRecord, "builderRunId", "$.scope"), "$.scope.builderRunId"), producerSessionId: null, generationId: generationId!, generationRefreshPolicyHash: oracleHash(dataField(scopeRecord, "generationRefreshPolicyHash", "$.scope"), "$.scope.generationRefreshPolicyHash") })
      : Object.freeze({ kind: scopeKind, builderRunId: oracleString(dataField(scopeRecord, "builderRunId", "$.scope"), "$.scope.builderRunId"), producerSessionId: producerSessionId!, generationId: generationId!, generationRefreshPolicyHash: oracleHash(dataField(scopeRecord, "generationRefreshPolicyHash", "$.scope"), "$.scope.generationRefreshPolicyHash") });
  const decoded: OracleEvidenceEventV1 = Object.freeze({
    schemaVersion: 1, kind: "aloha.fact-evidence-event", eventId: oracleHash(dataField(record, "eventId", path), "$.eventId"),
    source: Object.freeze({ systemId: oracleString(dataField(sourceRecord, "systemId", "$.source"), "$.source.systemId"), emitterKind, emitterCodeHash: oracleHash(dataField(sourceRecord, "emitterCodeHash", "$.source"), "$.source.emitterCodeHash"), rawBoundaryArtifactRef: decodeOracleReadOnlyArtifactRef(dataField(sourceRecord, "rawBoundaryArtifactRef", "$.source"), "$.source.rawBoundaryArtifactRef") }),
    runtime: Object.freeze({ commitSha: oracleGitSha40(dataField(runtimeRecord, "commitSha", "$.runtime"), "$.runtime.commitSha"), executableHash: oracleHash(dataField(runtimeRecord, "executableHash", "$.runtime"), "$.runtime.executableHash"), deploymentManifestHash: oracleHash(dataField(runtimeRecord, "deploymentManifestHash", "$.runtime"), "$.runtime.deploymentManifestHash"), serviceIdentityHash: oracleHash(dataField(runtimeRecord, "serviceIdentityHash", "$.runtime"), "$.runtime.serviceIdentityHash"), pid: oracleDecimal(dataField(runtimeRecord, "pid", "$.runtime"), "$.runtime.pid"), processStartTicks: oracleDecimal(dataField(runtimeRecord, "processStartTicks", "$.runtime"), "$.runtime.processStartTicks"), bootIdHash: oracleHash(dataField(runtimeRecord, "bootIdHash", "$.runtime"), "$.runtime.bootIdHash"), logRangeArtifactRefId: oracleHash(dataField(runtimeRecord, "logRangeArtifactRefId", "$.runtime"), "$.runtime.logRangeArtifactRefId") }),
    artifactLineage: Object.freeze({ inputArtifactIds: decodeOracleArray(dataField(lineageRecord, "inputArtifactIds", "$.artifactLineage"), oracleHash, "$.artifactLineage.inputArtifactIds"), outputArtifactId: oracleHash(dataField(lineageRecord, "outputArtifactId", "$.artifactLineage"), "$.artifactLineage.outputArtifactId"), productionReceiptId: oracleHash(dataField(lineageRecord, "productionReceiptId", "$.artifactLineage"), "$.artifactLineage.productionReceiptId") }),
    scope,
    correlationId: oracleString(dataField(record, "correlationId", path), "$.correlationId"), runSequence: oracleDecimal(dataField(record, "runSequence", path), "$.runSequence"), cutoff: decodeOracleCutoff(dataField(record, "cutoff", path), "$.cutoff"),
    definitionCatalogRoot: oracleHash(dataField(record, "definitionCatalogRoot", path), "$.definitionCatalogRoot"), strategyCatalogRoot: nullableHash(dataField(record, "strategyCatalogRoot", path), "$.strategyCatalogRoot"), instanceCatalogRoot: nullableHash(dataField(record, "instanceCatalogRoot", path), "$.instanceCatalogRoot"), graphRoot: nullableHash(dataField(record, "graphRoot", path), "$.graphRoot"),
    familyId: oracleString(dataField(record, "familyId", path), "$.familyId"), candidateKey: oracleString(dataField(record, "candidateKey", path), "$.candidateKey"), familyDefinitionHash: oracleHash(dataField(record, "familyDefinitionHash", path), "$.familyDefinitionHash"), capabilities, capabilitySetHash: oracleHash(dataField(record, "capabilitySetHash", path), "$.capabilitySetHash"), instanceKey: nullableString(dataField(record, "instanceKey", path), "$.instanceKey"),
    stage: Object.freeze({ ordinal, id: stageId as (typeof ORACLE_STAGE_IDS)[number], version: oracleLiteral(dataField(stageRecord, "version", "$.stage"), 1, "$.stage.version") }), parentEventIds: decodeOracleArray(dataField(record, "parentEventIds", path), oracleHash, "$.parentEventIds"), parentOutputHashes: decodeOracleArray(dataField(record, "parentOutputHashes", path), oracleHash, "$.parentOutputHashes"),
    inputSchema: decodeOracleSchemaRef(dataField(record, "inputSchema", path), "$.inputSchema"), inputs: decodeOracleCanonicalObject(dataField(record, "inputs", path), "$.inputs"), inputHash: oracleHash(dataField(record, "inputHash", path), "$.inputHash"), factSchema: decodeOracleSchemaRef(dataField(record, "factSchema", path), "$.factSchema"), facts: decodeOracleCanonicalObject(dataField(record, "facts", path), "$.facts"), outputHash: oracleHash(dataField(record, "outputHash", path), "$.outputHash"), outcome, reasonCode: reasonCode as OracleReasonCode | null,
    latency: Object.freeze({ startedMonotonicNs: oracleDecimal(dataField(latencyRecord, "startedMonotonicNs", "$.latency"), "$.latency.startedMonotonicNs"), finishedMonotonicNs: oracleDecimal(dataField(latencyRecord, "finishedMonotonicNs", "$.latency"), "$.latency.finishedMonotonicNs"), durationUs: oracleDecimal(dataField(latencyRecord, "durationUs", "$.latency"), "$.latency.durationUs") }), extensions,
  });
  const expectedScope = ordinal === 1 ? "builder-run" : ordinal === 2 ? "ready-generation" : "producer-session";
  if (decoded.scope.kind !== expectedScope || (ordinal <= 2) !== (decoded.strategyCatalogRoot === null)
    || (ordinal === 1) !== (decoded.instanceCatalogRoot === null && decoded.graphRoot === null)
    || (ordinal >= 2 && (decoded.instanceCatalogRoot === null || decoded.graphRoot === null))
    || ((decoded.outcome === "verified" || decoded.outcome === "success") && decoded.instanceKey === null)
    || (ordinal >= 2 && decoded.instanceKey === null)
    || ((decoded.outcome === "verified" || decoded.outcome === "success") !== (decoded.reasonCode === null))
    || (ordinal === 1 && decoded.outcome === "success") || (ordinal >= 2 && decoded.outcome === "verified")
    || (ordinal === 1 && decoded.outcome !== "verified" && decoded.outcome !== "chain_proven_rejected" && decoded.outcome !== "retryable" && decoded.outcome !== "invalid_program")
    || (ordinal === 1 && decoded.parentEventIds.length !== 0) || (ordinal === 2 && decoded.parentEventIds.length !== 1)
    || (ordinal === 3 && decoded.parentEventIds.length < 1) || (ordinal >= 4 && decoded.parentEventIds.length !== 1)
    || decoded.parentEventIds.length !== decoded.parentOutputHashes.length || new Set(decoded.parentEventIds).size !== decoded.parentEventIds.length
    || BigInt(decoded.latency.finishedMonotonicNs) < BigInt(decoded.latency.startedMonotonicNs)) throw new TypeError("event lifecycle refinement mismatch");
  if (decoded.capabilitySetHash !== hashDomain("aloha/capability-set/v1", decoded.capabilities as unknown as CanonicalJson)
    || decoded.inputHash !== hashDomain("aloha/stage-input/v1", { stageId: decoded.stage.id, inputSchema: decoded.inputSchema, inputs: decoded.inputs })
    || decoded.outputHash !== hashDomain("aloha/stage-output/v1", { stageId: decoded.stage.id, factSchema: decoded.factSchema, facts: decoded.facts, outcome: decoded.outcome, reasonCode: decoded.reasonCode })) throw new TypeError("event content hash mismatch");
  const { eventId: _eventId, ...payload } = decoded;
  if (decoded.eventId !== hashDomain("aloha/evidence-event/v1", payload as unknown as CanonicalJson)) throw new TypeError("event identity mismatch");
  return decoded;
}

function assertOracleEvidenceEventMatchesReceipt(event: OracleEvidenceEventV1, receipt: OracleProductionReceiptV1): void {
  if (event.artifactLineage.productionReceiptId !== receipt.receiptId || event.artifactLineage.outputArtifactId !== receipt.artifactId || event.source.systemId !== receipt.producer.systemId) throw new TypeError("event receipt identity mismatch");
  const runtime = { commitSha: receipt.producer.commitSha, executableHash: receipt.producer.executableHash, deploymentManifestHash: receipt.producer.deploymentManifestHash, serviceIdentityHash: receipt.producer.serviceIdentityHash, pid: receipt.producer.pid, processStartTicks: receipt.producer.processStartTicks, bootIdHash: receipt.producer.bootIdHash, logRangeArtifactRefId: receipt.logRangeArtifactRef.artifactRefId };
  if (!same(event.runtime, runtime) || !same(event.source.rawBoundaryArtifactRef, receipt.rawBoundaryArtifactRef)
    || !same(event.latency, { startedMonotonicNs: receipt.startedMonotonicNs, finishedMonotonicNs: receipt.finishedMonotonicNs, durationUs: receipt.durationUs })) throw new TypeError("event receipt binding mismatch");
}

function same(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function add(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function positiveHash(value: Hash): boolean {
  return /^0x[0-9a-f]{64}$/.test(value) && !/^0x0+$/.test(value);
}

function positiveWitness(value: { readonly artifactRefId: Hash; readonly contentRoot: Hash }): boolean {
  return positiveHash(value.artifactRefId) && positiveHash(value.contentRoot);
}

interface ObservedValueV1<T> {
  readonly value: T;
  readonly claimId: Hash;
}

type OracleWitnessPayloadMapV1 = ReadonlyMap<Hash, Readonly<Record<string, Readonly<Record<string, CanonicalJson>>>>>;
type OracleRawPayloadMapV1 = ReadonlyMap<Hash, Readonly<Record<string, CanonicalJson>>>;

function validateEvidenceEnvelope(
  input: SixStepReferenceInputV1,
  reasons: string[],
  witnessPayloadsByEvent: Map<Hash, Readonly<Record<string, Readonly<Record<string, CanonicalJson>>>>>,
  rawPayloadsByEvent: Map<Hash, Readonly<Record<string, CanonicalJson>>>,
): boolean {
  const evidence = input.evidence;
  const refsById = new Map<Hash, OracleReadOnlyArtifactRefV1>();
  const claimsByRef = new Map<Hash, OracleArtifactResolutionClaimV1>();
  const policiesByHash = new Map<Hash, OracleResolverPolicyV1>();
  const leasesById = new Map<Hash, OracleRetentionLeaseReceiptV1>();
  let valid = true;
  for (const ref of evidence.refs) {
    try {
      const decoded = decodeOracleReadOnlyArtifactRef(ref);
      const prior = refsById.get(decoded.artifactRefId);
      if (prior !== undefined) { valid = false; add(reasons, "duplicate-ref"); }
      refsById.set(decoded.artifactRefId, decoded);
    } catch {
      valid = false; add(reasons, "invalid-ref");
    }
  }
  for (const policy of evidence.policies) {
    try {
      const decoded = decodeOracleResolverPolicy(policy);
      const prior = policiesByHash.get(decoded.policyHash);
      if (prior !== undefined) { valid = false; add(reasons, "duplicate-policy"); }
      policiesByHash.set(decoded.policyHash, decoded);
    } catch {
      valid = false; add(reasons, "invalid-policy");
    }
  }
  for (const lease of evidence.leases) {
    try {
      const decoded = decodeOracleRetentionLeaseReceipt(lease);
      const prior = leasesById.get(decoded.receiptId);
      if (prior !== undefined) { valid = false; add(reasons, "duplicate-lease"); }
      leasesById.set(decoded.receiptId, decoded);
    } catch {
      valid = false; add(reasons, "invalid-lease");
    }
  }
  for (const claim of evidence.claims) {
    let decoded: OracleArtifactResolutionClaimV1;
    try {
      decoded = decodeOracleArtifactResolutionClaim(claim);
    } catch {
      valid = false; add(reasons, "invalid-claim");
      continue;
    }
    const priorClaim = claimsByRef.get(decoded.artifactRefId);
    if (priorClaim !== undefined || !refsById.has(decoded.artifactRefId) || !policiesByHash.has(decoded.resolverPolicyHash)) { valid = false; add(reasons, "claim-join"); }
    claimsByRef.set(decoded.artifactRefId, decoded);
    const ref = refsById.get(decoded.artifactRefId);
    const lease = ref === undefined ? undefined : leasesById.get(ref.retentionLeaseReceiptId);
    if (
      lease === undefined
      || lease.storeIdentityHash !== ref?.immutableMirrorLocator.storeIdentityHash
      || lease.objectKey !== ref?.immutableMirrorLocator.objectKey
      || lease.contentSha256 !== ref?.contentSha256
      || !positiveHash(lease.issuerQualificationId)
      || !positiveHash(lease.qualificationRegistryRoot)
    ) { valid = false; add(reasons, "lease-join"); }
    if (decoded.outcome !== "content-observed" || decoded.observedMirror === null || ref === undefined) {
      valid = false; add(reasons, "claim-outcome");
      continue;
    }
    try {
      const bytes = decodeOracleArtifactBytes(decoded.observedMirror.bytes);
      if (
        bytes.byteLength.toString() !== decoded.observedMirror.byteLength
        || sha256Hex(bytes) !== decoded.observedMirror.contentSha256
        || decoded.observedMirror.contentSha256 !== ref.contentSha256
        || decoded.observedMirror.byteLength !== ref.byteLength
        || decoded.observedMirror.objectKey !== ref.immutableMirrorLocator.objectKey
      ) { valid = false; add(reasons, "mirror-binding"); }
    } catch {
      valid = false; add(reasons, "mirror-decode");
    }
  }
  for (const observation of evidence.observations) {
    for (const ref of observation.rawArtifactRefs) {
      if (!refsById.has(ref.artifactRefId)) { valid = false; add(reasons, "observation-ref"); }
    }
    for (const claimId of observation.observedClaimIds) {
      const claim = evidence.claims.find((item) => item.claimId === claimId);
      if (claim === undefined || !observation.rawArtifactRefs.some((ref) => ref.artifactRefId === claim.artifactRefId)) { valid = false; add(reasons, "observation-claim"); }
    }
  }
  const observe = <T>(refId: Hash, decode: (bytes: Uint8Array) => T): ObservedValueV1<T> | null => {
    const ref = refsById.get(refId);
    const claim = claimsByRef.get(refId);
    if (ref === undefined || claim === undefined || claim.observedMirror === null || claim.outcome !== "content-observed") return null;
    try {
      const bytes = decodeOracleArtifactBytes(claim.observedMirror.bytes);
      return { value: decode(bytes), claimId: claim.claimId };
    } catch {
      return null;
    }
  };
  const requireObserved = <T>(refId: Hash, decode: (bytes: Uint8Array) => T, path: string): T | null => {
    const observed = observe(refId, decode);
    if (observed === null) {
      add(reasons, `${path}-observation`);
      valid = false; add(reasons, "event-fact-decode");
      return null;
    }
    const observedInObservation = evidence.observations.some((observation) => observation.rawArtifactRefs.some((ref) => ref.artifactRefId === refId) && observation.observedClaimIds.includes(observed.claimId));
    if (!observedInObservation) {
      add(reasons, `${path}-independent-observation`);
      valid = false; add(reasons, "event-fact-join");
    }
    return observed.value;
  };
  if (evidence.facts.length !== input.events.length) {
    add(reasons, "event-fact-cardinality");
    return false;
  }
  for (const [index, event] of input.events.entries()) {
    let fact: ReturnType<typeof decodeOracleSixStepEventFact>;
    try {
      fact = decodeOracleSixStepEventFact(evidence.facts[index]);
    } catch {
      valid = false; add(reasons, "stage-fact-decode");
      continue;
    }
    const observedEvent = requireObserved(fact.eventArtifactRefId, decodeOracleEvidenceEvent, `event[${index}]`);
    const observedSemantic = requireObserved(fact.semanticArtifactRefId, decodeOracleSemanticArtifact, `semantic[${index}]`);
    const observedReceipt = requireObserved(fact.productionReceiptArtifactRefId, decodeOracleProductionReceipt, `receipt[${index}]`);
    if (observedEvent === null || observedSemantic === null || observedReceipt === null || !same(observedEvent, event) || !same(observedSemantic, input.semanticArtifacts[index]) || !same(observedReceipt, input.productionReceipts[index])) {
      valid = false;
      continue;
    }
    let facts: OracleSixStepStageFactsV1;
    try {
      facts = decodeOracleSixStepStageFacts(event.facts);
    } catch {
      valid = false;
      continue;
    }
    if (!same(facts, input.stageFacts[index])) { valid = false; add(reasons, "stage-fact-input-join"); }
    const rawBoundary = requireObserved(observedReceipt.rawBoundaryArtifactRef.artifactRefId, decodeOracleNativeBoundaryRecord, `raw[${index}]`);
    if (rawBoundary === null || rawBoundary.stageId !== facts.stageId) {
      valid = false; add(reasons, "raw-boundary-join");
    } else {
      rawPayloadsByEvent.set(event.eventId, rawBoundary.payload);
    }
    try {
      const stageInput = decodeOracleSixStepStageInput(event.inputs, `event[${index}].inputs`);
      const witnessArtifactRefIds = oracleWitnessArtifactRefIds(facts);
      const expectedSemanticInputs = [observedReceipt.rawBoundaryArtifactRef.artifactRefId, ...witnessArtifactRefIds];
      if (!same(event.inputSchema, ORACLE_STAGE_INPUT_SCHEMA_REF)
        || stageInput.stageId !== facts.stageId
        || stageInput.rawBoundaryArtifactRefId !== observedReceipt.rawBoundaryArtifactRef.artifactRefId
        || !same(stageInput.orderedWitnessArtifactRefIds, witnessArtifactRefIds)
        || !same(stageInput.parentEventIds, event.parentEventIds)
        || !same(observedSemantic.inputArtifactIds, expectedSemanticInputs)
        || !same(event.artifactLineage.inputArtifactIds, expectedSemanticInputs)) {
        valid = false; add(reasons, "semantic-input-closure");
      }
    } catch {
      valid = false; add(reasons, "stage-input-decode");
    }
    const witnesses: readonly [OracleWitnessV1, string][] = (() => {
      switch (facts.stageId) {
        case "universe_instance": return [[facts.candidatePartition, "candidate-partition"], [facts.instancePublication, "instance-publication"], [facts.identityProof, "identity-proof"], [facts.sourceCoverage, "source-coverage"]];
        case "edge_ready_generation": return [[facts.instancePublication, "instance-publication"], [facts.edge, "edge"], [facts.coverage, "coverage"], [facts.memoReuseProof, "memo-reuse-proof"]];
        case "planner_consumption": return [[facts.routeSet, "route-set"], [facts.coarseProjection, "coarse-projection"], [facts.admissionReceipt, "admission-receipt"]];
        case "current_source_exact": return [[facts.exactOutput, "exact-output"]];
        case "execution_program": return [[facts.program, "program"], [facts.preCalls, "pre-calls"], [facts.observationPairs, "observation-pairs"], [facts.actionOwner, "action-owner"]];
        case "final_simulation": return [[facts.finalSimulationReceipt, "final-simulation-receipt"], [facts.economicReceipt, "economic-receipt"], [facts.safetyReceipt, "safety-receipt"]];
      }
    })();
    const payloads: Record<string, Readonly<Record<string, CanonicalJson>>> = {};
    for (const [witness, role] of witnesses) {
      const witnessStageId = facts.stageId === "edge_ready_generation" && role === "instance-publication" ? "universe_instance" : facts.stageId;
      const content = requireObserved(witness.artifactRefId, decodeOracleWitnessContent, `witness[${index}].${role}`);
      if (content === null || content.stageId !== witnessStageId || content.role !== role || oracleWitnessContentRoot(content) !== witness.contentRoot) valid = false;
      else payloads[role] = content.payload;
    }
    witnessPayloadsByEvent.set(event.eventId, Object.freeze(payloads));
  }
  const expectedRefIds = new Set<Hash>();
  for (const index of input.events.keys()) {
    const fact = evidence.facts[index];
    const stageFacts = input.stageFacts[index];
    const receipt = input.productionReceipts[index];
    if (fact === undefined || stageFacts === undefined || receipt === undefined) continue;
    try {
      const decodedFact = decodeOracleSixStepEventFact(fact);
      expectedRefIds.add(decodedFact.eventArtifactRefId);
      expectedRefIds.add(decodedFact.semanticArtifactRefId);
      expectedRefIds.add(decodedFact.productionReceiptArtifactRefId);
      expectedRefIds.add(receipt.rawBoundaryArtifactRef.artifactRefId);
      expectedRefIds.add(receipt.logRangeArtifactRef.artifactRefId);
      for (const refId of oracleWitnessArtifactRefIds(stageFacts)) expectedRefIds.add(refId);
    } catch {
      valid = false; add(reasons, "denominator-decode");
    }
  }
  const expectedIds = [...expectedRefIds].sort();
  if (!same([...refsById.keys()].sort(), expectedIds)) { valid = false; add(reasons, "ref-denominator"); }
  if (!same([...claimsByRef.keys()].sort(), expectedIds)) { valid = false; add(reasons, "claim-denominator"); }
  const expectedPolicyHashes = [...new Set([...refsById.values()].map((ref) => ref.resolverPolicyHash))].sort();
  if (!same([...policiesByHash.keys()].sort(), expectedPolicyHashes)) { valid = false; add(reasons, "policy-denominator"); }
  const expectedLeaseIds = [...new Set([...refsById.values()].map((ref) => ref.retentionLeaseReceiptId))].sort();
  if (!same([...leasesById.keys()].sort(), expectedLeaseIds)) { valid = false; add(reasons, "lease-denominator"); }
  if (evidence.observations.length !== 1) {
    valid = false; add(reasons, "observation-denominator");
  } else {
    const observation = evidence.observations[0]!;
    const observedIds = observation.rawArtifactRefs.map((ref) => ref.artifactRefId).sort();
    const expectedClaimIds = [...claimsByRef.values()].map((claim) => claim.claimId).sort();
    if (!same(observedIds, expectedIds)
      || !same(observation.observedClaimIds.slice().sort(), expectedClaimIds)
      || observation.rawArtifactRefs.some((ref) => !same(refsById.get(ref.artifactRefId), ref))) {
      valid = false; add(reasons, "observation-complete-join");
    }
  }
  if (!valid && reasons.length === 0) add(reasons, "evidence-envelope-invalid");
  return valid;
}

function stageFactsByEvent(
  events: readonly OracleEvidenceEventV1[],
  facts: readonly OracleSixStepStageFactsV1[],
): Map<Hash, OracleSixStepStageFactsV1> | null {
  if (facts.length !== events.length) return null;
  const output = new Map<Hash, OracleSixStepStageFactsV1>();
  for (const [index, event] of events.entries()) {
    const value = facts[index];
    if (value === undefined || value.stageId !== event.stage.id || !same(event.factSchema, ORACLE_STAGE_FACTS_SCHEMA_REF)) return null;
    if (output.has(event.eventId)) return null;
    output.set(event.eventId, value);
  }
  return output;
}

function assertArtifactReceiptBindings(
  events: readonly OracleEvidenceEventV1[],
  artifacts: readonly OracleSemanticArtifactV1[],
  receipts: readonly OracleProductionReceiptV1[],
  reasons: string[],
): void {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const receiptsById = new Map(receipts.map((receipt) => [receipt.receiptId, receipt]));
  for (const event of events) {
    const artifact = artifactsById.get(event.artifactLineage.outputArtifactId);
    const receipt = receiptsById.get(event.artifactLineage.productionReceiptId);
    if (artifact === undefined || receipt === undefined) {
      add(reasons, "artifact-or-receipt-missing");
      continue;
    }
    if (receipt.artifactId !== artifact.artifactId || event.outputHash !== artifact.canonicalPayloadHash) {
      add(reasons, "artifact-or-receipt-binding");
    }
    try {
      assertOracleEvidenceEventMatchesReceipt(event, receipt);
    } catch {
      add(reasons, "production-receipt-binding");
    }
  }
}

function validateStageFacts(
  events: readonly OracleEvidenceEventV1[],
  factsById: ReadonlyMap<Hash, OracleSixStepStageFactsV1>,
  reasons: string[],
): void {
  for (const event of events) {
    const facts = factsById.get(event.eventId);
    if (facts === undefined) {
      add(reasons, "stage-facts-missing");
      continue;
    }
    switch (facts.stageId) {
      case "universe_instance":
        if (!positiveWitness(facts.candidatePartition) || !positiveWitness(facts.instancePublication) || !positiveWitness(facts.identityProof) || !positiveWitness(facts.sourceCoverage)) add(reasons, "stage1-facts");
        break;
      case "edge_ready_generation":
        if (!positiveWitness(facts.instancePublication) || !positiveWitness(facts.edge) || !positiveWitness(facts.coverage) || facts.generationId !== event.scope.generationId || !positiveWitness(facts.memoReuseProof)) add(reasons, "stage2-facts");
        break;
      case "planner_consumption":
        if (facts.orderedInstanceBindings.length === 0 || oracleOrderedInstanceBindingsRoot(facts.orderedInstanceBindings) !== facts.orderedInstanceBindingsRoot || !positiveWitness(facts.routeSet) || !positiveWitness(facts.coarseProjection) || !positiveWitness(facts.admissionReceipt)) add(reasons, "stage3-facts");
        break;
      case "current_source_exact":
        if (facts.fallback !== false || !positiveWitness(facts.exactOutput)) add(reasons, "stage4-facts");
        break;
      case "execution_program":
        if (facts.fallback !== false || !positiveWitness(facts.program) || !positiveWitness(facts.preCalls) || !positiveWitness(facts.observationPairs) || !positiveWitness(facts.actionOwner)) add(reasons, "stage5-facts");
        break;
      case "final_simulation":
        if (facts.dryRun !== true || !positiveWitness(facts.finalSimulationReceipt) || !positiveWitness(facts.economicReceipt) || !positiveWitness(facts.safetyReceipt)) add(reasons, "stage6-facts");
        break;
    }
  }
}

function oraclePayloadRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function oracleExactPayloadKeys(value: unknown, keys: readonly string[]): boolean {
  const record = oraclePayloadRecord(value);
  return record !== null && same(Object.keys(record).sort(), [...keys].sort());
}

function oraclePositiveHash(value: unknown): value is Hash {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0+$/.test(value);
}

function oracleUnsigned(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function oracleDomainHash(domain: string, body: unknown, expected: unknown): boolean {
  if (!oraclePositiveHash(expected)) return false;
  try { return hashDomain(domain, body as CanonicalJson) === expected; } catch { return false; }
}

function oracleAsset(value: unknown, chainId: unknown): boolean {
  const asset = oraclePayloadRecord(value);
  const identity = oraclePayloadRecord(asset?.identity);
  if (asset === null || identity === null
    || !oracleExactPayloadKeys(asset, ["identity", "assetRef"])
    || !oracleExactPayloadKeys(identity, ["chainId", "kind", "address"])
    || oracleUnsigned(chainId) === null || oracleUnsigned(identity?.chainId) === null || identity?.chainId !== chainId
    || (identity.kind !== "native" && identity.kind !== "erc20")) return false;
  if (identity.kind === "native" ? identity.address !== null : typeof identity.address !== "string" || !/^0x[0-9a-f]{40}$/.test(identity.address) || /^0x0+$/.test(identity.address)) return false;
  return oracleDomainHash("aloha/asset-ref/v1", identity, asset?.assetRef);
}

function oracleEffectAccount(value: unknown): boolean {
  return typeof value === "string"
    ? /^0x[0-9a-f]{40}$/.test(value)
    : oracleExactPayloadKeys(value, ["kind"]) && oraclePayloadRecord(value)?.kind === "observed-sender";
}

function oracleEffectCaller(value: unknown): boolean {
  const caller = oraclePayloadRecord(value);
  return oracleExactPayloadKeys(caller, ["ref", "executionMode"])
    && oracleEffectAccount(caller?.ref)
    && (caller?.executionMode === "top-level" || caller?.executionMode === "impersonated-call-frame");
}

function oracleEffectTransport(value: unknown): boolean {
  const transport = oraclePayloadRecord(value);
  if (!oracleExactPayloadKeys(transport, ["caller", "preCalls", "observeTokenBalances", "observeLogs"])
    || !oracleEffectCaller(transport?.caller) || !Array.isArray(transport?.preCalls)
    || !Array.isArray(transport?.observeTokenBalances) || typeof transport?.observeLogs !== "boolean") return false;
  for (const raw of transport.preCalls) {
    const item = oraclePayloadRecord(raw);
    if (!oracleExactPayloadKeys(item, ["caller", "to", "data"]) || !oracleEffectCaller(item?.caller)
      || typeof item?.to !== "string" || !/^0x[0-9a-f]{40}$/.test(item.to)
      || typeof item?.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(item.data)) return false;
  }
  const observations = new Set<string>();
  for (const raw of transport.observeTokenBalances) {
    const item = oraclePayloadRecord(raw);
    if (!oracleExactPayloadKeys(item, ["token", "account"]) || typeof item?.token !== "string"
      || !/^0x[0-9a-f]{40}$/.test(item.token) || !oracleEffectAccount(item.account)) return false;
    const identity = encodeCanonicalJson(item);
    if (observations.has(identity)) return false;
    observations.add(identity);
  }
  return true;
}

interface OracleObservedEffectsV1 {
  readonly gasUsed: bigint;
  readonly before: ReadonlyMap<string, bigint>;
  readonly after: ReadonlyMap<string, bigint>;
}

interface OracleRouteSafetyV1 {
  readonly routeProof: Readonly<{
    readonly objectiveRef: Hash;
    readonly actionHashes: readonly Hash[];
    readonly executionReceiptHash: Hash;
    readonly effectsHash: Hash;
    readonly deltas: readonly Readonly<{
      readonly assetRef: Hash;
      readonly before: string;
      readonly after: string;
      readonly delta: string;
    }>[];
  }>;
  readonly actions: readonly Readonly<{
    readonly familyDefinitionHash: Hash;
    readonly actionOwnerId: string;
    readonly actionOwnerRef: Hash;
    readonly actionHash: Hash;
    readonly obligationRoot: Hash;
  }>[];
}

function oracleTokenSnapshot(value: unknown): ReadonlyMap<string, bigint> | null {
  if (!Array.isArray(value)) return null;
  const result = new Map<string, bigint>();
  for (const raw of value) {
    const row = oraclePayloadRecord(raw);
    if (!oracleExactPayloadKeys(row, ["token", "account", "balance"])
      || typeof row?.token !== "string" || !/^0x[0-9a-f]{40}$/.test(row.token)
      || typeof row?.account !== "string" || !/^0x[0-9a-f]{40}$/.test(row.account)) return null;
    const balance = oracleUnsigned(row.balance);
    const identity = `${row.token}\u0000${row.account}`;
    if (balance === null || result.has(identity)) return null;
    result.set(identity, balance);
  }
  return result;
}

function oracleRecomputeWorker(
  finalFacts: Readonly<Record<string, unknown>> | null,
  generationId: unknown,
  source: unknown,
  programHash: unknown,
  simulation: Readonly<Record<string, unknown>> | null,
  evaluatorBinding: SixStepReferenceInputV1["economicEvaluatorBinding"],
): OracleObservedEffectsV1 | null {
  const worker = oraclePayloadRecord(finalFacts?.workerReceipt);
  const projection = oraclePayloadRecord(finalFacts?.projection);
  const observedQualification = oraclePayloadRecord(finalFacts?.executorQualification);
  const expectedQualification = oraclePayloadRecord(evaluatorBinding.executorQualification);
  const effects = oraclePayloadRecord(worker?.effects);
  const keys = ["requestId", "attemptId", "ownerRef", "generationId", "authority", "inputHash", "deadlineAtMs", "authorityRoot", "workerEpoch", "executorSessionHash", "engine", "engineBuildFingerprint", "caller", "observeAccounts", "source", "programHash", "status", "output", "effects", "executionReceiptHash"];
  if (Object.prototype.hasOwnProperty.call(worker ?? {}, "effectTransport")) keys.push("effectTransport");
  const authority = oraclePayloadRecord(worker?.authority);
  const simulationFact = oraclePayloadRecord(simulation?.simulation);
  if (!oracleExactPayloadKeys(finalFacts, ["kind", "executorQualification", "projection", "workerReceipt"])
    || finalFacts?.kind !== "aloha.qualified-final-simulation-owner-facts-v1"
    || !oracleExactPayloadKeys(observedQualification, ["engineBuildFingerprint", "executableFingerprint", "qualifiedExecutorRegistryRoot", "selectedExecutorLeafHash", "releaseRoleManifestRoot"])
    || !oracleExactPayloadKeys(expectedQualification, ["executorKind", "engineBuildFingerprint", "executableFingerprint", "qualifiedExecutorRegistryRoot", "selectedExecutorLeafHash", "releaseRoleManifestRoot"])
    || expectedQualification?.executorKind !== "revm"
    || observedQualification?.engineBuildFingerprint !== expectedQualification.engineBuildFingerprint
    || observedQualification?.executableFingerprint !== expectedQualification.executableFingerprint
    || observedQualification?.qualifiedExecutorRegistryRoot !== expectedQualification.qualifiedExecutorRegistryRoot
    || observedQualification?.selectedExecutorLeafHash !== expectedQualification.selectedExecutorLeafHash
    || observedQualification?.releaseRoleManifestRoot !== expectedQualification.releaseRoleManifestRoot
    || !oracleExactPayloadKeys(worker, keys) || !oracleExactPayloadKeys(effects, ["format", "bytes", "observedAccounts", "effectsHash"])
    || worker?.generationId !== generationId || !same(worker?.source, source) || worker?.programHash !== programHash
    || worker?.status !== "returned" || worker?.engine !== expectedQualification.executorKind
    || worker?.engineBuildFingerprint !== expectedQualification.engineBuildFingerprint || authority === null
    || worker?.authorityRoot !== authority.authorityRoot || worker?.workerEpoch !== authority.workerEpoch
    || worker?.executorSessionHash !== authority.executorSessionHash
    || typeof worker?.deadlineAtMs !== "number" || !Number.isFinite(worker.deadlineAtMs)
    || effects?.format !== "revm-effects-v1" || typeof effects.bytes !== "string" || !Array.isArray(effects.observedAccounts)
    || !same(effects.observedAccounts, worker?.observeAccounts)
    || !oracleDomainHash("aloha/revm-effects-wire/v1", { format: effects.format, bytes: effects.bytes, observedAccounts: effects.observedAccounts }, effects.effectsHash)
    || effects.effectsHash !== simulation?.effectsHash || !same(effects, simulationFact?.effects)) return null;
  const receiptPayload = {
    requestId: worker.requestId,
    workerEpoch: worker.workerEpoch,
    ownerRef: worker.ownerRef,
    generationId: worker.generationId,
    attemptId: worker.attemptId,
    authority: worker.authority,
    inputHash: worker.inputHash,
    deadlineAtMs: worker.deadlineAtMs,
    source: worker.source,
    caller: worker.caller,
    observeAccounts: worker.observeAccounts,
    programHash: worker.programHash,
    status: worker.status,
    output: worker.output,
    effects: worker.effects,
    ...(Object.prototype.hasOwnProperty.call(worker, "effectTransport") ? { effectTransport: worker.effectTransport } : {}),
  };
  if (!oracleDomainHash("aloha/revm-execution-receipt/v1", receiptPayload, worker.executionReceiptHash)
    || worker.executionReceiptHash !== simulationFact?.executionReceiptHash
    || !same(worker.effectTransport, projection?.effectTransport)) return null;
  let decoded: Readonly<Record<string, unknown>> | null;
  try { decoded = oraclePayloadRecord(decodeCanonicalJson(effects.bytes)); } catch { return null; }
  if (!oracleExactPayloadKeys(decoded, ["accounts", "before", "gasUsed", "output", "status", "preCalls", "tokenBalancesBefore", "tokenBalancesAfter"])
    || decoded?.status !== "returned" || decoded.output !== worker.output) return null;
  const gasUsed = oracleUnsigned(decoded.gasUsed);
  const before = oracleTokenSnapshot(decoded.tokenBalancesBefore);
  const after = oracleTokenSnapshot(decoded.tokenBalancesAfter);
  if (gasUsed === null || gasUsed <= 0n || before === null || after === null) return null;
  return { gasUsed, before, after };
}

function oracleEconomicReceipt(value: unknown, chainId: unknown): boolean {
  const receipt = oraclePayloadRecord(value);
  const valuation = oraclePayloadRecord(receipt?.valuationFact);
  if (!oracleExactPayloadKeys(receipt, ["kind", "gasUsed", "nextBlockBaseFeePerGas", "priorityFeePerGas", "effectiveGasPrice", "gasCostNative", "profitAsset", "grossProfitAmount", "valuationNumerator", "valuationDenominator", "valuationFactRoot", "valuationFact", "grossProfitNative", "bidCostNative", "netProfitNative", "minNetProfitNative", "verdict", "receiptRoot"])
    || receipt?.kind !== "aloha.economic-receipt-v1" || receipt?.verdict !== "positive-net-ev"
    || !oraclePositiveHash(receipt?.valuationFactRoot)
    || !oracleExactPayloadKeys(valuation, ["kind", "ownerRef", "generationId", "source", "assetRef", "numerator", "denominator", "ownerImplementationHash", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot", "qualificationLeafDigest", "currentSourceObservationRoot", "factRoot"])
    || valuation?.kind !== "aloha.economic-valuation-fact-v1"
    || oracleUnsigned(valuation.numerator) === null || oracleUnsigned(valuation.denominator) === null
    || oracleUnsigned(valuation.numerator)! <= 0n || oracleUnsigned(valuation.denominator)! <= 0n
    || receipt.valuationFactRoot !== valuation.factRoot || !oraclePositiveHash(valuation.ownerRef) || !oraclePositiveHash(valuation.ownerImplementationHash)
    || !oraclePositiveHash(valuation.valuationOwnerRegistryRoot) || !oraclePositiveHash(valuation.qualifiedValuationOwnerSetRoot)
    || !oraclePositiveHash(valuation.qualificationLeafDigest) || !oraclePositiveHash(valuation.currentSourceObservationRoot)
    || !oracleDomainHash("aloha/economic-valuation-fact/v1", {
      kind: valuation.kind,
      ownerRef: valuation.ownerRef,
      generationId: valuation.generationId,
      source: valuation.source,
      assetRef: valuation.assetRef,
      numerator: valuation.numerator,
      denominator: valuation.denominator,
      ownerImplementationHash: valuation.ownerImplementationHash,
      valuationOwnerRegistryRoot: valuation.valuationOwnerRegistryRoot,
      qualifiedValuationOwnerSetRoot: valuation.qualifiedValuationOwnerSetRoot,
      qualificationLeafDigest: valuation.qualificationLeafDigest,
      currentSourceObservationRoot: valuation.currentSourceObservationRoot,
    }, valuation.factRoot)
    || !oracleAsset(receipt?.profitAsset, chainId)) return false;
  const names = ["gasUsed", "nextBlockBaseFeePerGas", "priorityFeePerGas", "effectiveGasPrice", "gasCostNative", "grossProfitAmount", "valuationNumerator", "valuationDenominator", "grossProfitNative", "bidCostNative", "netProfitNative", "minNetProfitNative"] as const;
  const n = Object.fromEntries(names.map((name) => [name, oracleUnsigned(receipt[name])])) as Record<(typeof names)[number], bigint | null>;
  if (names.some((name) => n[name] === null)) return false;
  if (n.gasUsed! <= 0n || n.grossProfitAmount! <= 0n || n.valuationNumerator! <= 0n || n.valuationDenominator! <= 0n
    || n.effectiveGasPrice !== n.nextBlockBaseFeePerGas! + n.priorityFeePerGas!
    || n.gasCostNative !== n.gasUsed! * n.effectiveGasPrice!
    || n.grossProfitNative !== n.grossProfitAmount! * n.valuationNumerator! / n.valuationDenominator!
    || n.netProfitNative !== n.grossProfitNative! - n.gasCostNative! - n.bidCostNative!
    || n.netProfitNative! <= n.minNetProfitNative! || n.netProfitNative! <= 0n) return false;
  const { receiptRoot: _root, ...body } = receipt;
  return oracleDomainHash("aloha/economic-receipt/v1", body, receipt.receiptRoot);
}

function oracleEconomicMatchesEffects(input: Readonly<{
  receipt: unknown;
  observed: OracleObservedEffectsV1;
  executionFacts: Readonly<Record<string, unknown>> | null;
  projection: Readonly<Record<string, unknown>> | null;
  evaluatorBinding: SixStepReferenceInputV1["economicEvaluatorBinding"];
  objectiveRef: unknown;
  generationId: unknown;
  source: unknown;
}>): boolean {
  const receipt = oraclePayloadRecord(input.receipt);
  const asset = oraclePayloadRecord(receipt?.profitAsset);
  const valuation = oraclePayloadRecord(receipt?.valuationFact);
  const template = input.evaluatorBinding.objectiveTemplates.map(oraclePayloadRecord)
    .find(candidate => candidate?.objectiveRef === input.objectiveRef);
  const valuationOwner = input.evaluatorBinding.valuationOwners.map(oraclePayloadRecord)
    .find(candidate => candidate?.ownerRef === template?.valuationOwnerRef);
  const projectionInput = oraclePayloadRecord(input.projection?.input);
  const block = oraclePayloadRecord(projectionInput?.block);
  const valuationNumerator = oracleUnsigned(receipt?.valuationNumerator);
  const valuationDenominator = oracleUnsigned(receipt?.valuationDenominator);
  const minNetGain = oracleUnsigned(template?.minNetGain);
  const valuationOracle = resolveSixStepReferenceValuationOracle(valuationOwner?.ownerRef);
  if (!oracleExactPayloadKeys(template, ["objectiveRef", "profitAsset", "profitAccount", "minNetGain", "maxGas", "maxValueAtRisk", "priorityFeePerGas", "bidCostNative", "valuationOwnerRef"])
    || !same(template?.profitAsset, receipt?.profitAsset)
    || typeof template?.profitAccount !== "string" || !/^0x[0-9a-f]{40}$/.test(template.profitAccount)
    || !oracleAsset(template?.profitAsset, oraclePayloadRecord(input.source)?.chainId)
    || valuationOwner === null || valuationOwner === undefined
    || !oracleExactPayloadKeys(valuationOwner, ["ownerRef", "implementationHash", "factSchemaRef", "implementationClosureRoot", "qualificationLeafDigest", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot"])
    || valuationOracle === null
    || template?.valuationOwnerRef !== valuationOracle.ownerRef
    || valuation?.generationId !== input.generationId || !same(valuation?.source, input.source)
    || valuation?.assetRef !== asset?.assetRef
    || valuation?.ownerRef !== template?.valuationOwnerRef
    || valuation?.ownerRef !== valuationOwner.ownerRef
    || valuation?.ownerImplementationHash !== valuationOwner.implementationHash
    || valuation?.valuationOwnerRegistryRoot !== valuationOwner.valuationOwnerRegistryRoot
    || valuation?.qualifiedValuationOwnerSetRoot !== valuationOwner.qualifiedValuationOwnerSetRoot
    || valuation?.qualificationLeafDigest !== valuationOwner.qualificationLeafDigest
    || !valuationOracle.evaluate({
      profitAsset: asset ?? Object.freeze({}),
      descriptor: valuationOwner,
      fact: valuation ?? Object.freeze({}),
      generationId: input.generationId,
      source: input.source,
    })
    || oracleUnsigned(block?.baseFeePerGas) === null || receipt?.nextBlockBaseFeePerGas !== block?.baseFeePerGas
    || receipt?.priorityFeePerGas !== template.priorityFeePerGas || receipt?.bidCostNative !== template.bidCostNative
    || valuationNumerator === null || valuationDenominator === null || valuationDenominator <= 0n
    || minNetGain === null
    || receipt?.minNetProfitNative !== (minNetGain * valuationNumerator / valuationDenominator).toString(10)
    || receipt?.valuationNumerator !== valuation?.numerator || receipt?.valuationDenominator !== valuation?.denominator
    || oracleUnsigned(receipt?.gasUsed) !== input.observed.gasUsed) return false;
  const refs = Array.isArray(input.executionFacts?.routeAssetReferences)
    ? input.executionFacts.routeAssetReferences.map(oraclePayloadRecord)
    : [];
  if (refs.length === 0 || new Set(refs.map(ref => ref?.assetRef)).size !== refs.length
    || !refs.some(ref => ref?.assetRef === asset?.assetRef && same(ref, receipt?.profitAsset))) return false;
  let terminalProfit: bigint | null = null;
  for (const ref of refs) {
    const token = oraclePayloadRecord(ref?.identity);
    if (token?.kind !== "erc20" || typeof token.address !== "string" || !/^0x[0-9a-f]{40}$/.test(token.address)) return false;
    const key = `${token.address}\u0000${template.profitAccount}`;
    const before = input.observed.before.get(key);
    const after = input.observed.after.get(key);
    if (before === undefined || after === undefined) return false;
    const delta = after - before;
    if (ref?.assetRef === asset?.assetRef) terminalProfit = delta;
    else if (delta !== 0n) return false;
  }
  return terminalProfit !== null && terminalProfit > 0n && receipt?.grossProfitAmount === terminalProfit.toString(10);
}

function oracleRecomputeRouteSafety(input: Readonly<{
  executionFacts: Readonly<Record<string, unknown>> | null;
  finalFacts: Readonly<Record<string, unknown>> | null;
  evaluatorBinding: SixStepReferenceInputV1["economicEvaluatorBinding"];
  objectiveRef: unknown;
  observed: OracleObservedEffectsV1;
}>): OracleRouteSafetyV1 | null {
  if (!oraclePositiveHash(input.objectiveRef)) return null;
  const template = input.evaluatorBinding.objectiveTemplates.map(oraclePayloadRecord)
    .find(value => value?.objectiveRef === input.objectiveRef);
  if (!oracleExactPayloadKeys(template, ["objectiveRef", "profitAsset", "profitAccount", "minNetGain", "maxGas", "maxValueAtRisk", "priorityFeePerGas", "bidCostNative", "valuationOwnerRef"])
    || typeof template?.profitAccount !== "string" || !/^0x[0-9a-f]{40}$/.test(template.profitAccount)) return null;
  const rawActions = input.executionFacts?.actionOwners;
  if (!Array.isArray(rawActions) || rawActions.length === 0) return null;
  const actions: Array<{
    readonly familyDefinitionHash: Hash;
    readonly actionOwnerId: string;
    readonly actionOwnerRef: Hash;
    readonly actionHash: Hash;
    readonly obligationRoot: Hash;
    readonly input: Readonly<{ readonly assetRef: Hash; readonly amount: bigint }>;
    readonly output: Readonly<{ readonly assetRef: Hash; readonly amount: bigint }>;
  }> = [];
  for (const raw of rawActions) {
    const action = oraclePayloadRecord(raw);
    if (!oracleExactPayloadKeys(action, ["familyDefinitionHash", "routeBindingHash", "actionOwnerId", "actionOwnerRef", "actionHash", "actionArtifactHash", "exactEvaluationHash", "payload", "payloadHash", "inputs", "outputs", "obligationRoot"])
      || !oraclePositiveHash(action?.familyDefinitionHash) || typeof action?.actionOwnerId !== "string" || action.actionOwnerId.length === 0
      || !oraclePositiveHash(action?.actionOwnerRef) || !oraclePositiveHash(action?.actionHash) || !oraclePositiveHash(action?.obligationRoot)
      || !Array.isArray(action?.inputs) || action.inputs.length !== 1
      || !Array.isArray(action?.outputs) || action.outputs.length !== 1) return null;
    const amount = (value: unknown): Readonly<{ readonly assetRef: Hash; readonly amount: bigint }> | null => {
      const item = oraclePayloadRecord(value);
      const quantity = oracleUnsigned(item?.amount);
      return oracleExactPayloadKeys(item, ["assetRef", "amount"]) && oraclePositiveHash(item?.assetRef) && quantity !== null && quantity > 0n
        ? Object.freeze({ assetRef: item.assetRef, amount: quantity })
        : null;
    };
    const actionInput = amount(action.inputs[0]);
    const actionOutput = amount(action.outputs[0]);
    if (actionInput === null || actionOutput === null) return null;
    actions.push(Object.freeze({
      familyDefinitionHash: action.familyDefinitionHash,
      actionOwnerId: action.actionOwnerId,
      actionOwnerRef: action.actionOwnerRef,
      actionHash: action.actionHash,
      obligationRoot: action.obligationRoot,
      input: actionInput,
      output: actionOutput,
    }));
  }
  for (let index = 1; index < actions.length; index += 1) {
    if (actions[index - 1]!.output.assetRef !== actions[index]!.input.assetRef
      || actions[index - 1]!.output.amount !== actions[index]!.input.amount) return null;
  }
  const profitAsset = oraclePayloadRecord(template.profitAsset);
  if (!oraclePositiveHash(profitAsset?.assetRef)
    || actions[0]!.input.assetRef !== profitAsset.assetRef
    || actions[actions.length - 1]!.output.assetRef !== profitAsset.assetRef) return null;
  const references = Array.isArray(input.executionFacts?.routeAssetReferences)
    ? input.executionFacts.routeAssetReferences.map(oraclePayloadRecord)
    : [];
  const referencesByAsset = new Map<Hash, Readonly<Record<string, unknown>>>();
  for (const reference of references) {
    if (!oraclePositiveHash(reference?.assetRef) || referencesByAsset.has(reference.assetRef)) return null;
    referencesByAsset.set(reference.assetRef, reference!);
  }
  const routeAssetRefs: Hash[] = [];
  for (const action of actions) {
    for (const assetRef of [action.input.assetRef, action.output.assetRef]) {
      if (!routeAssetRefs.includes(assetRef)) routeAssetRefs.push(assetRef);
    }
  }
  const deltas: Array<Readonly<{ readonly assetRef: Hash; readonly before: string; readonly after: string; readonly delta: string }>> = [];
  for (const assetRef of routeAssetRefs) {
    const reference = referencesByAsset.get(assetRef);
    const identity = oraclePayloadRecord(reference?.identity);
    if (reference === undefined || identity?.kind !== "erc20" || typeof identity.address !== "string" || !/^0x[0-9a-f]{40}$/.test(identity.address)) return null;
    const key = `${identity.address}\u0000${template.profitAccount}`;
    const before = input.observed.before.get(key);
    const after = input.observed.after.get(key);
    if (before === undefined || after === undefined) return null;
    const delta = after - before;
    if (assetRef !== profitAsset.assetRef && delta !== 0n) return null;
    deltas.push(Object.freeze({ assetRef, before: before.toString(10), after: after.toString(10), delta: delta.toString(10) }));
  }
  const worker = oraclePayloadRecord(input.finalFacts?.workerReceipt);
  const effects = oraclePayloadRecord(worker?.effects);
  if (!oraclePositiveHash(worker?.executionReceiptHash) || !oraclePositiveHash(effects?.effectsHash)) return null;
  return Object.freeze({
    routeProof: Object.freeze({
      objectiveRef: input.objectiveRef,
      actionHashes: Object.freeze(actions.map(action => action.actionHash)),
      executionReceiptHash: worker.executionReceiptHash,
      effectsHash: effects.effectsHash,
      deltas: Object.freeze(deltas),
    }),
    actions: Object.freeze(actions.map(action => Object.freeze({
      familyDefinitionHash: action.familyDefinitionHash,
      actionOwnerId: action.actionOwnerId,
      actionOwnerRef: action.actionOwnerRef,
      actionHash: action.actionHash,
      obligationRoot: action.obligationRoot,
    }))),
  });
}

function oracleQualifiedSafetyProfile(binding: SixStepReferenceInputV1["economicEvaluatorBinding"]): Readonly<{
  profile: Readonly<Record<string, unknown>>;
  claims: readonly Readonly<Record<string, unknown>>[];
  policies: readonly Readonly<Record<string, unknown>>[];
}> | null {
  const profile = oraclePayloadRecord(binding.safetyProfile);
  if (!oracleExactPayloadKeys(profile, ["schemaVersion", "kind", "profileRef", "requiredClaims", "qualifiedOwnerSetRoot", "profileCompositionRoot"])
    || profile?.schemaVersion !== 1 || profile?.kind !== "aloha.economic-safety-profile"
    || !oraclePositiveHash(profile.profileRef) || !oraclePositiveHash(profile.qualifiedOwnerSetRoot)
    || !Array.isArray(profile.requiredClaims) || profile.requiredClaims.length === 0) return null;
  const claims = profile.requiredClaims.map(oraclePayloadRecord);
  if (claims.some(claim => !oracleExactPayloadKeys(claim, ["claimSchemaRef", "ownerRef", "qualificationLeafDigest", "revmObservationSchemaRef"])
    || !oraclePositiveHash(claim?.claimSchemaRef) || !oraclePositiveHash(claim?.ownerRef)
    || !oraclePositiveHash(claim?.qualificationLeafDigest)
    || claim?.revmObservationSchemaRef !== ORACLE_ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF)) return null;
  for (let index = 1; index < claims.length; index += 1) {
    const left = claims[index - 1]!;
    const right = claims[index]!;
    if (`${left.ownerRef}\u0000${left.claimSchemaRef}` >= `${right.ownerRef}\u0000${right.claimSchemaRef}`) return null;
  }
  const profileBody = {
    schemaVersion: 1,
    kind: "aloha.economic-safety-profile",
    profileRef: profile.profileRef,
    requiredClaims: profile.requiredClaims,
    qualifiedOwnerSetRoot: profile.qualifiedOwnerSetRoot,
  };
  if (!oracleDomainHash("aloha/economic-safety-profile-composition/v1", profileBody, profile.profileCompositionRoot)) return null;
  const policies = binding.actionOwners.map(oraclePayloadRecord);
  if (policies.some(policy => !oracleExactPayloadKeys(policy, [
    "familyDefinitionHash", "ownerId", "ownerRef", "implementationHash", "schemaRef",
    "implementationClosureRoot", "claimSchemaRefs", "qualificationLeafDigest", "verifierHash",
  ]) || !oraclePositiveHash(policy?.familyDefinitionHash) || typeof policy?.ownerId !== "string" || policy.ownerId.length === 0
    || !oraclePositiveHash(policy?.ownerRef) || !oraclePositiveHash(policy?.implementationHash) || !oraclePositiveHash(policy?.schemaRef)
    || !oraclePositiveHash(policy?.implementationClosureRoot) || !oraclePositiveHash(policy?.qualificationLeafDigest)
    || !oraclePositiveHash(policy?.verifierHash) || !Array.isArray(policy?.claimSchemaRefs) || policy.claimSchemaRefs.length === 0)) return null;
  if (new Set(policies.map(policy => policy!.ownerRef)).size !== policies.length) return null;
  for (const policy of policies) {
    const schemaRefs = policy!.claimSchemaRefs as readonly unknown[];
    if (schemaRefs.some(schema => !oraclePositiveHash(schema))) return null;
    for (let index = 1; index < schemaRefs.length; index += 1) if (schemaRefs[index - 1]! >= schemaRefs[index]!) return null;
    const ownerClaims = claims.filter(claim => claim?.ownerRef === policy!.ownerRef);
    if (ownerClaims.length !== schemaRefs.length || ownerClaims.some((claim, index) =>
      claim?.claimSchemaRef !== schemaRefs[index] || claim?.qualificationLeafDigest !== policy!.qualificationLeafDigest)) return null;
  }
  if (new Set(claims.map(claim => claim!.ownerRef)).size !== policies.length
    || claims.some(claim => !policies.some(policy => policy!.ownerRef === claim!.ownerRef))) return null;
  return Object.freeze({ profile: profile!, claims: Object.freeze(claims as Readonly<Record<string, unknown>>[]), policies: Object.freeze(policies as Readonly<Record<string, unknown>>[]) });
}

function oracleEconomicSafety(input: Readonly<{
  evidence: unknown; economic: unknown; safetyWitness: unknown;
  executionEvidence: unknown; finalEvidence: unknown; program: unknown; simulation: unknown;
  correlationId: unknown; generationId: unknown; source: unknown; exactHash: unknown;
  evaluatorBinding: SixStepReferenceInputV1["economicEvaluatorBinding"];
}>): boolean {
  const evidence = oraclePayloadRecord(input.evidence);
  const executionEvidence = oraclePayloadRecord(input.executionEvidence);
  const finalEvidence = oraclePayloadRecord(input.finalEvidence);
  const executionFacts = oraclePayloadRecord(executionEvidence?.facts);
  const finalFacts = oraclePayloadRecord(finalEvidence?.facts);
  const program = oraclePayloadRecord(input.program);
  const simulation = oraclePayloadRecord(input.simulation);
  if (!oracleExactPayloadKeys(evidence, ["schemaVersion", "kind", "authorityRoot", "implementationHash", "releaseProvenanceHash", "correlationId", "generationId", "source", "objectiveRef", "exactHash", "programHash", "obligationRoot", "finalSimulationReceiptHash", "effectsHash", "executionOwnerEvidenceRoot", "finalSimulationOwnerEvidenceRoot", "executionOwnerFacts", "executionOwnerFactsRoot", "finalSimulationOwnerFacts", "finalSimulationOwnerFactsRoot", "declaredObligations", "declaredObligationSetRoot", "economic", "safety", "dryRun", "evidenceRoot"])
    || evidence?.schemaVersion !== 1 || evidence?.kind !== "aloha.economic-safety-finalization-evidence-v1" || evidence?.dryRun !== true
    || evidence.authorityRoot !== input.evaluatorBinding.authorityRoot
    || evidence.implementationHash !== input.evaluatorBinding.implementationHash
    || evidence.releaseProvenanceHash !== input.evaluatorBinding.releaseProvenanceHash
    || !oraclePositiveHash(evidence.objectiveRef)
    || evidence.correlationId !== input.correlationId || evidence.generationId !== input.generationId || !same(evidence.source, input.source)
    || evidence.exactHash !== input.exactHash || evidence.programHash !== program?.programHash || evidence.obligationRoot !== program?.obligationRoot
    || evidence.finalSimulationReceiptHash !== simulation?.receiptHash || evidence.effectsHash !== simulation?.effectsHash
    || evidence.executionOwnerEvidenceRoot !== executionEvidence?.evidenceRoot || evidence.finalSimulationOwnerEvidenceRoot !== finalEvidence?.evidenceRoot
    || !same(evidence.executionOwnerFacts, executionEvidence?.facts) || !same(evidence.finalSimulationOwnerFacts, finalEvidence?.facts)
    || !oracleDomainHash("aloha/economic-safety/execution-owner-facts/v1", evidence.executionOwnerFacts, evidence.executionOwnerFactsRoot)
    || !oracleDomainHash("aloha/economic-safety/final-simulation-owner-facts/v1", evidence.finalSimulationOwnerFacts, evidence.finalSimulationOwnerFactsRoot)) return false;
  const executionKeys = Object.prototype.hasOwnProperty.call(executionEvidence, "ownerObservation")
    ? ["schemaVersion", "kind", "correlationId", "generationId", "source", "routeHash", "exactHash", "programHash", "facts", "ownerObservation", "evidenceRoot"]
    : ["schemaVersion", "kind", "correlationId", "generationId", "source", "routeHash", "exactHash", "programHash", "facts", "evidenceRoot"];
  if (!oracleExactPayloadKeys(executionEvidence, executionKeys) || executionEvidence?.schemaVersion !== 1 || executionEvidence?.kind !== "aloha.execution-program-six-step-evidence-v1") return false;
  const { evidenceRoot: _executionRoot, ...executionBody } = executionEvidence;
  if (!oracleDomainHash("aloha/execution-program-six-step-evidence/v1", executionBody, executionEvidence.evidenceRoot)
    || !oracleExactPayloadKeys(finalEvidence, ["schemaVersion", "kind", "correlationId", "generationId", "source", "programHash", "finalSimulationReceiptHash", "facts", "evidenceRoot"])
    || finalEvidence?.schemaVersion !== 1 || finalEvidence?.kind !== "aloha.final-simulation-six-step-evidence-v1") return false;
  const { evidenceRoot: _finalRoot, ...finalBody } = finalEvidence;
  if (!oracleDomainHash("aloha/final-simulation-six-step-evidence/v1", finalBody, finalEvidence.evidenceRoot)) return false;
  if (!Array.isArray(evidence.declaredObligations) || evidence.declaredObligations.length === 0
    || !same(evidence.declaredObligations, executionFacts?.declaredObligations)
    || !oracleDomainHash("aloha/economic-safety/declared-obligation-set/v1", evidence.declaredObligations, evidence.declaredObligationSetRoot)) return false;
  const declarations = evidence.declaredObligations.map(oraclePayloadRecord);
  if (declarations.some((entry) => !oracleExactPayloadKeys(entry, ["obligationRef", "ownerRef", "policy"]) || !oraclePositiveHash(entry?.obligationRef) || !oraclePositiveHash(entry?.ownerRef) || entry?.policy !== "must-satisfy")) return false;
  if (new Set(declarations.map((entry) => entry!.obligationRef)).size !== declarations.length
    || !oracleDomainHash("aloha/search-runtime-obligation-root/v1", declarations.map((entry) => entry!.obligationRef), program?.obligationRoot)
    || executionFacts?.obligationRoot !== program?.obligationRoot) return false;
  const owners = Array.isArray(executionFacts?.actionOwners) ? executionFacts.actionOwners.map(oraclePayloadRecord) : [];
  for (const declaration of declarations) if (owners.filter((owner) => owner?.obligationRoot === declaration?.obligationRef && owner?.actionOwnerRef === declaration?.ownerRef).length !== 1) return false;
  const transport = program?.effectTransport;
  const caller = oraclePayloadRecord(oraclePayloadRecord(transport)?.caller);
  const projection = oraclePayloadRecord(finalFacts?.projection);
  const worker = oraclePayloadRecord(finalFacts?.workerReceipt);
  const workerEffects = oraclePayloadRecord(worker?.effects);
  if (!oracleEffectTransport(transport) || !same(simulation?.effectTransport, transport)
    || executionFacts?.callerMode !== caller?.executionMode
    || !same(executionFacts?.preCalls, oraclePayloadRecord(transport)?.preCalls)
    || !same(executionFacts?.observationPairs, oraclePayloadRecord(transport)?.observeTokenBalances)
    || executionFacts?.observeLogs !== oraclePayloadRecord(transport)?.observeLogs
    || !same(projection?.effectTransport, transport) || !same(worker?.effectTransport, transport)
    || workerEffects?.effectsHash !== simulation?.effectsHash) return false;
  const observed = oracleRecomputeWorker(finalFacts, input.generationId, input.source, program?.programHash, simulation, input.evaluatorBinding);
  if (observed === null) return false;
  if (!same(input.economic, evidence.economic)
    || !oracleEconomicReceipt(evidence.economic, oraclePayloadRecord(input.source)?.chainId)
    || !oracleEconomicMatchesEffects({
      receipt: evidence.economic,
      observed,
      executionFacts,
      projection,
      evaluatorBinding: input.evaluatorBinding,
      objectiveRef: evidence.objectiveRef,
      generationId: input.generationId,
      source: input.source,
    })) return false;
  const independentSafety = oracleRecomputeRouteSafety({
    executionFacts,
    finalFacts,
    evaluatorBinding: input.evaluatorBinding,
    objectiveRef: evidence.objectiveRef,
    observed,
  });
  if (independentSafety === null) return false;
  const qualified = oracleQualifiedSafetyProfile(input.evaluatorBinding);
  if (qualified === null) return false;
  const safety = oraclePayloadRecord(evidence.safety);
  if (!oracleExactPayloadKeys(safety, [
    "kind", "obligationRoot", "obligationReceipts", "obligationReceiptSetRoot", "safetyProfileRef", "safetyProfileRoot",
    "selectedRequiredClaims", "requiredClaimSetRoot", "revmObservationSchemaRef", "revmObservationRoot",
    "assetConservationProofRoot", "assetConservation", "verdict", "receiptRoot",
  ])
    || safety?.kind !== "aloha.final-safety-receipt-v1" || safety?.verdict !== "safe" || safety?.assetConservation !== "satisfied"
    || safety?.obligationRoot !== program?.obligationRoot
    || safety.safetyProfileRef !== qualified.profile.profileRef
    || safety.safetyProfileRoot !== qualified.profile.profileCompositionRoot
    || safety.revmObservationSchemaRef !== ORACLE_ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF
    || safety.assetConservationProofRoot !== hashDomain("aloha/economic-safety/asset-conservation-proof/v1", independentSafety.routeProof as unknown as CanonicalJson)
    || !Array.isArray(safety.selectedRequiredClaims)
    || !Array.isArray(safety.obligationReceipts)) return false;
  const selectedOwnerRefs = [...new Set(independentSafety.actions.map(action => action.actionOwnerRef))].sort();
  const selectedClaims = qualified.claims.filter(claim => selectedOwnerRefs.includes(claim.ownerRef as Hash));
  if (!same(safety.selectedRequiredClaims, selectedClaims)
    || !oracleDomainHash("aloha/economic-safety-selected-required-claim-set/v1", selectedClaims, safety.requiredClaimSetRoot)) return false;
  const workerReceipt = oraclePayloadRecord(finalFacts?.workerReceipt);
  const workerReceiptEffects = oraclePayloadRecord(workerReceipt?.effects);
  if (!oraclePositiveHash(workerReceipt?.executionReceiptHash) || !oraclePositiveHash(workerReceiptEffects?.effectsHash)
    || !oracleDomainHash("aloha/economic-safety/revm-observation/v1", {
      schemaRef: ORACLE_ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF,
      executorQualification: input.evaluatorBinding.executorQualification,
      source: input.source,
      executionReceiptHash: workerReceipt.executionReceiptHash,
      effectsHash: workerReceiptEffects.effectsHash,
    }, safety.revmObservationRoot)) return false;
  const receipts = safety.obligationReceipts.map(oraclePayloadRecord);
  if (receipts.some((receipt) => !oracleExactPayloadKeys(receipt, ["schemaRef", "ownerRef", "qualificationLeafDigest", "verifierHash", "subjectRoot", "proofRoot", "outcome", "receiptRoot"])
    || !oraclePositiveHash(receipt?.schemaRef) || !oraclePositiveHash(receipt?.ownerRef) || !oraclePositiveHash(receipt?.qualificationLeafDigest) || !oraclePositiveHash(receipt?.verifierHash)
    || !oraclePositiveHash(receipt?.subjectRoot) || !oraclePositiveHash(receipt?.proofRoot) || receipt?.outcome !== "satisfied")) return false;
  const receiptKeys = receipts.map(receipt => `${receipt?.subjectRoot}\u0000${receipt?.ownerRef}\u0000${receipt?.schemaRef}`);
  if (new Set(receiptKeys).size !== receipts.length) return false;
  for (const receipt of receipts) {
    const { receiptRoot: _root, ...body } = receipt!;
    if (!oracleDomainHash("aloha/safety-obligation-receipt/v1", body, receipt!.receiptRoot)) return false;
  }
  let expectedReceiptCount = 0;
  for (const declaration of declarations) {
    const action = independentSafety.actions.find(value => value.obligationRoot === declaration?.obligationRef && value.actionOwnerRef === declaration?.ownerRef);
    const policy = qualified.policies.find(value => value?.familyDefinitionHash === action?.familyDefinitionHash
      && value?.ownerId === action?.actionOwnerId && value?.ownerRef === action?.actionOwnerRef);
    const claims = selectedClaims.filter(claim => claim.ownerRef === declaration?.ownerRef);
    if (action === undefined || policy === undefined || claims.length === 0) return false;
    expectedReceiptCount += claims.length;
    for (const claim of claims) {
      if (receipts.filter((receipt) => receipt?.subjectRoot === declaration?.obligationRef
        && receipt?.ownerRef === declaration?.ownerRef
        && receipt?.schemaRef === claim.claimSchemaRef
        && receipt?.qualificationLeafDigest === claim.qualificationLeafDigest
        && receipt?.verifierHash === policy.verifierHash
        && receipt?.outcome === "satisfied").length !== 1) return false;
    }
  }
  if (receipts.length !== expectedReceiptCount) return false;
  if (!oracleDomainHash("aloha/safety-obligation-receipt-set/v1", receipts.map((receipt) => receipt!.receiptRoot), safety.obligationReceiptSetRoot)) return false;
  const { receiptRoot: _safetyRoot, ...safetyBody } = safety;
  if (!oracleDomainHash("aloha/final-safety-receipt/v1", safetyBody, safety.receiptRoot)
    || !same(input.safetyWitness, { safety: evidence.safety })) return false;
  const { evidenceRoot: _evidenceRoot, ...evidenceBody } = evidence;
  return oracleDomainHash("aloha/economic-safety-finalization-evidence/v1", evidenceBody, evidence.evidenceRoot);
}

function oraclePayload(
  payloads: OracleWitnessPayloadMapV1,
  event: OracleEvidenceEventV1,
  role: string,
): Readonly<Record<string, CanonicalJson>> | undefined {
  return payloads.get(event.eventId)?.[role];
}

function oracleStableRuntime(runtime: OracleEvidenceEventV1["runtime"]): Omit<OracleEvidenceEventV1["runtime"], "logRangeArtifactRefId"> {
  const { logRangeArtifactRefId: _logRangeArtifactRefId, ...stable } = runtime;
  return stable;
}

function compareProducerTail(
  tail: readonly OracleEvidenceEventV1[],
  factsById: ReadonlyMap<Hash, OracleSixStepStageFactsV1>,
  witnessPayloads: OracleWitnessPayloadMapV1,
  rawPayloads: OracleRawPayloadMapV1,
  reasons: string[],
  evaluatorBinding: SixStepReferenceInputV1["economicEvaluatorBinding"],
): void {
  if (tail.length !== 4) {
    add(reasons, "tail-cardinality");
    return;
  }
  const first = tail[0]!;
  if (tail.some(event => event.runtime.commitSha !== evaluatorBinding.candidateReleaseCommit)) add(reasons, "economic-evaluator-candidate-commit");
  for (const event of tail.slice(1)) {
    for (const [key, left, right] of [
      ["correlationId", first.correlationId, event.correlationId],
      ["producer-runtime", oracleStableRuntime(first.runtime), oracleStableRuntime(event.runtime)],
      ["scope", first.scope, event.scope],
      ["cutoff", first.cutoff, event.cutoff],
      ["definitionCatalogRoot", first.definitionCatalogRoot, event.definitionCatalogRoot],
      ["strategyCatalogRoot", first.strategyCatalogRoot, event.strategyCatalogRoot],
      ["instanceCatalogRoot", first.instanceCatalogRoot, event.instanceCatalogRoot],
      ["graphRoot", first.graphRoot, event.graphRoot],
      ["familyId", first.familyId, event.familyId],
      ["candidateKey", first.candidateKey, event.candidateKey],
      ["familyDefinitionHash", first.familyDefinitionHash, event.familyDefinitionHash],
      ["capabilitySetHash", first.capabilitySetHash, event.capabilitySetHash],
      ["instanceKey", first.instanceKey, event.instanceKey],
    ] as const) {
      if (!same(left, right)) add(reasons, `tail-${key}`);
    }
  }
  for (let index = 1; index < tail.length; index += 1) {
    const parent = tail[index - 1]!;
    const child = tail[index]!;
    if (child.parentEventIds.length !== 1 || child.parentEventIds[0] !== parent.eventId || child.parentOutputHashes[0] !== parent.outputHash) add(reasons, "tail-parent");
    if (BigInt(child.runSequence) <= BigInt(parent.runSequence)) add(reasons, "tail-sequence");
  }
  const [stage3, stage4, stage5, stage6] = tail;
  const stage4Facts = factsById.get(stage4.eventId);
  const stage6Facts = factsById.get(stage6.eventId);
  const routeSet = oraclePayloadRecord(oraclePayload(witnessPayloads, stage3, "route-set"));
  const stage3Raw = oraclePayloadRecord(rawPayloads.get(stage3.eventId));
  const exactPayload = oraclePayloadRecord(oraclePayload(witnessPayloads, stage4, "exact-output"));
  const exact = oraclePayloadRecord(exactPayload?.exact);
  const programPayload = oraclePayloadRecord(oraclePayload(witnessPayloads, stage5, "program"));
  const program = oraclePayloadRecord(programPayload?.program);
  if (!oracleExactPayloadKeys(oraclePayload(witnessPayloads, stage4, "exact-output"), ["exact"])
    || !same(oraclePayload(witnessPayloads, stage4, "exact-output"), { exact: oraclePayloadRecord(rawPayloads.get(stage4.eventId))?.exact })
    || exact?.routeHash !== routeSet?.routeHash
    || exact?.routeBindingHash !== stage3Raw?.routeBindingHash
    || stage4Facts?.stageId !== "current_source_exact"
    || !same(exact?.source, stage4Facts.currentSource)) add(reasons, "stage4-exact-payload");
  if (!oracleExactPayloadKeys(oraclePayload(witnessPayloads, stage5, "program"), ["program"])
    || !same(oraclePayload(witnessPayloads, stage5, "program"), { program: oraclePayloadRecord(rawPayloads.get(stage5.eventId))?.program })
    || program?.routeHash !== routeSet?.routeHash
    || program?.generationId !== stage5.scope.generationId
    || stage4Facts?.stageId !== "current_source_exact"
    || !same(program?.source, stage4Facts.currentSource)
    || !oracleExactPayloadKeys(oraclePayload(witnessPayloads, stage5, "pre-calls"), ["preCalls"])
    || !oracleExactPayloadKeys(oraclePayload(witnessPayloads, stage5, "observation-pairs"), ["observationPairs"])
    || !oracleExactPayloadKeys(oraclePayload(witnessPayloads, stage5, "action-owner"), ["actionOwners"])) add(reasons, "stage5-program-payload");
  const stage5Raw = oraclePayloadRecord(rawPayloads.get(stage5.eventId));
  const executionOwnerEvidence = oraclePayloadRecord(stage5Raw?.ownerEvidence);
  const executionOwnerFacts = oraclePayloadRecord(executionOwnerEvidence?.facts);
  const stage5Facts = factsById.get(stage5.eventId);
  if (stage5Facts?.stageId !== "execution_program"
    || executionOwnerEvidence?.correlationId !== stage5.correlationId
    || executionOwnerEvidence?.generationId !== stage5.scope.generationId
    || executionOwnerEvidence?.routeHash !== routeSet?.routeHash
    || executionOwnerEvidence?.exactHash !== exact?.exactHash
    || executionOwnerEvidence?.programHash !== program?.programHash
    || stage4Facts?.stageId !== "current_source_exact"
    || !same(executionOwnerEvidence?.source, stage4Facts.currentSource)
    || stage5Raw?.callerMode !== stage5Facts.callerMode
    || executionOwnerFacts?.callerMode !== stage5Facts.callerMode
    || !same(oraclePayload(witnessPayloads, stage5, "pre-calls"), { preCalls: executionOwnerFacts?.preCalls })
    || !same(oraclePayload(witnessPayloads, stage5, "observation-pairs"), { observationPairs: executionOwnerFacts?.observationPairs })
    || !same(oraclePayload(witnessPayloads, stage5, "action-owner"), { actionOwners: executionOwnerFacts?.actionOwners })) add(reasons, "stage5-owner-evidence-payload");
  const finalPayload = oraclePayloadRecord(oraclePayload(witnessPayloads, stage6, "final-simulation-receipt"));
  const simulation = oraclePayloadRecord(finalPayload?.simulation);
  const ownerEvidence = oraclePayloadRecord(finalPayload?.ownerEvidence);
  const ownerFacts = oraclePayloadRecord(ownerEvidence?.facts);
  const ownerEffects = oraclePayloadRecord(oraclePayloadRecord(ownerFacts?.workerReceipt)?.effects);
  const stage6Raw = oraclePayloadRecord(rawPayloads.get(stage6.eventId));
  const economicSafety = oraclePayloadRecord(stage6Raw?.economicSafety);
  const simulationSource = stage6Facts?.stageId === "final_simulation" ? stage6Facts.simulationSourceAnchor : null;
  if (!oracleExactPayloadKeys(oraclePayload(witnessPayloads, stage6, "final-simulation-receipt"), ["simulation", "ownerEvidence"])
    || simulation?.programHash !== program?.programHash
    || !same(simulation?.effectTransport, program?.effectTransport)
    || simulation?.generationId !== stage6.scope.generationId
    || !same(simulation?.source, simulationSource)
    || stage4Facts?.stageId !== "current_source_exact"
    || !same(simulationSource, stage4Facts.currentSource)
    || ownerEvidence?.correlationId !== stage6.correlationId
    || ownerEvidence?.generationId !== stage6.scope.generationId
    || ownerEvidence?.programHash !== program?.programHash
    || ownerEvidence?.finalSimulationReceiptHash !== simulation?.receiptHash
    || !same(ownerEvidence?.source, simulationSource)
    || ownerEffects?.effectsHash !== simulation?.effectsHash) add(reasons, "stage6-simulation-payload");
  const economicPayload = oraclePayloadRecord(oraclePayload(witnessPayloads, stage6, "economic-receipt"));
  const economic = oraclePayloadRecord(economicPayload?.economic);
  const safetyWitness = oraclePayloadRecord(oraclePayload(witnessPayloads, stage6, "safety-receipt"));
  if (!oracleExactPayloadKeys(oraclePayload(witnessPayloads, stage6, "economic-receipt"), ["economic"])
    || !same(stage6Raw?.program, program)
    || !same(stage6Raw?.simulation, simulation)
    || !same(stage6Raw?.ownerEvidence, ownerEvidence)
    || !oracleEconomicSafety({
      evidence: economicSafety,
      economic,
      safetyWitness,
      executionEvidence: executionOwnerEvidence,
      finalEvidence: ownerEvidence,
      program,
      simulation,
      correlationId: stage6.correlationId,
      generationId: stage6.scope.generationId,
      source: simulationSource,
      exactHash: exact?.exactHash,
      evaluatorBinding,
    })) add(reasons, "stage6-safety-payload");
}

function compareStage12(
  stage1: readonly OracleEvidenceEventV1[],
  stage2: readonly OracleEvidenceEventV1[],
  factsById: ReadonlyMap<Hash, OracleSixStepStageFactsV1>,
  reasons: string[],
): void {
  if (stage1.length === 0 || stage1.length !== stage2.length) {
    add(reasons, "stage1-stage2-cardinality");
    return;
  }
  const stage1ById = new Map(stage1.map((event) => [event.eventId, event]));
  const used = new Set<Hash>();
  for (const event of stage2) {
    if (event.parentEventIds.length !== 1 || event.parentOutputHashes.length !== 1) {
      add(reasons, "stage2-parent-cardinality");
      continue;
    }
    const parent = stage1ById.get(event.parentEventIds[0]!);
    if (parent === undefined || event.parentOutputHashes[0] !== parent.outputHash || used.has(parent.eventId)) {
      add(reasons, "stage2-parent-binding");
      continue;
    }
    used.add(parent.eventId);
    const parentFacts = factsById.get(parent.eventId);
    const facts = factsById.get(event.eventId);
    const parentStageFacts = parentFacts as Extract<OracleSixStepStageFactsV1, { readonly stageId: "universe_instance" }>;
    const stage2Facts = facts as Extract<OracleSixStepStageFactsV1, { readonly stageId: "edge_ready_generation" }>;
    if (parentStageFacts?.stageId !== "universe_instance" || stage2Facts?.stageId !== "edge_ready_generation" || stage2Facts.instancePublication.artifactRefId !== parentStageFacts.instancePublication.artifactRefId || stage2Facts.instancePublication.contentRoot !== parentStageFacts.instancePublication.contentRoot) add(reasons, "stage2-publication-binding");
    for (const [key, left, right] of [
      ["cutoff", parent.cutoff, event.cutoff],
      ["builderRunId", parent.scope.builderRunId, event.scope.builderRunId],
      ["definitionCatalogRoot", parent.definitionCatalogRoot, event.definitionCatalogRoot],
      ["familyId", parent.familyId, event.familyId],
      ["familyDefinitionHash", parent.familyDefinitionHash, event.familyDefinitionHash],
      ["capabilitySetHash", parent.capabilitySetHash, event.capabilitySetHash],
    ] as const) if (!same(left, right)) add(reasons, `stage2-${key}`);
    if (event.scope.generationId === "" || event.graphRoot === null || event.instanceCatalogRoot === null) add(reasons, "stage2-ready-binding");
    if (BigInt(event.runSequence) <= BigInt(parent.runSequence)) add(reasons, "stage2-sequence");
  }
}

function compareReadyStageSet(
  stage2: readonly OracleEvidenceEventV1[],
  planner: OracleEvidenceEventV1 | undefined,
  reasons: string[],
): void {
  if (stage2.length === 0) return;
  const first = stage2[0]!;
  for (const [index, event] of stage2.entries()) {
    for (const [key, left, right] of [
      ["cutoff", first.cutoff, event.cutoff],
      ["builderRunId", first.scope.builderRunId, event.scope.builderRunId],
      ["generationId", first.scope.generationId, event.scope.generationId],
      ["definitionCatalogRoot", first.definitionCatalogRoot, event.definitionCatalogRoot],
      ["strategyCatalogRoot", first.strategyCatalogRoot, event.strategyCatalogRoot],
      ["instanceCatalogRoot", first.instanceCatalogRoot, event.instanceCatalogRoot],
      ["graphRoot", first.graphRoot, event.graphRoot],
    ] as const) if (!same(left, right)) add(reasons, `stage2-set-${index}-${key}`);
  }
  if (planner !== undefined) {
    for (const [key, left, right] of [
      ["cutoff", first.cutoff, planner.cutoff],
      ["builderRunId", first.scope.builderRunId, planner.scope.builderRunId],
      ["generationId", first.scope.generationId, planner.scope.generationId],
      ["definitionCatalogRoot", first.definitionCatalogRoot, planner.definitionCatalogRoot],
      ["instanceCatalogRoot", first.instanceCatalogRoot, planner.instanceCatalogRoot],
      ["graphRoot", first.graphRoot, planner.graphRoot],
    ] as const) if (!same(left, right)) add(reasons, `planner-ready-${key}`);
  }
}

function comparePlanner(
  planner: OracleEvidenceEventV1,
  stage2: readonly OracleEvidenceEventV1[],
  factsById: ReadonlyMap<Hash, OracleSixStepStageFactsV1>,
  witnessPayloads: OracleWitnessPayloadMapV1,
  rawPayloads: OracleRawPayloadMapV1,
  reasons: string[],
): void {
  const facts = factsById.get(planner.eventId);
  if (facts?.stageId !== "planner_consumption") return;
  if (planner.parentEventIds.length !== stage2.length || planner.parentOutputHashes.length !== stage2.length) add(reasons, "planner-parent-cardinality");
  const stage2ById = new Map(stage2.map((event) => [event.eventId, event]));
  for (const [index, id] of planner.parentEventIds.entries()) {
    const parent = stage2ById.get(id);
    const binding = facts.orderedInstanceBindings[index];
    const parentFacts = factsById.get(parent?.eventId ?? "" as Hash);
    const parentStage2Facts = parentFacts?.stageId === "edge_ready_generation"
      ? parentFacts as Extract<OracleSixStepStageFactsV1, { readonly stageId: "edge_ready_generation" }>
      : undefined;
    if (parent === undefined || binding === undefined || planner.parentOutputHashes[index] !== parent.outputHash || binding.stage1EventId !== (parent?.parentEventIds.length === 1 ? parent.parentEventIds[0] : "") || binding.stage2EventId !== parent.eventId || binding.instanceKey !== parent.instanceKey || binding.instancePublicationRoot !== (parentStage2Facts?.instancePublication.contentRoot ?? "")) add(reasons, "planner-route-binding");
  }
  const routeSet = oraclePayloadRecord(oraclePayload(witnessPayloads, planner, "route-set"));
  const orderedEdgeIds = routeSet?.orderedEdgeIds;
  const plannerRaw = oraclePayloadRecord(rawPayloads.get(planner.eventId));
  if (!oracleExactPayloadKeys(oraclePayload(witnessPayloads, planner, "route-set"), ["routeCandidateId", "orderedEdgeIds", "routeHash"])
    || routeSet?.routeCandidateId !== planner.candidateKey
    || !Array.isArray(orderedEdgeIds)
    || !same(orderedEdgeIds, facts.orderedInstanceBindings.map((binding) => binding.edgeId))
    || plannerRaw?.routeCandidateId !== routeSet?.routeCandidateId
    || !same(plannerRaw?.orderedEdgeIds, orderedEdgeIds)
    || plannerRaw?.routeHash !== routeSet?.routeHash
    || typeof plannerRaw?.routeBindingHash !== "string"
    || !/^0x[0-9a-f]{64}$/.test(plannerRaw.routeBindingHash)
    || !same(oraclePayload(witnessPayloads, planner, "coarse-projection"), { coarse: plannerRaw?.coarse })
    || !same(oraclePayload(witnessPayloads, planner, "admission-receipt"), { planned: plannerRaw?.planned, admissionClass: plannerRaw?.admissionClass })
    || plannerRaw?.admissionClass !== facts.admissionClass) add(reasons, "planner-route-set-payload");
  for (const [index, id] of planner.parentEventIds.entries()) {
    const parent = stage2ById.get(id);
    const edge = parent === undefined ? null : oraclePayloadRecord(oraclePayload(witnessPayloads, parent, "edge"));
    if (edge?.edgeId !== facts.orderedInstanceBindings[index]?.edgeId) add(reasons, `planner-route-edge-payload-${index}`);
  }
}

/**
 * Independent qualification model. It consumes decoded objects, never a
 * GateCore evaluator or a producer verdict. Its implementation is purposely
 * separate from `runtime.ts`; qualification can therefore detect a runtime
 * adapter that silently diverges from the reviewed model.
 */
export function evaluateSixStepReferenceModel(input: SixStepReferenceInputV1): SixStepReferenceResultV1 {
  const reasons: string[] = [];
  let decodedInput: SixStepReferenceInputV1;
  try {
    decodedInput = Object.freeze({
      events: Object.freeze(input.events.map((event) => decodeOracleEvidenceEvent(event))),
      semanticArtifacts: Object.freeze(input.semanticArtifacts.map((artifact) => decodeOracleSemanticArtifact(artifact))),
      productionReceipts: Object.freeze(input.productionReceipts.map((receipt) => decodeOracleProductionReceipt(receipt))),
      stageFacts: Object.freeze(input.stageFacts.map((facts) => decodeOracleSixStepStageFacts(facts))),
      evidence: input.evidence,
      economicEvaluatorBinding: input.economicEvaluatorBinding,
    });
  } catch {
    return { verdict: "invalid", reasons: Object.freeze(["input-decode"]) };
  }
  if (decodedInput.events.length === 0 || decodedInput.events.length !== decodedInput.stageFacts.length) return { verdict: "invalid", reasons: ["empty-or-unpaired-facts"] };
  const witnessPayloads = new Map<Hash, Readonly<Record<string, Readonly<Record<string, CanonicalJson>>>>>();
  const rawPayloads = new Map<Hash, Readonly<Record<string, CanonicalJson>>>();
  if (!validateEvidenceEnvelope(decodedInput, reasons, witnessPayloads, rawPayloads)) return { verdict: "invalid", reasons: Object.freeze(reasons) };
  const eventIds = decodedInput.events.map((event) => event.eventId);
  if (new Set(eventIds).size !== eventIds.length) return { verdict: "invalid", reasons: ["duplicate-event"] };
  const factsById = stageFactsByEvent(decodedInput.events, decodedInput.stageFacts);
  if (factsById === null) return { verdict: "invalid", reasons: ["stage-facts-schema"] };
  assertArtifactReceiptBindings(decodedInput.events, decodedInput.semanticArtifacts, decodedInput.productionReceipts, reasons);
  validateStageFacts(decodedInput.events, factsById, reasons);
  const stage1 = decodedInput.events.filter((event) => event.stage.ordinal === 1);
  const stage2 = decodedInput.events.filter((event) => event.stage.ordinal === 2);
  const stage3 = decodedInput.events.filter((event) => event.stage.ordinal === 3);
  const stage4 = decodedInput.events.filter((event) => event.stage.ordinal === 4);
  const stage5 = decodedInput.events.filter((event) => event.stage.ordinal === 5);
  const stage6 = decodedInput.events.filter((event) => event.stage.ordinal === 6);
  if (stage3.length !== 1 || stage4.length !== 1 || stage5.length !== 1 || stage6.length !== 1) add(reasons, "stage-cardinality");
  if (decodedInput.events.some((event) => event.stage.ordinal !== 1 && event.stage.ordinal !== 2 && event.outcome !== "success")) add(reasons, "non-success-tail");
  if (stage1.some((event) => event.outcome !== "verified" || event.instanceKey === null || event.scope.kind !== "builder-run" || event.scope.generationId !== null)) add(reasons, "stage1-contract");
  if (stage2.some((event) => event.outcome !== "success" || event.instanceKey === null || event.scope.kind !== "ready-generation")) add(reasons, "stage2-contract");
  compareStage12(stage1, stage2, factsById, reasons);
  if (stage3[0] !== undefined) comparePlanner(stage3[0], stage2, factsById, witnessPayloads, rawPayloads, reasons);
  compareReadyStageSet(stage2, stage3[0], reasons);
  const binding = input.economicEvaluatorBinding;
  const { observationRoot: _bindingRoot, ...bindingPayload } = binding;
  const executorQualification = oraclePayloadRecord(binding.executorQualification);
  if (!oracleExactPayloadKeys(binding, ["schemaVersion", "kind", "runtimeBindingId", "candidateReleaseCommit", "releaseProvenanceHash", "authorityRoot", "implementationHash", "policyRoot", "evaluatorExportIdentityHash", "objectiveTemplates", "actionOwners", "valuationOwners", "executorQualification", "safetyProfile", "observationRoot"])
    || binding.schemaVersion !== 1
    || binding.kind !== "aloha.six-step-economic-evaluator-binding-observation-v1"
    || !oraclePositiveHash(binding.runtimeBindingId)
    || typeof binding.candidateReleaseCommit !== "string" || !/^[0-9a-f]{40}$/.test(binding.candidateReleaseCommit)
    || !oraclePositiveHash(binding.releaseProvenanceHash)
    || !oraclePositiveHash(binding.authorityRoot)
    || !oraclePositiveHash(binding.implementationHash)
    || !oraclePositiveHash(binding.policyRoot)
    || !oraclePositiveHash(binding.evaluatorExportIdentityHash)
    || !Array.isArray(binding.objectiveTemplates) || binding.objectiveTemplates.length === 0
    || !Array.isArray(binding.actionOwners) || binding.actionOwners.length === 0
    || !Array.isArray(binding.valuationOwners) || binding.valuationOwners.length === 0
    || oraclePayloadRecord(binding.safetyProfile) === null
    || binding.valuationOwners.some(owner => {
      const descriptor = oraclePayloadRecord(owner);
      return !oracleExactPayloadKeys(descriptor, ["ownerRef", "implementationHash", "factSchemaRef", "implementationClosureRoot", "qualificationLeafDigest", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot"])
        || ["ownerRef", "implementationHash", "factSchemaRef", "implementationClosureRoot", "qualificationLeafDigest", "valuationOwnerRegistryRoot", "qualifiedValuationOwnerSetRoot"]
          .some(key => !oraclePositiveHash(descriptor?.[key]));
    })
    || new Set(binding.valuationOwners.map(owner => oraclePayloadRecord(owner)?.ownerRef)).size !== binding.valuationOwners.length
    || !oracleExactPayloadKeys(executorQualification, ["executorKind", "engineBuildFingerprint", "executableFingerprint", "qualifiedExecutorRegistryRoot", "selectedExecutorLeafHash", "releaseRoleManifestRoot"])
    || executorQualification?.executorKind !== "revm"
    || ["engineBuildFingerprint", "executableFingerprint", "qualifiedExecutorRegistryRoot", "selectedExecutorLeafHash", "releaseRoleManifestRoot"].some(key => !oraclePositiveHash(executorQualification?.[key]))
    || !oracleDomainHash("aloha/runtime-release-economic-evaluator-policies/v4", {
      templates: binding.objectiveTemplates,
      actionOwners: binding.actionOwners,
      valuationOwners: binding.valuationOwners,
      executorQualification: binding.executorQualification,
      safetyProfile: binding.safetyProfile,
    }, binding.policyRoot)
    || !oracleDomainHash("aloha/six-step-economic-evaluator-binding-observation/v1", bindingPayload, binding.observationRoot)) add(reasons, "economic-evaluator-binding");
  compareProducerTail([stage3[0], stage4[0], stage5[0], stage6[0]].filter((event): event is OracleEvidenceEventV1 => event !== undefined), factsById, witnessPayloads, rawPayloads, reasons, binding);
  if (stage6[0]?.outcome !== "success") add(reasons, "final-simulation-not-success");
  if (reasons.length > 0) {
    const semanticFailure = reasons.some((reason) => reason.includes("not-success") || reason === "stage6-facts");
    return { verdict: semanticFailure ? "fail" : "invalid", reasons: Object.freeze(reasons) };
  }
  return { verdict: "pass", reasons: Object.freeze([]) };
}

export function decodeReferenceStageFacts(values: readonly unknown[]): readonly OracleSixStepStageFactsV1[] {
  return Object.freeze(values.map((value) => decodeOracleSixStepStageFacts(value)));
}
