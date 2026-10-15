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
export function recipientContinuation(){return new RuntimeAmountProgram().constant(1,0n);}
async function main(){
  const names=["--ready","--prices","--evidence-dir","--rpc-file","--revm-bin","--out"],args=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2){assert(names.includes(process.argv[i]!)&&!args.has(process.argv[i]!)&&process.argv[i+1]);args.set(process.argv[i]!,process.argv[i+1]!);}
  assert(names.every(n=>args.has(n)));
  const fd=openSync(args.get("--out")!,"wx",0o600),report:any={result:"failed",samples:[],roundTrips:[],tx:TX,source:{number:N,hash:HASH},signing:false,broadcast:false,
    scope:"Current external-recipient direct modes only; default quoted/runtime retained in prior evidence. Prior prices provide input amounts only. N-end actual delta checks, no original-precall replay, opportunity or performance claim."};
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
    report.amountDonor={path:pricePath,sha256:report.inputs[1].sha256,scope:"amountIn only; no output, admission or current natural valuation borrowed", priorSource:provenance.source};
    const donorSource=prices.runtime.pricing.effectiveMids.source;assert.equal(donorSource.number,N);assert.equal(donorSource.hash,HASH);report.amountDonor.source=donorSource;
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
    const executorRuntimeCode=loadBotVmRuntimeCode(owner);report.priorExecutorCodeHash=provenance.counterfactualExecutorCode.keccak256;
    report.executorArtifactSha256=sha(artifactBytes);report.executorCodeHash=executorRuntimeCode.keccak256;
    report.executorProvisioning=assertExecutorCode(await rpc("eth_getCode",[executor,pin]),executorRuntimeCode.code);assertOriginAccountCode(await rpc("eth_getCode",[owner,pin]));
    finalPins=async()=>{assert.deepEqual(pins(),report.inputs);assert.deepEqual(sourcePin(),report.code);assert.equal(sha(readFileSync(artifactPath)),report.executorArtifactSha256);assert.equal((await rpc("eth_getBlockByNumber",[ethers.toQuantity(N),false])).hash,HASH);};
    simulation=createRevmStrictSourceSimulation({identity:{source,rpcUrl,chainId:1,stateRoot:header.stateRoot},executorRuntimeCode,control:{signal:abort.signal,deadlineAtMs},executionGasLimit:0x1000000,
      createClient:({onFatal})=>new RevmSimClient({executablePath:args.get("--revm-bin")!,timeoutMs:90000,onFatal}),onFatal:()=>abort.abort(new Error("Vault simulation fatal"))});
    const runtime=createStrictCentralAdapterRuntime({simulator:simulation.transport,executor,transactionOrigin:owner,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);abort.signal.throwIfAborted();}},
      provider:{call:async({blockTag,...tx}:any,n:number)=>{assert.equal(blockTag??n,N);return rpc("eth_call",[tx,pin]);},getCode:async(a:string,n:number)=>{assert.equal(n,N);return rpc("eth_getCode",[a,pin]);},getStorage:async(a:string,slot:string,n:number)=>{assert.equal(n,N);return rpc("eth_getStorageAt",[a,slot,pin]);}} as never});
    const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:1",familyIds:[FAMILY],executionIdentity:{executor,transactionOrigin:owner}}),family=asPricedFamily(catalog.forStrictFamily(FAMILY));
    report.original=originalAmount(receipt,trace);const original=report.original;
    const memos=activeReadyMemos(envelope).filter(m=>m.familyId===FAMILY&&m.instanceKey.startsWith(VAULT+":"));assert.equal(memos.length,1);
    const memo=memos[0];assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
    const d=instance.descriptor as Descriptor;assert.equal(d.vault,VAULT);assert.equal(instance.routes.length,2);
    assertHistoricalDiscoveryReceipt(receipt,memo.candidateSnapshot as any,source);
    report.admission={instanceKey:d.instanceKey,memoFingerprint:memo.memoFingerprint,familyDefinitionHash:memo.familyDefinitionHash,candidate:memo.candidateSnapshot};
    const routes=instance.routes as readonly Route[],handles=routes.map(r=>instance.routeHandles.find(h=>h.routeKey===r.routeKey)!);assert(handles.every(Boolean));
    const recipient=owner,token=new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
    const build=(index:number,settlement:any)=>guard.build(()=>buildFamilyRuntimeAmountLeg({family,route:handles[index],source,executor,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog,settlement}));
    const legs=handles.map((_,index)=>{const request={kind:"direct-output",recipient},leg=build(index,request);assert(leg);assert.deepEqual(leg.settlementRequest,request);assert.equal(leg.settlement?.directOutput,true);
      for(const request of [{kind:"quote-output",recipient},{kind:"deferred-input",paymentAmount:1n,paymentProgram:ethers.hexlify(recipientContinuation().bytes())}])assert.equal(build(index,request),null);return leg;});
    const execute=async(script:Uint8Array,route:Route,amount:bigint,inputBalance:bigint,oldOutput:bigint)=>{
      const caller={kind:"executor" as const};const request:AdapterRequest={id:"vault-recipient-execution",required:false,kind:"effect-delta-simulation",call:{caller,executionMode:"executor-program",to:executor,data:buildSubscriptCalldata(script)},
        overrideIntent:{caller,nativeBalanceWei:17n,tokenBalances:[{token:route.tokenIn,amount:inputBalance},{token:route.tokenOut,amount:oldOutput}]},
        observeTokenBalances:[route.tokenIn,route.tokenOut].flatMap(token=>[{token,account:caller},{token,account:recipient},{token,account:d.vault}]),observeTotalSupplies:[...d.tokens],observe:effects};
      const outcome=await executeAdapterWork({runtime,control:{signal:abort.signal,deadlineAtMs},intent:{stage:"exact-refine",familyId:FAMILY,source,generation:source.generation,programInput:undefined,program:{requirements:()=>requirements,buildRequests:()=>[request],decode:({results}):readonly AdapterRequestResult[]=>results}}});
      assert.equal(outcome.status,"resolved");if(outcome.status!=="resolved")throw new Error("execution unresolved");const value=outcome.executed.evidence[0];assert(value.ok,"transport failure is not EVM rejection");assert.deepEqual(value.source,source);return {request,outcome,value};
    };
    const reverted=(value:AdapterRequestResult)=>{assert(value.ok);assert.equal(value.completion,"reverted-as-declared");assert.deepEqual(value.effects,{tokenDeltas:[],nativeDeltas:[],totalSupplyDeltas:[],logs:[]});};
    report.naturalRows=[];
    for(const [index,route] of routes.entries()){
      const edges=graph.filter(e=>e.instanceKey===d.instanceKey&&same(e.tokenIn,route.tokenIn)&&same(e.tokenOut,route.tokenOut));assert.equal(edges.length,1);
      const key=blockScanEdgeKey(edges[0]),row=prices.runtime.pricing.effectiveMids.rows.get(key),raw=prices.runtime.pricing.mids.get(key);assert(raw?.mid>0);assert(row);report.naturalRows.push({key,raw,effective:row,reuse:"amount donor only; not current natural valuation"});
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
          assert.equal(wantReturn,false,"required amount must quote");const run=await execute(runtimeScript,route,amount,amount+101n,103n);reverted(run.value);
          trial.executions.push({mode:"direct",fault:"same-state-capacity-or-zero-output",...run,status:"correctly-rejected"});trial.status="same-N-quote-and-direct-rejected";continue;
        }
        assert.equal(wantReturn,true);assert.equal(quote.amountIn,amount);assert(quote.amountOut>0n);assert.deepEqual(quote.source,source);
        for(const oldOutput of [0n,103n])for(const fault of ["none","insufficient-input","minimum-plus-one","wrong-receiver-postcondition","post-revert"]){
          const post=recipientContinuation();
          if(fault==="minimum-plus-one"||fault==="wrong-receiver-postcondition"){
            const account=fault==="wrong-receiver-postcondition"?executor:recipient;
            const opening=fault==="wrong-receiver-postcondition"?oldOutput:BigInt(token.decodeFunctionResult("balanceOf",await rpc("eth_call",[{to:route.tokenOut,data:token.encodeFunctionData("balanceOf",[recipient])},pin]))[0]);
            post.call(route.tokenOut,token.encodeFunctionData("balanceOf",[account]),{static:true}).load(1,0).constant(2,opening).math("sub",1,1,2).constant(2,quote.amountOut+(fault==="minimum-plus-one"?1n:0n)).math("sub",1,1,2);
          }
          if(fault==="post-revert")post.constant(1,1n).constant(2,0n).equal(1,2);
          const script=concatBytes(runtimeScript,runtimeProgramScript(post.bytes(),0n));
          const run=await execute(script,route,amount,fault==="insufficient-input"?amount-1n:amount+101n,oldOutput);
          const record:any={mode:"direct",fault,oldOutput,...run,status:"failed"};trial.executions.push(record);
          if(fault!=="none"){reverted(run.value);}else{
            assert.equal(run.value.completion,"returned");assert.equal(run.value.data,"0x");const e=run.value.effects!;
            assert.equal(e.tokenDeltas?.length,6);assert.equal(e.nativeDeltas?.length,1);assert.equal(e.nativeDeltas![0].delta,0n);assert(same(e.nativeDeltas![0].account,executor));
            for(const [t,a,delta] of [[route.tokenIn,executor,-amount],[route.tokenOut,executor,0n],[route.tokenIn,recipient,0n],[route.tokenOut,recipient,quote.amountOut],[route.tokenIn,d.vault,amount],[route.tokenOut,d.vault,-quote.amountOut]] as const){
              const rows=e.tokenDeltas!.filter(x=>same(x.token,t)&&same(x.account,a));assert.equal(rows.length,1);assert.equal(rows[0].delta,delta);
            }
            assert.equal(e.totalSupplyDeltas?.length,2);for(const t of d.tokens){const rows=e.totalSupplyDeltas!.filter(x=>same(x.token,t));assert.equal(rows.length,1);assert.equal(rows[0].delta,0n);}
            const events=e.logs!.filter(x=>same(x.address,d.vault)).map(decodeSwapLog).filter(x=>x!==null);assert.equal(events.length,1);assert(same(events[0].account,recipient));assert.equal(events[0].amountIn,amount);assert.equal(events[0].amountOut,quote.amountOut);assert.equal(events[0].tokenIn,route.tokenIn);assert.equal(events[0].tokenOut,route.tokenOut);
          }
          Object.assign(record,{status:fault==="none"?"pass":"correctly-rejected",rollbackEvidence:fault==="none"?undefined:"MainRevert via trusted production transport; effects intentionally omitted, no independent post-revert storage observation claimed"});
        }
        trial.status="same-N-direct-pass";console.log(json({label,tokenIn:route.tokenIn,amountIn:amount,amountOut:quote.amountOut,status:trial.status}));
      }
    }
    for(const [index,route] of routes.entries()){const run=await execute(runtimeProgramScript(ethers.getBytes(legs[index].program),0n),route,0n,101n,103n);reverted(run.value);report.roundTrips.push({kind:"direct-zero-rejection",direction:index,...run});}
    assert.equal(report.samples.length,12);assert(report.samples.every((s:any)=>s.status!=="failed"));
    assert(report.samples.some((s:any)=>s.label==="production-effective"&&s.status==="same-N-direct-pass"));
    assert(report.samples.some((s:any)=>s.label==="manual-legal-diagnostic"&&s.status==="same-N-direct-pass"));
    assert.equal(guard.counts.forbiddenDuringBuild,0);report.runtimeConstruction={rpc:0,exact:0,quotedFallback:false,scope:"real production issuer; live selector throwing-stub regression remains in shared family-dual suite"};
    report.result="same-N-direct-and-state-rejections-recorded";
  }catch(e){report.error={stage,message:redact(e instanceof Error?e.stack:e)};process.exitCode=1;}
  finally{try{await finalPins?.();await simulation?.closeAndDrain();report.drained=true;}catch(e){report.finalError=redact(e);report.result="failed";process.exitCode=1;await simulation?.closeAndDrain().catch(()=>{});}
    clearTimeout(timer);report.directReads=reads;report.invocationCounts=guard.counts;writeFileSync(fd,redact(json(report))+"\n");closeSync(fd);console.log(json({result:report.result,error:report.error,samples:report.samples.length,out:args.get("--out")}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("invalid Vault historical dual input; existing files preserved");process.exitCode=1;});
