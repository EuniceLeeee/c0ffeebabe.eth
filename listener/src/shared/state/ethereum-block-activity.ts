/** Evidence profile, not a runtime fork-discovery mechanism.
 * Reviewed go-ethereum revision (all paths below are at this immutable revision):
 * https://raw.githubusercontent.com/ethereum/go-ethereum/48a7c17281a617ddc0fac7bda277b3641e4c1fc0/params/config.go
 * params/protocol_params.go: SystemAddress and four system-call destinations.
 * core/state_processor.go: PreExecution/PostExecution and system-call implementations.
 * core/state_transition.go: authorization writes precede the ordinary EVM call.
 * consensus/beacon/consensus.go: withdrawal balance credits; no PoS block reward.
 * core/types/block.go + internal/ethapi/api.go: supported header/transaction envelopes.
 */
export const ETHEREUM_BLOCK_ACTIVITY_PROFILE = Object.freeze({
  gethRevision: "48a7c17281a617ddc0fac7bda277b3641e4c1fc0",
  chainId: 1n,
  pragueTime: 1746612311n,
  osakaTime: 1764798551n,
  bpo1Time: 1765290071n,
  bpo2Time: 1767747671n,
  bogotaTime: null,
});

export interface EthereumBlockActivity {
  readonly transactionHashes: readonly string[];
  readonly passiveTouchedAddresses: readonly string[];
}

// Ethereum consensus infrastructure, never Family/venue admission or pricing policy.
const SYSTEM_ADDRESSES = Object.freeze([
  "0xfffffffffffffffffffffffffffffffffffffffe",
  "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02",
  "0x0000F90827F1C53a10cb7A02335B175320002935",
  "0x00000961Ef480Eb55e80D19ad83579A64c007002",
  "0x0000BBdDc7CE488642fb579F8B00f3a590007251",
].map(address => address.toLowerCase()));
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const EMPTY_UNCLES = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";
const HEADER_HASH_FIELDS = ["hash", "parentHash", "mixHash", "stateRoot", "transactionsRoot", "receiptsRoot",
  "withdrawalsRoot", "parentBeaconBlockRoot", "requestsHash"];
const BLOCK_FIELDS = new Set([...HEADER_HASH_FIELDS, "number", "timestamp", "miner", "nonce", "difficulty", "sha3Uncles",
  "logsBloom", "extraData", "gasLimit", "gasUsed", "baseFeePerGas", "blobGasUsed", "excessBlobGas",
  "transactions", "uncles", "withdrawals", "size", "totalDifficulty"]);
const TX_FIELDS = new Set(["hash", "type", "blockHash", "blockNumber", "blockTimestamp", "transactionIndex", "from", "to",
  "nonce", "gas", "gasPrice", "value", "input", "v", "r", "s", "chainId", "accessList", "yParity",
  "maxFeePerGas", "maxPriorityFeePerGas", "maxFeePerBlobGas", "blobVersionedHashes"]);
const ACCESS_FIELDS = new Set(["address", "storageKeys"]);
const WITHDRAWAL_FIELDS = new Set(["index", "validatorIndex", "address", "amount"]);

/**
 * Passive activity only; callers still need the hash-pinned complete logs/call trace.
 * Accepts observed, full-transaction JSON-RPC blocks under the pinned mainnet
 * Prague/Osaka profile, including BPO1/BPO2 (blob changes, no new system targets).
 * All five system accounts are conservatively dirty even for an empty block.
 *
 * Null means no carry proof, not a failure of raw pricing. Unknown fields/types,
 * missing fork fields, and any authorizationList/type-4 transaction fail closed.
 * This is a shape/coverage check, NOT a consensus/hash/signature verifier. Caller
 * authenticates the observation and deployment's fork profile. Bogota is nil at
 * the pin; Amsterdam is not configured on mainnet there. A future fork with the
 * SAME envelope cannot be detected here: review/disable this profile on consensus
 * upgrades. There is deliberately no invented expiry or sample-block limit.
 */
