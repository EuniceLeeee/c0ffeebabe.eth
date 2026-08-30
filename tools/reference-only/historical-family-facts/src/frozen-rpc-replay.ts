import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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
import { writeImmutableFile } from "./immutable-file.ts";

export const HISTORICAL_RPC_REPLAY_DESCRIPTOR_KIND =
  "aloha.historical-rpc-read-descriptor" as const;
export const HISTORICAL_RPC_REPLAY_MANIFEST_KIND =
  "aloha.historical-rpc-replay-manifest" as const;

export interface HistoricalRpcSourceCutoffV1 {
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly stateRoot: Hash;
}

export interface HistoricalRpcOwnerBindingV1 {
  readonly ownerId: string;
  readonly implementationClosureRoot: Hash;
}

export type HistoricalRpcCutoffBindingV1 =
  | Readonly<{ kind: "block-number-param"; paramIndex: string }>
  | Readonly<{ kind: "eip1898-block-hash-param"; paramIndex: string }>
  | Readonly<{ kind: "source-invariant"; paramIndex: null }>;

/** A production-exported read identity, not a correctness claim. */
export interface HistoricalRpcReadDescriptorV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HISTORICAL_RPC_REPLAY_DESCRIPTOR_KIND;
  readonly lane: string;
  readonly method: string;
  readonly canonicalParams: readonly CanonicalJson[];
  readonly sourceCutoff: HistoricalRpcSourceCutoffV1;
  readonly cutoffBinding: HistoricalRpcCutoffBindingV1;
  readonly owner: HistoricalRpcOwnerBindingV1;
}

export interface HistoricalRpcReplayCaptureV1 {
  readonly descriptor: HistoricalRpcReadDescriptorV1;
  /** Exact canonical response payload bytes; never a producer verdict. */
  readonly responseBytes: Uint8Array;
}

export interface HistoricalRpcReplayManifestEntryV1 {
  readonly descriptor: HistoricalRpcReadDescriptorV1;
  readonly descriptorKey: Hash;
  readonly responseObjectHash: Hash;
  readonly responseByteLength: string;
}

export interface HistoricalRpcReplayManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HISTORICAL_RPC_REPLAY_MANIFEST_KIND;
  readonly advisoryOnly: true;
  readonly transportFactsOnly: true;
  readonly chainStateQualified: false;
  readonly transportOrigin:
    | "caller-materialized/untrusted-caller-material"
    | "reader-port-observed/untrusted-reader-port";
  readonly fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded";
  readonly sourceCutoff: HistoricalRpcSourceCutoffV1;
  readonly entries: readonly HistoricalRpcReplayManifestEntryV1[];
  readonly descriptorSetRoot: Hash;
  readonly responseObjectClosureRoot: Hash;
  readonly manifestRoot: Hash;
}

export type HistoricalRpcReplayMissReasonV1 =
  | "descriptor-invalid"
  | "mutable-block-tag"
  | "source-cutoff-mismatch"
  | "descriptor-miss";

export interface HistoricalRpcReplayMissV1 {
  readonly sequence: number;
  readonly reason: HistoricalRpcReplayMissReasonV1;
  readonly descriptorKey: Hash | null;
  readonly lane: string | null;
  readonly method: string | null;
}

const STORE_DIRECTORY = "rpc-replay-v1";

class DescriptorError extends TypeError {
  readonly reason: "descriptor-invalid" | "mutable-block-tag";

  constructor(reason: "descriptor-invalid" | "mutable-block-tag", message: string) {
    super(message);
    this.reason = reason;
  }
}

function fail(message: string): never {
  throw new TypeError(message);
}

