import { types as nodeTypes } from "node:util";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

export type TerminalSelectionReferenceVerdict = "pass" | "fail" | "invalid";

export interface TerminalSelectionReferenceInputV1 {
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
  readonly trustedObserverInvocation?: Readonly<{
    readonly roleId: string;
    readonly authenticatedArtifactRefIds: readonly Hash[];
    readonly candidateReleaseCommit: string;
  }> | null;
}

export interface TerminalSelectionReferenceResultV1 {
  readonly verdict: TerminalSelectionReferenceVerdict;
  readonly reasons: readonly string[];
}

const EXPECTED_POLICY_DIGEST = hashDomain(
  "aloha/searcher-production-six-step-window-selection-policy/v1",
  Object.freeze({
    denominator: "active-exact-100-performance-window",
    eligibility: "complete-successful-dry-run",
    order: Object.freeze(["ordinal", "lane:blockscan-before-backrun", "candidate-stable-key", "producer-terminal-id"]),
    selection: "first",
  }),
);

// These bounds are deliberately owned by this qualification oracle. Keeping
// them literal in this module makes the oracle compiler closure bind the wire
// contract without importing the production artifact-bytes codec.
const ORACLE_ARTIFACT_CHUNK_BYTES = 65_534;
const ORACLE_ARTIFACT_INLINE_BYTES = 500_000;
const ORACLE_ARTIFACT_KIND = "aloha.canonical-artifact-bytes";
const ORACLE_DECIMAL_MAX_DIGITS = 128;
const ORACLE_STRING_MAX_CODE_UNITS = 131_072;
const ORACLE_SIGNED_INVOCATION_ROLE_ID = "aloha.terminal-selection-lineage.facts.signed-invocation-seal";
const ORACLE_ARTIFACT_ROLES = Object.freeze([
  "raw-sqlite-selection",
  "durable-terminal-manifest",
  "full-family-projection",
  "selected-process-evidence",
] as const);
const ORACLE_SIX_STEP_PREDICATE_ARTIFACT_ROLE = "six-step-predicate-artifact";
const ORACLE_ARTIFACT_SCHEMA_REFS = Object.freeze({
  rawSelection: Object.freeze({
    id: "aloha.raw-terminal-selection-observation",
    version: "1.0.0",
    schemaHash: "0x40512cdbe4593c381ce29a7071416e3c6cd15a23ec4a1c2ef30033e5601e0378" as Hash,
  }),
  terminalManifest: Object.freeze({
    id: "aloha.production-terminal-phase-manifest",
    version: "1.0.0",
    schemaHash: "0xc20bc140c2538c0046e3dc10d775129ff27a3aeee45504b300a041606d22251c" as Hash,
  }),
  fullFamilyProjection: Object.freeze({
    id: "aloha.production-terminal-phase-full-family-projection",
    version: "1.0.0",
    schemaHash: "0x0b01fccaa4b4f1789d577caf899246a2d2d93432a15f016ae019a444c47afa59" as Hash,
  }),
  processEvidence: Object.freeze({
    id: "aloha.observer.six-step-process-evidence",
    version: "1.0.0",
    schemaHash: "0xc7540e3d8defa186099168d5fa072f7bca20b2452b526b12cfb4e3e0882c81e3" as Hash,
  }),
});
const ORACLE_EVENT_SCHEMA_REF = Object.freeze({
  id: "aloha.fact-evidence-event",
  version: "1.0.0",
  schemaHash: "0xf00c390090fcab1c6494b64bea7532e0ab2c3fa4918796db49cb88935ff2e135" as Hash,
});

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

interface OracleSchemaRefV1 {
  readonly id: string;
  readonly version: string;
  readonly schemaHash: Hash;
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

function oracleLiteral<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) throw new TypeError(`expected literal at ${path}`);
  return expected;
}

function decodeOracleArray<T>(
  value: unknown,
  decode: (entry: unknown, path: string) => T,
  path: string,
): readonly T[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) throw new TypeError(`expected concrete array at ${path}`);
  const length = value.length;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1
    || keys.some(key => key !== "length" && (typeof key !== "string"
      || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length))) {
    throw new TypeError(`expected dense exact array at ${path}`);
  }
  const output: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`expected enumerable data entry at ${path}[${index}]`);
    }
    output.push(decode(descriptor.value, `${path}[${index}]`));
  }
  return Object.freeze(output);
}

function decodeOracleCanonicalObject(value: unknown, path: string): Readonly<Record<string, CanonicalJson>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new TypeError(`expected canonical object at ${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`expected plain object at ${path}`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`symbol key at ${path}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`non-data property at ${path}.${key}`);
    }
  }
  encodeCanonicalJson(value);
  return value as Readonly<Record<string, CanonicalJson>>;
}

function decodeOracleLocator(value: unknown, path: string): OracleLocatorV1 {
  if (value === null || typeof value !== "object") throw new TypeError(`expected locator at ${path}`);
  const probe = exactDataRecord(value, Reflect.ownKeys(value).filter((key): key is string => typeof key === "string"), path);
  const kind = dataField(probe, "kind", path);
  switch (kind) {
    case "file-range": {
      const record = exactDataRecord(value, ["kind", "systemId", "bootIdHash", "device", "inode", "startInclusive", "endExclusive"], path);
      const startInclusive = oracleDecimal(dataField(record, "startInclusive", path), `${path}.startInclusive`);
      const endExclusive = oracleDecimal(dataField(record, "endExclusive", path), `${path}.endExclusive`);
      if (BigInt(endExclusive) < BigInt(startInclusive)) throw new TypeError(`reversed file range at ${path}`);
      return Object.freeze({
        kind,
        systemId: oracleString(dataField(record, "systemId", path), `${path}.systemId`),
        bootIdHash: oracleHash(dataField(record, "bootIdHash", path), `${path}.bootIdHash`),
        device: oracleDecimal(dataField(record, "device", path), `${path}.device`),
        inode: oracleDecimal(dataField(record, "inode", path), `${path}.inode`),
        startInclusive,
        endExclusive,
      });
    }
    case "checkpoint-record": {
      const record = exactDataRecord(value, ["kind", "storeIdentityHash", "namespaceHash", "keyHash", "revision", "recordHash"], path);
      return Object.freeze({
        kind,
        storeIdentityHash: oracleHash(dataField(record, "storeIdentityHash", path), `${path}.storeIdentityHash`),
        namespaceHash: oracleHash(dataField(record, "namespaceHash", path), `${path}.namespaceHash`),
        keyHash: oracleHash(dataField(record, "keyHash", path), `${path}.keyHash`),
        revision: oracleDecimal(dataField(record, "revision", path), `${path}.revision`),
        recordHash: oracleHash(dataField(record, "recordHash", path), `${path}.recordHash`),
      });
    }
    case "chain-object": {
      const record = exactDataRecord(value, ["kind", "chainId", "blockNumber", "blockHash", "objectKind", "objectKeyHash"], path);
      const objectKind = dataField(record, "objectKind", path);
      if (objectKind !== "header" && objectKind !== "transaction" && objectKind !== "receipt"
        && objectKind !== "state-proof" && objectKind !== "logs") throw new TypeError(`invalid chain object kind at ${path}.objectKind`);
      return Object.freeze({
        kind,
        chainId: oracleDecimal(dataField(record, "chainId", path), `${path}.chainId`),
        blockNumber: oracleDecimal(dataField(record, "blockNumber", path), `${path}.blockNumber`),
        blockHash: oracleHash(dataField(record, "blockHash", path), `${path}.blockHash`),
        objectKind,
        objectKeyHash: oracleHash(dataField(record, "objectKeyHash", path), `${path}.objectKeyHash`),
      });
    }
    case "content-object": {
      const record = exactDataRecord(value, ["kind", "storeIdentityHash", "objectKey"], path);
      return Object.freeze({
        kind,
        storeIdentityHash: oracleHash(dataField(record, "storeIdentityHash", path), `${path}.storeIdentityHash`),
        objectKey: oracleHash(dataField(record, "objectKey", path), `${path}.objectKey`),
      });
    }
    case "json-pointer": {
      const record = exactDataRecord(value, ["kind", "parentLocatorId", "pointer"], path);
      return Object.freeze({
        kind,
        parentLocatorId: oracleHash(dataField(record, "parentLocatorId", path), `${path}.parentLocatorId`),
        pointer: dataField(record, "pointer", path) === "" ? "" : oracleString(dataField(record, "pointer", path), `${path}.pointer`),
      });
    }
    default: throw new TypeError(`unknown locator kind at ${path}.kind`);
  }
}

