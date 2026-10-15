// Opt-in historical correctness only. Uses immutable natural Ready/production
// prices and the source-pinned local REVM transport; never runs live or signs.
import { createUnfundedFork } from "./unfunded-evidence.js";
import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { buildSubscriptCalldata } from "../../../../../shared/executor/botvm-program-entry.js";
import { executeAdapterWork, type AdapterWorkOutcome } from "../../../../adapter-work-intent.js";
import { parseAtBlockJson } from "../../../../blockscan-at-block-cli.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "../../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import type { AdapterRequest, AdapterRequestResult, ObservedEffects, RequestRequirements } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
import { assertPriceInput, productionAmount, constructionGuard, assertExecutorCode, assertOriginAccountCode, json, sha, same } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertHistoricalDiscoveryReceipt } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { FLUID_DEX_FAMILY_ID as FAMILY } from "../manifest.js";
import { FLUID_DEX_CONSTANTS_INTERFACE, FLUID_DEX_FACTORY_INTERFACE, sameAddress } from "../codec.js";
import type { FluidDexDescriptor as Descriptor, FluidDexRoute as Route } from "../types.js";
const POOL = new ethers.Interface(["event Swap(bool swap0to1,uint256 amountIn,uint256 amountOut,address to)"]);
const ERC20 = new ethers.Interface(["function allowance(address,address) view returns(uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"]);

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
// Single-leg receipts with pre-existing input/output inventory. No protocol
// balance/state override and no claim of original pre-call state replay.
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;
const requirements = { transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects };

const definitionNativeInput = (route: Route) => route.executionAssets!.input === "native";

