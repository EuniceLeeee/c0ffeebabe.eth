import {
  encodeCanonicalBytes,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  materializeHistoricalFamilyFactBundleV1,
  type HistoricalFamilyFactManifestV1,
  type HistoricalRpcObjectInputV1,
} from "./index.ts";

const CALL_TRACER_CONFIG = Object.freeze({
  tracer: "callTracer",
  tracerConfig: Object.freeze({ onlyTopCall: false }),
});

export interface HistoricalFamilyFactsJsonRpcV1 {
  request(method: string, params: readonly CanonicalJson[]): Promise<unknown>;
}

export interface HistoricalFamilyLogDiscoveryV1 {
  readonly fromBlock: string;
  readonly toBlock: string;
  readonly maxBlocksPerRequest: string;
  readonly address: string | null;
  readonly topic0: Hash;
}

export interface HistoricalFamilyLogLocatorV1 {
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly transactionIndex: string;
  readonly logIndex: string;
  readonly address: string;
  readonly topic0: Hash;
}

export interface HistoricalFamilyFactsAcquisitionRequestV1 {
  readonly rootDirectory: string;
  readonly discovery: HistoricalFamilyLogDiscoveryV1;
}

export interface HistoricalFamilyFactsAcquisitionReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.historical-family-facts-acquisition-receipt";
  readonly advisoryOnly: true;
  readonly locator: HistoricalFamilyLogLocatorV1;
  readonly chainId: string;
  readonly canonicalBlockHash: Hash;
  readonly txHash: Hash;
  readonly identityRoot: Hash;
  readonly manifestRoot: Hash;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`expected plain object at ${path}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`expected non-empty string at ${path}`);
  return value;
}

function hash(value: unknown, path: string): Hash {
  const result = text(value, path).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) fail(`expected 32-byte hash at ${path}`);
  return result as Hash;
}

function address(value: unknown, path: string): string {
  const result = text(value, path).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result)) fail(`expected address at ${path}`);
  return result;
}

function hexData(value: unknown, path: string): string {
  const result = text(value, path).toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(result)) fail(`expected even-length hex data at ${path}`);
  return result;
}

function quantity(value: unknown, path: string): bigint {
  const result = text(value, path).toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(result)) fail(`expected canonical hex quantity at ${path}`);
  return BigInt(result);
}

function positiveDecimal(value: unknown, path: string): bigint {
  const result = text(value, path);
  if (!/^[1-9][0-9]*$/.test(result)) fail(`expected positive decimal string at ${path}`);
  return BigInt(result);
}

function hexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function canonicalBytes(value: unknown, path: string): Uint8Array {
  try {
    return encodeCanonicalBytes(value);
  } catch (error) {
    throw new TypeError(`${path} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exactCanonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalBytes(left, "left canonical value")).equals(
    Buffer.from(canonicalBytes(right, "right canonical value")),
  );
}

function decodeLocator(raw: unknown, path: string): HistoricalFamilyLogLocatorV1 {
  const log = plainObject(raw, path);
  if (log.removed === true) fail(`removed log at ${path}`);
  if (!Array.isArray(log.topics) || log.topics.length === 0) fail(`expected topics at ${path}.topics`);
  return Object.freeze({
    blockNumber: hexQuantity(quantity(log.blockNumber, `${path}.blockNumber`)),
    blockHash: hash(log.blockHash, `${path}.blockHash`),
    txHash: hash(log.transactionHash, `${path}.transactionHash`),
    transactionIndex: hexQuantity(quantity(log.transactionIndex, `${path}.transactionIndex`)),
    logIndex: hexQuantity(quantity(log.logIndex, `${path}.logIndex`)),
    address: address(log.address, `${path}.address`),
    topic0: hash(log.topics[0], `${path}.topics[0]`),
  });
}

function assertHeaderIdentity(
  raw: unknown,
  path: string,
  blockNumber: string,
  blockHash: Hash,
): Record<string, unknown> {
  const header = plainObject(raw, path);
  if (hexQuantity(quantity(header.number, `${path}.number`)) !== blockNumber) {
    fail(`${path} block number mismatch`);
  }
  if (hash(header.hash, `${path}.hash`) !== blockHash) fail(`${path} block hash mismatch`);
  hash(header.stateRoot, `${path}.stateRoot`);
  return header;
}

function assertTransactionIdentity(raw: unknown, locator: HistoricalFamilyLogLocatorV1): void {
  const transaction = plainObject(raw, "$.transaction");
  if (hash(transaction.hash, "$.transaction.hash") !== locator.txHash) fail("transaction hash mismatch");
  if (hash(transaction.blockHash, "$.transaction.blockHash") !== locator.blockHash) {
    fail("transaction block hash mismatch");
  }
  if (hexQuantity(quantity(transaction.blockNumber, "$.transaction.blockNumber")) !== locator.blockNumber) {
    fail("transaction block number mismatch");
  }
  if (hexQuantity(quantity(transaction.transactionIndex, "$.transaction.transactionIndex")) !== locator.transactionIndex) {
    fail("transaction index mismatch");
  }
}