function decodeOracleReadOnlyArtifactRef(value: unknown, path = "$"): OracleReadOnlyArtifactRefV1 {
  const record = exactDataRecord(value, [
    "artifactRefId", "locatorId", "locator", "immutableMirrorLocatorId", "immutableMirrorLocator",
    "contentSha256", "byteLength", "mediaType", "schema", "resolverPolicyHash", "retentionLeaseReceiptId",
  ], path);
  const locator = decodeOracleLocator(dataField(record, "locator", path), `${path}.locator`);
  const immutableMirrorLocator = decodeOracleLocator(dataField(record, "immutableMirrorLocator", path), `${path}.immutableMirrorLocator`);
  if (immutableMirrorLocator.kind !== "content-object") throw new TypeError(`immutable mirror must be content object at ${path}`);
  const schemaValue = dataField(record, "schema", path);
  const decoded = Object.freeze({
    artifactRefId: oracleHash(dataField(record, "artifactRefId", path), `${path}.artifactRefId`),
    locatorId: oracleHash(dataField(record, "locatorId", path), `${path}.locatorId`),
    locator,
    immutableMirrorLocatorId: oracleHash(dataField(record, "immutableMirrorLocatorId", path), `${path}.immutableMirrorLocatorId`),
    immutableMirrorLocator,
    contentSha256: oracleHash(dataField(record, "contentSha256", path), `${path}.contentSha256`),
    byteLength: oracleDecimal(dataField(record, "byteLength", path), `${path}.byteLength`),
    mediaType: oracleString(dataField(record, "mediaType", path), `${path}.mediaType`),
    schema: schemaValue === null ? null : decodeOracleSchemaRef(schemaValue, `${path}.schema`),
    resolverPolicyHash: oracleHash(dataField(record, "resolverPolicyHash", path), `${path}.resolverPolicyHash`),
    retentionLeaseReceiptId: oracleHash(dataField(record, "retentionLeaseReceiptId", path), `${path}.retentionLeaseReceiptId`),
  });
  const locatorId = hashDomain("aloha/read-only-artifact-locator/v1", locator as unknown as CanonicalJson);
  const immutableMirrorLocatorId = hashDomain("aloha/read-only-artifact-locator/v1", immutableMirrorLocator as unknown as CanonicalJson);
  if (decoded.locatorId !== locatorId || decoded.immutableMirrorLocatorId !== immutableMirrorLocatorId
    || immutableMirrorLocator.objectKey !== decoded.contentSha256) throw new TypeError(`artifact locator binding mismatch at ${path}`);
  if (locator.kind === "file-range"
    && BigInt(locator.endExclusive) - BigInt(locator.startInclusive) !== BigInt(decoded.byteLength)) {
    throw new TypeError(`file range length mismatch at ${path}`);
  }
  const artifactRefId = hashDomain("aloha/read-only-artifact-ref/v1", {
    locatorId,
    immutableMirrorLocatorId,
    contentSha256: decoded.contentSha256,
    byteLength: decoded.byteLength,
    mediaType: decoded.mediaType,
    schema: decoded.schema,
    resolverPolicyHash: decoded.resolverPolicyHash,
    retentionLeaseReceiptId: decoded.retentionLeaseReceiptId,
  });
  if (decoded.artifactRefId !== artifactRefId) throw new TypeError(`artifact identity mismatch at ${path}.artifactRefId`);
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

function decodeReleaseIdentity(value: unknown, path: string) {
  const record = exactDataRecord(value, ["bindingId", "releaseProvenanceHash", "candidateReleaseCommit"], path);
  return Object.freeze({
    bindingId: oracleHash(dataField(record, "bindingId", path), `${path}.bindingId`),
    releaseProvenanceHash: oracleHash(dataField(record, "releaseProvenanceHash", path), `${path}.releaseProvenanceHash`),
    candidateReleaseCommit: oracleGitSha40(dataField(record, "candidateReleaseCommit", path), `${path}.candidateReleaseCommit`),
  });
}

function decodeServingIdentity(value: unknown, path: string) {
  const record = exactDataRecord(value, ["generationId", "graphRoot", "readyRecordHash", "sourceCoverageRoot"], path);
  return Object.freeze({
    generationId: oracleString(dataField(record, "generationId", path), `${path}.generationId`),
    graphRoot: oracleHash(dataField(record, "graphRoot", path), `${path}.graphRoot`),
    readyRecordHash: oracleHash(dataField(record, "readyRecordHash", path), `${path}.readyRecordHash`),
    sourceCoverageRoot: oracleHash(dataField(record, "sourceCoverageRoot", path), `${path}.sourceCoverageRoot`),
  });
}

function decodeCurrentSource(value: unknown, path: string) {
  const record = exactDataRecord(value, ["chainId", "number", "hash", "stateRoot"], path);
  return Object.freeze({
    chainId: oracleDecimal(dataField(record, "chainId", path), `${path}.chainId`),
    number: oracleDecimal(dataField(record, "number", path), `${path}.number`),
    hash: oracleHash(dataField(record, "hash", path), `${path}.hash`),
    stateRoot: oracleHash(dataField(record, "stateRoot", path), `${path}.stateRoot`),
  });
}

function decodeCanonicalHead(value: unknown, path: string) {
  const record = exactDataRecord(value, ["chainId", "number", "hash", "parentHash", "stateRoot"], path);
  return Object.freeze({
    chainId: oracleDecimal(dataField(record, "chainId", path), `${path}.chainId`),
    number: oracleDecimal(dataField(record, "number", path), `${path}.number`),
    hash: oracleHash(dataField(record, "hash", path), `${path}.hash`),
    parentHash: oracleHash(dataField(record, "parentHash", path), `${path}.parentHash`),
    stateRoot: oracleHash(dataField(record, "stateRoot", path), `${path}.stateRoot`),
  });
}

function decodeProducerSchedulerJoin(value: unknown, path: string) {
  const record = exactDataRecord(value, [
    "correlationId", "generationId", "source", "programHash", "finalSimulationReceiptHash",
    "unsignedDryRunCandidateId", "unsignedDryRunLineageHash",
  ], path);
  return Object.freeze({
    correlationId: oracleHash(dataField(record, "correlationId", path), `${path}.correlationId`),
    generationId: oracleString(dataField(record, "generationId", path), `${path}.generationId`),
    source: decodeCurrentSource(dataField(record, "source", path), `${path}.source`),
    programHash: oracleHash(dataField(record, "programHash", path), `${path}.programHash`),
    finalSimulationReceiptHash: oracleHash(dataField(record, "finalSimulationReceiptHash", path), `${path}.finalSimulationReceiptHash`),
    unsignedDryRunCandidateId: oracleHash(dataField(record, "unsignedDryRunCandidateId", path), `${path}.unsignedDryRunCandidateId`),
    unsignedDryRunLineageHash: oracleHash(dataField(record, "unsignedDryRunLineageHash", path), `${path}.unsignedDryRunLineageHash`),
  });
}

function decodeOracleFullFamilyProjection(bytes: Uint8Array) {
  const path = "$";
  const record = exactDataRecord(decodeCanonicalJson(bytes), [
    "schemaVersion", "kind", "status", "finalDurableWindowId", "readyRecordHash", "auditRoot",
    "fullGraphCoarseSweepRoot", "producerTerminalBindingRoot", "laneTerminalSetRoot",
    "bundleContentSha256", "locatorContentSha256", "missing", "observationRoot",
  ], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, "$.schemaVersion");
  oracleLiteral(dataField(record, "kind", path), "aloha.production-terminal-phase-full-family-projection-v1", "$.kind");
  const status = dataField(record, "status", path);
  if (status !== "observed" && status !== "missing") throw new TypeError("invalid Full-Family projection status");
  const missing = decodeOracleArray(dataField(record, "missing", path), (entry, entryPath) => {
    const item = exactDataRecord(entry, ["code", "subjectRoot"], entryPath);
    const code = dataField(item, "code", entryPath);
    if (code !== "coarse-family-artifact-unavailable" && code !== "graph-transition-audit-denominator-incomplete") {
      throw new TypeError(`invalid Full-Family missing code at ${entryPath}`);
    }
    return Object.freeze({ code, subjectRoot: oracleHash(dataField(item, "subjectRoot", entryPath), `${entryPath}.subjectRoot`) });
  }, "$.missing");
  const bundleValue = dataField(record, "bundleContentSha256", path);
  const locatorValue = dataField(record, "locatorContentSha256", path);
  const core = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-full-family-projection-v1" as const,
    status,
    finalDurableWindowId: oracleHash(dataField(record, "finalDurableWindowId", path), "$.finalDurableWindowId"),
    readyRecordHash: oracleHash(dataField(record, "readyRecordHash", path), "$.readyRecordHash"),
    auditRoot: oracleHash(dataField(record, "auditRoot", path), "$.auditRoot"),
    fullGraphCoarseSweepRoot: oracleHash(dataField(record, "fullGraphCoarseSweepRoot", path), "$.fullGraphCoarseSweepRoot"),
    producerTerminalBindingRoot: oracleHash(dataField(record, "producerTerminalBindingRoot", path), "$.producerTerminalBindingRoot"),
    laneTerminalSetRoot: oracleHash(dataField(record, "laneTerminalSetRoot", path), "$.laneTerminalSetRoot"),
    bundleContentSha256: bundleValue === null ? null : oracleHash(bundleValue, "$.bundleContentSha256"),
    locatorContentSha256: locatorValue === null ? null : oracleHash(locatorValue, "$.locatorContentSha256"),
    missing,
  });
  if ((status === "observed" && (core.bundleContentSha256 === null || core.locatorContentSha256 === null || missing.length !== 0))
    || (status === "missing" && (core.bundleContentSha256 !== null || core.locatorContentSha256 !== null || missing.length === 0))) {
    throw new TypeError("inconsistent Full-Family projection denominator");
  }
  const observationRoot = oracleHash(dataField(record, "observationRoot", path), "$.observationRoot");
  if (observationRoot !== hashDomain("aloha/production-terminal-phase-full-family-projection/v1", core as unknown as CanonicalJson)) {
    throw new TypeError("Full-Family projection root mismatch");
  }
  return Object.freeze({ ...core, observationRoot });
}

