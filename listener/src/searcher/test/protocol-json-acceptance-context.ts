import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { loadBotVmRuntimeCode } from "../../shared/executor/botvm-executor.js";
import type { AdapterWorkControl } from "../adapter-work-intent.js";
import { acceptanceFamilyDomain, type AcceptanceFamilyDomain } from "./protocol-json-acceptance-facts.js";
import type { PreparedFamilyInstance } from "../venues/adapter-family-runtime.js";
import { createNodeSimulateV1Rpc, nodeSimulateV1Environment, type NodeSimulateV1Header } from "../simulator/node-simulate-v1.js";
import type { PinnedNodeRpc } from "../simulator/node-input-funding.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytes32 = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const quantity = (value: unknown): bigint => {
  assert(typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value), "invalid RPC quantity");
  return BigInt(value);
};

/** Attest the exact production entry selected by the catalog. A JSON file beside a legacy entry is insufficient. */
export async function inspectAcceptanceEntry(family: { sourceFile: string; definitionBoundaryHash: string;
  plugin: { manifest: { familyId: string } } }) {
  const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } = await import("../venues/production-family-composition.js");
  const installed = catalog.listAll().find(item => item.plugin === family.plugin);
  if (!installed) return { kind: "not-installed", sourceFile: family.sourceFile } as const;
  assert.equal(family.sourceFile, installed.sourceFile);
  assert.equal(family.definitionBoundaryHash, installed.definitionBoundaryHash);
  assert(/^[a-z0-9-]+\.production\.ts$/.test(installed.sourceFile));
  const root = resolve(ROOT, "listener");
  const file = resolve(root, "src/searcher/venues/production-families", installed.sourceFile);
  const source = readFileSync(file, "utf8");
  const provenance = { sourceFile: installed.sourceFile, entrySha256: hash(source), definitionBoundaryHash: installed.definitionBoundaryHash };
  if (!source.startsWith("// Generated from Family JSON by build-declarative-production.ts.")) return { kind: "handwritten", ...provenance } as const;
  const ref = /^\/\/ Definition: (src\/searcher\/venues\/[a-z0-9/-]+\.json)$/m.exec(source);
  assert(ref, "generated entry missing its definition");
  const definitionFile = resolve(root, ref[1]), bytes = readFileSync(definitionFile);
  const document = JSON.parse(bytes.toString());
  const { renderDeclarativeProductionEntry } = await import("../build-declarative-production.js");
  const rendered = renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, entryFile: file, document });
  assert.equal(rendered.familyId, family.plugin.manifest.familyId);
  assert.equal(rendered.source, source, "installed entry differs from the production generator");
  if (rendered.format === "bindings-v1") return { kind: "json-bindings", ...provenance } as const;
  const variants = [document.standard, ...rendered.childFiles.map(f => JSON.parse(readFileSync(f,"utf8")))];
  return { kind: "declarative-json", ...provenance, definitionFile: ref[1], definitionSha256: hash(bytes),
    variants: variants.map(({ id, lineageId }) => ({ id, lineageId })), childDefinitions: rendered.childFiles.map(f =>
      ({ file: relative(root,f), sha256: hash(readFileSync(f)) })) } as const;
}

export interface ProtocolJsonAcceptanceContextInput {
  readonly readyPath: string;
  readonly rpcFile: string;
  readonly revmBin?: string; // Accepted legacy CLI option; never executed.
  readonly allowExecutorCodeOverride?: boolean;
  readonly familyId: string;
  readonly domain?: AcceptanceFamilyDomain;
  readonly instanceKey: string;
  readonly source: { readonly number: number; readonly hash: string };
  readonly chainId?: number;
  readonly executor: string;
  readonly owner: string;
  readonly transactionHash?: string;
  readonly inputPaths?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxRpcRequests?: number;
  readonly simulationMethod?: "debug_traceCall" | "eth_simulateV1";
}

export interface FamilyAcceptanceRuntimeContextInput extends Omit<ProtocolJsonAcceptanceContextInput, "domain"> {
  readonly domain?: AcceptanceFamilyDomain | "funding";
}