function assertReceiptIdentity(raw: unknown, locator: HistoricalFamilyLogLocatorV1): void {
  const receipt = plainObject(raw, "$.receipt");
  if (hash(receipt.transactionHash, "$.receipt.transactionHash") !== locator.txHash) {
    fail("receipt transaction hash mismatch");
  }
  if (hash(receipt.blockHash, "$.receipt.blockHash") !== locator.blockHash) {
    fail("receipt block hash mismatch");
  }
  if (hexQuantity(quantity(receipt.blockNumber, "$.receipt.blockNumber")) !== locator.blockNumber) {
    fail("receipt block number mismatch");
  }
  if (hexQuantity(quantity(receipt.transactionIndex, "$.receipt.transactionIndex")) !== locator.transactionIndex) {
    fail("receipt transaction index mismatch");
  }
  if (!Array.isArray(receipt.logs)) fail("expected array at $.receipt.logs");
  const matched = receipt.logs.some((rawLog, index) => {
    const candidate = decodeLocator(rawLog, `$.receipt.logs[${index}]`);
    return candidate.blockNumber === locator.blockNumber &&
      candidate.blockHash === locator.blockHash &&
      candidate.txHash === locator.txHash &&
      candidate.logIndex === locator.logIndex &&
      candidate.address === locator.address &&
      candidate.topic0 === locator.topic0;
  });
  if (!matched) fail("discovered log locator is absent from receipt");
}

function assertTraceIdentity(raw: unknown, rawTransaction: unknown): void {
  const trace = plainObject(raw, "$.trace");
  const transaction = plainObject(rawTransaction, "$.transaction");
  if (address(trace.from, "$.trace.from") !== address(transaction.from, "$.transaction.from")) {
    fail("trace root from mismatch");
  }
  if (transaction.to === null) {
    if (text(trace.type, "$.trace.type").toUpperCase() !== "CREATE") {
      fail("contract-creation trace root type mismatch");
    }
  } else {
    if (text(trace.type, "$.trace.type").toUpperCase() !== "CALL") {
      fail("transaction trace root type mismatch");
    }
    if (address(trace.to, "$.trace.to") !== address(transaction.to, "$.transaction.to")) {
      fail("trace root to mismatch");
    }
  }
  if (hexData(trace.input, "$.trace.input") !== hexData(transaction.input, "$.transaction.input")) {
    fail("trace root input mismatch");
  }
  if (quantity(trace.value, "$.trace.value") !== quantity(transaction.value, "$.transaction.value")) {
    fail("trace root value mismatch");
  }
}

function assertHeaderTransactionMembership(raw: unknown, locator: HistoricalFamilyLogLocatorV1): void {
  const header = plainObject(raw, "$.header");
  if (!Array.isArray(header.transactions)) fail("expected transaction hash array at $.header.transactions");
  const transactionIndex = quantity(locator.transactionIndex, "$.locator.transactionIndex");
  if (transactionIndex > BigInt(Number.MAX_SAFE_INTEGER)) fail("transaction index exceeds safe range");
  const indexed = header.transactions[Number(transactionIndex)];
  if (hash(indexed, `$.header.transactions[${transactionIndex}]`) !== locator.txHash) {
    fail("transaction is absent from its claimed canonical header index");
  }
}

async function discoverNewestLog(
  rpc: HistoricalFamilyFactsJsonRpcV1,
  input: HistoricalFamilyLogDiscoveryV1,
): Promise<HistoricalFamilyLogLocatorV1> {
  const from = quantity(input.fromBlock, "$.discovery.fromBlock");
  const to = quantity(input.toBlock, "$.discovery.toBlock");
  if (from > to) fail("discovery fromBlock exceeds toBlock");
  const span = positiveDecimal(input.maxBlocksPerRequest, "$.discovery.maxBlocksPerRequest");
  const expectedAddress = input.address === null ? null : address(input.address, "$.discovery.address");
  const expectedTopic0 = hash(input.topic0, "$.discovery.topic0");
  let upper = to;
  while (upper >= from) {
    const lower = upper - from + 1n > span ? upper - span + 1n : from;
    const filter: Record<string, CanonicalJson> = {
      fromBlock: hexQuantity(lower),
      toBlock: hexQuantity(upper),
      topics: [expectedTopic0],
    };
    if (expectedAddress !== null) filter.address = expectedAddress;
    const raw = await rpc.request("eth_getLogs", [filter]);
    if (!Array.isArray(raw)) fail("expected array from eth_getLogs");
    const locators = raw.map((log, index) => decodeLocator(log, `$.eth_getLogs[${index}]`));
    for (const locator of locators) {
      const block = quantity(locator.blockNumber, "$.locator.blockNumber");
      if (block < lower || block > upper) fail("eth_getLogs result outside requested range");
      if (locator.topic0 !== expectedTopic0) fail("eth_getLogs topic0 mismatch");
      if (expectedAddress !== null && locator.address !== expectedAddress) fail("eth_getLogs address mismatch");
    }
    locators.sort((left, right) => {
      const blockDifference = quantity(right.blockNumber, "right.blockNumber") -
        quantity(left.blockNumber, "left.blockNumber");
      if (blockDifference !== 0n) return blockDifference > 0n ? 1 : -1;
      const logDifference = quantity(right.logIndex, "right.logIndex") -
        quantity(left.logIndex, "left.logIndex");
      return logDifference === 0n ? 0 : logDifference > 0n ? 1 : -1;
    });
    if (locators.length > 0) return locators[0]!;
    if (lower === from) break;
    upper = lower - 1n;
  }
  fail("no historical family log found in bounded discovery range");
}

