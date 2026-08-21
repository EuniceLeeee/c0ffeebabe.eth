import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  assertSemVer,
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  readOwnEnumerableDataProperty,
  sha256Hex,
  stringSchema,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

// Keep the descriptor identity local so the oracle compiler closure does not
// pull in the production schema manifest merely to re-export a constant.
export const ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST = sha256Hex([
  "aloha/artifact-lineage/oracle-program-descriptor/v2",
  "sha256-bytes",
  "canonical-hex-copy",
  "exact-locator-media-schema",
  "outcome-required",
  "lease-epoch-only",
  "producer-outcome-ignored",
].join("\0"));

/** Stable plugin-owned oracle binding consumed by the release generator. */
export const ORACLE_PROGRAM_DESCRIPTOR_DIGEST = ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST;
export const ORACLE_VERSION = "artifact-lineage-independent-oracle-v2" as const;

/*
 * This file is deliberately a clean-room oracle. It may use canonical/hash
 * primitives and wire types, but it must not call the artifact-lineage
 * production decoder (or any predicate/qualification entry point). A bug in
 * that decoder therefore cannot make the oracle and live predicate fail
 * together.
 */

// These are local wire shapes, not imports from executable production schemas.
type ArtifactLineageCodecInput = string | Uint8Array | object;
type ArtifactLineageVerdict = "pass" | "fail" | "invalid";
type ArtifactLineageReasonCode =
  | "claim-decode-failed" | "observation-decode-failed" | "raw-shape-invalid" | "raw-bytes-missing"
  | "raw-bytes-hostile" | "raw-observation-mismatch" | "artifact-ref-length-mismatch"
  | "resolution-outcome-mismatch" | "locator-mismatch" | "object-key-mismatch" | "media-mismatch"
  | "schema-mismatch" | "lease-subject-mismatch" | "lease-out-of-range"
  | "lease-remaining-too-short" | "policy-mismatch" | "subject-content-mismatch";

interface SchemaRef {
  readonly id: string;
  readonly version: string;
  readonly schemaHash: Hash;
}

interface FileRangeLocator {
  readonly kind: "file-range";
  readonly systemId: string;
  readonly bootIdHash: Hash;
  readonly device: string;
  readonly inode: string;
  readonly startInclusive: string;
  readonly endExclusive: string;
}

interface CheckpointRecordLocator {
  readonly kind: "checkpoint-record";
  readonly storeIdentityHash: Hash;
  readonly namespaceHash: Hash;
  readonly keyHash: Hash;
  readonly revision: string;
  readonly recordHash: Hash;
}

interface ChainObjectLocator {
  readonly kind: "chain-object";
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly objectKind: "header" | "transaction" | "receipt" | "state-proof" | "logs";
  readonly objectKeyHash: Hash;
}

interface ContentObjectLocator {
  readonly kind: "content-object";
  readonly storeIdentityHash: Hash;
  readonly objectKey: Hash;
}

interface JsonPointerLocator {
  readonly kind: "json-pointer";
  readonly parentLocatorId: Hash;
  readonly pointer: string;
}

type ReadOnlyArtifactLocatorV1 =
  | FileRangeLocator
  | CheckpointRecordLocator
  | ChainObjectLocator
  | ContentObjectLocator
  | JsonPointerLocator;

interface ReadOnlyArtifactRefV1 {
  readonly artifactRefId: Hash;
  readonly locatorId: Hash;
  readonly locator: ReadOnlyArtifactLocatorV1;
  readonly immutableMirrorLocatorId: Hash;
  readonly immutableMirrorLocator: ContentObjectLocator;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly mediaType: string;
  readonly schema: SchemaRef | null;
  readonly resolverPolicyHash: Hash;
  readonly retentionLeaseReceiptId: Hash;
}

