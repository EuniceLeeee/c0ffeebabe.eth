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
import { assertPriceInput, productionAmount, splicedProductionAmount, constructionGuard, assertExecutorCode, assertOriginAccountCode, json, sha, same } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertHistoricalDiscoveryReceipt } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { ERC4626_FAMILY_ID, INFINIFI_LINEAGE_ID } from "../manifest.js";
import { ERC4626_INTERFACE } from "../abi.js";
import { INFINIFI_ABI, INFINIFI_GATEWAY } from "../infinifi.js";

const N = 25944594, HASH = "0x3fffa168458c84ea4cb5c5587db4e3eddcdad91c260baeff8b763ced64a7886e";
const ACCRUED = { number: 25944595, generation: 25944595,
  hash: "0x51a7fb91a39d3dac70e86ee6e13e186522ad4cee2addc7bfe44a718a47c9b10e" };
const TX = "0x3ba33cd287b063eebfdcc42802e143b9107e1923df56d16a2c94cbd5f81dc4a5";
const VAULT = "0xdbdc1ef57537e34680b898e1febd3d68c7389bcb";
const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;
const requirements = { transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects };

export function assertInfiniFiEffects(actual: ObservedEffects | undefined, executor: string,
  tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint): void {
  assert.equal(actual?.tokenDeltas?.length, 4);
  for (const [token, account, delta] of [[tokenIn, executor, -amountIn], [tokenOut, executor, amountOut],
    [tokenIn, INFINIFI_GATEWAY, 0n], [tokenOut, INFINIFI_GATEWAY, 0n]] as const) {
    const rows: NonNullable<ObservedEffects["tokenDeltas"]> = actual!.tokenDeltas!.filter(r => same(r.token, token) && same(r.account, account));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.delta, delta);
  }
  assert.equal(actual?.nativeDeltas?.length, 1);
  assert(same(actual!.nativeDeltas![0]!.account, executor)); assert.equal(actual!.nativeDeltas![0]!.delta, 0n);
}