function materializationInputs(
  chainId: string,
  locator: HistoricalFamilyLogLocatorV1,
  transaction: unknown,
  receipt: unknown,
  trace: unknown,
  header: unknown,
): readonly HistoricalRpcObjectInputV1[] {
  const common = {
    chainId,
    canonicalBlockHash: locator.blockHash,
    txHash: locator.txHash,
  };
  return Object.freeze([
    Object.freeze({
      role: "transaction" as const,
      key: Object.freeze({
        ...common,
        method: "eth_getTransactionByHash" as const,
        canonicalParams: Object.freeze([locator.txHash]),
      }),
      resultBytes: canonicalBytes(transaction, "$.transaction"),
    }),
    Object.freeze({
      role: "receipt" as const,
      key: Object.freeze({
        ...common,
        method: "eth_getTransactionReceipt" as const,
        canonicalParams: Object.freeze([locator.txHash]),
      }),
      resultBytes: canonicalBytes(receipt, "$.receipt"),
    }),
    Object.freeze({
      role: "trace" as const,
      key: Object.freeze({
        ...common,
        method: "debug_traceTransaction" as const,
        canonicalParams: Object.freeze([locator.txHash, CALL_TRACER_CONFIG]),
      }),
      resultBytes: canonicalBytes(trace, "$.trace"),
    }),
    Object.freeze({
      role: "header" as const,
      key: Object.freeze({
        ...common,
        method: "eth_getBlockByHash" as const,
        canonicalParams: Object.freeze([locator.blockHash, false]),
      }),
      resultBytes: canonicalBytes(header, "$.header"),
    }),
  ]);
}

export async function acquireHistoricalFamilyFactsV1(
  rpc: HistoricalFamilyFactsJsonRpcV1,
  request: HistoricalFamilyFactsAcquisitionRequestV1,
): Promise<HistoricalFamilyFactsAcquisitionReceiptV1> {
  const chainIdQuantity = quantity(await rpc.request("eth_chainId", []), "$.chainFence.before");
  if (chainIdQuantity === 0n) fail("chainId must be positive");
  const chainId = chainIdQuantity.toString();
  const locator = await discoverNewestLog(rpc, request.discovery);
  const blockParams = Object.freeze([locator.blockNumber, false] as const);
  const before = await rpc.request("eth_getBlockByNumber", blockParams);
  assertHeaderIdentity(before, "$.canonicalFence.before", locator.blockNumber, locator.blockHash);
  const transaction = await rpc.request("eth_getTransactionByHash", [locator.txHash]);
  const receipt = await rpc.request("eth_getTransactionReceipt", [locator.txHash]);
  const trace = await rpc.request("debug_traceTransaction", [locator.txHash, CALL_TRACER_CONFIG]);
  const header = await rpc.request("eth_getBlockByHash", [locator.blockHash, false]);
  assertTransactionIdentity(transaction, locator);
  assertReceiptIdentity(receipt, locator);
  assertTraceIdentity(trace, transaction);
  assertHeaderIdentity(header, "$.header", locator.blockNumber, locator.blockHash);
  assertHeaderTransactionMembership(header, locator);
  if (!exactCanonicalEqual(before, header)) fail("block header methods disagree during acquisition");
  const after = await rpc.request("eth_getBlockByNumber", blockParams);
  assertHeaderIdentity(after, "$.canonicalFence.after", locator.blockNumber, locator.blockHash);
  if (!exactCanonicalEqual(before, after)) fail("canonical block changed during acquisition");
  const chainIdAfter = quantity(await rpc.request("eth_chainId", []), "$.chainFence.after");
  if (chainIdAfter !== chainIdQuantity) fail("chainId changed during acquisition");
  const manifest: HistoricalFamilyFactManifestV1 = materializeHistoricalFamilyFactBundleV1(
    request.rootDirectory,
    materializationInputs(chainId, locator, transaction, receipt, trace, header),
  );
  const identityRoot = hashDomain("aloha/historical-family-facts-acquisition-identity/v1", {
    chainId,
    canonicalBlockHash: locator.blockHash,
    txHash: locator.txHash,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.historical-family-facts-acquisition-receipt",
    advisoryOnly: true,
    locator,
    chainId,
    canonicalBlockHash: locator.blockHash,
    txHash: locator.txHash,
    identityRoot,
    manifestRoot: manifest.manifestRoot,
  });
}
