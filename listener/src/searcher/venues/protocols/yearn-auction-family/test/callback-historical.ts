// Opt-in N-end correctness, using natural Ready, production issuer/encoders and
// local REVM. A borrowed production amount is input only, never admission/output.
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
import { ABI, NEED } from "../codec.js";
import type { Descriptor, Route } from "../types.js";

import { AnvilStateBackend } from "../../../../../shared/state/state-backend.js";
import { loadV4FundingFixture } from "../../../../test/family-integration/kyber-yb-compound/v4-native-settlement.js";
import { ERC20, word, matchesBalanceSlotProbe, isLocalBalanceProbeRevert } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { acceptYearnCallback, correlatedRpcResponse } from "./callback-evidence.js";
const N = 26152335, HASH = "0x62a1a08653dd520793f8526d405430bcaabd5152459fca18e79f843514f3e0b3";
const TX = "0x6cc7a620da9e1fc47e894ec69bdbd3b1075c05ebc6c1807a3a6a000035fe136b";
const TARGET = "0xa00e6b35c23442fa9d5149cba5dd94623ffe6693", SOLD = "0xdbdb4d16eda451d0503b854cf79d55697f90c8df";
const KEY = TARGET + ":" + SOLD, ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const effects = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;
const requirements = { transports: ["effect-delta-simulation"] as const, caller: "executor" as const, effects };