async function main(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(), required = ["--ready", "--prices", "--rpc-file", "--revm-bin", "--out"];
  const names = [...required, "--state", "--reference-prices", "--reference-edge"];
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]!) && !args.has(argv[i]!) && argv[i + 1]); args.set(argv[i]!, argv[i + 1]!);
  }
  assert(required.every(name => args.has(name)));
  assert.equal(args.has("--reference-prices"), args.has("--reference-edge"));
  const nextState = args.get("--state") === "next-accrual";
  assert(args.get("--state") === undefined || args.get("--state") === "receipt" || nextState);
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [], tx: TX,
    claim: "same-state production quote/quoted/runtime receipts; natural admission at N; no original pre-call or opportunity verdict",
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
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json"), fileURLToPath(import.meta.url),
      ...(referencePath ? [referencePath, declarationPath!] : [])];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = pins(); report.code = sourcePin(); report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!));
    const reference = referencePath ? { saved: parseAtBlockJson(readFileSync(referencePath, "utf8")),
      declaration: parseAtBlockJson(readFileSync(declarationPath!, "utf8")), edge: args.get("--reference-edge")! } : undefined;
    if (reference) report.referenceInputSource = { prices: referencePath, declaration: declarationPath,
      sourceCommit: reference.declaration.head, cfg: reference.saved.cfg, readySha256: reference.saved.readySha256,
      graphEdges: reference.saved.runtime.graph.edges.length, inputOnly: true, actualLiveEvidence: false };
    const prices = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2]!, "utf8"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), discoverySource = ready.cutoff;
    assert.equal(discoverySource.number, N); assert.equal(discoverySource.hash, HASH);
    const source = nextState ? ACCRUED : discoverySource;
    report.source = source; report.discoverySource = discoverySource;
    report.stateScope = nextState ? "N Ready reused at N+1 through current-source guards; not N+1 natural discovery" : "N state and N Ready";
    assertPriceInput(prices, provenance, ready, { readySha256: report.inputs[0].sha256,
      sourceTreeSha256: report.code.sourceTreeSha256, number: N });
    assert.equal(provenance.implementation.revmBinarySha256, report.revmSha256);
    const executor = ethers.getAddress(provenance.executor), owner = ethers.getAddress(provenance.owner);
    assert(!same(executor, owner)); report.actors = { executor, owner };
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === ERC4626_FAMILY_ID && same(m.instanceKey, VAULT)); assert.equal(memos.length, 1);
    const memo = memos[0]!; assert([familyDefinitionHash(ERC4626_FAMILY_ID), familyMemoDefinitionHash(ERC4626_FAMILY_ID)].includes(memo.familyDefinitionHash));
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [ERC4626_FAMILY_ID], executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const family = asPricedFamily(catalog.forStrictFamily(ERC4626_FAMILY_ID));
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d: any = instance.descriptor; assert(d.infinifi && d.lineageId === INFINIFI_LINEAGE_ID); assert.equal(instance.routes.length, 2);
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
    if (nextState) assert.equal(header.parentHash, HASH);
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const receipt = await rpc("eth_getTransactionReceipt", [TX]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: TX, blockNumber: N, blockHash: HASH }, discoverySource);
    const candidate: any = memo.candidateSnapshot;
    assertHistoricalDiscoveryReceipt(same(candidate.transactionHash, TX) ? receipt : await rpc("eth_getTransactionReceipt", [candidate.transactionHash]), candidate, discoverySource);
    const withdrawals = receipt.logs.filter((l: any) => !l.removed && same(l.address, VAULT) && same(l.topics[0], ERC4626_INTERFACE.getEvent("Withdraw")!.topicHash));
    assert.equal(withdrawals.length, 1); const original = ERC4626_INTERFACE.parseLog(withdrawals[0])!.args;
    assert(same(original.sender, INFINIFI_GATEWAY) && same(original.owner, INFINIFI_GATEWAY));
    report.originalObservation = { receipt, assets: original.assets, shares: original.shares, scope: "receipt amount anchors only; no pre-call-state parity claim" };
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
      createClient: ({ onFatal }) => new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 60_000, onFatal }),
      onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, source.number); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
    report.pendingRewards = BigInt(INFINIFI_ABI.decodeFunctionResult("vested", await rpc("eth_call", [{
      to: d.infinifi.yieldSharing, data: INFINIFI_ABI.encodeFunctionData("vested") }, pin]))[0]);
    if (nextState) assert(report.pendingRewards > 0n, "selected next state has no accrued rewards");
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, executor, concatBytes(...node.children.map(compile))); };
    let referenceComplete = true;
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!; assert(handle);
      const edge = graph.filter(e => e.instanceKey === VAULT && same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)); assert.equal(edge.length, 1);
      const edgeId = blockScanEdgeKey(edge[0]!), effective = prices.runtime.pricing.effectiveMids.rows.get(edgeId);
      const p = nextState ? { status: "unmet" as const, reason: "saved price reference belongs to discovery N, not N+1" } :
        productionAmount(effective, prices.runtime.pricing.mids.get(edgeId), edge[0], source, prices.runtime.generation);
      const donorRow = reference?.saved.runtime.pricing.effectiveMids.rows.get(reference.edge);
      if (reference) assert(donorRow, "selected donor row missing");
      const borrowed = donorRow && same(donorRow.tokenIn, route.tokenIn) ?
        splicedProductionAmount(reference!.saved, reference!.declaration, [reference!.edge], route.tokenIn) : undefined;
      if (p.status !== "met" && borrowed === undefined) referenceComplete = false;
      const leg = guard.build(() => buildFamilyRuntimeAmountLeg({ family, route: handle, source, executor, runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog })); assert(leg, "no runtime fallback");
      const originalAmount = same(route.tokenIn, VAULT) ? original.shares : original.assets;
      const inputs: [string, bigint][] = [...(p.status === "met" ? [["production-effective", p.amountIn] as [string, bigint]] : []),
        ...(borrowed ? [["spliced-production-input-only", borrowed.amountIn] as [string, bigint]] : []),
        ["one-token-control-not-production-reference", 10n ** 18n],
        [same(route.tokenIn, VAULT) ? "original-redeem-input-at-tested-state" : "original-assets-as-deposit-control-at-tested-state", originalAmount]];
      for (const [label, amountIn] of inputs) {
        const trial: any = { direction: (route as any).direction, tokenIn: route.tokenIn, tokenOut: route.tokenOut, label, amountIn,
          productionReference: p, borrowedReference: borrowed, status: "failed", executions: [] }; report.samples.push(trial);
        stage = "production-exact";
        const quote = await guard.exact(() => executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation, executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } }));
        trial.quote = quote; assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
        const preview = same(route.tokenIn, VAULT) ? "previewRedeem" : "previewDeposit";
        trial.bareVaultPreview = BigInt(INFINIFI_ABI.decodeFunctionResult(preview, await rpc("eth_call", [{
          to: VAULT, data: INFINIFI_ABI.encodeFunctionData(preview, [amountIn]) }, pin]))[0]);
        trial.distributionDelta = quote.amountOut - trial.bareVaultPreview;
        if (nextState) assert.notEqual(trial.distributionDelta, 0n, "accrued sample must distinguish the bare vault preview");
        if (label === "production-effective" && p.status === "met") assert.equal(quote.amountOut, p.amountOut);
        const fragment = guard.quoted(() => buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: quote.amountOut, executor, runtimeEvidence: [], actionOwnership: catalog }));
        assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
        const scripts: readonly (readonly ["quoted" | "runtime", Uint8Array])[] = [["quoted", concatBytes(...planFragmentNodes(fragment.fragment, route.tokenIn, amountIn).map(compile))],
          ["runtime", runtimeProgramScript(ethers.getBytes(leg.program), amountIn)]] as const;
        for (const [encoding, script] of scripts) for (const negative of ["none", "no-input", "post-execution-revert"] as const) {
          stage = encoding + ":" + negative;
          const result: any = { encoding, negative, status: "failed" }; trial.executions.push(result);
          const executedScript: Uint8Array = negative === "post-execution-revert" ? concatBytes(script,
            runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes(), 0n)) : script;
          const caller = { kind: "executor" as const }, request: AdapterRequest = { id: "infinifi-execute", required: false, kind: "effect-delta-simulation",
            call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(executedScript) },
            overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [{ token: route.tokenIn, amount: negative === "no-input" ? 0n : amountIn + 101n },
              { token: route.tokenOut, amount: quote.amountOut + 103n }] },
            observeTokenBalances: [route.tokenIn, route.tokenOut].flatMap(token => [{ token, account: caller }, { token, account: INFINIFI_GATEWAY }]), observe: effects };
          result.request = request;
          const outcome: AdapterWorkOutcome<readonly AdapterRequestResult[]> = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: {
            stage: "exact-refine", familyId: ERC4626_FAMILY_ID, source, generation: source.generation, programInput: undefined,
            program: { requirements: () => requirements, buildRequests: (): readonly AdapterRequest[] => [request], decode: ({ results }): readonly AdapterRequestResult[] => results } } });
          result.outcome = outcome; assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw new Error("execution unresolved");
          const returned = outcome.executed.evidence[0]!; assert(returned.ok, "transport failure is not an EVM negative");
          if (negative === "none") { assert.equal(returned.completion, "returned"); assert.equal(returned.data, "0x");
            assertInfiniFiEffects(returned.effects, executor, route.tokenIn, route.tokenOut, amountIn, quote.amountOut); result.quoteDelta = 0n;
          } else assert.equal(returned.completion, "reverted-as-declared", "negative control did not revert");
          result.status = "pass";
        }
        trial.status = "pass"; console.log(json({ direction: trial.direction, label, status: trial.status }));
      }
    }
    report.runtimeConstruction = { exactCalls: 0, quotedCalls: 0, rpcCalls: 0, quotedFallback: false, scope: "production issuer, not yet full sim selector" };
    report.invocationCounts = guard.counts; report.productionReference = referenceComplete ? "met" : "unmet";
    report.result = referenceComplete ? "pass" : "same-state-pass-reference-incomplete";
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
  main().catch(() => { console.error("invalid InfiniFi dual arguments/output; no success claimed"); process.exitCode = 1; });
