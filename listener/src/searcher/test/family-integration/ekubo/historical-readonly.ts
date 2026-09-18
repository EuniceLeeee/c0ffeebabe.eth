// Opt-in read-only acceptance probe. Uses production lifecycle/issuers and the
// existing strict REVM transport. It never signs, broadcasts, or writes catalogs.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { plugin } from "../../../venues/production-families/ekubo.production.js";
import type { UnifiedObservation } from "../../../venues/adapter-family-plugin.js";
import type { AdapterRequest, CanonicalSource } from "../../../venues/adapter-request-program.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../venues/production-infra-actions.js";
import { executeAdapterFamilyLifecycleBatch } from "../../../venues/adapter-family-runtime.js";
import { buildFamilyRouteGraphView } from "../../../adapter-family-graph-runtime.js";
import { createStrictCentralAdapterRuntime } from "../../../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot } from "../../../strict-production-runtime-session.js";
import { createRevmStrictSourceSimulation } from "../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../revm-sim-client.js";
import type { ResolvedPlanNode } from "../../../../types.js";
import { decodeSwapCall } from "../../../venues/swaps/ekubo-family/codec.js";
import { EKUBO_CORE, EKUBO_CORE_DEPLOY_BLOCK, parseEkuboCoreSwapLog } from "../../../venues/swaps/ekubo/abi.js";
import { ekuboNomination } from "../../../venues/swaps/ekubo-family/nomination.js";

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown): string { assert.equal(typeof value, "string"); return value as string; }
function array(value: unknown): unknown[] { assert(Array.isArray(value)); return value; }
function calls(trace: unknown, source: CanonicalSource, txHash: string): UnifiedObservation[] {
  const frame = object(trace), found: UnifiedObservation[] = [];
  if (frame.type === "CALL" && !frame.error && typeof frame.to === "string" && typeof frame.input === "string") {
    const observation: UnifiedObservation = { kind: "call", target: frame.to, data: frame.input, source, transactionHash: txHash };
    if (decodeSwapCall(observation)) found.push(observation);
  }
  for (const child of Array.isArray(frame.calls) ? frame.calls : []) found.push(...calls(child, source, txHash));
  return found;
}