function decodeSelection(value: unknown, path: string) {
  const record = exactDataRecord(value, [
    "finalDurableWindowId", "selectionPolicyDigest", "eligibleSuccessCount", "eligibleSuccessRoot",
    "selectedIndex", "selectedProducerTerminalId", "selectedPerformanceEventId",
    "selectedProducerTerminalEventId", "selectionRoot",
  ], path);
  const selectedIndex = dataField(record, "selectedIndex", path);
  const eligibleSuccessCount = oracleDecimal(dataField(record, "eligibleSuccessCount", path), `${path}.eligibleSuccessCount`);
  if (selectedIndex === null) {
    if (eligibleSuccessCount !== "0") throw new TypeError(`missing selection must have zero denominator at ${path}`);
    return Object.freeze({
      finalDurableWindowId: oracleHash(dataField(record, "finalDurableWindowId", path), `${path}.finalDurableWindowId`),
      selectionPolicyDigest: oracleHash(dataField(record, "selectionPolicyDigest", path), `${path}.selectionPolicyDigest`),
      eligibleSuccessCount,
      eligibleSuccessRoot: oracleHash(dataField(record, "eligibleSuccessRoot", path), `${path}.eligibleSuccessRoot`),
      selectedIndex: null,
      selectedProducerTerminalId: oracleLiteral(dataField(record, "selectedProducerTerminalId", path), null, `${path}.selectedProducerTerminalId`),
      selectedPerformanceEventId: oracleLiteral(dataField(record, "selectedPerformanceEventId", path), null, `${path}.selectedPerformanceEventId`),
      selectedProducerTerminalEventId: oracleLiteral(dataField(record, "selectedProducerTerminalEventId", path), null, `${path}.selectedProducerTerminalEventId`),
      selectionRoot: oracleHash(dataField(record, "selectionRoot", path), `${path}.selectionRoot`),
    });
  }
  if (selectedIndex !== "0" || eligibleSuccessCount === "0") throw new TypeError(`invalid selected denominator at ${path}`);
  return Object.freeze({
    finalDurableWindowId: oracleHash(dataField(record, "finalDurableWindowId", path), `${path}.finalDurableWindowId`),
    selectionPolicyDigest: oracleHash(dataField(record, "selectionPolicyDigest", path), `${path}.selectionPolicyDigest`),
    eligibleSuccessCount,
    eligibleSuccessRoot: oracleHash(dataField(record, "eligibleSuccessRoot", path), `${path}.eligibleSuccessRoot`),
    selectedIndex: "0" as const,
    selectedProducerTerminalId: oracleHash(dataField(record, "selectedProducerTerminalId", path), `${path}.selectedProducerTerminalId`),
    selectedPerformanceEventId: oracleHash(dataField(record, "selectedPerformanceEventId", path), `${path}.selectedPerformanceEventId`),
    selectedProducerTerminalEventId: oracleHash(dataField(record, "selectedProducerTerminalEventId", path), `${path}.selectedProducerTerminalEventId`),
    selectionRoot: oracleHash(dataField(record, "selectionRoot", path), `${path}.selectionRoot`),
  });
}

function decodeOracleTerminalSelectionFact(value: unknown, path = "$") {
  const record = exactDataRecord(value, ["schemaVersion", "kind", "artifacts"], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, `${path}.schemaVersion`);
  oracleLiteral(dataField(record, "kind", path), "aloha.terminal-selection-lineage-fact-v1", `${path}.kind`);
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.terminal-selection-lineage-fact-v1" as const,
    artifacts: decodeOracleArray(dataField(record, "artifacts", path), (entry, entryPath) => {
      const artifact = exactDataRecord(entry, ["role", "artifactRefId"], entryPath);
      return Object.freeze({
        role: oracleString(dataField(artifact, "role", entryPath), `${entryPath}.role`),
        artifactRefId: oracleHash(dataField(artifact, "artifactRefId", entryPath), `${entryPath}.artifactRefId`),
      });
    }, `${path}.artifacts`),
  });
}

