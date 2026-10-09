// Opt-in N/N DODO evidence. Production quote/builders/issuer/REVM only;
// per-call times are diagnostic, not the production-stage benchmark.
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
import { DODO_V2_FAMILY_ID } from "../manifest.js";
import { DODO_V2_EVENT_INTERFACE } from "../../dodo-v2-abi.js";
import { referenceAmount } from "./reference-amount.js";

const N = 26016874, HASH = "0xf2a4a8104b5ed1113df782166fbceeac9b8debdfef3a20a2b3993218215e5f0d";
const TX = "0x00085da9420425f8f3de1243d41d71ff160984310edf5474341fbe628375bc3e";
const POOLS = ["0x04571c32a4e1c5f39bc3a238cb95b215058c432c", "0xb9a4406982d990648093c71eff9f1f63a040152e"];
const EXECUTOR = "0x1000000000000000000000000000000000000002", OWNER = "0x1000000000000000000000000000000000000001";
const EFFECTS = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x, 2);
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function assertExecutorCodeProvenance(value: unknown, expectedCodeHash: string): void {
  // Production price artifacts may omit this optional counterfactual field.
  // A present field must bind both the executor address and its runtime code.
  if (value == null) return;
  assert(typeof value === "object", "invalid executor code provenance");
  const p = value as Record<string, unknown>;
  assert(typeof p.address === "string" && ethers.isAddress(p.address) && same(p.address, EXECUTOR), "executor provenance address mismatch");
  assert(typeof p.keccak256 === "string" && ethers.isHexString(p.keccak256, 32), "invalid executor provenance code hash");
  assert.equal(p.keccak256.toLowerCase(), expectedCodeHash.toLowerCase(), "executor provenance code mismatch");
}

