import {
  assertDecimalString,
  assertHash,
  decodeExactObject,
  deepFreeze,
  fieldArray,
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  decodeCandidateEvidenceRef,
  decodeCanonicalCutoff,
  recentObservationRange,
  type BlockRangeV1,
  type CandidateEvidenceRefV1,
  type CanonicalCutoffV1,
} from "../../discovery/src/index.ts";

export interface ObservedBlockV1 {
  readonly number: string;
  readonly hash: Hash;
  readonly parentHash: Hash;
  readonly evidence: readonly CandidateEvidenceRefV1[];
}

/**
 * Opaque, content-addressed bytes that are sufficient to re-open one raw
 * observation in the qualified chain observer. They are transient until the
 * checkpoint atomically roots them with the run.
 */
export interface RawEvidenceLocatorContentV1 {
  readonly rawLocatorHash: Hash;
  readonly bytes: Uint8Array;
}

/** The durable header facts needed to re-open and verify the observed chain. */
export interface ObservedHeaderV1 {
  readonly number: string;
  readonly hash: Hash;
  readonly parentHash: Hash;
}

export interface RecentObservationScanV1 {
  readonly blocks: readonly ObservedBlockV1[];
  readonly rawEvidenceLocators: readonly RawEvidenceLocatorContentV1[];
}

export interface RecentObservationReceiptV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly range: BlockRangeV1;
  readonly orderedHeaders: readonly ObservedHeaderV1[];
  readonly evidence: readonly CandidateEvidenceRefV1[];
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
    (item, itemPath) => decodeCandidateEvidenceRef(item, itemPath),
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
  cutoff: (field, path) => decodeCanonicalCutoff(field, path),
  range: (field, path) => decodeBlockRange(field, path),
  orderedHeaders: (field, path) => fieldArray(field, (item, itemPath) => decodeObservedHeader(item, itemPath), path),
  evidence: (field, path) => fieldArray(field, (item, itemPath) => decodeCandidateEvidenceRef(item, itemPath), path),
  observationRoot: (field, path) => assertHash(field, path),
}, name);

export function sealRecentObservation(
  cutoff: CanonicalCutoffV1,
  range: BlockRangeV1,
  blocks: readonly ObservedBlockV1[],
): RecentObservationReceiptV1 {
  const decodedCutoff = decodeCanonicalCutoff(cutoff, "observationCutoff");
  const decodedRange = decodeBlockRange(range, "observationRange");
  const decodedBlocks = fieldArray(blocks, (value, path) => decodeObservedBlock(value, path), "observedBlocks");
  const policyRange = recentObservationRange(decodedCutoff.number);
  if (
    decimal(decodedRange.to, "observationRange.to") !== decimal(decodedCutoff.number, "observationCutoff.number")
    || decimal(decodedRange.from, "observationRange.from") < decimal(policyRange.from, "policyRange.from")
    || decimal(decodedRange.from, "observationRange.from") > decimal(decodedRange.to, "observationRange.to")
  ) throw new Error("observation-range-outside-policy");
  const expectedCount = decimal(decodedRange.to, "observationRange.to") - decimal(decodedRange.from, "observationRange.from") + 1n;
  if (BigInt(decodedBlocks.length) !== expectedCount) throw new Error("observation-range-incomplete");
  let previousHash: Hash | null = null;
  const evidence = new Map<Hash, CandidateEvidenceRefV1>();
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
  const observationRoot = hashDomain("aloha/recent-observation/v1", {
    cutoff: decodedCutoff,
    range: decodedRange,
    orderedHeaders,
    evidence: orderedEvidence,
  });
  return deepFreeze({ cutoff: decodedCutoff, range: decodedRange, orderedHeaders, evidence: orderedEvidence, observationRoot });
}

export function validateRecentObservationReceipt(
  receipt: RecentObservationReceiptV1,
  expectedRange: BlockRangeV1,
): void {
  const decodedReceipt = decodeRecentObservationReceipt(receipt);
  const decodedExpectedRange = decodeBlockRange(expectedRange, "expectedObservationRange");
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
  const recomputed = hashDomain("aloha/recent-observation/v1", {
    cutoff: decodedReceipt.cutoff,
    range: decodedReceipt.range,
    orderedHeaders: decodedReceipt.orderedHeaders,
    evidence: decodedReceipt.evidence,
  });
  if (recomputed !== decodedReceipt.observationRoot) throw new Error("observation-root-mismatch");
}
