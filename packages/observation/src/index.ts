import {
  assertNonEmptyString,
  assertDecimalString,
  assertExactKeys,
  assertHash,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  fieldArray,
  hashDomain,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  decodeRecentLogEvidenceRef,
  decodeCanonicalCutoff,
  decodeRawEvidenceLocatorContent,
  recentObservationRange,
  validateRawEvidenceLocatorContents,
  type RawEvidenceLocatorContentV1,
  type RecentLogEvidenceRefV1,
  type BlockRangeV1,
  type CanonicalCutoffV1,
} from "../../discovery/src/index.ts";

export type { RawEvidenceLocatorContentV1 } from "../../discovery/src/index.ts";

export interface ObservedBlockV1 {
  readonly number: string;
  readonly hash: Hash;
  readonly parentHash: Hash;
  readonly evidence: readonly RecentLogEvidenceRefV1[];
}

/**
 * Protocol-neutral bytes persisted for one EVM log.  The chain observer owns
 * only this mechanical normalization; a Family remains the sole interpreter
 * of topics, data and address meaning.
 */
export interface EvmLogObservationV1 {
  readonly kind: "evm-log";
  readonly version: 1;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly transactionHash: Hash;
  readonly logIndex: string;
  readonly address: string;
  readonly topics: readonly Hash[];
  readonly data: string;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const EVM_BYTES = /^0x(?:[0-9a-f]{2})*$/;

export function decodeEvmLogObservation(
  value: unknown,
  name = "evmLogObservation",
): EvmLogObservationV1 {
  return decodeExactObject(value, {
    kind: (field, path) => field === "evm-log" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
    version: (field, path) => field === 1 ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
    blockNumber: (field, path) => assertDecimalString(field, path),
    blockHash: (field, path) => assertHash(field, path),
    transactionHash: (field, path) => assertHash(field, path),
    logIndex: (field, path) => assertDecimalString(field, path),
    address: (field, path) => {
      const address = assertNonEmptyString(field, path);
      if (!EVM_ADDRESS.test(address)) throw new TypeError(`${path} must be a lowercase EVM address`);
      return address;
    },
    topics: (field, path) => fieldArray(field, (item, itemPath) => assertHash(item, itemPath), path),
    data: (field, path) => {
      const data = assertNonEmptyString(field, path);
      if (!EVM_BYTES.test(data)) throw new TypeError(`${path} must be lowercase even-length EVM bytes`);
      return data;
    },
  }, name);
}

export function encodeEvmLogObservation(value: EvmLogObservationV1): Uint8Array {
  return new TextEncoder().encode(encodeCanonicalJson(decodeEvmLogObservation(value)));
}

export function decodeEvmLogObservationBytes(
  value: Uint8Array,
  name = "evmLogObservationBytes",
): EvmLogObservationV1 {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new TypeError(`${name} must be a concrete Uint8Array`);
  }
  return decodeEvmLogObservation(decodeCanonicalJson(value), name);
}

/**
 * Opaque, content-addressed bytes that are sufficient to re-open one raw
 * observation in the qualified chain observer. They are transient until the
 * checkpoint atomically roots them with the run.
 */
/** The durable header facts needed to re-open and verify the observed chain. */
export interface ObservedHeaderV1 {
  readonly number: string;
  readonly hash: Hash;
  readonly parentHash: Hash;
}

export interface RecentObservationScanV1 {
  readonly kind: "recent-observation-scan";
  readonly version: 1;
  readonly blocks: readonly ObservedBlockV1[];
  readonly rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
}

export interface RecentObservationReceiptV1 {
  readonly kind: "recent-observation";
  readonly version: 1;
  readonly cutoff: CanonicalCutoffV1;
  readonly range: BlockRangeV1;
  readonly orderedHeaders: readonly ObservedHeaderV1[];
  readonly evidence: readonly RecentLogEvidenceRefV1[];
  readonly rawLocatorHashes: readonly Hash[];
  readonly observationRoot: Hash;
}

const decimal = (value: string, name: string): bigint => BigInt(assertDecimalString(value, name));

const decodeBlockRange = (value: unknown, name = "observationRange"): BlockRangeV1 => decodeExactObject(value, {
  from: (field, path) => assertDecimalString(field, path),
  to: (field, path) => assertDecimalString(field, path),
}, name);

const decodeObservedBlock = (value: unknown, name = "observedBlock"): ObservedBlockV1 => decodeExactObject(value, {
  number: (field, path) => assertDecimalString(field, path),
  hash: (field, path) => assertHash(field, path),
  parentHash: (field, path) => assertHash(field, path),
  evidence: (field, path) => fieldArray(
    field,
    (item, itemPath) => decodeRecentLogEvidenceRef(item, itemPath),
    path,
  ),
}, name);

