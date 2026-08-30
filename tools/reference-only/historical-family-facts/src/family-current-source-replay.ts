import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExactKeys,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { CurrentSourceRpcReadTransport } from "../../../../packages/current-source-rpc/src/index.ts";
import {
  familySearchSource,
  type FamilySearchCurrentSourceV1,
  type FamilySearchSourceReadPortV1,
  type FamilySearchSourceReadRequestV1,
  type FamilySearchSourceReadResultV1,
} from "../../../../packages/family-sdk/search-runtime/index.ts";
import {
  readGeneratedFamilyRuntimeAdapterFactories,
  readGeneratedFamilyRuntimeFactoryMetadata,
} from "../../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import { createReleaseFamilyRuntimeComposition } from "../../../../generated/runtime-composition/index.ts";
import {
  HISTORICAL_RPC_REPLAY_DESCRIPTOR_KIND,
  captureHistoricalRpcReplayV1,
  historicalRpcReadDescriptorKeyV1,
  loadFrozenHistoricalRpcReplayV1,
  type HistoricalRpcReadDescriptorV1,
  type HistoricalRpcReplayCaptureV1,
} from "./frozen-rpc-replay.ts";
import { writeImmutableFile } from "./immutable-file.ts";

export const FAMILY_CURRENT_SOURCE_REPLAY_MANIFEST_KIND =
  "aloha.family-current-source-replay-manifest-v1" as const;

export interface GeneratedFamilySearchAdapterBindingV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly role: "search/v1";
  readonly modulePath: string;
  readonly exportName: string;
  readonly closureRoot: Hash;
  readonly leafDigest: Hash;
  readonly generatedRuntimePath: string;
  readonly generatedRuntimeSourceHash: Hash;
}

export interface FamilyCurrentSourceLogicalTranscriptEntryV1 {
  readonly sequence: string;
  readonly requestId: Hash;
  readonly source: FamilySearchSourceReadRequestV1["source"];
  readonly target: string;
  readonly data: string;
  readonly responseEncoding: FamilySearchSourceReadRequestV1["responseEncoding"];
  readonly declaredRevertData: FamilySearchSourceReadRequestV1["declaredRevertData"] | null;
  readonly completion: "returned" | "declared-revert-data";
  readonly rpcErrorCode: number | null;
  readonly resultDataEncoding: `abi-${string}` | null;
  readonly descriptorKey: Hash;
  readonly responseObjectHash: Hash;
}

export interface FamilyCurrentSourceReplayManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof FAMILY_CURRENT_SOURCE_REPLAY_MANIFEST_KIND;
  readonly transportFactsOnly: true;
  readonly advisoryOnly: true;
  readonly transportOrigin: "http-json-rpc-eip1898-observed";
  readonly chainStateQualified: false;
  readonly adapterExecutionQualified: false;
  readonly fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded";
  readonly generatedBindingClaim: "branded-generated-runtime-binding-and-file-hash-observation-only";
  readonly stateRootClaimLevel: "source-session-asserted-not-independently-queried";
  readonly canonicalGeneratedBinding: GeneratedFamilySearchAdapterBindingV1;
  readonly canonicalGeneratedBindingRoot: Hash;
  readonly endpointLocatorHash: Hash;
  readonly historicalRpcReplayManifestRoot: Hash;
  readonly logicalTranscript: readonly FamilyCurrentSourceLogicalTranscriptEntryV1[];
  readonly logicalTranscriptRoot: Hash;
  readonly manifestRoot: Hash;
}

type ReadInput = Parameters<FamilySearchSourceReadPortV1["read"]>[0];
const GENERATED_RUNTIME_PATH = fileURLToPath(new URL(
  "../../../../generated/runtime-composition/index.ts",
  import.meta.url,
));
const GENERATED_RUNTIME_LOGICAL_PATH = "generated/runtime-composition/index.ts";
const STORE_DIRECTORY = "family-current-source-replay-v1";

function fail(message: string): never {
  throw new TypeError(message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`${path} must be a plain object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${path} must be non-empty text`);
  return value;
}

function hash(value: unknown, path: string): Hash {
  const result = text(value, path).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) fail(`${path} must be a hash`);
  return result as Hash;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