interface ResolverPolicyV1 {
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

interface RetentionLeaseReceiptV1 {
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

interface ObservedImmutableMirrorV1 {
  readonly storeIdentityHash: Hash;
  readonly objectKey: Hash;
  readonly bytes: string;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly mediaType: string;
  readonly schema: SchemaRef | null;
}

interface ArtifactResolutionClaimV1 {
  readonly claimId: Hash;
  readonly artifactRefId: Hash;
  readonly resolverPolicyHash: Hash;
  readonly observedMirror: ObservedImmutableMirrorV1 | null;
  readonly outcome: "content-observed" | "missing" | "content-mismatch";
}

interface ArtifactLineageClaimV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.artifact-lineage-claim";
  readonly artifactRef: ReadOnlyArtifactRefV1;
  readonly resolverPolicy: ResolverPolicyV1;
  readonly resolutionClaim: ArtifactResolutionClaimV1;
  readonly retentionLease: RetentionLeaseReceiptV1;
  readonly observedStoreEpoch: string;
  readonly claimId: Hash;
}

interface ArtifactLineageObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.artifact-lineage-observation";
  readonly artifactRefId: Hash;
  readonly locator: ReadOnlyArtifactLocatorV1;
  readonly immutableMirrorLocator: ContentObjectLocator;
  readonly rawBytes: string | null;
  readonly contentSha256: Hash | null;
  readonly byteLength: string | null;
  readonly mediaType: string | null;
  readonly schema: SchemaRef | null;
  readonly observedStoreEpoch: string;
  readonly observationId: Hash;
  readonly payloadHash: Hash;
}

interface ArtifactLineageRawFactsInputV1 {
  readonly rawBytes: string | null;
  readonly locator: ReadOnlyArtifactLocatorV1;
  readonly immutableMirrorLocator: ContentObjectLocator;
  readonly mediaType: string;
  readonly schema: SchemaRef | null;
  readonly observedStoreEpoch: string;
}

interface ArtifactLineagePredicateResult {
  readonly verdict: ArtifactLineageVerdict;
  readonly reasons: readonly ArtifactLineageReasonCode[];
  readonly claimId: Hash | null;
  readonly observationId: Hash | null;
}

interface OracleRawFacts {
  readonly rawBytes: string;
  readonly locator: ReadOnlyArtifactLocatorV1;
  readonly immutableMirrorLocator: ReadOnlyArtifactLocatorV1;
  readonly mediaType: string;
  readonly schema: SchemaRef | null;
  readonly observedStoreEpoch: string;
}

function parseOracleInput(value: ArtifactLineageCodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

function oracleString(value: unknown, path: string): string {
  return stringSchema.decode(value, path);
}

function oracleHash(value: unknown, path: string): Hash {
  return assertHash(value, path);
}

function oracleDecimal(value: unknown, path: string): string {
  return assertDecimalString(value, path);
}

function oracleNonEmpty(value: unknown, path: string): string {
  return assertNonEmptyString(value, path);
}

function oracleLiteral<T extends string | number | boolean>(
  expected: T,
): (value: unknown, path: string) => T {
  return (value, path) => {
    if (value !== expected) throw new TypeError(`expected ${JSON.stringify(expected)} at ${path}`);
    return expected;
  };
}

function oracleNullable<T>(decoder: (value: unknown, path: string) => T): (value: unknown, path: string) => T | null {
  return (value, path) => value === null ? null : decoder(value, path);
}

function oracleObject(
  value: unknown,
  path: string,
  fields: Readonly<Record<string, (value: unknown, path: string) => unknown>>,
): Record<string, unknown> {
  const keys = Object.keys(fields);
  assertExactKeys(value, keys, path);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    output[key] = fields[key]!(
      readOwnEnumerableDataProperty(value, key, path),
      `${path}.${key}`,
    );
  }
  return Object.freeze(output);
}

