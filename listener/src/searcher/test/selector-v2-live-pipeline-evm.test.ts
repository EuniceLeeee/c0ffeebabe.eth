import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { ContractFactory, Interface, JsonRpcProvider, MaxUint256, getBytes, hexlify, keccak256, toBeHex, type Contract } from "ethers";
import { register, listAll } from "../../adapters/registry.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { defineSelectorFamilyModule } from "../venues/selector-family-module.js";
import { normalizeSelectorNativeExecutionDefinition } from "../venues/selector-native-definition.js";
import { createSelectorNativeRuntime } from "../venues/selector-native-runtime.js";
import { selectorNativeFundingCandidateFromCensus, normalizeSelectorNativeFundingDefinition } from "../venues/selector-native-funding-definition.js";
import { definedFamilyPluginContractSummary, type UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { createNodeStrictSourceSimulation } from "../node-strict-source-simulation.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createBlockScanStartupExecutionPreflight } from "../blockscan-startup-execution-preflight.js";
import { compileStartupPrefix, startupPrefixReceipts } from "../simulator/startup-prefix-program.js";
import { HOP_DIAGNOSTIC_SLOT } from "../simulator/direct-revert-hop.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { buildEffectiveMids, effectiveEnumerationMids, effectiveRowExecutionVerified } from "../blockscan-effective-mid.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { scanBlockStateFromResolvedMids } from "../detector/blockscan-scanner-core.js";
import { TemplatePlanner } from "../planner/planner.js";
import { AnvilSolver } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { createFinalSimulationWorkRuntime } from "../final-simulation-work-runtime.js";
import { maybeSubmitBlockScanAtomic, resolveBlockScanAtomicPolicy } from "../main.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { StartupNodeInvocation, StartupNodeSimulation } from "../blockscan-startup-node-simulation.js";
import type { PathTemplate } from "../templates/path-template.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";

const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item);

/** A local EVM regression of the real pipeline, not mainnet acceptance.
 * No route/edge or successful quote is hand-authored: historical mined calls
 * enter the v2 module, lifecycle, graph, startup, scanner, planner and Solver.
 * The only startup transport is snapshot -> real transaction -> real logs ->
 * rollback. It makes no claim about a provider's eth_simulateV1 support. */