async function main(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(), requiredNames = ["--ready", "--prices", "--pool", "--rpc-file", "--revm-bin", "--out", "--prior-evidence", "--port"], names = [...requiredNames, "--executor", "--owner", "--cases"];
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]!) && !args.has(argv[i]!) && argv[i + 1]); args.set(argv[i]!, argv[i + 1]!);
  }
  assert(requiredNames.every(name => args.has(name)));
  assert(!args.has("--cases"), "only the four previously incomplete USDT controls");
  const selected: unknown = ["quoted", "runtime", "direct-self", "direct-external"].map(m => `token1-to-token0/production-effective/${m}/no-input`);
  assert(selected === undefined || Array.isArray(selected) && selected.length > 0 && selected.every(x => typeof x === "string") && new Set(selected).size === selected.length);
  const wanted = selected === undefined ? undefined : new Set(selected as string[]);
  const wants = (id: string) => wanted === undefined || wanted.has(id);
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [],
    claim: "N-end production quote/quoted/runtime single-leg receipts, not original pre-call parity or full-loop execution",
    performance: "NOT RUN", signing: false, broadcast: false, protocolOverrides: false, actorOnlyFunding: true,
    caseFilter: selected ?? null, unverified: [] };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 1_200_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 1_200_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, quoteProvider: ethers.JsonRpcProvider | undefined,
    rpcUrl = "", reads = 0, stage = "inputs";
  const guard = constructionGuard();
  let fork: Awaited<ReturnType<typeof createUnfundedFork>> | undefined;
  const redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  let finalPins: (() => Promise<void>) | undefined;
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricesPath = realpathSync(args.get("--prices")!);
    const priorPath = realpathSync(args.get("--prior-evidence")!), prior = parseAtBlockJson(readFileSync(priorPath, "utf8"));
    assert.equal(sha(readFileSync(priorPath)), "2cd18950fb43217b686c50cf521b7a7367db78bb0ee9d3353ec57bcbd7ce6b91");
    assert.equal(prior.result, "incomplete"); assert(prior.drained); assert.equal(prior.samples.length, 1);
    const priorExecutions = prior.samples[0].executions; assert.equal(priorExecutions.length, 4);
    assert.deepEqual(priorExecutions.map((r: any) => r.caseId), selected);
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json"), fileURLToPath(import.meta.url), priorPath, fileURLToPath(new URL("./unfunded-evidence.ts", import.meta.url))];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = pins(); report.code = sourcePin(); report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!));
    assert.equal(report.revmSha256, "e5cbce3521fd98d7e59d3de80cca4fa0c3ec94c5cdfb1e74bbae4d6d7c7588c6");
    const prices = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2]!, "utf8"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    const N = source.number, HASH = source.hash, TARGET = ethers.getAddress(args.get("--pool")!); report.source = source; report.pool = TARGET;
    const donorReadyPath = realpathSync(prior.inputs[0].path), donorBytes = readFileSync(donorReadyPath);
    assert.equal(sha(donorBytes), prior.inputs[0].sha256); paths.push(donorReadyPath); report.inputs = pins();
    assert.equal(sha(readFileSync(pricesPath)), prior.inputs[1].sha256); assert.equal(sha(readFileSync(paths[2]!)), prior.inputs[2].sha256);
    const donorEnvelope = await new UniverseRebuildCheckpointStore({ path: donorReadyPath }).load(); assert(donorEnvelope && !donorEnvelope.inProgressRun);
    const donorReady = resolveStrictReadyRuntime(donorEnvelope.readyGeneration).ready;
    assertPriceInput(prices, provenance, donorReady, { readySha256: prior.inputs[0].sha256, sourceTreeSha256: prior.code.sourceTreeSha256, number: N });
    assert.equal(donorReady.cutoff.number, N); assert.equal(donorReady.cutoff.hash, HASH);
    assert.equal(prior.source.number, N); assert.equal(prior.source.hash, HASH);
    report.donor = { path: priorPath, sha256: report.inputs[4].sha256, originalSource: prior.source, originalResult: prior.result,
      originalSourceTree: prior.code.sourceTreeSha256, inputOnly: true, pricesUnchanged: true, naturalValuationClaim: false };
    report.claim = "four prior incomplete no-input controls only: current production construction/strict plus independent same-N fork rejection; no successful swap/valuation/opportunity/performance claim";
    assert.equal(provenance.implementation.revmBinarySha256, report.revmSha256);
    const executor = ethers.getAddress(provenance.executor), owner = ethers.getAddress(provenance.owner);
    assert(!same(executor, owner)); report.actors = { executor, owner };
    if (args.has("--executor")) assert(same(args.get("--executor")!, executor));
    if (args.has("--owner")) assert(same(args.get("--owner")!, owner));
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === FAMILY && same(m.instanceKey, TARGET)); assert.equal(memos.length, 1);
    const memo = memos[0]!, wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [FAMILY], executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const family = asPricedFamily(catalog.forStrictFamily(FAMILY));
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d = instance.descriptor as Descriptor; assert(same(d.pool, TARGET)); assert.equal(instance.routes.length, 2);
    const validCases = new Set<string>();
    for (const direction of ["token0-to-token1", "token1-to-token0"]) {
      for (const receiver of ["self", "external"]) validCases.add(`${direction}/readonly/${receiver}`);
      for (const label of ["production-effective", "10x-production-effective"]) for (const encoding of ["quoted", "runtime", "direct-self", "direct-external"])
        for (const negative of label === "production-effective" ? ["none", "no-input", "post-execution-revert"] : ["none"])
          validCases.add(`${direction}/${label}/${encoding}/${negative}`);
    }
    if (wanted) assert([...wanted].every(id => validCases.has(id)), "unknown selected case");
    report.admission = { memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, candidate: memo.candidateSnapshot };
    rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(/^https?:\/\//.test(rpcUrl));
    const fetchRequest = new ethers.FetchRequest(rpcUrl); fetchRequest.timeout = 25_000;
    quoteProvider = new ethers.JsonRpcProvider(fetchRequest, 1, { staticNetwork: true, batchMaxCount: 1 });
    const pin = { blockHash: source.hash, requireCanonical: true };
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      guard.check(); abort.signal.throwIfAborted(); const id = ++reads; assert(id <= 600);
      assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25_000)]) });
      assert(response.ok, `HTTP ${response.status}`); const body: any = await response.json(); assert.equal(body.id, id);
      assert.equal(body.jsonrpc, "2.0"); assert(!body.error, `read failed: ${method}`); return body.result;
    };
    stage = "source-and-runtime";
    const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false]); assert.equal(header.hash, HASH); report.header = header;
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const TX = (memo.candidateSnapshot as any).transactionHash; assert(ethers.isHexString(TX, 32)); report.tx = TX;
    const receipt = await rpc("eth_getTransactionReceipt", [TX]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: TX, blockNumber: N, blockHash: HASH }, source);
    const candidate: any = memo.candidateSnapshot;
    assertHistoricalDiscoveryReceipt(same(candidate.transactionHash, TX) ? receipt : await rpc("eth_getTransactionReceipt", [candidate.transactionHash]), candidate, source);
    const swaps = receipt.logs.filter((l: any) => !l.removed && same(l.address, TARGET) && same(l.topics[0], POOL.getEvent("Swap")!.topicHash));
    assert(swaps.length > 0); report.originalObservations = swaps.map((log: any) => ({ log,
      decoded: POOL.parseLog(log)!.args.toArray(), scope: "receipt observation only; N end is not original pre-call state" }));
    const constantsData = await rpc("eth_call", [{ to: TARGET, data: FLUID_DEX_CONSTANTS_INTERFACE.encodeFunctionData("constantsView") }, pin]);
    const constants = FLUID_DEX_CONSTANTS_INTERFACE.decodeFunctionResult("constantsView", constantsData)[0];
    assert(same(constants.factory, d.factoryBinding.factory)); assert.equal(constants.dexId, d.factoryBinding.dexId);
    assert(same(constants.token0, d.rawToken0)); assert(same(constants.token1, d.rawToken1));
    const reverse = await rpc("eth_call", [{ to: constants.factory,
      data: FLUID_DEX_FACTORY_INTERFACE.encodeFunctionData("getDexAddress", [constants.dexId]) }, pin]);
    assert(same(FLUID_DEX_FACTORY_INTERFACE.decodeFunctionResult("getDexAddress", reverse)[0], TARGET));
    const liquidity = ethers.getAddress(constants.liquidity); assert(!same(liquidity, ethers.ZeroAddress));
    report.identity = { constantsData, reverse, liquidity, runtimeCode: [] };
    for (const address of [...new Set([TARGET, liquidity, constants.factory, ...constants.implementations.toArray()].map(a => String(a).toLowerCase()))]) {
      if (same(address, ethers.ZeroAddress)) continue;
      const code = await rpc("eth_getCode", [address, pin]); assert(code !== "0x");
      report.identity.runtimeCode.push({ address, codeHash: ethers.keccak256(code), code });
    }
    fork = await createUnfundedFork({ rpcUrl, port: Number(args.get("--port")), source, header, owner, executor,
      signal: abort.signal, deadlineAtMs, report });
    report.identity.scope = "same-N runtime code and immutable getter/factory reverse bindings; no unverified proxy implementation inferred";
    const artifactPath = resolve(ROOT, "out/BotVM.sol/BotVM.json"), artifactBytes = readFileSync(artifactPath), artifact = JSON.parse(artifactBytes.toString());
    const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
    assert.equal(metadata.settings.compilationTarget["src/BotVM.sol"], "BotVM");
    assert(Object.keys(metadata.sources).length > 0);
    for (const [name, entry] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) {
      const p = realpathSync(resolve(ROOT, name)); assert(name.endsWith(".sol") && !relative(realpathSync(ROOT), p).startsWith(".."));
      assert.equal(ethers.keccak256(readFileSync(p)), entry.keccak256, "stale executor source");
    }
    const executorRuntimeCode = loadBotVmRuntimeCode(owner); report.executorCodeHash = executorRuntimeCode.keccak256; report.executorArtifactSha256 = sha(artifactBytes);
    report.executorProvisioning = assertExecutorCode(await rpc("eth_getCode", [executor, pin]), executorRuntimeCode.code);
    assertOriginAccountCode(await rpc("eth_getCode", [owner, pin]));
    finalPins = async () => { assert.deepEqual(pins(), report.inputs); assert.deepEqual(sourcePin(), report.code);
      assert.equal(sha(readFileSync(artifactPath)), report.executorArtifactSha256);
      assert.equal((await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false])).hash, HASH); };
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => {
        const client = new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 60_000, onFatal });
        const strict = client.strictSimulate.bind(client);
        client.strictSimulate = async (...input) => {
          try {
            const result = await strict(...input);
            (report.strictCalls ??= []).push({ stage, result }); return result;
          }
          catch (error) { (report.transportErrors ??= []).push({ stage, message: redact(error instanceof Error ? error.message : error) }); throw error; }
        };
        return client;
      },
      onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => {
        assert.equal(blockTag ?? n, N); guard.check(); abort.signal.throwIfAborted(); assert(++reads <= 600);
        // Preserve the provider's structured CALL_EXCEPTION and revert bytes;
        // Fluid's declared-revert quote is not a transport error.
        return quoteProvider!.send("eth_call", [tx, pin]);
      },
        getCode: async (a: string, n: number) => { assert.equal(n, N); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, N); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, executor, concatBytes(...node.children.map(compile))); };
    const dispatch = async (requests: readonly AdapterRequest[], declaredRequirements: RequestRequirements, label: string) => {
      const outcome = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: {
        stage: "exact-refine", familyId: FAMILY, source, generation: source.generation, programInput: undefined,
        program: { requirements: () => declaredRequirements,
          buildRequests: () => requests, decode: ({ results }): readonly AdapterRequestResult[] => results } } });
      if (outcome.status !== "resolved") { (report.unresolvedWork ??= []).push({ label, outcome }); throw Error(label + " unresolved"); }
      return { outcome, results: outcome.executed.evidence };
    };
    report.productionReferences = []; report.readonlyQuotes = [];
    report.externalNativeBalance = "not independently observed; VM guards executor native and graph-asset receiver deltas";
    const forceRevert = runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes(), 0n);
    for (const route of instance.routes as readonly Route[]) {
      const direction = same(route.tokenIn, d.token0) ? "token0-to-token1" : "token1-to-token0";
      const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!; assert(handle);
      const edges = graph.filter(e => same(e.instanceKey, TARGET) && same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)); assert.equal(edges.length, 1);
      const edgeId = blockScanEdgeKey(edges[0]!), reference = productionAmount(prices.runtime.pricing.effectiveMids.rows.get(edgeId), prices.runtime.pricing.mids.get(edgeId), edges[0], donorReady.cutoff, prices.runtime.generation);
      assert.equal(reference.status, "met"); if (reference.status !== "met") throw new Error("production reference unavailable");
      report.productionReferences.push({ direction, ...reference });
      const build = (settlement?: { kind: "quote-output" | "direct-output"; recipient: string }) => guard.build(() => buildFamilyRuntimeAmountLeg({
        family, route: handle, source, executor, runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog,
        ...(settlement ? { settlement } : {}) }));
      const leg = build(); assert(leg, "no runtime fallback");
      const inputs: [string, bigint][] = [["production-effective", reference.amountIn], ["10x-production-effective", reference.amountIn * 10n]];
      for (const [label, amountIn] of inputs) {
        if (wanted && ![...wanted].some(id => id.startsWith(`${direction}/${label}/`) || label === "production-effective" && id.startsWith(`${direction}/readonly/`))) continue;
        const trial: any = { label, direction, amountIn, tokenIn: route.tokenIn, tokenOut: route.tokenOut, status: "failed", executions: [] }; report.samples.push(trial);
        stage = "production-exact";
        const quote = await guard.exact(() => executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation,
          executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } }));
        trial.quote = quote; assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
        assert.equal(amountIn, BigInt(prior.samples[0].amountIn)); // input only; quote output is freshly computed
        const fragment = guard.quoted(() => buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: quote.amountOut,
          executor, runtimeEvidence: [], actionOwnership: catalog }));
        assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
        // Temporary Fluid allowance must be zero after execution; native
        // input has no ERC20 approval at all.
        const allowanceCheck = definitionNativeInput(route) ? new Uint8Array() : runtimeProgramScript(new RuntimeAmountProgram().call(route.tokenIn,
          ERC20.encodeFunctionData("allowance", [executor, TARGET]), { static: true }).load(1, 0).constant(2, 0n).equal(1, 2).bytes(), amountIn);
        const scripts: { encoding: string; script: Uint8Array; recipient: string }[] = [
          { encoding: "quoted", script: concatBytes(...planFragmentNodes(fragment.fragment, route.tokenIn, amountIn).map(compile), allowanceCheck), recipient: executor },
          { encoding: "runtime", script: concatBytes(runtimeProgramScript(ethers.getBytes(leg.program), amountIn), allowanceCheck), recipient: executor }];
        for (const recipient of [executor, owner]) {
          const direct = build({ kind: "direct-output", recipient }), prepared = build({ kind: "quote-output", recipient }); assert(direct && prepared);
          const checkQuote = runtimeProgramScript(new RuntimeAmountProgram().run(prepared.program, 0, 1, true).constant(2, quote.amountOut).equal(1, 2).bytes(), amountIn);
          if (label === "production-effective" && wants(`${direction}/readonly/${same(recipient, executor) ? "self" : "external"}`)) {
            stage = "readonly-quote-without-input";
            const caller = { kind: "executor" as const };
            const request: AdapterRequest = { id: "fluid-readonly", required: false, kind: "effect-delta-simulation",
              call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(checkQuote) },
              overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [{ token: route.tokenIn, amount: 0n }, { token: route.tokenOut, amount: 103n }] },
              observeTokenBalances: [route.tokenIn, route.tokenOut].flatMap(token => [{ token, account: caller }, { token, account: TARGET }, { token, account: owner }]), observe: effects };
            const record: any = { direction, recipient, amountIn, expectedQuote: quote.amountOut, request, status: "failed" }; report.readonlyQuotes.push(record);
            const run = await dispatch([request], requirements, stage); record.outcome = run.outcome;
            const returned = run.results[0]; assert(returned.ok && returned.completion === "returned");
            assert.equal(returned.effects?.tokenDeltas?.length, 6); assert(returned.effects!.tokenDeltas!.every(x => x.delta === 0n));
            assert.equal(returned.effects?.nativeDeltas?.length, 1); assert.equal(returned.effects!.nativeDeltas![0].delta, 0n);
            assert.equal(returned.effects?.logs?.length, 0); record.status = "pass";
          }
          scripts.push({ encoding: same(recipient, executor) ? "direct-self" : "direct-external", recipient,
            script: concatBytes(checkQuote, runtimeProgramScript(ethers.getBytes(direct.program), amountIn), allowanceCheck) });
        }
        for (const { encoding, script, recipient } of scripts) for (const negative of label === "production-effective" ? ["none", "no-input", "post-execution-revert"] : ["none"]) {
          const caseId = `${direction}/${label}/${encoding}/${negative}`;
          if (!wants(caseId)) continue;
          stage = encoding + ":" + negative;
          const caller = { kind: "executor" as const }, actors = [...new Set([executor, TARGET, liquidity, owner, recipient].map(a => a.toLowerCase()))];
          const request: AdapterRequest = { id: "fluid-execute", required: false, kind: "effect-delta-simulation",
            call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(negative === "post-execution-revert" ? concatBytes(script, forceRevert) : script) },
            overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [{ token: route.tokenIn, amount: negative === "no-input" ? 0n : amountIn + 101n },
              { token: route.tokenOut, amount: quote.amountOut + 103n }] },
            observeTokenBalances: [route.tokenIn, route.tokenOut].flatMap(token => actors.map(account => ({ token, account: same(account, executor) ? caller : account }))), observe: effects };
          const record: any = { caseId, encoding, recipient, negative, request, status: "failed" }; trial.executions.push(record);
          const oldRecord = priorExecutions.find((r: any) => r.caseId === caseId); assert(oldRecord);
          record.priorComparison = { originalCalldataSha256: sha(oldRecord.request.call.data), currentCalldataSha256: sha(request.call.data),
            calldataEqual: oldRecord.request.call.data === request.call.data, originalOverride: oldRecord.request.overrideIntent,
            currentOverride: request.overrideIntent, originalClassification: oldRecord.status, originalFailure: oldRecord.outcome.executed.evidence[0].failure };
          const run = await dispatch([request], requirements, stage); record.outcome = run.outcome;
          const returned = run.results[0];
          record.independentFork = await fork!.check({ script, request, executorRuntimeCode, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
            amountIn, outputInventory: quote.amountOut + 103n, pool: TARGET, liquidity, recipient });
          assert.equal(record.independentFork.status, "correct-insufficient-input-rejection-with-rollback");
          record.strictClassification = returned.ok ? returned.completion : returned.failure;
          if (!returned.ok) { record.status = "pass-independent-fork-strict-classification-retained"; report.unverified.push({ caseId, scope: "strict declared-revert classification remains unverified", failure: returned.failure }); continue; }
          if (!returned.ok) {
            // A failed transport/resource limit is never a successful rejection.
            // Retain it and finish the remaining independent negative controls.
            record.status = "unverified"; report.unverified.push({ caseId, failure: returned.failure });
            if (negative === "none") throw Error("positive execution transport failed");
            continue;
          }
          if (negative === "none") {
            assert.equal(returned.completion, "returned"); assert.equal(returned.data, "0x");
            const deltas = returned.effects?.tokenDeltas; assert.equal(deltas?.length, actors.length * 2);
            for (const token of [route.tokenIn, route.tokenOut]) for (const account of actors) {
              const expected = same(token, route.tokenIn)
                ? (same(account, executor) ? -amountIn : same(account, liquidity) && !definitionNativeInput(route) ? amountIn : 0n)
                : (same(account, recipient) ? quote.amountOut : same(account, liquidity) && route.executionAssets!.output !== "native" ? -quote.amountOut : 0n);
              const observations = deltas!.filter(x => same(x.token, token) && same(x.account, account)); assert.equal(observations.length, 1); assert.equal(observations[0].delta, expected);
            }
            const native = returned.effects?.nativeDeltas; assert.equal(native?.length, 1); assert(same(native![0].account, executor)); assert.equal(native![0].delta, 0n);
            const events = returned.effects?.logs?.filter(l => same(l.address, TARGET) && same(l.topics[0], POOL.getEvent("Swap")!.topicHash));
            assert.equal(events?.length, 1); const event = POOL.parseLog({ data: events![0].data, topics: [...events![0].topics] })!.args;
            const rawRecipient = route.executionAssets!.output === "native" ? executor : recipient;
            assert(same(event.to, rawRecipient)); assert.equal(event.swap0to1, route.swap0To1);
            assert.equal(event.amountIn, amountIn); assert.equal(event.amountOut, quote.amountOut); record.quoteReceiptDelta = 0n;
          } else {
            assert.equal(returned.completion, "reverted-as-declared");
            assert(returned.effects?.tokenDeltas?.every(x => x.delta === 0n) ?? true);
            record.rollbackScope = "declared EVM revert; no independent state-diff claim";
          }
          record.status = "pass";
          console.log(json({ direction, label, encoding, negative, status: record.status }));
        }
        assert.equal(trial.executions.length, 4); assert(trial.executions.every((x: any) => x.independentFork?.status === "correct-insufficient-input-rejection-with-rollback")); trial.status = "pass-independent-rejection";
      }
    }
    report.runtimeConstruction = { exactCalls: 0, quotedCalls: 0, rpcCalls: 0, quotedFallback: false, scope: "production issuer; existing common selector regression is separate, new Fluid composition not a historical opportunity claim" };
    report.invocationCounts = guard.counts; assert.equal(report.samples.length, 1); report.result = "pass-four-independent-rejections-strict-classification-preserved";
  } catch (e) { report.error = { stage, message: redact(e instanceof Error ? e.message : e) }; process.exitCode = 1; }
  finally {
    try { await finalPins?.(); await simulation?.closeAndDrain(); report.drained = true; }
    catch (e) { report.finalError = redact(e instanceof Error ? e.message : e); report.result = "failed"; process.exitCode = 1; await simulation?.closeAndDrain().catch(() => {}); }
    try { await fork?.close(); report.forkDrained = !!fork; } catch (e) { report.forkCloseError = redact(e); report.result = "failed"; process.exitCode = 1; }
    quoteProvider?.destroy(); clearTimeout(timer); report.directReads = reads; writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd);
    console.log(json({ result: report.result, error: report.error, out: args.get("--out"), samples: report.samples.length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("invalid Fluid dual arguments/output; no success claimed"); process.exitCode = 1; });
