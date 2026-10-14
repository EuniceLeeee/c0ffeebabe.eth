// N-end Family acceptance only. Uses current production issuers and local REVM;
// stored transaction amounts never replace identity, output or natural pricing.
import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, runtimeAmountFlowAdapter } from "../../../../../adapters/runtime-amount-program.js";
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
import { ID as FAMILY } from "../manifest.js";
import { ABI } from "../codec.js";
import { decodeSwapLog } from "../discovery.js";
import type { Descriptor, Route } from "../types.js";
const N=26182689,HASH="0xeb0d092ce871b19f4071115a4816a282864c7adf6e6d9c1971e30c61596aa09c";
const TX="0xc191d9dfd0897d17351e8e699b22aba475a04fccb74508a4b06a7b630b733058";
const VAULT="0x2d0aff409bde00451334011d55c141aff2103744";
const ROOT=fileURLToPath(new URL("../../../../../../../",import.meta.url));
const ERC20=new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const effects=["return-data","revert-data","token-delta","total-supply-delta","native-delta","logs"] as const;
const requirements={transports:["effect-delta-simulation"] as const,caller:"executor" as const,effects};
export function originalAmount(receipt:any,trace:any){
  assert(receipt&&receipt.transactionHash===TX&&receipt.blockHash===HASH&&BigInt(receipt.blockNumber)===BigInt(N)&&BigInt(receipt.status)===1n);
  assert(trace&&!trace.error&&!trace.revertReason);const frames:any[]=[];
  const walk=(f:any)=>{if(!f||f.error||f.revertReason)return;
    if(f.type==="CALL"&&same(f.to??"",VAULT)){try{const p=ABI.parseTransaction({data:f.input});if(p?.name==="swap")frames.push({f,p});}catch{}}
    for(const child of f.calls??[])walk(child);
  };walk(trace);assert.equal(frames.length,1);
  const {f,p}=frames[0],tokenIn=p.args[0].toLowerCase(),tokenOut=p.args[1].toLowerCase(),receiver=p.args[2].toLowerCase();
  const logs=receipt.logs.filter((l:any)=>!l.removed&&same(l.address,VAULT)&&decodeSwapLog(l));assert.equal(logs.length,1);
  const event=decodeSwapLog(logs[0])!;assert.equal(event.tokenIn,tokenIn);assert.equal(event.tokenOut,tokenOut);assert.equal(event.account,receiver);
  assert.equal(ABI.decodeFunctionResult("swap",f.output)[0],event.amountOut);
  const transfers=(token:string)=>receipt.logs.filter((l:any)=>!l.removed&&same(l.address,token)&&same(l.topics[0],ERC20.getEvent("Transfer")!.topicHash)).map((l:any)=>ERC20.parseLog(l)!.args);
  const inputs=transfers(tokenIn).filter((e:any)=>same(e.to,VAULT)&&e.value===event.amountIn),outputs=transfers(tokenOut).filter((e:any)=>same(e.from,VAULT)&&same(e.to,receiver)&&e.value===event.amountOut);
  assert.equal(inputs.length,1);assert.equal(outputs.length,1);
  return {...event,sender:f.from,receiver,inputSender:inputs[0].from,logIndex:logs[0].logIndex,originalPrecallReplay:false};
}
function observed(e:ObservedEffects|undefined,d:Descriptor,route:Route,actor:string,value:bigint,expected:bigint){
  assert.equal(e?.tokenDeltas?.length,4);assert.equal(e?.nativeDeltas?.length,1);assert.equal(e?.totalSupplyDeltas?.length,2);
  for(const [token,account,delta] of [[route.tokenIn,actor,-value],[route.tokenIn,d.vault,value],[route.tokenOut,actor,expected],[route.tokenOut,d.vault,-expected]] as const){
    const rows:NonNullable<ObservedEffects["tokenDeltas"]>=e!.tokenDeltas!.filter(r=>same(r.token,token)&&same(r.account,account));assert.equal(rows.length,1);assert.equal(rows[0].delta,delta);
  }
  assert(same(e!.nativeDeltas![0].account,actor));assert.equal(e!.nativeDeltas![0].delta,0n);
  for(const token of d.tokens){const rows:NonNullable<ObservedEffects["totalSupplyDeltas"]>=e!.totalSupplyDeltas!.filter(r=>same(r.token,token));assert.equal(rows.length,1);assert.equal(rows[0].delta,0n);}
  const logs=e!.logs!.filter(l=>same(l.address,d.vault)).map(decodeSwapLog).filter(x=>x!==null);assert.equal(logs.length,1);
  assert.equal(logs[0].tokenIn,route.tokenIn);assert.equal(logs[0].tokenOut,route.tokenOut);assert.equal(logs[0].account,actor.toLowerCase());assert.equal(logs[0].amountIn,value);assert.equal(logs[0].amountOut,expected);
}
async function main(){
  const names=["--ready","--prices","--evidence-dir","--rpc-file","--revm-bin","--out"],args=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2){assert(names.includes(process.argv[i]!)&&!args.has(process.argv[i]!)&&process.argv[i+1]);args.set(process.argv[i]!,process.argv[i+1]!);}
  assert(names.every(n=>args.has(n)));
  const fd=openSync(args.get("--out")!,"wx",0o600),report:any={result:"failed",samples:[],roundTrips:[],tx:TX,source:{number:N,hash:HASH},signing:false,broadcast:false,
    scope:"One reverse-registered Vault market, both directions, same N-end quote and execution; full original and production inputs remain unchanged, capacity/zero-output rejection retained. No original-precall/full opportunity or performance verdict."};
  const abort=new AbortController(),deadlineAtMs=Date.now()+600000,timer=setTimeout(()=>abort.abort(new Error("Vault acceptance deadline")),600000);
  const guard=constructionGuard();let reads=0,rpcUrl="",stage="inputs",simulation:ReturnType<typeof createRevmStrictSourceSimulation>|undefined;
  let finalPins:(()=>Promise<void>)|undefined;
  const redact=(s:unknown)=>String(s).split(rpcUrl||"\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]");
  try{
    const readyPath=realpathSync(args.get("--ready")!),pricePath=realpathSync(args.get("--prices")!), evidenceDir=realpathSync(args.get("--evidence-dir")!);
    const paths=[readyPath,pricePath,resolve(dirname(pricePath),"input.json"),resolve(evidenceDir,"receipt.json"),resolve(evidenceDir,"trace.json"),fileURLToPath(import.meta.url)];
    const pins=()=>paths.map(path=>({path,sha256:sha(readFileSync(path))}));report.inputs=pins();report.code=sourcePin();report.revmSha256=sha(readFileSync(args.get("--revm-bin")!));
    const prices=parseAtBlockJson(readFileSync(pricePath,"utf8")),provenance=parseAtBlockJson(readFileSync(paths[2]!,"utf8"));
    const envelope=await new UniverseRebuildCheckpointStore({path:readyPath}).load();assert(envelope&&!envelope.inProgressRun);
    const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source=ready.cutoff;assert.equal(source.number,N);assert.equal(source.hash,HASH);
    assertPriceInput(prices,provenance,ready,{readySha256:report.inputs[0].sha256,sourceTreeSha256:report.code.sourceTreeSha256,number:N});
    assert.equal(provenance.implementation.revmBinarySha256,report.revmSha256);
    const executor=ethers.getAddress(provenance.executor),owner=ethers.getAddress(provenance.owner);assert(!same(executor,owner));report.actors={executor,owner};
    const receipt=JSON.parse(readFileSync(paths[3]!,"utf8")),trace=JSON.parse(readFileSync(paths[4]!,"utf8"));assertHistoricalDiscoveryReceipt(receipt,{transactionHash:TX,blockNumber:N,blockHash:HASH},source);
    rpcUrl=JSON.parse(readFileSync(args.get("--rpc-file")!,"utf8")).MAINNET_RPC_URL;assert(/^https?:\/\//.test(rpcUrl));
    const pin={blockHash:HASH,requireCanonical:true};
    const rpc=async(method:string,params:unknown[]):Promise<any>=>{
      guard.check();abort.signal.throwIfAborted();const id=++reads;assert(id<=600);
      assert(["eth_chainId","eth_getBlockByNumber","eth_getCode","eth_call","eth_getStorageAt","eth_getTransactionReceipt"].includes(method));
      const res=await fetch(rpcUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(25000)])});
      assert(res.ok,`HTTP ${res.status}`);const body:any=await res.json();assert.equal(body.id,id);assert.equal(body.jsonrpc,"2.0");assert(!body.error,`read failed ${method}`);return body.result;
    };
    const header=await rpc("eth_getBlockByNumber",[ethers.toQuantity(N),false]);assert.equal(header.hash,HASH);assert.equal(BigInt(await rpc("eth_chainId",[])),1n);report.header=header;
    const artifactPath=resolve(ROOT,"out/BotVM.sol/BotVM.json"),artifactBytes=readFileSync(artifactPath),artifact=JSON.parse(artifactBytes.toString());
    const meta=typeof artifact.metadata==="string"?JSON.parse(artifact.metadata):artifact.metadata;
    assert.equal(meta.settings.compilationTarget["src/BotVM.sol"],"BotVM");assert(Object.keys(meta.sources).length>0);
    for(const [name,entry] of Object.entries(meta.sources) as [string,{keccak256:string}][]){const path=realpathSync(resolve(ROOT,name));assert(name.endsWith(".sol")&&!relative(realpathSync(ROOT),path).startsWith(".."));assert.equal(ethers.keccak256(readFileSync(path)),entry.keccak256);}
    const executorRuntimeCode=loadBotVmRuntimeCode(owner);assert.equal(provenance.counterfactualExecutorCode.keccak256,executorRuntimeCode.keccak256);
    report.executorArtifactSha256=sha(artifactBytes);report.executorCodeHash=executorRuntimeCode.keccak256;
    report.executorProvisioning=assertExecutorCode(await rpc("eth_getCode",[executor,pin]),executorRuntimeCode.code);assertOriginAccountCode(await rpc("eth_getCode",[owner,pin]));
    finalPins=async()=>{assert.deepEqual(pins(),report.inputs);assert.deepEqual(sourcePin(),report.code);assert.equal(sha(readFileSync(artifactPath)),report.executorArtifactSha256);assert.equal((await rpc("eth_getBlockByNumber",[ethers.toQuantity(N),false])).hash,HASH);};
    simulation=createRevmStrictSourceSimulation({identity:{source,rpcUrl,chainId:1,stateRoot:header.stateRoot},executorRuntimeCode,control:{signal:abort.signal,deadlineAtMs},executionGasLimit:0x1000000,
      createClient:({onFatal})=>new RevmSimClient({executablePath:args.get("--revm-bin")!,timeoutMs:90000,onFatal}),onFatal:()=>abort.abort(new Error("Vault simulation fatal"))});
    const runtime=createStrictCentralAdapterRuntime({simulator:simulation.transport,executor,transactionOrigin:owner,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);abort.signal.throwIfAborted();}},
      provider:{call:async({blockTag,...tx}:any,n:number)=>{assert.equal(blockTag??n,N);return rpc("eth_call",[tx,pin]);},getCode:async(a:string,n:number)=>{assert.equal(n,N);return rpc("eth_getCode",[a,pin]);},getStorage:async(a:string,slot:string,n:number)=>{assert.equal(n,N);return rpc("eth_getStorageAt",[a,slot,pin]);}} as never});
    const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:1",familyIds:[FAMILY],executionIdentity:{executor,transactionOrigin:owner}}),family=asPricedFamily(catalog.forStrictFamily(FAMILY));
    const adapters=[...family.plugin.actionAdapters,...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile=(n:ResolvedPlanNode):Uint8Array=>{const a=adapters.find(a=>a.id===n.adapterId);assert(a);return a.encode(n,executor,concatBytes(...n.children.map(compile)));};
    report.original=originalAmount(receipt,trace);const original=report.original;
    const memos=activeReadyMemos(envelope).filter(m=>m.familyId===FAMILY&&m.instanceKey.startsWith(VAULT+":"));assert.equal(memos.length,1);
    const memo=memos[0];assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
    const d=instance.descriptor as Descriptor;assert.equal(d.vault,VAULT);assert.equal(instance.routes.length,2);
    assertHistoricalDiscoveryReceipt(receipt,memo.candidateSnapshot as any,source);
    report.admission={instanceKey:d.instanceKey,memoFingerprint:memo.memoFingerprint,familyDefinitionHash:memo.familyDefinitionHash,candidate:memo.candidateSnapshot};
    const routes=instance.routes as readonly Route[],handles=routes.map(r=>instance.routeHandles.find(h=>h.routeKey===r.routeKey)!);assert(handles.every(Boolean));
    const legs=handles.map(route=>{const leg=guard.build(()=>buildFamilyRuntimeAmountLeg({family,route,source,executor,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog}));assert(leg,"quoted fallback prohibited");return leg;});
    const execute=async(script:Uint8Array,route:Route,amount:bigint,missing=false)=>{
      const caller={kind:"executor" as const};const request:AdapterRequest={id:"vault-execution",required:false,kind:"effect-delta-simulation",call:{caller,executionMode:"executor-program",to:executor,data:buildSubscriptCalldata(script)},
        overrideIntent:{caller,nativeBalanceWei:17n,tokenBalances:[{token:route.tokenIn,amount:missing?(amount>101n?101n:0n):amount+101n},{token:route.tokenOut,amount:103n}]},
        observeTokenBalances:[route.tokenIn,route.tokenOut].flatMap(token=>[{token,account:caller},{token,account:d.vault}]),observeTotalSupplies:[...d.tokens],observe:effects};
      const outcome=await executeAdapterWork({runtime,control:{signal:abort.signal,deadlineAtMs},intent:{stage:"exact-refine",familyId:FAMILY,source,generation:source.generation,programInput:undefined,program:{requirements:()=>requirements,buildRequests:()=>[request],decode:({results}):readonly AdapterRequestResult[]=>results}}});
      assert.equal(outcome.status,"resolved");if(outcome.status!=="resolved")throw new Error("execution unresolved");const value=outcome.executed.evidence[0];assert(value.ok,"transport failure is not EVM rejection");assert.deepEqual(value.source,source);return {request,outcome,value};
    };
    const reverted=(value:AdapterRequestResult)=>{assert(value.ok);assert.equal(value.completion,"reverted-as-declared");assert.deepEqual(value.effects,{tokenDeltas:[],nativeDeltas:[],totalSupplyDeltas:[],logs:[]});};
    report.naturalRows=[];
    for(const [index,route] of routes.entries()){
      const edges=graph.filter(e=>e.instanceKey===d.instanceKey&&same(e.tokenIn,route.tokenIn)&&same(e.tokenOut,route.tokenOut));assert.equal(edges.length,1);
      const key=blockScanEdgeKey(edges[0]),row=prices.runtime.pricing.effectiveMids.rows.get(key),raw=prices.runtime.pricing.mids.get(key);assert(raw?.mid>0);assert(row);report.naturalRows.push({key,raw,effective:row});
      const forward=route.tokenIn===original.tokenIn,originalNumber=forward?original.amountIn:original.amountOut;
      const trials=[{label:forward?"manual-original-input":"manual-original-output-as-reverse-input",amount:originalNumber,wantReturn:!forward},
        {label:forward?"manual-double-original-input":"manual-double-original-output-as-reverse-input",amount:originalNumber*2n,wantReturn:false}];
      // This diagnostic amount is disclosed separately. It never replaces
      // the original trade size or a failed production reference input.
      if(forward)trials.push({label:"manual-legal-diagnostic",amount:1000000000000n,wantReturn:true},{label:"manual-double-legal-diagnostic",amount:2000000000000n,wantReturn:true});
      assert.equal(typeof row.amountIn,"bigint","production requested amount must be preserved even on quote failure");
      trials.push({label:"production-effective",amount:row.amountIn,wantReturn:!forward},{label:"double-production-effective",amount:row.amountIn*2n,wantReturn:!forward},{label:"one-raw-unit-boundary",amount:1n,wantReturn:!forward});
      for(const {label,amount,wantReturn} of trials){
        stage=`quote:${route.tokenIn}:${label}`;const trial:any={direction:index,tokenIn:route.tokenIn,tokenOut:route.tokenOut,label,amountIn:amount,expected:wantReturn?"positive-full-input":"N-capacity-or-zero-output-rejection",status:"failed",executions:[]};report.samples.push(trial);
        const quote=await guard.exact(()=>executeFamilyExactQuote({family,route:handles[index],amountIn:amount,source,generation:source.generation,executor,runtimeEvidence:[],runtime,control:{signal:abort.signal,deadlineAtMs}}));trial.quote=quote;
        const runtimeScript=runtimeProgramScript(ethers.getBytes(legs[index].program),amount);
        if(quote.status!=="resolved"){
          assert.equal(wantReturn,false,"a required supported amount must quote");
          const run=await execute(runtimeScript,route,amount);reverted(run.value);trial.executions.push({encoding:"runtime",negative:"quote-unavailable-same-input",...run,status:"pass"});
          trial.status="same-N-quote-and-execution-rejected";
          console.log(json({label,tokenIn:route.tokenIn,amountIn:amount,status:trial.status}));continue;
        }
        assert.equal(wantReturn,true,"predeclared capacity or zero-output boundary must reject");
        assert.equal(quote.amountIn,amount);assert(quote.amountOut>0n);assert.deepEqual(quote.source,source);
        if(label==="production-effective"){assert.equal(row.status,"quoted");assert.equal(quote.amountOut,row.amountOut);}
        const fragment=guard.quoted(()=>buildFamilyExecutionFragment({family,route:handles[index],exact:quote,minAmountOut:quote.amountOut,executor,runtimeEvidence:[],actionOwnership:catalog}));assert.equal(fragment.status,"resolved");if(fragment.status!=="resolved")throw new Error("fragment unresolved");
        const nodes=planFragmentNodes(fragment.fragment,route.tokenIn,amount),quoted=concatBytes(...nodes.map(compile));
        const scripts:[string,Uint8Array][]=[["quoted",quoted],["runtime",runtimeScript],["quoted-minimum-plus-one",concatBytes(...nodes.map(n=>compile({...n,params:{...n.params,minAmountOut:quote.amountOut+1n}})))]];
        for(const [encoding,script] of scripts)for(const negative of encoding==="quoted-minimum-plus-one"?["minimum-output-plus-one"]:["none","insufficient-total-input","post-execution-revert"]){
          const executed=negative==="post-execution-revert"?concatBytes(script,runtimeProgramScript(new RuntimeAmountProgram().constant(1,0n).constant(2,1n).equal(1,2).bytes(),0n)):script;
          const run=await execute(executed,route,amount,negative==="insufficient-total-input");
          if(negative==="none"){assert.equal(run.value.completion,"returned");assert.equal(run.value.data,"0x");observed(run.value.effects,d,route,executor,amount,quote.amountOut);}
          else reverted(run.value);
          trial.executions.push({encoding,negative,...run,status:"pass"});
        }
        // Keep the shared final repayment minimum at the entire starting
        // amount. A fee-paying Vault round trip must not spend old inventory
        // to conceal its loss and must fail atomically.
        const flow:ResolvedPlanNode={adapterId:"runtime-amount-flow",target:executor,tokenIn:route.tokenIn,tokenOut:route.tokenIn,amount,children:[],params:{minimumReturn:amount,quoteToleranceRawUnits:0n,
          legs:JSON.stringify([index,1-index].map(i=>({tokenIn:routes[i].tokenIn,tokenOut:routes[i].tokenOut,program:legs[i].program})))}};
        const flowRun=await execute(runtimeAmountFlowAdapter.encode(flow,executor,new Uint8Array()),route,amount);reverted(flowRun.value);
        report.roundTrips.push({label,direction:index,amountIn:amount,minimumReturn:amount,expected:"fee-or-rounding-loss-closed-loop-rejection",...flowRun,status:"pass"});
        trial.status="same-N-dual-pass";console.log(json({label,tokenIn:route.tokenIn,amountIn:amount,amountOut:quote.amountOut,status:trial.status}));
      }
    }
    assert.equal(report.samples.length,12);assert(report.samples.every((s:any)=>s.status!=="failed"));
    assert(report.samples.some((s:any)=>s.label==="production-effective"&&s.status==="same-N-dual-pass"));
    assert(report.samples.some((s:any)=>s.label==="manual-legal-diagnostic"&&s.status==="same-N-dual-pass"));
    assert.equal(guard.counts.forbiddenDuringBuild,0);report.runtimeConstruction={rpc:0,exact:0,quotedFallback:false,scope:"real production issuer; live selector throwing-stub regression remains in shared family-dual suite"};
    report.result="same-N-dual-and-state-rejections-recorded";
  }catch(e){report.error={stage,message:redact(e instanceof Error?e.stack:e)};process.exitCode=1;}
  finally{try{await finalPins?.();await simulation?.closeAndDrain();report.drained=true;}catch(e){report.finalError=redact(e);report.result="failed";process.exitCode=1;await simulation?.closeAndDrain().catch(()=>{});}
    clearTimeout(timer);report.directReads=reads;report.invocationCounts=guard.counts;writeFileSync(fd,redact(json(report))+"\n");closeSync(fd);console.log(json({result:report.result,error:report.error,samples:report.samples.length,out:args.get("--out")}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("invalid Vault historical dual input; existing files preserved");process.exitCode=1;});
