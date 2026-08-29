import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  assertExactKeys,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";

export const HISTORICAL_FAMILY_FACT_MANIFEST_KIND =
  "aloha.historical-family-fact-manifest" as const;

const TRANSACTION_METHOD = "eth_getTransactionByHash" as const;
const RECEIPT_METHOD = "eth_getTransactionReceipt" as const;
const TRACE_METHOD = "debug_traceTransaction" as const;
const HEADER_METHOD = "eth_getBlockByHash" as const;

export type HistoricalRpcRole = "transaction" | "receipt" | "trace" | "header";
export type HistoricalRpcMethod =
  | typeof TRANSACTION_METHOD
  | typeof RECEIPT_METHOD
  | typeof TRACE_METHOD
  | typeof HEADER_METHOD;
export type FamilyFactStatus = "validated" | "contradicted" | "unresolved";
export type SupportedFamily = "univ2-standard" | "univ3-standard";

export interface HistoricalRpcObjectKeyV1 {
  readonly chainId: string;
  readonly canonicalBlockHash: Hash;
  readonly txHash: Hash;
  readonly method: HistoricalRpcMethod;
  readonly canonicalParams: readonly CanonicalJson[];
}

export interface HistoricalRpcObjectInputV1 {
  readonly role: HistoricalRpcRole;
  readonly key: HistoricalRpcObjectKeyV1;
  /** Exact canonical JSON bytes for the RPC result, without a JSON-RPC envelope. */
  readonly resultBytes: Uint8Array;
}

export interface HistoricalRpcManifestEntryV1 {
  readonly role: HistoricalRpcRole;
  readonly key: HistoricalRpcObjectKeyV1;
  readonly objectKey: Hash;
  readonly resultBytesSha256: Hash;
  readonly byteLength: string;
}

export interface HistoricalFamilyFactManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HISTORICAL_FAMILY_FACT_MANIFEST_KIND;
  readonly advisoryOnly: true;
  readonly chainId: string;
  readonly canonicalBlockHash: Hash;
  readonly txHash: Hash;
  readonly entries: readonly HistoricalRpcManifestEntryV1[];
  readonly manifestRoot: Hash;
}

export interface HistoricalFamilyAcquisitionDescriptorV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.historical-family-acquisition-descriptor";
  readonly advisoryOnly: true;
  readonly chainId: string;
  readonly txHash: Hash;
  readonly canonicalBlockHash: Hash | null;
  readonly canonicalBlockHashSource: "receipt.blockHash-then-header.hash";
  readonly requiredMethods: readonly HistoricalRpcMethod[];
  readonly expectedFamilies: readonly SupportedFamily[];
}

export interface FamilySwapFactV1 {
  readonly family: SupportedFamily;
  readonly logIndex: string;
  readonly pool: string;
  readonly successfulCallIndex: string | null;
  readonly selector: string;
  readonly amount0: string;
  readonly amount1: string;
  readonly direction: "zero-for-one" | "one-for-zero";
}

export interface HistoricalFamilyFactObservationV1 {
  readonly advisoryOnly: true;
  readonly status: FamilyFactStatus;
  readonly reasons: readonly string[];
  readonly chainId: string | null;
  readonly canonicalBlockHash: Hash | null;
  readonly txHash: Hash | null;
  readonly facts: readonly FamilySwapFactV1[];
}

export interface HistoricalFamilyFactEvaluationRequestV1 {
  readonly expectedFamilies: readonly SupportedFamily[];
}

export const TX149_ACQUISITION_DESCRIPTOR_V1: HistoricalFamilyAcquisitionDescriptorV1 =
  Object.freeze({
    schemaVersion: 1,
    kind: "aloha.historical-family-acquisition-descriptor",
    advisoryOnly: true,
    chainId: "1",
    txHash: "0x149df3ec17a6044e0c66c25aa55ce044abe33bf14cedea26295e1b6d4c9fde60",
    canonicalBlockHash: null,
    canonicalBlockHashSource: "receipt.blockHash-then-header.hash",
    requiredMethods: Object.freeze([
      TRANSACTION_METHOD,
      RECEIPT_METHOD,
      TRACE_METHOD,
      HEADER_METHOD,
    ]),
    expectedFamilies: Object.freeze(["univ2-standard", "univ3-standard"] as const),
  });

