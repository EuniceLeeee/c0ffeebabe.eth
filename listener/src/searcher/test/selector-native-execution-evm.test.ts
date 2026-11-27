import { fileURLToPath } from "node:url";
import { definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { defineSelectorFamilyModule } from "../venues/selector-family-module.js";
import { normalizeSelectorNativeExecutionDefinition } from "../venues/selector-native-definition.js";
import { selectSingleExecution } from "../venues/selector-program-role.js";
import { readSelectorSourceIdentity, createSelectorIdentityRequestReader } from "../venues/selector-source-identity.js";
import { selectorNativeSourceIdentityCandidate } from "../venues/selector-native-discovery.js";
import { hashCanonical } from "../venues/canonical-value.js";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { ContractFactory, Interface, JsonRpcProvider, MaxUint256, getBytes, hexlify, keccak256, toBeHex, type Contract } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createNodeStrictSourceSimulation } from "../node-strict-source-simulation.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { RevmStrictError } from "../revm-sim-client.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import { buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg, executeFamilyExactQuote } from "../venues/adapter-family-runtime.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash, asPricedFamily } from "../venues/family-capability-catalog.js";
import { compileStartupPrefix, startupPrefixReceipts, startupPrefixFailure } from "../simulator/startup-prefix-program.js";
import { HOP_DIAGNOSTIC_SLOT } from "../simulator/direct-revert-hop.js";
import { createBlockScanStartupExecutionPreflight } from "../blockscan-startup-execution-preflight.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { buildEffectiveMids, effectiveRowExecutionVerified } from "../blockscan-effective-mid.js";
import type { StartupNodeInvocation, StartupNodeSimulation } from "../blockscan-startup-node-simulation.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";

const stringify = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item);

/** Real EVM + existing NodeStrictClient transport + ordinary strict lifecycle.
 * Only a newly spawned loopback chain is accepted. External RPC is not an input.
 * Development tools use the same optional paths as the existing observed test. */