function loadCanonicalGeneratedFamilySearchAdapterBindingV1(
  familyIdInput: string,
): GeneratedFamilySearchAdapterBindingV1 {
  const bytes = Uint8Array.from(readFileSync(GENERATED_RUNTIME_PATH));
  const familyId = text(familyIdInput, "familyId");
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const families = metadata.families.filter((family) => family.familyId === familyId);
  if (families.length !== 1) fail(`generated Family runtime must contain exactly one ${familyId} entry`);
  const family = families[0]!;
  const matches = readGeneratedFamilyRuntimeAdapterFactories(createReleaseFamilyRuntimeComposition)
    .filter((binding) => binding.familyDefinitionHash === family.familyDefinitionHash
      && binding.descriptor.role === "search/v1");
  if (matches.length !== 1) fail(`generated Family ${familyId} must contain exactly one search/v1 adapter`);
  const adapter = matches[0]!.descriptor;
  return Object.freeze({
    familyId,
    familyDefinitionHash: family.familyDefinitionHash,
    role: "search/v1",
    modulePath: adapter.modulePath,
    exportName: adapter.exportName,
    closureRoot: adapter.closureRoot,
    leafDigest: adapter.leafDigest,
    generatedRuntimePath: GENERATED_RUNTIME_LOGICAL_PATH,
    generatedRuntimeSourceHash: sha256Hex(bytes),
  });
}

/** Branded generated binding plus source hash observation; this is not release qualification. */
export function loadGeneratedFamilySearchAdapterBindingV1(
  familyId: string,
): GeneratedFamilySearchAdapterBindingV1 {
  return loadCanonicalGeneratedFamilySearchAdapterBindingV1(familyId);
}

function assertFreshBinding(binding: GeneratedFamilySearchAdapterBindingV1): void {
  if (binding.generatedRuntimePath !== GENERATED_RUNTIME_LOGICAL_PATH) {
    fail("Family search adapter binding does not name the canonical generated runtime");
  }
  const current = loadCanonicalGeneratedFamilySearchAdapterBindingV1(binding.familyId);
  if (!canonicalEqual(current, binding)) fail("generated Family search adapter binding changed during file observation");
}

function request(value: unknown): FamilySearchSourceReadRequestV1 {
  const selected = object(value, "familyCurrentSource.request");
  const keys = ["kind", "requestId", "source", "target", "data", "responseEncoding"];
  if (Object.hasOwn(selected, "declaredRevertData")) keys.push("declaredRevertData");
  assertExactKeys(selected, keys, "familyCurrentSource.request");
  if (selected.kind !== "family-search.current-source-read") fail("Family current-source request kind mismatch");
  const requestId = hash(selected.requestId, "familyCurrentSource.request.requestId");
  const source = familySearchSource(selected.source, "familyCurrentSource.request.source");
  const target = text(selected.target, "familyCurrentSource.request.target").toLowerCase();
  const data = text(selected.data, "familyCurrentSource.request.data").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(target)) fail("Family current-source target is not an address");
  if (!/^0x(?:[0-9a-f]{2})*$/.test(data)) fail("Family current-source data is not canonical bytes");
  const responseEncoding = text(selected.responseEncoding, "familyCurrentSource.request.responseEncoding");
  if (responseEncoding !== "hex" && !/^abi-[a-z0-9][a-z0-9+._:-]*$/.test(responseEncoding)) {
    fail("Family current-source response encoding is invalid");
  }
  let declaredRevertData: FamilySearchSourceReadRequestV1["declaredRevertData"];
  if (Object.hasOwn(selected, "declaredRevertData")) {
    const declaration = object(selected.declaredRevertData, "familyCurrentSource.request.declaredRevertData");
    assertExactKeys(declaration, ["kind", "dataEncoding", "selector", "byteLength"], "familyCurrentSource.request.declaredRevertData");
    if (declaration.kind !== "declared-revert-data") fail("Family current-source declared revert kind mismatch");
    const dataEncoding = text(declaration.dataEncoding, "familyCurrentSource.request.declaredRevertData.dataEncoding");
    const selector = text(declaration.selector, "familyCurrentSource.request.declaredRevertData.selector").toLowerCase();
    if (!/^abi-[a-z0-9][a-z0-9+._:-]*$/.test(dataEncoding)) fail("Family current-source declared revert encoding is invalid");
    if (!/^0x[0-9a-f]{8}$/.test(selector)) fail("Family current-source declared revert selector is invalid");
    if (!Number.isSafeInteger(declaration.byteLength) || (declaration.byteLength as number) <= 4) fail("Family current-source declared revert byteLength is invalid");
    declaredRevertData = Object.freeze({
      kind: "declared-revert-data",
      dataEncoding: dataEncoding as `abi-${string}`,
      selector: selector as `0x${string}`,
      byteLength: declaration.byteLength as number,
    });
  }
  return Object.freeze({
    kind: "family-search.current-source-read",
    requestId,
    source,
    target,
    data,
    responseEncoding: responseEncoding as FamilySearchSourceReadRequestV1["responseEncoding"],
    ...(declaredRevertData === undefined ? {} : { declaredRevertData }),
  });
}