function validateRuntimeContextInput(input: FamilyAcceptanceRuntimeContextInput): void {
  assert(input && typeof input === "object", "acceptance context input required");
  for (const path of [input.readyPath, input.rpcFile, ...(input.inputPaths ?? [])])
    assert(typeof path === "string" && isAbsolute(path), "acceptance input paths must be absolute");
  assert(input.allowExecutorCodeOverride === undefined || typeof input.allowExecutorCodeOverride === "boolean", "invalid executor code mode");
  assert(typeof input.familyId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(input.familyId), "invalid family id");
  assert(["protocol", "swap", "credit", "funding"].includes(input.domain ?? "protocol"), "invalid family domain");
  assert(input.simulationMethod === undefined || ["debug_traceCall", "eth_simulateV1"].includes(input.simulationMethod), "invalid simulation method");
  assert(typeof input.instanceKey === "string" && input.instanceKey.trim() === input.instanceKey && input.instanceKey.length > 0, "instance required");
  assert(input.source && Number.isSafeInteger(input.source.number) && input.source.number >= 0 && bytes32(input.source.hash), "invalid source anchor");
  assert(Number.isSafeInteger(input.chainId ?? 1) && (input.chainId ?? 1) > 0, "invalid chain id");
  assert(!same(ethers.getAddress(input.executor), ethers.getAddress(input.owner)), "executor and origin must differ");
  assert(input.transactionHash === undefined || bytes32(input.transactionHash), "invalid transaction hash");
  for (const n of [input.timeoutMs ?? 480_000, input.maxRpcRequests ?? 600]) assert(Number.isSafeInteger(n) && n > 0, "invalid acceptance limit");
}

export function validateAcceptanceContextInput(input: ProtocolJsonAcceptanceContextInput): void {
  validateRuntimeContextInput(input);
  acceptanceFamilyDomain(input.familyId, input.domain);
}

export function assertAcceptanceHeader(header: any, expected: { readonly number: number; readonly hash: string }): void {
  assert(header && quantity(header.number) === BigInt(expected.number) && bytes32(header.hash) && same(header.hash, expected.hash), "historical source header mismatch");
  assert(bytes32(header.stateRoot) && bytes32(header.mixHash), "historical header lacks state root/randomness");
  for (const key of ["timestamp", "gasLimit", "baseFeePerGas"]) quantity(header[key]);
  ethers.getAddress(header.miner);
}

export function assertAcceptanceReceipt(receipt: any, transactionHash: string, source: { readonly number: number; readonly hash: string }): void {
  assert(bytes32(transactionHash) && receipt && bytes32(receipt.transactionHash) && same(receipt.transactionHash, transactionHash), "historical receipt transaction mismatch");
  assert(quantity(receipt.blockNumber) === BigInt(source.number) && bytes32(receipt.blockHash) && same(receipt.blockHash, source.hash), "historical receipt source mismatch");
  assert(quantity(receipt.status) === 1n && Array.isArray(receipt.logs), "historical sample receipt must be successful");
}

/** No state overrides or mutating RPC methods can enter this context's provider.
 * Node simulation owns its bounded RPC transport; these limits count direct reads only. */
export function assertAcceptanceReadOnlyRpc(method: string, params: readonly unknown[], source: { readonly number: number; readonly hash: string }): void {
  assert(Array.isArray(params), "RPC parameters must be an array");
  if (method === "eth_chainId") { assert.equal(params.length, 0); return; }
  if (method === "eth_getBlockByNumber") {
    assert.equal(params.length, 2); assert.equal(params[1], false);
    assert(quantity(params[0]) <= BigInt(source.number), "header read exceeds source"); return;
  }
  if (method === "eth_getTransactionReceipt") { assert.equal(params.length, 1); assert(bytes32(params[0])); return; }
  assert(["eth_call", "eth_getCode", "eth_getStorageAt"].includes(method), "RPC method is not read-only acceptance transport");
  assert.equal(params.length, method === "eth_getStorageAt" ? 3 : 2, "RPC state overrides are forbidden");
  const pin = params.at(-1) as any;
  assert(pin && typeof pin === "object" && Object.keys(pin).length === 2 && pin.requireCanonical === true && bytes32(pin.blockHash) && same(pin.blockHash, source.hash), "RPC source pin mismatch");
  if (method === "eth_call") {
    const tx = params[0] as any;
    assert(tx && typeof tx === "object" && Object.keys(tx).every(key => ["to", "from", "data", "value", "gas"].includes(key)), "invalid read call");
    ethers.getAddress(tx.to); assert(ethers.isHexString(tx.data, true), "invalid read calldata");
    if (tx.from !== undefined) ethers.getAddress(tx.from);
    for (const key of ["value", "gas"]) if (tx[key] !== undefined) quantity(tx[key]);
  } else {
    ethers.getAddress(String(params[0]));
    if (method === "eth_getStorageAt") assert(ethers.isHexString(params[1], 32) || typeof params[1] === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(params[1]), "invalid storage slot");
  }
}

