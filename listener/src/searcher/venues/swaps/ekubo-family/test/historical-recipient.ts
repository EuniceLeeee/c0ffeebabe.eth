// Supplementary direct-only native/ERC20 correctness. Reuses immutable natural Ready/production
// prices and the source-pinned local REVM transport; never runs live or signs.
import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeSettlementRequest } from "../../../../../adapters/runtime-amount-program.js";
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
import { assertPriceInput, productionAmount, splicedMissingProductionAmount, constructionGuard, assertExecutorCode, assertOriginAccountCode, json, sha, same } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertHistoricalDiscoveryReceipt } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { EKUBO_FAMILY_ID as FAMILY } from "../manifest.js";
import { EKUBO_CORE, EKUBO_ROUTER, parseEkuboCoreSwapLog } from "../../ekubo/abi.js";
import { ekuboPoolId, ekuboGraphToken, ekuboPoolExtension } from "../../ekubo/pool-key.js";
import { extensionRegistrationSlot, validateExtensionProof } from "../extension.js";
import type { EkuboDescriptor as Descriptor, EkuboRoute as Route } from "../types.js";
const NATIVE_TX = "0xed014b884a511a4abd1c0e5f218be8dbcd1209cd7bb645d440334fdfecf928f0";
const ERC20 = new ethers.Interface(["function allowance(address,address) view returns(uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"]);

const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
// Single-leg receipts with pre-existing input/output inventory. No protocol
// balance/state override and no claim of original pre-call state replay.
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;
const requirements = { transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects };

const definitionNativeInput = (route: Route) => route.executionAssets!.input === "native";