const ROLES: readonly HistoricalRpcRole[] = Object.freeze([
  "transaction",
  "receipt",
  "trace",
  "header",
]);
const METHODS: Readonly<Record<HistoricalRpcRole, HistoricalRpcMethod>> = Object.freeze({
  transaction: TRANSACTION_METHOD,
  receipt: RECEIPT_METHOD,
  trace: TRACE_METHOD,
  header: HEADER_METHOD,
});
const UNIV2_SWAP_TOPIC =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const UNIV3_SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const UNIV2_SWAP_SELECTOR = "0x022c0d9f";
const UNIV3_SWAP_SELECTOR = "0x128acb08";

function fail(message: string): never {
  throw new TypeError(message);
}

class HistoricalFactContradiction extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalFactContradiction";
  }
}

function contradiction(message: string): never {
  throw new HistoricalFactContradiction(message);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function decimal(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) fail(`expected unsigned decimal string at ${path}`);
  return result;
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

function hexQuantity(value: unknown, path: string): bigint {
  const result = text(value, path).toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(result)) fail(`expected canonical hex quantity at ${path}`);
  return BigInt(result);
}

function canonicalArray(value: unknown, path: string): readonly CanonicalJson[] {
  if (!Array.isArray(value)) fail(`expected array at ${path}`);
  encodeCanonicalBytes(value);
  return value as readonly CanonicalJson[];
}

export function historicalRpcObjectKeyV1(key: HistoricalRpcObjectKeyV1): Hash {
  return hashDomain("aloha/historical-rpc-object-key/v1", decodeHistoricalRpcObjectKeyV1(key));
}

function expectedParams(method: HistoricalRpcMethod, txHash: Hash, blockHash: Hash): readonly CanonicalJson[] {
  if (method === HEADER_METHOD) return [blockHash, false];
  if (method === TRACE_METHOD) {
    return [txHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }];
  }
  return [txHash];
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

export function decodeHistoricalRpcObjectKeyV1(value: unknown): HistoricalRpcObjectKeyV1 {
  const object = plainObject(value, "$.key");
  assertExactKeys(object, ["chainId", "canonicalBlockHash", "txHash", "method", "canonicalParams"], "$.key");
  const chainId = decimal(object.chainId, "$.key.chainId");
  if (chainId === "0") fail("chainId must be positive");
  const canonicalBlockHash = hash(object.canonicalBlockHash, "$.key.canonicalBlockHash");
  const txHash = hash(object.txHash, "$.key.txHash");
  const method = text(object.method, "$.key.method") as HistoricalRpcMethod;
  if (!Object.values(METHODS).includes(method)) fail("unsupported historical RPC method");
  const canonicalParams = canonicalArray(object.canonicalParams, "$.key.canonicalParams");
  if (!canonicalEqual(canonicalParams, expectedParams(method, txHash, canonicalBlockHash))) {
    fail(`canonicalParams do not exactly bind ${method}`);
  }
  return Object.freeze({ chainId, canonicalBlockHash, txHash, method, canonicalParams: Object.freeze([...canonicalParams]) });
}

function entryRoot(entry: Omit<HistoricalRpcManifestEntryV1, "objectKey">): Hash {
  return historicalRpcObjectKeyV1(entry.key);
}

function manifestRoot(manifest: Omit<HistoricalFamilyFactManifestV1, "manifestRoot">): Hash {
  return hashDomain("aloha/historical-family-fact-manifest/v1", manifest);
}

