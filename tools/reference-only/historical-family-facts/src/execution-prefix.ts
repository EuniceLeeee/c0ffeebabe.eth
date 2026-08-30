import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertExactKeys,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  loadHistoricalFamilyFactBundleV1,
  type HistoricalFamilyFactManifestV1,
} from "./index.ts";
import { writeImmutableFile } from "./immutable-file.ts";

export const HISTORICAL_EXECUTION_PREFIX_MANIFEST_KIND =
  "aloha.historical-execution-prefix-manifest" as const;

const RAW_ROOT_DOMAIN = "aloha/historical-execution-prefix-raw-closure/v1";
const RECEIPT_ROOT_DOMAIN = "aloha/historical-execution-prefix-receipt-closure/v1";
const PREFIX_ROOT_DOMAIN = "aloha/historical-execution-prefix/v1";
const MANIFEST_ROOT_DOMAIN = "aloha/historical-execution-prefix-manifest/v1";
const ACQUISITION_OBSERVATION_ROOT_DOMAIN =
  "aloha/historical-execution-prefix-acquisition-observations/v1";
const HISTORICAL_EXECUTION_PREFIX_TRANSCRIPT_KIND =
  "aloha.historical-execution-prefix-acquisition-transcript" as const;

export type HistoricalExecutionPrefixOriginV1 =
  | "caller-materialized"
  | "rpc-port-observed";

export type HistoricalExecutionPrefixAcquisitionTrustV1 =
  | "untrusted-caller-material"
  | "untrusted-request-port";

export interface HistoricalExecutionPrefixAcquisitionTranscriptRefV1 {
  readonly objectHash: Hash;
  readonly byteLength: string;
  readonly observationRoot: Hash;
}

export interface HistoricalExecutionPrefixAcquisitionObservationV1 {
  readonly sequence: string;
  readonly fence: "before" | "prefix" | "after";
  readonly method: string;
  readonly paramsCanonicalBytes: string;
  readonly responseCanonicalBytes: string;
}

export interface HistoricalExecutionPrefixAcquisitionTranscriptV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HISTORICAL_EXECUTION_PREFIX_TRANSCRIPT_KIND;
  readonly acquisitionTrust: "untrusted-request-port";
  readonly observations: readonly HistoricalExecutionPrefixAcquisitionObservationV1[];
}

export interface HistoricalBlockIdentityV1 {
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface HistoricalTargetExecutionContextV1 extends HistoricalBlockIdentityV1 {
  readonly parentHash: Hash;
  readonly transactionsRoot: Hash;
  readonly receiptsRoot: Hash;
  readonly timestamp: string;
  readonly gasLimit: string;
  readonly gasUsed: string;
  readonly baseFeePerGas: string | null;
  readonly miner: string | null;
  readonly beneficiary: string | null;
  readonly mixHash: Hash | null;
  readonly prevRandao: Hash | null;
  readonly difficulty: string | null;
  readonly totalDifficulty: string | null;
  readonly blobGasUsed: string | null;
  readonly excessBlobGas: string | null;
  readonly withdrawalsRoot: Hash | null;
  readonly parentBeaconBlockRoot: Hash | null;
  readonly requestsHash: Hash | null;
  readonly targetIndex: string;
  readonly targetTxHash: Hash;
  /** Exact target header bytes are owned by the joined family-fact manifest. */
  readonly headerObjectHash: Hash;
  readonly headerByteLength: string;
}

export interface HistoricalExecutionPrefixInputEntryV1 {
  readonly index: string;
  readonly txHash: Hash;
  /** Exact signed transaction bytes, not JSON. */
  readonly rawSignedTransaction: Uint8Array;
  /** Exact canonical JSON bytes for eth_getTransactionReceipt result. */
  readonly receiptBytes: Uint8Array;
}

export interface HistoricalExecutionPrefixEntryV1 {
  readonly index: string;
  readonly txHash: Hash;
  readonly rawObjectHash: Hash;
  readonly rawByteLength: string;
  readonly receiptObjectHash: Hash;
  readonly receiptByteLength: string;
}

export interface HistoricalExecutionPrefixManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HISTORICAL_EXECUTION_PREFIX_MANIFEST_KIND;
  readonly advisoryOnly: true;
  readonly chainStateQualified: false;
  readonly origin: HistoricalExecutionPrefixOriginV1;
  readonly acquisitionTrust: HistoricalExecutionPrefixAcquisitionTrustV1;
  /** parent.hash is linked by target.parentHash; the parent header hash is not recomputed. */
  readonly parentStateRootProof: "hash-link-only";
  /** Receipt identity is checked, but no receipt-trie inclusion proof is acquired. */
  readonly receiptProof: "identity-only-no-trie-proof";
  /** Immutable injected-port transcript; null for public caller materialization. */
  readonly acquisitionTranscript: HistoricalExecutionPrefixAcquisitionTranscriptRefV1 | null;
  readonly historicalFamilyFactManifestRoot: Hash;
  readonly chainId: string;
  readonly parent: HistoricalBlockIdentityV1;
  /** target.stateRoot is the target block result, never the execution prestate. */
  readonly target: HistoricalTargetExecutionContextV1;
  readonly prefix: readonly HistoricalExecutionPrefixEntryV1[];
  readonly rawClosureRoot: Hash;
  readonly receiptRoot: Hash;
  readonly prefixRoot: Hash;
  readonly manifestRoot: Hash;
}

export interface HistoricalExecutionPrefixMaterializationV1 {
  readonly historicalFamilyFactManifestRoot: Hash;
  readonly parentHeader: unknown;
  readonly prefix: readonly HistoricalExecutionPrefixInputEntryV1[];
}

export interface HistoricalExecutionPrefixBundleV1 {
  readonly manifest: HistoricalExecutionPrefixManifestV1;
  readonly rawSignedTransactions: readonly Uint8Array[];
  readonly receipts: readonly CanonicalJson[];
  readonly acquisitionTranscript: HistoricalExecutionPrefixAcquisitionTranscriptV1 | null;
}

export interface HistoricalExecutionPrefixJsonRpcV1 {
  request(method: string, params: readonly CanonicalJson[]): Promise<unknown>;
}

export interface HistoricalExecutionPrefixAcquisitionRequestV1 {
  readonly rootDirectory: string;
  readonly historicalFamilyFactManifestRoot: Hash;
}

export type HistoricalExecutionPrefixUnavailableReasonV1 =
  | "method-not-found"
  | "null-result"
  | "pruned"
  | "transport";