const decodeObservedHeader = (
  value: unknown,
  name = "observedHeader",
): ObservedHeaderV1 => decodeExactObject(value, {
  number: (field, path) => assertDecimalString(field, path),
  hash: (field, path) => assertHash(field, path),
  parentHash: (field, path) => assertHash(field, path),
}, name);

const decodeRecentObservationReceipt = (
  value: unknown,
  name = "recentObservationReceipt",
): RecentObservationReceiptV1 => decodeExactObject(value, {
  kind: (field, path) => field === "recent-observation" ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
  version: (field, path) => field === 1 ? field : (() => { throw new TypeError(`${path} is invalid`); })(),
  cutoff: (field, path) => decodeCanonicalCutoff(field, path),
  range: (field, path) => decodeBlockRange(field, path),
  orderedHeaders: (field, path) => fieldArray(field, (item, itemPath) => decodeObservedHeader(item, itemPath), path),
  evidence: (field, path) => fieldArray(field, (item, itemPath) => decodeRecentLogEvidenceRef(item, itemPath), path),
  rawLocatorHashes: (field, path) => fieldArray(field, (item, itemPath) => assertHash(item, itemPath), path),
  observationRoot: (field, path) => assertHash(field, path),
}, name);

export function decodeRecentObservationScan(
  value: unknown,
  name = "recentObservationScan",
): RecentObservationScanV1 {
  assertExactKeys(value, ["kind", "version", "blocks", "rawEvidenceLocators"], name);
  const kind = readOwnEnumerableDataProperty(value, "kind", name);
  const version = readOwnEnumerableDataProperty(value, "version", name);
  if (kind !== "recent-observation-scan" || version !== 1) throw new TypeError(`${name} kind/version is invalid`);
  const rawBlocks = readOwnEnumerableDataProperty(value, "blocks", name);
  const rawLocators = readOwnEnumerableDataProperty(value, "rawEvidenceLocators", name);
  const blocks = fieldArray(rawBlocks, (item, itemPath) => decodeObservedBlock(item, itemPath), `${name}.blocks`);
  if (!Array.isArray(rawLocators)) throw new TypeError(`${name}.rawEvidenceLocators must be an array`);
  const rawEvidenceLocators = Object.freeze(rawLocators.map((item, index) => decodeRawEvidenceLocatorContent(item, `${name}.rawEvidenceLocators[${index}]`)));
  return Object.freeze({ kind: "recent-observation-scan", version: 1 as const, blocks, rawEvidenceLocators });
}

export function sealRecentObservation(
  cutoff: CanonicalCutoffV1,
  range: BlockRangeV1,
  blocks: readonly ObservedBlockV1[],
  rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[],
): RecentObservationReceiptV1 {
  const decodedCutoff = decodeCanonicalCutoff(cutoff, "observationCutoff");
  const decodedRange = decodeBlockRange(range, "observationRange");
  const decodedBlocks = fieldArray(blocks, (value, path) => decodeObservedBlock(value, path), "observedBlocks");
  const policyRange = recentObservationRange(decodedCutoff.number);
  if (
    decimal(decodedRange.to, "observationRange.to") !== decimal(decodedCutoff.number, "observationCutoff.number")
    || decodedRange.from !== policyRange.from
    || decodedRange.to !== policyRange.to
  ) throw new Error("observation-range-must-be-exact-50-blocks");
  const expectedCount = decimal(decodedRange.to, "observationRange.to") - decimal(decodedRange.from, "observationRange.from") + 1n;
  if (BigInt(decodedBlocks.length) !== expectedCount) throw new Error("observation-range-incomplete");
  let previousHash: Hash | null = null;
  const evidence = new Map<Hash, RecentLogEvidenceRefV1>();
  for (let index = 0; index < decodedBlocks.length; index += 1) {
    const block = decodedBlocks[index]!;
    const expectedNumber = decimal(decodedRange.from, "observationRange.from") + BigInt(index);
    if (decimal(block.number, "observedBlock.number") !== expectedNumber) throw new Error("observation-block-gap");
    if (previousHash !== null && block.parentHash !== previousHash) throw new Error("observation-parent-mismatch");
    previousHash = block.hash;
    for (const item of block.evidence) {
      if (item.blockNumber !== block.number || item.blockHash !== block.hash) {
        throw new Error("observation-evidence-block-mismatch");
      }
      evidence.set(hashDomain("aloha/candidate-evidence-ref/v1", item), deepFreeze({ ...item }));
    }
  }
  if (decodedBlocks.at(-1)?.hash !== decodedCutoff.hash) throw new Error("observation-cutoff-hash-mismatch");
  const orderedHeaders = decodedBlocks.map(block => deepFreeze({
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
  }));
  const orderedEvidence = [...evidence.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, item]) => item);
  const rawLocators = validateRawEvidenceLocatorContents(
    rawEvidenceLocators,
    [...new Set(orderedEvidence.map(item => item.rawLocatorHash))]
      .sort((left, right) => left.localeCompare(right)),
    "recentRawEvidenceLocators",
  );
  const rawLocatorHashes = rawLocators.map(item => item.rawLocatorHash);
  const observationRoot = hashDomain("aloha/recent-observation/v1", {
    kind: "recent-observation",
    version: 1,
    cutoff: decodedCutoff,
    range: decodedRange,
    orderedHeaders,
    evidence: orderedEvidence,
    rawLocatorHashes,
  });
  return deepFreeze({ kind: "recent-observation", version: 1, cutoff: decodedCutoff, range: decodedRange, orderedHeaders, evidence: orderedEvidence, rawLocatorHashes, observationRoot });
}

