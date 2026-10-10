// Opt-in N-end correctness via natural Ready, production issuer and local REVM.
// This is not original pre-call replay, full-loop acceptance or a latency test.
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
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
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
import { assertPriceInput, constructionGuard, assertExecutorCode, assertOriginAccountCode, json, sha, same } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertHistoricalDiscoveryReceipt } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { FAMILY } from "../manifest.js";
import { ABI, DECIMALS } from "../codec.js";
import type { Descriptor, Route } from "../types.js";
const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const TARGET = "0xdcef968d416a41cdac0ed8702fac8128a64241a2";
const CASES: Record<number, { tx: string; hash: string }> = {
  26152335: { tx: "0x6cc7a620da9e1fc47e894ec69bdbd3b1075c05ebc6c1807a3a6a000035fe136b", hash: "0x62a1a08653dd520793f8526d405430bcaabd5152459fca18e79f843514f3e0b3" },
  26152194: { tx: "0x3090f50f31cb6d02b87a575fb1770418b62f230868c177b2ac81591ed0650539", hash: "0x11408489e6cea134aa9414ba735f99fdcc1c1f78ad8156d04dcbe5f6c6c0cde6" },
};
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] as const;
async function main(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(), names = ["--ready", "--prices", "--rpc-file", "--revm-bin", "--out"];
  for (let i = 0; i < argv.length; i += 2) { assert(names.includes(argv[i]!) && !args.has(argv[i]!) && argv[i + 1]); args.set(argv[i]!, argv[i + 1]!); }
  assert(names.every(name => args.has(name)));
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [],
    claim: "source-bound four-direction coin/LP single-leg quote, quoted and runtime receipts; original TX observations separate",
    performance: "NOT RUN", originalPrecallParity: "NOT RUN", fullLoop: "NOT RUN", signing: false, broadcast: false, protocolOverrides: false };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 600_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 600_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, rpcUrl = "", reads = 0, stage = "inputs";
  const guard = constructionGuard(), redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  let finalPins: (() => Promise<void>) | undefined;
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricesPath = realpathSync(args.get("--prices")!);
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json"), fileURLToPath(import.meta.url)];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = pins(); report.code = sourcePin(); report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!));
    assert.equal(report.revmSha256, "36f22eecfdf8c92c3914347ace5a488b6ea3b53cd4b2b5f44d2943e7d17e903d");
    const prices = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2]!, "utf8"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff, sample = CASES[source.number];
    assert(sample); assert.equal(source.hash, sample.hash); report.source = source; report.tx = sample.tx;
    assertPriceInput(prices, provenance, ready, { readySha256: report.inputs[0].sha256, sourceTreeSha256: report.code.sourceTreeSha256, number: source.number });
    assert.equal(provenance.implementation.revmBinarySha256, report.revmSha256);
    const executor = ethers.getAddress(provenance.executor), owner = ethers.getAddress(provenance.owner); assert(!same(executor, owner)); report.actors = { executor, owner };
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === FAMILY && m.instanceKey === TARGET); assert.equal(memos.length, 1);
    const memo = memos[0]!, wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [FAMILY], executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo)); const family = asPricedFamily(catalog.forStrictFamily(FAMILY));
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d = instance.descriptor as Descriptor; assert.equal(d.pool, TARGET); assert.equal(instance.routes.length, 4);
    report.admission = { memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, candidate: memo.candidateSnapshot };
    rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL; assert(/^https?:\/\//.test(rpcUrl));
    const pin = { blockHash: source.hash, requireCanonical: true };
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      guard.check(); abort.signal.throwIfAborted(); const id = ++reads; assert(id <= 1000);
      assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25_000)]) });
      assert(res.ok, `HTTP ${res.status}`); const body: any = await res.json(); assert.equal(body.id, id); assert.equal(body.jsonrpc, "2.0"); assert(!body.error, `read failed: ${method}`); return body.result;
    };
    stage = "source-and-runtime"; const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]); assert.equal(header.hash, sample.hash); report.header = header;
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const receipt = await rpc("eth_getTransactionReceipt", [sample.tx]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: sample.tx, blockNumber: source.number, blockHash: sample.hash }, source);
    const candidate: any = memo.candidateSnapshot;
    assertHistoricalDiscoveryReceipt(same(candidate.transactionHash, sample.tx) ? receipt : await rpc("eth_getTransactionReceipt", [candidate.transactionHash]), candidate, source);
    report.originalObservation = { receipt, scope: "receipt facts, not original pre-call replay" };
    const artifactPath = resolve(ROOT, "out/BotVM.sol/BotVM.json"), artifactBytes = readFileSync(artifactPath), artifact = JSON.parse(artifactBytes.toString());
    const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
    assert.equal(metadata.settings.compilationTarget["src/BotVM.sol"], "BotVM"); assert(Object.keys(metadata.sources).length > 0);
    for (const [name, entry] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) { const p = realpathSync(resolve(ROOT, name));
      assert(name.endsWith(".sol") && !relative(realpathSync(ROOT), p).startsWith("..")); assert.equal(ethers.keccak256(readFileSync(p)), entry.keccak256, "stale executor source"); }
    const refs = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
    assert.equal(refs.length, 1); assert(refs[0]!.length > 0 && refs[0]!.every(r => r.length === 32));
    const executorRuntimeCode = loadBotVmRuntimeCode(owner); report.executorCodeHash = executorRuntimeCode.keccak256; report.executorArtifactSha256 = sha(artifactBytes);
    report.executorProvisioning = assertExecutorCode(await rpc("eth_getCode", [executor, pin]), executorRuntimeCode.code); assertOriginAccountCode(await rpc("eth_getCode", [owner, pin]));
    finalPins = async () => { assert.deepEqual(pins(), report.inputs); assert.deepEqual(sourcePin(), report.code); assert.equal(sha(readFileSync(artifactPath)), report.executorArtifactSha256);
      assert.equal((await rpc("eth_getBlockByNumber", [ethers.toQuantity(source.number), false])).hash, sample.hash); };
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 60_000, onFatal }), onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, source.number); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, source.number); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, executor, concatBytes(...node.children.map(compile))); };
    for (const route of instance.routes as Route[]) {
      const handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!; assert(handle);
      const edges = graph.filter(e => e.instanceKey === TARGET && same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)); assert.equal(edges.length, 1);
      const key = blockScanEdgeKey(edges[0]!), row = prices.runtime.pricing.effectiveMids.rows.get(key); assert(prices.runtime.pricing.mids.get(key));
      assert.equal(row?.status, "quoted", "production reference input unavailable"); assert(row.amountIn > 0n);
      const inputs: [string, bigint][] = [["natural-production-input", row.amountIn], ["two-production-inputs", row.amountIn * 2n]];
      if (route.index === 1) inputs.push(["observed-historical-input-at-N", route.direction === "mint" ? 36977795n : 265363627991310138877n]);
      else inputs.push(["one-token-at-N", 10n ** BigInt(route.direction === "mint" ? DECIMALS[route.index] : 18)]);
      const leg = guard.build(() => buildFamilyRuntimeAmountLeg({ family, route: handle, source, executor, runtime: guard.runtime(runtime), runtimeEvidence: [], actionOwnership: catalog }));
      assert(leg, "no runtime fallback"); assert.notEqual(leg.inputMode, "maximum");
      for (const [label, amountIn] of inputs) {
        const trial: any = { label, direction: route.direction, index: route.index, amountIn, reference: { key, row }, tokenIn: route.tokenIn, tokenOut: route.tokenOut, status: "failed", executions: [] }; report.samples.push(trial);
        stage = "production-exact"; const quote = await guard.exact(() => executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation,
          executor, runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } }));
        trial.quote = quote; assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
        const buildQuoted = (minimum: bigint) => { const fragment = guard.quoted(() => buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: minimum,
          executor, runtimeEvidence: [], actionOwnership: catalog })); assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
          return concatBytes(...planFragmentNodes(fragment.fragment, route.tokenIn, amountIn).map(compile)); };
        const checkAllowance = route.direction === "mint" ? runtimeProgramScript(new RuntimeAmountProgram().call(route.tokenIn, ABI.encodeFunctionData("allowance", [executor, TARGET]), { static: true })
          .load(1, 0).constant(2, 0n).equal(1, 2).bytes(), 0n) : new Uint8Array();
        const scripts: readonly (readonly ["quoted" | "runtime", Uint8Array])[] = [["quoted", concatBytes(buildQuoted(quote.amountOut), checkAllowance)], ["runtime", concatBytes(runtimeProgramScript(ethers.getBytes(leg.program), amountIn), checkAllowance)]];
        for (const [encoding, script] of scripts) for (const negative of label === "natural-production-input" ? ["none", "no-input", "post-execution-revert"] : ["none"]) {
          stage = encoding + ":" + negative; const result: any = { encoding, negative, status: "failed" }; trial.executions.push(result);
          const executed: Uint8Array = negative === "post-execution-revert" ? concatBytes(script, runtimeProgramScript(new RuntimeAmountProgram().constant(0, 0n).constant(1, 1n).equal(0, 1).bytes(), 0n)) : script;
          const caller = { kind: "executor" as const }, request: AdapterRequest = { id: "lp-execute", required: false, kind: "effect-delta-simulation",
            call: { caller, executionMode: "executor-program", to: executor, data: buildSubscriptCalldata(executed) },
            overrideIntent: { caller, nativeBalanceWei: 17n, tokenBalances: [{ token: route.tokenIn, amount: negative === "no-input" ? 0n : amountIn + 101n }, { token: route.tokenOut, amount: quote.amountOut + 103n }] },
            observeTokenBalances: [{ token: route.tokenIn, account: caller }, { token: route.tokenIn, account: TARGET }, { token: route.tokenOut, account: caller }, { token: route.tokenOut, account: TARGET }],
            observeTotalSupplies: [d.lp], observe: effects };
          result.request = request;
          const outcome = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: { stage: "exact-refine", familyId: FAMILY, source, generation: source.generation, programInput: undefined,
            program: { requirements: () => ({ transports: ["effect-delta-simulation"], caller: "executor", effects }), buildRequests: (): readonly AdapterRequest[] => [request], decode: ({ results }): readonly AdapterRequestResult[] => results } } });
          result.outcome = outcome; assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw new Error("execution unresolved");
          const returned = outcome.executed.evidence[0]!; assert(returned.ok, "transport failure is not an EVM negative");
          if (negative === "none") {
            assert.equal(returned.completion, "returned"); assert.equal(returned.data, "0x"); assert.equal(returned.effects?.tokenDeltas?.length, 4);
            const expected: readonly (readonly [string, string, bigint])[] = [[route.tokenIn, executor, -amountIn], [route.tokenIn, TARGET, route.direction === "mint" ? amountIn : 0n],
              [route.tokenOut, executor, quote.amountOut], [route.tokenOut, TARGET, route.direction === "redeem" ? -quote.amountOut : 0n]];
            for (const [token, account, delta] of expected) { const matched: NonNullable<ObservedEffects["tokenDeltas"]> = returned.effects!.tokenDeltas!.filter(r => same(r.token, token) && same(r.account, account));
              assert.equal(matched.length, 1); assert.equal(matched[0].delta, delta); }
            assert.deepEqual(returned.effects?.totalSupplyDeltas, [{ token: d.lp, delta: route.direction === "mint" ? quote.amountOut : -amountIn }]);
            const native = returned.effects?.nativeDeltas; assert.equal(native?.length, 1); assert(same(native![0].account, executor)); assert.equal(native![0].delta, 0n);
            result.quoteDelta = 0n; result.debitDelta = 0n;
          } else { assert.equal(returned.completion, "reverted-as-declared", "negative did not revert");
            for (const values of [returned.effects?.tokenDeltas, returned.effects?.nativeDeltas, returned.effects?.totalSupplyDeltas]) assert(values?.every(d => d.delta === 0n) ?? true); }
          result.status = "pass";
        }
        trial.status = "pass"; console.log(json({ label, direction: route.direction, index: route.index, status: trial.status, amountIn, amountOut: quote.amountOut }));
      }
    }
    report.runtimeConstruction = { exactCalls: 0, quotedCalls: 0, rpcCalls: 0, quotedFallback: false, scope: "production issuer construction; historical EVM executes single-leg programs, not a full-loop final sim" };
    report.invocationCounts = guard.counts; report.result = "same-state-four-direction-dual-pass";
  } catch (e) { report.error = { stage, message: redact(e instanceof Error ? e.message : e) }; process.exitCode = 1; }
  finally {
    try { await finalPins?.(); await simulation?.closeAndDrain(); report.drained = true; }
    catch (e) { report.finalError = redact(e instanceof Error ? e.message : e); report.result = "failed"; process.exitCode = 1; await simulation?.closeAndDrain().catch(() => {}); }
    clearTimeout(timer); report.directReads = reads; writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd); console.log(json({ result: report.result, error: report.error, out: args.get("--out"), samples: report.samples.length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("invalid Curve LP dual arguments/output; no success claimed"); process.exitCode = 1; });