function normalizedReadInput(value: ReadInput): ReadInput {
  const selected = object(value, "familyCurrentSource.read");
  const keys = ["request"];
  if (Object.hasOwn(selected, "signal")) keys.push("signal");
  if (Object.hasOwn(selected, "deadlineAtMs")) keys.push("deadlineAtMs");
  assertExactKeys(selected, keys, "familyCurrentSource.read");
  if (Object.hasOwn(selected, "signal") && selected.signal === undefined) {
    fail("Family current-source signal must be omitted rather than undefined");
  }
  if (Object.hasOwn(selected, "deadlineAtMs") && !Number.isFinite(selected.deadlineAtMs)) {
    fail("Family current-source capture deadline is invalid");
  }
  return Object.freeze({
    request: request(selected.request),
    ...(Object.hasOwn(selected, "signal") ? { signal: selected.signal as AbortSignal } : {}),
    ...(Object.hasOwn(selected, "deadlineAtMs") ? { deadlineAtMs: selected.deadlineAtMs as number } : {}),
  });
}

function assertLive(input: ReadInput, prefix: string): void {
  if (input.signal?.aborted === true) fail(`${prefix} was aborted`);
  if (input.deadlineAtMs !== undefined && performance.now() >= input.deadlineAtMs) fail(`${prefix} deadline elapsed`);
}

function descriptor(
  binding: GeneratedFamilySearchAdapterBindingV1,
  selected: FamilySearchSourceReadRequestV1,
): HistoricalRpcReadDescriptorV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: HISTORICAL_RPC_REPLAY_DESCRIPTOR_KIND,
    lane: "family-search.current-source",
    method: "eth_call",
    canonicalParams: Object.freeze([
      Object.freeze({ to: selected.target, data: selected.data }),
      Object.freeze({ blockHash: selected.source.hash, requireCanonical: true }),
    ]),
    sourceCutoff: Object.freeze({
      chainId: selected.source.chainId,
      blockNumber: `0x${BigInt(selected.source.number).toString(16)}`,
      blockHash: selected.source.hash,
      stateRoot: selected.source.stateRoot,
    }),
    cutoffBinding: Object.freeze({ kind: "eip1898-block-hash-param", paramIndex: "1" }),
    owner: Object.freeze({
      ownerId: `${binding.familyId}#search/v1:${binding.leafDigest}`,
      implementationClosureRoot: binding.closureRoot,
    }),
  });
}

function transcriptEntry(
  sequence: number,
  selected: FamilySearchSourceReadRequestV1,
  selectedDescriptor: HistoricalRpcReadDescriptorV1,
  result: Extract<FamilySearchSourceReadResultV1, { readonly kind: "returned" | "reverted" }>,
): FamilyCurrentSourceLogicalTranscriptEntryV1 {
  const observation = resultObservation(result);
  return Object.freeze({
    sequence: String(sequence),
    requestId: selected.requestId,
    source: selected.source,
    target: selected.target,
    data: selected.data,
    responseEncoding: selected.responseEncoding,
    declaredRevertData: selected.declaredRevertData ?? null,
    completion: observation.completion,
    rpcErrorCode: observation.rpcErrorCode,
    resultDataEncoding: observation.dataEncoding,
    descriptorKey: historicalRpcReadDescriptorKeyV1(selectedDescriptor),
    responseObjectHash: sha256Hex(encodeCanonicalBytes(observation)),
  });
}

interface FamilyCurrentSourceResultObservationV1 {
  readonly completion: "returned" | "declared-revert-data";
  readonly rpcErrorCode: number | null;
  readonly dataEncoding: `abi-${string}` | null;
  readonly dataHex: string;
}

function resultObservation(
  result: Extract<FamilySearchSourceReadResultV1, { readonly kind: "returned" | "reverted" }>,
): FamilyCurrentSourceResultObservationV1 {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(result.dataHex)) fail("Family current-source result is not canonical raw bytes");
  if (result.kind === "returned") {
    return Object.freeze({ completion: "returned", rpcErrorCode: null, dataEncoding: null, dataHex: result.dataHex });
  }
  if (!Number.isSafeInteger(result.rpcErrorCode)) fail("Family current-source reverted result code is invalid");
  return Object.freeze({
    completion: "declared-revert-data",
    rpcErrorCode: result.rpcErrorCode,
    dataEncoding: result.dataEncoding,
    dataHex: result.dataHex,
  });
}