function exactRawRelation(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function hexByteLength(value: string): number | null {
  return /^0x(?:[0-9a-f]{2})*$/.test(value) ? (value.length - 2) / 2 : null;
}

function decodeHex(value: string): Uint8Array {
  const length = hexByteLength(value);
  if (length === null) throw new TypeError("invalid hex");
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function decodeOracleSchemaRef(value: unknown, path: string): SchemaRef {
  return oracleObject(value, path, {
    id: oracleNonEmpty,
    version: (entry, entryPath) => assertSemVer(entry, entryPath),
    schemaHash: oracleHash,
  }) as unknown as SchemaRef;
}

function decodeOracleLocator(value: unknown, path: string): ReadOnlyArtifactLocatorV1 {
  assertPlainObject(value, path);
  const kind = readOwnEnumerableDataProperty(value, "kind", path);
  switch (kind) {
    case "file-range":
      return oracleObject(value, path, {
        kind: oracleLiteral("file-range"),
        systemId: oracleNonEmpty,
        bootIdHash: oracleHash,
        device: oracleDecimal,
        inode: oracleDecimal,
        startInclusive: oracleDecimal,
        endExclusive: oracleDecimal,
      }) as unknown as ReadOnlyArtifactLocatorV1;
    case "checkpoint-record":
      return oracleObject(value, path, {
        kind: oracleLiteral("checkpoint-record"),
        storeIdentityHash: oracleHash,
        namespaceHash: oracleHash,
        keyHash: oracleHash,
        revision: oracleDecimal,
        recordHash: oracleHash,
      }) as unknown as ReadOnlyArtifactLocatorV1;
    case "chain-object":
      return oracleObject(value, path, {
        kind: oracleLiteral("chain-object"),
        chainId: oracleDecimal,
        blockNumber: oracleDecimal,
        blockHash: oracleHash,
        objectKind: (entry, entryPath) => {
          if (entry !== "header" && entry !== "transaction" && entry !== "receipt" && entry !== "state-proof" && entry !== "logs") {
            throw new TypeError(`invalid chain object kind at ${entryPath}`);
          }
          return entry;
        },
        objectKeyHash: oracleHash,
      }) as unknown as ReadOnlyArtifactLocatorV1;
    case "content-object":
      return oracleObject(value, path, {
        kind: oracleLiteral("content-object"),
        storeIdentityHash: oracleHash,
        objectKey: oracleHash,
      }) as unknown as ReadOnlyArtifactLocatorV1;
    case "json-pointer":
      return oracleObject(value, path, {
        kind: oracleLiteral("json-pointer"),
        parentLocatorId: oracleHash,
        pointer: oracleString,
      }) as unknown as ReadOnlyArtifactLocatorV1;
    default:
      throw new TypeError(`unknown locator kind at ${path}.kind`);
  }
}

function decodeOracleContentLocator(value: unknown, path: string): ReadOnlyArtifactLocatorV1 {
  const locator = decodeOracleLocator(value, path);
  if (locator.kind !== "content-object") throw new TypeError(`expected content-object locator at ${path}`);
  return locator;
}

function locatorId(locator: ReadOnlyArtifactLocatorV1): Hash {
  return hashDomain("aloha/read-only-artifact-locator/v1", locator);
}

function decodeOracleArtifactRef(value: unknown, path: string): ReadOnlyArtifactRefV1 {
  const decoded = oracleObject(value, path, {
    artifactRefId: oracleHash,
    locatorId: oracleHash,
    locator: decodeOracleLocator,
    immutableMirrorLocatorId: oracleHash,
    immutableMirrorLocator: decodeOracleContentLocator,
    contentSha256: oracleHash,
    byteLength: oracleDecimal,
    mediaType: oracleNonEmpty,
    schema: oracleNullable(decodeOracleSchemaRef),
    resolverPolicyHash: oracleHash,
    retentionLeaseReceiptId: oracleHash,
  }) as unknown as ReadOnlyArtifactRefV1;
  if (decoded.immutableMirrorLocator.objectKey !== decoded.contentSha256) {
    throw new TypeError(`immutable mirror objectKey does not match content hash at ${path}`);
  }
  if (decoded.locator.kind === "file-range") {
    const start = BigInt(decoded.locator.startInclusive);
    const end = BigInt(decoded.locator.endExclusive);
    if (end < start || end - start !== BigInt(decoded.byteLength)) {
      throw new TypeError(`file-range length does not match byteLength at ${path}`);
    }
  }
  if (decoded.locatorId !== locatorId(decoded.locator)) {
    throw new TypeError(`locatorId does not match locator at ${path}`);
  }
  if (decoded.immutableMirrorLocatorId !== locatorId(decoded.immutableMirrorLocator)) {
    throw new TypeError(`immutableMirrorLocatorId does not match locator at ${path}`);
  }
  const expectedId = hashDomain("aloha/read-only-artifact-ref/v1", {
    locatorId: decoded.locatorId,
    immutableMirrorLocatorId: decoded.immutableMirrorLocatorId,
    contentSha256: decoded.contentSha256,
    byteLength: decoded.byteLength,
    mediaType: decoded.mediaType,
    schema: decoded.schema,
    resolverPolicyHash: decoded.resolverPolicyHash,
    retentionLeaseReceiptId: decoded.retentionLeaseReceiptId,
  });
  if (decoded.artifactRefId !== expectedId) throw new TypeError(`artifactRefId does not match payload at ${path}`);
  return decoded;
}

function decodeOracleResolverPolicy(value: unknown, path: string): ResolverPolicyV1 {
  const policy = oracleObject(value, path, {
    schemaVersion: oracleLiteral(1),
    kind: oracleLiteral("aloha.artifact-resolver-policy"),
    policyHash: oracleHash,
    allowedLocatorKind: oracleLiteral("content-object"),
    digestAlgorithm: oracleLiteral("sha256"),
    maxByteLength: oracleDecimal,
    requireExactLengthMediaAndSchema: oracleLiteral(true),
    minimumRemainingStoreEpochs: oracleDecimal,
    failureOutcome: oracleLiteral("invalid"),
  }) as unknown as ResolverPolicyV1;
  if (BigInt(policy.maxByteLength) <= 0n) throw new TypeError(`maxByteLength must be positive at ${path}`);
  const { policyHash: _policyHash, ...payload } = policy;
  if (policy.policyHash !== hashDomain("aloha/artifact-resolver-policy/v1", payload)) {
    throw new TypeError(`policyHash does not match payload at ${path}`);
  }
  return policy;
}

function decodeOracleLease(value: unknown, path: string): RetentionLeaseReceiptV1 {
  const lease = oracleObject(value, path, {
    receiptId: oracleHash,
    storeIdentityHash: oracleHash,
    objectKey: oracleHash,
    contentSha256: oracleHash,
    validFromStoreEpoch: oracleDecimal,
    validThroughStoreEpoch: oracleDecimal,
    issuerId: oracleNonEmpty,
    issuerQualificationId: oracleHash,
    qualificationRegistryRoot: oracleHash,
  }) as unknown as RetentionLeaseReceiptV1;
  if (BigInt(lease.validThroughStoreEpoch) < BigInt(lease.validFromStoreEpoch)) {
    throw new TypeError(`lease interval is reversed at ${path}`);
  }
  const { receiptId: _receiptId, ...payload } = lease;
  if (lease.receiptId !== hashDomain("aloha/retention-lease-receipt/v1", payload)) {
    throw new TypeError(`receiptId does not match payload at ${path}`);
  }
  return lease;
}

function preflightOracleMirrorBudget(value: unknown, maxByteLength: bigint, path: string): void {
  assertPlainObject(value, path);
  assertExactKeys(value, ["storeIdentityHash", "objectKey", "bytes", "contentSha256", "byteLength", "mediaType", "schema"], path);
  const bytes = oracleString(readOwnEnumerableDataProperty(value, "bytes", path), `${path}.bytes`);
  const byteLength = BigInt(oracleDecimal(readOwnEnumerableDataProperty(value, "byteLength", path), `${path}.byteLength`));
  if (byteLength > maxByteLength || BigInt(Math.max(0, bytes.length - 2)) > maxByteLength * 2n) {
    throw new TypeError(`mirror bytes exceed resolver policy before decode at ${path}.bytes`);
  }
}

function decodeOracleObservedMirror(
  value: unknown,
  path: string,
  maxByteLength?: bigint,
): ObservedImmutableMirrorV1 {
  if (maxByteLength !== undefined) preflightOracleMirrorBudget(value, maxByteLength, path);
  const mirror = oracleObject(value, path, {
    storeIdentityHash: oracleHash,
    objectKey: oracleHash,
    bytes: oracleString,
    contentSha256: oracleHash,
    byteLength: oracleDecimal,
    mediaType: oracleNonEmpty,
    schema: oracleNullable(decodeOracleSchemaRef),
  }) as unknown as ObservedImmutableMirrorV1;
  const length = hexByteLength(mirror.bytes);
  if (length === null) throw new TypeError(`mirror bytes are not lowercase even hex at ${path}`);
  const bytes = decodeHex(mirror.bytes);
  if (String(length) !== mirror.byteLength || sha256Hex(bytes) !== mirror.contentSha256) {
    throw new TypeError(`mirror bytes do not match sidecars at ${path}`);
  }
  return mirror;
}

function decodeOracleResolutionClaim(
  value: unknown,
  path: string,
  maxByteLength: bigint,
): ArtifactResolutionClaimV1 {
  const claim = oracleObject(value, path, {
    claimId: oracleHash,
    artifactRefId: oracleHash,
    resolverPolicyHash: oracleHash,
    observedMirror: oracleNullable((entry, entryPath) => decodeOracleObservedMirror(entry, entryPath, maxByteLength)),
    outcome: (entry, entryPath) => {
      if (entry !== "content-observed" && entry !== "missing" && entry !== "content-mismatch") {
        throw new TypeError(`invalid resolution outcome at ${entryPath}`);
      }
      return entry;
    },
  }) as unknown as ArtifactResolutionClaimV1;
  if (claim.outcome === "content-observed" && claim.observedMirror === null) {
    throw new TypeError(`content-observed resolution claim requires mirror at ${path}`);
  }
  if (claim.outcome === "missing" && claim.observedMirror !== null) {
    throw new TypeError(`missing resolution claim carries mirror at ${path}`);
  }
  const { claimId: _claimId, ...payload } = claim;
  if (claim.claimId !== hashDomain("aloha/artifact-resolution-claim/v1", payload)) {
    throw new TypeError(`resolution claim id does not match payload at ${path}`);
  }
  return claim;
}

function decodeOracleClaim(value: unknown, path: string): ArtifactLineageClaimV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "schemaVersion", "kind", "artifactRef", "resolverPolicy", "resolutionClaim",
    "retentionLease", "observedStoreEpoch", "claimId",
  ], path);
  const schemaVersion = oracleLiteral(1)(readOwnEnumerableDataProperty(value, "schemaVersion", path), `${path}.schemaVersion`);
  const kind = oracleLiteral("aloha.artifact-lineage-claim")(readOwnEnumerableDataProperty(value, "kind", path), `${path}.kind`);
  const artifactRef = decodeOracleArtifactRef(readOwnEnumerableDataProperty(value, "artifactRef", path), `${path}.artifactRef`);
  const resolverPolicy = decodeOracleResolverPolicy(readOwnEnumerableDataProperty(value, "resolverPolicy", path), `${path}.resolverPolicy`);
  const resolutionClaim = decodeOracleResolutionClaim(
    readOwnEnumerableDataProperty(value, "resolutionClaim", path),
    `${path}.resolutionClaim`,
    BigInt(resolverPolicy.maxByteLength),
  );
  const retentionLease = decodeOracleLease(readOwnEnumerableDataProperty(value, "retentionLease", path), `${path}.retentionLease`);
  const observedStoreEpoch = oracleDecimal(readOwnEnumerableDataProperty(value, "observedStoreEpoch", path), `${path}.observedStoreEpoch`);
  const claimId = oracleHash(readOwnEnumerableDataProperty(value, "claimId", path), `${path}.claimId`);
  const claim = Object.freeze({
    schemaVersion, kind, artifactRef, resolverPolicy, resolutionClaim, retentionLease, observedStoreEpoch, claimId,
  }) as ArtifactLineageClaimV1;
  if (artifactRef.resolverPolicyHash !== resolverPolicy.policyHash) throw new TypeError(`artifact ref policy mismatch at ${path}`);
  if (resolutionClaim.artifactRefId !== artifactRef.artifactRefId || resolutionClaim.resolverPolicyHash !== resolverPolicy.policyHash) {
    throw new TypeError(`resolution claim binding mismatch at ${path}`);
  }
  const mirror = artifactRef.immutableMirrorLocator;
  if (
    retentionLease.storeIdentityHash !== mirror.storeIdentityHash ||
    retentionLease.objectKey !== mirror.objectKey ||
    retentionLease.contentSha256 !== artifactRef.contentSha256 ||
    artifactRef.retentionLeaseReceiptId !== retentionLease.receiptId
  ) throw new TypeError(`retention lease subject mismatch at ${path}`);
  const { claimId: _claimId, ...payload } = claim;
  if (claimId !== hashDomain("aloha/artifact-lineage-claim/payload/v2", payload)) {
    throw new TypeError(`artifact-lineage claim id does not match payload at ${path}`);
  }
  return claim;
}

