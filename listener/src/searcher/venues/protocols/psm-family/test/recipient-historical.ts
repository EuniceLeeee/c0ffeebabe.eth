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
import { PSM_FAMILY_ID as FAMILY } from "../manifest.js";
import { PSM_INTERFACE as ABI, psmBuyCost, psmBuyQuote, psmSellQuote } from "../codec.js";
import type { PsmDescriptor as Descriptor, PsmRoute as Route } from "../types.js";
const N=26029876,HASH="0xd33e839d78988e851e3e85515084208a7229f53feb0d446d9b63d8d1bd9b937a";
const TX="0x03d6a2efb77d0f80b21ff295674120f2dff2465f6a0497b58d9dfbe057703c72";
const TARGET="0xf6e72db5454dd049d0788e411b06cfaf16853042";
const ROOT=fileURLToPath(new URL("../../../../../../../",import.meta.url));
const TOKEN=new ethers.Interface(["function balanceOf(address) view returns(uint256)","event Transfer(address indexed from,address indexed to,uint256 value)"]);
const effects=["return-data","revert-data","token-delta","total-supply-delta","native-delta","logs"] as const;
const requirements={transports:["effect-delta-simulation"] as const,caller:"executor" as const,effects};
export function recipientContinuation(){return new RuntimeAmountProgram().constant(1,0n);}
async function main(){
  const names=["--ready","--reference","--rpc-file","--revm-bin","--out"],args=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2){assert(names.includes(process.argv[i]!)&&!args.has(process.argv[i]!)&&process.argv[i+1]);args.set(process.argv[i]!,process.argv[i+1]!);}
  assert(names.every(n=>args.has(n)));
  const fd=openSync(args.get("--out")!,"wx",0o600),report:any={result:"failed",samples:[],roundTrips:[],tx:TX,source:{number:N,hash:HASH},signing:false,broadcast:false,
    scope:"Current PSM direct self/external receiver execution. Full requested buy budget, actual integer cost and retained refund are separate. Prior same-N report donates input only; no old output/identity, current natural valuation, opportunity or performance claim."};
  const abort=new AbortController(),deadlineAtMs=Date.now()+600000,timer=setTimeout(()=>abort.abort(new Error("PSM recipient deadline")),600000);
  const guard=constructionGuard();let reads=0,rpcUrl="",stage="inputs",simulation:ReturnType<typeof createRevmStrictSourceSimulation>|undefined;
  let finalPins:(()=>Promise<void>)|undefined;
  const redact=(s:unknown)=>String(s).split(rpcUrl||"\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]");
  try{
    const readyPath=realpathSync(args.get("--ready")!),referencePath=realpathSync(args.get("--reference")!);
    const paths=[readyPath,referencePath,resolve(dirname(readyPath),"receipt.json"),fileURLToPath(import.meta.url),realpathSync(args.get("--revm-bin")!)];
    const pins=()=>paths.map(path=>({path,sha256:sha(readFileSync(path))}));report.inputs=pins();report.code=sourcePin();report.revmSha256=sha(readFileSync(args.get("--revm-bin")!));
    const reference=JSON.parse(readFileSync(referencePath,"utf8"));assert.equal(reference.result,"pass");assert.equal(reference.block,N);assert.equal(reference.inputs.source.hash,HASH);
    const envelope=await new UniverseRebuildCheckpointStore({path:readyPath}).load();assert(envelope&&!envelope.inProgressRun);
    const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source=ready.cutoff;assert.equal(source.number,N);assert.equal(source.hash,HASH);
    report.amountDonor={path:referencePath,sha256:report.inputs[1].sha256,source:reference.inputs.source,priorInputHashes:reference.inputHashes,scope:"amountIn only; old outputs/identity not borrowed; no current natural valuation claim"};
    const executor="0x1000000000000000000000000000000000000002",owner="0x1000000000000000000000000000000000000001";report.actors={executor,owner,scope:"isolated current executor/origin; not historical transaction sender"};
    const receipt=JSON.parse(readFileSync(paths[2]!,"utf8"));assertHistoricalDiscoveryReceipt(receipt,{transactionHash:TX,blockNumber:N,blockHash:HASH},source);
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
    const executorRuntimeCode=loadBotVmRuntimeCode(owner);report.priorExecutorCodeHash=reference.runtimeCodeHash;
    report.executorArtifactSha256=sha(artifactBytes);report.executorCodeHash=executorRuntimeCode.keccak256;
    report.executorProvisioning=assertExecutorCode(await rpc("eth_getCode",[executor,pin]),executorRuntimeCode.code);assertOriginAccountCode(await rpc("eth_getCode",[owner,pin]));
    finalPins=async()=>{assert.deepEqual(pins(),report.inputs);assert.deepEqual(sourcePin(),report.code);assert.equal(sha(readFileSync(artifactPath)),report.executorArtifactSha256);assert.equal((await rpc("eth_getBlockByNumber",[ethers.toQuantity(N),false])).hash,HASH);};
    simulation=createRevmStrictSourceSimulation({identity:{source,rpcUrl,chainId:1,stateRoot:header.stateRoot},executorRuntimeCode,control:{signal:abort.signal,deadlineAtMs},executionGasLimit:0x1000000,
      createClient:({onFatal})=>new RevmSimClient({executablePath:args.get("--revm-bin")!,timeoutMs:90000,onFatal}),onFatal:()=>abort.abort(new Error("PSM recipient simulation fatal"))});
    const runtime=createStrictCentralAdapterRuntime({simulator:simulation.transport,executor,transactionOrigin:owner,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);abort.signal.throwIfAborted();}},
      provider:{call:async({blockTag,...tx}:any,n:number)=>{assert.equal(blockTag??n,N);return rpc("eth_call",[tx,pin]);},getCode:async(a:string,n:number)=>{assert.equal(n,N);return rpc("eth_getCode",[a,pin]);},getStorage:async(a:string,slot:string,n:number)=>{assert.equal(n,N);return rpc("eth_getStorageAt",[a,slot,pin]);}} as never});
    const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:1",familyIds:[FAMILY],executionIdentity:{executor,transactionOrigin:owner}}),family=asPricedFamily(catalog.forStrictFamily(FAMILY));
    const memos=activeReadyMemos(envelope).filter(m=>m.familyId===FAMILY&&same(m.instanceKey,TARGET));assert.equal(memos.length,1);const memo=memos[0]!;assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
    const d=instance.descriptor as Descriptor;assert(same(d.target,TARGET));assert.equal(instance.routes.length,2);
    const pocket=ethers.getAddress(ABI.decodeFunctionResult("pocket",await rpc("eth_call",[{to:TARGET,data:ABI.encodeFunctionData("pocket")},pin]))[0]);
    assert(new Set([executor,owner,TARGET,pocket,...[d.gem,d.dai]].map(x=>x.toLowerCase())).size===6);
    report.admission={memoFingerprint:memo.memoFingerprint,familyDefinitionHash:memo.familyDefinitionHash,candidate:memo.candidateSnapshot,descriptor:d,pocket};
    const candidate:any=memo.candidateSnapshot;assertHistoricalDiscoveryReceipt(same(candidate.transactionHash,TX)?receipt:await rpc("eth_getTransactionReceipt",[candidate.transactionHash]),candidate,source);
    const routes=instance.routes as readonly Route[],handles=routes.map(r=>instance.routeHandles.find(h=>h.routeKey===r.routeKey)!);assert(handles.every(Boolean));
    const build=(index:number,settlement:any)=>guard.build(()=>buildFamilyRuntimeAmountLeg({family,route:handles[index],source,executor,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog,settlement}));
    const execute=async(script:Uint8Array,route:Route,inputBalance:bigint,oldOutput:bigint)=>{
      const caller={kind:"executor" as const};const request:AdapterRequest={id:"psm-direct-execution",required:false,kind:"effect-delta-simulation",call:{caller,executionMode:"executor-program",to:executor,data:buildSubscriptCalldata(script)},
        overrideIntent:{caller,nativeBalanceWei:17n,tokenBalances:[{token:route.tokenIn,amount:inputBalance},{token:route.tokenOut,amount:oldOutput}]},
        observeTokenBalances:[route.tokenIn,route.tokenOut].flatMap(token=>[{token,account:caller},{token,account:owner}]).concat([{token:d.gem,account:pocket},{token:d.dai,account:TARGET}]),observeTotalSupplies:[d.gem,d.dai],observe:effects};
      const outcome=await executeAdapterWork({runtime,control:{signal:abort.signal,deadlineAtMs},intent:{stage:"exact-refine",familyId:FAMILY,source,generation:source.generation,programInput:undefined,program:{requirements:()=>requirements,buildRequests:()=>[request],decode:({results}):readonly AdapterRequestResult[]=>results}}});
      assert.equal(outcome.status,"resolved");if(outcome.status!=="resolved")throw new Error("execution unresolved");const value=outcome.executed.evidence[0]!;assert(value.ok,"transport failure is not EVM rejection");assert.deepEqual(value.source,source);return {request,outcome,value};
    };
    const reverted=(value:AdapterRequestResult)=>{assert(value.ok);assert.equal(value.completion,"reverted-as-declared");assert.deepEqual(value.effects,{tokenDeltas:[],nativeDeltas:[],totalSupplyDeltas:[],logs:[]});};
    for(const [index,route] of routes.entries()){
      const edges=graph.filter(e=>e.instanceKey!==undefined&&same(e.instanceKey,TARGET)&&same(e.tokenIn,route.tokenIn)&&same(e.tokenOut,route.tokenOut));assert.equal(edges.length,1);
      const sell=route.direction==="sell-gem",fee=BigInt(ABI.decodeFunctionResult(sell?"tin":"tout",await rpc("eth_call",[{to:TARGET,data:ABI.encodeFunctionData(sell?"tin":"tout")},pin]))[0]);
      const donors=reference.samples.filter((s:any)=>s.family===FAMILY&&same(s.instance,TARGET)&&same(s.tokenIn,route.tokenIn)&&same(s.tokenOut,route.tokenOut));assert.equal(donors.length,3);
      const boundary=sell?1n:psmBuyCost(1n,fee,d.decimalScale);
      const trials=[...donors.map((s:any)=>({label:s.label,amount:BigInt(s.amountIn),donorRow:{edgeId:s.edgeId,source:reference.inputs.source,label:s.label}})),{label:"one-output-unit-cost",amount:boundary,donorRow:undefined},{label:"one-output-unit-cost-plus-one",amount:boundary+1n,donorRow:undefined}];
      for(const recipient of [executor,owner]){
        const request={kind:"direct-output",recipient},leg=build(index,request);assert(leg);assert.deepEqual(leg.settlementRequest,request);assert.equal(leg.settlement?.directOutput,true);assert.equal(leg.inputMode,sell?undefined:"maximum");
        for(const unsupported of [{kind:"quote-output",recipient},{kind:"deferred-input",paymentAmount:1n,paymentProgram:ethers.hexlify(recipientContinuation().bytes())}])assert.equal(build(index,unsupported),null);
        const external=!same(recipient,executor);
        for(const {label,amount,donorRow} of trials){
          stage=`quote:${route.direction}:${label}`;const trial:any={direction:route.direction,recipient,tokenIn:route.tokenIn,tokenOut:route.tokenOut,label,amountIn:amount,donorRow,status:"failed",executions:[]};report.samples.push(trial);
          const quote=await guard.exact(()=>executeFamilyExactQuote({family,route:handles[index]!,amountIn:amount,source,generation:source.generation,executor,runtimeEvidence:[],runtime,control:{signal:abort.signal,deadlineAtMs}}));trial.quote=quote;
          assert.equal(quote.status,"resolved");if(quote.status!=="resolved")throw new Error("Exact unresolved");assert.equal(quote.amountIn,amount);assert.deepEqual(quote.source,source);
          const output=(sell?psmSellQuote:psmBuyQuote)(amount,fee,d.decimalScale),cost=sell?amount:psmBuyCost(output,fee,d.decimalScale);assert.equal(quote.amountOut,output);assert(cost>0n&&output>0n&&cost<=amount);
          trial.inputBudget={requested:amount,cost,unspent:amount-cost,inputMode:sell?"exact":"maximum",fee,roundingToleranceRawUnits:0n};
          const runtimeScript=runtimeProgramScript(ethers.getBytes(leg.program),amount);
          for(const oldOutput of [0n,103n])for(const fault of ["none","insufficient-cost","minimum-plus-one","wrong-receiver-postcondition","post-revert"]){
            stage=`direct:${route.direction}:${label}:${fault}`;const post=recipientContinuation();
            if(fault==="minimum-plus-one"||fault==="wrong-receiver-postcondition"){
              const account=fault==="wrong-receiver-postcondition"?(external?executor:owner):recipient;
              const opening=same(account,executor)?oldOutput:BigInt(TOKEN.decodeFunctionResult("balanceOf",await rpc("eth_call",[{to:route.tokenOut,data:TOKEN.encodeFunctionData("balanceOf",[account])},pin]))[0]);
              post.call(route.tokenOut,TOKEN.encodeFunctionData("balanceOf",[account]),{static:true}).load(1,0).constant(2,opening).math("sub",1,1,2).constant(2,output+(fault==="minimum-plus-one"?1n:0n)).math("sub",1,1,2);
            }
            if(fault==="post-revert")post.constant(1,1n).constant(2,0n).equal(1,2);
            const run=await execute(concatBytes(runtimeScript,runtimeProgramScript(post.bytes(),0n)),route,fault==="insufficient-cost"?cost-1n:amount+101n,oldOutput);
            const record:any={mode:external?"direct-external":"direct-self",fault,oldOutput,...run,status:"failed"};trial.executions.push(record);
            if(fault!=="none")reverted(run.value);else{
              assert.equal(run.value.completion,"returned");assert.equal(run.value.data,"0x");const e=run.value.effects!;
              assert.equal(e.tokenDeltas?.length,6);assert.equal(e.nativeDeltas?.length,1);assert.equal(e.nativeDeltas![0].delta,0n);assert(same(e.nativeDeltas![0].account,executor));
              const expected=[[route.tokenIn,executor,-cost],[route.tokenOut,executor,external?0n:output],[route.tokenIn,owner,0n],[route.tokenOut,owner,external?output:0n],[d.gem,pocket,sell?amount:-output],[d.dai,TARGET,sell?-output:cost]] as const;
              for(const [t,a,delta] of expected){const rows=e.tokenDeltas!.filter(x=>same(x.token,t)&&same(x.account,a));assert.equal(rows.length,1);assert.equal(rows[0].delta,delta);}
              assert.equal(e.totalSupplyDeltas?.length,2);for(const t of [d.gem,d.dai]){const rows=e.totalSupplyDeltas!.filter(x=>same(x.token,t));assert.equal(rows.length,1);assert.equal(rows[0].delta,0n);}
              const transfers=e.logs!.filter(x=>same(x.topics[0],TOKEN.getEvent("Transfer")!.topicHash)).map(x=>({token:x.address,args:TOKEN.parseLog(x)!.args}));
              for(const [t,from,to,value] of [[route.tokenIn,executor,sell?pocket:TARGET,cost],[route.tokenOut,sell?TARGET:pocket,recipient,output]] as const){assert.equal(transfers.filter(x=>same(x.token,t)&&same(x.args.from,from)&&same(x.args.to,to)&&x.args.value===value).length,1);}
            }
            Object.assign(record,{status:fault==="none"?"pass":"correctly-rejected",rollbackEvidence:fault==="none"?undefined:"Trusted production MainRevert; effects omitted on rollback, no independent storageDiff claim"});
          }
          trial.status="pass";console.log(json({direction:route.direction,label,recipient,amountIn:amount,cost,refund:amount-cost,amountOut:output,status:trial.status}));
        }
        for(const amount of sell?[0n]:[0n,1n]){const run=await execute(runtimeProgramScript(ethers.getBytes(leg.program),amount),route,101n,103n);const record={kind:amount===0n?"zero-input":"no-whole-gem-output",direction:route.direction,recipient,amount,...run};report.roundTrips.push(record);reverted(run.value);}
      }
    }
    assert.equal(report.samples.length,20);assert(report.samples.every((s:any)=>s.status==="pass"));assert.equal(report.roundTrips.length,6);
    assert.equal(guard.counts.forbiddenDuringBuild,0);report.runtimeConstruction={rpc:0,exact:0,quotedFallback:false,scope:"real production issuer; selector throwing-stub coverage in shared dual suite"};report.result="same-N-psm-direct-budget-pass";
  }catch(e){report.error={stage,message:redact(e instanceof Error?e.stack:e)};process.exitCode=1;}
  finally{try{await finalPins?.();await simulation?.closeAndDrain();report.drained=true;}catch(e){report.finalError=redact(e);report.result="failed";process.exitCode=1;await simulation?.closeAndDrain().catch(()=>{});}
    clearTimeout(timer);report.directReads=reads;report.invocationCounts=guard.counts;writeFileSync(fd,redact(json(report))+"\n");closeSync(fd);console.log(json({result:report.result,error:report.error,samples:report.samples.length,out:args.get("--out")}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("invalid PSM recipient historical input; existing files preserved");process.exitCode=1;});
