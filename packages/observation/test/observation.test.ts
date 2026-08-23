import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { recentObservationRange } from "../../discovery/src/index.ts";
import { sealRecentObservation, validateRecentObservationReceipt, type ObservedBlockV1 } from "../src/index.ts";

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
  const receipt = sealRecentObservation(cutoff, recentObservationRange(cutoff.number), blocks);
  assert.deepEqual(receipt.range, { from: "0", to: "49" });
  assert.equal(receipt.orderedHeaders.length, 50);
  assert.deepEqual(receipt.orderedHeaders[10], blocks[10] && {
    number: blocks[10].number,
    hash: blocks[10].hash,
    parentHash: blocks[10].parentHash,
  });
  validateRecentObservationReceipt(receipt, receipt.range);
});

test("persisted ordered headers revalidate parent links even when an attacker recomputes the root", () => {
  const blocks = [...chain(50)];
  const cutoff = { chainId: "1", number: "49", hash: blocks[49]!.hash, stateRoot: h("state") };
  const receipt = sealRecentObservation(cutoff, recentObservationRange(cutoff.number), blocks);
  const forgedHeaders = receipt.orderedHeaders.map((header, index) => index === 10
    ? { ...header, parentHash: h("wrong-parent") }
    : header);
  const forgedRoot = hashDomain("aloha/recent-observation/v1", {
    cutoff: receipt.cutoff,
    range: receipt.range,
    orderedHeaders: forgedHeaders,
    evidence: receipt.evidence,
  });
  assert.throws(
    () => validateRecentObservationReceipt(
      { ...receipt, orderedHeaders: forgedHeaders, observationRoot: forgedRoot },
      receipt.range,
    ),
    /header-parent-mismatch/,
  );
});

test("a gap, parent mismatch, or wrong cutoff is rejected", () => {
  const blocks = [...chain(50)];
  const cutoff = { chainId: "1", number: "49", hash: blocks[49]!.hash, stateRoot: h("state") };
  blocks[10] = { ...blocks[10]!, number: "11" };
  assert.throws(() => sealRecentObservation(cutoff, recentObservationRange(cutoff.number), blocks), /block-gap/);

  const parentBroken = [...chain(50)];
  parentBroken[10] = { ...parentBroken[10]!, parentHash: h("wrong") };
  assert.throws(() => sealRecentObservation(cutoff, recentObservationRange(cutoff.number), parentBroken), /parent-mismatch/);
});

test("observation freeze rejects fields that the central contract does not declare", () => {
  const blocks = [...chain(50)];
  const cutoff = { chainId: "1", number: "49", hash: blocks[49]!.hash, stateRoot: h("state") };
  blocks[0] = { ...blocks[0]!, assertedComplete: true } as unknown as ObservedBlockV1;
  assert.throws(() => sealRecentObservation(cutoff, recentObservationRange(cutoff.number), blocks), /unknown field/);
});

test("observation decoder reads only data descriptors and rejects proxies/non-arrays", () => {
  const blocks = [...chain(50)];
  const cutoff = { chainId: "1", number: "49", hash: blocks[49]!.hash, stateRoot: h("state") };
  let getterCalled = false;
  const accessorBlock = { ...blocks[0]! } as Record<string, unknown>;
  Object.defineProperty(accessorBlock, "hash", {
    enumerable: true,
    configurable: true,
    get: () => {
      getterCalled = true;
      throw new Error("accessor was invoked");
    },
  });
  blocks[0] = accessorBlock as unknown as ObservedBlockV1;
  assert.throws(
    () => sealRecentObservation(cutoff, recentObservationRange(cutoff.number), blocks),
    /accessor/,
  );
  assert.equal(getterCalled, false);
  assert.throws(
    () => sealRecentObservation(cutoff, recentObservationRange(cutoff.number), new Proxy(blocks, { get: () => { throw new Error("proxy trap"); } })),
    /Proxy/,
  );
  assert.throws(
    () => sealRecentObservation(cutoff, recentObservationRange(cutoff.number), { 0: blocks[0] } as unknown as readonly ObservedBlockV1[]),
    /array/,
  );
});