function decodeResultObservation(value: unknown, path: string): FamilyCurrentSourceResultObservationV1 {
  const selected = object(value, path);
  assertExactKeys(selected, ["completion", "rpcErrorCode", "dataEncoding", "dataHex"], path);
  const dataHex = text(selected.dataHex, `${path}.dataHex`).toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(dataHex)) fail(`${path}.dataHex is not canonical bytes`);
  if (selected.completion === "returned") {
    if (selected.rpcErrorCode !== null || selected.dataEncoding !== null) fail(`${path} returned completion metadata mismatch`);
    return Object.freeze({ completion: "returned", rpcErrorCode: null, dataEncoding: null, dataHex });
  }
  if (selected.completion !== "declared-revert-data" || !Number.isSafeInteger(selected.rpcErrorCode)) fail(`${path} completion mismatch`);
  const dataEncoding = text(selected.dataEncoding, `${path}.dataEncoding`);
  if (!/^abi-[a-z0-9][a-z0-9+._:-]*$/.test(dataEncoding)) fail(`${path}.dataEncoding is invalid`);
  return Object.freeze({
    completion: "declared-revert-data",
    rpcErrorCode: selected.rpcErrorCode as number,
    dataEncoding: dataEncoding as `abi-${string}`,
    dataHex,
  });
}

function bindingRoot(binding: GeneratedFamilySearchAdapterBindingV1): Hash {
  return hashDomain("aloha/family-current-source-generated-binding/v1", binding);
}

function transcriptRoot(transcript: readonly FamilyCurrentSourceLogicalTranscriptEntryV1[]): Hash {
  return hashDomain("aloha/family-current-source-logical-transcript/v1", transcript);
}

function wrapperRoot(manifest: Omit<FamilyCurrentSourceReplayManifestV1, "manifestRoot">): Hash {
  return hashDomain("aloha/family-current-source-replay-manifest/v1", manifest);
}

function endpointLocatorHash(endpoint: string | URL): Hash {
  const locator = endpoint instanceof URL ? endpoint.toString() : new URL(endpoint).toString();
  return hashDomain("aloha/family-current-source-endpoint-locator/v1", locator);
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`Family current-source replay path is not a real directory: ${path}`);
  }
}

function materializeWrapper(
  rootDirectory: string,
  manifest: FamilyCurrentSourceReplayManifestV1,
): void {
  const directory = join(resolve(rootDirectory), STORE_DIRECTORY, "manifests");
  ensureDirectory(directory);
  writeImmutableFile(
    join(directory, `${manifest.manifestRoot.slice(2)}.json`),
    encodeCanonicalBytes(manifest),
    "immutable Family current-source replay manifest changed",
  );
}

function decodeBinding(value: unknown): GeneratedFamilySearchAdapterBindingV1 {
  const selected = object(value, "$.manifest.canonicalGeneratedBinding");
  assertExactKeys(selected, [
    "familyId", "familyDefinitionHash", "role", "modulePath", "exportName", "closureRoot", "leafDigest",
    "generatedRuntimePath", "generatedRuntimeSourceHash",
  ], "$.manifest.canonicalGeneratedBinding");
  if (selected.role !== "search/v1") fail("canonical generated binding role mismatch");
  return Object.freeze({
    familyId: text(selected.familyId, "$.manifest.canonicalGeneratedBinding.familyId"),
    familyDefinitionHash: hash(selected.familyDefinitionHash, "$.manifest.canonicalGeneratedBinding.familyDefinitionHash"),
    role: "search/v1",
    modulePath: text(selected.modulePath, "$.manifest.canonicalGeneratedBinding.modulePath"),
    exportName: text(selected.exportName, "$.manifest.canonicalGeneratedBinding.exportName"),
    closureRoot: hash(selected.closureRoot, "$.manifest.canonicalGeneratedBinding.closureRoot"),
    leafDigest: hash(selected.leafDigest, "$.manifest.canonicalGeneratedBinding.leafDigest"),
    generatedRuntimePath: text(selected.generatedRuntimePath, "$.manifest.canonicalGeneratedBinding.generatedRuntimePath"),
    generatedRuntimeSourceHash: hash(selected.generatedRuntimeSourceHash, "$.manifest.canonicalGeneratedBinding.generatedRuntimeSourceHash"),
  });
}