function buildManifest(inputs: readonly HistoricalRpcObjectInputV1[]): HistoricalFamilyFactManifestV1 {
  if (!Array.isArray(inputs) || inputs.length !== ROLES.length) fail("historical closure requires exactly four RPC objects");
  const seen = new Set<string>();
  const entries = inputs.map((input, index): HistoricalRpcManifestEntryV1 => {
    const object = plainObject(input, `$.inputs[${index}]`);
    assertExactKeys(object, ["role", "key", "resultBytes"], `$.inputs[${index}]`);
    const role = text(object.role, `$.inputs[${index}].role`) as HistoricalRpcRole;
    if (!ROLES.includes(role) || seen.has(role)) fail(`invalid or duplicate role ${role}`);
    seen.add(role);
    const key = decodeHistoricalRpcObjectKeyV1(object.key);
    if (key.method !== METHODS[role]) fail(`${role} role must use ${METHODS[role]}`);
    if (!(object.resultBytes instanceof Uint8Array) || Object.getPrototypeOf(object.resultBytes) !== Uint8Array.prototype) {
      fail(`resultBytes must be Uint8Array at $.inputs[${index}].resultBytes`);
    }
    decodeCanonicalBytes(object.resultBytes);
    const base = {
      role,
      key,
      resultBytesSha256: sha256Hex(object.resultBytes),
      byteLength: String(object.resultBytes.length),
    };
    return Object.freeze({ ...base, objectKey: entryRoot(base) });
  }).sort((left, right) => ROLES.indexOf(left.role) - ROLES.indexOf(right.role));
  if (seen.size !== ROLES.length) fail("historical RPC closure is incomplete");
  const common = entries[0]!.key;
  if (entries.some((entry) =>
    entry.key.chainId !== common.chainId ||
    entry.key.canonicalBlockHash !== common.canonicalBlockHash ||
    entry.key.txHash !== common.txHash
  )) fail("cross-chain/block/tx historical RPC splice");
  const base = {
    schemaVersion: 1 as const,
    kind: HISTORICAL_FAMILY_FACT_MANIFEST_KIND,
    advisoryOnly: true as const,
    chainId: common.chainId,
    canonicalBlockHash: common.canonicalBlockHash,
    txHash: common.txHash,
    entries: Object.freeze(entries),
  };
  return Object.freeze({ ...base, manifestRoot: manifestRoot(base) });
}

function writeExclusiveOrVerify(path: string, bytes: Uint8Array): void {
  try {
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`content-addressed path is not a regular file: ${path}`);
    const existing = readFileSync(path);
    if (!existing.equals(Buffer.from(bytes))) fail(`immutable content-addressed object changed: ${path}`);
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`content-addressed store path is not a real directory: ${path}`);
}

export function materializeHistoricalFamilyFactBundleV1(
  rootDirectory: string,
  inputs: readonly HistoricalRpcObjectInputV1[],
): HistoricalFamilyFactManifestV1 {
  const root = resolve(rootDirectory);
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(join(root, "objects"));
  ensurePrivateDirectory(join(root, "manifests"));
  const manifest = buildManifest(inputs);
  for (const entry of manifest.entries) {
    const input = inputs.find((candidate) => candidate.role === entry.role)!;
    writeExclusiveOrVerify(join(root, "objects", entry.resultBytesSha256.slice(2)), input.resultBytes);
  }
  writeExclusiveOrVerify(
    join(root, "manifests", `${manifest.manifestRoot.slice(2)}.json`),
    encodeCanonicalBytes(manifest),
  );
  return manifest;
}

function decodeManifest(value: unknown): HistoricalFamilyFactManifestV1 {
  const object = plainObject(value, "$");
  assertExactKeys(object, ["schemaVersion", "kind", "advisoryOnly", "chainId", "canonicalBlockHash", "txHash", "entries", "manifestRoot"], "$");
  if (object.schemaVersion !== 1 || object.kind !== HISTORICAL_FAMILY_FACT_MANIFEST_KIND || object.advisoryOnly !== true) {
    fail("invalid historical family fact manifest discriminator");
  }
  const chainId = decimal(object.chainId, "$.chainId");
  const canonicalBlockHash = hash(object.canonicalBlockHash, "$.canonicalBlockHash");
  const txHash = hash(object.txHash, "$.txHash");
  if (!Array.isArray(object.entries) || object.entries.length !== ROLES.length) fail("manifest closure must contain four entries");
  const entries = object.entries.map((raw, index): HistoricalRpcManifestEntryV1 => {
    const entry = plainObject(raw, `$.entries[${index}]`);
    assertExactKeys(entry, ["role", "key", "objectKey", "resultBytesSha256", "byteLength"], `$.entries[${index}]`);
    const role = text(entry.role, `$.entries[${index}].role`) as HistoricalRpcRole;
    if (role !== ROLES[index]) fail("manifest roles are not exact and ordered");
    const key = decodeHistoricalRpcObjectKeyV1(entry.key);
    if (key.method !== METHODS[role] || key.chainId !== chainId || key.canonicalBlockHash !== canonicalBlockHash || key.txHash !== txHash) {
      fail("manifest entry binding mismatch");
    }
    const result = {
      role,
      key,
      objectKey: hash(entry.objectKey, `$.entries[${index}].objectKey`),
      resultBytesSha256: hash(entry.resultBytesSha256, `$.entries[${index}].resultBytesSha256`),
      byteLength: decimal(entry.byteLength, `$.entries[${index}].byteLength`),
    };
    if (result.objectKey !== historicalRpcObjectKeyV1(key)) fail("historical RPC object key mismatch");
    return Object.freeze(result);
  });
  const base = {
    schemaVersion: 1 as const,
    kind: HISTORICAL_FAMILY_FACT_MANIFEST_KIND,
    advisoryOnly: true as const,
    chainId,
    canonicalBlockHash,
    txHash,
    entries: Object.freeze(entries),
  };
  const root = hash(object.manifestRoot, "$.manifestRoot");
  if (root !== manifestRoot(base)) fail("manifest root mismatch");
  return Object.freeze({ ...base, manifestRoot: root });
}

