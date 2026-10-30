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

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytes32 = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const quantity = (value: unknown): bigint => {
  assert(typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value), "invalid RPC quantity");
  return BigInt(value);
};

export interface ProtocolJsonAcceptanceContextInput {
  readonly readyPath: string;
  readonly rpcFile: string;
  readonly revmBin: string;
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
}

export function validateAcceptanceContextInput(input: ProtocolJsonAcceptanceContextInput): void {
  assert(input && typeof input === "object", "acceptance context input required");
  for (const path of [input.readyPath, input.rpcFile, input.revmBin, ...(input.inputPaths ?? [])])
    assert(typeof path === "string" && isAbsolute(path), "acceptance input paths must be absolute");
  acceptanceFamilyDomain(input.familyId, input.domain);
  assert(typeof input.instanceKey === "string" && input.instanceKey.trim() === input.instanceKey && input.instanceKey.length > 0, "instance required");
  assert(input.source && Number.isSafeInteger(input.source.number) && input.source.number >= 0 && bytes32(input.source.hash), "invalid source anchor");
  assert(Number.isSafeInteger(input.chainId ?? 1) && (input.chainId ?? 1) > 0, "invalid chain id");
  assert(!same(ethers.getAddress(input.executor), ethers.getAddress(input.owner)), "executor and origin must differ");
  assert(input.transactionHash === undefined || bytes32(input.transactionHash), "invalid transaction hash");
  for (const n of [input.timeoutMs ?? 480_000, input.maxRpcRequests ?? 600]) assert(Number.isSafeInteger(n) && n > 0, "invalid acceptance limit");
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
 * REVM owns its own pinned archive reads; these limits count direct reads only. */
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
}) {
  const url = input.url, source = Object.freeze({ ...input.source }), control = Object.freeze({ ...input.control });
  const maxRequests = input.maxRequests, send = input.fetch ?? fetch;
  const endpoint = new URL(url); assert(["http:", "https:"].includes(endpoint.protocol) && !endpoint.hash, "invalid RPC endpoint");
  assert(Number.isSafeInteger(maxRequests) && maxRequests > 0, "invalid RPC budget");
  const redact = (value: unknown) => String(value).split(url).join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  let reads = 0;
  const failures: { method: string; message: string; code?: number }[] = [];
  const request = async (method: string, params: readonly unknown[], extra?: AdapterWorkControl): Promise<any> => {
    assertAcceptanceReadOnlyRpc(method, params, source);
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
  return { request, counters: () => ({ directRpcReads: reads, failures: failures.map(failure => ({ ...failure })), revmInternalRpcReads: "not counted" as const }) };
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
 * Local REVM is lazy: the existing transport starts it only when a caller runs a
 * quote/simulation. The context does not perform protocol acceptance by itself. */
export async function openProtocolJsonAcceptanceContext(input: ProtocolJsonAcceptanceContextInput) {
  validateAcceptanceContextInput(input);
  input = Object.freeze({ ...input, source: Object.freeze({ ...input.source }), inputPaths: Object.freeze([...(input.inputPaths ?? [])]) });
  const abort = new AbortController(), control = Object.freeze({ signal: abort.signal, deadlineAtMs: Date.now() + (input.timeoutMs ?? 480_000) });
  const timer = setTimeout(() => abort.abort(new Error("acceptance context deadline")), input.timeoutMs ?? 480_000);
  timer.unref();
  let simulation: ReturnType<typeof import("../revm-strict-source-simulation.js").createRevmStrictSourceSimulation> | undefined, stage = "inputs", url = "";
  let rpc: ReturnType<typeof createAcceptanceReadOnlyRpc> | undefined;
  const evidence: Record<string, any> = {}, simulationErrors: string[] = [];
  const redact = (value: unknown) => String(value instanceof Error ? value.message : value).split(url || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  try {
    const readyPath = realpathSync(input.readyPath), rpcFile = realpathSync(input.rpcFile), revmBin = realpathSync(input.revmBin);
    const artifactPath = resolve(ROOT, "out/BotVM.sol/BotVM.json"), artifactBytes = readFileSync(artifactPath);
    const pins = [...new Set([readyPath, rpcFile, revmBin, artifactPath, fileURLToPath(import.meta.url), ...(input.inputPaths ?? []).map(path => realpathSync(path))])].map(path => {
      assert(statSync(path).isFile(), "acceptance input must be a file"); return { path, sha256: hash(readFileSync(path)) };
    });
    const sourceFiles = verifyAcceptanceBotVmArtifact(ROOT, artifactBytes);
    const sourceTreeSha256 = acceptanceSourceFingerprint(ROOT);
    evidence.inputs = pins; evidence.code = { sourceTreeSha256, executorSources: sourceFiles };
    evidence.revmSha256 = hash(readFileSync(revmBin)); evidence.executorArtifactSha256 = hash(artifactBytes);
    const executor = ethers.getAddress(input.executor), owner = ethers.getAddress(input.owner);
    const runtimeCode = loadBotVmRuntimeCode(owner); evidence.executorCodeHash = runtimeCode.keccak256; evidence.actors = { executor, owner };
    stage = "ready";
    // Validators/unused contexts do not initialize production catalogues or
    // require unrelated runtime data. Actual acceptance uses those exact modules.
    const [{ createStrictCentralAdapterRuntime }, { createRevmStrictSourceSimulation }, { RevmSimClient },
      { resolveStrictReadyRuntime }, { UniverseRebuildCheckpointStore, activeReadyMemos }, { createRebuildWiring },
      { assertIssuedPreparedFamilyInstance }, { asPricedFamily }, { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog }] = await Promise.all([
      import("../strict-central-adapter-runtime.js"), import("../revm-strict-source-simulation.js"), import("../revm-sim-client.js"),
      import("../strict-ready-runtime.js"), import("../universe-rebuild-checkpoint.js"), import("../universe-rebuild-production.js"),
      import("../venues/adapter-family-runtime.js"), import("../venues/family-capability-catalog.js"), import("../venues/production-family-composition.js"),
    ]);
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load();
    assert(envelope && envelope.inProgressRun === null, "acceptance requires committed Ready without an active rebuild");
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = Object.freeze({ ...ready.cutoff });
    assert.equal(source.number, input.source.number); assert(same(source.hash, input.source.hash), "Ready source differs from case");
    const family = asPricedFamily(catalog.forStrictFamily(input.familyId as never));
    assert.equal(family.plugin.manifest.domain, acceptanceFamilyDomain(input.familyId, input.domain),
      "acceptance domain differs from the installed Family manifest");
    const memos = activeReadyMemos(envelope).filter(memo => memo.familyId === input.familyId &&
      (ethers.isAddress(memo.instanceKey) && ethers.isAddress(input.instanceKey) ? same(memo.instanceKey, input.instanceKey) : memo.instanceKey === input.instanceKey));
    assert.equal(memos.length, 1, "Ready must contain exactly one requested family instance");
    const memo = memos[0]!, wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [input.familyId], executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo), "stale Ready family definition");
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    evidence.admission = { kind: "reused-ready-admission", currentDefinition: true, memoFingerprint: memo.memoFingerprint,
      familyDefinitionHash: memo.familyDefinitionHash, proofSource: memo.validity.proofSource, candidate: memo.candidateSnapshot,
      readyGraphHash: ready.graphHash, readyCatalogHash: ready.catalogHash, newStrictAttestation: false };
    evidence.source = source;
    stage = "source-and-executor";
    try { url = JSON.parse(readFileSync(rpcFile, "utf8")).MAINNET_RPC_URL; }
    catch { throw new Error("invalid RPC configuration JSON"); }
    assert(typeof url === "string", "RPC file has no MAINNET_RPC_URL");
    rpc = createAcceptanceReadOnlyRpc({ url, source, control, maxRequests: input.maxRpcRequests ?? 600 });
    const request = rpc.request, chainId = input.chainId ?? 1;
    assert.equal(quantity(await request("eth_chainId", [])), BigInt(chainId), "RPC chain differs from case");
    const header = await request("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]); assertAcceptanceHeader(header, source); evidence.header = header;
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
    assert(ethers.isHexString(executorCode, true) && (executorCode === "0x" || same(executorCode, runtimeCode.code)), "refuse replacing unrelated actor code");
    assert(ownerCode === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(ownerCode), "origin must be empty or exact EIP-7702 designator");
    evidence.executorProvisioning = { historicalCodeHash: ethers.keccak256(executorCode), runtimeCodeHash: runtimeCode.keccak256,
      actorOnlyCodeOverlay: executorCode === "0x", protocolOverrides: false, signing: false, broadcast: false };
    stage = "runtime";
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl: url, chainId, stateRoot: header.stateRoot }, executorRuntimeCode: runtimeCode,
      control, executionGasLimit: 0x1000000, createClient: ({ onFatal }) => {
        const client = new RevmSimClient({ executablePath: revmBin, timeoutMs: 60_000, onFatal });
        const strict = client.strictSimulate.bind(client);
        client.strictSimulate = async (...args) => { try { return await strict(...args); } catch (error) { simulationErrors.push(redact(error)); throw error; } };
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
    return Object.freeze({ catalog, family, instance, ready, graph, source, executor, owner, header, runtime, control, evidence,
      counters: () => ({ ...rpc!.counters(), simulationErrors: [...simulationErrors] }), assertUnchanged, close });
  } catch (error) {
    clearTimeout(timer); abort.abort(new Error("acceptance context failed"));
    try { await simulation?.closeAndDrain(); } catch (drain) { simulationErrors.push(redact(drain)); }
    throw new ProtocolJsonAcceptanceContextError(stage, redact(error), { ...evidence, diagnostics: rpc?.counters(), simulationErrors });
  }
}

export type ProtocolJsonAcceptanceContext = Awaited<ReturnType<typeof openProtocolJsonAcceptanceContext>>;