function decodeTranscriptEntry(value: unknown, index: number): FamilyCurrentSourceLogicalTranscriptEntryV1 {
  const path = `$.manifest.logicalTranscript[${index}]`;
  const selected = object(value, path);
  assertExactKeys(selected, [
    "sequence", "requestId", "source", "target", "data", "responseEncoding", "declaredRevertData",
    "completion", "rpcErrorCode", "resultDataEncoding", "descriptorKey", "responseObjectHash",
  ], path);
  if (selected.sequence !== String(index + 1)) fail("logical transcript sequence mismatch");
  const normalized = request({
    kind: "family-search.current-source-read",
    requestId: selected.requestId,
    source: selected.source,
    target: selected.target,
    data: selected.data,
    responseEncoding: selected.responseEncoding,
    ...(selected.declaredRevertData === null ? {} : { declaredRevertData: selected.declaredRevertData }),
  });
  const completion = selected.completion;
  const rpcErrorCode = selected.rpcErrorCode;
  const resultDataEncoding = selected.resultDataEncoding;
  if (completion === "returned") {
    if (rpcErrorCode !== null || resultDataEncoding !== null) fail("logical transcript returned completion metadata mismatch");
  } else {
    if (completion !== "declared-revert-data" || !Number.isSafeInteger(rpcErrorCode)) fail("logical transcript completion mismatch");
    if (normalized.declaredRevertData === undefined
      || resultDataEncoding !== normalized.declaredRevertData.dataEncoding) fail("logical transcript declared revert binding mismatch");
  }
  return Object.freeze({
    sequence: String(index + 1),
    requestId: normalized.requestId,
    source: normalized.source,
    target: normalized.target,
    data: normalized.data,
    responseEncoding: normalized.responseEncoding,
    declaredRevertData: normalized.declaredRevertData ?? null,
    completion,
    rpcErrorCode: rpcErrorCode as number | null,
    resultDataEncoding: resultDataEncoding as `abi-${string}` | null,
    descriptorKey: hash(selected.descriptorKey, `${path}.descriptorKey`),
    responseObjectHash: hash(selected.responseObjectHash, `${path}.responseObjectHash`),
  });
}

function loadWrapper(rootDirectory: string, expectedManifestRoot: Hash): FamilyCurrentSourceReplayManifestV1 {
  const expected = hash(expectedManifestRoot, "expectedManifestRoot");
  const path = join(resolve(rootDirectory), STORE_DIRECTORY, "manifests", `${expected.slice(2)}.json`);
  if (!existsSync(path)) fail("Family current-source replay manifest missing");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Family current-source replay manifest is not a regular file");
  const bytes = Uint8Array.from(readFileSync(path));
  const decodedBytes = decodeCanonicalBytes(bytes);
  const selected = object(decodedBytes, "$.manifest");
  assertExactKeys(selected, [
    "schemaVersion", "kind", "advisoryOnly", "transportFactsOnly", "transportOrigin", "chainStateQualified", "adapterExecutionQualified",
    "fenceClaimLevel",
    "generatedBindingClaim", "stateRootClaimLevel", "canonicalGeneratedBinding",
    "canonicalGeneratedBindingRoot", "endpointLocatorHash", "historicalRpcReplayManifestRoot",
    "logicalTranscript", "logicalTranscriptRoot", "manifestRoot",
  ], "$.manifest");
  if (
    selected.schemaVersion !== 1 ||
    selected.kind !== FAMILY_CURRENT_SOURCE_REPLAY_MANIFEST_KIND ||
    selected.advisoryOnly !== true ||
    selected.transportFactsOnly !== true ||
    selected.transportOrigin !== "http-json-rpc-eip1898-observed" ||
    selected.chainStateQualified !== false ||
    selected.adapterExecutionQualified !== false ||
    selected.fenceClaimLevel !== "before-after-observation-only-a-b-a-not-excluded" ||
    selected.generatedBindingClaim !== "branded-generated-runtime-binding-and-file-hash-observation-only" ||
    selected.stateRootClaimLevel !== "source-session-asserted-not-independently-queried"
  ) fail("invalid Family current-source replay manifest discriminator");
  const canonicalGeneratedBinding = decodeBinding(selected.canonicalGeneratedBinding);
  const canonicalGeneratedBindingRoot = hash(selected.canonicalGeneratedBindingRoot, "$.manifest.canonicalGeneratedBindingRoot");
  if (canonicalGeneratedBindingRoot !== bindingRoot(canonicalGeneratedBinding)) {
    fail("canonical generated binding root mismatch");
  }
  if (!Array.isArray(selected.logicalTranscript) || selected.logicalTranscript.length === 0) {
    fail("Family current-source logical transcript must not be empty");
  }
  const logicalTranscript = Object.freeze(selected.logicalTranscript.map(decodeTranscriptEntry));
  const logicalTranscriptRoot = hash(selected.logicalTranscriptRoot, "$.manifest.logicalTranscriptRoot");
  if (logicalTranscriptRoot !== transcriptRoot(logicalTranscript)) fail("logical transcript root mismatch");
  for (const entry of logicalTranscript) {
    const selectedDescriptor = descriptor(canonicalGeneratedBinding, {
      kind: "family-search.current-source-read",
      requestId: entry.requestId,
      source: entry.source,
      target: entry.target,
      data: entry.data,
      responseEncoding: entry.responseEncoding,
      ...(entry.declaredRevertData === null ? {} : { declaredRevertData: entry.declaredRevertData }),
    });
    if (entry.descriptorKey !== historicalRpcReadDescriptorKeyV1(selectedDescriptor)) {
      fail("logical transcript descriptor key mismatch");
    }
  }
  const base = {
    schemaVersion: 1 as const,
    kind: FAMILY_CURRENT_SOURCE_REPLAY_MANIFEST_KIND,
    advisoryOnly: true as const,
    transportFactsOnly: true as const,
    transportOrigin: "http-json-rpc-eip1898-observed" as const,
    chainStateQualified: false as const,
    adapterExecutionQualified: false as const,
    fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded" as const,
    generatedBindingClaim: "branded-generated-runtime-binding-and-file-hash-observation-only" as const,
    stateRootClaimLevel: "source-session-asserted-not-independently-queried" as const,
    canonicalGeneratedBinding,
    canonicalGeneratedBindingRoot,
    endpointLocatorHash: hash(selected.endpointLocatorHash, "$.manifest.endpointLocatorHash"),
    historicalRpcReplayManifestRoot: hash(selected.historicalRpcReplayManifestRoot, "$.manifest.historicalRpcReplayManifestRoot"),
    logicalTranscript,
    logicalTranscriptRoot,
  };
  const manifestRoot = hash(selected.manifestRoot, "$.manifest.manifestRoot");
  if (manifestRoot !== wrapperRoot(base)) fail("Family current-source replay manifest root mismatch");
  if (manifestRoot !== expected) fail("Family current-source replay manifest does not match the requested root");
  const manifest = Object.freeze({ ...base, manifestRoot });
  if (!canonicalEqual(manifest, decodedBytes)) fail("Family current-source replay manifest bytes are not canonical");
  return manifest;
}