export function createAcceptanceReadOnlyRpc(input: {
  readonly url: string; readonly source: { readonly number: number; readonly hash: string };
  readonly control: { readonly signal: AbortSignal; readonly deadlineAtMs: number }; readonly maxRequests: number;
  readonly fetch?: typeof fetch;
  /** Trusted transport adapter, applied only after the original read-call validator. */
  readonly mapCall?: (send: PinnedNodeRpc, params: readonly unknown[]) => Promise<unknown>;
}) {
  const url = input.url, source = Object.freeze({ ...input.source }), control = Object.freeze({ ...input.control });
  const maxRequests = input.maxRequests, send = input.fetch ?? fetch, mapCall = input.mapCall;
  const endpoint = new URL(url); assert(["http:", "https:"].includes(endpoint.protocol) && !endpoint.hash, "invalid RPC endpoint");
  assert(Number.isSafeInteger(maxRequests) && maxRequests > 0, "invalid RPC budget");
  const redact = (value: unknown) => String(value).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]").split(url).join("[REDACTED]");
  let reads = 0;
  const failures: { method: string; message: string; code?: number }[] = [];
  const sendRequest = async (method: string, params: readonly unknown[], extra?: AdapterWorkControl): Promise<any> => {
    control.signal.throwIfAborted(); extra?.signal?.throwIfAborted();
    const remaining = Math.min(control.deadlineAtMs, extra?.deadlineAtMs ?? Infinity) - Date.now();
    assert(remaining > 0, "historical read deadline expired"); assert(reads < maxRequests, "historical direct-read budget exceeded");
    const id = ++reads;
    try {
      const response = await send(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.any([control.signal, ...(extra?.signal ? [extra.signal] : []), AbortSignal.timeout(Math.min(25_000, remaining))]) });
      assert(response.ok, `historical RPC HTTP ${response.status}`);
      const body: any = await response.json();
      assert(body && body.id === id && body.jsonrpc === "2.0", "historical RPC response identity mismatch");
      if (Object.hasOwn(body, "error")) {
        assert(!Object.hasOwn(body, "result") && body.error && Number.isSafeInteger(body.error.code), "invalid RPC error envelope");
        const error = { code: body.error.code, message: redact(body.error.message ?? "historical RPC request failed"),
          ...(ethers.isHexString(body.error.data, true) ? { data: body.error.data } : {}) };
        // Match the existing provider envelope; central code owns revert vs
        // quota/transport classification, including empty revert payloads.
        throw Object.assign(new Error(error.message), { code: method === "eth_call" ? "CALL_EXCEPTION" : error.code,
          ...(error.data === undefined ? {} : { data: error.data }), info: { error, payload: { method } } });
      }
      assert(Object.hasOwn(body, "result"), "historical RPC response has no result");
      control.signal.throwIfAborted(); extra?.signal?.throwIfAborted();
      return body.result;
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : error);
      failures.push({ method, message, ...(typeof (error as any)?.code === "number" ? { code: (error as any).code } : {}) });
      if (error instanceof Error && (error as any).code === "CALL_EXCEPTION") throw error;
      throw Object.assign(new Error(message), { code: (error as any)?.code });
    }
  };
  const request = async (method: string, params: readonly unknown[], extra?: AdapterWorkControl): Promise<any> => {
    assertAcceptanceReadOnlyRpc(method, params, source);
    if (method !== "eth_call" || !mapCall) return sendRequest(method, params, extra);
    const failureCount = failures.length;
    try { return await mapCall((name, values) => sendRequest(name, values, extra), params); }
    catch (error) {
      if (failures.length === failureCount) failures.push({ method,
        message: redact(error instanceof Error ? error.message : error),
        ...(typeof (error as any)?.code === "number" ? { code: (error as any).code } : {}) });
      if ((error as any)?.code === 3 && ethers.isHexString((error as any)?.data, true)) {
        throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: (error as any).data,
          info: { error: { code: 3, message: "execution reverted", data: (error as any).data }, payload: { method: "eth_call" } } });
      }
      throw error;
    }
  };
  return { request, counters: () => ({ directRpcReads: reads, failures: failures.map(failure => ({ ...failure })), nodeSimulationRpcReads: "not counted by direct provider" as const }) };
}

