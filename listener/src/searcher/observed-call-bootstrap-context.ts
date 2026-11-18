import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isHexString, keccak256, toQuantity, ZeroAddress } from "ethers";
import { loadBotVmRuntimeCode } from "../shared/executor/botvm-executor.js";
import { createStrictCentralAdapterRuntime } from "./strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "./revm-strict-source-simulation.js";
import { NodeStrictClient } from "./simulator/node-strict-client.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from "./venues/production-verified-actors.js";
import { assertDeclarativeExecutionSource } from "./venues/declarative-execution.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { createNodeSimulateV1Rpc, nodeSimulateV1Environment, type NodeSimulateV1Header } from "./simulator/node-simulate-v1.js";
import { acceptanceSourceFingerprint, assertAcceptanceHeader, createAcceptanceReadOnlyRpc,
  verifyAcceptanceBotVmArtifact } from "./test/protocol-json-acceptance-context.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface ObservedCallBootstrapContextInput {
  readonly source: CanonicalSource;
  readonly rpcFile: string;
  readonly executor: string;
  readonly owner: string;
  readonly allowExecutorCodeOverride?: boolean;
  readonly simulationMethod: "debug_traceCall" | "eth_simulateV1";
  readonly inputPaths?: readonly string[];
  readonly maxRequests?: number;
  readonly timeoutMs?: number;
}

/** Read-only source/executor context for candidate acquisition. It neither
 * opens a Family's Ready memo nor creates an admitted instance or route handle.
 * It has no protocol-identity prerequisite. A selector-owned or existing owner
 * must still acquire current execution evidence and pass the ordinary Ready
 * issuer before Graph publication. */