function decodeOracleRawSelection(bytes: Uint8Array) {
  const path = "$";
  const value = decodeCanonicalJson(bytes);
  const record = exactDataRecord(value, [
    "schemaVersion", "kind", "sourceKind", "databaseSha256Before", "databaseSha256After",
    "storageSetRootBefore", "storageSetRootAfter", "sqliteSchemaRoot", "rawRowRoot", "eventRoot",
    "terminalPhaseRowCount", "terminalPhaseRowRoot", "release", "serving", "selection", "observationRoot",
  ], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, "$.schemaVersion");
  oracleLiteral(dataField(record, "kind", path), "aloha.raw-terminal-selection-observation-v1", "$.kind");
  oracleLiteral(dataField(record, "sourceKind", path), "readonly-sqlite-snapshot", "$.sourceKind");
  const decoded = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.raw-terminal-selection-observation-v1" as const,
    sourceKind: "readonly-sqlite-snapshot" as const,
    databaseSha256Before: oracleHash(dataField(record, "databaseSha256Before", path), "$.databaseSha256Before"),
    databaseSha256After: oracleHash(dataField(record, "databaseSha256After", path), "$.databaseSha256After"),
    storageSetRootBefore: oracleHash(dataField(record, "storageSetRootBefore", path), "$.storageSetRootBefore"),
    storageSetRootAfter: oracleHash(dataField(record, "storageSetRootAfter", path), "$.storageSetRootAfter"),
    sqliteSchemaRoot: oracleHash(dataField(record, "sqliteSchemaRoot", path), "$.sqliteSchemaRoot"),
    rawRowRoot: oracleHash(dataField(record, "rawRowRoot", path), "$.rawRowRoot"),
    eventRoot: oracleHash(dataField(record, "eventRoot", path), "$.eventRoot"),
    terminalPhaseRowCount: oracleDecimal(dataField(record, "terminalPhaseRowCount", path), "$.terminalPhaseRowCount"),
    terminalPhaseRowRoot: oracleHash(dataField(record, "terminalPhaseRowRoot", path), "$.terminalPhaseRowRoot"),
    release: decodeReleaseIdentity(dataField(record, "release", path), "$.release"),
    serving: decodeServingIdentity(dataField(record, "serving", path), "$.serving"),
    selection: decodeSelection(dataField(record, "selection", path), "$.selection"),
    observationRoot: oracleHash(dataField(record, "observationRoot", path), "$.observationRoot"),
  });
  const { observationRoot: _root, ...core } = decoded;
  if (decoded.observationRoot !== hashDomain("aloha/raw-terminal-selection-observation/v1", core as unknown as CanonicalJson)) {
    throw new TypeError("raw terminal selection observation root mismatch");
  }
  return decoded;
}

function decodeOracleEventOrdinal(bytes: Uint8Array): 1 | 2 | 3 | 4 | 5 | 6 {
  const path = "$";
  const record = exactDataRecord(decodeCanonicalJson(bytes), [
    "schemaVersion", "kind", "eventId", "source", "runtime", "artifactLineage", "scope", "correlationId",
    "runSequence", "cutoff", "definitionCatalogRoot", "strategyCatalogRoot", "instanceCatalogRoot", "graphRoot",
    "familyId", "candidateKey", "familyDefinitionHash", "capabilities", "capabilitySetHash", "instanceKey",
    "stage", "parentEventIds", "parentOutputHashes", "inputSchema", "inputs", "inputHash", "factSchema",
    "facts", "outputHash", "outcome", "reasonCode", "latency", "extensions",
  ], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, "$.schemaVersion");
  oracleLiteral(dataField(record, "kind", path), "aloha.fact-evidence-event", "$.kind");
  const stage = exactDataRecord(dataField(record, "stage", path), ["ordinal", "id", "version"], "$.stage");
  const ordinal = dataField(stage, "ordinal", "$.stage");
  if (ordinal !== 1 && ordinal !== 2 && ordinal !== 3 && ordinal !== 4 && ordinal !== 5 && ordinal !== 6) {
    throw new TypeError("invalid terminal event ordinal");
  }
  const ids = ["universe_instance", "edge_ready_generation", "planner_consumption", "current_source_exact", "execution_program", "final_simulation"] as const;
  oracleLiteral(dataField(stage, "id", "$.stage"), ids[ordinal - 1], "$.stage.id");
  oracleLiteral(dataField(stage, "version", "$.stage"), 1, "$.stage.version");
  return ordinal;
}

function decodeTerminalSixStep(value: unknown, path: string) {
  const record = exactDataRecord(value, [
    "status", "observationRoot", "windowSelectionRoot", "selectionPolicyDigest", "eligibleSuccessCount",
    "eligibleSuccessRoot", "selectedIndex", "selectedProducerTerminalId", "reason",
    "joinedProcessEvidenceRoot", "performanceAppendRecordId", "producerTerminalAppendRecordId",
    "predicateArtifactCount", "predicateArtifactRoot", "eventArtifactRefIds",
  ], path);
  const status = dataField(record, "status", path);
  if (status !== "observed" && status !== "missing" && status !== "invalid") throw new TypeError(`invalid six-step status at ${path}`);
  const nullableHashAt = (key: string): Hash | null => {
    const field = dataField(record, key, path);
    return field === null ? null : oracleHash(field, `${path}.${key}`);
  };
  const countValue = dataField(record, "eligibleSuccessCount", path);
  const eligibleSuccessCount = countValue === null ? null : oracleDecimal(countValue, `${path}.eligibleSuccessCount`);
  const selectedIndexValue = dataField(record, "selectedIndex", path);
  if (selectedIndexValue !== null && selectedIndexValue !== "0") throw new TypeError(`invalid selected index at ${path}`);
  const reasonValue = dataField(record, "reason", path);
  const reason = reasonValue === null ? null : oracleString(reasonValue, `${path}.reason`);
  const decoded = Object.freeze({
    status,
    observationRoot: oracleHash(dataField(record, "observationRoot", path), `${path}.observationRoot`),
    windowSelectionRoot: nullableHashAt("windowSelectionRoot"),
    selectionPolicyDigest: nullableHashAt("selectionPolicyDigest"),
    eligibleSuccessCount,
    eligibleSuccessRoot: nullableHashAt("eligibleSuccessRoot"),
    selectedIndex: selectedIndexValue as "0" | null,
    selectedProducerTerminalId: nullableHashAt("selectedProducerTerminalId"),
    reason,
    joinedProcessEvidenceRoot: nullableHashAt("joinedProcessEvidenceRoot"),
    performanceAppendRecordId: nullableHashAt("performanceAppendRecordId"),
    producerTerminalAppendRecordId: nullableHashAt("producerTerminalAppendRecordId"),
    predicateArtifactCount: oracleDecimal(dataField(record, "predicateArtifactCount", path), `${path}.predicateArtifactCount`),
    predicateArtifactRoot: oracleHash(dataField(record, "predicateArtifactRoot", path), `${path}.predicateArtifactRoot`),
    eventArtifactRefIds: decodeOracleArray(dataField(record, "eventArtifactRefIds", path), oracleHash, `${path}.eventArtifactRefIds`),
  });
  const hasSelection = decoded.windowSelectionRoot !== null;
  const hasSelected = decoded.selectedIndex === "0" && decoded.selectedProducerTerminalId !== null;
  const hasJoined = decoded.joinedProcessEvidenceRoot !== null && decoded.performanceAppendRecordId !== null && decoded.producerTerminalAppendRecordId !== null;
  const partialJoined = decoded.joinedProcessEvidenceRoot !== null || decoded.performanceAppendRecordId !== null || decoded.producerTerminalAppendRecordId !== null;
  const missingReasons = new Set(["no-successful-dry-run", "terminal-binding-missing", "joined-process-evidence-missing"]);
  const invalidReasons = new Set(["window-selection-capability-invalid", "terminal-capability-invalid", "terminal-artifact-capability-invalid", "process-capability-invalid", "terminal-process-binding-mismatch"]);
  if ((decoded.windowSelectionRoot === null) !== (decoded.selectionPolicyDigest === null)
    || (decoded.windowSelectionRoot === null) !== (decoded.eligibleSuccessCount === null)
    || (decoded.windowSelectionRoot === null) !== (decoded.eligibleSuccessRoot === null)
    || (decoded.selectedIndex === null) !== (decoded.selectedProducerTerminalId === null)
    || (!hasSelection && hasSelected) || (hasSelection && decoded.eligibleSuccessCount === "0" && hasSelected)
    || (hasSelection && decoded.eligibleSuccessCount !== "0" && !hasSelected)
    || (status === "observed" && (!hasSelection || decoded.eligibleSuccessCount === "0" || !hasSelected || reason !== null || !hasJoined))
    || (status !== "observed" && (reason === null || partialJoined))
    || (status === "observed" && (decoded.predicateArtifactCount === "0" || decoded.eventArtifactRefIds.length === 0))
    || new Set(decoded.eventArtifactRefIds).size !== decoded.eventArtifactRefIds.length
    || (status !== "observed" && (decoded.predicateArtifactCount !== "0" || decoded.eventArtifactRefIds.length !== 0))
    || (status === "missing" && !missingReasons.has(reason as string))
    || (status === "invalid" && !invalidReasons.has(reason as string))
    || (reason === "no-successful-dry-run" && (!hasSelection || decoded.eligibleSuccessCount !== "0" || hasSelected))
    || (reason === "window-selection-capability-invalid" && hasSelection)
    || (reason !== null && reason !== "no-successful-dry-run" && reason !== "window-selection-capability-invalid"
      && (!hasSelection || decoded.eligibleSuccessCount === "0" || !hasSelected))) throw new TypeError(`inconsistent six-step denominator at ${path}`);
  return decoded;
}

