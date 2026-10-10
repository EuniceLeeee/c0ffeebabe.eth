// Opt-in historical correctness only. Uses immutable natural Ready/production
// prices and the source-pinned local REVM transport; never runs live or signs.
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
import type { AdapterRequest, AdapterRequestResult, ObservedEffects } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
import { assertPriceInput, productionAmount, constructionGuard, assertExecutorCode, assertOriginAccountCode, json, sha, same } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertHistoricalDiscoveryReceipt } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { FAMILY } from "../manifest.js";
import { ABI } from "../codec.js";
import type { Descriptor, Route } from "../types.js";

const N = 26152596, HASH = "0x107b98060d965fb8a7323495a1c4fdbc06acd4315ad3f9ba1967918985f6fbeb";
const TX = "0xd62e67ae40e3479b6e6612ab49ba0d2aea3c0cd09d8921b31e7bfd29a9a4a2b8";
const TARGET = "0xc72178d412256a6dc5f04d749859b4cd95076d61";
const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
// Single-leg receipts with pre-existing input/output inventory. No protocol
// balance/state override and no claim of original pre-call state replay.
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;
const requirements = { transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects };

async function main(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(), names = ["--ready", "--prices", "--rpc-file", "--revm-bin", "--out"];
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]!) && !args.has(argv[i]!) && argv[i + 1]); args.set(argv[i]!, argv[i + 1]!);
  }
  assert(names.every(name => args.has(name)));
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [], tx: TX,
    claim: "N-end production quote/quoted/runtime single-leg receipts, not original pre-call parity or full-loop execution",
    performance: "NOT RUN", signing: false, broadcast: false, protocolOverrides: false, actorOnlyFunding: true };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 480_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 480_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, rpcUrl = "", reads = 0, stage = "inputs";
  const guard = constructionGuard();
  const redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  let finalPins: (() => Promise<void>) | undefined;
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricesPath = realpathSync(args.get("--prices")!);
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json"), fileURLToPath(import.meta.url)];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = pins(); report.code = sourcePin(); report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!));
    assert.equal(report.revmSha256, "36f22eecfdf8c92c3914347ace5a488b6ea3b53cd4b2b5f44d2943e7d17e903d");
    const prices = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2]!, "utf8"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    assert.equal(source.number, N); assert.equal(source.hash, HASH); report.source = source;
    assertPriceInput(prices, provenance, ready, { readySha256: report.inputs[0].sha256, sourceTreeSha256: report.code.sourceTreeSha256, number: N });
    assert.equal(provenance.implementation.revmBinarySha256, report.revmSha256);
    const executor = ethers.getAddress(provenance.executor), owner = ethers.getAddress(provenance.owner);
    assert(!same(executor, owner)); report.actors = { executor, owner };
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === FAMILY && same(m.instanceKey, TARGET)); assert.equal(memos.length, 1);
    const memo = memos[0]!, wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [FAMILY], executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const family = asPricedFamily(catalog.forStrictFamily(FAMILY));
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d = instance.descriptor as Descriptor; assert.equal(d.target, TARGET); assert.equal(instance.routes.length, 2);
    report.admission = { memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, candidate: memo.candidateSnapshot };
    rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(/^https?:\/\//.test(rpcUrl));
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
    const receipt = await rpc("eth_getTransactionReceipt", [TX]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: TX, blockNumber: N, blockHash: HASH }, source);
    const candidate: any = memo.candidateSnapshot;
    assertHistoricalDiscoveryReceipt(same(candidate.transactionHash, TX) ? receipt : await rpc("eth_getTransactionReceipt", [candidate.transactionHash]), candidate, source);
    const swaps = receipt.logs.filter((l: any) => !l.removed && same(l.address, TARGET) && same(l.topics[0], ABI.getEvent("Swap")!.topicHash));
    assert.equal(swaps.length, 1); const original = ABI.parseLog(swaps[0])!.args;
    const outputs = receipt.logs.filter((l: any) => !l.removed && same(l.address, d.stable) && same(l.topics[0], ABI.getEvent("Transfer")!.topicHash))
      .map((l: any) => ABI.parseLog(l)!.args).filter((a: any) => same(a.from, TARGET) && same(a.to, original.recipient));
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].value, original.amountOut);
    report.originalObservation = { amountIn: original.amountIn, amountOut: outputs[0].value, receiver: original.recipient, fee: original.fee,
      scope: "original receipt only; N end is not original pre-call state", receipt };
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
          try { return await strict(...input); }
          catch (error) { (report.transportErrors ??= []).push({ stage, message: redact(error instanceof Error ? error.message : error) }); throw error; }
        };
        return client;
      },
      onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, N); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, N); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, N); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, executor, concatBytes(...node.children.map(compile))); };
    report.productionReferences = [];
    for (const route of instance.routes as readonly Route[]) {
    const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!; assert(handle);
    const edges = graph.filter(e => e.instanceKey === TARGET && same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)); assert.equal(edges.length, 1);
    const edgeId = blockScanEdgeKey(edges[0]!), p = productionAmount(prices.runtime.pricing.effectiveMids.rows.get(edgeId), prices.runtime.pricing.mids.get(edgeId), edges[0], source, prices.runtime.generation);
    assert.equal(p.status, "met"); if (p.status !== "met") throw new Error("production reference unavailable"); report.productionReferences.push({ direction: route.direction, ...p });
    const leg = guard.build(() => buildFamilyRuntimeAmountLeg({ family, route: handle, source, executor, runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog })); assert(leg, "no runtime fallback");
    const inputs: [string, bigint][] = [["production-effective", p.amountIn], ["original-size-at-N-end", original.amountIn],
      ["one-token-control", 10n ** BigInt(route.direction === "sell-gem" ? d.gemDecimals : d.stableDecimals)], ["one-raw-control", 1n]];
    for (const [label, amountIn] of inputs) {
      const trial: any = { label, direction: route.direction, amountIn, tokenIn: route.tokenIn, tokenOut: route.tokenOut, status: "failed", executions: [] }; report.samples.push(trial);
      stage = "production-exact";
      const quote = await guard.exact(() => executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation, executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } }));
      trial.quote = quote; assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
      if (label === "production-effective") assert.equal(quote.amountOut, p.amountOut);
      const fragment = guard.quoted(() => buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: quote.amountOut, executor, runtimeEvidence: [], actionOwnership: catalog }));
      assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
      const allowanceCheck = runtimeProgramScript(new RuntimeAmountProgram().call(route.tokenIn, ABI.encodeFunctionData("allowance", [executor, TARGET]), { static: true })
        .load(1, 0).constant(2, 0n).equal(1, 2).bytes(), 0n);
      const scripts = [["quoted", concatBytes(...planFragmentNodes(fragment.fragment, route.tokenIn, amountIn).map(compile), allowanceCheck)],
        ["runtime", concatBytes(runtimeProgramScript(ethers.getBytes(leg.program), amountIn), allowanceCheck)]] as const;
      for (const [encoding, script] of scripts) for (const negative of label === "production-effective" ? ["none", "no-input", "post-execution-revert"] : ["none"]) {
        stage = encoding + ":" + negative;
        const result: any = { encoding, negative, status: "failed" }; trial.executions.push(result);
        const executedScript = negative === "post-execution-revert" ? concatBytes(script,
          runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes(), 0n)) : script;
        const caller = { kind: "executor" as const }, request: AdapterRequest = { id: "psv-execute", required: false, kind: "effect-delta-simulation",
          call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(executedScript) },
          overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [{ token: route.tokenIn, amount: negative === "no-input" ? 0n : amountIn + 101n },
            { token: route.tokenOut, amount: quote.amountOut + 103n }] },
          observeTokenBalances: [route.tokenIn, route.tokenOut].flatMap(token => [{ token, account: caller }, { token, account: TARGET }]), observe: effects };
        result.request = request;
        const outcome: AdapterWorkOutcome<readonly AdapterRequestResult[]> = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: {
          stage: "exact-refine", familyId: FAMILY, source, generation: source.generation, programInput: undefined,
          program: { requirements: () => requirements, buildRequests: (): readonly AdapterRequest[] => [request], decode: ({ results }): readonly AdapterRequestResult[] => results } } });
        result.outcome = outcome; assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw new Error("execution unresolved");
        const returned = outcome.executed.evidence[0]!; assert(returned.ok, "transport failure is not an EVM negative");
        if (negative === "none") {
          assert.equal(returned.completion, "returned"); assert.equal(returned.data, "0x");
          assert.equal(returned.effects?.tokenDeltas?.length, 4);
          // This pinned state has both fees zero (independently observed below).
          const expected: readonly (readonly [string, string, bigint])[] = [[route.tokenIn, executor, -amountIn], [route.tokenIn, TARGET, amountIn],
            [route.tokenOut, executor, quote.amountOut], [route.tokenOut, TARGET, -quote.amountOut]];
          for (const [token, account, delta] of expected) {
            const matched: NonNullable<ObservedEffects["tokenDeltas"]> = returned.effects!.tokenDeltas!.filter(r => same(r.token, token) && same(r.account, account)); assert.equal(matched.length, 1); assert.equal(matched[0].delta, delta);
          }
          const native: ObservedEffects["nativeDeltas"] = returned.effects?.nativeDeltas; assert.equal(native?.length, 1); assert(same(native![0].account, executor)); assert.equal(native![0].delta, 0n);
          const events = returned.effects?.logs?.filter(l => same(l.address, TARGET) && same(l.topics[0], ABI.getEvent("Swap")!.topicHash));
          assert.equal(events?.length, 1); const event = ABI.parseLog({ data: events![0].data, topics: [...events![0].topics] })!.args;
          assert(same(event.sender, executor) && same(event.recipient, executor));
          assert(same(event.tokenIn, route.tokenIn) && same(event.tokenOut, route.tokenOut));
          assert.equal(event.amountIn, amountIn); assert.equal(event.amountOut, quote.amountOut); assert.equal(event.fee, 0n); result.quoteDelta = 0n;
        } else { assert.equal(returned.completion, "reverted-as-declared", "negative did not revert");
          assert(returned.effects?.tokenDeltas?.every(d => d.delta === 0n) ?? true); }
        result.status = "pass";
      }
      trial.status = "pass"; console.log(json({ label, direction: route.direction, status: trial.status, amountOut: quote.amountOut }));
    }
    }
    report.runtimeConstruction = { exactCalls: 0, quotedCalls: 0, rpcCalls: 0, quotedFallback: false, scope: "production issuer; selector contract separately tested offline" };
    report.invocationCounts = guard.counts; report.result = "pass";
  } catch (e) { report.error = { stage, message: redact(e instanceof Error ? e.message : e) }; process.exitCode = 1; }
  finally {
    try { await finalPins?.(); await simulation?.closeAndDrain(); report.drained = true; }
    catch (e) { report.finalError = redact(e instanceof Error ? e.message : e); report.result = "failed"; process.exitCode = 1; await simulation?.closeAndDrain().catch(() => {}); }
    clearTimeout(timer); report.directReads = reads; writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd);
    console.log(json({ result: report.result, error: report.error, out: args.get("--out"), samples: report.samples.length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("invalid PSV dual arguments/output; no success claimed"); process.exitCode = 1; });
