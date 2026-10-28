// Opt-in same-state production-interface check, NOT a latency/EV benchmark.
// Reads a natural Ready; never supplies admission, graph edges or protocol state.
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
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import type { AdapterRequest, AdapterRequestResult, ObservedEffects } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
import { assertPriceInput, productionAmount, splicedMissingProductionAmount, constructionGuard, assertExecutorCode, assertOriginAccountCode, json, sha, same } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertHistoricalDiscoveryReceipt } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { ERC4626_SILO_REDEEM_FAMILY_ID as FAMILY_ID } from "../manifest.js";

export const SAMPLE_ANCHORS = {
  junior: { number: 26130609, hash: "0xc2a34ba6aef82b049e82d6123a65656358d389a55bbb95dd1a5a252dae62e1bc",
    tx: "0x84e3bb020d915dedddf168c98680060ed5c1b65e5361d7c4d2f65f6f7525fb01", vault: "0xc58d044404d8b14e953c115e67823784dea53d8f" },
  senior: { number: 25462190, hash: "0x3b02e4d1911cefa4a6e5cef387db42da16821da9d48196421156ae63ab1bac13",
    tx: "0xf391d02add5e6cbbd98836d9eacdb66de3e5d76ef3874134145a6563a126ee86", vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003" },
} as const; // Test provenance only: admission still comes from the production Ready.
const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const ABI = new ethers.Interface([
  "function cdo() view returns(address)", "function strategy() view returns(address)",
  "function erc20Cooldown() view returns(address)", "function isJrt(address) view returns(bool)",
  "function sUSDeCooldownJrt() view returns(uint256)", "function sUSDeCooldownSrt() view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
  "event OnMetaWithdraw(address indexed owner,address indexed token,uint256 tokenAssets,uint256 shares)",
]);
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] as const;
const requirements = { transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects };
export function originalSiloWithdrawal(receipt: { logs: readonly any[] }, vault: string, payoutToken: string) {
  const events = receipt.logs.filter(l => !l.removed && same(l.address, vault)).flatMap(l => {
    try { const event = ABI.parseLog(l); return event ? [event] : []; } catch { return []; }
  });
  const withdrawals = events.filter(e => e.name === "Withdraw"), metas = events.filter(e => e.name === "OnMetaWithdraw");
  assert.equal(withdrawals.length, 1); assert.equal(metas.length, 1);
  const w = withdrawals[0]!.args, m = metas[0]!.args;
  assert(w.shares > 0n && w.assets > 0n && m.tokenAssets > 0n);
  assert.equal(w.shares, m.shares); assert(same(m.token, payoutToken) && same(m.owner, w.receiver));
  return { assets: w.assets as bigint, shares: w.shares as bigint, payout: m.tokenAssets as bigint, receiver: w.receiver as string };
}
export function assertSiloRecipientEffects(actual: ObservedEffects | undefined, executor: string,
  recipient: string, tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint): void {
  const accounts = [...new Set([executor, recipient].map(a => a.toLowerCase()))];
  assert.equal(actual?.tokenDeltas?.length, accounts.length * 2);
  for (const token of [tokenIn, tokenOut]) for (const account of accounts) {
    const expected = same(token, tokenIn) ? (same(account, executor) ? -amountIn : 0n) :
      (same(account, recipient) ? amountOut : 0n);
    const rows = actual!.tokenDeltas!.filter(r => same(r.token, token) && same(r.account, account));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.delta, expected);
  }
  assert.equal(actual?.nativeDeltas?.length, 1);
  assert(same(actual!.nativeDeltas![0]!.account, executor)); assert.equal(actual!.nativeDeltas![0]!.delta, 0n);
  assert.equal(actual?.totalSupplyDeltas?.length, 1);
  assert(same(actual!.totalSupplyDeltas![0]!.token, tokenIn)); assert.equal(actual!.totalSupplyDeltas![0]!.delta, -amountIn);
  const events = actual?.logs?.flatMap(log => {
    if (!same(log.address, tokenIn)) return [];
    try { const e = ABI.parseLog({ topics: [...log.topics], data: log.data }); return e ? [e] : []; } catch { return []; }
  }) ?? [];
  const withdraws = events.filter(e => e.name === "Withdraw"), metas = events.filter(e => e.name === "OnMetaWithdraw");
  assert.equal(withdraws.length, 1); assert.equal(metas.length, 1);
  const w = withdraws[0]!.args, m = metas[0]!.args;
  assert(same(w.sender, executor) && same(w.owner, executor) && same(w.receiver, recipient));
  assert.equal(w.shares, amountIn); assert(w.assets > 0n);
  // In both verified Tranche generations OnMetaWithdraw's first indexed field is the receiver.
  assert(same(m.owner, recipient) && same(m.token, tokenOut));
  assert.equal(m.tokenAssets, amountOut); assert.equal(m.shares, amountIn);
}