function decodeOracleTerminalManifest(bytes: Uint8Array) {
  const path = "$";
  const record = exactDataRecord(decodeCanonicalJson(bytes), [
    "schemaVersion", "kind", "finalDurableWindowId", "windowId", "releaseAnchorRoot", "runtimeAnchorRoot",
    "runtimeArtifactRoot", "processAnchorRoot", "fullGraphCoarseSweepRoot", "terminalPhaseInvocationRoot",
    "fullFamily", "sixStep", "manifestRoot",
  ], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, "$.schemaVersion");
  oracleLiteral(dataField(record, "kind", path), "aloha.production-terminal-phase-manifest-v1", "$.kind");
  const decoded = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-manifest-v1" as const,
    finalDurableWindowId: oracleHash(dataField(record, "finalDurableWindowId", path), "$.finalDurableWindowId"),
    windowId: oracleHash(dataField(record, "windowId", path), "$.windowId"),
    releaseAnchorRoot: oracleHash(dataField(record, "releaseAnchorRoot", path), "$.releaseAnchorRoot"),
    runtimeAnchorRoot: oracleHash(dataField(record, "runtimeAnchorRoot", path), "$.runtimeAnchorRoot"),
    runtimeArtifactRoot: oracleHash(dataField(record, "runtimeArtifactRoot", path), "$.runtimeArtifactRoot"),
    processAnchorRoot: oracleHash(dataField(record, "processAnchorRoot", path), "$.processAnchorRoot"),
    fullGraphCoarseSweepRoot: oracleHash(dataField(record, "fullGraphCoarseSweepRoot", path), "$.fullGraphCoarseSweepRoot"),
    terminalPhaseInvocationRoot: oracleHash(dataField(record, "terminalPhaseInvocationRoot", path), "$.terminalPhaseInvocationRoot"),
    fullFamily: (() => {
      const fullFamily = exactDataRecord(dataField(record, "fullFamily", path), ["projectionArtifactRefId", "projectionContentSha256"], "$.fullFamily");
      return Object.freeze({
        projectionArtifactRefId: oracleHash(dataField(fullFamily, "projectionArtifactRefId", "$.fullFamily"), "$.fullFamily.projectionArtifactRefId"),
        projectionContentSha256: oracleHash(dataField(fullFamily, "projectionContentSha256", "$.fullFamily"), "$.fullFamily.projectionContentSha256"),
      });
    })(),
    sixStep: decodeTerminalSixStep(dataField(record, "sixStep", path), "$.sixStep"),
    manifestRoot: oracleHash(dataField(record, "manifestRoot", path), "$.manifestRoot"),
  });
  const { manifestRoot: _root, ...core } = decoded;
  if (decoded.manifestRoot !== hashDomain("aloha/production-terminal-phase-manifest/v1", core as unknown as CanonicalJson)) {
    throw new TypeError("terminal phase manifest root mismatch");
  }
  return decoded;
}

function decodeDurableAppend(value: unknown, path: string) {
  const record = exactDataRecord(value, [
    "namespace", "sequence", "eventId", "contentSha256", "byteLength", "offsetStart", "offsetEnd", "fsynced",
  ], path);
  return Object.freeze({
    namespace: oracleString(dataField(record, "namespace", path), `${path}.namespace`),
    sequence: oracleDecimal(dataField(record, "sequence", path), `${path}.sequence`),
    eventId: oracleHash(dataField(record, "eventId", path), `${path}.eventId`),
    contentSha256: oracleHash(dataField(record, "contentSha256", path), `${path}.contentSha256`),
    byteLength: oracleDecimal(dataField(record, "byteLength", path), `${path}.byteLength`),
    offsetStart: oracleDecimal(dataField(record, "offsetStart", path), `${path}.offsetStart`),
    offsetEnd: oracleDecimal(dataField(record, "offsetEnd", path), `${path}.offsetEnd`),
    fsynced: oracleLiteral(dataField(record, "fsynced", path), true, `${path}.fsynced`),
  });
}

function decodeRuntimeAnchor(value: unknown, path: string) {
  const record = exactDataRecord(value, [
    "kind", "manifestHash", "manifestArtifactSha256", "bindingId", "releaseProvenanceHash",
    "candidateReleaseCommit", "runtimeArtifactRoot", "implementationClosureDigest", "entrypointSha256",
    "nodeExecutableSha256", "bundleModulePath", "bundleModuleSha256", "serviceName", "systemdUnit",
    "bootId", "invocationId", "logDevice", "logInode", "pid", "processStartTicks", "dryRun",
  ], path);
  oracleLiteral(dataField(record, "kind", path), "aloha.searcher-runtime-anchor-v1", `${path}.kind`);
  return Object.freeze({
    kind: "aloha.searcher-runtime-anchor-v1" as const,
    manifestHash: oracleHash(dataField(record, "manifestHash", path), `${path}.manifestHash`),
    manifestArtifactSha256: oracleHash(dataField(record, "manifestArtifactSha256", path), `${path}.manifestArtifactSha256`),
    bindingId: oracleHash(dataField(record, "bindingId", path), `${path}.bindingId`),
    releaseProvenanceHash: oracleHash(dataField(record, "releaseProvenanceHash", path), `${path}.releaseProvenanceHash`),
    candidateReleaseCommit: oracleGitSha40(dataField(record, "candidateReleaseCommit", path), `${path}.candidateReleaseCommit`),
    runtimeArtifactRoot: oracleHash(dataField(record, "runtimeArtifactRoot", path), `${path}.runtimeArtifactRoot`),
    implementationClosureDigest: oracleHash(dataField(record, "implementationClosureDigest", path), `${path}.implementationClosureDigest`),
    entrypointSha256: oracleHash(dataField(record, "entrypointSha256", path), `${path}.entrypointSha256`),
    nodeExecutableSha256: oracleHash(dataField(record, "nodeExecutableSha256", path), `${path}.nodeExecutableSha256`),
    bundleModulePath: oracleString(dataField(record, "bundleModulePath", path), `${path}.bundleModulePath`),
    bundleModuleSha256: oracleHash(dataField(record, "bundleModuleSha256", path), `${path}.bundleModuleSha256`),
    serviceName: oracleString(dataField(record, "serviceName", path), `${path}.serviceName`),
    systemdUnit: oracleString(dataField(record, "systemdUnit", path), `${path}.systemdUnit`),
    bootId: oracleString(dataField(record, "bootId", path), `${path}.bootId`),
    invocationId: oracleString(dataField(record, "invocationId", path), `${path}.invocationId`),
    logDevice: oracleDecimal(dataField(record, "logDevice", path), `${path}.logDevice`),
    logInode: oracleDecimal(dataField(record, "logInode", path), `${path}.logInode`),
    pid: oracleDecimal(dataField(record, "pid", path), `${path}.pid`),
    processStartTicks: oracleDecimal(dataField(record, "processStartTicks", path), `${path}.processStartTicks`),
    dryRun: oracleLiteral(dataField(record, "dryRun", path), true, `${path}.dryRun`),
  });
}