function decodeOracleObservation(value: unknown, path: string): ArtifactLineageObservationV1 {
  const decoded = oracleObject(value, path, {
    schemaVersion: oracleLiteral(1),
    kind: oracleLiteral("aloha.artifact-lineage-observation"),
    artifactRefId: oracleHash,
    locator: decodeOracleLocator,
    immutableMirrorLocator: decodeOracleContentLocator,
    rawBytes: oracleNullable((entry, entryPath) => {
      const bytes = oracleString(entry, entryPath);
      if (hexByteLength(bytes) === null) throw new TypeError(`invalid observation bytes at ${entryPath}`);
      return bytes;
    }),
    contentSha256: oracleNullable(oracleHash),
    byteLength: oracleNullable(oracleDecimal),
    mediaType: oracleNullable(oracleString),
    schema: oracleNullable(decodeOracleSchemaRef),
    observedStoreEpoch: oracleDecimal,
    observationId: oracleHash,
    payloadHash: oracleHash,
  }) as unknown as ArtifactLineageObservationV1;
  const empty = decoded.rawBytes === null;
  if (empty !== (decoded.contentSha256 === null && decoded.byteLength === null && decoded.mediaType === null)) {
    throw new TypeError(`raw observation sidecars are not all-null or all-present at ${path}`);
  }
  const { observationId: _observationId, payloadHash: _payloadHash, ...payload } = decoded;
  const expectedPayloadHash = hashDomain("aloha/artifact-lineage-observation/payload/v2", payload);
  if (decoded.payloadHash !== expectedPayloadHash) throw new TypeError(`observation payload hash mismatch at ${path}`);
  if (decoded.observationId !== hashDomain("aloha/artifact-lineage-observation/id/v2", expectedPayloadHash)) {
    throw new TypeError(`observation id mismatch at ${path}`);
  }
  return decoded;
}