export async function openObservedCallBootstrapContext(input: ObservedCallBootstrapContextInput) {
  assertDeclarativeExecutionSource(input.source);
  const source = Object.freeze({ ...input.source });
  const executor = getAddress(input.executor), owner = getAddress(input.owner);
  assert(executor !== ZeroAddress && owner !== ZeroAddress && executor !== owner, "invalid bootstrap actors");
  const maxRequests = input.maxRequests ?? 2000, timeoutMs = input.timeoutMs ?? 480_000;
  assert(Number.isSafeInteger(maxRequests) && maxRequests > 0 && maxRequests <= 1_000_000, "invalid bootstrap request budget");
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 86_400_000, "invalid bootstrap deadline");
  const abort = new AbortController();
  const control = Object.freeze({ signal: abort.signal, deadlineAtMs: Date.now() + timeoutMs });
  const timer = setTimeout(() => abort.abort(new Error("observed acquisition deadline")), timeoutMs);
  timer.unref();
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined;
  let closing = false;
  try {
    const rpcFile = realpathSync(input.rpcFile), artifact = resolve(ROOT, "out/BotVM.sol/BotVM.json");
    const artifactBytes = readFileSync(artifact), executorSources = verifyAcceptanceBotVmArtifact(ROOT, artifactBytes);
    const pins = [...new Set([rpcFile, artifact, fileURLToPath(new URL("./test/protocol-json-acceptance-context.ts", import.meta.url)),
      ...(input.inputPaths ?? []).map(path => realpathSync(path))])].map(path => {
      assert(statSync(path).isFile(), "bootstrap input must be a regular file");
      return { path, sha256: hash(readFileSync(path)) };
    });
    const sourceTreeHash = acceptanceSourceFingerprint(ROOT), runtimeCode = loadBotVmRuntimeCode(owner);
    const configuration = JSON.parse(readFileSync(rpcFile, "utf8"));
    assert(typeof configuration.MAINNET_RPC_URL === "string", "RPC configuration has no MAINNET_RPC_URL");
    let executionHeader: NodeSimulateV1Header | undefined;
    const rpc = createAcceptanceReadOnlyRpc({ url: configuration.MAINNET_RPC_URL, source, control, maxRequests,
      ...(input.simulationMethod === "eth_simulateV1" ? { mapCall: async (send, params) => {
        assert(executionHeader, "bootstrap execution environment unavailable");
        return createNodeSimulateV1Rpc(send, executionHeader)("eth_call", params);
      } } : {}) });
    const request = rpc.request;
    assert.equal(BigInt(await request("eth_chainId", [])), 1n, "bootstrap requires Ethereum mainnet source");
    const header = await request("eth_getBlockByNumber", [toQuantity(source.number), false]);
    assertAcceptanceHeader(header, source);
    assert(isHexString(header.stateRoot, 32), "source state root missing");
    executionHeader = header;
    const executionEnvironment = input.simulationMethod === "eth_simulateV1" ? nodeSimulateV1Environment(header) : undefined;
    const pin = { blockHash: source.hash, requireCanonical: true };
    const executorCode = await request("eth_getCode", [executor, pin]), ownerCode = await request("eth_getCode", [owner, pin]);
    assert(isHexString(executorCode, true) && (same(executorCode, runtimeCode.code) ||
      input.allowExecutorCodeOverride === true && executorCode === "0x"), "bootstrap executor code mismatch; explicit empty-address provisioning required");
    assert(ownerCode === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(ownerCode), "bootstrap transaction origin is not a supported account");
    const allowOverride = input.allowExecutorCodeOverride === true && executorCode === "0x";
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl: configuration.MAINNET_RPC_URL, chainId: 1, stateRoot: header.stateRoot },
      control, executionGasLimit: 0x1000000, executorRuntimeCode: runtimeCode, preserveExecutorCode: !allowOverride,
      ...(allowOverride ? { provisionedExecutor: executor } : {}),
      createClient: () => {
        const client = new NodeStrictClient({ timeoutMs: 60_000, executor, executorRuntimeCode: runtimeCode,
          allowExecutorCodeOverride: allowOverride, simulationMethod: input.simulationMethod, lane: "discovery" });
        const strict = client.strictSimulate.bind(client);
        client.strictSimulate = async (...args) => {
          const result = await strict(...args);
          // Ordinary reads and simulations must use the same virtual header,
          // including timestamp/fee context, not merely the same base state.
          const observation = (result as typeof result & { readonly executionObservation?: unknown }).executionObservation;
          if (input.simulationMethod === "eth_simulateV1") assert.deepEqual(observation, executionEnvironment,
            "bootstrap reads and simulation virtual environments differ");
          return result;
        };
        return client;
      },
      onFatal: () => abort.abort(new Error("bootstrap source or simulation failed")) });
    const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner,
      verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS, simulator: simulation.transport,
      generationFence: { assertCurrent(generation, current) {
        assert(!closing, "bootstrap context closed"); abort.signal.throwIfAborted();
        assert.equal(generation, source.generation); assert.deepEqual(current, source);
      } },
      provider: {
        call: async ({ blockTag, ...tx }, n, extra) => { assert.equal(blockTag ?? n, source.number); return request("eth_call", [tx, pin], extra); },
        getCode: async (address, n, extra) => { assert.equal(n, source.number); return request("eth_getCode", [address, pin], extra); },
        getStorage: async (address, slot, n, extra) => { assert.equal(n, source.number); return request("eth_getStorageAt", [address, slot, pin], extra); },
      } });
    const assertUnchanged = async () => {
      for (const entry of [...pins, ...executorSources]) assert.equal(hash(readFileSync(entry.path)), entry.sha256, "bootstrap source/input changed");
      assert.equal(acceptanceSourceFingerprint(ROOT), sourceTreeHash, "bootstrap production source changed");
      const current = await request("eth_getBlockByNumber", [toQuantity(source.number), false]);
      assertAcceptanceHeader(current, source); assert.deepEqual(current, header, "bootstrap canonical environment changed");
    };
    let closePromise: Promise<void> | undefined;
    const close = () => closePromise ??= (async () => {
      closing = true;
      try { await assertUnchanged(); }
      finally { clearTimeout(timer); abort.abort(new Error("bootstrap context settled")); await simulation!.closeAndDrain(); }
    })();
    return Object.freeze({ source, executor, owner, runtime, control, header, assertUnchanged, close, counters: rpc.counters,
      evidence: Object.freeze({ kind: "source-bound-candidate-acquisition", readyAdmission: false, graphPublication: false,
        sourceTreeHash, executorCodeHash: runtimeCode.keccak256, originalExecutorCodeHash: keccak256(executorCode),
        executorProvisioning: allowOverride ? "counterfactual" : "deployed", ...(executionEnvironment ? { executionEnvironment } : {}) }) });
  } catch (error) {
    clearTimeout(timer); abort.abort(new Error("bootstrap context failed"));
    await simulation?.closeAndDrain();
    throw error;
  }
}
export type ObservedCallBootstrapContext = Awaited<ReturnType<typeof openObservedCallBootstrapContext>>;
