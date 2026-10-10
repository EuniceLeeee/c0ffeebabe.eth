import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { assertOriginalReceipt, assertSourceCoverage, SAMPLE, selectTargetEdges } from "./historical-ready.js";

// Captured public receipt fields test the observer, not protocol execution.
const receipt = {
  transactionHash: SAMPLE.tx, blockHash: SAMPLE.hash,
  blockNumber: ethers.toQuantity(SAMPLE.block), status: "0x1",
  logs: [{ address: SAMPLE.token, topics: ["0x9a1b418bc061a5d80270261562e6986a35d995f8051145f277be16103abd3453"],
    data: "0x0000000000000000000000000000000000000000000000000003c0c2ce38253b",
    transactionHash: SAMPLE.tx, blockHash: SAMPLE.hash, blockNumber: ethers.toQuantity(SAMPLE.block), removed: false }],
};

test("real EtherToken Destruction has one uint256 and no account topic", () => {
  assertOriginalReceipt(receipt);
  assert.equal(ethers.id("Destruction(uint256)"), receipt.logs[0]!.topics[0]);
  assert.notEqual(ethers.id("Destruction(address,uint256)"), receipt.logs[0]!.topics[0]);
});

test("production graph uses canonicalEdgeId, not a nonexistent familyId field", () => {
  type Edge = Parameters<typeof selectTargetEdges>[0][number];
  const fixtureId = (value: string) => value as NonNullable<Edge["canonicalEdgeId"]>;
  const edge: Edge = {
    instanceKey: SAMPLE.token, tokenIn: SAMPLE.token, adapterId: "ethertoken-native-redeem",
    target: SAMPLE.token, tokenOut: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", slotKind: "protocol",
    edgeKind: "protocol", score: 0, leavesStandingPosition: false,
    canonicalEdgeId: fixtureId("protocol:ethertoken-native-redeem\u001f" + SAMPLE.token + "\u001froute") };
  const graph = [edge, { ...edge, canonicalEdgeId: fixtureId("another-family\u001froute") },
    { ...edge, instanceKey: ethers.ZeroAddress }, { ...edge, tokenIn: ethers.ZeroAddress },
    { ...edge, canonicalEdgeId: undefined, familyId: "protocol:ethertoken-native-redeem" }];
  assert.deepEqual(selectTargetEdges(graph), [edge]);
});

test("reused admission alone cannot prove the declared multi-Family scan coverage", () => {
  const coverage = ["protocol:ethertoken-native-redeem", "protocol:astra-multitoken", "univ2-standard"]
    .map(familyId => ({ familyId, sourceId: "startup-universe", completeThroughBlock: SAMPLE.block,
      completeThroughHash: SAMPLE.hash }));
  const required = coverage.map(row => row.familyId + "|" + row.sourceId);
  assertSourceCoverage(coverage, required);
  assert.throws(() => assertSourceCoverage(coverage.slice(0, 1), required), /scan scope/);
  assert.throws(() => assertSourceCoverage([...coverage, coverage[0]!], required));
  assert.throws(() => assertSourceCoverage(coverage, [...required, "another-family|event:new"]));
  for (const change of [{ completeThroughBlock: SAMPLE.block - 1 }, { completeThroughHash: ethers.ZeroHash },
    { completeThroughHash: null }, { observationScope: { selection: "fixture-subset" } }])
    assert.throws(() => assertSourceCoverage(coverage.map((row, i) => i ? row : { ...row, ...change }), required));
});

test("receipt binding rejects another transaction, state, token, amount or removed log", () => {
  for (const field of ["transactionHash", "blockHash"] as const)
    assert.throws(() => assertOriginalReceipt({ ...receipt, [field]: ethers.ZeroHash }));
  assert.throws(() => assertOriginalReceipt({ ...receipt, status: "0x0" }));
  assert.throws(() => assertOriginalReceipt({ ...receipt, blockNumber: ethers.toQuantity(SAMPLE.block - 1) }));
  for (const change of [{ address: ethers.ZeroAddress }, { data: ethers.toBeHex(SAMPLE.amount + 1n, 32) },
    { topics: [ethers.id("Destruction(address,uint256)"), ethers.ZeroHash] }, { removed: true },
    { blockHash: ethers.ZeroHash }, { transactionHash: ethers.ZeroHash }, { blockNumber: "0x1" }])
    assert.throws(() => assertOriginalReceipt({ ...receipt, logs: [{ ...receipt.logs[0], ...change }] }));
});