export function loadHistoricalFamilyFactBundleV1(
  rootDirectory: string,
  expectedManifestRoot: Hash,
): Readonly<{ manifest: HistoricalFamilyFactManifestV1; results: Readonly<Record<HistoricalRpcRole, CanonicalJson>> }> {
  const root = resolve(rootDirectory);
  const manifestPath = join(root, "manifests", `${hash(expectedManifestRoot, "$.expectedManifestRoot").slice(2)}.json`);
  if (!existsSync(manifestPath)) fail("historical manifest missing");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail("historical manifest is not a regular file");
  const manifest = decodeManifest(decodeCanonicalBytes(Uint8Array.from(readFileSync(manifestPath))));
  if (manifest.manifestRoot !== expectedManifestRoot) fail("loaded manifest root mismatch");
  const results = {} as Record<HistoricalRpcRole, CanonicalJson>;
  for (const entry of manifest.entries) {
    const objectPath = join(root, "objects", entry.resultBytesSha256.slice(2));
    if (!existsSync(objectPath)) fail(`historical object missing for ${entry.role}`);
    const stat = lstatSync(objectPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`historical object is not a regular file for ${entry.role}`);
    const bytes = readFileSync(objectPath);
    if (String(bytes.length) !== entry.byteLength || sha256Hex(bytes) !== entry.resultBytesSha256) {
      fail(`historical object bytes changed for ${entry.role}`);
    }
    results[entry.role] = decodeCanonicalBytes(Uint8Array.from(bytes));
  }
  return Object.freeze({ manifest, results: Object.freeze(results) });
}

interface TraceCall {
  readonly index: number;
  readonly to: string;
  readonly selector: string;
}

function successfulCalls(trace: CanonicalJson): readonly TraceCall[] {
  const calls: TraceCall[] = [];
  let index = 0;
  const visit = (raw: unknown, parentSuccessful: boolean): void => {
    const node = plainObject(raw, "$.trace");
    const currentIndex = index++;
    const ownSuccessful = parentSuccessful && node.error === undefined && node.revertReason === undefined;
    if (ownSuccessful && typeof node.to === "string" && typeof node.input === "string") {
      const input = hexData(node.input, "$.trace.input");
      calls.push({
        index: currentIndex,
        to: address(node.to, "$.trace.to"),
        selector: input.length >= 10 ? input.slice(0, 10) : input,
      });
    }
    if (node.calls !== undefined) {
      if (!Array.isArray(node.calls)) fail("trace calls must be an array");
      for (const child of node.calls) visit(child, ownSuccessful);
    }
  };
  visit(trace, true);
  return Object.freeze(calls);
}

function word(data: string, index: number, signed: boolean): bigint {
  const body = data.slice(2);
  const start = index * 64;
  if (body.length < start + 64) fail("swap log data is truncated");
  const unsigned = BigInt(`0x${body.slice(start, start + 64)}`);
  if (!signed || unsigned < (1n << 255n)) return unsigned;
  return unsigned - (1n << 256n);
}

