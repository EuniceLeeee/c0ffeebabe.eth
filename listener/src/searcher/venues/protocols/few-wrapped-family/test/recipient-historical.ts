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
import { FAMILY } from "../manifest.js";
import { ABI } from "../codec.js";
import type { Descriptor, Route } from "../types.js";
const N=26182689,HASH="0xeb0d092ce871b19f4071115a4816a282864c7adf6e6d9c1971e30c61596aa09c";
const TX="0xc191d9dfd0897d17351e8e699b22aba475a04fccb74508a4b06a7b630b733058";
const targets=["0xa250cc729bb3323e7933022a67b52200fe354767","0x0e3fe143de98c73e72942c8f760a2e69d98bc1cb"];
const ROOT=fileURLToPath(new URL("../../../../../../../",import.meta.url));
const ERC20=new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const effects=["return-data","revert-data","token-delta","total-supply-delta","native-delta","logs"] as const;
const requirements={transports:["effect-delta-simulation"] as const,caller:"executor" as const,effects};
export function originalAmount(receipt:any,trace:any,d:Pick<Descriptor,"target"|"asset">){
  assert(receipt && receipt.transactionHash===TX && receipt.blockHash===HASH && BigInt(receipt.blockNumber)===BigInt(N) && BigInt(receipt.status)===1n);
  assert(trace&&!trace.error&&!trace.revertReason);
  const frames:any[]=[];
  const walk=(f:any)=>{if(!f||f.error||f.revertReason)return;
    if(f.type==="CALL"&&same(f.to??"",d.target)) {try{const call=ABI.parseTransaction({data:f.input});if(call&&["wrap","unwrap","wrapTo","unwrapTo"].includes(call.name))frames.push({f,call});}catch{}}
    for(const c of f.calls??[])walk(c);
  };walk(trace);assert.equal(frames.length,1,"ambiguous original conversion");
  const {f,call}=frames[0],direction=call.name.startsWith("unwrap")?"unwrap":"wrap",amount=BigInt(call.args[0]);assert(amount>0n);
  const receiver=call.name.endsWith("To")?call.args[1]:f.from;
  assert.equal(ABI.decodeFunctionResult(call.name,f.output)[0],amount);
  const name=direction==="wrap"?"Wrap":"Unwrap";
  const logs=receipt.logs.filter((l:any)=>!l.removed&&same(l.address,d.target)&&same(l.topics[0],ABI.getEvent(name)!.topicHash));assert.equal(logs.length,1);
  const event=ABI.parseLog(logs[0])!.args;assert(same(event.sender,f.from)&&same(event.to,receiver));assert.equal(event.amount,amount);
  const transfer=(token:string,from:string,to:string)=>{
    const rows=receipt.logs.filter((l:any)=>!l.removed&&same(l.address,token)&&same(l.topics[0],ERC20.getEvent("Transfer")!.topicHash))
      .map((l:any)=>ERC20.parseLog(l)!.args).filter((e:any)=>same(e.from,from)&&same(e.to,to)&&e.value===amount);
    assert.equal(rows.length,1,"original independent transfer missing/ambiguous");
  };
  if(direction==="wrap"){transfer(d.asset,f.from,d.target);transfer(d.target,ethers.ZeroAddress,receiver);}
  else {transfer(d.target,f.from,ethers.ZeroAddress);transfer(d.asset,d.target,receiver);}
  return {amountIn:amount,amountOut:amount,direction,method:call.name,actor:f.from,receiver,logIndex:logs[0].logIndex};
}
export function recipientContinuation(){return new RuntimeAmountProgram().constant(1,0n);}
async function main(){
  const names=["--ready","--prices","--evidence-dir","--rpc-file","--revm-bin","--out"],args=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2){assert(names.includes(process.argv[i]!)&&!args.has(process.argv[i]!)&&process.argv[i+1]);args.set(process.argv[i]!,process.argv[i+1]!);}
  assert(names.every(n=>args.has(n)));
  const fd=openSync(args.get("--out")!,"wx",0o600),report:any={result:"failed",samples:[],roundTrips:[],tx:TX,source:{number:N,hash:HASH},signing:false,broadcast:false,
    scope:"Two Few instances, both directions, current direct receiver execution only. Default dual evidence retained; prior price rows donate amounts only. No original-precall, opportunity or performance verdict."};
  const abort=new AbortController(),deadlineAtMs=Date.now()+600000,timer=setTimeout(()=>abort.abort(new Error("Few acceptance deadline")),600000);
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
    report.amountDonor={path:pricePath,sha256:report.inputs[1].sha256,scope:"amountIn only; no output, admission or current natural valuation borrowed",priorSource:provenance.source};
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
      createClient:({onFatal})=>new RevmSimClient({executablePath:args.get("--revm-bin")!,timeoutMs:90000,onFatal}),onFatal:()=>abort.abort(new Error("Few simulation fatal"))});
    const runtime=createStrictCentralAdapterRuntime({simulator:simulation.transport,executor,transactionOrigin:owner,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);abort.signal.throwIfAborted();}},
      provider:{call:async({blockTag,...tx}:any,n:number)=>{assert.equal(blockTag??n,N);return rpc("eth_call",[tx,pin]);},getCode:async(a:string,n:number)=>{assert.equal(n,N);return rpc("eth_getCode",[a,pin]);},getStorage:async(a:string,slot:string,n:number)=>{assert.equal(n,N);return rpc("eth_getStorageAt",[a,slot,pin]);}} as never});
    const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:1",familyIds:[FAMILY],executionIdentity:{executor,transactionOrigin:owner}}),family=asPricedFamily(catalog.forStrictFamily(FAMILY));
    report.admissions=[];report.naturalRows=[];
    for(const target of targets){
      const memos: ReturnType<typeof activeReadyMemos>=activeReadyMemos(envelope).filter(m=>m.familyId===FAMILY&&same(m.instanceKey,target));assert.equal(memos.length,1);const memo=memos[0]!;assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
      const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
      const d=instance.descriptor as Descriptor;assert(same(d.target,target));assert.equal(instance.routes.length,2);
      const candidate:any=memo.candidateSnapshot;assertHistoricalDiscoveryReceipt(same(candidate.transactionHash,TX)?receipt:await rpc("eth_getTransactionReceipt",[candidate.transactionHash]),candidate,source);
      const original=originalAmount(receipt,trace,d);report.admissions.push({target,memoFingerprint:memo.memoFingerprint,familyDefinitionHash:memo.familyDefinitionHash,candidate,original});
      const routes=instance.routes as readonly Route[],handles=routes.map(r=>instance.routeHandles.find(h=>h.routeKey===r.routeKey)!);assert(handles.every(Boolean));
      const recipient=owner;
      const build=(index:number,settlement:any)=>guard.build(()=>buildFamilyRuntimeAmountLeg({family,route:handles[index],source,executor,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog,settlement}));
      const legs=handles.map((_,index)=>{const request={kind:"direct-output",recipient},leg=build(index,request);assert(leg);assert.deepEqual(leg.settlementRequest,request);assert.equal(leg.settlement?.directOutput,true);
        for(const request of [{kind:"quote-output",recipient},{kind:"deferred-input",paymentAmount:1n,paymentProgram:ethers.hexlify(recipientContinuation().bytes())}])assert.equal(build(index,request),null);return leg;});
      const execute=async(script:Uint8Array,route:Route,inputBalance:bigint,oldOutput:bigint)=>{
        const caller={kind:"executor" as const};const request:AdapterRequest={id:"few-recipient-execution",required:false,kind:"effect-delta-simulation",call:{caller,executionMode:"executor-program",to:executor,data:buildSubscriptCalldata(script)},
          overrideIntent:{caller,nativeBalanceWei:17n,tokenBalances:[{token:route.tokenIn,amount:inputBalance},{token:route.tokenOut,amount:oldOutput}]},
          observeTokenBalances:[route.tokenIn,route.tokenOut].flatMap(token=>[{token,account:caller},{token,account:recipient}]).concat([{token:d.asset,account:d.target}]),observeTotalSupplies:[d.target],observe:effects};
        const outcome=await executeAdapterWork({runtime,control:{signal:abort.signal,deadlineAtMs},intent:{stage:"exact-refine",familyId:FAMILY,source,generation:source.generation,programInput:undefined,program:{requirements:()=>requirements,buildRequests:()=>[request],decode:({results}):readonly AdapterRequestResult[]=>results}}});
        assert.equal(outcome.status,"resolved");if(outcome.status!=="resolved")throw new Error("execution unresolved");const value=outcome.executed.evidence[0]!;assert(value.ok,"transport failure is not EVM rejection");assert.deepEqual(value.source,source);return {request,outcome,value};
      };
      const reverted=(value:AdapterRequestResult)=>{assert(value.ok);assert.equal(value.completion,"reverted-as-declared");assert.deepEqual(value.effects,{tokenDeltas:[],nativeDeltas:[],totalSupplyDeltas:[],logs:[]});};
      for(const [index,route] of routes.entries()){
        const edges=graph.filter(e=>e.instanceKey!==undefined&&same(e.instanceKey,target)&&same(e.tokenIn,route.tokenIn)&&same(e.tokenOut,route.tokenOut));assert.equal(edges.length,1);
        const key=blockScanEdgeKey(edges[0]!),row=prices.runtime.pricing.effectiveMids.rows.get(key),raw=prices.runtime.pricing.mids.get(key);assert(raw?.mid>0);assert(row&&["quoted","missing-valuation"].includes(row.status));report.naturalRows.push({key,row,reuse:"amount only; no current natural valuation claim"});
        const trials=[{label:"manual-original-raw-input",amount:original.amountIn},{label:"manual-double-original-raw-input",amount:original.amountIn*2n}];
        if(row.status==="quoted")trials.push({label:"production-effective",amount:row.amountIn});
        for(const {label,amount} of trials){
          stage=`quote:${target}:${route.direction}:${label}`;const trial:any={target,direction:route.direction,tokenIn:route.tokenIn,tokenOut:route.tokenOut,label,amountIn:amount,originalInputToken:original.direction==="wrap"?d.asset:d.target,manualNumberOnly:label!=="production-effective",status:"failed",executions:[]};report.samples.push(trial);
          const quote=await guard.exact(()=>executeFamilyExactQuote({family,route:handles[index]!,amountIn:amount,source,generation:source.generation,executor,runtimeEvidence:[],runtime,control:{signal:abort.signal,deadlineAtMs}}));
          trial.quote=quote;assert.equal(quote.status,"resolved");if(quote.status!=="resolved")throw new Error("Exact unresolved");assert.equal(quote.amountIn,amount);assert.equal(quote.amountOut,amount);assert.deepEqual(quote.source,source);
          const runtimeScript=runtimeProgramScript(ethers.getBytes(legs[index]!.program),amount);
          for(const oldOutput of [0n,103n])for(const fault of ["none","insufficient-input","minimum-plus-one","wrong-receiver-postcondition","post-revert"]){
            const post=recipientContinuation();
            if(fault==="minimum-plus-one"||fault==="wrong-receiver-postcondition"){
              const account=fault==="wrong-receiver-postcondition"?executor:recipient;
              const opening=fault==="wrong-receiver-postcondition"?oldOutput:BigInt(ABI.decodeFunctionResult("balanceOf",await rpc("eth_call",[{to:route.tokenOut,data:ABI.encodeFunctionData("balanceOf",[recipient])},pin]))[0]);
              post.call(route.tokenOut,ABI.encodeFunctionData("balanceOf",[account]),{static:true}).load(1,0).constant(2,opening).math("sub",1,1,2).constant(2,quote.amountOut+(fault==="minimum-plus-one"?1n:0n)).math("sub",1,1,2);
            }
            if(fault==="post-revert")post.constant(1,1n).constant(2,0n).equal(1,2);
            const run=await execute(concatBytes(runtimeScript,runtimeProgramScript(post.bytes(),0n)),route,fault==="insufficient-input"?amount-1n:amount+101n,oldOutput);
            const record:any={mode:"direct",fault,oldOutput,...run,status:"failed"};trial.executions.push(record);
            if(fault!=="none")reverted(run.value);else{
              assert.equal(run.value.completion,"returned");assert.equal(run.value.data,"0x");const e=run.value.effects!,sign=route.direction==="wrap"?1n:-1n;
              assert.equal(e.tokenDeltas?.length,5);assert.equal(e.nativeDeltas?.length,1);assert.equal(e.nativeDeltas![0].delta,0n);assert(same(e.nativeDeltas![0].account,executor));
              for(const [t,a,delta] of [[route.tokenIn,executor,-amount],[route.tokenOut,executor,0n],[route.tokenIn,recipient,0n],[route.tokenOut,recipient,amount],[d.asset,d.target,sign*amount]] as const){
                const rows=e.tokenDeltas!.filter(x=>same(x.token,t)&&same(x.account,a));assert.equal(rows.length,1);assert.equal(rows[0].delta,delta);
              }
              assert.equal(e.totalSupplyDeltas?.length,1);assert(same(e.totalSupplyDeltas![0].token,d.target));assert.equal(e.totalSupplyDeltas![0].delta,sign*amount);
              const name=route.direction==="wrap"?"Wrap":"Unwrap",events=e.logs!.filter(x=>same(x.address,d.target)&&same(x.topics[0],ABI.getEvent(name)!.topicHash)).map(x=>ABI.parseLog(x)!.args);
              assert.equal(events.length,1);assert(same(events[0].sender,executor));assert(same(events[0].to,recipient));assert.equal(events[0].amount,amount);
            }
            Object.assign(record,{status:fault==="none"?"pass":"correctly-rejected",rollbackEvidence:fault==="none"?undefined:"MainRevert via trusted production transport; effects intentionally omitted, no independent post-revert storage observation claimed"});
          }
          trial.status="pass";console.log(json({target,direction:route.direction,label,amountIn:amount,status:trial.status}));
        }
        const run=await execute(runtimeProgramScript(ethers.getBytes(legs[index]!.program),0n),route,101n,103n);reverted(run.value);report.roundTrips.push({kind:"direct-zero-rejection",target,direction:route.direction,...run});
      }
    }
    assert.equal(report.samples.length,10);assert(report.samples.every((s:any)=>s.status==="pass"));assert.equal(report.roundTrips.length,4);
    assert.equal(guard.counts.forbiddenDuringBuild,0);report.runtimeConstruction={rpc:0,exact:0,quotedFallback:false,scope:"real production issuer; selector throwing-stub coverage in shared dual suite"};report.result="same-N-direct-input-pass";
  }catch(e){report.error={stage,message:redact(e instanceof Error?e.stack:e)};process.exitCode=1;}
  finally{try{await finalPins?.();await simulation?.closeAndDrain();report.drained=true;}catch(e){report.finalError=redact(e);report.result="failed";process.exitCode=1;await simulation?.closeAndDrain().catch(()=>{});}
    clearTimeout(timer);report.directReads=reads;report.invocationCounts=guard.counts;writeFileSync(fd,redact(json(report))+"\n");closeSync(fd);console.log(json({result:report.result,error:report.error,samples:report.samples.length,out:args.get("--out")}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("invalid Few historical dual input; existing files preserved");process.exitCode=1;});