function oracleProcessAnchorRoot(value: ReturnType<typeof decodeRuntimeAnchor>): Hash {
  return hashDomain("aloha/production-terminal-phase-process-anchor/v1", {
    bootId: value.bootId,
    invocationId: value.invocationId,
    logDevice: value.logDevice,
    logInode: value.logInode,
    pid: value.pid,
    processStartTicks: value.processStartTicks,
  });
}

function oracleRuntimeAnchorRoot(value: ReturnType<typeof decodeRuntimeAnchor>): Hash {
  return hashDomain("aloha/production-terminal-phase-runtime-anchor/v1", value as unknown as CanonicalJson);
}

function decodeOracleProcessEvidence(bytes: Uint8Array) {
  const path = "$";
  const record = exactDataRecord(decodeCanonicalJson(bytes), [
    "schemaVersion", "kind", "runtimeBindingId", "candidateReleaseCommit", "releaseProvenanceHash",
    "terminalBindingRoot", "traceRoot", "correlationId", "generationId", "readyRecordHash", "graphRoot",
    "currentSource", "programHash", "finalSimulationReceiptHash", "stage12", "stage12Root", "sixStepLineageRoot",
    "runtimeFacts", "runtimeFactsRoot", "producerSchedulerJoin", "producerSchedulerJoinRoot", "runtimeAnchor",
    "runtimeAnchorRoot", "serving", "canonicalHead", "admissionId", "producerTerminalId",
    "producerTerminalBindingRoot", "durableAppend", "durableAppendRecordId", "producerTerminalDurableAppend",
    "producerTerminalDurableAppendRecordId", "evidenceRoot",
  ], path);
  oracleLiteral(dataField(record, "schemaVersion", path), 1, "$.schemaVersion");
  oracleLiteral(dataField(record, "kind", path), "aloha.searcher-production-six-step-process-evidence-v1", "$.kind");
  const decoded = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.searcher-production-six-step-process-evidence-v1" as const,
    runtimeBindingId: oracleHash(dataField(record, "runtimeBindingId", path), "$.runtimeBindingId"),
    candidateReleaseCommit: oracleGitSha40(dataField(record, "candidateReleaseCommit", path), "$.candidateReleaseCommit"),
    releaseProvenanceHash: oracleHash(dataField(record, "releaseProvenanceHash", path), "$.releaseProvenanceHash"),
    terminalBindingRoot: oracleHash(dataField(record, "terminalBindingRoot", path), "$.terminalBindingRoot"),
    traceRoot: oracleHash(dataField(record, "traceRoot", path), "$.traceRoot"),
    correlationId: oracleHash(dataField(record, "correlationId", path), "$.correlationId"),
    generationId: oracleString(dataField(record, "generationId", path), "$.generationId"),
    readyRecordHash: oracleHash(dataField(record, "readyRecordHash", path), "$.readyRecordHash"),
    graphRoot: oracleHash(dataField(record, "graphRoot", path), "$.graphRoot"),
    currentSource: decodeCurrentSource(dataField(record, "currentSource", path), "$.currentSource"),
    programHash: oracleHash(dataField(record, "programHash", path), "$.programHash"),
    finalSimulationReceiptHash: oracleHash(dataField(record, "finalSimulationReceiptHash", path), "$.finalSimulationReceiptHash"),
    stage12: decodeOracleCanonicalObject(dataField(record, "stage12", path), "$.stage12"),
    stage12Root: oracleHash(dataField(record, "stage12Root", path), "$.stage12Root"),
    sixStepLineageRoot: oracleHash(dataField(record, "sixStepLineageRoot", path), "$.sixStepLineageRoot"),
    runtimeFacts: decodeOracleCanonicalObject(dataField(record, "runtimeFacts", path), "$.runtimeFacts"),
    runtimeFactsRoot: oracleHash(dataField(record, "runtimeFactsRoot", path), "$.runtimeFactsRoot"),
    producerSchedulerJoin: decodeProducerSchedulerJoin(dataField(record, "producerSchedulerJoin", path), "$.producerSchedulerJoin"),
    producerSchedulerJoinRoot: oracleHash(dataField(record, "producerSchedulerJoinRoot", path), "$.producerSchedulerJoinRoot"),
    runtimeAnchor: decodeRuntimeAnchor(dataField(record, "runtimeAnchor", path), "$.runtimeAnchor"),
    runtimeAnchorRoot: oracleHash(dataField(record, "runtimeAnchorRoot", path), "$.runtimeAnchorRoot"),
    serving: decodeServingIdentity(dataField(record, "serving", path), "$.serving"),
    canonicalHead: decodeCanonicalHead(dataField(record, "canonicalHead", path), "$.canonicalHead"),
    admissionId: oracleHash(dataField(record, "admissionId", path), "$.admissionId"),
    producerTerminalId: oracleHash(dataField(record, "producerTerminalId", path), "$.producerTerminalId"),
    producerTerminalBindingRoot: oracleHash(dataField(record, "producerTerminalBindingRoot", path), "$.producerTerminalBindingRoot"),
    durableAppend: decodeDurableAppend(dataField(record, "durableAppend", path), "$.durableAppend"),
    durableAppendRecordId: oracleHash(dataField(record, "durableAppendRecordId", path), "$.durableAppendRecordId"),
    producerTerminalDurableAppend: decodeDurableAppend(dataField(record, "producerTerminalDurableAppend", path), "$.producerTerminalDurableAppend"),
    producerTerminalDurableAppendRecordId: oracleHash(dataField(record, "producerTerminalDurableAppendRecordId", path), "$.producerTerminalDurableAppendRecordId"),
    evidenceRoot: oracleHash(dataField(record, "evidenceRoot", path), "$.evidenceRoot"),
  });
  const { evidenceRoot: _root, ...core } = decoded;
  if (decoded.evidenceRoot !== hashDomain("aloha/searcher-production-six-step-process-evidence/v1", core as unknown as CanonicalJson)
    || decoded.stage12Root !== hashDomain("aloha/searcher-production-evidence-stage12/v1", decoded.stage12 as unknown as CanonicalJson)
    || decoded.sixStepLineageRoot !== hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
      stage12Root: decoded.stage12Root,
      stage36Root: decoded.traceRoot,
    })
    || decoded.runtimeFactsRoot !== hashDomain("aloha/searcher-production-six-step-runtime-facts/v1", decoded.runtimeFacts as unknown as CanonicalJson)
    || decoded.producerSchedulerJoinRoot !== hashDomain("aloha/searcher-production-six-step-producer-scheduler-join/v1", decoded.producerSchedulerJoin as unknown as CanonicalJson)
    || decoded.runtimeAnchorRoot !== hashDomain("aloha/searcher-production-six-step-runtime-anchor/v1", decoded.runtimeAnchor as unknown as CanonicalJson)
    || decoded.durableAppendRecordId !== hashDomain("aloha/searcher-production-six-step-durable-append/v1", decoded.durableAppend as unknown as CanonicalJson)
    || decoded.producerTerminalDurableAppendRecordId !== hashDomain("aloha/searcher-production-six-step-durable-append/v1", decoded.producerTerminalDurableAppend as unknown as CanonicalJson)) {
    throw new TypeError("selected process evidence root mismatch");
  }
  return decoded;
}

function add(reasons: string[], value: string): void {
  if (!reasons.includes(value)) reasons.push(value);
}