test("native selector EVM binds Ready without SIM, prices once through funded startup, and preserves Exact encoded execution", {
  skip: process.env.SELECTOR_NATIVE_EVM_TEST !== "1", timeout: 240_000,
}, async t => {
  const require = createRequire(import.meta.url), solc = require(process.env.OBSERVED_CALL_SOLC_MODULE ?? "solc");
  const root = new URL("../../../../", import.meta.url);
  const tokenFixture = "listener/src/searcher/test/fixtures/SelectorExecutionFixture.sol";
  const fixture = "listener/src/searcher/test/fixtures/SelectorProgramFixture.sol";
  const fundingFixture = "listener/src/searcher/test/fixtures/FundingPreparationToken.sol";
  const files = ["src/BotVM.sol", "src/Constants.sol", "src/RuntimeAmountVM.sol", "src/RuntimeAmountKernel.sol",
    "src/RuntimeCallSequence.sol", "src/interfaces/IERC20.sol", tokenFixture, fixture, fundingFixture];
  const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity",
    sources: Object.fromEntries(files.map(file => [file, { content: readFileSync(new URL(file, root), "utf8") }])),
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } },
  })));
  const errors = (output.errors ?? []).filter((error: { severity: string }) => error.severity === "error");
  assert.deepEqual(errors, [], stringify(errors));
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address(); assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.env.OBSERVED_CALL_ANVIL_BIN ?? "anvil",
    // Existing BotVM exceeds EIP-170 under these repository settings. Only
    // this local fixture relaxes the limit; no deployment verdict is implied.
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--hardfork", "cancun", "--disable-code-size-limit", "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] });
  let startupError: Error | undefined, stderr = "";
  child.once("error", error => { startupError = error; });
  child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-2000); });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const contexts: ReturnType<typeof createNodeStrictSourceSimulation>[] = [];
  const rpcCounts = new Map<string, number>();
  const allowed = new Set(["eth_getBlockByHash", "eth_chainId", "eth_getCode", "eth_call", "eth_createAccessList", "eth_getStorageAt"]);
  const proxy = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(), query = JSON.parse(body);
    rpcCounts.set(query.method, (rpcCounts.get(query.method) ?? 0) + 1);
    if (!allowed.has(query.method)) {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: query.id, error: { code: -32601, message: "read-only trace-forbidden local proxy" } })); return;
    }
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(10_000) });
      res.statusCode = response.status; res.end(await response.text());
    } catch { res.statusCode = 502; res.end("{}"); }
  });
  const priorDryRun = process.env.SEARCHER_DRY_RUN, priorSubmit = process.env.SEARCHER_BLOCKSCAN_SUBMIT;
  process.env.SEARCHER_DRY_RUN = "1"; process.env.SEARCHER_BLOCKSCAN_SUBMIT = "0";
  t.after(async () => {
    try { await Promise.allSettled(contexts.map(context => context.closeAndDrain())); }
    finally {
      if (proxy.listening) await new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); });
      provider.destroy();
      if (priorDryRun === undefined) delete process.env.SEARCHER_DRY_RUN; else process.env.SEARCHER_DRY_RUN = priorDryRun;
      if (priorSubmit === undefined) delete process.env.SEARCHER_BLOCKSCAN_SUBMIT; else process.env.SEARCHER_BLOCKSCAN_SUBMIT = priorSubmit;
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
        child.kill("SIGKILL"); await closed;
      }
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`local anvil stopped: ${stderr}`);
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(500) });
      const body = await response.json() as { result?: string };
      if (body.result === "0x7a69") { ready = true; break; }
    } catch { /* The only retry is startup of this newly spawned local chain. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, `local anvil did not start: ${stderr}`);
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const owner = await provider.getSigner(0), oldActor = await provider.getSigner(1);
  const origin = (await owner.getAddress()).toLowerCase(), oldAddress = (await oldActor.getAddress()).toLowerCase();
  await provider.send("anvil_setCode", [ADDR.WETH,
    `0x${output.contracts[fundingFixture].FundingPreparationToken.evm.deployedBytecode.object}`]);
  async function deploy(file: string, name: string, args: readonly unknown[] = []): Promise<Contract> {
    const artifact = output.contracts[file][name];
    const deployed = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, owner).deploy(...args);
    await deployed.waitForDeployment(); return deployed as unknown as Contract;
  }
  async function send(contract: Contract, method: string, args: readonly unknown[]) {
    const tx = await contract.getFunction(method)(...args), receipt = await tx.wait();
    assert.equal(receipt?.status, 1); return { tx, receipt };
  }
  const asset = await deploy(fixture, "SelectorProgramToken", [18]);
  const gem = await deploy(fixture, "SelectorProgramToken", [6]);
  const dai = await deploy(fixture, "SelectorProgramToken", [18]);
  const executor = await deploy("src/BotVM.sol", "BotVM");
  const vault = await deploy(fixture, "SelectorProgramVault", [await asset.getAddress()]);
  const psm = await deploy(fixture, "SelectorProgramPsm", [await gem.getAddress(), await dai.getAddress()]);
  const executorAddress = (await executor.getAddress()).toLowerCase();
  const vaultAddress = (await vault.getAddress()).toLowerCase(), psmAddress = (await psm.getAddress()).toLowerCase();
  for (const receiver of [oldAddress, executorAddress]) {
    await send(asset, "issue", [receiver, 10n ** 24n]);
    await send(dai, "issue", [receiver, 10n ** 24n]);
    await send(vault, "issue", [receiver, 10n ** 24n]);
  }
  await send(asset, "issue", [vaultAddress, 10n ** 25n]);
  await send(gem, "issue", [psmAddress, 10n ** 18n]);
  await send(asset.connect(oldActor) as Contract, "approve", [vaultAddress, MaxUint256]);
  await send(dai.connect(oldActor) as Contract, "approve", [psmAddress, MaxUint256]);
  const cases = [
    { contract: vault, target: vaultAddress, method: "withdraw", args: [1001n, oldAddress, oldAddress], selector: "b460af94", amountIn: 888n, output: 592n },
    { contract: vault, target: vaultAddress, method: "mint", args: [1000n, oldAddress], selector: "94bf804d", amountIn: 777n, output: 1165n },
    { contract: psm, target: psmAddress, method: "buyGem", args: [oldAddress, 1000000n], selector: "8d7ef9bb", amountIn: 10n ** 18n + 123n, output: 1000000n },
  ];
  const censuses = [];
  for (const row of cases) {
    const { tx, receipt } = await send(row.contract.connect(oldActor) as Contract, row.method, row.args);
    censuses.push(readySelectorCensusFromTransaction({ chain_id: 31337, tx_hash: tx.hash,
      block_number: receipt.blockNumber, block_hash: receipt.blockHash, transaction_index: receipt.index,
      receipt_status: 1, from: oldAddress, to: row.target, input: row.contract.interface.encodeFunctionData(row.method, row.args),
      logs: receipt.logs.map((log: any) => ({ address: log.address, topics: log.topics, data: log.data, log_index: log.index })), traces: [] }, { chainId: 31337 }));
  }
  await provider.send("evm_mine", []);
  const header = await provider.send("eth_getBlockByNumber", ["latest", false]);
  const source: CanonicalSource = { number: Number(BigInt(header.number)), hash: header.hash, generation: 2 };
  const executorCode = await provider.send("eth_getCode", [executorAddress, { blockHash: source.hash, requireCanonical: true }]);
  const control = { signal: AbortSignal.timeout(120_000), deadlineAtMs: Date.now() + 120_000 };
  const simulation = createNodeStrictSourceSimulation({ identity: { source, chainId: 31337, rpcUrl: proxyUrl, stateRoot: header.stateRoot },
    timeoutMs: 60_000, executionGasLimit: 0x1000000, control, executor: executorAddress,
    executorRuntimeCode: { code: executorCode, keccak256: keccak256(executorCode) }, tracePolicy: "forbid",
    onFatal(reason) { throw new Error(`local simulation failed: ${stringify(reason)}`); } });
  contexts.push(simulation);
  const pin = { blockHash: source.hash, requireCanonical: true };
  let strictSimulations = 0;
  const runtime = createStrictCentralAdapterRuntime({ executor: executorAddress, transactionOrigin: origin,
    simulator: { ...simulation.transport, async simulate(input) { strictSimulations++; try { return await simulation.transport.simulate(input); }
      catch (error) { t.diagnostic(stringify({ simulationError: error instanceof Error ? { name: error.name, message: error.message,
        ...Object.fromEntries(Object.entries(error)) } : error })); throw error; } } },
    generationFence: { assertCurrent(generation, current) { assert.equal(generation, source.generation); assert.deepEqual(current, source); } },
    provider: { call: async ({ blockTag, ...tx }, n) => { assert.equal(blockTag ?? n, source.number); return provider.send("eth_call", [tx, pin]); },
      getCode: async (address, n) => { assert.equal(n, source.number); return provider.send("eth_getCode", [address, pin]); },
      getStorage: async (address, slot, n) => { assert.equal(n, source.number); return provider.send("eth_getStorageAt", [address, slot, pin]); } } });
  const results: unknown[] = [];
  for (const [index, row] of cases.entries()) {
    const file = fileURLToPath(new URL(`../venues/selector-native/selector-${row.selector}-family/selector-${row.selector}.json`, import.meta.url));
    const authored = normalizeSelectorNativeExecutionDefinition(JSON.parse(readFileSync(file, "utf8")));
    // These local contracts implement one exact production recipe. Additional
    // recipes sharing its ABI are covered by the alternative-candidate case
    // below; they must not silently turn this focused fixture into another one.
    const definition = authored.directState
      ? authored
      : normalizeSelectorNativeExecutionDefinition({ ...authored, programs: [authored.programs[0]] });
    const plugin = defineSelectorFamilyModule(definition).plugin, familyId = plugin.manifest.familyId;
    const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId, capability, contractVersion: "selector-family-evm-v2",
      contentHash: hashCanonical({ capability, signature: definition.signature }), semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
    const catalog = new FamilyCapabilityCatalog({ modules: [{ sourceFile: "fixture/selector-native.production.ts", plugin,
      definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
      generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
    const family = asPricedFamily(catalog.forFamily(familyId)), census = censuses[index]!;
    let observation: UnifiedObservation;
    if (definition.directState) {
      const daiAddr = (await dai.getAddress()).toLowerCase(), gemAddr = (await gem.getAddress()).toLowerCase();
      const sqlEdge = { chainId: 1 as const, selector: definition.selector, poolAddress: row.target, tokenIn: daiAddr, tokenOut: gemAddr };
      const idRes = await readSelectorSourceIdentity({
        definition, edge: sqlEdge, source,
        readRequests: createSelectorIdentityRequestReader({
          source,
          read: (to, data) => provider.send("eth_call", [{ to, data }, pin]),
          readCode: at => provider.send("eth_getCode", [at, pin]),
        }),
      });
      assert.equal(idRes.matches.length, 1, idRes.issues.join("; "));
      const candidate = selectorNativeSourceIdentityCandidate(definition, idRes.matches[0]!, sqlEdge, source, selectSingleExecution(definition).programKey);
      assert(candidate && plugin.discovery.reverseBinding?.kind === "implementation");
      const channel = await plugin.discovery.reverseBinding.reverseBinding({
        source,
        provider: {
          call: ({ blockTag, ...tx }: any, n?: number) => { assert.equal(blockTag ?? n, source.number); return provider.send("eth_call", [tx, pin]); },
          getCode: (address: string, n?: number) => { assert.equal(n, source.number); return provider.send("eth_getCode", [address, pin]); },
          getStorage: (address: string, slot: string, n?: number) => { assert.equal(n, source.number); return provider.send("eth_getStorageAt", [address, slot, pin]); },
          getLogs: async () => [],
          getTransactionReceipt: async () => null,
        } as any,
        nominations: [{ address: candidate.target, opaque: candidate as any }],
      });
      assert.equal(channel.length, 1); assert.equal(channel[0]!.status, "verified");
      observation = channel[0]!.observation;
    } else {
      observation = { kind: "call", source, evidenceSource: { number: census.blockNumber!, hash: census.blockHash!, generation: 1 },
        target: row.target, sender: oldAddress, data: census.calls[0]!.calldata!, transactionHash: census.transactionHash!,
        opaque: { selectorCensus: census, callId: census.calls[0]!.id } as any };
    }
    const beforeReady = strictSimulations;
    const publication = await runStrictFamilyLifecycle({ catalog, familyId, source, observations: [observation], runtime });
    assert.equal(publication.instances.length, 1, stringify(publication.outcomes));
    assert.equal(strictSimulations, beforeReady, "Ready binds parameters without executing an admission or price SIM");
    const instance = publication.instances[0]!, route = instance.routeHandles[0]!;
    assert("proof" in instance.descriptor && instance.descriptor.proof && typeof instance.descriptor.proof === "object");
    const proof = instance.descriptor.proof as { stage?: string; probes?: unknown };
    assert.equal(proof.stage, "complete"); assert.equal(proof.probes, undefined);
    assert(instance.pricingInstances.every(state => state.mids.size === 0 && state.unavailable.size === 0));
    const graph = buildFamilyRouteGraphView({ routes: instance.routes.map(r => ({ family: catalog.forFamily(familyId), descriptor: instance.descriptor,
      route: r, handle: instance.routeHandles.find(handle => handle.routeKey === r.routeKey)! })) });
    assert.equal(graph.edges.length, 1); assert(graph.edges[0]!.stateResourceKey);
    const edge = graph.edges[0]!;
    assert.equal(edge.executionVerification, "startup-simulation");
    const strictRoot = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: graph.edges,
      readyInstances: publication.instances, readyFundingAssets: [] });
    const session = await strictRoot.createSession({ source, runtime, fundingAssets: [], control });
    assert.deepEqual(session.currentPricingForEdge(edge), { status: "unresolved", reason: "awaiting-startup-simulation" });
    assert.equal(strictSimulations, beforeReady, "current-source preparation also leaves execution to startup");

    // The preparation leg is explicitly a local fixture: burn newly funded
    // WETH and issue the target's input token. The target leg itself is always
    // built by the actual strict session from the installed native selector program.
    const seedAbi = new Interface(["function burn(address,uint256)", "function issue(address,uint256)"]);
    const seedProgram = hexlify(new RuntimeAmountProgram()
      .call(ADDR.WETH, seedAbi.encodeFunctionData("burn", [executorAddress, 0n]), { patches: [{ offset: 36, reg: 0 }] })
      .call(edge.tokenIn, seedAbi.encodeFunctionData("issue", [executorAddress, 0n]), { patches: [{ offset: 36, reg: 0 }] }).bytes());
    const seed: TokenEdge = { tokenIn: ADDR.WETH.toLowerCase(), tokenOut: edge.tokenIn,
      adapterId: "local-fixture-input", target: edge.tokenIn, instanceKey: `local-seed:${row.selector}`,
      executionVariantKey: row.selector, canonicalEdgeId: `local-seed:${row.selector}` as TokenEdge["canonicalEdgeId"],
      slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false };
    const startupEdges = [seed, edge], prepareQuote = async () => {};
    const sessionFor = (value: TokenEdge): StrictProductionRuntimeSession => value === seed
      ? { buildRuntimeAmountLeg: () => ({ program: seedProgram }) } as unknown as StrictProductionRuntimeSession
      : session;
    let startupTransactions = 0, targetTransactions = 0;
    // Bundled Anvil does not authenticate raw eth_simulateV1 parent headers.
    // This test transport runs the production startup script on an isolated
    // snapshot, reads actual mined receipts, then restores the exact source.
    // It does not rewrite a provider response or assert V1 compatibility.
    const simulateStandalone = Object.assign(async (invocation: StartupNodeInvocation) => {
      assert.deepEqual(invocation.source, source);
      assert.deepEqual(invocation.callerAuthority, { executor: executorAddress, transactionOrigin: origin });
      const checkpoint = await provider.send("evm_snapshot", []);
      try {
        const compiled = compileStartupPrefix(invocation, executorAddress);
        const diagnosticKey = keccak256(compiled.scriptHex);
        await provider.send("anvil_setCode", [compiled.recorder, compiled.recorderCode]);
        await provider.send("anvil_setBalance", [executorAddress, toBeHex(invocation.amount)]);
        await provider.send("anvil_setStorageAt", [executorAddress, HOP_DIAGNOSTIC_SLOT, diagnosticKey]);
        startupTransactions++; if (invocation.legs.length === 2) targetTransactions++;
        const calldata = buildExecuteCalldata(getBytes(compiled.scriptHex));
        let receipt;
        try { receipt = await (await owner.sendTransaction({ to: executorAddress, data: calldata, gasLimit: 0x1000000 })).wait(); }
        catch (error) {
          const rejectedReceipt = (error as { receipt?: { status?: number; blockNumber: number; gasUsed: bigint } }).receipt;
          assert.equal(rejectedReceipt?.status, 0, "a rejected recipe must actually revert on the local EVM");
          // A mined failure does not retain revert data. Obtain its authenticated
          // diagnostic from the unchanged local state; this is a failure-only
          // diagnostic call, never a substitute price or a manufactured receipt.
          const raw = await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
            body: stringify({ jsonrpc: "2.0", id: 99, method: "eth_call", params: [
              { from: origin, to: executorAddress, data: calldata, gas: "0xffffff" }, "latest"] }) })).json() as { error?: { data?: string } };
          assert.equal(typeof raw.error?.data, "string");
          const returnData = raw.error!.data!, failure = startupPrefixFailure(returnData, undefined, diagnosticKey, compiled);
          assert(failure, "the EVM must bind the rejected hop to this exact prefix");
          return { kind: "revert" as const, receipts: [], returnData, failure, gasUsed: rejectedReceipt!.gasUsed,
            targetBlock: rejectedReceipt!.blockNumber, scriptHash: keccak256(compiled.scriptHex),
            inputFundingMode: "native-prefix" as const, simulationMs: 0, nodeQueueMs: 0 };
        }
        assert.equal(receipt?.status, 1); assert(receipt); assert.equal(receipt.blockNumber, source.number + 1);
        return { kind: "success" as const, receipts: startupPrefixReceipts(receipt.logs, compiled), returnData: "0x",
          gasUsed: receipt.gasUsed, targetBlock: receipt.blockNumber, scriptHash: keccak256(compiled.scriptHex),
          inputFundingMode: "native-prefix" as const, simulationMs: 0, nodeQueueMs: 0 };
      } finally {
        assert.equal(await provider.send("evm_revert", [checkpoint]), true);
        assert.equal((await provider.send("eth_getBlockByNumber", ["latest", false])).hash, source.hash);
      }
    }, { stats: () => ({ requests: startupTransactions, retries: 0, simulations: startupTransactions, headers: 0, maxCuIn1000Ms: 0 }) }) satisfies StartupNodeSimulation;
    const startup = createBlockScanStartupExecutionPreflight({ executor: executorAddress, transactionOrigin: origin,
      simRejects: new BlockScanSimRejectCache(), concurrency: 1, simulateStandalone });
    const effective = await buildEffectiveMids({ pricing: { sourceBlock: source.number, sourceBlockHash: source.hash,
      generation: source.generation, graph: { edges: startupEdges }, mids: new Map(), coverage: { resolvedEdgeKeys: [] },
      pricingStateKeyByEdgeKey: new Map(startupEdges.map(value => [blockScanEdgeKey(value), value.stateResourceKey ?? value.instanceKey!])) },
      weth: ADDR.WETH, fixedWethInput: row.amountIn, maxInputPathHops: 4, gasCostWei: null, enumerationSpreadBps: 0,
      control, concurrency: 1, prepareQuote, quote: async request => {
        const quoted = await startup.quoteEffective({ ...request, control, edges: startupEdges, prepareQuote, sessionFor });
        assert(quoted); return quoted;
      } });
    const startupPrice = effective.rows.get(blockScanEdgeKey(edge))!;
    assert.equal(startupPrice.status, "quoted", stringify(startupPrice));
    assert.equal(startupPrice.amountIn, row.amountIn); assert.equal(startupPrice.amountOut, row.output);
    assert(effectiveRowExecutionVerified(effective, startupPrice, edge));
    assert.equal(targetTransactions, 1); assert.equal(startupTransactions, 2);
    await startup.run({ effective, edges: startupEdges, control, prepareQuote, sessionFor });
    assert.equal(targetTransactions, 1, "screening reuses the target's pricing receipt");
    assert.equal(startupTransactions, 2); assert.equal(strictSimulations, beforeReady);
    const quote = await executeFamilyExactQuote({ family, route, amountIn: row.amountIn, executor: executorAddress,
      source, generation: source.generation, runtimeEvidence: [], runtime, control });
    assert.equal(quote.status, "resolved", stringify(quote)); if (quote.status !== "resolved") continue;
    assert.equal(quote.amountOut, row.output);
    const leg = buildFamilyRuntimeAmountLeg({ family, route, source, runtime, executor: executorAddress, runtimeEvidence: [], actionOwnership: catalog });
    assert(leg); if (row.method === "buyGem") assert.equal(leg.inputMode, "maximum");
    if (row.method === "withdraw") {
      // Doubling the legal 1502-share sample is not in this program's input
      // lattice: the preview returns 2002 assets, withdraw spends 3003 shares.
      const direct = await provider.send("eth_call", [{ from: executorAddress, to: vaultAddress,
        data: vault.interface.encodeFunctionData("withdraw", [2002n, executorAddress, executorAddress]) }, pin]);
      assert.equal(vault.interface.decodeFunctionResult("withdraw", direct)[0], 3003n);
      const outputToken = (await asset.getAddress()).toLowerCase(), callsBefore = rpcCounts.get("eth_call") ?? 0;
      const callerAuthority = runtime.callerAuthority.bind({ stage: "exact-refine", familyId,
        subject: { familyId }, subjectKey: familyId, source, callerRole: "executor" });
      await assert.rejects(() => simulation.transport.simulate({ source, control, callerAuthority, request: {
        id: "off-lattice-amount", kind: "effect-delta-simulation", call: { caller: { kind: "executor" }, executionMode: "executor-program",
          to: executorAddress, data: buildSubscriptCalldata(runtimeProgramScript(getBytes(leg.program), 3004n)) },
        overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: vaultAddress, amount: 3004n }] },
        observeTokenBalances: [vaultAddress, outputToken].map(token => ({ token, account: { kind: "executor" } })),
        observe: ["return-data", "revert-data", "token-delta", "native-delta"],
      } }), error => error instanceof RevmStrictError && error.kind === "observation");
      assert((rpcCounts.get("eth_call") ?? 0) > callsBefore, "the negative case executes on the local EVM, not a request-validation rejection");
    }
    const fragment = buildFamilyExecutionFragment({ family, route, exact: quote, minAmountOut: row.output,
      executor: executorAddress, runtimeEvidence: [], actionOwnership: catalog });
    assert.equal(fragment.status, "resolved", stringify(fragment));
    if (fragment.status === "resolved") {
      const node = fragment.fragment.nodes[0]!;
      const encoded = plugin.actionAdapters[0]!.encode(node, executorAddress, new Uint8Array());
      assert(encoded.length > 0, "the native owned encoder accepts its source-bound selector node");
      const tokenAbi = new Interface(["function balanceOf(address) view returns(uint256)"]);
      const balances = () => Promise.all([edge.tokenIn, edge.tokenOut].map(async token => BigInt(await provider.call({
        to: token, data: tokenAbi.encodeFunctionData("balanceOf", [executorAddress]) }))));
      const checkpoint = await provider.send("evm_snapshot", []);
      try {
        const before = await balances();
        const receipt = await (await owner.sendTransaction({ to: executorAddress,
          data: buildExecuteCalldata(encoded), gasLimit: 0x1000000 })).wait();
        assert.equal(receipt?.status, 1);
        const after = await balances();
        assert.equal(before[0]! - after[0]!, startupPrice.amountSpent);
        assert.equal(after[1]! - before[1]!, row.output);
      } finally { assert.equal(await provider.send("evm_revert", [checkpoint]), true); }
    }
    const pricingStartupTransactions = startupTransactions, pricingTargetTransactions = targetTransactions;
    if (row.method === "mint") {
      const alternativeDefinition = JSON.parse(JSON.stringify(definition));
      const withoutApproval = JSON.parse(JSON.stringify(alternativeDefinition.programs[0]));
      withoutApproval.meta = { fixture: "local-no-approval-recipe" };
      for (const step of withoutApproval.execution.steps) delete step.approval;
      alternativeDefinition.programs = [withoutApproval, alternativeDefinition.programs[0]];
      const alternatePlugin = defineSelectorFamilyModule(alternativeDefinition).plugin;
      const alternateCatalog = new FamilyCapabilityCatalog({ modules: [{ sourceFile: "fixture/native-alternatives.production.ts", plugin: alternatePlugin,
        definitionBoundaryHash: definedFamilyPluginContractSummary(alternatePlugin).definitionBoundaryHash }],
        generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
      const bound = await runStrictFamilyLifecycle({ catalog: alternateCatalog, familyId, source, observations: [observation], runtime });
      assert.equal(bound.instances.length, 2, "an earlier static binding cannot suppress another executable parameter recipe");
      assert(bound.instances.every(value => value.pricingInstances.every(state => state.mids.size === 0)));
      const alternateGraph = buildFamilyRouteGraphView({ routes: bound.instances.flatMap(value => value.routes.map(r => ({
        family: alternateCatalog.forFamily(familyId), descriptor: value.descriptor, route: r,
        handle: value.routeHandles.find(handle => handle.routeKey === r.routeKey)!,
      }))) });
      assert.equal(alternateGraph.edges.length, 2);
      assert.equal(new Set(alternateGraph.edges.map(value => value.stateResourceKey)).size, 1, "recipes share physical liquidity");
      assert(alternateGraph.edges.every(value => value.executionVerification === "startup-simulation"));
      const alternateRoot = new StrictProductionRuntimeRoot({ catalog: alternateCatalog, readySource: source,
        readyGraph: alternateGraph.edges, readyInstances: bound.instances, readyFundingAssets: [] });
      const alternateSession = await alternateRoot.createSession({ source, runtime, fundingAssets: [], control });
      const alternativeEdges = [seed, ...alternateGraph.edges];
      const alternativeStartup = createBlockScanStartupExecutionPreflight({ executor: executorAddress, transactionOrigin: origin,
        simRejects: new BlockScanSimRejectCache(), concurrency: 1, simulateStandalone });
      const sessionForAlternative = (value: TokenEdge) => value === seed ? sessionFor(seed) : alternateSession;
      const alternatives = await buildEffectiveMids({ pricing: { sourceBlock: source.number, sourceBlockHash: source.hash,
        generation: source.generation, graph: { edges: alternativeEdges }, mids: new Map(), coverage: { resolvedEdgeKeys: [] },
        pricingStateKeyByEdgeKey: new Map(alternativeEdges.map(value => [blockScanEdgeKey(value), value.stateResourceKey ?? value.instanceKey!])) },
        weth: ADDR.WETH, fixedWethInput: row.amountIn, maxInputPathHops: 4, gasCostWei: null, enumerationSpreadBps: 0,
        control, concurrency: 1, prepareQuote, quote: async request => {
          const quoted = await alternativeStartup.quoteEffective({ ...request, control, edges: alternativeEdges, prepareQuote, sessionFor: sessionForAlternative });
          assert(quoted); return quoted;
        } });
      const alternativeRows = alternateGraph.edges.map(value => ({ edge: value, row: alternatives.rows.get(blockScanEdgeKey(value))! }));
      assert.deepEqual(alternativeRows.map(value => value.row.status).sort(), ["quote-failed", "quoted"]);
      const valid = alternativeRows.find(value => value.row.status === "quoted")!, rejected = alternativeRows.find(value => value.row.status !== "quoted")!;
      assert.equal(valid.row.amountOut, row.output);
      assert(effectiveRowExecutionVerified(alternatives, valid.row, valid.edge));
      assert.equal(rejected.row.failureEvidence, "evm-revert-observed");
      assert.equal(effectiveRowExecutionVerified(alternatives, rejected.row, rejected.edge), false);
      results.push({ selector: definition.selector, alternativeRecipes: 2, pendingBindings: 2, quotedRecipes: 1,
        rejectedRecipes: 1, rejectedReason: "actual-EVM-missing-approval", sharedPhysicalResource: true });
    }
    results.push({ selector: definition.selector, method: row.method, input: row.amountIn, output: quote.amountOut,
      inputMode: leg.inputMode ?? "exact", readySimulations: 0, startupTransactions: pricingStartupTransactions, targetTransactions: pricingTargetTransactions,
      startupAmountSpent: startupPrice.amountSpent, executionVerified: effectiveRowExecutionVerified(effective, startupPrice, edge),
      finalEncodedExecution: "local-EVM-balanced-deltas" });
  }
  assert((rpcCounts.get("eth_createAccessList") ?? 0) > 0);
  assert(![...rpcCounts.keys()].some(method => /^(debug_|trace_)/.test(method)));
  t.diagnostic(stringify({ cases: results, rpcMethods: Object.fromEntries(rpcCounts), simulationPolicy: "forbid-trace",
    startupTransport: "isolated-local-EVM-receipts; raw-V1-compatibility-not-claimed", broadcast: "local-fixture-only" }));
});