test("minimal v2 swap and selector funding reach natural enumeration, Solver and mandatory final SIM/EV", {
  skip: process.env.SELECTOR_V2_PIPELINE_EVM_TEST !== "1", timeout: 300_000,
}, async t => {
  const require = createRequire(import.meta.url), solc = require(process.env.OBSERVED_CALL_SOLC_MODULE ?? "solc");
  const root = new URL("../../../../", import.meta.url);
  const fixture = "listener/src/searcher/test/fixtures/SelectorV2Pipeline.sol";
  const fundingFixture = "listener/src/searcher/test/fixtures/SelectorFunding.sol";
  const files = ["src/BotVM.sol", "src/Constants.sol", "src/RuntimeAmountVM.sol", "src/RuntimeAmountKernel.sol",
    "src/RuntimeCallSequence.sol", "src/interfaces/IERC20.sol", fixture, fundingFixture];
  const compiled = JSON.parse(solc.compile(json({ language: "Solidity",
    sources: Object.fromEntries(files.map(file => [file, { content: readFileSync(new URL(file, root), "utf8") }])),
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } })));
  assert.deepEqual((compiled.errors ?? []).filter((e: any) => e.severity === "error"), []);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.env.OBSERVED_CALL_ANVIL_BIN ?? "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--hardfork", "cancun",
      "--disable-code-size-limit", "--gas-limit", "60000000", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let spawnError: Error | undefined; child.once("error", error => { spawnError = error; });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const methods = new Map<string, number>();
  const allowed = new Set(["eth_getBlockByHash", "eth_chainId", "eth_getCode", "eth_call", "eth_createAccessList", "eth_getStorageAt"]);
  const proxy = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(), query = JSON.parse(body);
    methods.set(query.method, (methods.get(query.method) ?? 0) + 1);
    if (!allowed.has(query.method)) {
      res.end(json({ jsonrpc: "2.0", id: query.id, error: { code: -32601, message: "local read-only no-trace source" } })); return;
    }
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      res.statusCode = response.status; res.end(await response.text());
    } catch { res.statusCode = 502; res.end("{}"); }
  });
  let sourceSimulation: ReturnType<typeof createNodeStrictSourceSimulation> | undefined;
  let state: AnvilStateBackend | undefined;
  let finalRuntime: ReturnType<typeof createFinalSimulationWorkRuntime<null, ResolvedPlan, SimulationResult>> | undefined;
  const savedDryRun = process.env.SEARCHER_DRY_RUN, savedSubmit = process.env.SEARCHER_BLOCKSCAN_SUBMIT;
  process.env.SEARCHER_DRY_RUN = "1"; process.env.SEARCHER_BLOCKSCAN_SUBMIT = "0";
  t.after(async () => {
    finalRuntime?.close(); await sourceSimulation?.closeAndDrain();
    if (proxy.listening) await new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); });
    state?.provider.destroy(); provider.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await stopped;
    }
    if (savedDryRun === undefined) delete process.env.SEARCHER_DRY_RUN; else process.env.SEARCHER_DRY_RUN = savedDryRun;
    if (savedSubmit === undefined) delete process.env.SEARCHER_BLOCKSCAN_SUBMIT; else process.env.SEARCHER_BLOCKSCAN_SUBMIT = savedSubmit;
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (spawnError) throw spawnError;
    try { if (await provider.send("eth_chainId", []) === "0x7a69") { ready = true; break; } } catch { /* local process startup */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready);
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const owner = await provider.getSigner(0), actor = await provider.getSigner(1);
  const origin = (await owner.getAddress()).toLowerCase(), actorAddress = (await actor.getAddress()).toLowerCase();
  const deploy = async (file: string, name: string): Promise<Contract> => {
    const artifact = compiled.contracts[file][name];
    const instance = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, owner).deploy();
    await instance.waitForDeployment(); return instance as unknown as Contract;
  };
  const send = async (contract: Contract, method: string, args: readonly unknown[]) => {
    const tx = await contract.getFunction(method)(...args), receipt = await tx.wait();
    assert.equal(receipt?.status, 1); return { tx, receipt };
  };
  const weth = ADDR.WETH.toLowerCase();
  await provider.send("anvil_setCode", [weth, `0x${compiled.contracts[fixture].SelectorV2Token.evm.deployedBytecode.object}`]);
  const wethContract = new (await import("ethers")).Contract(weth, compiled.contracts[fixture].SelectorV2Token.abi, owner);
  const token = await deploy(fixture, "SelectorV2Token"), manager = await deploy(fixture, "SelectorV2PoolManager");
  const lender = await deploy(fundingFixture, "SelectorFundingProvider"), borrower = await deploy(fixture, "SelectorV2HistoricalBorrower");
  const executor = await deploy("src/BotVM.sol", "BotVM");
  const asset = (await token.getAddress()).toLowerCase(), target = (await manager.getAddress()).toLowerCase();
  const lenderAddress = (await lender.getAddress()).toLowerCase(), borrowerAddress = (await borrower.getAddress()).toLowerCase();
  const executorAddress = (await executor.getAddress()).toLowerCase();
  const firstPool = toBeHex(1, 32), secondPool = toBeHex(2, 32);
  await send(manager, "setPool", [firstPool, weth, asset, 2, 1]);
  await send(manager, "setPool", [secondPool, asset, weth, 3, 5]);
  for (const receiver of [target, actorAddress]) {
    await send(wethContract, "mint", [receiver, 10n ** 25n]); await send(token, "mint", [receiver, 10n ** 25n]);
  }
  await send(wethContract, "mint", [lenderAddress, 10n ** 21n]);
  await send(wethContract, "mint", [borrowerAddress, 100n]);
  await send(wethContract, "mint", [executorAddress, 17n]); await send(token, "mint", [executorAddress, 23n]);
  await send(lender, "configure", [10n ** 15n, 0]);
  await send(wethContract.connect(actor) as Contract, "approve", [target, MaxUint256]);
  await send(token.connect(actor) as Contract, "approve", [target, MaxUint256]);
  const swapSignature = "function swap(bytes32 poolId,address tokenIn,address tokenOut,uint256 amountIn,uint256 minimumOut,address recipient) returns(uint256)";
  const swapAbi = new Interface([swapSignature]), swapSelector = swapAbi.getFunction("swap")!.selector;
  const swapDocument = { selector: swapSelector, signature: swapSignature,
    parameters: [{ path: [0], role: "poolId" }, { path: [1], role: "tokenIn" }, { path: [2], role: "tokenOut" },
      { path: [3], role: "amountIn" }, { path: [4], role: "minimumOut" }, { path: [5], role: "recipient" }], payment: { kind: "approval" } };
  const censusFor = (call: { tx: any; receipt: any }, to: string, input: string) => readySelectorCensusFromTransaction({
    chain_id: 31337, tx_hash: call.tx.hash, block_number: call.receipt.blockNumber, block_hash: call.receipt.blockHash,
    transaction_index: call.receipt.index, receipt_status: 1, from: actorAddress, to, input,
    logs: call.receipt.logs.map((log: any) => ({ address: log.address, topics: log.topics, data: log.data, log_index: log.index })),
    traces: [] }, { chainId: 31337 });
  const observations = [];
  for (const args of [[firstPool, weth, asset, 1000n, 0n, actorAddress], [secondPool, asset, weth, 2000n, 0n, actorAddress]]) {
    const mined = await send(manager.connect(actor) as Contract, "swap", args);
    observations.push(censusFor(mined, target, swapAbi.encodeFunctionData("swap", args)));
  }
  const fundingRaw = JSON.parse(readFileSync(new URL("../venues/selector-native/selector-5c38449e-family/selector-5c38449e.json", import.meta.url), "utf8"));
  const fundingDefinition = normalizeSelectorNativeFundingDefinition(fundingRaw), fundingAbi = new Interface([fundingDefinition.signature]);
  const fundingArgs = [borrowerAddress, [weth], [1000n], "0x"];
  const fundingCall = await send(lender.connect(actor) as Contract, "flashLoan(address,address[],uint256[],bytes)", fundingArgs);
  const fundingCensus = censusFor(fundingCall, lenderAddress, fundingAbi.encodeFunctionData("flashLoan", fundingArgs));
  const fundingCandidate = selectorNativeFundingCandidateFromCensus(fundingDefinition, fundingCensus, fundingCensus.calls[0]!.id);
  assert(fundingCandidate); assert.equal(fundingCandidate.provider, lenderAddress);
  await provider.send("evm_mine", []);
  const header = await provider.send("eth_getBlockByNumber", ["latest", false]);
  const source: CanonicalSource = { number: Number(BigInt(header.number)), hash: header.hash, generation: 1 };
  const control = { signal: AbortSignal.timeout(180_000), deadlineAtMs: Date.now() + 180_000 };
  const modules = [defineSelectorFamilyModule(swapDocument), defineSelectorFamilyModule(fundingRaw)];
  const plugins = modules.map(module => module.plugin);
  const entries = plugins.flatMap(plugin => FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId,
    capability, contractVersion: "selector-family/v2-local-regression", contentHash: hashCanonical({ family: plugin.manifest.familyId, capability }),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: null })));
  const catalog = new FamilyCapabilityCatalog({ modules: plugins.map((plugin, i) => ({ sourceFile: `fixture/v2-${i}.production.ts`, plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash })),
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  for (const action of plugins.flatMap(plugin => plugin.actionAdapters)) if (!listAll().some(existing => existing.id === action.id)) register(action);
  const executorCode = await provider.send("eth_getCode", [executorAddress, { blockHash: source.hash, requireCanonical: true }]);
  sourceSimulation = createNodeStrictSourceSimulation({ identity: { source, chainId: 31337, rpcUrl: proxyUrl, stateRoot: header.stateRoot },
    timeoutMs: 60_000, executionGasLimit: 0x1000000, control, executor: executorAddress,
    executorRuntimeCode: { code: executorCode, keccak256: keccak256(executorCode) }, tracePolicy: "forbid",
    onFatal(reason) { throw new Error(json(reason)); } });
  let exactSimulations = 0, bindingReads = 0;
  const pin = { blockHash: source.hash, requireCanonical: true };
  const runtime = createStrictCentralAdapterRuntime({ executor: executorAddress, transactionOrigin: origin,
    simulator: { ...sourceSimulation.transport, async simulate(input) { exactSimulations++; return sourceSimulation!.transport.simulate(input); } },
    generationFence: { assertCurrent(generation, observed) { assert.equal(generation, source.generation); assert.deepEqual(observed, source); } },
    provider: { call: async ({ blockTag, ...tx }, block) => { bindingReads++; assert.equal(blockTag ?? block, source.number); return provider.send("eth_call", [tx, pin]); },
      getCode: async () => assert.fail("selector admission must not read identity"), getStorage: async () => assert.fail("selector binding needs no storage") } });
  const swapPlugin = plugins[0]!, fundingPlugin = plugins[1]!;
  const calls: UnifiedObservation[] = observations.map(census => ({ kind: "call", source,
    evidenceSource: { number: census.blockNumber!, hash: census.blockHash!, generation: 1 }, target, sender: actorAddress,
    data: census.calls[0]!.calldata!, transactionHash: census.transactionHash!, opaque: { selectorCensus: census, callId: census.calls[0]!.id } as any }));
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: swapPlugin.manifest.familyId, source, observations: calls, runtime });
  assert.equal(publication.instances.length, 2, json(publication.outcomes)); assert.equal(bindingReads, 0); assert.equal(exactSimulations, 0);
  const graph = buildFamilyRouteGraphView({ routes: publication.instances.flatMap(instance => instance.routes.map(route => ({
    family: catalog.forFamily(swapPlugin.manifest.familyId), descriptor: instance.descriptor, route,
    handle: instance.routeHandles.find(handle => handle.routeKey === route.routeKey)! }))) });
  assert.equal(graph.edges.length, 2); assert.equal(new Set(graph.edges.map(edge => edge.stateResourceKey)).size, 2);
  const strictRoot = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: graph.edges, readyInstances: publication.instances,
    readyFundingAssets: fundingCandidate.fundingBindings.map(binding => ({ familyId: fundingPlugin.manifest.familyId, asset: binding.asset, binding })) });
  const session = await strictRoot.createSession({ source, runtime, fundingAssets: [weth], control });
  assert.equal(exactSimulations, 0); assert.equal(session.fundingProjection().sources.size, 1);
  let startupRuns = 0;
  const simulateStandalone = Object.assign(async (invocation: StartupNodeInvocation) => {
    assert.deepEqual(invocation.source, source);
    const snapshot = await provider.send("evm_snapshot", []);
    try {
      const prefix = compileStartupPrefix(invocation, executorAddress);
      await provider.send("anvil_setCode", [prefix.recorder, prefix.recorderCode]);
      await provider.send("anvil_setBalance", [executorAddress, toBeHex(invocation.amount)]);
      await provider.send("anvil_setStorageAt", [executorAddress, HOP_DIAGNOSTIC_SLOT, keccak256(prefix.scriptHex)]);
      const receipt = await (await owner.sendTransaction({ to: executorAddress, data: buildExecuteCalldata(getBytes(prefix.scriptHex)), gasLimit: 0x1000000 })).wait();
      assert.equal(receipt?.status, 1); assert(receipt); startupRuns++;
      return { kind: "success" as const, receipts: startupPrefixReceipts(receipt.logs, prefix), returnData: "0x", gasUsed: receipt.gasUsed,
        targetBlock: receipt.blockNumber, scriptHash: keccak256(prefix.scriptHex), inputFundingMode: "native-prefix" as const, simulationMs: 0, nodeQueueMs: 0 };
    } finally { assert.equal(await provider.send("evm_revert", [snapshot]), true); }
  }, { stats: () => ({ requests: startupRuns, retries: 0, simulations: startupRuns, headers: 0, maxCuIn1000Ms: 0 }) }) satisfies StartupNodeSimulation;
  const startup = createBlockScanStartupExecutionPreflight({ executor: executorAddress, transactionOrigin: origin,
    simRejects: new BlockScanSimRejectCache(), concurrency: 1, simulateStandalone });
  const pricing = { sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation, graph: { edges: [...graph.edges] },
    mids: new Map(), coverage: { resolvedEdgeKeys: [] }, pricingStateKeyByEdgeKey: new Map(graph.edges.map(edge => [blockScanEdgeKey(edge), edge.stateResourceKey!])) };
  const prepareQuote = async () => {}, sessionFor = () => session;
  const effective = await buildEffectiveMids({ pricing, weth, fixedWethInput: 10n ** 15n, maxInputPathHops: 4, gasCostWei: null,
    enumerationSpreadBps: 0, control, concurrency: 1, prepareQuote, quote: async request => {
      const quote = await startup.quoteEffective({ ...request, control, edges: graph.edges, prepareQuote, sessionFor }); assert(quote); return quote;
    } });
  for (const edge of graph.edges) assert(effectiveRowExecutionVerified(effective, effective.rows.get(blockScanEdgeKey(edge))!, edge));
  const runsForPrices = startupRuns;
  await startup.run({ effective, edges: graph.edges, control, prepareQuote, sessionFor });
  assert.equal(startupRuns, runsForPrices, "startup revert screening reuses its real pricing executions");
  const mids = effectiveEnumerationMids({ ...pricing, effectiveMids: effective });
  const funding = session.fundingProjection().sources, available = funding.get(weth)!;
  const scan = scanBlockStateFromResolvedMids({ edges: [...graph.edges], mids, sourceBlock: source.number, swapTouched: null,
    cfg: { enumerationBackend: "typescript", enumerationMethod: "joint-dfs", allowRepeatedPools: false, allowRepeatedTokens: false,
      deduplicateRotations: true, prefixPruningEnabled: false, hopPoolsPerPair: 0, hopTokensPerStep: 0, ethSignalPairsPerToken: 100,
      maxHops: 4, minSpreadBps: 1, maxCandidates: 100, budgetMs: 5000, pricedTokens: new Map([[weth, { maxBorrow: available.amount }]]) } });
  assert.equal(scan.selection.forcedSelectionCount, 0); assert(scan.opportunities.length > 0, json(scan));
  const valuation = { source, canValue: (address: string) => address.toLowerCase() === weth,
    valueInEth: (address: string, amount: bigint) => address.toLowerCase() === weth ? amount : null };
  const planner = new TemplatePlanner(); planner.setGraph([...graph.edges]); planner.setMaxHops(4);
  planner.setFlashLiquidity({ borrowable: address => funding.get(address.toLowerCase())?.amount ?? 0n,
    source: address => funding.get(address.toLowerCase()) ?? null }); planner.setProfitTokenValuation(valuation);
  const template: PathTemplate = { name: "v2-generic-cycle", slots: [
    { id: "flash", kind: "flash", adapters: [...fundingPlugin.manifest.ownedActionAdapterIds] },
    { id: "swap", kind: "swap", adapters: [...swapPlugin.manifest.ownedActionAdapterIds], min: 1, max: 4 },
    { id: "repay", kind: "repay", adapters: ["erc20-transfer", "erc20-approve"] }, { id: "guard", kind: "guard", adapters: ["assert-balance"] }],
    constraints: [{ type: "token-continuity" }, { type: "final-token-equals-start-token" }] };
  const opportunity = scan.opportunities[0]!;
  const plans = await planner.plan(opportunity, [template], { deadlineAtMs: control.deadlineAtMs }); assert(plans.length > 0);
  state = new AnvilStateBackend(rpcUrl, rpcUrl, port);
  const simulator = new BotVMSimulator(state, executorAddress, origin);
  const resolved = await new AnvilSolver().solve(plans[0]!, state, { executor: executorAddress, simulate: plan => simulator.simulate(plan) },
    { strictSession: session, signal: control.signal, deadlineAtMs: control.deadlineAtMs, deferPhase2Sim: true, quoteToleranceRawUnits: 0n });
  assert(resolved.flashAmount > 0n); assert(exactSimulations > 0);
  let finalSimulations = 0;
  finalRuntime = createFinalSimulationWorkRuntime<null, ResolvedPlan, SimulationResult>({ reservedResources: [{ id: "local-final-sim", value: null }],
    runner: { async simulate(input) { finalSimulations++; assert.deepEqual(input.source, source); return simulator.simulate(input.resolvedPlan, input.signal); } },
    generationFence: { assertCurrent(generation, observed) { assert.equal(generation, source.generation); assert.deepEqual(observed, source); } },
    planIdentity: { bytesHex: plan => hexlify(compilePlan(plan.root, executorAddress)), resultBytesHex: result => result.scriptHex! },
    parentSignal: control.signal, timeoutMs: 60_000, maxQueued: 1 });
  const result = await maybeSubmitBlockScanAtomic({ config: { ...resolveBlockScanAtomicPolicy({ SEARCHER_ENABLE_BACKRUN: "0", SEARCHER_EV_GATE: "1" }),
      dryRun: true, blockScanSubmit: false, finalVerifyFloorBps: 0n }, provider, finalSimulationRuntime: finalRuntime,
    sourceGeneration: source.generation, sourceBlock: source.number, sourceBlockHash: source.hash, opp: opportunity, resolved,
    ring: "local-v2-cycle", protoRing: false, plans: plans.length, passDeadlineAtMs: control.deadlineAtMs,
    simRejects: new BlockScanSimRejectCache(), profitTokenValuation: valuation, signal: control.signal, collectBlindAudit: true,
    bundleRouter: { submit: async () => assert.fail("local regression never submits") },
    submissionCoordinator: { offer: () => assert.fail("submission is disabled") },
    strategyVersions: { strategy_view_version: "local-v2", blockscan_view_hash: source.hash } });
  assert.equal(finalSimulations, 1); assert.equal(result.finalSimStatus, "succeeded", json(result));
  assert.equal(result.decision, "blockscan_submit_disabled", json(result)); assert.equal(result.audit?.ev.reason, "ev_gate_pass", json(result));
  assert(![...methods.keys()].some(method => /^(trace_|debug_)/.test(method)));
  assert.equal((await provider.send("eth_getBlockByNumber", ["latest", false])).hash, source.hash);
  await t.test("migrated basket runs nested conservation guards on EVM and rolls back side-output faults", async () => {
    const basket = await deploy(fixture, "SelectorV2Basket"), module = await deploy(fixture, "SelectorV2BasketModule");
    const components: Contract[] = [];
    for (let i = 0; i < 16; i++) components.push(await deploy(fixture, "SelectorV2BasketAsset"));
    const assets = await Promise.all(components.map(component => component.getAddress().then(address => address.toLowerCase())));
    const basketAddress = (await basket.getAddress()).toLowerCase(), moduleAddress = (await module.getAddress()).toLowerCase();
    await send(basket, "configure", [assets, 0]); await send(basket, "mint", [executorAddress, 100n]);
    for (const component of components) {
      await send(component, "mint", [executorAddress, 7n]); await send(component, "mint", [actorAddress, 5n]);
    }
    const raw = JSON.parse(readFileSync(new URL("../venues/selector-native/selector-5c833bfd-family/selector-5c833bfd.json", import.meta.url), "utf8"));
    const recipe = raw.programs.find((program: any) => program.meta?.migrationKey === "typed:set:basic-basket"); assert(recipe);
    const definition = normalizeSelectorNativeExecutionDefinition({ ...raw, programs: [recipe] });
    const runtime = createSelectorNativeRuntime(definition, definition.programs[0]!);
    const leg = runtime.buildRuntimeLeg({ descriptor: { target: moduleAddress, set: basketAddress, components: assets,
        componentRows: assets.map((token, index) => ({ token, index })) },
      route: { target: moduleAddress, tokenIn: basketAddress, tokenOut: assets[0]!, adapterId: runtime.actionId },
      executor: executorAddress, source, runtimeEvidence: [], settlement: { kind: "direct-output", recipient: actorAddress } }); assert(leg);
    const transaction = { to: executorAddress, data: buildExecuteCalldata(runtimeProgramScript(getBytes(leg.program), 7n)), gasLimit: 16_000_000 };
    const clean = await provider.send("evm_snapshot", []);
    const receipt = await (await owner.sendTransaction(transaction)).wait(); assert.equal(receipt?.status, 1);
    assert.equal(await basket.getFunction("balanceOf")(executorAddress), 93n);
    assert.equal(await components[0]!.getFunction("balanceOf")(executorAddress), 7n);
    assert.equal(await components[0]!.getFunction("balanceOf")(actorAddress), 12n);
    assert.equal(await components[15]!.getFunction("balanceOf")(executorAddress), 119n);
    assert.equal(await module.getFunction("calls")(), 1n);
    assert.equal(await provider.send("evm_revert", [clean]), true);
    for (const fault of ["short-component", "side-theft-during-handoff"]) {
      await send(basket, "configure", [assets, fault === "short-component" ? 1 : 2]);
      await send(components[0]!, "setSabotage", [fault === "side-theft-during-handoff" ? assets[15]! : toBeHex(0, 20)]);
      await assert.rejects(async () => (await owner.sendTransaction(transaction)).wait());
      assert.equal(await module.getFunction("calls")(), 0n, "reverted EVM changes cannot survive the guard");
      assert.equal(await basket.getFunction("balanceOf")(executorAddress), 100n);
      assert.equal(await components[15]!.getFunction("balanceOf")(executorAddress), 7n);
      assert.equal(await components[0]!.getFunction("balanceOf")(actorAddress), 5n);
    }
  });
  t.diagnostic(json({ scope: "local-EVM-regression", minimalSwap: true, identityReads: 0, readySimulations: 0,
    generatedEdges: graph.edges.length, physicalPools: new Set(graph.edges.map(edge => edge.stateResourceKey)).size,
    pricedRows: mids.size, startupExecutions: runsForPrices, naturallyEnumerated: scan.opportunities.length,
    forcedSelection: 0, plans: plans.length, exactSimulations, selectedAmount: resolved.flashAmount,
    finalSimulations, finalDecision: result.decision, ev: result.audit?.ev.reason,
    sourceTransport: "read-only-no-trace", startupTransport: "isolated-local-EVM-receipts", broadcast: false }));
});