export class HistoricalExecutionPrefixUnavailableErrorV1 extends Error {
  readonly reason: HistoricalExecutionPrefixUnavailableReasonV1;
  readonly method: string;

  constructor(reason: HistoricalExecutionPrefixUnavailableReasonV1, method: string, detail: string) {
    super(`historical execution prefix unavailable (${reason}) for ${method}: ${detail}`);
    this.name = "HistoricalExecutionPrefixUnavailableErrorV1";
    this.reason = reason;
    this.method = method;
  }
}

interface ExecutionPrefixProvenanceV1 {
  readonly origin: HistoricalExecutionPrefixOriginV1;
  readonly acquisitionTrust: HistoricalExecutionPrefixAcquisitionTrustV1;
  readonly acquisitionTranscript: HistoricalExecutionPrefixAcquisitionTranscriptRefV1 | null;
  readonly acquisitionTranscriptBytes: Uint8Array | null;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`expected plain object at ${path}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`expected non-empty string at ${path}`);
  return value;
}

function decimal(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) fail(`expected unsigned decimal string at ${path}`);
  return result;
}

function hash(value: unknown, path: string): Hash {
  const result = text(value, path).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) fail(`expected 32-byte hash at ${path}`);
  return result as Hash;
}

function nullableHash(value: unknown, path: string): Hash | null {
  return value === null || value === undefined ? null : hash(value, path);
}

function address(value: unknown, path: string): string {
  const result = text(value, path).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result)) fail(`expected address at ${path}`);
  return result;
}

function nullableAddress(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : address(value, path);
}

function quantity(value: unknown, path: string): bigint {
  const result = text(value, path).toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(result)) fail(`expected canonical hex quantity at ${path}`);
  return BigInt(result);
}

function quantityDecimal(value: unknown, path: string): string {
  return quantity(value, path).toString();
}

function nullableQuantityDecimal(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : quantityDecimal(value, path);
}

function bytes(value: unknown, path: string): Uint8Array {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    fail(`expected native Uint8Array at ${path}`);
  }
  return value;
}

function decodeExactCanonicalBytes(value: Uint8Array, path: string): CanonicalJson {
  const decoded = decodeCanonicalBytes(value);
  if (!Buffer.from(encodeCanonicalBytes(decoded)).equals(Buffer.from(value))) {
    fail(`canonical JSON bytes changed during exact decode at ${path}`);
  }
  return decoded;
}

function safeIndex(value: string, path: string): number {
  const parsed = BigInt(decimal(value, path));
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail(`index exceeds safe range at ${path}`);
  return Number(parsed);
}

function decodeHexBytes(value: unknown, path: string): Uint8Array {
  const raw = text(value, path).toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})+$/.test(raw)) fail(`expected non-empty even-length hex bytes at ${path}`);
  return Uint8Array.from(Buffer.from(raw.slice(2), "hex"));
}

function canonicalBytesHex(value: CanonicalJson): string {
  return `0x${Buffer.from(encodeCanonicalBytes(value)).toString("hex")}`;
}

function decodeCanonicalBytesHex(value: unknown, path: string): CanonicalJson {
  const raw = text(value, path).toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})+$/.test(raw)) fail(`expected non-empty even-length canonical bytes at ${path}`);
  return decodeExactCanonicalBytes(Uint8Array.from(Buffer.from(raw.slice(2), "hex")), path);
}

function field(object: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

function headerIdentity(raw: unknown, path: string): HistoricalBlockIdentityV1 {
  const header = plainObject(raw, path);
  return Object.freeze({
    number: quantityDecimal(header.number, `${path}.number`),
    hash: hash(header.hash, `${path}.hash`),
    stateRoot: hash(header.stateRoot, `${path}.stateRoot`),
  });
}

function targetContext(
  raw: unknown,
  targetIndex: number,
  targetTxHash: Hash,
  headerObjectHash: Hash,
  headerByteLength: string,
): HistoricalTargetExecutionContextV1 {
  const path = "$.targetHeader";
  const header = plainObject(raw, path);
  const identity = headerIdentity(header, path);
  const miner = nullableAddress(field(header, "miner"), `${path}.miner`);
  const beneficiary = nullableAddress(field(header, "beneficiary"), `${path}.beneficiary`);
  if (miner === null && beneficiary === null) fail("target header has neither miner nor beneficiary");
  if (miner !== null && beneficiary !== null && miner !== beneficiary) fail("target header miner and beneficiary disagree");
  const mixHash = nullableHash(field(header, "mixHash"), `${path}.mixHash`);
  const prevRandao = nullableHash(field(header, "prevRandao"), `${path}.prevRandao`);
  if (mixHash !== null && prevRandao !== null && mixHash !== prevRandao) fail("target header mixHash and prevRandao disagree");
  return Object.freeze({
    ...identity,
    parentHash: hash(header.parentHash, `${path}.parentHash`),
    transactionsRoot: hash(header.transactionsRoot, `${path}.transactionsRoot`),
    receiptsRoot: hash(header.receiptsRoot, `${path}.receiptsRoot`),
    timestamp: quantityDecimal(header.timestamp, `${path}.timestamp`),
    gasLimit: quantityDecimal(header.gasLimit, `${path}.gasLimit`),
    gasUsed: quantityDecimal(header.gasUsed, `${path}.gasUsed`),
    baseFeePerGas: nullableQuantityDecimal(field(header, "baseFeePerGas"), `${path}.baseFeePerGas`),
    miner,
    beneficiary,
    mixHash,
    prevRandao,
    difficulty: nullableQuantityDecimal(field(header, "difficulty"), `${path}.difficulty`),
    totalDifficulty: nullableQuantityDecimal(field(header, "totalDifficulty"), `${path}.totalDifficulty`),
    blobGasUsed: nullableQuantityDecimal(field(header, "blobGasUsed"), `${path}.blobGasUsed`),
    excessBlobGas: nullableQuantityDecimal(field(header, "excessBlobGas"), `${path}.excessBlobGas`),
    withdrawalsRoot: nullableHash(field(header, "withdrawalsRoot"), `${path}.withdrawalsRoot`),
    parentBeaconBlockRoot: nullableHash(field(header, "parentBeaconBlockRoot"), `${path}.parentBeaconBlockRoot`),
    requestsHash: nullableHash(field(header, "requestsHash"), `${path}.requestsHash`),
    targetIndex: String(targetIndex),
    targetTxHash,
    headerObjectHash,
    headerByteLength,
  });
}

function transactionHashes(rawHeader: unknown, path: string): readonly Hash[] {
  const header = plainObject(rawHeader, path);
  if (!Array.isArray(header.transactions)) fail(`expected transaction hash array at ${path}.transactions`);
  return Object.freeze(header.transactions.map((value, index) => hash(value, `${path}.transactions[${index}]`)));
}

function targetIndexForManifest(
  family: HistoricalFamilyFactManifestV1,
  results: Readonly<Record<string, CanonicalJson>>,
): number {
  const header = results.header;
  const identity = headerIdentity(header, "$.existing.header");
  if (identity.hash !== family.canonicalBlockHash) fail("existing manifest target block hash splice");
  const hashes = transactionHashes(header, "$.existing.header");
  const indexes = hashes.flatMap((candidate, index) => candidate === family.txHash ? [index] : []);
  if (indexes.length !== 1) fail("existing manifest target transaction membership is not exact");
  const targetIndex = indexes[0]!;
  const transaction = plainObject(results.transaction, "$.existing.transaction");
  if (
    hash(transaction.hash, "$.existing.transaction.hash") !== family.txHash ||
    hash(transaction.blockHash, "$.existing.transaction.blockHash") !== family.canonicalBlockHash ||
    quantityDecimal(transaction.blockNumber, "$.existing.transaction.blockNumber") !== identity.number ||
    quantity(transaction.transactionIndex, "$.existing.transaction.transactionIndex") !== BigInt(targetIndex)
  ) fail("existing manifest transaction identity splice");
  const receipt = plainObject(results.receipt, "$.existing.receipt");
  assertReceiptIdentity(receipt, family.txHash, family.canonicalBlockHash, identity.number, targetIndex, "$.existing.receipt");
  return targetIndex;
}

function assertReceiptIdentity(
  raw: unknown,
  txHash: Hash,
  blockHash: Hash,
  blockNumber: string,
  index: number,
  path: string,
): void {
  const receipt = plainObject(raw, path);
  if (hash(receipt.transactionHash, `${path}.transactionHash`) !== txHash) fail(`receipt transaction hash splice at ${path}`);
  if (hash(receipt.blockHash, `${path}.blockHash`) !== blockHash) fail(`receipt block hash splice at ${path}`);
  if (quantityDecimal(receipt.blockNumber, `${path}.blockNumber`) !== blockNumber) fail(`receipt block number splice at ${path}`);
  if (quantity(receipt.transactionIndex, `${path}.transactionIndex`) !== BigInt(index)) fail(`receipt transaction index splice at ${path}`);
}

function rawRoot(prefix: readonly HistoricalExecutionPrefixEntryV1[]): Hash {
  return hashDomain(RAW_ROOT_DOMAIN, {
    entries: prefix.map(({ index, txHash, rawObjectHash, rawByteLength }) => ({
      index, txHash, rawObjectHash, rawByteLength,
    })),
  });
}

function receiptsRoot(prefix: readonly HistoricalExecutionPrefixEntryV1[]): Hash {
  return hashDomain(RECEIPT_ROOT_DOMAIN, {
    entries: prefix.map(({ index, txHash, receiptObjectHash, receiptByteLength }) => ({
      index, txHash, receiptObjectHash, receiptByteLength,
    })),
  });
}

function prefixEntriesRoot(prefix: readonly HistoricalExecutionPrefixEntryV1[]): Hash {
  return hashDomain(PREFIX_ROOT_DOMAIN, { entries: prefix });
}

function executionManifestRoot(manifest: Omit<HistoricalExecutionPrefixManifestV1, "manifestRoot">): Hash {
  return hashDomain(MANIFEST_ROOT_DOMAIN, manifest);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`content-addressed store path is not a real directory: ${path}`);
}

function prefixDirectories(rootDirectory: string): Readonly<{ root: string; objects: string; manifests: string }> {
  const root = join(resolve(rootDirectory), "execution-prefix");
  return Object.freeze({ root, objects: join(root, "objects"), manifests: join(root, "manifests") });
}

function buildManifest(
  family: HistoricalFamilyFactManifestV1,
  results: Readonly<Record<string, CanonicalJson>>,
  input: HistoricalExecutionPrefixMaterializationV1,
  provenance: ExecutionPrefixProvenanceV1,
): HistoricalExecutionPrefixManifestV1 {
  const targetIndex = targetIndexForManifest(family, results);
  if (!Array.isArray(input.prefix) || input.prefix.length !== targetIndex) {
    fail("execution prefix must contain exactly indexes 0..targetIndex-1");
  }
  const targetHeader = results.header;
  const targetHashes = transactionHashes(targetHeader, "$.existing.header");
  const parent = headerIdentity(input.parentHeader, "$.parentHeader");
  const headerEntry = family.entries.find((entry) => entry.role === "header")!;
  const target = targetContext(
    targetHeader,
    targetIndex,
    family.txHash,
    headerEntry.resultBytesSha256,
    headerEntry.byteLength,
  );
  if (BigInt(parent.number) + 1n !== BigInt(target.number)) fail("parent and target block numbers are not consecutive");
  if (target.parentHash !== parent.hash) fail("target parentHash does not bind parent header");
  const seen = new Set<Hash>();
  const prefix = input.prefix.map((rawEntry, index): HistoricalExecutionPrefixEntryV1 => {
    const entry = plainObject(rawEntry, `$.prefix[${index}]`);
    assertExactKeys(entry, ["index", "txHash", "rawSignedTransaction", "receiptBytes"], `$.prefix[${index}]`);
    if (decimal(entry.index, `$.prefix[${index}].index`) !== String(index)) {
      fail("execution prefix indexes are missing or reordered");
    }
    const txHash = hash(entry.txHash, `$.prefix[${index}].txHash`);
    if (seen.has(txHash)) fail("execution prefix contains duplicate transaction hash");
    seen.add(txHash);
    if (targetHashes[index] !== txHash) fail("execution prefix transaction membership is reordered or spliced");
    const rawSignedTransaction = bytes(entry.rawSignedTransaction, `$.prefix[${index}].rawSignedTransaction`);
    if (rawSignedTransaction.length === 0) fail("raw signed transaction bytes are empty");
    if (keccak256RawTransactionV1(rawSignedTransaction) !== txHash) fail("raw signed transaction hash mismatch");
    const receiptBytes = bytes(entry.receiptBytes, `$.prefix[${index}].receiptBytes`);
    const receipt = decodeExactCanonicalBytes(receiptBytes, `$.prefix[${index}].receiptBytes`);
    assertReceiptIdentity(receipt, txHash, target.hash, target.number, index, `$.prefix[${index}].receipt`);
    return Object.freeze({
      index: String(index),
      txHash,
      rawObjectHash: sha256Hex(rawSignedTransaction),
      rawByteLength: String(rawSignedTransaction.length),
      receiptObjectHash: sha256Hex(receiptBytes),
      receiptByteLength: String(receiptBytes.length),
    });
  });
  const rawClosureRoot = rawRoot(prefix);
  const receiptRoot = receiptsRoot(prefix);
  const prefixRoot = prefixEntriesRoot(prefix);
  const base = {
    schemaVersion: 1 as const,
    kind: HISTORICAL_EXECUTION_PREFIX_MANIFEST_KIND,
    advisoryOnly: true as const,
    chainStateQualified: false as const,
    origin: provenance.origin,
    acquisitionTrust: provenance.acquisitionTrust,
    parentStateRootProof: "hash-link-only" as const,
    receiptProof: "identity-only-no-trie-proof" as const,
    acquisitionTranscript: provenance.acquisitionTranscript,
    historicalFamilyFactManifestRoot: family.manifestRoot,
    chainId: family.chainId,
    parent,
    target,
    prefix: Object.freeze(prefix),
    rawClosureRoot,
    receiptRoot,
    prefixRoot,
  };
  return Object.freeze({ ...base, manifestRoot: executionManifestRoot(base) });
}

export function materializeHistoricalExecutionPrefixV1(
  rootDirectory: string,
  input: HistoricalExecutionPrefixMaterializationV1,
): HistoricalExecutionPrefixManifestV1 {
  const request = plainObject(input, "$.input");
  assertExactKeys(request, ["historicalFamilyFactManifestRoot", "parentHeader", "prefix"], "$.input");
  return materializeHistoricalExecutionPrefixWithProvenanceV1(rootDirectory, input, {
    origin: "caller-materialized",
    acquisitionTrust: "untrusted-caller-material",
    acquisitionTranscript: null,
    acquisitionTranscriptBytes: null,
  });
}

function materializeHistoricalExecutionPrefixWithProvenanceV1(
  rootDirectory: string,
  input: HistoricalExecutionPrefixMaterializationV1,
  provenance: ExecutionPrefixProvenanceV1,
): HistoricalExecutionPrefixManifestV1 {
  const callerMaterialized = provenance.origin === "caller-materialized";
  if (
    callerMaterialized
      ? provenance.acquisitionTrust !== "untrusted-caller-material" ||
        provenance.acquisitionTranscript !== null || provenance.acquisitionTranscriptBytes !== null
      : provenance.acquisitionTrust !== "untrusted-request-port" ||
        provenance.acquisitionTranscript === null || provenance.acquisitionTranscriptBytes === null
  ) fail("execution prefix origin, trust, and acquisition transcript disagree");
  const expectedRoot = hash(input.historicalFamilyFactManifestRoot, "$.input.historicalFamilyFactManifestRoot");
  const existing = loadHistoricalFamilyFactBundleV1(rootDirectory, expectedRoot);
  const manifest = buildManifest(existing.manifest, existing.results, input, provenance);
  const directories = prefixDirectories(rootDirectory);
  ensurePrivateDirectory(directories.root);
  ensurePrivateDirectory(directories.objects);
  ensurePrivateDirectory(directories.manifests);
  for (let index = 0; index < manifest.prefix.length; index += 1) {
    const source = input.prefix[index]!;
    const entry = manifest.prefix[index]!;
    writeImmutableFile(
      join(directories.objects, entry.rawObjectHash.slice(2)),
      source.rawSignedTransaction,
      "immutable execution-prefix object changed",
    );
    writeImmutableFile(
      join(directories.objects, entry.receiptObjectHash.slice(2)),
      source.receiptBytes,
      "immutable execution-prefix object changed",
    );
  }
  if (provenance.acquisitionTranscript !== null && provenance.acquisitionTranscriptBytes !== null) {
    writeImmutableFile(
      join(directories.objects, provenance.acquisitionTranscript.objectHash.slice(2)),
      provenance.acquisitionTranscriptBytes,
      "immutable execution-prefix acquisition transcript changed",
    );
  }
  writeImmutableFile(
    join(directories.manifests, `${manifest.manifestRoot.slice(2)}.json`),
    encodeCanonicalBytes(manifest),
    "immutable execution-prefix manifest changed",
  );
  return loadHistoricalExecutionPrefixV1(rootDirectory, manifest.manifestRoot).manifest;
}

function decodeBlockIdentity(value: unknown, path: string): HistoricalBlockIdentityV1 {
  const object = plainObject(value, path);
  assertExactKeys(object, ["number", "hash", "stateRoot"], path);
  return Object.freeze({
    number: decimal(object.number, `${path}.number`),
    hash: hash(object.hash, `${path}.hash`),
    stateRoot: hash(object.stateRoot, `${path}.stateRoot`),
  });
}

function decodeNullableDecimal(value: unknown, path: string): string | null {
  return value === null ? null : decimal(value, path);
}

function decodeNullableAddress(value: unknown, path: string): string | null {
  return value === null ? null : address(value, path);
}

function decodeNullableHash(value: unknown, path: string): Hash | null {
  return value === null ? null : hash(value, path);
}

function decodeTarget(value: unknown, path: string): HistoricalTargetExecutionContextV1 {
  const object = plainObject(value, path);
  assertExactKeys(object, [
    "number", "hash", "stateRoot", "parentHash", "transactionsRoot", "receiptsRoot",
    "timestamp", "gasLimit", "gasUsed", "baseFeePerGas", "miner", "beneficiary",
    "mixHash", "prevRandao", "difficulty", "totalDifficulty", "blobGasUsed", "excessBlobGas",
    "withdrawalsRoot", "parentBeaconBlockRoot", "requestsHash", "targetIndex", "targetTxHash",
    "headerObjectHash", "headerByteLength",
  ], path);
  const identity = decodeBlockIdentity(
    { number: object.number, hash: object.hash, stateRoot: object.stateRoot },
    `${path}.identity`,
  );
  const miner = decodeNullableAddress(object.miner, `${path}.miner`);
  const beneficiary = decodeNullableAddress(object.beneficiary, `${path}.beneficiary`);
  if (miner === null && beneficiary === null) fail("target has neither miner nor beneficiary");
  if (miner !== null && beneficiary !== null && miner !== beneficiary) fail("target miner and beneficiary disagree");
  const mixHash = decodeNullableHash(object.mixHash, `${path}.mixHash`);
  const prevRandao = decodeNullableHash(object.prevRandao, `${path}.prevRandao`);
  if (mixHash !== null && prevRandao !== null && mixHash !== prevRandao) fail("target mixHash and prevRandao disagree");
  return Object.freeze({
    ...identity,
    parentHash: hash(object.parentHash, `${path}.parentHash`),
    transactionsRoot: hash(object.transactionsRoot, `${path}.transactionsRoot`),
    receiptsRoot: hash(object.receiptsRoot, `${path}.receiptsRoot`),
    timestamp: decimal(object.timestamp, `${path}.timestamp`),
    gasLimit: decimal(object.gasLimit, `${path}.gasLimit`),
    gasUsed: decimal(object.gasUsed, `${path}.gasUsed`),
    baseFeePerGas: decodeNullableDecimal(object.baseFeePerGas, `${path}.baseFeePerGas`),
    miner,
    beneficiary,
    mixHash,
    prevRandao,
    difficulty: decodeNullableDecimal(object.difficulty, `${path}.difficulty`),
    totalDifficulty: decodeNullableDecimal(object.totalDifficulty, `${path}.totalDifficulty`),
    blobGasUsed: decodeNullableDecimal(object.blobGasUsed, `${path}.blobGasUsed`),
    excessBlobGas: decodeNullableDecimal(object.excessBlobGas, `${path}.excessBlobGas`),
    withdrawalsRoot: decodeNullableHash(object.withdrawalsRoot, `${path}.withdrawalsRoot`),
    parentBeaconBlockRoot: decodeNullableHash(object.parentBeaconBlockRoot, `${path}.parentBeaconBlockRoot`),
    requestsHash: decodeNullableHash(object.requestsHash, `${path}.requestsHash`),
    targetIndex: decimal(object.targetIndex, `${path}.targetIndex`),
    targetTxHash: hash(object.targetTxHash, `${path}.targetTxHash`),
    headerObjectHash: hash(object.headerObjectHash, `${path}.headerObjectHash`),
    headerByteLength: decimal(object.headerByteLength, `${path}.headerByteLength`),
  });
}

function decodePrefixEntry(value: unknown, index: number): HistoricalExecutionPrefixEntryV1 {
  const path = `$.prefix[${index}]`;
  const object = plainObject(value, path);
  assertExactKeys(object, [
    "index", "txHash", "rawObjectHash", "rawByteLength", "receiptObjectHash", "receiptByteLength",
  ], path);
  const decoded = Object.freeze({
    index: decimal(object.index, `${path}.index`),
    txHash: hash(object.txHash, `${path}.txHash`),
    rawObjectHash: hash(object.rawObjectHash, `${path}.rawObjectHash`),
    rawByteLength: decimal(object.rawByteLength, `${path}.rawByteLength`),
    receiptObjectHash: hash(object.receiptObjectHash, `${path}.receiptObjectHash`),
    receiptByteLength: decimal(object.receiptByteLength, `${path}.receiptByteLength`),
  });
  if (decoded.index !== String(index)) fail("manifest prefix indexes are not exact and ordered");
  return decoded;
}

function decodeAcquisitionTranscriptRef(
  value: unknown,
  path: string,
): HistoricalExecutionPrefixAcquisitionTranscriptRefV1 | null {
  if (value === null) return null;
  const object = plainObject(value, path);
  assertExactKeys(object, ["objectHash", "byteLength", "observationRoot"], path);
  return Object.freeze({
    objectHash: hash(object.objectHash, `${path}.objectHash`),
    byteLength: decimal(object.byteLength, `${path}.byteLength`),
    observationRoot: hash(object.observationRoot, `${path}.observationRoot`),
  });
}

export function decodeHistoricalExecutionPrefixAcquisitionTranscriptV1(
  value: unknown,
): HistoricalExecutionPrefixAcquisitionTranscriptV1 {
  const object = plainObject(value, "$.acquisitionTranscript");
  assertExactKeys(
    object,
    ["schemaVersion", "kind", "acquisitionTrust", "observations"],
    "$.acquisitionTranscript",
  );
  if (
    object.schemaVersion !== 1 ||
    object.kind !== HISTORICAL_EXECUTION_PREFIX_TRANSCRIPT_KIND ||
    object.acquisitionTrust !== "untrusted-request-port"
  ) fail("invalid execution prefix acquisition transcript discriminator");
  if (!Array.isArray(object.observations)) fail("expected acquisition transcript observations array");
  const observations = Object.freeze(object.observations.map((value, index) => {
    const path = `$.acquisitionTranscript.observations[${index}]`;
    const observation = plainObject(value, path);
    assertExactKeys(
      observation,
      ["sequence", "fence", "method", "paramsCanonicalBytes", "responseCanonicalBytes"],
      path,
    );
    if (decimal(observation.sequence, `${path}.sequence`) !== String(index)) {
      fail("acquisition transcript observations are missing or reordered");
    }
    if (observation.fence !== "before" && observation.fence !== "prefix" && observation.fence !== "after") {
      fail(`invalid acquisition transcript fence at ${path}`);
    }
    const method = text(observation.method, `${path}.method`);
    const paramsCanonicalBytes = text(observation.paramsCanonicalBytes, `${path}.paramsCanonicalBytes`).toLowerCase();
    const responseCanonicalBytes = text(observation.responseCanonicalBytes, `${path}.responseCanonicalBytes`).toLowerCase();
    const params = decodeCanonicalBytesHex(paramsCanonicalBytes, `${path}.paramsCanonicalBytes`);
    decodeCanonicalBytesHex(responseCanonicalBytes, `${path}.responseCanonicalBytes`);
    if (!Array.isArray(params)) fail(`acquisition transcript params are not an array at ${path}`);
    return Object.freeze({
      sequence: String(index),
      fence: observation.fence,
      method,
      paramsCanonicalBytes,
      responseCanonicalBytes,
    });
  }));
  return Object.freeze({
    schemaVersion: 1,
    kind: HISTORICAL_EXECUTION_PREFIX_TRANSCRIPT_KIND,
    acquisitionTrust: "untrusted-request-port",
    observations,
  });
}

export function decodeHistoricalExecutionPrefixManifestV1(value: unknown): HistoricalExecutionPrefixManifestV1 {
  const object = plainObject(value, "$");
  assertExactKeys(object, [
    "schemaVersion", "kind", "advisoryOnly", "chainStateQualified", "origin", "acquisitionTrust",
    "parentStateRootProof", "receiptProof", "acquisitionTranscript", "historicalFamilyFactManifestRoot", "chainId",
    "parent", "target", "prefix", "rawClosureRoot", "receiptRoot", "prefixRoot", "manifestRoot",
  ], "$");
  if (
    object.schemaVersion !== 1 ||
    object.kind !== HISTORICAL_EXECUTION_PREFIX_MANIFEST_KIND ||
    object.advisoryOnly !== true ||
    object.chainStateQualified !== false
  ) fail("invalid historical execution prefix manifest discriminator");
  if (object.origin !== "caller-materialized" && object.origin !== "rpc-port-observed") {
    fail("invalid historical execution prefix origin");
  }
  const origin: HistoricalExecutionPrefixOriginV1 = object.origin;
  if (object.acquisitionTrust !== "untrusted-caller-material" && object.acquisitionTrust !== "untrusted-request-port") {
    fail("invalid historical execution prefix acquisition trust");
  }
  const acquisitionTrust: HistoricalExecutionPrefixAcquisitionTrustV1 = object.acquisitionTrust;
  if (object.parentStateRootProof !== "hash-link-only") fail("invalid parent stateRoot proof level");
  if (object.receiptProof !== "identity-only-no-trie-proof") fail("invalid receipt proof level");
  const acquisitionTranscript = decodeAcquisitionTranscriptRef(
    object.acquisitionTranscript,
    "$.acquisitionTranscript",
  );
  if (
    origin === "caller-materialized"
      ? acquisitionTrust !== "untrusted-caller-material" || acquisitionTranscript !== null
      : acquisitionTrust !== "untrusted-request-port" || acquisitionTranscript === null
  ) fail("execution prefix origin, trust, and acquisition transcript disagree");
  const historicalFamilyFactManifestRoot = hash(
    object.historicalFamilyFactManifestRoot,
    "$.historicalFamilyFactManifestRoot",
  );
  const chainId = decimal(object.chainId, "$.chainId");
  if (chainId === "0") fail("chainId must be positive");
  const parent = decodeBlockIdentity(object.parent, "$.parent");
  const target = decodeTarget(object.target, "$.target");
  if (BigInt(parent.number) + 1n !== BigInt(target.number)) fail("parent and target block numbers are not consecutive");
  if (target.parentHash !== parent.hash) fail("target parentHash does not bind parent header");
  if (!Array.isArray(object.prefix)) fail("expected array at $.prefix");
  const targetIndex = safeIndex(target.targetIndex, "$.target.targetIndex");
  if (object.prefix.length !== targetIndex) fail("manifest prefix length does not match targetIndex");
  const prefix = Object.freeze(object.prefix.map(decodePrefixEntry));
  if (new Set(prefix.map((entry) => entry.txHash)).size !== prefix.length) fail("manifest prefix contains duplicate transaction hash");
  const rawClosureRoot = hash(object.rawClosureRoot, "$.rawClosureRoot");
  const receiptRoot = hash(object.receiptRoot, "$.receiptRoot");
  const prefixRoot = hash(object.prefixRoot, "$.prefixRoot");
  if (rawClosureRoot !== rawRoot(prefix)) fail("raw closure root mismatch");
  if (receiptRoot !== receiptsRoot(prefix)) fail("receipt root mismatch");
  if (prefixRoot !== prefixEntriesRoot(prefix)) fail("prefix root mismatch");
  const base = {
    schemaVersion: 1 as const,
    kind: HISTORICAL_EXECUTION_PREFIX_MANIFEST_KIND,
    advisoryOnly: true as const,
    chainStateQualified: false as const,
    origin,
    acquisitionTrust,
    parentStateRootProof: "hash-link-only" as const,
    receiptProof: "identity-only-no-trie-proof" as const,
    acquisitionTranscript,
    historicalFamilyFactManifestRoot,
    chainId,
    parent,
    target,
    prefix,
    rawClosureRoot,
    receiptRoot,
    prefixRoot,
  };
  const manifestRoot = hash(object.manifestRoot, "$.manifestRoot");
  if (manifestRoot !== executionManifestRoot(base)) fail("execution prefix manifest root mismatch");
  return Object.freeze({ ...base, manifestRoot });
}

function readRegularFile(path: string, missingMessage: string, irregularMessage: string): Buffer {
  if (!existsSync(path)) fail(missingMessage);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(irregularMessage);
  return readFileSync(path);
}

export function loadHistoricalExecutionPrefixV1(
  rootDirectory: string,
  expectedManifestRoot: Hash,
): HistoricalExecutionPrefixBundleV1 {
  const root = hash(expectedManifestRoot, "$.expectedManifestRoot");
  const directories = prefixDirectories(rootDirectory);
  const manifestBytes = readRegularFile(
    join(directories.manifests, `${root.slice(2)}.json`),
    "historical execution prefix manifest missing",
    "historical execution prefix manifest is not a regular file",
  );
  const manifest = decodeHistoricalExecutionPrefixManifestV1(
    decodeExactCanonicalBytes(Uint8Array.from(manifestBytes), "$.manifestBytes"),
  );
  if (manifest.manifestRoot !== root) fail("loaded execution prefix manifest root mismatch");
  let acquisitionTranscript: HistoricalExecutionPrefixAcquisitionTranscriptV1 | null = null;
  if (manifest.acquisitionTranscript !== null) {
    const transcriptRef = manifest.acquisitionTranscript;
    const transcriptBytes = readRegularFile(
      join(directories.objects, transcriptRef.objectHash.slice(2)),
      "execution prefix acquisition transcript missing",
      "execution prefix acquisition transcript is not a regular file",
    );
    if (
      String(transcriptBytes.length) !== transcriptRef.byteLength ||
      sha256Hex(transcriptBytes) !== transcriptRef.objectHash
    ) fail("execution prefix acquisition transcript changed");
    acquisitionTranscript = decodeHistoricalExecutionPrefixAcquisitionTranscriptV1(
      decodeExactCanonicalBytes(Uint8Array.from(transcriptBytes), "$.acquisitionTranscriptBytes"),
    );
    if (acquisitionTranscript.acquisitionTrust !== manifest.acquisitionTrust) {
      fail("execution prefix acquisition transcript trust splice");
    }
    if (acquisitionObservationRoot(acquisitionTranscript.observations) !== transcriptRef.observationRoot) {
      fail("execution prefix acquisition observation root mismatch");
    }
  }
  const existing = loadHistoricalFamilyFactBundleV1(rootDirectory, manifest.historicalFamilyFactManifestRoot);
  if (existing.manifest.chainId !== manifest.chainId) fail("execution prefix chainId splice");
  const targetIndex = targetIndexForManifest(existing.manifest, existing.results);
  const headerEntry = existing.manifest.entries.find((entry) => entry.role === "header")!;
  const expectedTarget = targetContext(
    existing.results.header,
    targetIndex,
    existing.manifest.txHash,
    headerEntry.resultBytesSha256,
    headerEntry.byteLength,
  );
  if (!Buffer.from(encodeCanonicalBytes(expectedTarget)).equals(Buffer.from(encodeCanonicalBytes(manifest.target)))) {
    fail("execution prefix target context splice");
  }
  const targetHashes = transactionHashes(existing.results.header, "$.existing.header");
  const rawSignedTransactions: Uint8Array[] = [];
  const receipts: CanonicalJson[] = [];
  for (let index = 0; index < manifest.prefix.length; index += 1) {
    const entry = manifest.prefix[index]!;
    if (targetHashes[index] !== entry.txHash) fail("execution prefix target membership splice");
    const raw = readRegularFile(
      join(directories.objects, entry.rawObjectHash.slice(2)),
      `execution prefix raw object missing at index ${index}`,
      `execution prefix raw object is not a regular file at index ${index}`,
    );
    if (
      String(raw.length) !== entry.rawByteLength ||
      sha256Hex(raw) !== entry.rawObjectHash ||
      keccak256RawTransactionV1(Uint8Array.from(raw)) !== entry.txHash
    ) fail(`execution prefix raw object changed at index ${index}`);
    const receiptBytes = readRegularFile(
      join(directories.objects, entry.receiptObjectHash.slice(2)),
      `execution prefix receipt object missing at index ${index}`,
      `execution prefix receipt object is not a regular file at index ${index}`,
    );
    if (String(receiptBytes.length) !== entry.receiptByteLength || sha256Hex(receiptBytes) !== entry.receiptObjectHash) {
      fail(`execution prefix receipt object changed at index ${index}`);
    }
    const receipt = decodeExactCanonicalBytes(Uint8Array.from(receiptBytes), `$.receiptBytes[${index}]`);
    assertReceiptIdentity(receipt, entry.txHash, manifest.target.hash, manifest.target.number, index, `$.receipt[${index}]`);
    rawSignedTransactions.push(Uint8Array.from(raw));
    receipts.push(receipt);
  }
  return Object.freeze({
    manifest,
    rawSignedTransactions: Object.freeze(rawSignedTransactions),
    receipts: Object.freeze(receipts),
    acquisitionTranscript,
  });
}

function unavailableReason(error: unknown): HistoricalExecutionPrefixUnavailableReasonV1 | null {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.shift();
    const object = candidate !== null && typeof candidate === "object"
      ? candidate as Record<string, unknown>
      : null;
    if (object !== null) {
      if (seen.has(object)) continue;
      seen.add(object);
      if (Object.prototype.hasOwnProperty.call(object, "cause")) pending.push(object.cause);
      if (Object.prototype.hasOwnProperty.call(object, "error")) pending.push(object.error);
    }
    const code = object?.code;
    const message = candidate instanceof Error
      ? candidate.message
      : typeof candidate === "string"
        ? candidate
        : typeof object?.message === "string"
          ? object.message
          : "";
    if (
      code === -32601 || code === "-32601" ||
      /method(?:\s+is)? not found|unsupported method|method(?:\s+is)? not supported|not supported.*method/i.test(message)
    ) return "method-not-found";
    if (/pruned|missing trie node|historical state unavailable/i.test(message)) return "pruned";
    if (
      typeof code === "string" && /^(?:E(?:CONN|HOST|NET|PIPE|TIMEDOUT)|UND_ERR_)/.test(code) ||
      /socket|network|connection|fetch failed|timed? out/i.test(message)
    ) return "transport";
  }
  return null;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function resolvedJsonRpcError(value: unknown): unknown | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (object.jsonrpc !== "2.0" || !Object.prototype.hasOwnProperty.call(object, "error")) return null;
  return object.error ?? null;
}

async function rpcRequest(
  rpc: HistoricalExecutionPrefixJsonRpcV1,
  method: string,
  params: readonly CanonicalJson[],
): Promise<unknown> {
  try {
    const result = await rpc.request(method, params);
    const resolvedError = resolvedJsonRpcError(result);
    if (resolvedError !== null) throw resolvedError;
    return result;
  } catch (error) {
    if (error instanceof HistoricalExecutionPrefixUnavailableErrorV1) throw error;
    const reason = unavailableReason(error);
    if (reason === null) throw error;
    throw new HistoricalExecutionPrefixUnavailableErrorV1(
      reason,
      method,
      errorDetail(error),
    );
  }
}

function nonNullRpcResult(value: unknown, method: string): unknown {
  if (value === null) throw new HistoricalExecutionPrefixUnavailableErrorV1("null-result", method, "provider returned null");
  return value;
}

function exactCanonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

async function observedRpcRequest(
  rpc: HistoricalExecutionPrefixJsonRpcV1,
  observations: HistoricalExecutionPrefixAcquisitionObservationV1[],
  fence: HistoricalExecutionPrefixAcquisitionObservationV1["fence"],
  method: string,
  params: readonly CanonicalJson[],
): Promise<unknown> {
  const response = await rpcRequest(rpc, method, params);
  observations.push(Object.freeze({
    sequence: String(observations.length),
    fence,
    method,
    paramsCanonicalBytes: canonicalBytesHex(params),
    responseCanonicalBytes: canonicalBytesHex(response as CanonicalJson),
  }));
  return response;
}

function acquisitionObservationRoot(
  observations: readonly HistoricalExecutionPrefixAcquisitionObservationV1[],
): Hash {
  return hashDomain(ACQUISITION_OBSERVATION_ROOT_DOMAIN, {
    acquisitionTrust: "untrusted-request-port",
    observations,
  });
}

function buildAcquisitionTranscript(
  observations: readonly HistoricalExecutionPrefixAcquisitionObservationV1[],
): Readonly<{
  bytes: Uint8Array;
  ref: HistoricalExecutionPrefixAcquisitionTranscriptRefV1;
}> {
  const transcript: HistoricalExecutionPrefixAcquisitionTranscriptV1 = Object.freeze({
    schemaVersion: 1,
    kind: HISTORICAL_EXECUTION_PREFIX_TRANSCRIPT_KIND,
    acquisitionTrust: "untrusted-request-port",
    observations: Object.freeze([...observations]),
  });
  const transcriptBytes = encodeCanonicalBytes(transcript);
  return Object.freeze({
    bytes: transcriptBytes,
    ref: Object.freeze({
      objectHash: sha256Hex(transcriptBytes),
      byteLength: String(transcriptBytes.length),
      observationRoot: acquisitionObservationRoot(transcript.observations),
    }),
  });
}

export async function acquireHistoricalExecutionPrefixV1(
  rpc: HistoricalExecutionPrefixJsonRpcV1,
  request: HistoricalExecutionPrefixAcquisitionRequestV1,
): Promise<HistoricalExecutionPrefixManifestV1> {
  const acquisitionRequest = plainObject(request, "$.request");
  assertExactKeys(
    acquisitionRequest,
    ["rootDirectory", "historicalFamilyFactManifestRoot"],
    "$.request",
  );
  const rootDirectory = text(acquisitionRequest.rootDirectory, "$.request.rootDirectory");
  const existing = loadHistoricalFamilyFactBundleV1(
    rootDirectory,
    hash(acquisitionRequest.historicalFamilyFactManifestRoot, "$.request.historicalFamilyFactManifestRoot"),
  );
  const observations: HistoricalExecutionPrefixAcquisitionObservationV1[] = [];
  const chainId = quantityDecimal(
    await observedRpcRequest(rpc, observations, "before", "eth_chainId", []),
    "$.chainId.before",
  );
  if (chainId !== existing.manifest.chainId) fail("provider chainId does not match historical manifest");
  const storedTarget = existing.results.header;
  const targetIdentity = headerIdentity(storedTarget, "$.storedTarget");
  const fetchedTarget = nonNullRpcResult(
    await observedRpcRequest(rpc, observations, "before", "eth_getBlockByHash", [targetIdentity.hash, false]),
    "eth_getBlockByHash",
  );
  if (!exactCanonicalEqual(storedTarget, fetchedTarget)) fail("target header changed or was spliced during acquisition");
  const targetObject = plainObject(fetchedTarget, "$.targetHeader");
  const parentHash = hash(targetObject.parentHash, "$.targetHeader.parentHash");
  const parentHeader = nonNullRpcResult(
    await observedRpcRequest(rpc, observations, "before", "eth_getBlockByHash", [parentHash, false]),
    "eth_getBlockByHash",
  );
  const targetIndex = targetIndexForManifest(existing.manifest, existing.results);
  const hashes = transactionHashes(fetchedTarget, "$.targetHeader");
  const prefix: HistoricalExecutionPrefixInputEntryV1[] = [];
  for (let index = 0; index < targetIndex; index += 1) {
    const txHash = hashes[index]!;
    const rawResult = nonNullRpcResult(
      await observedRpcRequest(rpc, observations, "prefix", "eth_getRawTransactionByHash", [txHash]),
      "eth_getRawTransactionByHash",
    );
    const receipt = nonNullRpcResult(
      await observedRpcRequest(rpc, observations, "prefix", "eth_getTransactionReceipt", [txHash]),
      "eth_getTransactionReceipt",
    );
    prefix.push(Object.freeze({
      index: String(index),
      txHash,
      rawSignedTransaction: decodeHexBytes(rawResult, `$.rawTransactions[${index}]`),
      receiptBytes: encodeCanonicalBytes(receipt),
    }));
  }
  const targetAfter = nonNullRpcResult(
    await observedRpcRequest(rpc, observations, "after", "eth_getBlockByHash", [targetIdentity.hash, false]),
    "eth_getBlockByHash",
  );
  if (!exactCanonicalEqual(fetchedTarget, targetAfter)) fail("target header changed during acquisition");
  const parentAfter = nonNullRpcResult(
    await observedRpcRequest(rpc, observations, "after", "eth_getBlockByHash", [parentHash, false]),
    "eth_getBlockByHash",
  );
  if (!exactCanonicalEqual(parentHeader, parentAfter)) fail("parent header changed during acquisition");
  const chainIdAfter = quantityDecimal(
    await observedRpcRequest(rpc, observations, "after", "eth_chainId", []),
    "$.chainId.after",
  );
  if (chainIdAfter !== chainId) fail("provider chainId changed during acquisition");
  const acquisitionTranscript = buildAcquisitionTranscript(observations);
  return materializeHistoricalExecutionPrefixWithProvenanceV1(rootDirectory, {
    historicalFamilyFactManifestRoot: existing.manifest.manifestRoot,
    parentHeader,
    prefix,
  }, {
    origin: "rpc-port-observed",
    acquisitionTrust: "untrusted-request-port",
    acquisitionTranscript: acquisitionTranscript.ref,
    acquisitionTranscriptBytes: acquisitionTranscript.bytes,
  });
}

/** Keccak-256 (Ethereum variant) over exact signed transaction bytes. */
export function keccak256RawTransactionV1(input: Uint8Array): Hash {
  bytes(input, "$.rawSignedTransaction");
  const state = new BigInt64Array(25);
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let byte = 0; byte < 8; byte += 1) {
        value |= BigInt(padded[offset + lane * 8 + byte]!) << BigInt(byte * 8);
      }
      state[lane] = BigInt.asIntN(64, state[lane]! ^ BigInt.asIntN(64, value));
    }
    keccakF(state);
  }
  const output = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    output[index] = Number((state[Math.floor(index / 8)]! >> BigInt((index % 8) * 8)) & 0xffn);
  }
  return `0x${Array.from(output, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hash;
}

function keccakF(state: BigInt64Array): void {
  const rotation = [
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
  ];
  const roundConstants = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const mask = (1n << 64n) - 1n;
  const rotl = (value: bigint, amount: number): bigint => {
    const normalized = BigInt.asUintN(64, value);
    return BigInt.asIntN(64, ((normalized << BigInt(amount)) | (normalized >> BigInt(64 - amount))) & mask);
  };
  for (const roundConstant of roundConstants) {
    const c = new BigInt64Array(5);
    const d = new BigInt64Array(5);
    for (let x = 0; x < 5; x += 1) {
      c[x] = BigInt.asIntN(64, state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!);
    }
    for (let x = 0; x < 5; x += 1) d[x] = BigInt.asIntN(64, c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1));
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] = BigInt.asIntN(64, state[x + 5 * y]! ^ d[x]!);
    }
    const b = new BigInt64Array(25);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y]!, rotation[x + 5 * y]!);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = BigInt.asIntN(
          64,
          b[x + 5 * y]! ^ ((~b[(x + 1) % 5 + 5 * y]!) & b[(x + 2) % 5 + 5 * y]!),
        );
      }
    }
    state[0] = BigInt.asIntN(64, state[0]! ^ roundConstant);
  }
}