export function assertObservedLeg(effects: ObservedEffects | undefined, input: string, output: string,
  amountIn: bigint, amountOut: bigint): void {
  assert(effects?.tokenDeltas && effects.tokenDeltas.length === 2, "missing/extra balance observations");
  for (const [token, delta] of [[input, -amountIn], [output, amountOut]] as const) {
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
  const args = new Map<string, string>();
  const required = ["--ready", "--prices", "--rpc-env", "--revm-bin", "--out"];
  const allowed = [...required, "--amounts-prices", "--amount-edge-keys"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    assert(allowed.includes(key) && !args.has(key) && value); args.set(key, value);
  }
  for (const key of required) assert(args.has(key));
  assert.equal(args.get("--rpc-env"), "MAINNET_RPC_URL");
  assert.equal(args.has("--amounts-prices"), args.has("--amount-edge-keys"));
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [],
    tx: TX, block: N, hash: HASH, broadcast: false,
    claim: "same-N production quote/quoted/runtime receipts; spliced amounts do not prove natural valuation; no original-precall, profitability or representative latency verdict" };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 600_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 600_000);
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, rpcUrl = "", reads = 0;
  let constructing = false, constructionReads = 0, stage = "inputs";
  const redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const error = (e: unknown) => ({ stage, message: redact(e instanceof Error ? e.message : e) });
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricesPath = realpathSync(args.get("--prices")!);
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json")];
    let donor: any, donorKeys: readonly string[] | undefined;
    if (args.has("--amounts-prices")) {
      const donorPath = realpathSync(args.get("--amounts-prices")!);
      const donorInputPath = realpathSync(resolve(dirname(donorPath), "input.json"));
      paths.push(donorPath, donorInputPath);
      donor = parseAtBlockJson(readFileSync(donorPath, "utf8"));
      const origin = parseAtBlockJson(readFileSync(donorInputPath, "utf8"));
      assert.equal(BigInt(origin.chainId), 1n); assert.equal(donor.readySha256, origin.readySha256);
      assert.equal(donor.runtime.sourceBlock, origin.stateSource.number);
      assert.equal(donor.runtime.sourceBlockHash, origin.stateSource.hash);
      donorKeys = JSON.parse(args.get("--amount-edge-keys")!); assert(Array.isArray(donorKeys));
      report.amountDonor = { path: donorPath, source: origin.stateSource, parameters: origin.parameters,
        selectedKeys: donorKeys, meaning: "input amounts only, not target valuation or quote outputs" };
    }
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
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === DODO_V2_FAMILY_ID && POOLS.includes(m.instanceKey.toLowerCase()));
    assert.equal(memos.length, 2); assert.equal(new Set(memos.map(m => m.instanceKey.toLowerCase())).size, 2);
    const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [DODO_V2_FAMILY_ID], executionIdentity: { executor: EXECUTOR, transactionOrigin: OWNER } });
    const family = asPricedFamily(catalog.forStrictFamily(DODO_V2_FAMILY_ID));
    const rows = memos.flatMap(memo => {
      assert([familyDefinitionHash(DODO_V2_FAMILY_ID), familyMemoDefinitionHash(DODO_V2_FAMILY_ID)].includes(memo.familyDefinitionHash));
      const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
      assert.equal(instance.routes.length, 2); const edges = graph.filter(e => e.instanceKey === instance.instanceKey); assert.equal(edges.length, 2);
      return edges.map(edge => {
        const key = blockScanEdgeKey(edge), row = prices.runtime.pricing.effectiveMids.rows.get(key), raw = prices.runtime.pricing.mids.get(key);
        assert(row && raw?.mid > 0); assertHistoricalPriceDirection(edge, row, instance.instanceKey);
        const ref = donorKeys ? referenceAmount(donor, donorKeys, row.tokenIn) : { amountIn: row.amountIn, kind: "production-effective" };
        if (!donorKeys) {
          assert(row.status === "quoted" && row.amountIn > 0n && row.amountOut > 0n);
          assert.equal(row.quotedAt.number, N); assert.equal(row.quotedAt.hash, HASH);
        }
        const route = instance.routes.find(r => same(r.tokenIn, row.tokenIn) && same(r.tokenOut, row.tokenOut))!; assert(route);
        const handle = instance.routeHandles.find(r => r.routeKey === route.routeKey)!; assert(handle);
        return { row, route, handle, ref, pool: instance.instanceKey };
      });
    });
    assert.equal(rows.length, 4);
    report.ready = { graphHash: ready.graphHash, memos: memos.map(m => ({ fingerprint: m.memoFingerprint, familyDefinitionHash: m.familyDefinitionHash, candidate: m.candidateSnapshot })) };
    report.prices = rows.map(r => ({ targetRow: r.row, reference: r.ref }));
    rpcUrl = process.env.MAINNET_RPC_URL!; assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
    const pin = { blockHash: HASH, requireCanonical: true };
    const rpc = async (method: string, params: unknown[]) => {
      assert(!constructing); assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const id = ++reads; assert(id <= 256); abort.signal.throwIfAborted();
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) });
      assert(response.ok, `HTTP ${response.status}`); const body: any = await response.json();
      assert.equal(body.id, id); assert.equal(body.jsonrpc, "2.0"); assert(!body.error, `read failed: ${method}`); return body.result;
    };
    stage = "source/receipt";
    const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false]); assert.equal(header.hash, HASH);
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n); report.header = header;
    const receipt = await rpc("eth_getTransactionReceipt", [TX]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: TX, blockNumber: N, blockHash: HASH }, source);
    for (const memo of memos) {
      const candidate = memo.candidateSnapshot as any;
      const candidateReceipt = candidate.transactionHash === TX ? receipt : await rpc("eth_getTransactionReceipt", [candidate.transactionHash]);
      assertHistoricalDiscoveryReceipt(candidateReceipt, candidate, source);
    }
    const originals = receipt.logs.filter((l: any) => POOLS.includes(l.address.toLowerCase())).flatMap((l: any) => {
      try { const e = DODO_V2_EVENT_INTERFACE.parseLog(l); return e?.name === "DODOSwap" ? [{ pool: l.address, tokenIn: e.args.fromToken,
        tokenOut: e.args.toToken, amountIn: e.args.fromAmount, amountOut: e.args.toAmount, logIndex: l.logIndex }] : []; } catch { return []; }
    });
    assert(POOLS.every(pool => originals.some((o: any) => same(pool, o.pool))));
    report.original = { swaps: originals, comparison: "original call-prestate not restored; N-end output may differ" };
    const executorRuntimeCode = loadBotVmRuntimeCode(OWNER); report.executorCodeHash = executorRuntimeCode.keccak256;
    // Pure eth_call prices need no executor override. A non-null binding may
    // never be waived; the newly executed programs always bind trusted code.
    assertExecutorCodeProvenance(provenance.counterfactualExecutorCode, executorRuntimeCode.keccak256);
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 90_000, onFatal }),
      onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor: EXECUTOR, transactionOrigin: OWNER,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, N); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, N); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, N); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
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
    for (const [index, { row, route, handle, ref, pool }] of rows.entries()) {
      const original = originals.filter((o: any) => same(o.pool, pool) && same(o.tokenIn, row.tokenIn) && same(o.tokenOut, row.tokenOut));
      assert(original.length <= 1, "select original call explicitly if repeated");
      const amounts = [[ref.kind, ref.amountIn], original.length === 1 ? ["original-amount-at-N", original[0].amountIn] : ["additional-10x-reference", ref.amountIn * 10n]] as const;
      for (const [label, amountIn] of amounts) {
        const sample: any = { label, pool, direction: (route as any).direction, tokenIn: row.tokenIn, tokenOut: row.tokenOut, amountIn, status: "failed", executions: [] }; report.samples.push(sample);
        try {
          assert(typeof amountIn === "bigint" && amountIn > 0n && amountIn < ethers.MaxUint256 - 101n);
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
              overrideIntent: { caller, tokenBalances: [{ token: row.tokenIn, amount: amountIn + 101n }, { token: row.tokenOut, amount: quote.amountOut + 103n }] },
              observeTokenBalances: [row.tokenIn, row.tokenOut].map(token => ({ token, account: caller })), observe: EFFECTS };
            const begin = performance.now(); const outcome = await executeAdapterWork({ runtime, control: { signal: abort.signal, deadlineAtMs }, intent: {
              stage: "exact-refine", familyId: DODO_V2_FAMILY_ID, source, generation: source.generation, programInput: undefined,
              program: { requirements: () => ({ transports: ["effect-delta-simulation"], caller: "executor", effects: EFFECTS }), buildRequests: () => [request], decode: ({ results }) => results } } });
            result.diagnosticMs = performance.now() - begin; result.outcome = outcome;
            assert.equal(outcome.status, "resolved"); if (outcome.status !== "resolved") throw new Error("execution issuer unresolved");
            const evidence = outcome.executed.evidence; assert.equal(evidence.length, 1); const returned = evidence[0]!;
            assert(returned.ok && returned.data === "0x", "program reverted or returned unexpected data"); assert.deepEqual(returned.source, source);
            assertObservedLeg(returned.effects, row.tokenIn, row.tokenOut, amountIn, quote.amountOut);
            result.effects = returned.effects; result.quoteDelta = 0n; result.oldInventoryConsumed = 0n; result.status = "pass";
          }
          assert.deepEqual(sample.executions[0].effects.tokenDeltas, sample.executions[1].effects.tokenDeltas);
          sample.status = "pass";
        } catch (e) { sample.error = error(e); }
        console.log(json({ pool, direction: sample.direction, label, status: sample.status, error: sample.error }));
        abort.signal.throwIfAborted();
      }
    }
    assert.equal(report.samples.length, 8); assert(report.samples.every((s: any) => s.status === "pass"));
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
  main().catch(() => { console.error("invalid DODO dual inputs; existing outputs untouched"); process.exitCode = 1; });
