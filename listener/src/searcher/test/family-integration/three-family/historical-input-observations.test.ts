import test from "node:test";
import assert from "node:assert/strict";
import { assertHistoricalDiscoveryReceipt, assertHistoricalPriceDirection } from "./historical-input-observations.js";

const input = "0x1000000000000000000000000000000000000001";
const output = "0x1000000000000000000000000000000000000002";
const edge = { instanceKey: "pool", tokenIn: input, tokenOut: output };
const tx = "0x" + "11".repeat(32), hash = "0x" + "22".repeat(32);
const source = { number: 26138731, hash };
const candidate = { transactionHash: tx, blockNumber: source.number, blockHash: hash };
const receipt = { transactionHash: tx, blockNumber: "0x" + source.number.toString(16), blockHash: hash, status: "0x1" };

test("matching price row and Ready direction pass", () => {
  assertHistoricalPriceDirection(edge, { ...edge }, "pool");
});
test("same edge id with a swapped row direction is rejected", () => {
  assert.throws(() => assertHistoricalPriceDirection(edge, { ...edge, tokenIn: output, tokenOut: input }, "pool"), /direction/);
});
test("reusing another route's price direction cannot count twice", () => {
  assert.throws(() => assertHistoricalPriceDirection({ ...edge, tokenIn: output, tokenOut: input }, { ...edge }, "pool"), /direction/);
});
test("foreign price instance is rejected", () => {
  assert.throws(() => assertHistoricalPriceDirection(edge, { ...edge, instanceKey: "foreign" }, "pool"), /instance/);
});
test("real receipt anchors the discovery transaction to canonical N", () => {
  assertHistoricalDiscoveryReceipt(receipt, candidate, source);
});
test("invented transaction hash without a receipt is rejected", () => {
  assert.throws(() => assertHistoricalDiscoveryReceipt(null, candidate, source), /no canonical receipt/);
});
test("receipt of a different transaction is rejected", () => {
  assert.throws(() => assertHistoricalDiscoveryReceipt({ ...receipt, transactionHash: "0x" + "33".repeat(32) }, candidate, source), /transaction mismatch/);
});
test("foreign height or fork receipt is rejected", () => {
  assert.throws(() => assertHistoricalDiscoveryReceipt({ ...receipt, blockNumber: "0x1" }, candidate, source), /outside N/);
  assert.throws(() => assertHistoricalDiscoveryReceipt({ ...receipt, blockHash: "0x" + "44".repeat(32) }, candidate, source), /canonical N/);
});
test("failed discovery transaction is rejected for these success samples", () => {
  assert.throws(() => assertHistoricalDiscoveryReceipt({ ...receipt, status: "0x0" }, candidate, source), /successful/);
});
