import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { sealRecentObservation, type ObservedBlockV1 } from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/observation", value);

function chain(length: number): readonly ObservedBlockV1[] {
  const blocks: ObservedBlockV1[] = [];
  let parent = h("parent");
  for (let number = 0; number < length; number += 1) {
    const hash = h(`block:${number}`);
    blocks.push({ number: String(number), hash, parentHash: parent, evidence: [] });
    parent = hash;
  }
  return blocks;
}

test("receipt proves the exact contiguous 50-block observation", () => {
  const blocks = chain(50);
  const cutoff = { chainId: "1", number: "49", hash: blocks[49]!.hash, stateRoot: h("state") };
  const receipt = sealRecentObservation(cutoff, blocks);
  assert.deepEqual(receipt.range, { from: "0", to: "49" });
  assert.equal(receipt.orderedBlockHashes.length, 50);
});

test("a gap, parent mismatch, or wrong cutoff is rejected", () => {
  const blocks = [...chain(50)];
  const cutoff = { chainId: "1", number: "49", hash: blocks[49]!.hash, stateRoot: h("state") };
  blocks[10] = { ...blocks[10]!, number: "11" };
  assert.throws(() => sealRecentObservation(cutoff, blocks), /block-gap/);

  const parentBroken = [...chain(50)];
  parentBroken[10] = { ...parentBroken[10]!, parentHash: h("wrong") };
  assert.throws(() => sealRecentObservation(cutoff, parentBroken), /parent-mismatch/);
});

test("observation freeze rejects fields that the central contract does not declare", () => {
  const blocks = [...chain(50)];
  const cutoff = { chainId: "1", number: "49", hash: blocks[49]!.hash, stateRoot: h("state") };
  blocks[0] = { ...blocks[0]!, assertedComplete: true } as unknown as ObservedBlockV1;
  assert.throws(() => sealRecentObservation(cutoff, blocks), /unknown or missing fields/);
});