function decodeOracleRawFacts(value: unknown, path = "$"): ArtifactLineageRawFactsInputV1 {
  const decoded = oracleObject(value, path, {
    rawBytes: oracleNullable((entry, entryPath) => {
      const bytes = oracleString(entry, entryPath);
      if (hexByteLength(bytes) === null) throw new TypeError(`invalid raw facts bytes at ${entryPath}`);
      return bytes;
    }),
    locator: decodeOracleLocator,
    immutableMirrorLocator: decodeOracleContentLocator,
    mediaType: oracleString,
    schema: oracleNullable(decodeOracleSchemaRef),
    observedStoreEpoch: oracleDecimal,
  }) as unknown as ArtifactLineageRawFactsInputV1;
  return decoded;
}

function hashBytes(bytes: Uint8Array): Hash {
  return sha256Hex(bytes);
}

function invalidResult(
  reason: ArtifactLineageReasonCode,
  claimId: Hash | null,
  observationId: Hash | null,
): ArtifactLineagePredicateResult {
  return Object.freeze({ verdict: "invalid", reasons: Object.freeze([reason]), claimId, observationId });
}

function failResult(
  reason: ArtifactLineageReasonCode,
  claimId: Hash,
  observationId: Hash,
): ArtifactLineagePredicateResult {
  return Object.freeze({ verdict: "fail", reasons: Object.freeze([reason]), claimId, observationId });
}