export interface FamilyCurrentSourceCaptureV1 {
  /** Real HTTP JSON-RPC transport capture only; it does not execute or qualify an Adapter. */
  readonly readPort: FamilySearchSourceReadPortV1;
  readonly binding: GeneratedFamilySearchAdapterBindingV1;
  seal(): Promise<FamilyCurrentSourceReplayManifestV1>;
}

export function createFamilyCurrentSourceCaptureV1(input: Readonly<{
  rootDirectory: string;
  familyId: string;
  endpoint: string | URL;
  currentSource: FamilySearchCurrentSourceV1;
  timeoutMs?: number;
  headers?: Readonly<Record<string, string>>;
}>): FamilyCurrentSourceCaptureV1 {
  const optionKeys = ["rootDirectory", "familyId", "endpoint", "currentSource"];
  if (Object.hasOwn(input, "timeoutMs")) optionKeys.push("timeoutMs");
  if (Object.hasOwn(input, "headers")) optionKeys.push("headers");
  assertExactKeys(input, optionKeys, "familyCurrentSource.captureOptions");
  const binding = loadCanonicalGeneratedFamilySearchAdapterBindingV1(input.familyId);
  const transport = new CurrentSourceRpcReadTransport({
    endpoint: input.endpoint,
    currentSource: input.currentSource,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  });
  const captures: HistoricalRpcReplayCaptureV1[] = [];
  const transcript: FamilyCurrentSourceLogicalTranscriptEntryV1[] = [];
  let failure: string | null = null;
  let active = 0;
  let nextSequence = 1;
  let sealed = false;
  const poison = (reason: string): void => { failure ??= reason; };
  const readPort: FamilySearchSourceReadPortV1 = Object.freeze({
    async read(readInputValue: ReadInput): Promise<FamilySearchSourceReadResultV1> {
      if (sealed) fail("Family current-source capture is already sealed");
      const sequence = nextSequence++;
      active += 1;
      try {
        const readInput = normalizedReadInput(readInputValue);
        assertLive(readInput, "Family current-source capture");
        let raw: FamilySearchSourceReadResultV1;
        try {
          // Pass normalized frozen facts, never the caller's mutable request.
          raw = await transport.read(readInput);
        } catch (error) {
          poison("transport-error");
          throw error;
        }
        // Re-fence this logical consumer after the awaited HTTP lifecycle and
        // before any bytes become sealable.
        assertLive(readInput, "Family current-source capture");
        if (raw.kind === "unavailable") {
          poison(`unavailable:${raw.reasonCode}`);
          return raw;
        }
        const exact = readInput.request;
        if (raw.requestId !== exact.requestId || !canonicalEqual(raw.source, exact.source)) {
          poison("transport-identity-mismatch");
          fail("Family current-source transport returned mismatched request identity");
        }
        const observation = resultObservation(raw);
        if (raw.kind === "reverted" && (exact.declaredRevertData === undefined
          || raw.reasonCode !== "declared-revert-data"
          || raw.dataEncoding !== exact.declaredRevertData.dataEncoding)) {
          poison("declared-revert-binding-mismatch");
          fail("Family current-source declared revert result does not bind its request");
        }
        const selectedDescriptor = descriptor(binding, exact);
        captures[sequence - 1] = Object.freeze({
          descriptor: selectedDescriptor,
          responseBytes: encodeCanonicalBytes(observation),
        });
        transcript[sequence - 1] = transcriptEntry(sequence, exact, selectedDescriptor, raw);
        return Object.freeze({ ...raw, source: exact.source });
      } catch (error) {
        poison("read-error");
        throw error;
      } finally {
        active -= 1;
      }
    },
  });
  return Object.freeze({
    readPort,
    binding,
    async seal(): Promise<FamilyCurrentSourceReplayManifestV1> {
      if (sealed) fail("Family current-source capture is already sealed");
      if (active !== 0) fail("Family current-source capture has active reads");
      if (failure !== null) fail(`Family current-source capture is not sealable: ${failure}`);
      if (
        captures.length === 0 ||
        captures.length !== nextSequence - 1 ||
        transcript.length !== nextSequence - 1 ||
        captures.some((value) => value === undefined) ||
        transcript.some((value) => value === undefined)
      ) fail("Family current-source capture transcript is incomplete");
      // Fresh file observation at seal time limits, but does not eliminate,
      // A->B->A TOCTOU and does not prove that a generated runner was invoked.
      assertFreshBinding(binding);
      const byDescriptor = new Map(captures.map(capture => [
        historicalRpcReadDescriptorKeyV1(capture.descriptor),
        capture.responseBytes,
      ]));
      const historical = await captureHistoricalRpcReplayV1(
        input.rootDirectory,
        captures.map(capture => capture.descriptor),
        Object.freeze({
          async read(selectedDescriptor: HistoricalRpcReadDescriptorV1): Promise<Uint8Array> {
            const bytes = byDescriptor.get(historicalRpcReadDescriptorKeyV1(selectedDescriptor));
            if (bytes === undefined) fail("Family current-source captured reader descriptor is missing");
            return Uint8Array.from(bytes);
          },
        }),
      );
      if (historical.transportOrigin !== "reader-port-observed/untrusted-reader-port") {
        fail("Family current-source historical transport origin mismatch");
      }
      const base = {
        schemaVersion: 1 as const,
        kind: FAMILY_CURRENT_SOURCE_REPLAY_MANIFEST_KIND,
        advisoryOnly: true as const,
        transportFactsOnly: true as const,
        transportOrigin: "http-json-rpc-eip1898-observed" as const,
        chainStateQualified: false as const,
        adapterExecutionQualified: false as const,
        fenceClaimLevel: "before-after-observation-only-a-b-a-not-excluded" as const,
        generatedBindingClaim: "branded-generated-runtime-binding-and-file-hash-observation-only" as const,
        stateRootClaimLevel: "source-session-asserted-not-independently-queried" as const,
        canonicalGeneratedBinding: binding,
        canonicalGeneratedBindingRoot: bindingRoot(binding),
        endpointLocatorHash: endpointLocatorHash(input.endpoint),
        historicalRpcReplayManifestRoot: historical.manifestRoot,
        logicalTranscript: Object.freeze([...transcript]),
        logicalTranscriptRoot: transcriptRoot(transcript),
      };
      const manifest = Object.freeze({ ...base, manifestRoot: wrapperRoot(base) });
      materializeWrapper(input.rootDirectory, manifest);
      loadWrapper(input.rootDirectory, manifest.manifestRoot);
      sealed = true;
      return manifest;
    },
  });
}