async function run(): Promise<void> {
  const listener = fileURLToPath(new URL("../../../../../", import.meta.url));
  const workspace = dirname(listener);
  const cache = process.env.EKUBO_ANCHOR_CACHE;
  assert(cache, "EKUBO_ANCHOR_CACHE must name the real tx-8a0cccb8 cache directory");
  const primary = object(JSON.parse(readFileSync(resolve(cache, "primary.json"), "utf8")));
  const prices = object(JSON.parse(readFileSync(resolve(cache, "prices.json"), "utf8")));
  const storedSource = object(prices.source);
  const source: CanonicalSource = { number: Number(storedSource.number), hash: text(storedSource.hash), generation: Number(storedSource.generation) };
  const txHash = text(primary.txHash), trace = object(primary.trace);
  const observed = calls(trace, source, txHash);
  assert.equal(observed.length, 1);
  const anchor = decodeSwapCall(observed[0]); assert(anchor);
  // Isolated prefunding of a clean execution actor. No pool/token code or
  // reserves overridden; this proves fragment semantics, not live allowance state.
  const executor = "0x1000000000000000000000000000000000000002";
  const transactionOrigin = text(trace.from);
  const envFile = process.env.EKUBO_RPC_ENV_FILE;
  assert(envFile, "EKUBO_RPC_ENV_FILE must explicitly name the authorized read-only endpoint configuration");
  const envLine = readFileSync(envFile, "utf8").split(/\r?\n/).find(line => /^(?:export\s+)?MAINNET_RPC_URL=/.test(line.trim()));
  assert(envLine, "read-only endpoint unavailable");
  const rpcUrl = envLine.trim().split("=").slice(1).join("=").replace(/^["']|["']$/g, "");
  const basename = process.env.EKUBO_REPORT_BASENAME ?? "ekubo-historical-strict.json";
  assert(/^ekubo-historical-strict(?:-attempt[0-9]+)?\.json$/.test(basename));
  const out = resolve(workspace, "logs", basename);
  const report: Record<string, unknown> = { claim: "source-pinned production-catalog Family lifecycle/Exact/encoded-fragment; not natural enumeration or production gap acceptance",
    broadcast: false, source, txHash, executor, requests: [], stages: [] };
  const requests = array(report.requests), stages = array(report.stages);
  const save = () => writeFileSync(out, JSON.stringify(report, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2), { mode: 0o600 });
  let queue = Promise.resolve();
  const memo = new Map<string, Promise<unknown>>();
  if (process.env.EKUBO_READ_CACHE_PATH) {
    const cached = object(JSON.parse(readFileSync(process.env.EKUBO_READ_CACHE_PATH, "utf8")));
    assert.deepEqual(cached.source, source);
    for (const item of array(cached.requests)) {
      const row = object(item), request = object(row.request), body = object(row.body);
      if (row.status !== 200 || body.error) continue;
      const key = JSON.stringify([request.method, request.params]);
      memo.set(key, Promise.resolve(body.result));
      requests.push({ ...row, cached: true });
    }
  }
  async function send(method: string, params: readonly unknown[]): Promise<unknown> {
    const key = JSON.stringify([method, params]);
    const cached = memo.get(key); if (cached) return cached;
    const pending = queue.then(async () => {
      assert(requests.length < 48, "read-only request cap");
      const request = { jsonrpc: "2.0", id: requests.length + 1, method, params };
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(20000) });
      const body = object(await response.json());
      requests.push({ request, status: response.status, body }); save();
      assert(response.ok, `RPC HTTP ${response.status}`);
      if (body.error) {
        const error = object(body.error);
        throw Object.assign(new Error(text(error.message).replaceAll(rpcUrl, "[RPC_REDACTED]")), { code: error.code, data: error.data });
      }
      return body.result;
    });
    queue = pending.then(() => {}, () => {}); memo.set(key, pending); return pending;
  }
  const pin = { blockHash: source.hash, requireCanonical: true };
  const provider = { call: async (tx: { to: string; data: string; from?: string }) => text(await send("eth_call", [tx, pin])),
    getCode: async (address: string) => text(await send("eth_getCode", [address, pin])),
    getStorage: async (address: string, slot: string) => text(await send("eth_getStorageAt", [address, slot, pin])) };
  const control = { deadlineAtMs: Date.now() + 240000, signal: AbortSignal.timeout(240000) };
  const simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1 }, control, executionGasLimit: 2_000_000,
    createClient: ({ onFatal }) => new RevmSimClient({ executablePath: resolve(workspace, "logs/revm-diag-target/release/revm-sim"), timeoutMs: 45000, onFatal }),
    onFatal: reason => { report.fatal = reason; save(); } });
  try {
    const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } = await import("../../../venues/production-family-composition.js");
    report.catalogHash = catalog.catalogHash;
    const header = object(await send("eth_getBlockByHash", [source.hash, false]));
    assert.equal(Number(header.number), source.number); assert.equal(header.hash, source.hash);
    const runtime = createStrictCentralAdapterRuntime({ provider, exactCallBackend: { call: provider.call }, executor, transactionOrigin,
      simulator: simulation.transport, generationFence: { assertCurrent(generation, boundSource) {
        assert.equal(generation, source.generation); assert.deepEqual(boundSource, source);
      } } });
    // The target transaction is ONLY the amount/identity comparison reference.
    // Source discovery re-reads earlier real Core logs and their transactions.
    // This is pool-scoped validation, not a target-blind production rebuild.
    const priorLogs = array(await send("eth_getLogs", [{ address: EKUBO_CORE,
      fromBlock: ethers.toQuantity(Math.max(EKUBO_CORE_DEPLOY_BLOCK, source.number - 499)), toBlock: ethers.toQuantity(source.number) }]));
    const priorTxs: string[] = [];
    for (const raw of [...priorLogs].reverse()) {
      const log = object(raw);
      if (array(log.topics).length !== 0 || log.removed === true || Number(log.blockNumber) > source.number) continue;
      try {
        if (parseEkuboCoreSwapLog(text(log.data)).poolId !== anchor.poolId) continue;
        const hash = text(log.transactionHash); assert.notEqual(hash, txHash);
        if (!priorTxs.includes(hash)) priorTxs.push(hash);
      } catch { /* unrelated structural Core event */ }
    }
    report.earlierPoolLogs = priorLogs.filter(raw => {
      const log = object(raw);
      try { return array(log.topics).length === 0 && parseEkuboCoreSwapLog(text(log.data)).poolId === anchor.poolId; } catch { return false; }
    }); save();
    let discoveryObservations: readonly UnifiedObservation[] = [];
    for (const earlierHash of priorTxs.slice(0, 4)) {
      discoveryObservations = await ekuboNomination.nominate({ source,
        nominations: [{ address: anchor.poolId, opaque: { adapter: "ekubo-core-pool-v1", poolId: anchor.poolId, txHash: earlierHash } }],
        provider: { ...provider, getLogs: async () => { throw new Error("unbudgeted initialization scan"); },
          getTransactionReceipt: async hash => {
            const raw = await send("eth_getTransactionReceipt", [hash]); if (raw === null) return null;
            const receipt = object(raw);
            return { blockNumber: Number(receipt.blockNumber), logs: array(receipt.logs).map(value => {
              const log = object(value); return { address: text(log.address), topics: array(log.topics).map(text), data: text(log.data), transactionHash: text(log.transactionHash) };
            }) };
          }, traceTransaction: hash => send("debug_traceTransaction", [hash, { tracer: "callTracer", timeout: "10s" }]) } });
      if (discoveryObservations.length > 0) break;
    }
    report.discoveryObservations = discoveryObservations; save();
    assert(discoveryObservations.length > 0, "no affordable earlier router-call discovery evidence; do not seed from target");
    const family = catalog.forFamily(plugin.manifest.familyId);
    const matches = discoveryObservations.map(observation => {
      const match = catalog.matches(observation).find(m => m.familyId === plugin.manifest.familyId); assert(match);
      return { observation, matchedPatternId: match.patternId };
    });
    const lifecycle = await executeAdapterFamilyLifecycleBatch({ family, matches, source, generation: source.generation, runtime,
      publisher: { publish() {} } });
    report.outcomes = lifecycle.outcomes; save();
    assert(lifecycle.publication, "no strict lifecycle publication");
    const instances = lifecycle.publication.instances;
    assert.equal(instances.length, 1); assert.equal(instances[0].routes.length, 2);
    const graph = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, i) =>
      ({ family, descriptor: instance.descriptor, route, handle: instance.routeHandles[i] }))) });
    report.graph = graph.edges;
    report.pricing = instances[0].pricingInstances.map(p => ({ snapshot: p.snapshot, mids: [...p.mids] }));
    console.log("Ekubo real lifecycle published two directions"); save();
    const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: graph.edges, readyInstances: instances, readyFundingAssets: [] });
    const session = await root.createSession({ source, runtime, kind: "exact", fundingAssets: [],
      requiredEdgeIds: new Set(graph.edges.map(e => e.canonicalEdgeId)), control });
    const actions = [...plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    for (const [index, edge] of session.edges.entries()) {
      const amountIn: bigint = edge.tokenIn.toLowerCase() === anchor.poolKey.token0.toLowerCase() ? anchor.amountIn : 283473222n;
      const exact = await session.issueExact({ edge, amountIn, executor, runtimeEvidence: [], control });
      const execution = session.buildExecution({ edge, exact, minAmountOut: exact.amountOut, executor });
      assert.equal(execution.status, "resolved"); if (execution.status !== "resolved") throw new Error("unresolved execution");
      const row: Record<string, unknown> = { tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, amountIn, amountOut: exact.amountOut, fragment: execution.fragment };
      stages.push(row); save();
      const nodes: ResolvedPlanNode[] = execution.fragment.requirements.map(requirement => {
        assert.equal(requirement.kind, "approve"); if (requirement.kind !== "approve") throw new Error("unexpected requirement");
        return { adapterId: "erc20-approve", target: requirement.token, tokenIn: requirement.token, tokenOut: requirement.token,
          amount: requirement.amount, params: { spender: requirement.spender, amount: requirement.amount }, children: [] };
      });
      nodes.push(...execution.fragment.nodes);
      const caller = { kind: "executor" as const };
      const wire = nodes.map(node => {
        const action = actions.find(a => a.id === node.adapterId); assert(action);
        const bytes = action.encode(node, executor, new Uint8Array());
        assert.equal(bytes[0], 0);
        const size = (bytes[21] << 16) + (bytes[22] << 8) + bytes[23]; assert.equal(size + 24, bytes.length);
        return { caller, to: ethers.hexlify(bytes.slice(1, 21)), data: ethers.hexlify(bytes.slice(24)) };
      });
      const request: Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }> = {
        id: `ekubo-encoded:${index}`, kind: "effect-delta-simulation", preCalls: wire.slice(0, -1),
        call: { ...wire.at(-1)!, executionMode: "impersonated-call-frame" },
        overrideIntent: { caller, tokenBalances: [{ token: edge.tokenIn, amount: amountIn }] },
        observe: ["return-data", "token-delta"], observeTokenBalances: [{ token: edge.tokenIn, account: executor }, { token: edge.tokenOut, account: executor }] };
      row.request = request; save();
      const result = await simulation.transport.simulate({ request, source, control, callerAuthority: { executor, transactionOrigin } });
      row.result = result; save();
      assert.equal(result.effects?.tokenDeltas?.find(d => d.token.toLowerCase() === edge.tokenIn.toLowerCase())?.delta, -amountIn);
      assert.equal(result.effects?.tokenDeltas?.find(d => d.token.toLowerCase() === edge.tokenOut.toLowerCase())?.delta, exact.amountOut);
      row.verified = true; save(); console.log(JSON.stringify({ direction: index, amountIn: String(amountIn), amountOut: String(exact.amountOut), verified: true }));
    }
    report.complete = true;
  } catch (error) {
    report.failure = String(error instanceof Error ? error.message : error).replaceAll(rpcUrl, "[RPC_REDACTED]");
    process.exitCode = 1; console.error(report.failure);
  } finally { await simulation.closeAndDrain(); save(); }
}
if (process.argv.includes("--run")) await run();
