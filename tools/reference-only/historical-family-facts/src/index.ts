import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
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
import { writeImmutableFile } from "./immutable-file.ts";

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
export type SupportedSelectorCandidateV1 = "univ2-standard" | "univ3-standard";

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
  writeImmutableFile(path, bytes, "immutable content-addressed object changed");
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