function same(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function hashField(record: Readonly<Record<string, CanonicalJson>>, key: string): Hash | null {
  const value = record[key];
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) ? value as Hash : null;
}

function stringField(record: Readonly<Record<string, CanonicalJson>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readArtifactEnvelope<T>(
  input: TerminalSelectionReferenceInputV1,
  refId: Hash,
  expectedSchema: Readonly<{ readonly id: string; readonly version: string; readonly schemaHash: Hash }> | null,
  decode: (bytes: Uint8Array) => T,
  reasons: string[],
  name: string,
): Readonly<{ ref: OracleReadOnlyArtifactRefV1; claim: OracleArtifactResolutionClaimV1; lease: OracleRetentionLeaseReceiptV1; value: T }> | null {
  const refs = input.refs.filter(raw => raw.artifactRefId === refId);
  const claims = input.claims.filter(raw => raw.artifactRefId === refId);
  if (refs.length !== 1 || claims.length !== 1) {
    add(reasons, `${name}-denominator`);
    return null;
  }
  let ref: OracleReadOnlyArtifactRefV1;
  let claim: OracleArtifactResolutionClaimV1;
  try {
    ref = decodeOracleReadOnlyArtifactRef(refs[0]!);
    claim = decodeOracleArtifactResolutionClaim(claims[0]!);
  } catch {
    add(reasons, `${name}-decode`);
    return null;
  }
  let policy: OracleResolverPolicyV1 | null = null;
  let lease: OracleRetentionLeaseReceiptV1 | null = null;
  try {
    policy = decodeOracleResolverPolicy(input.policies.find(raw => raw.policyHash === claim.resolverPolicyHash)!);
    lease = decodeOracleRetentionLeaseReceipt(input.leases.find(raw => raw.receiptId === ref.retentionLeaseReceiptId)!);
  } catch {
    add(reasons, `${name}-authority`);
    return null;
  }
  if ((expectedSchema !== null && !same(ref.schema, expectedSchema))
    || ref.mediaType !== "application/json"
    || ref.resolverPolicyHash !== policy.policyHash
    || policy.failureOutcome !== "invalid"
    || claim.outcome !== "content-observed"
    || claim.observedMirror === null
    || lease.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash
    || lease.objectKey !== ref.immutableMirrorLocator.objectKey
    || lease.contentSha256 !== ref.contentSha256) {
    add(reasons, `${name}-authority`);
    return null;
  }
  const mirror = claim.observedMirror;
  let bytes: Uint8Array;
  try {
    bytes = decodeOracleArtifactBytes(mirror.bytes);
  } catch {
    add(reasons, `${name}-bytes`);
    return null;
  }
  if (mirror.contentSha256 !== ref.contentSha256
    || mirror.byteLength !== ref.byteLength
    || mirror.objectKey !== ref.immutableMirrorLocator.objectKey
    || mirror.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash
    || mirror.mediaType !== ref.mediaType
    || !same(mirror.schema, ref.schema)
    || bytes.byteLength.toString() !== ref.byteLength
    || sha256Hex(bytes) !== ref.contentSha256
    || !input.observations.some(observation =>
      observation.rawArtifactRefs.some(raw => raw.artifactRefId === refId)
      && observation.observedClaimIds.includes(claim.claimId))) {
    add(reasons, `${name}-observation`);
    return null;
  }
  try {
    return Object.freeze({ ref, claim, lease, value: decode(bytes) });
  } catch {
    add(reasons, `${name}-content`);
    return null;
  }
}


function readArtifact<T>(
  input: TerminalSelectionReferenceInputV1,
  refId: Hash,
  expectedSchema: Readonly<{ readonly id: string; readonly version: string; readonly schemaHash: Hash }>,
  decode: (bytes: Uint8Array) => T,
  reasons: string[],
  name: string,
): T | null {
  return readArtifactEnvelope(input, refId, expectedSchema, decode, reasons, name)?.value ?? null;
}

function exactOracleObservationDenominator(
  input: TerminalSelectionReferenceInputV1,
  artifactRefIds: readonly Hash[],
): boolean {
  const expectedRefs = [...artifactRefIds].sort();
  const expectedClaims = artifactRefIds.map(artifactRefId => {
    const claims = input.claims.filter(claim => claim.artifactRefId === artifactRefId);
    return claims.length === 1 ? claims[0]!.claimId : null;
  });
  if (expectedClaims.some(value => value === null)) return false;
  return input.observations.some(observation =>
    same(observation.rawArtifactRefs.map(ref => ref.artifactRefId).sort(), expectedRefs)
    && same([...observation.observedClaimIds].sort(), (expectedClaims as Hash[]).sort()));
}

/** Qualification-only implementation. It replays the three-source joins and
 * never imports the production predicate or consumes its verdict. */
export function evaluateTerminalSelectionReferenceModel(
  input: TerminalSelectionReferenceInputV1,
): TerminalSelectionReferenceResultV1 {
  const reasons: string[] = [];
  if (input.facts.length !== 1) return Object.freeze({ verdict: "invalid", reasons: Object.freeze(["fact-denominator"]) });
  let fact: ReturnType<typeof decodeOracleTerminalSelectionFact>;
  try {
    fact = decodeOracleTerminalSelectionFact(input.facts[0]);
  } catch {
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze(["fact-decode"]) });
  }
  const hasSelectedProcess = fact.artifacts[3]?.role === ORACLE_ARTIFACT_ROLES[3];
  const predicateArtifacts = fact.artifacts.slice(hasSelectedProcess ? 4 : 3);
  if (fact.artifacts.length < 3
    || fact.artifacts.slice(0, 3).some((entry, index) => entry.role !== ORACLE_ARTIFACT_ROLES[index])
    || predicateArtifacts.some(entry => entry.role !== ORACLE_SIX_STEP_PREDICATE_ARTIFACT_ROLE)
    || predicateArtifacts.some((entry, index) => index > 0 && predicateArtifacts[index - 1]!.artifactRefId >= entry.artifactRefId)
    || new Set(fact.artifacts.map(entry => entry.artifactRefId)).size !== fact.artifacts.length) {
    return Object.freeze({ verdict: "invalid", reasons: Object.freeze(["fact-artifacts"]) });
  }
  const expectedRefs = fact.artifacts.map(entry => entry.artifactRefId);
  if (input.trustedObserverInvocation === undefined
    || input.trustedObserverInvocation === null
    || input.trustedObserverInvocation.roleId !== ORACLE_SIGNED_INVOCATION_ROLE_ID
    || !same([...input.trustedObserverInvocation.authenticatedArtifactRefIds].sort(), [...expectedRefs].sort())) {
    add(reasons, "observer-invocation");
  }
  if (!exactOracleObservationDenominator(input, expectedRefs)) add(reasons, "raw-observer-denominator");
  const raw = readArtifact(input, expectedRefs[0]!, ORACLE_ARTIFACT_SCHEMA_REFS.rawSelection, decodeOracleRawSelection, reasons, "raw");
  const manifest = readArtifact(input, expectedRefs[1]!, ORACLE_ARTIFACT_SCHEMA_REFS.terminalManifest, decodeOracleTerminalManifest, reasons, "manifest");
  const projectionEnvelope = readArtifactEnvelope(input, expectedRefs[2]!, ORACLE_ARTIFACT_SCHEMA_REFS.fullFamilyProjection, decodeOracleFullFamilyProjection, reasons, "projection");
  const projection = projectionEnvelope?.value ?? null;
  const process = hasSelectedProcess
    ? readArtifact(input, expectedRefs[3]!, ORACLE_ARTIFACT_SCHEMA_REFS.processEvidence, decodeOracleProcessEvidence, reasons, "process")
    : null;
  const closure = predicateArtifacts.map((entry, index) => readArtifactEnvelope(
    input,
    entry.artifactRefId,
    null,
    bytes => bytes,
    reasons,
    `six-step-predicate[${index}]`,
  ));
  if (manifest !== null && projectionEnvelope !== null
    && (manifest.fullFamily.projectionArtifactRefId !== projectionEnvelope.ref.artifactRefId
      || manifest.fullFamily.projectionContentSha256 !== projectionEnvelope.ref.contentSha256)) add(reasons, "manifest-projection-join");
  if (raw !== null && manifest !== null && projection !== null) {
    if (raw.databaseSha256Before !== raw.databaseSha256After
      || raw.storageSetRootBefore !== raw.storageSetRootAfter
      || raw.terminalPhaseRowCount !== "0"
      || raw.terminalPhaseRowRoot !== hashDomain("aloha/raw-production-terminal-phase-row-root/v1", [])) add(reasons, "sqlite-fence");
    if (raw.selection.selectionPolicyDigest !== EXPECTED_POLICY_DIGEST) add(reasons, "selection-policy");
    if (manifest.releaseAnchorRoot !== hashDomain("aloha/production-terminal-phase-release-anchor/v1", raw.release as unknown as CanonicalJson)) add(reasons, "release-anchor");
    if (manifest.terminalPhaseInvocationRoot !== hashDomain("aloha/production-terminal-phase-invocation/v1", {
        finalDurableWindowId: manifest.finalDurableWindowId,
        fullGraphCoarseSweepRoot: manifest.fullGraphCoarseSweepRoot,
        fullFamilyObservationRoot: projection.observationRoot,
        sixStepObservationRoot: manifest.sixStep.observationRoot,
        releaseAnchorRoot: manifest.releaseAnchorRoot,
        runtimeAnchorRoot: manifest.runtimeAnchorRoot,
        runtimeArtifactRoot: manifest.runtimeArtifactRoot,
        processAnchorRoot: manifest.processAnchorRoot,
      })) add(reasons, "terminal-invocation");
    if (raw.selection.finalDurableWindowId !== manifest.finalDurableWindowId
      || raw.selection.selectionRoot !== manifest.sixStep.windowSelectionRoot
      || raw.selection.selectionPolicyDigest !== manifest.sixStep.selectionPolicyDigest
      || raw.selection.eligibleSuccessCount !== manifest.sixStep.eligibleSuccessCount
      || raw.selection.eligibleSuccessRoot !== manifest.sixStep.eligibleSuccessRoot
      || raw.selection.selectedIndex !== manifest.sixStep.selectedIndex
      || raw.selection.selectedProducerTerminalId !== manifest.sixStep.selectedProducerTerminalId) add(reasons, "raw-manifest-join");
    if (raw.selection.selectedIndex === null && manifest.sixStep.status === "missing") {
      if (hasSelectedProcess || predicateArtifacts.length !== 0) add(reasons, "unexpected-process-artifact");
      if (input.trustedObserverInvocation?.candidateReleaseCommit !== stringField(raw.release, "candidateReleaseCommit")) add(reasons, "observer-release");
      return Object.freeze({ verdict: reasons.length === 0 ? "fail" : "invalid", reasons: Object.freeze(reasons) });
    }
    if (raw.selection.selectedIndex === null || manifest.sixStep.status !== "observed" || process === null) {
      add(reasons, "selected-terminal-denominator");
      return Object.freeze({ verdict: "invalid", reasons: Object.freeze(reasons) });
    }
    if (manifest.sixStep.joinedProcessEvidenceRoot !== process.evidenceRoot
      || manifest.sixStep.selectedProducerTerminalId !== process.producerTerminalId
      || raw.selection.selectedPerformanceEventId !== process.durableAppend.eventId
      || raw.selection.selectedProducerTerminalEventId !== process.producerTerminalDurableAppend.eventId
      || manifest.sixStep.performanceAppendRecordId !== process.durableAppendRecordId
      || manifest.sixStep.producerTerminalAppendRecordId !== process.producerTerminalDurableAppendRecordId) add(reasons, "manifest-process-join");
    const completeClosure = closure.filter((value): value is NonNullable<typeof value> => value !== null);
    const closureRows = completeClosure.map(value => Object.freeze({
      artifactRefId: value.ref.artifactRefId,
      contentSha256: value.ref.contentSha256,
      claimId: value.claim.claimId,
      leaseReceiptId: value.lease.receiptId,
    }));
    let orderedEventArtifactRefIds: readonly Hash[] | null = null;
    try {
      const events = completeClosure
        .filter(value => same(value.ref.schema, ORACLE_EVENT_SCHEMA_REF))
        .map(value => Object.freeze({
          artifactRefId: value.ref.artifactRefId,
          ordinal: decodeOracleEventOrdinal(value.value),
        }))
        .sort((left, right) => left.ordinal - right.ordinal
          || left.artifactRefId.localeCompare(right.artifactRefId));
      if (events.length > 0 && new Set(events.map(value => value.artifactRefId)).size === events.length) {
        orderedEventArtifactRefIds = Object.freeze(events.map(value => value.artifactRefId));
      }
    } catch {
      orderedEventArtifactRefIds = null;
    }
    if (closure.length !== completeClosure.length
      || manifest.sixStep.predicateArtifactCount !== String(predicateArtifacts.length)
      || manifest.sixStep.predicateArtifactRoot !== hashDomain("aloha/production-six-step-predicate-artifact-closure/v1", closureRows)
      || completeClosure.length !== predicateArtifacts.length
      || orderedEventArtifactRefIds === null
      || !same(manifest.sixStep.eventArtifactRefIds, orderedEventArtifactRefIds)) add(reasons, "six-step-artifact-closure");
    if (process.durableAppend.namespace !== "searcher-production-evidence/performance/v1"
      || process.producerTerminalDurableAppend.namespace !== "searcher-production-evidence/producer-terminals/v1") add(reasons, "durable-namespace");
    if (manifest.processAnchorRoot !== oracleProcessAnchorRoot(process.runtimeAnchor)
      || manifest.runtimeAnchorRoot !== oracleRuntimeAnchorRoot(process.runtimeAnchor)
      || manifest.runtimeArtifactRoot !== process.runtimeAnchor.runtimeArtifactRoot) add(reasons, "process-anchor");
    if (process.runtimeBindingId !== process.runtimeAnchor.bindingId
      || process.releaseProvenanceHash !== process.runtimeAnchor.releaseProvenanceHash
      || process.candidateReleaseCommit !== process.runtimeAnchor.candidateReleaseCommit) add(reasons, "process-release-anchor");
    if (hashField(raw.release, "bindingId") !== process.runtimeBindingId
      || hashField(raw.release, "releaseProvenanceHash") !== process.releaseProvenanceHash
      || stringField(raw.release, "candidateReleaseCommit") !== process.candidateReleaseCommit
      || stringField(raw.serving, "generationId") !== process.generationId
      || hashField(raw.serving, "graphRoot") !== process.graphRoot
      || hashField(raw.serving, "readyRecordHash") !== process.readyRecordHash
      || hashField(raw.serving, "sourceCoverageRoot") !== process.serving.sourceCoverageRoot) add(reasons, "raw-process-anchor");
    if (input.trustedObserverInvocation?.candidateReleaseCommit !== process.candidateReleaseCommit) add(reasons, "observer-release");
    if (projection.producerTerminalBindingRoot !== process.producerTerminalBindingRoot
      || projection.finalDurableWindowId !== manifest.finalDurableWindowId
      || projection.readyRecordHash !== process.readyRecordHash
      || projection.fullGraphCoarseSweepRoot !== manifest.fullGraphCoarseSweepRoot) add(reasons, "terminal-process-binding");
  }
  return Object.freeze({
    verdict: reasons.length === 0 ? "pass" : "invalid",
    reasons: Object.freeze(reasons),
  });
}