function decodeSwapLog(
  raw: unknown,
  calls: readonly TraceCall[],
  minimumCallIndex: number,
): FamilySwapFactV1 | null {
  const log = plainObject(raw, "$.receipt.logs[]");
  if (!hasOwn(log, "topics")) contradiction("receipt log topics missing");
  const topics = canonicalArray(log.topics, "$.receipt.logs[].topics");
  if (topics.length === 0 || typeof topics[0] !== "string") return null;
  const topic0 = hash(topics[0], "$.receipt.logs[].topics[0]");
  const family = topic0 === UNIV2_SWAP_TOPIC
    ? "univ2-standard"
    : topic0 === UNIV3_SWAP_TOPIC
      ? "univ3-standard"
      : null;
  if (family === null) return null;
  if (!hasOwn(log, "address")) contradiction(`${family} pool identity missing`);
  if (!hasOwn(log, "logIndex")) contradiction(`${family} log order missing`);
  if (!hasOwn(log, "data")) contradiction(`${family} amount data missing`);
  const pool = address(log.address, "$.receipt.logs[].address");
  const logIndex = hexQuantity(log.logIndex, "$.receipt.logs[].logIndex").toString();
  const data = hexData(log.data, "$.receipt.logs[].data");
  const selector = family === "univ2-standard" ? UNIV2_SWAP_SELECTOR : UNIV3_SWAP_SELECTOR;
  let amount0: bigint;
  let amount1: bigint;
  let direction: FamilySwapFactV1["direction"];
  if (family === "univ2-standard") {
    const amount0In = word(data, 0, false);
    const amount1In = word(data, 1, false);
    const amount0Out = word(data, 2, false);
    const amount1Out = word(data, 3, false);
    if (amount0In > 0n && amount1In === 0n && amount0Out === 0n && amount1Out > 0n) {
      amount0 = amount0In;
      amount1 = -amount1Out;
      direction = "zero-for-one";
    } else if (amount1In > 0n && amount0In === 0n && amount1Out === 0n && amount0Out > 0n) {
      amount0 = -amount0Out;
      amount1 = amount1In;
      direction = "one-for-zero";
    } else contradiction("UniV2 Swap amounts do not describe one exact direction");
  } else {
    amount0 = word(data, 0, true);
    amount1 = word(data, 1, true);
    if (amount0 > 0n && amount1 < 0n) direction = "zero-for-one";
    else if (amount0 < 0n && amount1 > 0n) direction = "one-for-zero";
    else contradiction("UniV3 Swap amounts do not have opposite non-zero signs");
  }
  const call = calls.find((candidate) =>
    candidate.index > minimumCallIndex && candidate.to === pool && candidate.selector === selector);
  return Object.freeze({
    family,
    logIndex,
    pool,
    successfulCallIndex: call === undefined ? null : String(call.index),
    selector,
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    direction,
  });
}

function contradicted(manifest: HistoricalFamilyFactManifestV1, reasons: readonly string[], facts: readonly FamilySwapFactV1[] = []): HistoricalFamilyFactObservationV1 {
  return Object.freeze({
    advisoryOnly: true,
    status: "contradicted",
    reasons: Object.freeze([...reasons]),
    chainId: manifest.chainId,
    canonicalBlockHash: manifest.canonicalBlockHash,
    txHash: manifest.txHash,
    facts: Object.freeze([...facts]),
  });
}

function unresolved(
  manifest: HistoricalFamilyFactManifestV1 | null,
  reason: string,
): HistoricalFamilyFactObservationV1 {
  return Object.freeze({
    advisoryOnly: true,
    status: "unresolved",
    reasons: Object.freeze([reason]),
    chainId: manifest?.chainId ?? null,
    canonicalBlockHash: manifest?.canonicalBlockHash ?? null,
    txHash: manifest?.txHash ?? null,
    facts: Object.freeze([]),
  });
}