function readOracleRawFacts(value: unknown): OracleRawFacts {
  const parsed = decodeOracleRawFacts(parseOracleInput(value as ArtifactLineageCodecInput));
  if (parsed.rawBytes === null) throw new TypeError("missing");
  return Object.freeze({
    rawBytes: parsed.rawBytes,
    locator: parsed.locator,
    immutableMirrorLocator: parsed.immutableMirrorLocator,
    mediaType: parsed.mediaType,
    schema: parsed.schema,
    observedStoreEpoch: parsed.observedStoreEpoch,
  });
}

/** Independent oracle: only raw bytes/hash/length/media/schema/locator and lease facts enter verdict. */
export function evaluateArtifactLineageOracle(
  rawClaim: unknown,
  rawObservation: unknown,
  rawFacts: unknown,
): ArtifactLineagePredicateResult {
  let claim: ArtifactLineageClaimV1;
  try {
    claim = decodeOracleClaim(parseOracleInput(rawClaim as ArtifactLineageCodecInput), "$.claim");
  } catch {
    return invalidResult("claim-decode-failed", null, null);
  }
  let observation: ArtifactLineageObservationV1;
  try {
    observation = decodeOracleObservation(parseOracleInput(rawObservation as ArtifactLineageCodecInput), "$.observation");
  } catch {
    return invalidResult("observation-decode-failed", claim.claimId, null);
  }
  let raw: OracleRawFacts;
  try {
    raw = readOracleRawFacts(rawFacts);
  } catch (error) {
    return invalidResult(
      error instanceof TypeError && error.message === "missing" ? "raw-bytes-missing" : "raw-shape-invalid",
      claim.claimId,
      observation.observationId,
    );
  }

  if (claim.resolutionClaim.outcome !== "content-observed" || claim.resolutionClaim.observedMirror === null) {
    return invalidResult("resolution-outcome-mismatch", claim.claimId, observation.observationId);
  }
  if (
    observation.rawBytes === null ||
    observation.contentSha256 === null ||
    observation.byteLength === null ||
    observation.mediaType === null
  ) {
    return invalidResult("raw-observation-mismatch", claim.claimId, observation.observationId);
  }
  const rawLength = hexByteLength(raw.rawBytes);
  const observedLength = hexByteLength(observation.rawBytes);
  if (rawLength === null || observedLength === null) {
    return invalidResult("raw-shape-invalid", claim.claimId, observation.observationId);
  }
  let maxByteLength: bigint;
  try {
    maxByteLength = BigInt(claim.resolverPolicy.maxByteLength);
    assertDecimalString(raw.observedStoreEpoch, "$.rawFacts.observedStoreEpoch");
  } catch {
    return invalidResult("policy-mismatch", claim.claimId, observation.observationId);
  }
  if (
    BigInt(claim.artifactRef.byteLength) > maxByteLength ||
    BigInt(rawLength) > maxByteLength ||
    BigInt(observedLength) > maxByteLength
  ) {
    return invalidResult("policy-mismatch", claim.claimId, observation.observationId);
  }

  let rawBytes: Uint8Array;
  let observedBytes: Uint8Array;
  try {
    rawBytes = decodeHex(raw.rawBytes);
    observedBytes = decodeHex(observation.rawBytes);
  } catch {
    return invalidResult("raw-shape-invalid", claim.claimId, observation.observationId);
  }
  const rawHash = hashBytes(rawBytes);
  const observedHash = hashBytes(observedBytes);
  const claimedMirror = claim.resolutionClaim.observedMirror;
  if (
    raw.rawBytes !== observation.rawBytes ||
    claimedMirror.bytes !== observation.rawBytes ||
    observedHash !== observation.contentSha256 ||
    observedHash !== rawHash ||
    String(observedBytes.byteLength) !== observation.byteLength ||
    String(rawBytes.byteLength) !== observation.byteLength
  ) {
    return invalidResult("raw-observation-mismatch", claim.claimId, observation.observationId);
  }
  if (
    claim.artifactRef.byteLength !== claimedMirror.byteLength ||
    claim.artifactRef.byteLength !== observation.byteLength ||
    claim.artifactRef.byteLength !== String(rawBytes.byteLength)
  ) {
    return invalidResult("artifact-ref-length-mismatch", claim.claimId, observation.observationId);
  }
  if (observation.artifactRefId !== claim.artifactRef.artifactRefId) {
    return invalidResult("raw-observation-mismatch", claim.claimId, observation.observationId);
  }
  if (
    claim.resolverPolicy.allowedLocatorKind !== "content-object" ||
    claim.resolverPolicy.digestAlgorithm !== "sha256" ||
    claim.resolverPolicy.requireExactLengthMediaAndSchema !== true ||
    claim.resolverPolicy.failureOutcome !== "invalid"
  ) {
    return invalidResult("policy-mismatch", claim.claimId, observation.observationId);
  }
  if (
    claimedMirror.storeIdentityHash !== claim.artifactRef.immutableMirrorLocator.storeIdentityHash ||
    claimedMirror.objectKey !== claim.artifactRef.immutableMirrorLocator.objectKey
  ) {
    return invalidResult("object-key-mismatch", claim.claimId, observation.observationId);
  }
  if (claimedMirror.contentSha256 !== observation.contentSha256) {
    return invalidResult("raw-observation-mismatch", claim.claimId, observation.observationId);
  }
  if (
    claimedMirror.mediaType !== claim.artifactRef.mediaType ||
    claimedMirror.mediaType !== observation.mediaType ||
    raw.mediaType !== observation.mediaType ||
    raw.mediaType !== claim.artifactRef.mediaType
  ) {
    return invalidResult("media-mismatch", claim.claimId, observation.observationId);
  }
  if (
    !exactRawRelation(claimedMirror.schema, claim.artifactRef.schema) ||
    !exactRawRelation(claimedMirror.schema, observation.schema) ||
    !exactRawRelation(raw.schema, observation.schema) ||
    !exactRawRelation(raw.schema, claim.artifactRef.schema)
  ) {
    return invalidResult("schema-mismatch", claim.claimId, observation.observationId);
  }
  if (!exactRawRelation(raw.locator, observation.locator) || !exactRawRelation(raw.locator, claim.artifactRef.locator)) {
    return invalidResult("locator-mismatch", claim.claimId, observation.observationId);
  }
  if (
    !exactRawRelation(raw.immutableMirrorLocator, observation.immutableMirrorLocator) ||
    !exactRawRelation(raw.immutableMirrorLocator, claim.artifactRef.immutableMirrorLocator)
  ) {
    return invalidResult("object-key-mismatch", claim.claimId, observation.observationId);
  }
  if (raw.observedStoreEpoch !== observation.observedStoreEpoch || raw.observedStoreEpoch !== claim.observedStoreEpoch) {
    return invalidResult("lease-out-of-range", claim.claimId, observation.observationId);
  }
  const lease = claim.retentionLease;
  const mirror = claim.artifactRef.immutableMirrorLocator;
  if (
    lease.storeIdentityHash !== mirror.storeIdentityHash ||
    lease.objectKey !== mirror.objectKey ||
    lease.contentSha256 !== claim.artifactRef.contentSha256 ||
    claim.artifactRef.retentionLeaseReceiptId !== lease.receiptId
  ) {
    return invalidResult("lease-subject-mismatch", claim.claimId, observation.observationId);
  }
  const epoch = BigInt(raw.observedStoreEpoch);
  if (epoch < BigInt(lease.validFromStoreEpoch) || epoch > BigInt(lease.validThroughStoreEpoch)) {
    return invalidResult("lease-out-of-range", claim.claimId, observation.observationId);
  }
  if (BigInt(lease.validThroughStoreEpoch) - epoch < BigInt(claim.resolverPolicy.minimumRemainingStoreEpochs)) {
    return invalidResult("lease-remaining-too-short", claim.claimId, observation.observationId);
  }
  return rawHash === claim.artifactRef.contentSha256
    ? Object.freeze({ verdict: "pass", reasons: Object.freeze([]), claimId: claim.claimId, observationId: observation.observationId })
    : failResult("subject-content-mismatch", claim.claimId, observation.observationId);
}
