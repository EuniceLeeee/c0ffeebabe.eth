// Opt-in same-N evidence from natural production Ready/price artifacts.
// Uses the production Exact issuer, quoted action and runtime builder, then
// independently observes both scripts through the trusted executor transport.
// Per-call times are diagnostics, NOT the live-stage latency benchmark.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
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
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../../universe-rebuild-production.js";
import { planFragmentNodes } from "../../../../solver/plan-fragment-requirements.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import type { AdapterRequest, ObservedEffects } from "../../../adapter-request-program.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../production-infra-actions.js";
import { assertHistoricalDiscoveryReceipt, assertHistoricalPriceDirection } from "../../../../test/family-integration/three-family/historical-input-observations.js";
import { YIELDBASIS_FAMILY_ID } from "../manifest.js";
import { DEPOSIT_REQUIREMENTS, DEPOSIT_EFFECTS, DEPOSIT_DEBT_POLICY } from "../deposit.js";
import { LT_INTERFACE } from "../abi.js";

const N = 26003536, HASH = "0xf913fc4aaaeca0fd9fcd871c1a2b0159e1ecc3679724fff679a061ca7bedeaad";
const TX = "0x022a9ff85219675bcf0a0a2b17c76ac72b98d5e2c4177bc104edff56e706ee77";
const LT = "0x2b9c9f3bdceb5d8e36a4704f08a78fca53343cea";
const EXECUTOR = "0x1000000000000000000000000000000000000002", OWNER = "0x1000000000000000000000000000000000000001";
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x, 2);
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function assertObservedLeg(effects: ObservedEffects | undefined, input: string, output: string,
  stable: string, amountIn: bigint, amountOut: bigint): void {
  assert(effects?.tokenDeltas && effects.tokenDeltas.length === 3, "missing/extra balance observations");
  for (const [token, delta] of [[input, -amountIn], [output, amountOut], [stable, 0n]] as const) {
    const rows = effects.tokenDeltas.filter(r => same(r.token, token) && same(r.account, EXECUTOR));
    assert.equal(rows.length, 1, "ambiguous observation"); assert.equal(rows[0]!.delta, delta, "actual debit/receipt differs");
  }
  assert.equal(effects.nativeDeltas?.length, 1);
  assert(same(effects.nativeDeltas![0]!.account, EXECUTOR)); assert.equal(effects.nativeDeltas![0]!.delta, 0n);
}