export function evaluateHistoricalFamilyFactsV1(
  rootDirectory: string,
  expectedManifestRoot: Hash,
  request: HistoricalFamilyFactEvaluationRequestV1,
): HistoricalFamilyFactObservationV1 {
  let bundle: ReturnType<typeof loadHistoricalFamilyFactBundleV1>;
  try {
    bundle = loadHistoricalFamilyFactBundleV1(rootDirectory, expectedManifestRoot);
  } catch (error) {
    return unresolved(null, error instanceof Error ? error.message : String(error));
  }
  const { manifest, results } = bundle;
  try {
    const transaction = plainObject(results.transaction, "$.transaction");
    const receipt = plainObject(results.receipt, "$.receipt");
    const header = plainObject(results.header, "$.header");
    if (!hasOwn(transaction, "hash")) return contradicted(manifest, ["transaction hash missing"]);
    if (!hasOwn(transaction, "blockHash")) return contradicted(manifest, ["transaction block hash missing"]);
    if (!hasOwn(receipt, "transactionHash")) return contradicted(manifest, ["receipt transaction hash missing"]);
    if (!hasOwn(receipt, "blockHash")) return contradicted(manifest, ["receipt block hash missing"]);
    if (!hasOwn(header, "hash")) return contradicted(manifest, ["header hash missing"]);
    if (hash(transaction.hash, "$.transaction.hash") !== manifest.txHash) return contradicted(manifest, ["transaction hash mismatch"]);
    if (hash(transaction.blockHash, "$.transaction.blockHash") !== manifest.canonicalBlockHash) return contradicted(manifest, ["transaction block hash mismatch"]);
    if (hash(receipt.transactionHash, "$.receipt.transactionHash") !== manifest.txHash) return contradicted(manifest, ["receipt transaction hash mismatch"]);
    if (hash(receipt.blockHash, "$.receipt.blockHash") !== manifest.canonicalBlockHash) return contradicted(manifest, ["receipt block hash mismatch"]);
    if (hash(header.hash, "$.header.hash") !== manifest.canonicalBlockHash) return contradicted(manifest, ["header hash mismatch"]);
    if (!hasOwn(receipt, "status")) return contradicted(manifest, ["receipt status missing"]);
    if (hexQuantity(receipt.status, "$.receipt.status") !== 1n) return contradicted(manifest, ["receipt status is not successful"]);
    if (!hasOwn(receipt, "logs")) return contradicted(manifest, ["receipt logs missing"]);
    if (!Array.isArray(receipt.logs)) fail("unsupported receipt logs schema");
    const calls = successfulCalls(results.trace);
    const facts: FamilySwapFactV1[] = [];
    let priorLogIndex: bigint | null = null;
    let priorMatchedCallIndex = -1;
    for (const raw of receipt.logs) {
      const log = plainObject(raw, "$.receipt.logs[]");
      if (!hasOwn(log, "logIndex")) return contradicted(manifest, ["receipt log order missing"], facts);
      const currentLogIndex = hexQuantity(log.logIndex, "$.receipt.logs[].logIndex");
      if (priorLogIndex !== null && currentLogIndex <= priorLogIndex) {
        return contradicted(manifest, ["receipt log order is not strictly increasing"], facts);
      }
      priorLogIndex = currentLogIndex;
      const fact = decodeSwapLog(raw, calls, priorMatchedCallIndex);
      if (fact !== null) {
        facts.push(fact);
        if (fact.successfulCallIndex !== null) priorMatchedCallIndex = Number(fact.successfulCallIndex);
      }
    }
    const expected = [...request.expectedFamilies];
    if (expected.length === 0 || new Set(expected).size !== expected.length || expected.some((family) => family !== "univ2-standard" && family !== "univ3-standard")) {
      return contradicted(manifest, ["expected family denominator is invalid"], facts);
    }
    const reasons: string[] = [];
    for (const family of expected) {
      const familyFacts = facts.filter((fact) => fact.family === family);
      if (familyFacts.length === 0) reasons.push(`${family} ordered swap log missing`);
      if (familyFacts.some((fact) => fact.successfulCallIndex === null)) reasons.push(`${family} successful call evidence missing`);
    }
    if (reasons.length > 0) return contradicted(manifest, reasons, facts);
    return Object.freeze({
      advisoryOnly: true,
      status: "validated",
      reasons: Object.freeze([]),
      chainId: manifest.chainId,
      canonicalBlockHash: manifest.canonicalBlockHash,
      txHash: manifest.txHash,
      facts: Object.freeze(facts),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return error instanceof HistoricalFactContradiction
      ? contradicted(manifest, [reason])
      : unresolved(manifest, reason);
  }
}