async function main(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(), names = ["--ready", "--prices", "--reference-prices", "--rpc-file", "--revm-bin", "--out", "--port", "--funding-artifact"];
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]!) && !args.has(argv[i]!) && argv[i + 1]); args.set(argv[i]!, argv[i + 1]!);
  }
  assert(names.every(name => args.has(name)));
  const fd = openSync(args.get("--out")!, "wx", 0o600), report: any = { result: "failed", samples: [], readonlyQuotes: [], tx: TX,
    claim: "Real Yearn four-argument callback at N-end using production issuer and runtime encoder; isolated funding fixture is not a market return path, profitability or original-precall replay. Existing default/direct results are not rerun.",
    performance: "NOT RUN", signing: false, broadcast: false, protocolOverrides: false, actorOnlyFunding: true };
  const abort = new AbortController(), deadlineAtMs = Date.now() + 480_000;
  const timer = setTimeout(() => abort.abort(new Error("historical dual deadline")), 480_000);
  let backend: AnvilStateBackend | undefined;
  let simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined, rpcUrl = "", reads = 0, stage = "inputs";
  const guard = constructionGuard();
  const redact = (v: unknown) => String(v).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  let finalPins: (() => Promise<void>) | undefined;
  try {
    const readyPath = realpathSync(args.get("--ready")!), pricesPath = realpathSync(args.get("--prices")!);
    const referencePath = realpathSync(args.get("--reference-prices")!);
    const paths = [readyPath, pricesPath, resolve(dirname(pricesPath), "input.json"), fileURLToPath(import.meta.url), referencePath, fileURLToPath(new URL("./callback-evidence.ts", import.meta.url)), args.get("--funding-artifact")!];
    const pins = () => paths.map(path => ({ path, sha256: sha(readFileSync(path)) }));
    report.inputs = pins(); report.code = sourcePin(); report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!));
    assert.equal(report.revmSha256, "e5cbce3521fd98d7e59d3de80cca4fa0c3ec94c5cdfb1e74bbae4d6d7c7588c6");
    const prices = parseAtBlockJson(readFileSync(pricesPath, "utf8")), provenance = parseAtBlockJson(readFileSync(paths[2]!, "utf8"));
    const envelope = await new UniverseRebuildCheckpointStore({ path: readyPath }).load(); assert(envelope && !envelope.inProgressRun);
    const { ready, graph } = resolveStrictReadyRuntime(envelope.readyGeneration), source = ready.cutoff;
    assert.equal(source.number, N); assert.equal(source.hash, HASH); report.source = source;
    report.priorPriceUse = "old price input supplies actor configuration only; not current natural valuation evidence";
    assert.equal(provenance.implementation.revmBinarySha256, report.revmSha256);
    const executor = ethers.getAddress(provenance.executor), owner = ethers.getAddress(provenance.owner);
    assert(!same(executor, owner)); report.actors = { executor, owner };
    const memos = activeReadyMemos(envelope).filter(m => m.familyId === FAMILY && m.instanceKey === KEY); assert.equal(memos.length, 1);
    const memo = memos[0]!, wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:1", familyIds: [FAMILY], executionIdentity: { executor, transactionOrigin: owner } });
    assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const family = asPricedFamily(catalog.forStrictFamily(FAMILY));
    const instance = wiring.rehydrateVerifiedInstance({ memo, cutoff: source }) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({ family, instance, source, generation: source.generation });
    const d = instance.descriptor as Descriptor; assert.equal(d.target, TARGET); assert.equal(d.sold, SOLD); assert.equal(instance.routes.length, 1);
    report.admission = { memoFingerprint: memo.memoFingerprint, familyDefinitionHash: memo.familyDefinitionHash, candidate: memo.candidateSnapshot };
    const route = instance.routes[0] as Route, handle = instance.routeHandles.find(h => h.routeKey === route.routeKey)!; assert(handle);
    const edges = graph.filter(e => e.instanceKey === KEY && same(e.tokenIn, route.tokenIn) && same(e.tokenOut, route.tokenOut)); assert.equal(edges.length, 1);
    report.readyTargetEdge = edges[0];
    // The user permits splicing an existing live-production amount only. The
    // complete original row, its carried source and run config remain evidence.
    const reference = parseAtBlockJson(readFileSync(referencePath, "utf8"));
    const references = [...reference.runtime.pricing.effectiveMids.rows.entries()]
      .filter(([, r]: any) => r.status === "quoted" && same(r.tokenIn, d.want) && typeof r.amountIn === "bigint" && r.amountIn > 0n)
      .sort(([a]: any, [b]: any) => String(a).localeCompare(String(b)));
    assert(references.length > 0, "large production table has no payment-token input amount");
    const [referenceId, referenceRow] = references[0] as [string, any];
    report.borrowedReference = { path: referencePath, sha256: report.inputs[4].sha256, edgeId: referenceId, row: referenceRow,
      cfg: reference.cfg, publishedAt: { number: reference.runtime.sourceBlock, hash: reference.runtime.sourceBlockHash, generation: reference.runtime.generation },
      scope: "only amountIn borrowed; no target identity/output/valuation is borrowed; not natural target effective acceptance" };
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
    const call = async (name: string, values: unknown[]) => ABI.decodeFunctionResult(name,
      await rpc("eth_call", [{ to: d.target, data: ABI.encodeFunctionData(name, values) }, pin]))[0];
    stage = "source-and-runtime";
    const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false]); assert.equal(header.hash, HASH); report.header = header;
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const receipt = await rpc("eth_getTransactionReceipt", [TX]); assertHistoricalDiscoveryReceipt(receipt, { transactionHash: TX, blockNumber: N, blockHash: HASH }, source);
    const candidate: any = memo.candidateSnapshot;
    assertHistoricalDiscoveryReceipt(same(candidate.transactionHash, TX) ? receipt : await rpc("eth_getTransactionReceipt", [candidate.transactionHash]), candidate, source);
    const receiver: string = await call("receiver", []), available: bigint = await call("available", [d.sold]); assert(available > 0n);
    const transfers = (token: string) => receipt.logs.filter((l: any) => !l.removed && same(l.address, token) && same(l.topics[0], ABI.getEvent("Transfer")!.topicHash))
      .map((l: any) => ABI.parseLog(l)!.args);
    const outputs = transfers(d.sold).filter((a: any) => same(a.from, TARGET)); assert.equal(outputs.length, 1);
    const payments = transfers(d.want).filter((a: any) => same(a.from, outputs[0].to) && same(a.to, receiver)); assert.equal(payments.length, 1);
    const original = { amountIn: payments[0].value as bigint, amountOut: outputs[0].value as bigint, actor: outputs[0].to };
    assert.equal(original.amountIn, 267759246788654353808n); assert.equal(original.amountOut, 106378642455288485048n);
    report.originalObservation = { ...original, receiver, scope: "original receipt only; N end is not original pre-call state", receipt };
    const artifactPath = resolve(ROOT, "out/BotVM.sol/BotVM.json"), artifactBytes = readFileSync(artifactPath), artifact = JSON.parse(artifactBytes.toString());
    const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
    assert.equal(metadata.settings.compilationTarget["src/BotVM.sol"], "BotVM"); assert(Object.keys(metadata.sources).length > 0);
    for (const [name, entry] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) {
      const p = realpathSync(resolve(ROOT, name)); assert(name.endsWith(".sol") && !relative(realpathSync(ROOT), p).startsWith(".."));
      assert.equal(ethers.keccak256(readFileSync(p)), entry.keccak256, "stale executor source");
    }
    const refs = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
    assert.equal(refs.length, 1); assert(refs[0]!.length > 0 && refs[0]!.every(r => r.length === 32));
    const executorRuntimeCode = loadBotVmRuntimeCode(owner); report.executorCodeHash = executorRuntimeCode.keccak256; report.executorArtifactSha256 = sha(artifactBytes);
    report.executorProvisioning = assertExecutorCode(await rpc("eth_getCode", [executor, pin]), executorRuntimeCode.code);
    assertOriginAccountCode(await rpc("eth_getCode", [owner, pin]));
    finalPins = async () => { assert.deepEqual(pins(), report.inputs); assert.deepEqual(sourcePin(), report.code);
      assert.equal(sha(readFileSync(artifactPath)), report.executorArtifactSha256);
      assert.equal((await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false])).hash, HASH); };
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot }, executorRuntimeCode,
      control: { signal: abort.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 60_000, onFatal }),
      onFatal: () => abort.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); abort.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...tx }: any, n: number) => { assert.equal(blockTag ?? n, N); return rpc("eth_call", [tx, pin]); },
        getCode: async (a: string, n: number) => { assert.equal(n, N); return rpc("eth_getCode", [a, pin]); },
        getStorage: async (a: string, slot: string, n: number) => { assert.equal(n, N); return rpc("eth_getStorageAt", [a, slot, pin]); } } as never });
    const adapters = [...family.plugin.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile = (node: ResolvedPlanNode): Uint8Array => { const a = adapters.find(a => a.id === node.adapterId); assert(a); return a.encode(node, executor, concatBytes(...node.children.map(compile))); };
    const build = (settlement?: RuntimeSettlementRequest) => guard.build(() =>
      buildFamilyRuntimeAmountLeg({ family, route: handle, source, executor, runtime: guard.runtime(runtime), runtimeEvidence: [],
        actionOwnership: catalog, ...(settlement ? { settlement } : {}) }));
    const leg = build();
    assert(leg, "no runtime fallback"); assert.equal(leg.inputMode, "maximum");
    const capacityCost: bigint = await call(NEED, [d.sold, available]);
    const port=Number(args.get("--port"));assert(Number.isInteger(port)&&port>1024&&port<65536);
    const endpoint=`http://127.0.0.1:${port}`;
    backend=new AnvilStateBackend(rpcUrl,endpoint,port);await backend.forkAt(N,{signal:abort.signal,deadlineAtMs});
    let localReads=0;
    const localRpc=async(method:string,params:any[]):Promise<any>=>{
      guard.check();abort.signal.throwIfAborted();
      assert(["web3_clientVersion","eth_chainId","eth_getBlockByNumber","eth_call","eth_getCode","eth_createAccessList","debug_traceCall","anvil_setCoinbase"].includes(method));
      if(method==="anvil_setCoinbase")assert.deepEqual(params,[header.miner]);
      const body=await correlatedRpcResponse(()=>++localReads,async id=>{
        assert(id<=1200);
        const res=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])});
        assert(res.ok);return res.json();
      });
      if(body.error)throw Object.assign(new Error(method+": "+redact(body.error.message)),{localCall:method==="eth_call",rpcCode:body.error.code,returnData:body.error.data});return body.result;
    };
    assert(/anvil/i.test(await localRpc("web3_clientVersion",[])));assert.equal(BigInt(await localRpc("eth_chainId",[])),1n);
    const localCall=(to:string,data:string,overrides:any={})=>localRpc("eth_call",[{from:owner,to,data},pin,overrides]);
    const balance=async(token:string,holder:string,overrides:any={})=>BigInt(await localCall(token,ERC20.encodeFunctionData("balanceOf",[holder]),overrides));
    const environment=async()=>[...ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"),await localCall(executor,"0x",{[executor]:{code:"0x43600052426020524860405241606052456080524460a0524660c05260e06000f3"}}))]as bigint[];
    const expected=[BigInt(header.number),BigInt(header.timestamp),BigInt(header.baseFeePerGas),BigInt(header.miner),BigInt(header.gasLimit),BigInt(header.mixHash),1n];
    const beforeEnvironment=await environment();assert.deepEqual(beforeEnvironment.filter((_,i)=>i!==3),expected.filter((_,i)=>i!==3));
    if(beforeEnvironment[3]!==expected[3])await localRpc("anvil_setCoinbase",[header.miner]);assert.deepEqual(await environment(),expected);report.environment=expected;
    const slots=new Map<string,string>();
    const slotFor=async(token:string,protectedAccount:string,holder=executor)=>{
      const cached=slots.get(token+":"+holder);if(cached)return cached;
      assert(!same(holder,protectedAccount));
      const original=await balance(token,holder),protectedBalance=await balance(token,protectedAccount),supply=await localCall(token,ERC20.encodeFunctionData("totalSupply"));
      const access=await localRpc("eth_createAccessList",[{from:owner,to:token,data:ERC20.encodeFunctionData("balanceOf",[holder]),gas:"0x100000"},ethers.toQuantity(N)]);
      assert(!access.error&&Array.isArray(access.accessList));
      const candidates:string[]=[...new Set<string>(access.accessList.filter((a:any)=>same(a.address,token)).flatMap((a:any)=>a.storageKeys.map(word)))];assert(candidates.length>0&&candidates.length<=16);const matches:string[]=[];
      for(const key of candidates){let valid=true;for(const probe of[717171717171n,919191919193n]){
        const o={[token]:{stateDiff:{[key]:word(probe)}}};let returned:string;
        try{returned=await localCall(token,ERC20.encodeFunctionData("balanceOf",[holder]),o);}catch(error){if(!isLocalBalanceProbeRevert(error))throw error;valid=false;break;}
        if(!matchesBalanceSlotProbe(returned,probe)||await balance(token,protectedAccount,o)!==protectedBalance||await localCall(token,ERC20.encodeFunctionData("totalSupply"),o)!==supply){valid=false;break;}}
        if(valid)matches.push(key);}
      assert.equal(matches.length,1,"unique actor-only balance slot");slots.set(token+":"+holder,matches[0]!);
      (report.balanceSlotProofs??=[]).push({token,holder,original,protectedAccount,protectedBalance,supply,slot:matches[0],probes:[717171717171n,919191919193n]});return matches[0]!;
    };
    const fixture=loadV4FundingFixture(ROOT,args.get("--funding-artifact")!);report.fundingFixture={...fixture,code:undefined,scope:"isolated actual Yearn callback funding; no protocol code replacement, no market route"};
    const priorFinal=finalPins;finalPins=async()=>{await priorFinal?.();assert.deepEqual(await environment(),expected);assert.equal((await localRpc("eth_getBlockByNumber",["latest",false])).hash,HASH);report.localReads=localReads;};
    const inputs: [string, bigint][] = [["borrowed-production-input-at-N", referenceRow.amountIn], ["original-budget-at-N", original.amountIn],
      ["original-budget-plus-two-wei", original.amountIn + 2n], ["capacity-capped-budget", capacityCost + 17n]];
    for (const [label, amountIn] of inputs) {
      const trial: any = { label, amountIn, tokenIn: route.tokenIn, tokenOut: route.tokenOut, status: "failed", executions: [] }; report.samples.push(trial);
      stage = "production-exact";
      const quote = await guard.exact(() => executeFamilyExactQuote({ family, route: handle, amountIn, source, generation: source.generation, executor,
        runtimeEvidence: [], runtime, control: { signal: abort.signal, deadlineAtMs } }));
      trial.quote = quote; assert.equal(quote.status, "resolved"); if (quote.status !== "resolved") throw new Error("Exact unresolved");
      const spent: bigint = await call(NEED, [d.sold, quote.amountOut]); assert(spent > 0n && spent <= amountIn);
      trial.chainCost = spent; trial.residual = amountIn - spent; trial.available = available;
      if (label === "original-budget-plus-two-wei") { assert.equal(trial.residual, 2n); assert.equal(quote.amountOut, original.amountOut); }
      if (label === "capacity-capped-budget") { assert.equal(quote.amountOut, available); assert.equal(trial.residual, 17n); }
      else assert(await call(NEED, [d.sold, quote.amountOut + 1n]) > amountIn, "not maximal payable output");
      stage = "actual-four-argument-callback";
      await acceptYearnCallback({descriptor:d,executor,owner,receiver,runtimeCode:executorRuntimeCode,fixture,amountIn,amountOut:quote.amountOut,spent,
        header,source,pin,trial,rpc:localRpc,balance,slotFor,build:request=>build(request)});
      trial.status = "pass"; console.log(json({ label, status: trial.status, amountOut: quote.amountOut, spent, residual: trial.residual }));
    }
    report.runtimeConstruction = { exactCalls: 0, quotedCalls: 0, rpcCalls: 0, quotedFallback: false,
      scope: "production issuer; maximum mask/selector and generic flow inventory safety have separate offline/EVM contracts; this historical run executes four-argument Yearn callbacks with an isolated funding fixture" };
    report.invocationCounts = guard.counts; report.result = "pass-actual-callback-with-funding-fixture";
  } catch (e) { report.error = { stage, message: redact(e instanceof Error ? e.message : e) }; process.exitCode = 1; }
  finally {
    try { await finalPins?.(); await simulation?.closeAndDrain(); report.drained = true; }
    catch (e) { report.finalError = redact(e instanceof Error ? e.message : e); report.result = "failed"; process.exitCode = 1; await simulation?.closeAndDrain().catch(() => {}); }
    try { await backend?.stopAndWait(); report.forkDrained=true; } catch(e) { report.forkError=redact(e);report.result="failed";process.exitCode=1; }
    clearTimeout(timer); report.directReads = reads; writeFileSync(fd, redact(json(report)) + "\n"); closeSync(fd);
    console.log(json({ result: report.result, error: report.error, out: args.get("--out"), samples: report.samples.length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error("invalid Yearn callback arguments/output; no success claimed"); process.exitCode = 1; });