function descriptorFail(message: string): never {
  throw new DescriptorError("descriptor-invalid", message);
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) descriptorFail(`expected plain object at ${path}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) descriptorFail(`expected text at ${path}`);
  return value;
}

function hash(value: unknown, path: string): Hash {
  const result = text(value, path).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) descriptorFail(`expected hash at ${path}`);
  return result as Hash;
}

function positiveDecimal(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[1-9][0-9]*$/.test(result)) descriptorFail(`expected positive decimal at ${path}`);
  return result;
}

function unsignedDecimal(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) descriptorFail(`expected unsigned decimal at ${path}`);
  return result;
}

function hexQuantity(value: unknown, path: string): string {
  const result = text(value, path).toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(result)) {
    descriptorFail(`expected canonical hex quantity at ${path}`);
  }
  return result;
}

function identifier(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[A-Za-z0-9@/_.:#-]{1,160}$/.test(result)) descriptorFail(`invalid identifier at ${path}`);
  return result;
}

function freezeCanonical(value: CanonicalJson): CanonicalJson {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCanonical));
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeCanonical(item)]),
    ));
  }
  return value;
}

function canonicalClone(value: unknown, path: string): CanonicalJson {
  try {
    return freezeCanonical(decodeCanonicalBytes(encodeCanonicalBytes(value)));
  } catch (error) {
    descriptorFail(`${path} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertFrozenTag(value: CanonicalJson, path: string): void {
  if (
    value === "latest" ||
    value === "pending" ||
    value === "safe" ||
    value === "finalized" ||
    value === "earliest"
  ) {
    throw new DescriptorError("mutable-block-tag", `mutable block tag ${value} at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFrozenTag(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => assertFrozenTag(item, `${path}.${key}`));
  }
}

function decodeCutoffBinding(
  value: unknown,
  method: string,
  params: readonly CanonicalJson[],
  cutoff: HistoricalRpcSourceCutoffV1,
): HistoricalRpcCutoffBindingV1 {
  const path = "$.descriptor.cutoffBinding";
  const object = plainObject(value, path);
  assertExactKeys(object, ["kind", "paramIndex"], path);
  if (object.kind === "source-invariant") {
    if (object.paramIndex !== null) descriptorFail("source-invariant binding must use null paramIndex");
    if (method !== "eth_chainId" && method !== "net_version") {
      descriptorFail(`RPC method ${method} is not source-invariant`);
    }
    if (params.length !== 0) descriptorFail(`${method} must not have parameters`);
    return Object.freeze({ kind: "source-invariant", paramIndex: null });
  }
  if (method !== "eth_call") {
    descriptorFail(`RPC method ${method} has no compiled historical cutoff binding`);
  }
  const indexText = unsignedDecimal(object.paramIndex, `${path}.paramIndex`);
  const index = Number(indexText);
  if (!Number.isSafeInteger(index) || index >= params.length) descriptorFail("cutoff paramIndex is out of range");
  if (params.length !== 2 || index !== 1) {
    descriptorFail("eth_call cutoff must be exact parameter 1 of a two-parameter request");
  }
  if (object.kind === "block-number-param") {
    if (params[index] !== cutoff.blockNumber) descriptorFail("block-number param does not equal source cutoff");
    return Object.freeze({ kind: "block-number-param", paramIndex: indexText });
  }
  if (object.kind === "eip1898-block-hash-param") {
    const selector = plainObject(params[index], `$.descriptor.canonicalParams[${index}]`);
    assertExactKeys(selector, ["blockHash", "requireCanonical"], `$.descriptor.canonicalParams[${index}]`);
    if (
      hash(selector.blockHash, `$.descriptor.canonicalParams[${index}].blockHash`) !== cutoff.blockHash ||
      selector.requireCanonical !== true
    ) descriptorFail("EIP-1898 param does not exactly bind canonical source cutoff");
    return Object.freeze({ kind: "eip1898-block-hash-param", paramIndex: indexText });
  }
  descriptorFail("unsupported cutoff binding kind");
}

function decodeCutoff(value: unknown, path: string): HistoricalRpcSourceCutoffV1 {
  const object = plainObject(value, path);
  assertExactKeys(object, ["chainId", "blockNumber", "blockHash", "stateRoot"], path);
  return Object.freeze({
    chainId: positiveDecimal(object.chainId, `${path}.chainId`),
    blockNumber: hexQuantity(object.blockNumber, `${path}.blockNumber`),
    blockHash: hash(object.blockHash, `${path}.blockHash`),
    stateRoot: hash(object.stateRoot, `${path}.stateRoot`),
  });
}

function decodeOwner(value: unknown, path: string): HistoricalRpcOwnerBindingV1 {
  const object = plainObject(value, path);
  assertExactKeys(object, ["ownerId", "implementationClosureRoot"], path);
  return Object.freeze({
    ownerId: identifier(object.ownerId, `${path}.ownerId`),
    implementationClosureRoot: hash(object.implementationClosureRoot, `${path}.implementationClosureRoot`),
  });
}

export function decodeHistoricalRpcReadDescriptorV1(value: unknown): HistoricalRpcReadDescriptorV1 {
  const object = plainObject(value, "$.descriptor");
  assertExactKeys(
    object,
    [
      "schemaVersion", "kind", "lane", "method", "canonicalParams", "sourceCutoff",
      "cutoffBinding", "owner",
    ],
    "$.descriptor",
  );
  if (object.schemaVersion !== 1 || object.kind !== HISTORICAL_RPC_REPLAY_DESCRIPTOR_KIND) {
    descriptorFail("invalid historical RPC descriptor discriminator");
  }
  const selectedLane = text(object.lane, "$.descriptor.lane");
  if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(selectedLane)) descriptorFail("invalid RPC lane");
  const selectedMethod = text(object.method, "$.descriptor.method");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(selectedMethod)) descriptorFail("invalid RPC method");
  const params = canonicalClone(object.canonicalParams, "$.descriptor.canonicalParams");
  if (!Array.isArray(params)) descriptorFail("canonicalParams must be an array");
  assertFrozenTag(params, "$.descriptor.canonicalParams");
  const sourceCutoff = decodeCutoff(object.sourceCutoff, "$.descriptor.sourceCutoff");
  return Object.freeze({
    schemaVersion: 1,
    kind: HISTORICAL_RPC_REPLAY_DESCRIPTOR_KIND,
    lane: selectedLane,
    method: selectedMethod,
    canonicalParams: params,
    sourceCutoff,
    cutoffBinding: decodeCutoffBinding(object.cutoffBinding, selectedMethod, params, sourceCutoff),
    owner: decodeOwner(object.owner, "$.descriptor.owner"),
  });
}

export function historicalRpcReadDescriptorKeyV1(value: unknown): Hash {
  return hashDomain("aloha/historical-rpc-read-descriptor/v1", decodeHistoricalRpcReadDescriptorV1(value));
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

function exactResponseBytes(value: unknown, path: string): Uint8Array {
  if (!(value instanceof Uint8Array)) fail(`expected response bytes at ${path}`);
  const bytes = Uint8Array.from(value);
  const decoded = decodeCanonicalBytes(bytes);
  if (!Buffer.from(encodeCanonicalBytes(decoded)).equals(Buffer.from(bytes))) {
    fail(`response bytes are not exact canonical JSON at ${path}`);
  }
  return bytes;
}

function computeDescriptorSetRoot(entries: readonly HistoricalRpcReplayManifestEntryV1[]): Hash {
  return hashDomain(
    "aloha/historical-rpc-descriptor-set/v1",
    entries.map((entry) => ({ descriptorKey: entry.descriptorKey, descriptor: entry.descriptor })),
  );
}

function computeResponseClosureRoot(entries: readonly HistoricalRpcReplayManifestEntryV1[]): Hash {
  const unique = new Map<Hash, { responseObjectHash: Hash; responseByteLength: string }>();
  entries.forEach((entry) => unique.set(entry.responseObjectHash, {
    responseObjectHash: entry.responseObjectHash,
    responseByteLength: entry.responseByteLength,
  }));
  return hashDomain(
    "aloha/historical-rpc-response-object-closure/v1",
    [...unique.values()].sort((left, right) => left.responseObjectHash.localeCompare(right.responseObjectHash)),
  );
}

function computeManifestRoot(manifest: Omit<HistoricalRpcReplayManifestV1, "manifestRoot">): Hash {
  return hashDomain("aloha/historical-rpc-replay-manifest/v1", manifest);
}

function buildManifest(
  captures: readonly HistoricalRpcReplayCaptureV1[],
  transportOrigin: HistoricalRpcReplayManifestV1["transportOrigin"],
): Readonly<{
  manifest: HistoricalRpcReplayManifestV1;
  objects: ReadonlyMap<Hash, Uint8Array>;
}> {
  if (!Array.isArray(captures) || captures.length === 0) fail("replay capture set must not be empty");
  const entries = new Map<Hash, HistoricalRpcReplayManifestEntryV1>();
  const objects = new Map<Hash, Uint8Array>();
  let sourceCutoff: HistoricalRpcSourceCutoffV1 | null = null;
  captures.forEach((capture, index) => {
    assertExactKeys(capture, ["descriptor", "responseBytes"], `$.captures[${index}]`);
    const descriptor = decodeHistoricalRpcReadDescriptorV1(capture.descriptor);
    if (sourceCutoff === null) sourceCutoff = descriptor.sourceCutoff;
    if (!canonicalEqual(sourceCutoff, descriptor.sourceCutoff)) fail("capture source cutoff mismatch");
    const bytes = exactResponseBytes(capture.responseBytes, `$.captures[${index}].responseBytes`);
    const descriptorKey = historicalRpcReadDescriptorKeyV1(descriptor);
    const responseObjectHash = sha256Hex(bytes);
    const previous = entries.get(descriptorKey);
    if (previous) {
      if (!canonicalEqual(previous.descriptor, descriptor)) fail("descriptor key collision");
      if (previous.responseObjectHash !== responseObjectHash) {
        fail("duplicate replay descriptor has different response bytes");
      }
      return;
    }
    entries.set(descriptorKey, Object.freeze({
      descriptor,
      descriptorKey,
      responseObjectHash,
      responseByteLength: String(bytes.length),
    }));
    objects.set(responseObjectHash, bytes);
  });
  const orderedEntries = Object.freeze(
    [...entries.values()].sort((left, right) => left.descriptorKey.localeCompare(right.descriptorKey)),
  );
  const base = {
    schemaVersion: 1 as const,
    kind: HISTORICAL_RPC_REPLAY_MANIFEST_KIND,
    advisoryOnly: true as const,
    transportFactsOnly: true as const,
    chainStateQualified: false as const,
    transportOrigin,
    fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded" as const,
    sourceCutoff: sourceCutoff!,
    entries: orderedEntries,
    descriptorSetRoot: computeDescriptorSetRoot(orderedEntries),
    responseObjectClosureRoot: computeResponseClosureRoot(orderedEntries),
  };
  return Object.freeze({
    manifest: Object.freeze({ ...base, manifestRoot: computeManifestRoot(base) }),
    objects,
  });
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`replay path is not a real directory: ${path}`);
}

function writeExclusiveOrVerify(path: string, bytes: Uint8Array): void {
  writeImmutableFile(path, bytes, "immutable replay object changed");
}

export function materializeHistoricalRpcReplayV1(
  rootDirectory: string,
  captures: readonly HistoricalRpcReplayCaptureV1[],
): HistoricalRpcReplayManifestV1 {
  return materializeHistoricalRpcReplay(
    rootDirectory,
    captures,
    "caller-materialized/untrusted-caller-material",
  );
}

function materializeHistoricalRpcReplay(
  rootDirectory: string,
  captures: readonly HistoricalRpcReplayCaptureV1[],
  transportOrigin: HistoricalRpcReplayManifestV1["transportOrigin"],
): HistoricalRpcReplayManifestV1 {
  const built = buildManifest(captures, transportOrigin);
  const root = join(resolve(rootDirectory), STORE_DIRECTORY);
  const objects = join(root, "objects");
  const manifests = join(root, "manifests");
  ensureDirectory(objects);
  ensureDirectory(manifests);
  for (const [objectHash, bytes] of built.objects) {
    writeExclusiveOrVerify(join(objects, objectHash.slice(2)), bytes);
  }
  writeExclusiveOrVerify(
    join(manifests, `${built.manifest.manifestRoot.slice(2)}.json`),
    encodeCanonicalBytes(built.manifest),
  );
  loadFrozenHistoricalRpcReplayV1(rootDirectory, built.manifest.manifestRoot);
  return built.manifest;
}

export async function captureHistoricalRpcReplayV1(
  rootDirectory: string,
  descriptors: readonly HistoricalRpcReadDescriptorV1[],
  reader: Readonly<{ read(descriptor: HistoricalRpcReadDescriptorV1): Promise<Uint8Array> }>,
): Promise<HistoricalRpcReplayManifestV1> {
  const captures: HistoricalRpcReplayCaptureV1[] = [];
  for (const descriptor of descriptors) {
    const decoded = decodeHistoricalRpcReadDescriptorV1(descriptor);
    captures.push(Object.freeze({ descriptor: decoded, responseBytes: await reader.read(decoded) }));
  }
  return materializeHistoricalRpcReplay(
    rootDirectory,
    captures,
    "reader-port-observed/untrusted-reader-port",
  );
}

function decodeManifest(value: unknown): HistoricalRpcReplayManifestV1 {
  const object = plainObject(value, "$.manifest");
  const transportOrigin = object.transportOrigin;
  assertExactKeys(object, [
    "schemaVersion", "kind", "advisoryOnly", "transportFactsOnly", "chainStateQualified",
    "transportOrigin", "fenceClaimLevel", "sourceCutoff", "entries",
    "descriptorSetRoot", "responseObjectClosureRoot", "manifestRoot",
  ], "$.manifest");
  if (
    object.schemaVersion !== 1 ||
    object.kind !== HISTORICAL_RPC_REPLAY_MANIFEST_KIND ||
    object.advisoryOnly !== true ||
    object.transportFactsOnly !== true ||
    object.chainStateQualified !== false ||
    (transportOrigin !== "caller-materialized/untrusted-caller-material"
      && transportOrigin !== "reader-port-observed/untrusted-reader-port") ||
    object.fenceClaimLevel !== "before-after-observation-only-a-b-a-not-excluded"
  ) fail("invalid historical RPC replay manifest discriminator");
  const decodedTransportOrigin = transportOrigin as HistoricalRpcReplayManifestV1["transportOrigin"];
  const sourceCutoff = decodeCutoff(object.sourceCutoff, "$.manifest.sourceCutoff");
  if (!Array.isArray(object.entries) || object.entries.length === 0) fail("replay manifest has no entries");
  const seen = new Set<Hash>();
  const entries = object.entries.map((raw, index): HistoricalRpcReplayManifestEntryV1 => {
    const entry = plainObject(raw, `$.manifest.entries[${index}]`);
    assertExactKeys(
      entry,
      ["descriptor", "descriptorKey", "responseObjectHash", "responseByteLength"],
      `$.manifest.entries[${index}]`,
    );
    const descriptor = decodeHistoricalRpcReadDescriptorV1(entry.descriptor);
    const descriptorKey = hash(entry.descriptorKey, `$.manifest.entries[${index}].descriptorKey`);
    if (descriptorKey !== historicalRpcReadDescriptorKeyV1(descriptor)) fail("replay descriptor key mismatch");
    if (!canonicalEqual(descriptor.sourceCutoff, sourceCutoff)) fail("manifest source cutoff mismatch");
    if (seen.has(descriptorKey)) fail("duplicate replay descriptor key");
    seen.add(descriptorKey);
    return Object.freeze({
      descriptor,
      descriptorKey,
      responseObjectHash: hash(entry.responseObjectHash, `$.manifest.entries[${index}].responseObjectHash`),
      responseByteLength: positiveDecimal(entry.responseByteLength, `$.manifest.entries[${index}].responseByteLength`),
    });
  });
  if (entries.some((entry, index) => index > 0 && entries[index - 1]!.descriptorKey >= entry.descriptorKey)) {
    fail("replay manifest entries are not strictly ordered");
  }
  const descriptorSetRoot = hash(object.descriptorSetRoot, "$.manifest.descriptorSetRoot");
  const responseObjectClosureRoot = hash(
    object.responseObjectClosureRoot,
    "$.manifest.responseObjectClosureRoot",
  );
  if (descriptorSetRoot !== computeDescriptorSetRoot(entries)) fail("descriptor set root mismatch");
  if (responseObjectClosureRoot !== computeResponseClosureRoot(entries)) {
    fail("response object closure root mismatch");
  }
  const base = {
    schemaVersion: 1 as const,
    kind: HISTORICAL_RPC_REPLAY_MANIFEST_KIND,
    advisoryOnly: true as const,
    transportFactsOnly: true as const,
    chainStateQualified: false as const,
    transportOrigin: decodedTransportOrigin,
    fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded" as const,
    sourceCutoff,
    entries: Object.freeze(entries),
    descriptorSetRoot,
    responseObjectClosureRoot,
  };
  const root = hash(object.manifestRoot, "$.manifest.manifestRoot");
  if (root !== computeManifestRoot(base)) fail("replay manifest root mismatch");
  return Object.freeze({ ...base, manifestRoot: root });
}

/** Frozen replay port. It records every miss and has no upstream fallback. */
export interface FrozenHistoricalRpcReplayPortV1 {
  readonly transportOrigin: HistoricalRpcReplayManifestV1["transportOrigin"];
  readonly descriptorSetRoot: Hash;
  readonly responseObjectClosureRoot: Hash;
  readonly manifestRoot: Hash;
  read(value: unknown): Uint8Array;
  stats(): Readonly<{
    requests: number;
    misses: number;
    missedDescriptors: readonly HistoricalRpcReplayMissV1[];
  }>;
}

class LoadedFrozenHistoricalRpcReplayPortV1 implements FrozenHistoricalRpcReplayPortV1 {
  readonly transportOrigin: HistoricalRpcReplayManifestV1["transportOrigin"];
  readonly descriptorSetRoot: Hash;
  readonly responseObjectClosureRoot: Hash;
  readonly manifestRoot: Hash;
  readonly #sourceCutoff: HistoricalRpcSourceCutoffV1;
  readonly #responses: ReadonlyMap<Hash, Uint8Array>;
  readonly #misses: HistoricalRpcReplayMissV1[] = [];
  #requests = 0;

  constructor(manifest: HistoricalRpcReplayManifestV1, responses: ReadonlyMap<Hash, Uint8Array>) {
    this.transportOrigin = manifest.transportOrigin;
    this.descriptorSetRoot = manifest.descriptorSetRoot;
    this.responseObjectClosureRoot = manifest.responseObjectClosureRoot;
    this.manifestRoot = manifest.manifestRoot;
    this.#sourceCutoff = manifest.sourceCutoff;
    this.#responses = responses;
  }

  read(value: unknown): Uint8Array {
    this.#requests += 1;
    let descriptor: HistoricalRpcReadDescriptorV1;
    try {
      descriptor = decodeHistoricalRpcReadDescriptorV1(value);
    } catch (error) {
      const reason = error instanceof DescriptorError ? error.reason : "descriptor-invalid";
      this.#record(reason, null, null, null);
      throw new TypeError(`frozen historical RPC ${reason}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const descriptorKey = historicalRpcReadDescriptorKeyV1(descriptor);
    if (!canonicalEqual(descriptor.sourceCutoff, this.#sourceCutoff)) {
      this.#record("source-cutoff-mismatch", descriptorKey, descriptor.lane, descriptor.method);
      fail("frozen historical RPC source cutoff mismatch");
    }
    const bytes = this.#responses.get(descriptorKey);
    if (!bytes) {
      this.#record("descriptor-miss", descriptorKey, descriptor.lane, descriptor.method);
      fail("frozen historical RPC descriptor miss");
    }
    return Uint8Array.from(bytes);
  }

  stats(): Readonly<{
    requests: number;
    misses: number;
    missedDescriptors: readonly HistoricalRpcReplayMissV1[];
  }> {
    return Object.freeze({
      requests: this.#requests,
      misses: this.#misses.length,
      missedDescriptors: Object.freeze([...this.#misses]),
    });
  }

  #record(
    reason: HistoricalRpcReplayMissReasonV1,
    descriptorKey: Hash | null,
    selectedLane: string | null,
    selectedMethod: string | null,
  ): void {
    this.#misses.push(Object.freeze({
      sequence: this.#misses.length + 1,
      reason,
      descriptorKey,
      lane: selectedLane,
      method: selectedMethod,
    }));
  }
}

export function loadFrozenHistoricalRpcReplayV1(
  rootDirectory: string,
  expectedManifestRoot: Hash,
): FrozenHistoricalRpcReplayPortV1 {
  const expectedRoot = hash(expectedManifestRoot, "$.expectedManifestRoot");
  const root = join(resolve(rootDirectory), STORE_DIRECTORY);
  const manifestPath = join(root, "manifests", `${expectedRoot.slice(2)}.json`);
  if (!existsSync(manifestPath)) fail("historical RPC replay manifest missing");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail("replay manifest is not a regular file");
  const manifestBytes = Uint8Array.from(readFileSync(manifestPath));
  const manifest = decodeManifest(decodeCanonicalBytes(manifestBytes));
  if (!Buffer.from(encodeCanonicalBytes(manifest)).equals(Buffer.from(manifestBytes))) {
    fail("replay manifest bytes are not canonical");
  }
  if (manifest.manifestRoot !== expectedRoot) fail("loaded replay manifest root mismatch");
  const objectDirectory = join(root, "objects");
  if (!existsSync(objectDirectory)) fail("historical RPC replay objects missing");
  const objects = new Map<Hash, Uint8Array>();
  for (const entry of manifest.entries) {
    const path = join(objectDirectory, entry.responseObjectHash.slice(2));
    if (!existsSync(path)) fail("historical RPC replay object closure mismatch");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("replay response object is not a regular file");
    const bytes = Uint8Array.from(readFileSync(path));
    if (String(bytes.length) !== entry.responseByteLength || sha256Hex(bytes) !== entry.responseObjectHash) {
      fail("replay response object bytes changed");
    }
    exactResponseBytes(bytes, "$.storedResponseBytes");
    objects.set(entry.responseObjectHash, bytes);
  }
  const responses = new Map<Hash, Uint8Array>();
  manifest.entries.forEach((entry) => responses.set(entry.descriptorKey, objects.get(entry.responseObjectHash)!));
  return new LoadedFrozenHistoricalRpcReplayPortV1(manifest, responses);
}
