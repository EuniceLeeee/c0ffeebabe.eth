import assert from "node:assert/strict";
import { ETHEREUM_BLOCK_ACTIVITY_PROFILE, ethereumBlockActivityCoverage } from "../../shared/state/ethereum-block-activity.js";

// Complete synthetic RPC envelopes, not cryptographic block/signature witnesses.
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const address = (byte: string) => `0x${byte.repeat(40)}`;
const quantity = (value: bigint | number) => `0x${value.toString(16)}`;
const BLOCK_HASH = hash("a"), PARENT_HASH = hash("b"), HEIGHT = quantity(26_000_000);
const MINER = address("a"), WITHDRAWAL = address("b"), SENDER = address("c"), TARGET = address("d"), COLD = address("e");
const SYSTEM = [
  "0xfffffffffffffffffffffffffffffffffffffffe",
  "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02",
  "0x0000F90827F1C53a10cb7A02335B175320002935",
  "0x00000961Ef480Eb55e80D19ad83579A64c007002",
  "0x0000BBdDc7CE488642fb579F8B00f3a590007251",
].map(value => value.toLowerCase());

function transaction(type = 2, index = 0): Record<string, unknown> {
  return {
    hash: `0x${(index + 1).toString(16).padStart(64, "0")}`, type: quantity(type),
    blockHash: BLOCK_HASH, blockNumber: HEIGHT, transactionIndex: quantity(index),
    from: SENDER, to: TARGET, nonce: "0x0", gas: "0x5208", gasPrice: "0x2", value: "0x0", input: "0x",
    v: type === 0 ? "0x25" : "0x1", r: "0x1", s: "0x1", chainId: "0x1",
    ...(type === 0 ? {} : { accessList: [], yParity: "0x1" }),
    ...(type < 2 ? {} : { maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" }),
    ...(type !== 3 ? {} : { maxFeePerBlobGas: "0x1", blobVersionedHashes: [`0x01${"00".repeat(31)}`] }),
  };
}
function block(transactions: unknown[] = [transaction()]): Record<string, unknown> {
  return {
    hash: BLOCK_HASH, parentHash: PARENT_HASH, number: HEIGHT, timestamp: quantity(1_800_000_000),
    nonce: "0x0000000000000000", mixHash: hash("c"), difficulty: "0x0", miner: MINER,
    sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
    stateRoot: hash("d"), transactionsRoot: hash("e"), receiptsRoot: hash("f"), logsBloom: `0x${"00".repeat(256)}`,
    gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1", extraData: "0x", uncles: [],
    withdrawalsRoot: hash("1"), parentBeaconBlockRoot: hash("2"), requestsHash: hash("3"),
    blobGasUsed: "0x0", excessBlobGas: "0x0", transactions,
    withdrawals: [{ index: "0x1", validatorIndex: "0x2", address: WITHDRAWAL, amount: "0x0" }],
  };
}
let rejected = 0;
function rejects(name: string, value: unknown, chainId = 1n): void {
  assert.equal(ethereumBlockActivityCoverage(chainId, value), null, name);
  rejected++;
}

assert.equal(ETHEREUM_BLOCK_ACTIVITY_PROFILE.gethRevision, "48a7c17281a617ddc0fac7bda277b3641e4c1fc0");
assert(Object.isFrozen(ETHEREUM_BLOCK_ACTIVITY_PROFILE));
assert.equal(ETHEREUM_BLOCK_ACTIVITY_PROFILE.pragueTime, 1746612311n);
assert.equal(ETHEREUM_BLOCK_ACTIVITY_PROFILE.osakaTime, 1764798551n);
assert.equal(ETHEREUM_BLOCK_ACTIVITY_PROFILE.bpo1Time, 1765290071n);
assert.equal(ETHEREUM_BLOCK_ACTIVITY_PROFILE.bpo2Time, 1767747671n);
assert.equal(ETHEREUM_BLOCK_ACTIVITY_PROFILE.bogotaTime, null);

const full = block([transaction(0, 0), transaction(1, 1), transaction(2, 2), transaction(3, 3)]);
const before = structuredClone(full);
const coverage = ethereumBlockActivityCoverage(1n, full);
assert(coverage);
assert.deepEqual(full, before, "input is not mutated");
assert.deepEqual(coverage.transactionHashes, (full.transactions as Record<string, unknown>[]).map(tx => tx.hash));
assert.deepEqual(coverage.passiveTouchedAddresses, [...SYSTEM, MINER, WITHDRAWAL].sort());
for (const system of SYSTEM) assert(coverage.passiveTouchedAddresses.includes(system), "all consensus system targets are always dirty");
assert(!coverage.passiveTouchedAddresses.includes(SENDER) && !coverage.passiveTouchedAddresses.includes(TARGET),
  "ordinary transaction activity still belongs to the separate complete call-trace proof");
assert(Object.isFrozen(coverage) && Object.isFrozen(coverage.transactionHashes) && Object.isFrozen(coverage.passiveTouchedAddresses));
assert.throws(() => (coverage.transactionHashes as string[]).push(BLOCK_HASH), TypeError);
assert.throws(() => (coverage.passiveTouchedAddresses as string[]).push(COLD), TypeError);
(full.transactions as Record<string, unknown>[])[0]!.hash = PARENT_HASH;
(full.withdrawals as Record<string, unknown>[])[0]!.address = COLD;
full.miner = COLD;
assert.deepEqual(coverage.passiveTouchedAddresses, [...SYSTEM, MINER, WITHDRAWAL].sort(), "returned addresses are detached");
assert.notEqual(coverage.transactionHashes[0], PARENT_HASH, "returned hashes are detached");

const mixedCase = block([{ ...transaction(), hash: hash("A"), blockHash: hash("A"), blockTimestamp: quantity(1_800_000_000) }]);
mixedCase.hash = hash("A");
mixedCase.miner = address("A");
mixedCase.withdrawals = [
  { index: "0x1", validatorIndex: "0x2", address: address("B"), amount: "0x0" },
  { index: "0x2", validatorIndex: "0x3", address: WITHDRAWAL, amount: "0x1" },
  { index: "0x3", validatorIndex: "0x4", address: MINER, amount: "0x1" },
];
const normalized = ethereumBlockActivityCoverage(1n, mixedCase);
assert(normalized);
assert.deepEqual(normalized.transactionHashes, [BLOCK_HASH]);
assert.deepEqual(normalized.passiveTouchedAddresses, [...SYSTEM, MINER, WITHDRAWAL].sort(), "normalize, sort and deduplicate addresses");

for (const timestamp of [1746612311n, 1764798550n, 1764798551n, 1765290071n, 1767747671n]) {
  const empty = ethereumBlockActivityCoverage(1n, { ...block([]), timestamp: quantity(timestamp), withdrawals: [] });
  assert(empty, "complete empty blocks are covered across the reviewed Prague/Osaka/BPO boundaries");
  assert.deepEqual(empty.transactionHashes, []);
  assert.deepEqual(empty.passiveTouchedAddresses, [...SYSTEM, MINER].sort());
}
rejects("pre-Prague is outside this evidence profile", { ...block(), timestamp: quantity(1746612310n) });
assert(ethereumBlockActivityCoverage(1n, { ...block(), timestamp: quantity(2_000_000_000) }),
  "no invented expiry: an unchanged envelope remains CONDITIONAL on the deployment still using the pinned profile");
for (const chainId of [0n, 5n, 11155111n, 560048n, 1337n, 1 as unknown as bigint]) rejects("unsupported chain", block(), chainId);

for (const value of [null, undefined, "", [], {}, Object.create({ ...block() })]) rejects("not a complete plain block", value);
for (const field of ["hash", "parentHash", "number", "timestamp", "miner", "nonce", "difficulty", "sha3Uncles", "mixHash",
  "stateRoot", "transactionsRoot", "receiptsRoot", "logsBloom", "gasLimit", "gasUsed", "baseFeePerGas", "extraData", "uncles",
  "withdrawalsRoot", "parentBeaconBlockRoot", "requestsHash", "blobGasUsed", "excessBlobGas", "transactions", "withdrawals"]) {
  const missing = block();
  delete missing[field];
  rejects(`missing header field ${field}`, missing);
}
for (const change of [
  { hash: "bad" }, { parentHash: "0x1" }, { timestamp: "0x01" }, { timestamp: "1800000000" },
  { timestamp: "0x10000000000000000" }, { number: -1 }, { miner: "bad" },
  { nonce: "0x0000000000000001" }, { difficulty: "0x1" }, { uncles: [hash("0")] }, { sha3Uncles: hash("0") },
  { requestsHash: null }, { withdrawalsRoot: null }, { parentBeaconBlockRoot: null },
  { blobGasUsed: -1 }, { excessBlobGas: "0x00" }, { baseFeePerGas: null },
  { gasLimit: "0x0" }, { gasUsed: "0xffffffffff" }, { logsBloom: "0x" }, { extraData: "0x1" },
  { extraData: `0x${"00".repeat(33)}` }, { transactions: null }, { withdrawals: null },
  { size: "bad" }, { totalDifficulty: null },
  { blockAccessListHash: hash("0") }, { slotNumber: "0x1" }, { futureForkField: true }, { [Symbol("unknown")]: true },
]) rejects("malformed or unsupported header shape", { ...block(), ...change });

for (const tx of [null, "0x1", transaction().hash, {}, { hash: transaction().hash, type: "0x2" }]) {
  rejects("hash-only and partial transaction objects cannot establish absence of authorizations", block([tx]));
}
for (const field of ["hash", "type", "blockHash", "blockNumber", "transactionIndex", "from", "to", "nonce", "gas",
  "gasPrice", "value", "input", "v", "r", "s", "chainId", "accessList", "maxFeePerGas", "maxPriorityFeePerGas"]) {
  const missing = transaction();
  delete missing[field];
  rejects(`missing transaction field ${field}`, block([missing]));
}
for (const change of [
  { type: "0x4" }, { type: "0x5" }, { type: "0xff" }, { type: "0x04" }, { type: 2 }, { type: "2" },
  { hash: "bad" }, { blockHash: PARENT_HASH }, { blockNumber: "0x1" }, { transactionIndex: "0x1" },
  { blockTimestamp: "0x1" }, { blockHash: null }, { from: "bad" }, { to: "bad" }, { input: "0x1" },
  { nonce: "0x10000000000000000" }, { gas: "bad" }, { value: -1 }, { v: null }, { r: undefined }, { s: "0x00" },
  { chainId: "0x2" }, { yParity: "0x2" }, { accessList: null }, { accessList: [null] },
  { accessList: [{ address: TARGET, storageKeys: ["bad"] }] },
  { accessList: [{ address: "bad", storageKeys: [] }] },
  { accessList: [{ address: TARGET, storageKeys: Array(1) }] },
  { maxFeePerGas: "bad" }, { maxPriorityFeePerGas: null }, { blobVersionedHashes: [] }, { futureTxField: true },
]) rejects("malformed or unsupported full transaction envelope", block([{ ...transaction(), ...change }]));
rejects("duplicate hashes regardless of case", block([{ ...transaction(2, 0), hash: hash("a") }, { ...transaction(2, 1), hash: hash("A") }]));
rejects("transaction order mismatch", block([transaction(2, 1), transaction(2, 0)]));
rejects("sparse transaction list", block(Array(1)));
for (const type of [0, 1, 2, 3]) for (const authorizationList of [undefined, null, [], "bad", [{ address: COLD }]]) {
  rejects("any authorizationList presence disables the whole block", block([
    transaction(2, 0), { ...transaction(type, 1), authorizationList }, transaction(2, 2),
  ]));
}
rejects("type-4 cold authorization cannot be covered by top-level from/to or logs", block([
  transaction(2, 0), { ...transaction(2, 1), type: "0x4", to: TARGET,
    authorizationList: [{ chainId: "0x1", address: COLD, nonce: "0x0", yParity: "0x1", r: "0x1", s: "0x1" }] },
]));
for (const change of [{ to: null }, { maxFeePerBlobGas: undefined }, { blobVersionedHashes: [] },
  { blobVersionedHashes: [hash("0")] }, { blobVersionedHashes: Array(1) }]) {
  rejects("malformed blob envelope", block([{ ...transaction(3), ...change }]));
}
for (const type of [0, 1, 2]) assert(ethereumBlockActivityCoverage(1n, block([{ ...transaction(type), to: null }])), "ordinary contract creation remains supported");
const unprotected = transaction(0);
delete unprotected.chainId;
unprotected.v = "0x1b";
assert(ethereumBlockActivityCoverage(1n, block([unprotected])), "explicit type-0 unprotected legacy envelope is supported");

for (const withdrawal of [null, {}, { index: "0x0", validatorIndex: "0x1", amount: "0x1" },
  { index: "0x0", validatorIndex: "0x1", amount: "0x1", address: "bad" },
  { index: "0x0", validatorIndex: "0x1", amount: -1, address: WITHDRAWAL },
  { index: "0x0", validatorIndex: "0x1", amount: "0x1", address: WITHDRAWAL, unknown: true },
]) rejects("malformed withdrawal evidence", { ...block(), withdrawals: [withdrawal] });
rejects("sparse withdrawals", { ...block(), withdrawals: Array(1) });
const throwing = block();
Object.defineProperty(throwing, "timestamp", { get() { throw new Error("malformed getter"); } });
rejects("malformed accessor returns null rather than throwing", throwing);

console.log(`ethereum-block-activity PASS (${rejected} rejection controls; pinned fork/system coverage, full envelopes, authorization exclusion, immutable data)`);
