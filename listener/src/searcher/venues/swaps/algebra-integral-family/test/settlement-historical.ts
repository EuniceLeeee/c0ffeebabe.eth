// Same-N Algebra Integral settlement correctness. Old price rows supply amounts only.
// Actual protocol state/code remain untouched; an isolated fixture funds callbacks.
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
import { ALGEBRA_INTEGRAL_FAMILY_ID as FAMILY } from "../manifest.js";
import { SAMPLES } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import type { AlgebraIntegralDescriptor as Descriptor, AlgebraIntegralRoute as Route } from "../types.js";

import { AnvilStateBackend } from "../../../../../shared/state/state-backend.js";
import { loadV4FundingFixture } from "../../../../test/family-integration/kyber-yb-compound/v4-native-settlement.js";
import { ERC20, word, matchesBalanceSlotProbe, isLocalBalanceProbeRevert } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { acceptAlgebraSettlement } from "./settlement-evidence.js";
const ROOT = fileURLToPath(new URL("../../../../../../../", import.meta.url));

async function main(argv=process.argv.slice(2)) {
  const args=new Map<string,string>(), names=["--ready","--reference","--provenance","--rpc-file","--revm-bin","--revm-sha256","--out","--port","--funding-artifact","--sample"];
  for(let i=0;i<argv.length;i+=2){assert(names.includes(argv[i]!)&&!args.has(argv[i]!)&&argv[i+1]);args.set(argv[i]!,argv[i+1]!);}
  assert(names.every(n=>args.has(n)));
  const sample=(SAMPLES as any)[args.get("--sample")!];assert(sample&&args.get("--sample")!.startsWith("algebra"));
  const N=sample.number,TX=sample.tx;let HASH="";
  const fd=openSync(args.get("--out")!,"wx",0o600),report:any={result:"failed",samples:[],tx:TX,signing:false,broadcast:false,performance:"NOT RUN",
    claim:"Actual direct self/external execution and output-first Algebra Integral callback at N end; fixture fixed1 raw output is not a market return path, profit or opportunity replay. Existing defaults retained separately."};
  const abort=new AbortController(),deadlineAtMs=Date.now()+600000,timer=setTimeout(()=>abort.abort(new Error("Algebra Integral settlement deadline")),600000);
  let backend:AnvilStateBackend|undefined,simulation:ReturnType<typeof createRevmStrictSourceSimulation>|undefined,rpcUrl="",reads=0,stage="inputs";
  const guard=constructionGuard(),redact=(v:unknown)=>String(v).split(rpcUrl||"\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]");
  let finalPins:(()=>Promise<void>)|undefined;
  try{
    const readyPath=realpathSync(args.get("--ready")!),referencePath=realpathSync(args.get("--reference")!);
    const paths=[readyPath,referencePath,realpathSync(args.get("--provenance")!),fileURLToPath(import.meta.url),fileURLToPath(new URL("./settlement-evidence.ts",import.meta.url)),args.get("--funding-artifact")!,args.get("--revm-bin")!];
    const pins=()=>paths.map(path=>({path,sha256:sha(readFileSync(path))}));report.inputs=pins();report.code=sourcePin();report.revmSha256=sha(readFileSync(args.get("--revm-bin")!));
    const reference=parseAtBlockJson(readFileSync(referencePath,"utf8")),provenance=parseAtBlockJson(readFileSync(paths[2]!,"utf8"));
    assert(String(reference.result).startsWith("pass"));assert.equal(reference.source.number,N);HASH=reference.source.hash;
    assert.equal(report.revmSha256,args.get("--revm-sha256"));report.priorDonorRevmSha256=provenance.implementation.revmBinarySha256;
    const envelope=await new UniverseRebuildCheckpointStore({path:readyPath}).load();assert(envelope&&!envelope.inProgressRun);
    const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source=ready.cutoff;assert.equal(source.number,N);assert.equal(source.hash,HASH);report.source=source;
    const executor=ethers.getAddress(provenance.executor),owner=ethers.getAddress(provenance.owner);assert(!same(executor,owner));report.actors={executor,owner};
    const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:1",familyIds:[FAMILY],executionIdentity:{executor,transactionOrigin:owner}}),family=asPricedFamily(catalog.forStrictFamily(FAMILY));
    const memos=activeReadyMemos(envelope).filter(m=>m.familyId===FAMILY&&m.instanceKey.toLowerCase().includes(sample.instances[0].toLowerCase()));assert.equal(memos.length,1);const memo=memos[0]!;assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
    const d=instance.descriptor as Descriptor;assert(same(d.pool,sample.instances[0]));assert.equal(instance.routes.length,2);
    report.admission={memoFingerprint:memo.memoFingerprint,familyDefinitionHash:memo.familyDefinitionHash,candidate:memo.candidateSnapshot,descriptor:d};
    report.amountDonor={path:referencePath,sha256:report.inputs[1].sha256,priorSource:reference.source,priorInputPins:reference.inputHashes,priorReference:reference.referenceInputSource,
      scope:"prior successful trial inputs only; no target output, identity, admission or natural valuation borrowed"};
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
    const port=Number(args.get("--port"));assert(Number.isInteger(port)&&port>1024&&port<65536);
    const endpoint=`http://127.0.0.1:${port}`;
    backend=new AnvilStateBackend(rpcUrl,endpoint,port);await backend.forkAt(N,{signal:abort.signal,deadlineAtMs});
    let localReads=0;
    const localRpc=async(method:string,params:any[]):Promise<any>=>{
      guard.check();abort.signal.throwIfAborted();
      assert(["web3_clientVersion","eth_chainId","eth_getBlockByNumber","eth_call","eth_getCode","eth_createAccessList","debug_traceCall","anvil_setCoinbase"].includes(method));
      if(method==="anvil_setCoinbase")assert.deepEqual(params,[header.miner]);
      const id=++localReads;const body=await (async()=>{
        assert(id<=5000);
        const res=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])});
        assert(res.ok);return res.json();
      })();assert.equal(body.jsonrpc,"2.0");assert.equal(body.id,id);
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
    const fixture=loadV4FundingFixture(ROOT,args.get("--funding-artifact")!);report.fundingFixture={...fixture,code:undefined,scope:"isolated actual Algebra Integral callback funding; no protocol code replacement, no market route"};
    const priorFinal=finalPins;finalPins=async()=>{await priorFinal?.();assert.deepEqual(await environment(),expected);assert.equal((await localRpc("eth_getBlockByNumber",["latest",false])).hash,HASH);report.localReads=localReads;};
    for(const [index,route] of (instance.routes as readonly Route[]).entries()){
      const handle=instance.routeHandles.find(h=>h.routeKey===route.routeKey)!;assert(handle);
      const edges=graph.filter(e=>e.instanceKey===d.instanceKey&&same(e.tokenIn,route.tokenIn)&&same(e.tokenOut,route.tokenOut));assert.equal(edges.length,1);
      const oldRows=reference.samples.filter((s:any)=>same(s.tokenIn,route.tokenIn)&&same(s.tokenOut,route.tokenOut));assert.equal(oldRows.length,1);
      const inputs:[string,bigint][] = oldRows[0].trials.map((t:any)=>[t.label,BigInt(t.amountIn)]);
      assert(inputs.length>=2&&inputs.every(([,a])=>typeof a==="bigint"&&a>0n));
      const donor={inputOnly:true,referencePath,source:reference.source,productionReferenceGate:oldRows[0].productionReferenceGate,splicedReferenceInput:oldRows[0].splicedReferenceInput};
      const build=(settlement:RuntimeSettlementRequest)=>guard.build(()=>buildFamilyRuntimeAmountLeg({family,route:handle,source,executor,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog,settlement}));
      for(const [label,amountIn] of inputs){
        const trial:any={direction:index,label,amountIn,tokenIn:route.tokenIn,tokenOut:route.tokenOut,donor,status:"failed",executions:[]};report.samples.push(trial);stage="same-state-production-exact";
        const quote=await guard.exact(()=>executeFamilyExactQuote({family,route:handle,amountIn,source,generation:source.generation,executor,runtimeEvidence:[],runtime,control:{signal:abort.signal,deadlineAtMs}}));
        trial.quote=quote;assert.equal(quote.status,"resolved");if(quote.status!=="resolved")throw Error("unresolved quote");assert.equal(quote.amountIn,amountIn);assert(quote.amountOut>1n);
        stage="actual-settlement";await acceptAlgebraSettlement({descriptor:d,route,executor,owner,runtimeCode:executorRuntimeCode,fixture,amountIn,amountOut:quote.amountOut,header,source,pin,trial,rpc:localRpc,balance,slotFor,build});
        trial.status="pass";console.log(json({direction:index,label,amountIn,amountOut:quote.amountOut,status:"pass"}));
      }
    }
    assert.equal(guard.counts.forbiddenDuringBuild,0);report.runtimeConstruction={exactCalls:0,quotedCalls:0,rpcCalls:0,quotedFallback:false,scope:"production issuer throwing guards; direct and deferred actual execution"};
    report.invocationCounts=guard.counts;report.result="pass-actual-settlement-with-funding-fixture";
  }catch(e){report.error={stage,message:redact(e instanceof Error?e.stack:e)};process.exitCode=1;}
  finally{
    try{await finalPins?.();await simulation?.closeAndDrain();report.drained=true;}catch(e){report.finalError=redact(e);report.result="failed";process.exitCode=1;await simulation?.closeAndDrain().catch(()=>{});}
    try{await backend?.stopAndWait();report.forkDrained=true;}catch(e){report.forkError=redact(e);report.result="failed";process.exitCode=1;}
    clearTimeout(timer);report.directReads=reads;writeFileSync(fd,redact(json(report))+"\n");closeSync(fd);console.log(json({result:report.result,error:report.error,samples:report.samples.length,out:args.get("--out")}));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("invalid Algebra Integral settlement arguments/output; no success claimed");process.exitCode=1;});