export function ethereumBlockActivityCoverage(chainId: bigint, block: unknown): EthereumBlockActivity | null {
  try {
    if (chainId !== ETHEREUM_BLOCK_ACTIVITY_PROFILE.chainId || !record(block) || !knownFields(block, BLOCK_FIELDS)) return null;
    const timestamp = quantity(block.timestamp, 64), number = quantity(block.number, 64);
    const gasLimit = quantity(block.gasLimit, 64), gasUsed = quantity(block.gasUsed, 64);
    if (timestamp === null || timestamp < ETHEREUM_BLOCK_ACTIVITY_PROFILE.pragueTime || number === null ||
        gasLimit === null || gasLimit === 0n || gasUsed === null || gasUsed > gasLimit ||
        HEADER_HASH_FIELDS.some(field => !matches(HASH, block[field])) || !matches(ADDRESS, block.miner) ||
        block.difficulty !== "0x0" || block.nonce !== "0x0000000000000000" ||
        typeof block.sha3Uncles !== "string" || block.sha3Uncles.toLowerCase() !== EMPTY_UNCLES ||
        !Array.isArray(block.uncles) || block.uncles.length !== 0 ||
        !matches(/^0x[0-9a-fA-F]{512}$/, block.logsBloom) || !matches(BYTES, block.extraData) || block.extraData.length > 66 ||
        quantity(block.baseFeePerGas) === null || quantity(block.blobGasUsed, 64) === null || quantity(block.excessBlobGas, 64) === null ||
        (block.size !== undefined && quantity(block.size, 64) === null) ||
        (block.totalDifficulty !== undefined && quantity(block.totalDifficulty) === null) ||
        !Array.isArray(block.transactions) || !Array.isArray(block.withdrawals)) return null;

    const transactionHashes: string[] = [], seenHashes = new Set<string>();
    for (const [index, tx] of block.transactions.entries()) {
      if (!validTransaction(tx, block.hash as string, number, timestamp, index)) return null;
      const hash = (tx.hash as string).toLowerCase();
      if (seenHashes.has(hash)) return null;
      seenHashes.add(hash);
      transactionHashes.push(hash);
    }
    const passive = new Set([...SYSTEM_ADDRESSES, block.miner.toLowerCase()]);
    for (const withdrawal of block.withdrawals) {
      if (!record(withdrawal) || !knownFields(withdrawal, WITHDRAWAL_FIELDS) || !matches(ADDRESS, withdrawal.address) ||
          ["index", "validatorIndex", "amount"].some(field => quantity(withdrawal[field], 64) === null)) return null;
      passive.add(withdrawal.address.toLowerCase());
    }
    return Object.freeze({ transactionHashes: Object.freeze(transactionHashes),
      passiveTouchedAddresses: Object.freeze([...passive].sort()) });
  } catch {
    // Malformed accessors/iterators cannot produce partial activity evidence.
    return null;
  }
}

function validTransaction(tx: unknown, blockHash: string, number: bigint, timestamp: bigint, index: number): tx is Record<string, unknown> {
  if (!record(tx) || "authorizationList" in tx || !knownFields(tx, TX_FIELDS)) return false;
  const type = quantity(tx.type, 8);
  if (type === null || type > 3n || !matches(HASH, tx.hash) || !matches(HASH, tx.blockHash) ||
      tx.blockHash.toLowerCase() !== blockHash.toLowerCase() || quantity(tx.blockNumber, 64) !== number ||
      quantity(tx.transactionIndex, 64) !== BigInt(index) || !matches(ADDRESS, tx.from) ||
      (tx.to !== null && !matches(ADDRESS, tx.to)) || !matches(BYTES, tx.input) ||
      quantity(tx.nonce, 64) === null || quantity(tx.gas, 64) === null ||
      ["gasPrice", "value", "v", "r", "s"].some(field => quantity(tx[field]) === null) ||
      (tx.blockTimestamp !== undefined && quantity(tx.blockTimestamp, 64) !== timestamp) ||
      (tx.yParity !== undefined && quantity(tx.yParity, 8) !== 0n && quantity(tx.yParity, 8) !== 1n)) return false;
  if (type === 0n) {
    if (tx.chainId !== undefined && quantity(tx.chainId) !== 0n && quantity(tx.chainId) !== 1n) return false;
    if ("accessList" in tx) return false;
  } else {
    if (quantity(tx.chainId) !== 1n || !Array.isArray(tx.accessList)) return false;
    for (const access of tx.accessList) {
      if (!record(access) || !knownFields(access, ACCESS_FIELDS) || !matches(ADDRESS, access.address) || !Array.isArray(access.storageKeys)) return false;
      for (const key of access.storageKeys) if (!matches(HASH, key)) return false;
    }
  }
  if (type < 2n) {
    if ("maxFeePerGas" in tx || "maxPriorityFeePerGas" in tx) return false;
  } else if (quantity(tx.maxFeePerGas) === null || quantity(tx.maxPriorityFeePerGas) === null) return false;
  if (type !== 3n) return !("maxFeePerBlobGas" in tx || "blobVersionedHashes" in tx);
  if (!matches(ADDRESS, tx.to) || quantity(tx.maxFeePerBlobGas) === null ||
      !Array.isArray(tx.blobVersionedHashes) || tx.blobVersionedHashes.length === 0) return false;
  for (const hash of tx.blobVersionedHashes) if (!matches(/^0x01[0-9a-fA-F]{62}$/, hash)) return false;
  return true;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function knownFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && fields.has(key));
}
function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.test(value);
}
function quantity(value: unknown, bits = 256): bigint | null {
  if (typeof value !== "string" || value.length > 2 + bits / 4 || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) return null;
  return BigInt(value);
}
