// Opt-in Family acceptance only; no strategy enablement, live or broadcasting.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/fluid-credit.production.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { executeCreditFamilyInstanceLifecycle } from "../../../adapter-family-runtime.js";
import type { UnifiedObservation } from "../../../adapter-family-plugin.js";
import type { AdapterRequest, CanonicalSource } from "../../../adapter-request-program.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "../../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import { prepareCreditFamilyRoutes, projectCreditRouteGraph, executeCreditRiskQuote,
  issueCreditExecutionHandle, buildCreditExecutionFragment } from "../../../../adapter-credit-runtime.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { FLUID_CREDIT_PROBE_ACTOR, FLUID_VAULT_INTERFACE } from "../codec.js";
import { FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID } from "../identity.js";
import { StrictProductionRuntimeRoot } from "../../../../strict-production-runtime-session.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { createVerifiedGraphView, blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { tokenToWethReferences } from "../../../../blockscan-amount-reference.js";
import type { FluidCreditDescriptor } from "../types.js";
import type { ResolvedPlanNode } from "../../../../../types.js";

function required(name: string): string { const value = process.env[name]; assert(value, `${name} required`); return value; }
function json(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }
function priceSnapshot(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"), (_key, value) =>
    value?.$type === "bigint" ? BigInt(value.value) :
    value?.$type === "map" ? new Map(value.entries) :
    value?.$type === "set" ? new Set(value.values) : value);
}
async function run(): Promise<void> {
  const cache = required("FLUID_TX_CACHE");
  const boundary = json(resolve(cache, "boundary.json"));
  const followup = json(resolve(cache, "followup.json"));
  const trace = followup.requests.find((r: any) => r.request.method === "debug_traceTransaction").result;
  const receipt = boundary.requests.find((r: any) => r.request.method === "eth_getTransactionReceipt").result;
  assert.equal(receipt.status, "0x1");
  assert.equal(receipt.transactionHash, boundary.winner);
  const source: CanonicalSource = { number: Number(receipt.blockNumber), hash: receipt.blockHash, generation: Number(receipt.blockNumber) };
  assert.equal(source.number, boundary.block); assert.equal(source.hash, boundary.hash);
  const pricesPath = required("FLUID_REFERENCE_PRICES"), prices = json(pricesPath);
  assert.equal(prices.sourceBlock, source.number); assert.equal(prices.sourceBlockHash, source.hash);
  const observations: UnifiedObservation[] = [];
  const frames: any[] = [];
  const visit = (frame: any) => {
    if (frame.type === "CALL" && !frame.error && typeof frame.input === "string") {
      const observation: UnifiedObservation = { kind: "call", target: frame.to, sender: frame.from,
        data: frame.input, source, transactionHash: receipt.transactionHash };
      if (catalog.matches(observation).some(m => m.familyId === plugin.manifest.familyId)) {
        observations.push(observation); frames.push(frame);
      }
    }
    for (const child of frame.calls ?? []) visit(child);
  };
  visit(trace); assert(observations.length > 0, "real trace contains no Credit discovery observation");
  const observation = observations[0], frame = frames[0];
  const args = FLUID_VAULT_INTERFACE.decodeFunctionData("operate", frame.input);
  const txAmountIn = BigInt(args[1]), originalDebtRequested = BigInt(args[2]);
  const originalReturned = FLUID_VAULT_INTERFACE.decodeFunctionResult("operate", frame.output);
  assert.equal(BigInt(originalReturned[2]), originalDebtRequested);
  const executor = "0x1000000000000000000000000000000000000002";
  const transactionOrigin = ethers.getAddress(trace.from);
  const env = readFileSync(required("FLUID_RPC_ENV_FILE"), "utf8").split(/\r?\n/)
    .find(line => /^(?:export\s+)?MAINNET_RPC_URL=/.test(line.trim()));
  assert(env, "MAINNET_RPC_URL missing");
  const rpcUrl = env.trim().split("=").slice(1).join("=").replace(/^["']|["']$/g, "");
  const output = resolve(required("FLUID_REPORT")); mkdirSync(dirname(output), { recursive: true });
  const report: any = { claim: "Credit Family strict, production session raw/effective and encoded operate parity at N end; not original pre-tx replay or strategy admission",
    source, transactionHash: receipt.transactionHash, broadcast: false, executor, referencePrices: pricesPath,
    original: { amountIn: txAmountIn, requestedDebt: originalDebtRequested, returnedDebt: BigInt(originalReturned[2]) },
    catalogHash: catalog.catalogHash, rows: [], requests: [] };
  const save = () => writeFileSync(output, JSON.stringify(report, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2), { mode: 0o600 });
  const control = { deadlineAtMs: Date.now() + 240000, signal: AbortSignal.timeout(240000) };
  const simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1 }, control,
    executionGasLimit: 3_000_000, createClient: ({ onFatal }) => new RevmSimClient({ executablePath: required("FLUID_REVM_BIN"),
      timeoutMs: 90000, onFatal }), onFatal: reason => { report.fatal = reason; save(); } });
  let calls = 0;
  async function rpc(method: string, params: readonly unknown[]): Promise<any> {
    assert(++calls <= 32, "bounded read request cap");
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }), signal: AbortSignal.timeout(20000) });
    const body: any = await response.json();
    report.requests.push({ method, params, status: response.status, result: body.result, error: body.error }); save();
    assert(response.ok && !body.error, `historical read ${method} failed (${response.status})`);
    return body.result;
  }
  const pin = { blockHash: source.hash, requireCanonical: true };
  const provider = { call: (tx: any) => rpc("eth_call", [tx, pin]), getCode: (a: string) => rpc("eth_getCode", [a, pin]),
    getStorage: (a: string, slot: string) => rpc("eth_getStorageAt", [a, slot, pin]) };
  try {
    const header = await rpc("eth_getBlockByHash", [source.hash, false]);
    assert.equal(Number(header.number), source.number); assert.equal(header.hash, source.hash);
    const runtime = createStrictCentralAdapterRuntime({ provider, simulator: simulation.transport, executor, transactionOrigin,
      exactCallBackend: provider, verifiedActors: { [FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID]: FLUID_CREDIT_PROBE_ACTOR },
      generationFence: { assertCurrent(generation, bound) { assert.equal(generation, source.generation); assert.deepEqual(bound, source); } } });
    const family = catalog.forStrictFamily(plugin.manifest.familyId);
    const match = catalog.matches(observation).find(m => m.familyId === plugin.manifest.familyId)!;
    report.stage = "strict"; save();
    const lifecycle = await executeCreditFamilyInstanceLifecycle({ family, match: { observation, matchedPatternId: match.patternId },
      source, generation: source.generation, runtime });
    report.outcomes = lifecycle.outcomes; save(); assert(lifecycle.instance, "historical Credit strict did not admit");
    const routes = prepareCreditFamilyRoutes({ family, instance: lifecycle.instance, source, generation: source.generation });
    assert.equal(routes.routes.length, 1);
    const route = routes.routes[0]; report.graph = projectCreditRouteGraph({ family, route }).edge;
    const descriptor = lifecycle.instance.descriptor as FluidCreditDescriptor;
    const view = buildFamilyRouteGraphView({ routes: [], creditRoutes: [projectCreditRouteGraph({ family, route })] });
    const graph = createVerifiedGraphView({ id: "fluid-historical-admitted", sourceBlock: source.number,
      sourceBlockHash: source.hash, generation: source.generation, completenessWatermark: source.number,
      perSourceCoverage: [{ familyId: plugin.manifest.familyId, sourceId: "historical-trace",
        sourceFingerprint: receipt.transactionHash, completeThroughBlock: source.number, completeThroughHash: source.hash }],
      edges: view.edges, familyIdForEdge: () => plugin.manifest.familyId });
    const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: graph.edges,
      readyInstances: [lifecycle.instance], readyFundingAssets: [] });
    const reference = priceSnapshot(pricesPath).pricing;
    const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    const exactSession = await root.createSession({ source, runtime, fundingAssets: [], kind: "exact",
      requiredEdgeIds: new Set(graph.edges.map(blockScanEdgeKey)), control });
    const edge = exactSession.edges[0];
    const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({ source: request.source,
      runtime, fundingAssets: request.fundingAssets, kind: "pricing", control: request.control }), () => {}, undefined,
      (pricing, workControl, _backend, reuse) => buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph,
        weth, gasCostWei: null, enumerationSpreadBps: 0, control: workControl, concurrency: 1,
        tokenReferences: () => tokenToWethReferences(reference, weth),
        quote: async input => {
          const result = await exactSession.issueExact({ ...input, edge, executor, runtimeEvidence: [] });
          assert("amountIn" in result); return result;
        } }));
    await coordinator.prepareCoarsePricing({ graph, deadlineAtMs: control.deadlineAtMs });
    const published = coordinator.latestPricingSnapshot(); assert(published);
    const edgeId = blockScanEdgeKey(edge);
    report.raw = { mid: published.mids.get(edgeId), coverage: published.coverage };
    const effective = published.effectiveMids?.rows.get(edgeId);
    report.effective = effective; save();
    assert(published.effectiveMids?.complete && effective?.status === "quoted");
    assert.equal(graph.scannerEdgeCount, 0, "pricing does not release standing-position policy");
    const row = prices.pricing.effectiveMids.rows.entries.map((pair: any[]) => pair[1])
      .find((r: any) => r.status === "quoted" && r.tokenIn.toLowerCase() === descriptor.supplyToken.toLowerCase());
    assert(row, "no production amount reference for collateral token; do not invent P");
    const productionAmount = BigInt(row.amountIn.value); report.referenceRow = row;
    for (const [label, amountIn] of [["production-effective", effective.amountIn!], ["original-tx-input", txAmountIn]] as const) {
      report.stage = label; save(); console.log(`Fluid ${label}: quote started`);
      const quote = await executeCreditRiskQuote({ family, route, collateralAmount: amountIn, debtBps: 10000n,
        executor, runtimeEvidence: [], source, generation: source.generation, runtime, control });
      const evidence: any = { label, amountIn, quote }; report.rows.push(evidence); save();
      if (quote.status !== "resolved") throw new Error(quote.reasonCode);
      const exact = await exactSession.issueExact({ edge, amountIn, executor, runtimeEvidence: [], control });
      assert("amountIn" in exact); assert.equal(exact.amountOut, quote.amountOut);
      if (label === "production-effective") assert.equal(exact.amountOut, effective.amountOut);
      evidence.exact = { amountIn: exact.amountIn, amountOut: exact.amountOut, source: exact.source };
      const handle = issueCreditExecutionHandle({ family, route, risk: quote, minAmountOut: quote.amountOut,
        executor, runtimeEvidence: [], source, generation: source.generation });
      const execution = buildCreditExecutionFragment({ family, actionOwnership: catalog, handle });
      if (execution.status !== "resolved") throw new Error(execution.reasonCode);
      const nodes: ResolvedPlanNode[] = execution.fragment.requirements.map(r => {
        assert.equal(r.kind, "approve"); if (r.kind !== "approve") throw new Error("unexpected requirement");
        return { adapterId: "erc20-approve", target: r.token, tokenIn: r.token, tokenOut: r.token, amount: r.amount,
          params: { spender: r.spender, amount: r.amount }, children: [] };
      });
      nodes.push(...execution.fragment.nodes);
      const actions = [...plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
      const wire = nodes.map(node => {
        const action = actions.find(a => a.id === node.adapterId); assert(action);
        const data = action.encode(node, executor, new Uint8Array()); assert.equal(data[0], 0);
        assert.equal(((data[21] << 16) | (data[22] << 8) | data[23]) + 24, data.length);
        return { caller: { kind: "executor" as const }, to: ethers.hexlify(data.slice(1, 21)), data: ethers.hexlify(data.slice(24)) };
      });
      const request: Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }> = {
        id: `encoded:${label}`, kind: "effect-delta-simulation", preCalls: wire.slice(0, -1),
        call: { ...wire.at(-1)!, executionMode: "impersonated-call-frame" },
        overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: descriptor.supplyToken, amount: amountIn }] },
        observe: ["return-data", "token-delta"], observeTokenBalances: [descriptor.supplyToken, descriptor.borrowToken]
          .map(token => ({ token, account: executor })) };
      evidence.request = request; save();
      const result = await simulation.transport.simulate({ request, source, control, callerAuthority: { executor, transactionOrigin } });
      evidence.execution = result; save();
      const delta = (token: string) => result.effects?.tokenDeltas?.find(d => d.token.toLowerCase() === token.toLowerCase() && d.account.toLowerCase() === executor.toLowerCase())?.delta;
      assert.equal(delta(descriptor.supplyToken), -amountIn); assert.equal(delta(descriptor.borrowToken), quote.amountOut);
      evidence.parity = true; console.log(JSON.stringify({ label, amountIn: String(amountIn), amountOut: String(quote.amountOut), parity: true })); save();
    }
    const canonical = await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]);
    assert.equal(canonical.hash, source.hash); report.complete = true; report.stage = "complete";
  } catch (error) {
    report.failure = String(error instanceof Error ? error.message : error).replaceAll(rpcUrl, "[RPC_REDACTED]");
    process.exitCode = 1; console.error(report.failure);
  } finally { await simulation.closeAndDrain(); save(); }
}
if (process.argv.includes("--run")) await run();