function sourcePin() {
  const root = fileURLToPath(new URL("../../../../../", import.meta.url)), files: [string, string][] = [];
  const visit = (relative: string) => {
    for (const e of readdirSync(resolve(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "test" || e.name === "templates") continue;
      const p = relative ? relative + "/" + e.name : e.name;
      if (e.isDirectory()) visit(p); else { assert(e.isFile()); files.push([p, sha(readFileSync(resolve(root, p)))]); }
    }
  };
  visit(""); return sha(JSON.stringify(files));
}

async function main() {
  const args = new Map<string, string>(), names = ["--ready", "--prices", "--rpc-env", "--revm-bin", "--out"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert(names.includes(key) && !args.has(key) && value); args.set(key, value);
  }
  assert.equal(args.size, names.length); assert.equal(args.get("--rpc-env"), "MAINNET_RPC_URL");
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [],
    tx: TX, block: N, hash: HASH, policy: DEPOSIT_DEBT_POLICY, broadcast: false,
    claim: "same-N production quote/quoted/runtime actual receipts; no original-precall, profitability or representative latency verdict" };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 360_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 360_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, rpcUrl = "", reads = 0;
  let constructing = false, constructionReads = 0, stage = "inputs";
  const redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const error = (e: unknown) => ({ stage, message: redact(e instanceof Error ? e.message : e) });
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricesPath = realpathSync(args.get("--prices")!);
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json")];
    const inputPins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = inputPins(); report.sourceTreeSha256 = sourcePin();
    report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!)); report.harnessSha256 = sha(readFileSync(fileURLToPath(import.meta.url)));
    const prices = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2]!, "utf8"));
    for (const p of [prices, provenance]) {
      assert.equal(p.readySha256, report.inputs[0].sha256); assert.equal(realpathSync(p.readyPath), readyPath);
    }
    assert.equal(provenance.implementation.sourceTreeSha256, report.sourceTreeSha256);
    assert.equal(provenance.implementation.revmBinarySha256, report.revmSha256);
    assert.equal(provenance.executionMode, "source-block"); assert.equal(provenance.through, "prices"); assert.equal(provenance.broadcast, false);
    assert(same(provenance.executor, EXECUTOR) && same(provenance.owner, OWNER)); assert.equal(BigInt(provenance.chainId), 1n);
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    assert.equal(source.number, N); assert.equal(source.hash, HASH);
    assert.equal(ready.universeRange.fromBlock, N); assert.equal(ready.universeRange.toBlock, N);
    for (const s of [provenance.topologySource, provenance.stateSource]) { assert.equal(s.number, N); assert.equal(s.hash, HASH); }
    assert.equal(prices.runtime.sourceBlock, N); assert.equal(prices.runtime.sourceBlockHash, HASH);
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === YIELDBASIS_FAMILY_ID && same(m.instanceKey, LT)); assert.equal(memos.length, 1);
    const memo = memos[0]!; assert([familyDefinitionHash(YIELDBASIS_FAMILY_ID), familyMemoDefinitionHash(YIELDBASIS_FAMILY_ID)].includes(memo.familyDefinitionHash));
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [YIELDBASIS_FAMILY_ID], executionIdentity: { executor: EXECUTOR, transactionOrigin: OWNER } });
    const family = asPricedFamily(catalog.forStrictFamily(YIELDBASIS_FAMILY_ID));
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d = instance.descriptor as any; assert.equal(d.depositPathVerified, true); assert.equal(d.redemptionPathVerified, true);
    assert.equal(instance.routes.length, 2); const edges = graph.filter(e => e.instanceKey === instance.instanceKey); assert.equal(edges.length, 2);
    const rows = edges.map(edge => {
      const key = blockScanEdgeKey(edge), row = prices.runtime.pricing.effectiveMids.rows.get(key), raw = prices.runtime.pricing.mids.get(key);
      assert(row?.status === "quoted" && row.amountIn > 0n && row.amountOut > 0n && raw?.mid > 0);
      assertHistoricalPriceDirection(edge, row, instance.instanceKey); assert.equal(row.quotedAt.number, N); assert.equal(row.quotedAt.hash, HASH);
      const route = instance.routes.find(r => same(r.tokenIn, row.tokenIn) && same(r.tokenOut, row.tokenOut))!; assert(route);
      const handle = instance.routeHandles.find(r => r.routeKey === route.routeKey)!; assert(handle);
      return { row, route, handle };
    });
    report.ready = { graphHash: ready.graphHash, memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, candidate: memo.candidateSnapshot };
    report.prices = rows.map(r => r.row); report.originalPriceStageMs = prices.runtime.pricing.effectiveMids.wallMs;
    rpcUrl = process.env.MAINNET_RPC_URL!; assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
    const pin = { blockHash: HASH, requireCanonical: true };
    const rpc = async (method: string, params: unknown[]) => {
      assert(!constructing); assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const id = ++reads; assert(id <= 100); abort.signal.throwIfAborted();
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) });
      assert(response.ok, `HTTP ${response.status}`); const body: any = await response.json();
      assert.equal(body.id, id); assert.equal(body.jsonrpc, "2.0"); assert(!body.error, `read failed: ${method}`); return body.result;
    };
    stage = "source/receipt";
    const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false]); assert.equal(header.hash, HASH);
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n); report.header = header;
    const receipt = await rpc("eth_getTransactionReceipt", [TX]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: TX, blockNumber: N, blockHash: HASH }, source);
    const candidateReceipt = (memo.candidateSnapshot as any).transactionHash === TX ? receipt : await rpc("eth_getTransactionReceipt", [(memo.candidateSnapshot as any).transactionHash]);
    assertHistoricalDiscoveryReceipt(candidateReceipt, memo.candidateSnapshot as any, source);
    const events = receipt.logs.filter((l: any) => same(l.address, LT)).flatMap((l: any) => { try { return [LT_INTERFACE.parseLog(l)]; } catch { return []; } }).filter(Boolean);
    const deposits = events.filter((e: any) => e.name === "Deposit"), withdraws = events.filter((e: any) => e.name === "Withdraw");
    assert.equal(deposits.length, 1); assert.equal(withdraws.length, 1);
    const originals = { deposit: { amountIn: deposits[0].args.assets, amountOut: deposits[0].args.shares },
      withdraw: { amountIn: withdraws[0].args.shares, amountOut: withdraws[0].args.assets } };
    report.original = { ...originals, comparison: "original call-prestate not restored; N-end output may differ" };
    const executorRuntimeCode = loadBotVmRuntimeCode(OWNER); report.executorCodeHash = executorRuntimeCode.keccak256;
    assert.equal(provenance.counterfactualExecutorCode.keccak256, executorRuntimeCode.keccak256);
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 90_000, onFatal }),
      onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor: EXECUTOR, transactionOrigin: OWNER,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, N); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, N); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, N); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
    // The production boundary needs sealed caller authority. All service access
    // is forbidden during construction, including simulation as well as Exact.
    const guardedRuntime = new Proxy(runtime, { get(target, key, receiver) {
      if (constructing && !["callerAuthority", "generationFence"].includes(String(key))) {
        constructionReads++; throw new Error("runtime construction accessed quote/simulation service");
      }
      return Reflect.get(target, key, receiver);
    } });
    const beforeConstruction = reads; constructing = true;
    const legs = rows.map(({ handle }) => {
      const input: any = { family, route: handle, source, runtime: guardedRuntime, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog };
      for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exact", "exactEvidence"])
        Object.defineProperty(input, key, { get() { constructionReads++; throw new Error("runtime construction read a quote/amount"); } });
      const leg = buildFamilyRuntimeAmountLeg(input); assert(leg, "runtime fallback is not accepted"); return leg;
    });
    constructing = false; assert.equal(constructionReads, 0); assert.equal(reads, beforeConstruction);
    report.runtimeConstruction = { directions: legs.length, exactCalls: 0, rpcCalls: 0, quotedFallback: false };
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, EXECUTOR, concatBytes(...node.children.map(compile))); };
    for (const [index, { row, route, handle }] of rows.entries()) {
      const original = same(row.tokenIn, d.asset) ? originals.deposit : originals.withdraw;
      for (const [label, amountIn] of [["production-effective", row.amountIn], ["original-amount-at-N", original.amountIn]] as const) {
        const sample: any = { label, direction: (route as any).direction, tokenIn: row.tokenIn, tokenOut: row.tokenOut, amountIn, status: "failed", executions: [] }; report.samples.push(sample);
        try {
          stage = "production-exact"; const started = performance.now();
          const quote = await executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation, executor: EXECUTOR,
            runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } });
          sample.quoteDiagnosticMs = performance.now() - started; sample.quote = quote;
          assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
          assert.equal(quote.amountIn, amountIn); assert.deepEqual(quote.source, source); assert(quote.amountOut > 0n);
          if (label === "production-effective") assert.equal(quote.amountOut, row.amountOut, "saved effective differs");
          const fragment = buildFamilyExecutionFragment({ family, route: handle, exact: quote, minAmountOut: quote.amountOut, executor: EXECUTOR, runtimeEvidence: [], actionOwnership: catalog });
          assert.equal(fragment.status, "resolved"); if (fragment.status !== "resolved") throw new Error("quoted fragment unresolved");
          const scripts = [["quoted", concatBytes(...planFragmentNodes(fragment.fragment, row.tokenIn, amountIn).map(compile))],
            ["runtime", runtimeProgramScript(ethers.getBytes(legs[index]!.program), amountIn)]] as const;
          for (const [encoding, script] of scripts) {
            stage = encoding; const result: any = { encoding, status: "failed", scriptHash: ethers.keccak256(script) }; sample.executions.push(result);
            const caller = { kind: "executor" as const }, request: AdapterRequest = { id: "execute", kind: "effect-delta-simulation",
              call: { caller, executionMode: "executor-program", to: EXECUTOR, data: buildSubscriptCalldata(script) },
              overrideIntent: { caller, tokenBalances: [{ token: row.tokenIn, amount: amountIn + 101n }, { token: row.tokenOut, amount: quote.amountOut + 103n }, { token: d.stablecoin, amount: 107n }] },
              observeTokenBalances: [row.tokenIn, row.tokenOut, d.stablecoin].map(token => ({ token, account: caller })), observe: DEPOSIT_EFFECTS };
            const begin = performance.now(); const outcome = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: {
              stage: "exact-refine", familyId: YIELDBASIS_FAMILY_ID, source, generation: source.generation, programInput: undefined,
              program: { requirements: () => DEPOSIT_REQUIREMENTS, buildRequests: () => [request], decode: ({ results }) => results } } });
            result.diagnosticMs = performance.now() - begin; result.outcome = outcome;
            assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw new Error("execution issuer unresolved");
            const evidence = outcome.executed.evidence; assert.equal(evidence.length, 1); const returned = evidence[0]!;
            assert(returned.ok && returned.data === "0x", "program reverted or returned unexpected data"); assert.deepEqual(returned.source, source);
            assertObservedLeg(returned.effects, row.tokenIn, row.tokenOut, d.stablecoin, amountIn, quote.amountOut);
            result.effects = returned.effects; result.quoteDelta = 0n; result.oldInventoryConsumed = 0n; result.status = "pass";
          }
          assert.deepEqual(sample.executions[0].effects.tokenDeltas, sample.executions[1].effects.tokenDeltas);
          sample.status = "pass";
        } catch (e) { sample.error = error(e); }
        console.log(json({ direction: sample.direction, label, status: sample.status, quoteMs: sample.quoteDiagnosticMs }));
        abort.signal.throwIfAborted();
      }
    }
    assert.equal(report.samples.length, 4); assert(report.samples.every((s: any) => s.status === "pass"));
    assert.equal((await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false])).hash, HASH);
    assert.equal(sourcePin(), report.sourceTreeSha256); assert.deepEqual(inputPins(), report.inputs); report.result = "pass";
  } catch (e) { report.error = error(e); process.exitCode = 1; }
  finally {
    const start = performance.now(); try { await simulation?.closeAndDrain(); } catch (e) { report.drainError = error(e); report.result = "failed"; process.exitCode = 1; }
    clearTimeout(timer); report.drainDiagnosticMs = performance.now() - start; report.directReads = reads;
    writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd);
    console.log(json({ result: report.result, error: report.error, samples: report.samples.length, executions: report.samples.reduce((n: number, s: any) => n + s.executions.filter((e: any) => e.status === "pass").length, 0) }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("invalid YB dual inputs; existing outputs untouched"); process.exitCode = 1; });