export interface FrozenFamilyCurrentSourceReplayV1 {
  /** Frozen transport only; exact transcript consumption is not an Adapter verdict. */
  readonly readPort: FamilySearchSourceReadPortV1;
  readonly binding: GeneratedFamilySearchAdapterBindingV1;
  assertExactTranscriptConsumed(): void;
  stats(): Readonly<{ requests: number; consumed: number; expected: number; violations: number; misses: number }>;
}

export function createFrozenFamilyCurrentSourceReplayV1(input: Readonly<{
  rootDirectory: string;
  manifestRoot: Hash;
}>): FrozenFamilyCurrentSourceReplayV1 {
  assertExactKeys(input, ["rootDirectory", "manifestRoot"], "familyCurrentSource.replayOptions");
  const manifest = loadWrapper(input.rootDirectory, input.manifestRoot);
  assertFreshBinding(manifest.canonicalGeneratedBinding);
  const replay = loadFrozenHistoricalRpcReplayV1(
    input.rootDirectory,
    manifest.historicalRpcReplayManifestRoot,
  );
  if (replay.transportOrigin !== "reader-port-observed/untrusted-reader-port") {
    fail("frozen Family current-source historical transport origin mismatch");
  }
  let requests = 0;
  let cursor = 0;
  let violations = 0;
  const readPort: FamilySearchSourceReadPortV1 = Object.freeze({
    read(readInputValue: ReadInput): FamilySearchSourceReadResultV1 {
      requests += 1;
      let completed = false;
      try {
        const readInput = normalizedReadInput(readInputValue);
        assertLive(readInput, "frozen Family current-source replay");
        const selected = readInput.request;
        const expected = manifest.logicalTranscript[cursor];
        if (expected === undefined) {
          fail("frozen Family current-source replay received an extra transcript request");
        }
        const actualLogical = {
          requestId: selected.requestId,
          source: selected.source,
          target: selected.target,
          data: selected.data,
          responseEncoding: selected.responseEncoding,
          declaredRevertData: selected.declaredRevertData ?? null,
        };
        const expectedLogical = {
          requestId: expected.requestId,
          source: expected.source,
          target: expected.target,
          data: expected.data,
          responseEncoding: expected.responseEncoding,
          declaredRevertData: expected.declaredRevertData,
        };
        if (!canonicalEqual(actualLogical, expectedLogical)) {
          fail(`frozen Family current-source replay transcript mismatch at sequence ${expected.sequence}`);
        }
        const selectedDescriptor = descriptor(manifest.canonicalGeneratedBinding, selected);
        if (historicalRpcReadDescriptorKeyV1(selectedDescriptor) !== expected.descriptorKey) {
          fail(`frozen Family current-source replay descriptor mismatch at sequence ${expected.sequence}`);
        }
        const decoded = decodeResultObservation(
          decodeCanonicalBytes(replay.read(selectedDescriptor)),
          "frozenFamilyCurrentSource.result",
        );
        if (sha256Hex(encodeCanonicalBytes(decoded)) !== expected.responseObjectHash) {
          fail(`frozen Family current-source replay response mismatch at sequence ${expected.sequence}`);
        }
        if (decoded.completion !== expected.completion
          || decoded.rpcErrorCode !== expected.rpcErrorCode
          || decoded.dataEncoding !== expected.resultDataEncoding) {
          fail(`frozen Family current-source replay completion mismatch at sequence ${expected.sequence}`);
        }
        cursor += 1;
        completed = true;
        if (decoded.completion === "returned") {
          return Object.freeze({ kind: "returned", requestId: selected.requestId, source: selected.source, dataHex: decoded.dataHex });
        }
        if (selected.declaredRevertData === undefined
          || selected.declaredRevertData.dataEncoding !== decoded.dataEncoding
          || decoded.rpcErrorCode === null
          || decoded.dataEncoding === null) {
          fail(`frozen Family current-source replay declared revert mismatch at sequence ${expected.sequence}`);
        }
        return Object.freeze({
          kind: "reverted",
          reasonCode: "declared-revert-data",
          requestId: selected.requestId,
          source: selected.source,
          rpcErrorCode: decoded.rpcErrorCode,
          dataEncoding: decoded.dataEncoding,
          dataHex: decoded.dataHex,
        });
      } finally {
        if (!completed) violations += 1;
      }
    },
  });
  return Object.freeze({
    readPort,
    binding: manifest.canonicalGeneratedBinding,
    assertExactTranscriptConsumed(): void {
      // Completion is another fresh file observation, still not a runner proof.
      assertFreshBinding(manifest.canonicalGeneratedBinding);
      const stats = replay.stats();
      if (
        violations !== 0 ||
        stats.misses !== 0 ||
        requests !== manifest.logicalTranscript.length ||
        cursor !== manifest.logicalTranscript.length
      ) {
        fail("frozen Family current-source replay did not consume the exact transcript");
      }
    },
    stats(): Readonly<{ requests: number; consumed: number; expected: number; violations: number; misses: number }> {
      return Object.freeze({
        requests,
        consumed: cursor,
        expected: manifest.logicalTranscript.length,
        violations,
        misses: replay.stats().misses,
      });
    },
  });
}