export function acceptanceSourceFingerprint(root: string): string {
  const files: [string, string][] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(resolve(root, "listener/src", path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "test" || entry.name === "templates") continue;
      const item = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(item);
      else { assert(entry.isFile(), "source symlink unsupported"); files.push([item, hash(readFileSync(resolve(root, "listener/src", item)))]); }
    }
  };
  visit(""); return hash(JSON.stringify(files));
}

export function verifyAcceptanceBotVmArtifact(root: string, artifactBytes: Buffer): readonly { path: string; sha256: string }[] {
  const artifact = JSON.parse(artifactBytes.toString());
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert.equal(metadata?.settings?.compilationTarget?.["src/BotVM.sol"], "BotVM");
  assert(metadata.sources && Object.keys(metadata.sources).length > 0, "executor source metadata absent");
  const canonicalRoot = realpathSync(root);
  return Object.entries(metadata.sources).map(([name, entry]) => {
    const path = realpathSync(resolve(root, name)), rel = relative(canonicalRoot, path);
    assert(name.endsWith(".sol") && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel), "executor source outside repository");
    const bytes = readFileSync(path); assert.equal(ethers.keccak256(bytes), (entry as any).keccak256, "stale executor source");
    return { path, sha256: hash(bytes) };
  });
}

export class ProtocolJsonAcceptanceContextError extends Error {
  constructor(readonly stage: string, message: string, readonly evidence: unknown) { super(message); this.name = "ProtocolJsonAcceptanceContextError"; }
}

/** Reuses admitted Ready, never creates it or substitutes a hand-built descriptor.
 * Simulation and input funding execute on the configured node. The context
 * does not perform protocol acceptance by itself. */