async function main(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(), requiredNames = ["--ready", "--prices", "--pool", "--rpc-file", "--revm-bin", "--out"], names = [...requiredNames, "--executor", "--owner", "--cases", "--profile", "--reference-prices", "--reference-edges"];
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]!) && !args.has(argv[i]!) && argv[i + 1]); args.set(argv[i]!, argv[i + 1]!);
  }
  assert(requiredNames.every(name => args.has(name)));
  const erc20 = args.get("--profile") === "erc20";
  assert(!args.has("--profile") || erc20 || args.get("--profile") === "native");
  assert.equal(args.has("--reference-prices"), args.has("--reference-edges"));
  assert(!args.has("--reference-prices") || erc20);
  const TX = erc20 ? "0x868b69ff429fea8ec1e483c8be1d9e236aabe00065e355ff5a60af0596a75847" : NATIVE_TX;
  const secondaryLabel = erc20 ? "historical-or-twice-recorded-input-at-N-end" : "original-sized-at-N-end";
  const primaryLabel = erc20 ? "recorded-input-at-N-end" : "production-effective";
  const selected: unknown = args.has("--cases") ? JSON.parse(args.get("--cases")!) : undefined;
  assert(selected === undefined || Array.isArray(selected) && selected.length > 0 && selected.every(x => typeof x === "string") && new Set(selected).size === selected.length);
  const wanted = selected === undefined ? undefined : new Set(selected as string[]);
  const wants = (id: string) => wanted === undefined || wanted.has(id);
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [],
    claim: "Supplementary direct-only at N end: production Exact and quoted construction are checked; only direct-self/direct-external execute. Prior quoted/default evidence is retained, not re-created here. No original-precall or full-loop claim.",
    performance: "NOT RUN", signing: false, broadcast: false, protocolOverrides: false, actorOnlyFunding: true,
    caseFilter: selected ?? null, unverified: [] };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 1_200_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 1_200_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, quoteProvider: ethers.JsonRpcProvider | undefined,
    rpcUrl = "", reads = 0, stage = "inputs";
  const guard = constructionGuard();
  const redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  let finalPins: (() => Promise<void>) | undefined;
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricesPath = realpathSync(args.get("--prices")!);
    const referencePath = args.has("--reference-prices") ? realpathSync(args.get("--reference-prices")!) : undefined;
    const declarationPath = referencePath ? realpathSync(resolve(dirname(referencePath), "declaration.json")) : undefined;
    const referenceEdges = args.has("--reference-edges") ? JSON.parse(args.get("--reference-edges")!) : undefined;
    assert(referenceEdges === undefined || Array.isArray(referenceEdges) && referenceEdges.length === 2 && referenceEdges.every(x => typeof x === "string"));
    const donor = referencePath ? { prices: parseAtBlockJson(readFileSync(referencePath,"utf8")), declaration: parseAtBlockJson(readFileSync(declarationPath!,"utf8")) } : undefined;
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json"), fileURLToPath(import.meta.url), ...(referencePath ? [referencePath, declarationPath!] : [])];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = pins(); report.code = sourcePin(); report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!));
    assert.equal(report.revmSha256, "e5cbce3521fd98d7e59d3de80cca4fa0c3ec94c5cdfb1e74bbae4d6d7c7588c6");
    const prices = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2]!, "utf8"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    const N = source.number, HASH = source.hash, TARGET = args.get("--pool")!.toLowerCase(); assert(ethers.isHexString(TARGET, 32)); report.source = source; report.pool = TARGET;
    assertPriceInput(prices, provenance, ready, { readySha256: report.inputs[0].sha256, sourceTreeSha256: report.code.sourceTreeSha256, number: N });
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
    const d = instance.descriptor as Descriptor; assert(same(d.poolId, TARGET) && same(ekuboPoolId(d.poolKey), TARGET)); assert.equal(d.poolKey.token0 === ethers.ZeroAddress, !erc20); assert.equal(instance.routes.length, 2);
    const validCases = new Set<string>();
    for (const direction of ["token0-to-token1", "token1-to-token0"]) {
      for (const label of [primaryLabel, secondaryLabel]) for (const encoding of ["direct-self", "direct-external"])
        for (const negative of label === primaryLabel ? ["none", "no-input", "post-execution-revert"] : ["none"])
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
    assert.equal(N, erc20 ? 25943731 : 26088150);
    assert.equal(HASH, erc20 ? "0x265fd1d8bfa75ca4aa8ae34c486750b62c494be0695dc2893c5e74836aa63e41" : "0xcd1606be5437c39dae2f04fd1709e6016827cd05323e81674ce8b378f46f86b6");
    report.discoveryScope = { historicalNaturalDiscoveryProven: provenance.historicalNaturalDiscoveryProven,
      topologyContainsFutureDiscovery: provenance.topologyContainsFutureDiscovery,
      claim: "Saved natural Ready reused then current production revalidation; not fresh-from-zero discovery" };
    report.tx = TX;
    const receipt = await rpc("eth_getTransactionReceipt", [TX]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: TX, blockNumber: N, blockHash: HASH }, source);
    const candidate: any = memo.candidateSnapshot;
    assertHistoricalDiscoveryReceipt(same(candidate.transactionHash, TX) ? receipt : await rpc("eth_getTransactionReceipt", [candidate.transactionHash]), candidate, source);
    const swaps = receipt.logs.flatMap((log: any) => {
      if (log.removed || !same(log.address, EKUBO_CORE) || log.topics.length !== 0) return [];
      try { const parsed = parseEkuboCoreSwapLog(log.data); return same(parsed.poolId, TARGET) ? [{ log, parsed }] : []; }
      catch { return []; }
    });
    assert.equal(swaps.length, 1); const originalUpdate = swaps[0]!.parsed;
    assert(same(originalUpdate.locker, EKUBO_ROUTER));
    const originalIsToken1 = originalUpdate.delta1 > 0n;
    const original = { tokenIn: ekuboGraphToken(originalIsToken1 ? d.poolKey.token1 : d.poolKey.token0),
      amountIn: originalIsToken1 ? originalUpdate.delta1 : originalUpdate.delta0,
      amountOut: -(originalIsToken1 ? originalUpdate.delta0 : originalUpdate.delta1) };
    assert(original.amountIn > 0n && original.amountOut > 0n);
    report.originalObservation = { ...original, coreSwap: swaps[0],
      scope: "Original receipt Core event sizes only; prior coffee evidence separately binds Router ABI/return/recipient. N-end is not original call prestate." };
    const coreCode = await rpc("eth_getCode", [EKUBO_CORE, pin]), routerCode = await rpc("eth_getCode", [EKUBO_ROUTER, pin]);
    assert.equal(ethers.keccak256(coreCode), d.coreCodeHash); assert.equal(ethers.keccak256(routerCode), d.routerCodeHash);
    const extension = ekuboPoolExtension(d.poolKey.config);
    let extensionCodeHash: string | undefined, registration: string | undefined;
    if (!same(extension, ethers.ZeroAddress)) {
      const code = await rpc("eth_getCode", [extension, pin]);
      registration = await rpc("eth_getStorageAt", [EKUBO_CORE, extensionRegistrationSlot(extension), pin]);
      extensionCodeHash = validateExtensionProof(d.coreCodeHash, d.routerCodeHash, code, registration!);
      assert.equal(extensionCodeHash, d.extensionCodeHash);
    }
    report.identity = { poolKey: d.poolKey, poolId: d.poolId, coreCodeHash: d.coreCodeHash, routerCodeHash: d.routerCodeHash,
      extension, extensionCodeHash, registration,
      scope: "Current same-N Ready full PoolKey/active full-fill identity, same-N Core/Router code; actual selected extension code and registration if applicable." };
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
        // Preserve provider errors and source-pinned return data unchanged.
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
    report.productionReferences = []; report.unsupportedSettlement = { quoteOutput: "rejected", deferredInput: "rejected" };
    report.externalNativeBalance = "not independently observed; VM guards executor native and graph-asset receiver deltas";
    const forceRevert = runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes(), 0n);
    for (const route of instance.routes as readonly Route[]) {
      const direction = same(route.tokenIn, ekuboGraphToken(d.poolKey.token0)) ? "token0-to-token1" : "token1-to-token0";
      const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!; assert(handle);
      const edges = graph.filter(e => same(e.instanceKey, TARGET) && same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)); assert.equal(edges.length, 1);
      const edgeId = blockScanEdgeKey(edges[0]!), reference = productionAmount(prices.runtime.pricing.effectiveMids.rows.get(edgeId), prices.runtime.pricing.mids.get(edgeId), edges[0], source, prices.runtime.generation);
      const borrowed = reference.status !== "met" && donor ? splicedMissingProductionAmount(
        prices.runtime.pricing.effectiveMids.rows.get(edgeId), route.tokenIn, donor.prices, donor.declaration, referenceEdges!) : undefined;
      if (reference.status !== "met" && !borrowed) throw new Error("production reference unavailable");
      const referenceAmount = reference.status === "met" ? reference.amountIn : borrowed!.amountIn;
      report.productionReferences.push({ direction, ...reference, borrowedInput: borrowed });
      const build = (settlement?: RuntimeSettlementRequest) => guard.build(() => buildFamilyRuntimeAmountLeg({
        family, route: handle, source, executor, runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog,
        ...(settlement ? { settlement } : {}) }));
      const leg = build(); assert(leg, "no runtime fallback");
      assert.equal(build({ kind: "quote-output", recipient: executor }), null, "unimplemented quote-output must remain unavailable");
      assert.equal(build({ kind: "deferred-input", paymentAmount: 1n, paymentProgram: "0x0100" }), null,
        "Router internal lock callback is not a caller continuation");
      const inputs: [string, bigint][] = [[primaryLabel, referenceAmount], [secondaryLabel,
        same(route.tokenIn, original.tokenIn) ? original.amountIn : erc20 ? referenceAmount * 2n : original.amountOut]];
      for (const [label, amountIn] of inputs) {
        if (wanted && ![...wanted].some(id => id.startsWith(`${direction}/${label}/`))) continue;
        const trial: any = { label, direction, amountIn, defaultRuntimeProgramHash: ethers.keccak256(leg.program), tokenIn: route.tokenIn, tokenOut: route.tokenOut, status: "failed", executions: [] }; report.samples.push(trial);
        stage = "production-exact";
        const quote = await guard.exact(() => executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation,
          executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } }));
        trial.quote = quote; assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
        if (label === primaryLabel && reference.status === "met") assert.equal(quote.amountOut, reference.amountOut);
        const fragment = guard.quoted(() => buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: quote.amountOut,
          executor, runtimeEvidence: [], actionOwnership: catalog }));
        assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
        // Default/quoted retain their original MAX_UINT policy. Only the new
        // explicit direct path requires a cleared temporary approval.
        const allowanceCheck = definitionNativeInput(route) ? new Uint8Array() : runtimeProgramScript(new RuntimeAmountProgram().call(route.tokenIn,
          ERC20.encodeFunctionData("allowance", [executor, EKUBO_ROUTER]), { static: true }).load(1, 0).constant(2, 0n).equal(1, 2).bytes(), amountIn);
        trial.quotedConstruction = { status: fragment.status,
          scriptHash: ethers.keccak256(concatBytes(...planFragmentNodes(fragment.fragment, route.tokenIn, amountIn).map(compile))),
          executed: false, scope: "Quoted construction retained; this supplemental entry executes only new direct paths." };
        const scripts: { encoding: string; script: Uint8Array; recipient: string }[] = [];
        for (const recipient of [executor, owner]) {
          const direct = build({ kind: "direct-output", recipient }); assert(direct);
          assert.deepEqual(direct.settlementRequest, { kind: "direct-output", recipient });
          scripts.push({ encoding: same(recipient, executor) ? "direct-self" : "direct-external", recipient,
            script: concatBytes(runtimeProgramScript(ethers.getBytes(direct.program), amountIn), allowanceCheck) });
        }
        for (const { encoding, script, recipient } of scripts) for (const negative of label === primaryLabel ? ["none", "no-input", "post-execution-revert"] : ["none"]) {
          const caseId = `${direction}/${label}/${encoding}/${negative}`;
          if (!wants(caseId)) continue;
          stage = encoding + ":" + negative;
          const caller = { kind: "executor" as const }, actors = [...new Set([executor, EKUBO_CORE, EKUBO_ROUTER, owner, recipient].map(a => a.toLowerCase()))];
          const request: AdapterRequest = { id: "ekubo-direct-execute", required: false, kind: "effect-delta-simulation",
            call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(negative === "post-execution-revert" ? concatBytes(script, forceRevert) : script) },
            overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [{ token: route.tokenIn, amount: negative === "no-input" ? 0n : amountIn + 101n },
              { token: route.tokenOut, amount: quote.amountOut + 103n }] },
            observeTokenBalances: [route.tokenIn, route.tokenOut].flatMap(token => actors.map(account => ({ token, account: same(account, executor) ? caller : account }))), observe: effects };
          const record: any = { caseId, encoding, recipient, negative, request, scriptHash: ethers.keccak256(script), status: "failed" }; trial.executions.push(record);
          const run = await dispatch([request], requirements, stage); record.outcome = run.outcome;
          const returned = run.results[0];
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
                ? (same(account, executor) ? -amountIn : same(account, EKUBO_CORE) && !definitionNativeInput(route) ? amountIn : 0n)
                : (same(account, recipient) ? quote.amountOut : same(account, EKUBO_CORE) && route.executionAssets!.output !== "native" ? -quote.amountOut : 0n);
              const observations = deltas!.filter(x => same(x.token, token) && same(x.account, account)); assert.equal(observations.length, 1); assert.equal(observations[0].delta, expected);
            }
            const native = returned.effects?.nativeDeltas; assert.equal(native?.length, 1); assert(same(native![0].account, executor)); assert.equal(native![0].delta, 0n);
            const events = returned.effects?.logs?.flatMap(l => {
              if (!same(l.address, EKUBO_CORE) || l.topics.length !== 0) return [];
              try { const parsed = parseEkuboCoreSwapLog(l.data); return same(parsed.poolId, TARGET) ? [parsed] : []; }
              catch { return []; }
            });
            assert.equal(events?.length, 1); const event = events![0]!;
            assert(same(event.locker, EKUBO_ROUTER));
            assert.equal(route.isToken1 ? event.delta1 : event.delta0, amountIn);
            assert.equal(route.isToken1 ? event.delta0 : event.delta1, -quote.amountOut);
            record.quoteReceiptDelta = 0n;
          } else {
            assert.equal(returned.completion, "reverted-as-declared");
            assert(returned.effects?.tokenDeltas?.every(x => x.delta === 0n) ?? true);
            record.rollbackScope = "declared EVM revert; no independent state-diff claim";
          }
          record.status = "pass";
          console.log(json({ direction, label, encoding, negative, status: record.status }));
        }
        trial.status = trial.executions.some((x: any) => x.status !== "pass") ? "incomplete" : "pass";
      }
    }
    report.runtimeConstruction = { exactCalls: 0, quotedCalls: 0, rpcCalls: 0, quotedFallback: false, scope: "production issuer; direct-only production issuer; no fallback or new quoted-execution/market-path opportunity claim" };
    report.invocationCounts = guard.counts; report.result = report.unverified.length ? "incomplete" : report.productionReferences.some((x: any) => x.status !== "met") ? "pass-with-spliced-reference" : "pass";
    if (report.unverified.length) process.exitCode = 1;
  } catch (e) { report.error = { stage, message: redact(e instanceof Error ? e.message : e) }; process.exitCode = 1; }
  finally {
    try { await finalPins?.(); await simulation?.closeAndDrain(); report.drained = true; }
    catch (e) { report.finalError = redact(e instanceof Error ? e.message : e); report.result = "failed"; process.exitCode = 1; await simulation?.closeAndDrain().catch(() => {}); }
    quoteProvider?.destroy(); clearTimeout(timer); report.directReads = reads; writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd);
    console.log(json({ result: report.result, error: report.error, out: args.get("--out"), samples: report.samples.length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("invalid Ekubo recipient arguments/output; no success claimed"); process.exitCode = 1; });