async function main(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(), required = ["--ready", "--prices", "--rpc-file", "--revm-bin", "--out", "--sample", "--recipient"];
  for (let i = 0; i < argv.length; i += 2) {
    assert([...required, "--reference-prices", "--reference-edge"].includes(argv[i]!) && !args.has(argv[i]!) && argv[i + 1]); args.set(argv[i]!, argv[i + 1]!);
  }
  assert(required.every(name => args.has(name)));
  assert.equal(args.has("--reference-prices"), args.has("--reference-edge"));
  const selected = SAMPLE_ANCHORS[args.get("--sample")! as keyof typeof SAMPLE_ANCHORS]; assert(selected, "unknown test sample");
  const { number: N, hash: HASH, tx: TX, vault: VAULT } = selected;
  const requestedRecipient = ethers.getAddress(args.get("--recipient")!);
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [], tx: TX,
    claim: "Same-state current production Exact/quoted/default/direct receipts; preserved natural Ready revalidated, no original pre-call or opportunity verdict",
    performance: "NOT RUN", signing: false, broadcast: false, protocolOverrides: false, inputOnlyActorFunding: true };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 480_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 480_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, rpcUrl = "", reads = 0, stage = "inputs";
  const guard = constructionGuard();
  const redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  let finalPins: (() => Promise<void>) | undefined;
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricesPath = realpathSync(args.get("--prices")!);
    const referencePath = args.has("--reference-prices") ? realpathSync(args.get("--reference-prices")!) : undefined;
    const declarationPath = referencePath ? realpathSync(resolve(dirname(referencePath), "declaration.json")) : undefined;
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json"), fileURLToPath(import.meta.url), realpathSync(args.get("--revm-bin")!),
      ...(referencePath ? [referencePath, declarationPath!] : [])];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = pins(); report.code = sourcePin(); report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!));
    const prices = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2]!, "utf8"));
    const reference = referencePath ? { saved: parseAtBlockJson(readFileSync(referencePath, "utf8")),
      declaration: parseAtBlockJson(readFileSync(declarationPath!, "utf8")), edge: args.get("--reference-edge")! } : undefined;
    if (reference) {
      assert.equal(reference.saved.runtime.pricing.effectiveMids.referenceWethInput, prices.runtime.pricing.effectiveMids.referenceWethInput);
      report.referenceInputSource = { prices: referencePath, declaration: declarationPath, inputOnly: true,
        claim: "Recorded production amount only; donor valuation, identity, output and state are not transplanted" };
    }
    report.discoveryScope = { historicalNaturalDiscoveryProven: provenance.historicalNaturalDiscoveryProven,
      topologyContainsFutureDiscovery: provenance.topologyContainsFutureDiscovery,
      claim: "Preserved natural Ready provenance; current production revalidation does not claim fresh-from-zero discovery" };
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), discoverySource = ready.cutoff;
    assert.equal(discoverySource.number, N); assert.equal(discoverySource.hash, HASH);
    const source = discoverySource;
    report.source = source; report.discoverySource = discoverySource;
    report.stateScope = "N state and preserved N Ready, current production revalidation";
    assertPriceInput(prices, provenance, ready, { readySha256: report.inputs[0].sha256,
      sourceTreeSha256: report.code.sourceTreeSha256, number: N });
    assert.equal(provenance.implementation.revmBinarySha256, report.revmSha256);
    const executor = ethers.getAddress(provenance.executor), owner = ethers.getAddress(provenance.owner);
    assert(!same(executor, owner)); report.actors = { executor, owner };
    if (requestedRecipient) { assert(!same(executor, requestedRecipient)); report.recipientAcceptance = {
      recipient: requestedRecipient, scope: "quoted/default plus explicit direct-self/direct-external; separate from old opportunity evidence",
      externalNative: "not separately observed; executor native and all selected token accounts are observed" }; }
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === FAMILY_ID && same(m.compiledDescriptor.vault as string, VAULT)); assert.equal(memos.length, 1);
    const memo = memos[0]!; assert([familyDefinitionHash(FAMILY_ID), familyMemoDefinitionHash(FAMILY_ID)].includes(memo.familyDefinitionHash));
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [FAMILY_ID], executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const family = asPricedFamily(catalog.forStrictFamily(FAMILY_ID));
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d: any = instance.descriptor; assert(same(d.vault, VAULT)); assert.equal(instance.routes.length, 1);
    report.identity = d;
    report.admission = { memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, candidate: memo.candidateSnapshot };
    rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(/^https?:\/\//.test(rpcUrl));
    const pin = { blockHash: source.hash, requireCanonical: true };
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      guard.check(); abort.signal.throwIfAborted(); const id = ++reads; assert(id <= 650);
      assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25_000)]) });
      assert(response.ok, `HTTP ${response.status}`); const body: any = await response.json(); assert.equal(body.id, id);
      assert.equal(body.jsonrpc, "2.0"); assert(!body.error, `read failed: ${method}`); return body.result;
    };
    stage = "source-and-runtime";
    const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]); assert.equal(header.hash, source.hash); report.header = header;
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const receipt = await rpc("eth_getTransactionReceipt", [TX]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: TX, blockNumber: N, blockHash: HASH }, discoverySource);
    const candidate: any = memo.candidateSnapshot;
    assertHistoricalDiscoveryReceipt(same(candidate.transactionHash, TX) ? receipt : await rpc("eth_getTransactionReceipt", [candidate.transactionHash]), candidate, discoverySource);
    const original = originalSiloWithdrawal(receipt, VAULT, d.payoutToken);
    report.originalObservation = { receipt, ...original, scope: "receipt burned shares, including original withdraw mode; no pre-call-state parity claim" };
    const artifactPath = resolve(ROOT, "out/BotVM.sol/BotVM.json"), artifactBytes = readFileSync(artifactPath), artifact = JSON.parse(artifactBytes.toString());
    const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
    assert.equal(metadata.settings.compilationTarget["src/BotVM.sol"], "BotVM");
    for (const [name, entry] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) {
      const p = realpathSync(resolve(ROOT, name)); assert(name.endsWith(".sol") && !relative(realpathSync(ROOT), p).startsWith(".."));
      assert.equal(ethers.keccak256(readFileSync(p)), entry.keccak256, "stale executor source");
    }
    const executorRuntimeCode = loadBotVmRuntimeCode(owner); report.executorCodeHash = executorRuntimeCode.keccak256; report.executorArtifactSha256 = sha(artifactBytes);
    // Price-only runs need not provision an executor. Bind the actual actor's
    // code separately; never replace an unrelated existing contract implicitly.
    report.executorProvisioning = assertExecutorCode(await rpc("eth_getCode", [executor, pin]), executorRuntimeCode.code);
    assertOriginAccountCode(await rpc("eth_getCode", [owner, pin]));
    if (provenance.counterfactualExecutorCode !== undefined)
      assert.equal(provenance.counterfactualExecutorCode.keccak256, executorRuntimeCode.keccak256);
    finalPins = async () => { assert.deepEqual(pins(), report.inputs); assert.deepEqual(sourcePin(), report.code);
      assert.equal(sha(readFileSync(artifactPath)), report.executorArtifactSha256);
      assert.equal((await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false])).hash, source.hash);
      assert.equal((await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false])).hash, HASH); };
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => {
        const client = new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 60_000, onFatal });
        const strict = client.strictSimulate.bind(client);
        client.strictSimulate = async (...input) => {
          try { const result = await strict(...input); (report.strictCalls ??= []).push({ stage, result }); return result; }
          catch (error) { (report.transportErrors ??= []).push({ stage, message: redact(error instanceof Error ? error.message : error) }); throw error; }
        };
        return client;
      },
      onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, source.number); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
    const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const deployed = async (label: string, address: string) => {
      const code = await rpc("eth_getCode", [address, pin]); assert(code !== "0x");
      const storage = await rpc("eth_getStorageAt", [address, implementationSlot, pin]);
      const implementation = BigInt(storage) === 0n ? undefined : ethers.getAddress("0x" + storage.slice(-40));
      const implementationCode = implementation ? await rpc("eth_getCode", [implementation, pin]) : undefined;
      assert(implementationCode !== "0x");
      return { label, address, source, codeHash: ethers.keccak256(code), codeBytes: ethers.getBytes(code).length,
        implementationSlot, storage, implementation, implementationCodeHash: implementationCode ? ethers.keccak256(implementationCode) : undefined };
    };
    const addressCall = async (target: string, method: string) => ethers.getAddress(ABI.decodeFunctionResult(method,
      await rpc("eth_call", [{ to: target, data: ABI.encodeFunctionData(method) }, pin]))[0]);
    const cdo = await addressCall(VAULT, "cdo"), strategy = await addressCall(cdo, "strategy");
    const cooldown = await addressCall(strategy, "erc20Cooldown");
    const isJunior = ABI.decodeFunctionResult("isJrt", await rpc("eth_call", [{ to: cdo, data: ABI.encodeFunctionData("isJrt", [VAULT]) }, pin]))[0];
    assert.equal(typeof isJunior, "boolean");
    const cooldownMethod = isJunior ? "sUSDeCooldownJrt" : "sUSDeCooldownSrt";
    const cooldownSeconds = BigInt(ABI.decodeFunctionResult(cooldownMethod, await rpc("eth_call", [{ to: strategy,
      data: ABI.encodeFunctionData(cooldownMethod) }, pin]))[0]);
    report.deployedBindings = { cdo, strategy, cooldown, isJunior, cooldownSeconds, contracts: await Promise.all([
      deployed("tranche", VAULT), deployed("cdo", cdo), deployed("strategy", strategy),
      deployed("cooldown", cooldown), deployed("payout", d.payoutToken)]) };
    assert.equal(cooldownSeconds, 0n, "sample is delayed redemption, outside synchronous settlement acceptance");
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, executor, concatBytes(...node.children.map(compile))); };
    let referenceComplete = true;
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!; assert(handle);
      const edge = graph.filter(e => e.instanceKey === d.instanceKey && same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)); assert.equal(edge.length, 1);
      const edgeId = blockScanEdgeKey(edge[0]!), effective = prices.runtime.pricing.effectiveMids.rows.get(edgeId);
      const p = productionAmount(effective, prices.runtime.pricing.mids.get(edgeId), edge[0], source, prices.runtime.generation);
      const borrowed = reference && p.status !== "met" ? splicedMissingProductionAmount(effective, route.tokenIn,
        reference.saved, reference.declaration, [reference.edge]) : undefined;
      if (p.status !== "met" && !borrowed) referenceComplete = false;
      if (borrowed) report.splicedReferenceUsed = true;
      const leg = guard.build(() => buildFamilyRuntimeAmountLeg({ family, route: handle, source, executor, runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog })); assert(leg, "no runtime fallback");
      const directLegs = requestedRecipient ? [executor, requestedRecipient].map(recipient => {
        const direct = guard.build(() => buildFamilyRuntimeAmountLeg({ family, route: handle, source, executor,
          runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog, settlement: { kind: "direct-output", recipient } }));
        assert(direct, "direct output may not fall back"); assert.deepEqual(direct.settlementRequest, { kind: "direct-output", recipient });
        return { recipient, leg: direct };
      }) : [];
      if (requestedRecipient) {
        const build = (settlement: any) => guard.build(() => buildFamilyRuntimeAmountLeg({ family, route: handle, source, executor,
          runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog, settlement }));
        assert.equal(build({ kind: "quote-output", recipient: executor }), null);
        assert.equal(build({ kind: "deferred-input", paymentAmount: 1n, paymentProgram: "0x0100" }), null);
        for (const recipient of [ethers.ZeroAddress, d.vault, d.payoutToken, d.underlyingAsset])
          assert.throws(() => build({ kind: "direct-output", recipient }));
      }
      const inputs: [string, bigint][] = [
        ...(p.status === "met" ? [["production-effective", p.amountIn] as [string, bigint]] : []),
        ...(borrowed ? [["spliced-production-input-only", borrowed.amountIn] as [string, bigint]] : []),
        ["original-burned-shares-at-N", original.shares], ["twice-original-burned-shares-at-N", original.shares * 2n],
      ];
      for (const [label, amountIn] of inputs) {
        const trial: any = { direction: (route as any).direction, tokenIn: route.tokenIn, tokenOut: route.tokenOut, label, amountIn,
          productionReference: p, borrowedReference: borrowed, status: "failed", executions: [] }; report.samples.push(trial);
        stage = "production-exact";
        const quote = await guard.exact(() => executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation, executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } }));
        trial.quote = quote; assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
        if (label === "production-effective" && p.status === "met") assert.equal(quote.amountOut, p.amountOut);
        const fragment = guard.quoted(() => buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: quote.amountOut, executor, runtimeEvidence: [], actionOwnership: catalog }));
        assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
        const quotedScript = concatBytes(...planFragmentNodes(fragment.fragment, route.tokenIn, amountIn).map(compile));
        trial.quotedConstruction = { scriptHash: ethers.keccak256(quotedScript),
          calldataHash: ethers.keccak256(buildSubscriptCalldata(quotedScript)), executed: true };
        trial.defaultRuntimeConstruction = { programHash: ethers.keccak256(leg.program),
          calldataHash: ethers.keccak256(buildSubscriptCalldata(runtimeProgramScript(ethers.getBytes(leg.program), amountIn))),
          executed: true };
        const scripts: readonly (readonly [string, Uint8Array, string])[] = [
          ["quoted", quotedScript, executor], ["runtime", runtimeProgramScript(ethers.getBytes(leg.program), amountIn), executor],
          ...directLegs.map(({ recipient, leg: direct }) => [same(recipient, executor) ? "direct-self" : "direct-external",
            runtimeProgramScript(ethers.getBytes(direct.program), amountIn), recipient] as const)];
        for (const [encoding, script, recipient] of scripts) for (const negative of ["none", "no-input", "post-execution-revert"] as const) {
          stage = encoding + ":" + negative;
          const result: any = { encoding, negative, recipient, scriptHash: ethers.keccak256(script), status: "failed" }; trial.executions.push(result);
          const executedScript: Uint8Array = negative === "post-execution-revert" ? concatBytes(script,
            runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes(), 0n)) : script;
          const caller = { kind: "executor" as const }, request: AdapterRequest = { id: "silo-redeem-execute", required: false, kind: "effect-delta-simulation",
            call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(executedScript) },
            overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [{ token: route.tokenIn, amount: negative === "no-input" ? 0n : amountIn + 101n },
              { token: route.tokenOut, amount: quote.amountOut + 103n }] },
            observeTokenBalances: [route.tokenIn, route.tokenOut].flatMap(token => [{ token, account: caller },
              ...(!same(recipient, executor) ? [{ token, account: recipient }] : [])]),
            observeTotalSupplies: [VAULT], observe: effects };
          result.request = request;
          const outcome: AdapterWorkOutcome<readonly AdapterRequestResult[]> = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: {
            stage: "exact-refine", familyId: FAMILY_ID, source, generation: source.generation, programInput: undefined,
            program: { requirements: () => requirements, buildRequests: (): readonly AdapterRequest[] => [request], decode: ({ results }): readonly AdapterRequestResult[] => results } } });
          result.outcome = outcome; assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw new Error("execution unresolved");
          const returned = outcome.executed.evidence[0]!; assert(returned.ok, "transport failure is not an EVM negative");
          if (negative === "none") { assert.equal(returned.completion, "returned"); assert.equal(returned.data, "0x");
            assertSiloRecipientEffects(returned.effects, executor, recipient, route.tokenIn, route.tokenOut, amountIn, quote.amountOut);
            result.quoteDelta = 0n;
          } else { assert.equal(returned.completion, "reverted-as-declared", "negative control did not revert");
            result.rollbackScope = "declared EVM revert only; no independent post-rollback storage observation"; }
          result.status = "pass";
        }
        trial.status = "pass"; console.log(json({ direction: trial.direction, label, status: trial.status }));
      }
    }
    assert(report.samples.length >= 2);
    report.measurementScope = "selected real Tranche instance: synchronous redeem to sUSDe; one supported direction";
    report.runtimeConstruction = { exactCalls: 0, quotedCalls: 0, rpcCalls: 0, quotedFallback: false, scope: "production issuer, not yet full sim selector" };
    report.invocationCounts = guard.counts; report.productionReference = referenceComplete ? "met" : "unmet";
    report.result = referenceComplete ? (report.splicedReferenceUsed ? "pass-with-spliced-reference" : "pass") : "same-state-pass-reference-incomplete";
  } catch (e) { report.error = { stage, message: redact(e instanceof Error ? e.message : e) }; process.exitCode = 1; }
  finally {
    try { await finalPins?.(); await simulation?.closeAndDrain(); report.drained = true; }
    catch (e) { report.finalError = redact(e instanceof Error ? e.message : e); report.result = "failed"; process.exitCode = 1;
      await simulation?.closeAndDrain().catch(() => {}); }
    clearTimeout(timer); report.directReads = reads; writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd);
    console.log(json({ result: report.result, error: report.error, out: args.get("--out"), samples: report.samples.length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("invalid Silo recipient arguments/output; no success claimed"); process.exitCode = 1; });