export async function openFamilyAcceptanceRuntimeContext(input: FamilyAcceptanceRuntimeContextInput) {
  validateRuntimeContextInput(input);
  input = Object.freeze({ ...input, source: Object.freeze({ ...input.source }), inputPaths: Object.freeze([...(input.inputPaths ?? [])]) });
  const abort = new AbortController(), control = Object.freeze({ signal: abort.signal, deadlineAtMs: Date.now() + (input.timeoutMs ?? 480_000) });
  const timer = setTimeout(() => abort.abort(new Error("acceptance context deadline")), input.timeoutMs ?? 480_000);
  timer.unref();
  let simulation: ReturnType<typeof import("../revm-strict-source-simulation.js").createRevmStrictSourceSimulation> | undefined, stage = "inputs", url = "";
  let rpc: ReturnType<typeof createAcceptanceReadOnlyRpc> | undefined;
  const evidence: Record<string, any> = {}, simulationErrors: string[] = [];
  const redact = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]").split(url || "\0").join("[REDACTED]");
  try {
    const readyPath = realpathSync(input.readyPath), rpcFile = realpathSync(input.rpcFile);
    const artifactPath = resolve(ROOT, "out/BotVM.sol/BotVM.json"), artifactBytes = readFileSync(artifactPath);
    const pins = [...new Set([readyPath, rpcFile, artifactPath, fileURLToPath(import.meta.url), ...(input.inputPaths ?? []).map(path => realpathSync(path))])].map(path => {
      assert(statSync(path).isFile(), "acceptance input must be a file"); return { path, sha256: hash(readFileSync(path)) };
    });
    const sourceFiles = verifyAcceptanceBotVmArtifact(ROOT, artifactBytes);
    const sourceTreeSha256 = acceptanceSourceFingerprint(ROOT);
    evidence.inputs = pins; evidence.code = { sourceTreeSha256, executorSources: sourceFiles };
    evidence.simulator = "node-rpc"; evidence.executorArtifactSha256 = hash(artifactBytes);
    const executor = ethers.getAddress(input.executor), owner = ethers.getAddress(input.owner);
    const runtimeCode = loadBotVmRuntimeCode(owner); evidence.executorCodeHash = runtimeCode.keccak256; evidence.actors = { executor, owner };
    stage = "ready";
    // Validators/unused contexts do not initialize production catalogues or
    // require unrelated runtime data. Actual acceptance uses those exact modules.
    const [{ createStrictCentralAdapterRuntime }, { createRevmStrictSourceSimulation }, { NodeStrictClient },
      { resolveStrictReadyRuntime }, { UniverseRebuildCheckpointStore, activeReadyMemos }, { createRebuildWiring },
      { assertIssuedPreparedFamilyInstance }, { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog }] = await Promise.all([
      import("../strict-central-adapter-runtime.js"), import("../revm-strict-source-simulation.js"), import("../simulator/node-strict-client.js"),
      import("../strict-ready-runtime.js"), import("../universe-rebuild-checkpoint.js"), import("../universe-rebuild-production.js"),
      import("../venues/adapter-family-runtime.js"), import("../venues/production-family-composition.js"),
    ]);
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load();
    assert(envelope && envelope.inProgressRun === null, "acceptance requires committed Ready without an active rebuild");
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = Object.freeze({ ...ready.cutoff });
    assert.equal(source.number, input.source.number); assert(same(source.hash, input.source.hash), "Ready source differs from case");
    const family = catalog.forStrictFamily(input.familyId as never);
    assert.equal(family.plugin.manifest.domain, input.domain ?? "protocol",
      "acceptance domain differs from the installed Family manifest");
    const memos = activeReadyMemos(envelope).filter(memo => memo.familyId === input.familyId &&
      (ethers.isAddress(memo.instanceKey) && ethers.isAddress(input.instanceKey) ? same(memo.instanceKey, input.instanceKey) : memo.instanceKey === input.instanceKey));
    assert.equal(memos.length, 1, "Ready must contain exactly one requested family instance");
    const memo = memos[0]!, wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [input.familyId], executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo), "stale Ready family definition");
    const instance = input.domain === "funding" ? undefined : wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    if (instance) assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    evidence.admission = { kind: "reused-ready-admission", currentDefinition: true, memoFingerprint: memo.memoFingerprint,
      familyDefinitionHash: memo.familyDefinitionHash, proofSource: memo.validity.proofSource, candidate: memo.candidateSnapshot,
      readyGraphHash: ready.graphHash, readyCatalogHash: ready.catalogHash, newStrictAttestation: false };
    evidence.source = source;
    stage = "source-and-executor";
    try { url = JSON.parse(readFileSync(rpcFile, "utf8")).MAINNET_RPC_URL; }
    catch { throw new Error("invalid RPC configuration JSON"); }
    assert(typeof url === "string", "RPC file has no MAINNET_RPC_URL");
    let executionHeader: NodeSimulateV1Header | undefined;
    rpc = createAcceptanceReadOnlyRpc({ url, source, control, maxRequests: input.maxRpcRequests ?? 600,
      ...(input.simulationMethod === "eth_simulateV1" ? { mapCall: async (send: PinnedNodeRpc, params: readonly unknown[]) => {
        assert(executionHeader, "virtual execution environment not initialized");
        return createNodeSimulateV1Rpc(send, executionHeader)("eth_call", params);
      } } : {}) });
    const request = rpc.request, chainId = input.chainId ?? 1;
    assert.equal(quantity(await request("eth_chainId", [])), BigInt(chainId), "RPC chain differs from case");
    const header = await request("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]); assertAcceptanceHeader(header, source); evidence.header = header;
    executionHeader = header;
    evidence.executionEnvironment = input.simulationMethod === "eth_simulateV1" ? nodeSimulateV1Environment(header)
      : { method: "debug_traceCall", base: source, header };
    evidence.simulations = [];
    if (input.transactionHash !== undefined) {
      const receipt = await request("eth_getTransactionReceipt", [input.transactionHash]); assertAcceptanceReceipt(receipt, input.transactionHash, source); evidence.receipt = receipt;
    }
    const candidate = memo.candidateSnapshot as any;
    if (candidate?.transactionHash !== undefined) {
      assert(bytes32(candidate.transactionHash) && Number.isSafeInteger(candidate.blockNumber) && candidate.blockNumber >= 0 && candidate.blockNumber <= source.number && bytes32(candidate.blockHash), "candidate discovery anchor incomplete");
      const anchor = { number: candidate.blockNumber, hash: candidate.blockHash };
      const receipt = evidence.receipt && same(evidence.receipt.transactionHash, candidate.transactionHash) ? evidence.receipt : await request("eth_getTransactionReceipt", [candidate.transactionHash]);
      assertAcceptanceReceipt(receipt, candidate.transactionHash, anchor);
      if (anchor.number !== source.number) assertAcceptanceHeader(await request("eth_getBlockByNumber", [ethers.toQuantity(anchor.number), false]), anchor);
      else assert(same(anchor.hash, source.hash), "discovery source differs from Ready");
      evidence.candidateReceipt = receipt;
    }
    const pin = { blockHash: source.hash, requireCanonical: true };
    const executorCode = await request("eth_getCode", [executor, pin]), ownerCode = await request("eth_getCode", [owner, pin]);
    assert(ethers.isHexString(executorCode, true) && (same(executorCode, runtimeCode.code) || input.allowExecutorCodeOverride === true && executorCode === "0x"), "deployed executor code mismatch; counterfactual mode must be explicit");
    assert(ownerCode === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(ownerCode), "origin must be empty or exact EIP-7702 designator");
    evidence.executorProvisioning = { mode: input.allowExecutorCodeOverride ? "counterfactual" : "deployed",
      historicalCodeHash: ethers.keccak256(executorCode), runtimeCodeHash: runtimeCode.keccak256,
      actorOnlyCodeOverlay: executorCode === "0x", protocolOverrides: false, signing: false, broadcast: false };
    stage = "runtime";
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl: url, chainId, stateRoot: header.stateRoot }, executorRuntimeCode: runtimeCode,
      control, executionGasLimit: 0x1000000, preserveExecutorCode: !input.allowExecutorCodeOverride, createClient: () => {
        const client = new NodeStrictClient({ executor, executorRuntimeCode: runtimeCode, timeoutMs: 60_000,
          allowExecutorCodeOverride: input.allowExecutorCodeOverride, simulationMethod: input.simulationMethod });
        const strict = client.strictSimulate.bind(client);
        client.strictSimulate = async (...args) => { try {
          const result = await strict(...args);
          if (input.simulationMethod === "eth_simulateV1") assert.deepEqual((result as any).executionObservation, evidence.executionEnvironment,
            "quote and execution virtual environments differ");
          const { rpcUrl: _url, ...request } = args[0];
          evidence.simulations.push({ request, response: result });
          return result;
        } catch (error) { simulationErrors.push(redact(error)); throw error; } };
        return client;
      }, onFatal: () => abort.abort(new Error("acceptance source/transport fatal")) });
    let closing = false;
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, current) { assert(!closing, "acceptance context closed"); abort.signal.throwIfAborted(); assert.equal(g, source.generation); assert.deepEqual(current, source); } },
      provider: {
        call: async ({ blockTag, ...tx }, n, extra) => { assert.equal(blockTag ?? n, source.number); return request("eth_call", [tx, pin], extra); },
        getCode: async (address, n, extra) => { assert.equal(n, source.number); return request("eth_getCode", [address, pin], extra); },
        getStorage: async (address, slot, n, extra) => { assert.equal(n, source.number); return request("eth_getStorageAt", [address, slot, pin], extra); },
      } });
    const assertUnchanged = async () => {
      for (const entry of [...pins, ...sourceFiles]) assert.equal(hash(readFileSync(entry.path)), entry.sha256, "acceptance input/source changed");
      assert.equal(acceptanceSourceFingerprint(ROOT), sourceTreeSha256, "production source changed");
      const currentHeader = await request("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]);
      assertAcceptanceHeader(currentHeader, source); assert.deepEqual(currentHeader, header, "historical header environment changed");
    };
    let closePromise: Promise<void> | undefined;
    const close = () => closePromise ??= (async () => {
      closing = true;
      try { await assertUnchanged(); }
      finally { clearTimeout(timer); abort.abort(new Error("acceptance context settled")); await simulation!.closeAndDrain(); }
    })();
    return Object.freeze({ catalog, family, instance, memo, ready, graph, source, executor, owner, header, runtime, control, evidence,
      counters: () => ({ ...rpc!.counters(), simulationErrors: [...simulationErrors] }), assertUnchanged, close });
  } catch (error) {
    clearTimeout(timer); abort.abort(new Error("acceptance context failed"));
    try { await simulation?.closeAndDrain(); } catch (drain) { simulationErrors.push(redact(drain)); }
    throw new ProtocolJsonAcceptanceContextError(stage, redact(error), { ...evidence, diagnostics: rpc?.counters(), simulationErrors });
  }
}

export async function openProtocolJsonAcceptanceContext(input: ProtocolJsonAcceptanceContextInput) {
  validateAcceptanceContextInput(input);
  const context = await openFamilyAcceptanceRuntimeContext(input);
  try {
    assert(context.instance, "route acceptance requires a prepared instance");
    return Object.freeze({ ...context, instance: context.instance });
  } catch (error) { await context.close(); throw error; }
}

export type FamilyAcceptanceRuntimeContext = Awaited<ReturnType<typeof openFamilyAcceptanceRuntimeContext>>;
export type ProtocolJsonAcceptanceContext = Awaited<ReturnType<typeof openProtocolJsonAcceptanceContext>>;
