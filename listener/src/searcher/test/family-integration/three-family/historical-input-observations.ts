import assert from "node:assert/strict";
import { ethers } from "ethers";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Observation assertions only; never issue admission or calculate a quote. */
export function assertHistoricalPriceDirection(
  edge: { tokenIn: string; tokenOut: string; instanceKey?: string },
  row: { tokenIn: string; tokenOut: string; instanceKey: string },
  instanceKey: string,
): void {
  assert.equal(edge.instanceKey, instanceKey, "Ready edge belongs to another instance");
  assert.equal(row.instanceKey, instanceKey, "price row belongs to another instance");
  assert(same(row.tokenIn, edge.tokenIn) && same(row.tokenOut, edge.tokenOut),
    "price row direction differs from Ready edge");
}

export function assertHistoricalDiscoveryReceipt(
  receipt: any,
  candidate: { transactionHash: string; blockNumber: number; blockHash: string },
  source: { number: number; hash: string },
): void {
  assert(receipt, "discovery transaction has no canonical receipt");
  assert(ethers.isHexString(candidate.transactionHash, 32), "invalid discovery transaction hash");
  assert.equal(candidate.blockNumber, source.number);
  assert(same(candidate.blockHash, source.hash));
  assert(same(receipt.transactionHash, candidate.transactionHash), "discovery transaction mismatch");
  assert.equal(Number(BigInt(receipt.blockNumber)), source.number, "discovery transaction is outside N");
  assert(same(receipt.blockHash, source.hash), "discovery transaction is outside canonical N");
  assert.equal(BigInt(receipt.status), 1n, "this sample requires a successful discovery transaction");
}