export function validateRecentObservationReceipt(
  receipt: RecentObservationReceiptV1,
  expectedRange: BlockRangeV1,
): void {
  const decodedReceipt = decodeRecentObservationReceipt(receipt);
  const decodedExpectedRange = decodeBlockRange(expectedRange, "expectedObservationRange");
  const policyRange = recentObservationRange(decodedReceipt.cutoff.number);
  if (decodedReceipt.range.from !== policyRange.from || decodedReceipt.range.to !== policyRange.to) {
    throw new Error("observation-range-must-be-exact-50-blocks");
  }
  if (decodedReceipt.range.from !== decodedExpectedRange.from || decodedReceipt.range.to !== decodedExpectedRange.to) {
    throw new Error("observation-range-mismatch");
  }
  const expectedCount = decimal(decodedReceipt.range.to, "recentObservationReceipt.range.to") - decimal(decodedReceipt.range.from, "recentObservationReceipt.range.from") + 1n;
  if (BigInt(decodedReceipt.orderedHeaders.length) !== expectedCount) {
    throw new Error("observation-hash-partition-incomplete");
  }
  if (decodedReceipt.cutoff.number !== decodedReceipt.range.to) {
    throw new Error("observation-cutoff-number-mismatch");
  }
  for (let index = 0; index < decodedReceipt.orderedHeaders.length; index += 1) {
    const header = decodedReceipt.orderedHeaders[index]!;
    const expectedNumber = decimal(decodedReceipt.range.from, "recentObservationReceipt.range.from") + BigInt(index);
    if (decimal(header.number, "recentObservationHeader.number") !== expectedNumber) {
      throw new Error("observation-header-number-gap");
    }
    const previous = decodedReceipt.orderedHeaders[index - 1];
    if (previous && header.parentHash !== previous.hash) {
      throw new Error("observation-header-parent-mismatch");
    }
  }
  if (decodedReceipt.orderedHeaders.at(-1)?.hash !== decodedReceipt.cutoff.hash) {
    throw new Error("observation-cutoff-hash-mismatch");
  }
  const evidenceKeys: Hash[] = [];
  for (const item of decodedReceipt.evidence) {
    const offset = decimal(item.blockNumber, "observedEvidence.blockNumber") - decimal(decodedReceipt.range.from, "recentObservationReceipt.range.from");
    if (offset < 0n || offset >= BigInt(decodedReceipt.orderedHeaders.length)) {
      throw new Error("observation-evidence-outside-range");
    }
    if (decodedReceipt.orderedHeaders[Number(offset)]?.hash !== item.blockHash) {
      throw new Error("observation-evidence-block-mismatch");
    }
    evidenceKeys.push(hashDomain("aloha/candidate-evidence-ref/v1", item));
  }
  const sortedEvidenceKeys = [...evidenceKeys].sort();
  if (
    new Set(evidenceKeys).size !== evidenceKeys.length
    || evidenceKeys.some((key, index) => key !== sortedEvidenceKeys[index])
  ) throw new Error("observation-evidence-order-mismatch");
  const expectedRawLocatorHashes = [...new Set(decodedReceipt.evidence.map(item => item.rawLocatorHash))].sort();
  const actualRawLocatorHashes = [...decodedReceipt.rawLocatorHashes].sort();
  if (
    new Set(decodedReceipt.rawLocatorHashes).size !== decodedReceipt.rawLocatorHashes.length
    || decodedReceipt.rawLocatorHashes.some((hash, index) => hash !== actualRawLocatorHashes[index])
    || actualRawLocatorHashes.length !== expectedRawLocatorHashes.length
    || actualRawLocatorHashes.some((hash, index) => hash !== expectedRawLocatorHashes[index])
  ) throw new Error("observation-raw-locator-binding-mismatch");
  const recomputed = hashDomain("aloha/recent-observation/v1", {
    kind: decodedReceipt.kind,
    version: decodedReceipt.version,
    cutoff: decodedReceipt.cutoff,
    range: decodedReceipt.range,
    orderedHeaders: decodedReceipt.orderedHeaders,
    evidence: decodedReceipt.evidence,
    rawLocatorHashes: decodedReceipt.rawLocatorHashes,
  });
  if (recomputed !== decodedReceipt.observationRoot) throw new Error("observation-root-mismatch");
}
