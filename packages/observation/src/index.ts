import { deepFreeze, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
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

export interface RecentObservationReceiptV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly range: BlockRangeV1;
  readonly orderedBlockHashes: readonly Hash[];
  readonly evidence: readonly CandidateEvidenceRefV1[];
  readonly observationRoot: Hash;
}

const decimal = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError("invalid block number");
  return BigInt(value);
};

function assertExactRecord(value: object, expected: readonly string[], name: string): void {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${name} must be a plain record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string")) throw new TypeError(`${name} has symbol fields`);
  const actual = (keys as string[]).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError(`${name} has unknown or missing fields`);
  }
}

export function sealRecentObservation(
  cutoff: CanonicalCutoffV1,
  blocks: readonly ObservedBlockV1[],
): RecentObservationReceiptV1 {
  const range = recentObservationRange(cutoff.number);
  const expectedCount = decimal(range.to) - decimal(range.from) + 1n;
  if (BigInt(blocks.length) !== expectedCount) throw new Error("observation-range-incomplete");
  let previousHash: Hash | null = null;
  const evidence = new Map<Hash, CandidateEvidenceRefV1>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    assertExactRecord(block, ["number", "hash", "parentHash", "evidence"], "observedBlock");
    const expectedNumber = decimal(range.from) + BigInt(index);
    if (decimal(block.number) !== expectedNumber) throw new Error("observation-block-gap");
    if (previousHash !== null && block.parentHash !== previousHash) throw new Error("observation-parent-mismatch");
    previousHash = block.hash;
    for (const item of block.evidence) {
      assertExactRecord(item, ["blockNumber", "blockHash", "txHash", "logIndex", "address", "topic", "rawLocatorHash"], "observedEvidence");
      if (item.blockNumber !== block.number || item.blockHash !== block.hash) {
        throw new Error("observation-evidence-block-mismatch");
      }
      evidence.set(hashDomain("aloha/candidate-evidence-ref/v1", item), deepFreeze({ ...item }));
    }
  }
  if (blocks.at(-1)?.hash !== cutoff.hash) throw new Error("observation-cutoff-hash-mismatch");
  const orderedBlockHashes = blocks.map(block => block.hash);
  const orderedEvidence = [...evidence.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, item]) => item);
  const observationRoot = hashDomain("aloha/recent-observation/v1", {
    cutoff,
    range,
    orderedBlockHashes,
    evidence: orderedEvidence,
  });
  return deepFreeze({ cutoff: deepFreeze({ ...cutoff }), range, orderedBlockHashes, evidence: orderedEvidence, observationRoot });
}
