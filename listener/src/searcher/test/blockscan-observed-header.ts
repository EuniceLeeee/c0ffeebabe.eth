import assert from "node:assert/strict";
import { parseBlockScanObservedHeader } from "../blockscan-observed-header.js";

const hash = (c: string) => "0x" + c.repeat(64);
const addr = (c: string) => "0x" + c.repeat(40);
const tx = { blockHash: hash("a"), blockNumber: "0x123", from: addr("a"), to: addr("b"),
  nonce: "0x1", gas: "0x5208", gasPrice: "0x1", value: "0x0", input: "0x", v: "0x1b", r: "0x1", s: "0x2" };
const raw = { number: "0x123", hash: hash("a"), parentHash: hash("b"), timestamp: "0x" + (1767747672).toString(16),
  miner: addr("c"), transactions: [{ ...tx, hash: hash("1"), type: "0x2", transactionIndex: "0x0",
    chainId: "0x1", accessList: [], maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" },
    { ...tx, hash: hash("2"), type: "0x0", transactionIndex: "0x1" }],
  withdrawals: [{ address: addr("d"), index: "0x0", validatorIndex: "0x0", amount: "0x1" }],
  withdrawalsRoot: hash("3"), parentBeaconBlockRoot: hash("4"), requestsHash: hash("5"),
  blobGasUsed: "0x0", excessBlobGas: "0x0",
  difficulty: "0x0", nonce: "0x0000000000000000", uncles: [],
  sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
  logsBloom: "0x" + "00".repeat(256), extraData: "0x",
  mixHash: hash("6"), stateRoot: hash("7"), transactionsRoot: hash("8"), receiptsRoot: hash("9"),
  gasUsed: "0x1000", gasLimit: "0x2000", baseFeePerGas: "0x400" };
const header = parseBlockScanObservedHeader(raw, 0x123, 1n);
assert.equal(header.number, 0x123);
assert.equal(header.timestamp, 1767747672);
assert.equal(header.baseFeePerGas, 1024n);
assert.deepEqual(header.transactionHashes, raw.transactions.map(tx => tx.hash));
assert(header.passiveTouchedAddresses?.includes(addr("c")));
assert(header.passiveTouchedAddresses?.includes(addr("d")));
assert(Object.isFrozen(header) && Object.isFrozen(header.transactionHashes) && Object.isFrozen(header.passiveTouchedAddresses));
for (const bad of [null, [], { ...raw, number: "0x124" }, { ...raw, hash: null },
  { ...raw, parentHash: "0xb" }, { ...raw, transactions: [hash("1"), hash("1")] },
  { ...raw, transactions: [{ hash: "bad" }] },
  { ...raw, timestamp: "0x10000000000000000" }, { ...raw, gasUsed: "0x001" }]) {
  assert.throws(() => parseBlockScanObservedHeader(bad, 0x123, 1n));
}
for (const noProof of [{ ...raw, transactions: [hash("1")] },
  { ...raw, transactions: [{ hash: hash("1"), type: "0x4", authorizationList: [] }] },
  { ...raw, withdrawals: undefined }, { ...raw, withdrawals: [null] }, { ...raw, miner: "bad" }]) {
  assert.equal(parseBlockScanObservedHeader(noProof, 0x123, 1n).passiveTouchedAddresses, undefined);
}
assert.equal(parseBlockScanObservedHeader(raw, 0x123, 2n).passiveTouchedAddresses, undefined);
const addressCount = header.passiveTouchedAddresses!.length;
raw.transactions.push({ ...raw.transactions[0]!, hash: hash("3"), transactionIndex: "0x2" });
raw.withdrawals.push({ address: addr("e"), index: "0x1", validatorIndex: "0x1", amount: "0x1" });
assert.equal(header.transactionHashes.length, 2);
assert.equal(header.passiveTouchedAddresses!.length, addressCount);
console.log("blockscan observed header tests passed (offline)");
