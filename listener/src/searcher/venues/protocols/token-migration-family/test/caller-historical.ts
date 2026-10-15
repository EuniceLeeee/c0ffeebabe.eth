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
import { selectedSample, originalInputs } from "./caller-samples.js";
type Route = {routeKey:string;tokenIn:string;tokenOut:string;direction:string};
const ROOT=fileURLToPath(new URL("../../../../../../../",import.meta.url));
const TOKEN=new ethers.Interface(["function balanceOf(address) view returns(uint256)","event Transfer(address indexed from,address indexed to,uint256 value)"]);
const effects=["return-data","revert-data","token-delta","total-supply-delta","native-delta","logs"] as const;
const requirements={transports:["effect-delta-simulation"] as const,caller:"executor" as const,effects};
export function recipientContinuation(){return new RuntimeAmountProgram().constant(1,0n);}
async function main(){
  const names=["--ready","--sample","--rpc-file","--revm-bin","--out"],args=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2){assert(names.includes(process.argv[i]!)&&!args.has(process.argv[i]!)&&process.argv[i+1]);args.set(process.argv[i]!,process.argv[i+1]!);}
  assert(names.every(n=>args.has(n)));
  const sample=selectedSample(args.get("--sample")!),{family:FAMILY,tx:TX,number:N,hash:HASH,target:TARGET}=sample;
  const fd=openSync(args.get("--out")!,"wx",0o600),report:any={result:"failed",samples:[],zeroInputs:[],tx:TX,source:{number:N,hash:HASH},signing:false,broadcast:false,
    scope:"Current caller-only quoted and runtime execution; original transaction token quantities donate input only. No natural valuation, opportunity replay or performance claim."};
  const abort=new AbortController(),deadlineAtMs=Date.now()+600000,timer=setTimeout(()=>abort.abort(new Error("Caller-only deadline")),600000);
  const guard=constructionGuard();let reads=0,rpcUrl="",stage="inputs",simulation:ReturnType<typeof createRevmStrictSourceSimulation>|undefined;
  let finalPins:(()=>Promise<void>)|undefined;
  const redact=(s:unknown)=>String(s).split(rpcUrl||"\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]");
  try{
    const readyPath=realpathSync(args.get("--ready")!);
    const paths=[readyPath,resolve(dirname(readyPath),"receipt.json"),fileURLToPath(new URL("./caller-samples.js",import.meta.url)).replace(/\.js$/,".ts"),fileURLToPath(import.meta.url),realpathSync(args.get("--revm-bin")!)];
    const pins=()=>paths.map(path=>({path,sha256:sha(readFileSync(path))}));report.inputs=pins();report.code=sourcePin();report.revmSha256=sha(readFileSync(args.get("--revm-bin")!));
    const envelope=await new UniverseRebuildCheckpointStore({path:readyPath}).load();assert(envelope&&!envelope.inProgressRun);
    const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source=ready.cutoff;assert.equal(source.number,N);assert.equal(source.hash,HASH);
    const executor="0x1000000000000000000000000000000000000002",owner="0x1000000000000000000000000000000000000001";report.actors={executor,owner,scope:"isolated current executor/origin; not historical transaction sender"};
    const receipt=JSON.parse(readFileSync(paths[1]!,"utf8"));assertHistoricalDiscoveryReceipt(receipt,{transactionHash:TX,blockNumber:N,blockHash:HASH},source);const inputs=originalInputs(args.get("--sample")!,receipt);report.amountDonor={tx:TX,source:report.source,inputs,scope:"original token quantity only; smaller input is manual one-tenth, no prices altered"};
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
    const executorRuntimeCode=loadBotVmRuntimeCode(owner);
    report.executorArtifactSha256=sha(artifactBytes);report.executorCodeHash=executorRuntimeCode.keccak256;
    report.executorProvisioning=assertExecutorCode(await rpc("eth_getCode",[executor,pin]),executorRuntimeCode.code);assertOriginAccountCode(await rpc("eth_getCode",[owner,pin]));
    finalPins=async()=>{assert.deepEqual(pins(),report.inputs);assert.deepEqual(sourcePin(),report.code);assert.equal(sha(readFileSync(artifactPath)),report.executorArtifactSha256);assert.equal((await rpc("eth_getBlockByNumber",[ethers.toQuantity(N),false])).hash,HASH);};
    simulation=createRevmStrictSourceSimulation({identity:{source,rpcUrl,chainId:1,stateRoot:header.stateRoot},executorRuntimeCode,control:{signal:abort.signal,deadlineAtMs},executionGasLimit:0x1000000,
      createClient:({onFatal})=>{const c=new RevmSimClient({executablePath:args.get("--revm-bin")!,timeoutMs:90000,onFatal});const invoke=c.strictSimulate.bind(c);c.strictSimulate=async(...args)=>{const result=await invoke(...args);(report.rawStrict??=[]).push({stage,result});return result;};return c;},onFatal:()=>abort.abort(new Error("Caller-only simulation fatal"))});
    const runtime=createStrictCentralAdapterRuntime({simulator:simulation.transport,executor,transactionOrigin:owner,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);abort.signal.throwIfAborted();}},
      provider:{call:async({blockTag,...tx}:any,n:number)=>{assert.equal(blockTag??n,N);return rpc("eth_call",[tx,pin]);},getCode:async(a:string,n:number)=>{assert.equal(n,N);return rpc("eth_getCode",[a,pin]);},getStorage:async(a:string,slot:string,n:number)=>{assert.equal(n,N);return rpc("eth_getStorageAt",[a,slot,pin]);}} as never});
    const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:1",familyIds:[FAMILY],executionIdentity:{executor,transactionOrigin:owner}}),family=asPricedFamily(catalog.forStrictFamily(FAMILY));
    const memos=activeReadyMemos(envelope).filter(m=>m.familyId===FAMILY&&same(m.instanceKey,TARGET));assert.equal(memos.length,1);const memo=memos[0]!;assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
    const d:any=instance.descriptor;assert(same(d.target,TARGET));assert.equal(instance.routes.length,sample.routes);
    if(args.get("--sample")==="btb")assert.equal(d.variant,"btb-bear-v1");
    const asset=args.get("--sample")==="btb"?d.asset:d.tokenIn,outputToken=args.get("--sample")==="btb"?TARGET:d.tokenOut;
    assert(![asset,outputToken,TARGET].some(a=>same(a,executor)||same(a,owner)));assert(!same(asset,outputToken));
    const bindings=[];for(const address of [...new Set([TARGET,asset,outputToken])]){const code=await rpc("eth_getCode",[address,pin]);assert(code!=="0x");bindings.push({address,codeHash:ethers.keccak256(code)});if(same(address,TARGET))assert.equal(ethers.keccak256(code),d.codeHash);}
    report.admission={memoFingerprint:memo.memoFingerprint,familyDefinitionHash:memo.familyDefinitionHash,candidate:memo.candidateSnapshot,descriptor:d,bindings};
    const candidate:any=memo.candidateSnapshot;assertHistoricalDiscoveryReceipt(same(candidate.transactionHash,TX)?receipt:await rpc("eth_getTransactionReceipt",[candidate.transactionHash]),candidate,source);
    const routes=instance.routes as unknown as readonly Route[],handles=routes.map(r=>instance.routeHandles.find(h=>h.routeKey===r.routeKey)!);assert(handles.every(Boolean));
    const build=(index:number,settlement:any)=>guard.build(()=>buildFamilyRuntimeAmountLeg({family,route:handles[index],source,executor,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog,settlement}));
    const adapters=[...family.plugin.actionAdapters,...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile=(node:ResolvedPlanNode):Uint8Array=>{const adapter=adapters.find(a=>a.id===node.adapterId);assert(adapter);return adapter.encode(node,executor,concatBytes(...node.children.map(compile)));};
    const execute=async(script:Uint8Array,route:Route,inputBalance:bigint,oldOutput:bigint)=>{
      const caller={kind:"executor" as const};const request:AdapterRequest={id:"caller-only-execution",required:false,kind:"effect-delta-simulation",call:{caller,executionMode:"executor-program",to:executor,data:buildSubscriptCalldata(script)},
        overrideIntent:{caller,nativeBalanceWei:17n,tokenBalances:[{token:route.tokenIn,amount:inputBalance},{token:route.tokenOut,amount:oldOutput}]},
        observeTokenBalances:[route.tokenIn,route.tokenOut].flatMap(token=>[{token,account:caller},{token,account:owner}]).concat([{token:asset,account:TARGET},{token:outputToken,account:TARGET}]),observeTotalSupplies:[asset,outputToken],observe:effects};
      const outcome=await executeAdapterWork({runtime,control:{signal:abort.signal,deadlineAtMs},intent:{stage:"exact-refine",familyId:FAMILY,source,generation:source.generation,programInput:undefined,program:{requirements:()=>requirements,buildRequests:()=>[request],decode:({results}):readonly AdapterRequestResult[]=>results}}});
      assert.equal(outcome.status,"resolved");if(outcome.status!=="resolved")throw new Error("execution unresolved");const value=outcome.executed.evidence[0]!;assert(value.ok,"transport failure is not EVM rejection");assert.deepEqual(value.source,source);return {request,outcome,value};
    };
    const reverted=(value:AdapterRequestResult)=>{assert(value.ok);assert.equal(value.completion,"reverted-as-declared");assert.deepEqual(value.effects,{tokenDeltas:[],nativeDeltas:[],totalSupplyDeltas:[],logs:[]});};
    for(const [index,route] of routes.entries()){
      assert.equal(graph.filter(e=>e.instanceKey!==undefined&&same(e.instanceKey,TARGET)&&same(e.tokenIn,route.tokenIn)&&same(e.tokenOut,route.tokenOut)).length,1);
      const leg=build(index,undefined);assert(leg);assert.equal(leg.settlementRequest,undefined);assert.equal(leg.inputMode,undefined);
      for(const request of [{kind:"direct-output",recipient:owner},{kind:"quote-output",recipient:owner},{kind:"deferred-input",paymentAmount:1n,paymentProgram:ethers.hexlify(recipientContinuation().bytes())}])assert.equal(build(index,request),null);
      const donor=inputs[route.direction];assert(donor);const amounts=[donor.amount/10n,donor.amount];assert(amounts[0]!>0n&&amounts[0]!==amounts[1]);
      for(const amount of amounts){
        stage=`quote:${route.direction}:${amount}`;const trial:any={direction:route.direction,tokenIn:route.tokenIn,tokenOut:route.tokenOut,amountIn:amount,donor,status:"failed",executions:[]};report.samples.push(trial);
        const quote=await guard.exact(()=>executeFamilyExactQuote({family,route:handles[index]!,amountIn:amount,source,generation:source.generation,executor,runtimeEvidence:[],runtime,control:{signal:abort.signal,deadlineAtMs}}));trial.quote=quote;
        assert.equal(quote.status,"resolved");if(quote.status!=="resolved")throw new Error("Exact unresolved");assert.equal(quote.amountIn,amount);assert.deepEqual(quote.source,source);const output=quote.amountOut;assert(output>0n);
        if(args.get("--sample")==="migration")assert.equal(output,amount*d.numerator/d.denominator);else assert.equal(output,amount);
        const fragment=guard.quoted(()=>buildFamilyExecutionFragment({family,route:handles[index]!,exact:quote,minAmountOut:output,executor,runtimeEvidence:[],actionOwnership:catalog}));assert.equal(fragment.status,"resolved");if(fragment.status!=="resolved")throw new Error("quoted unresolved");
        const scripts:[string,Uint8Array][]=[["quoted",concatBytes(...planFragmentNodes(fragment.fragment,route.tokenIn,amount).map(compile))],["runtime",runtimeProgramScript(ethers.getBytes(leg.program),amount)]];
        for(const [mode,script]of scripts)for(const oldOutput of [0n,103n])for(const fault of ["none","insufficient-input","post-revert"]){
          stage=`${route.direction}:${mode}:${amount}:${fault}`;const post=recipientContinuation();if(fault==="post-revert")post.constant(1,1n).constant(2,0n).equal(1,2);
          const run=await execute(concatBytes(script,runtimeProgramScript(post.bytes(),0n)),route,fault==="insufficient-input"?amount-1n:amount+101n,oldOutput);
          const record:any={mode,oldOutput,fault,...run,status:"failed"};trial.executions.push(record);
          if(fault!=="none")reverted(run.value);else{
            assert.equal(run.value.completion,"returned");assert.equal(run.value.data,"0x");const e=run.value.effects!;
            const migration=route.direction==="migrate",mint=route.direction==="mint";
            const expected=[[route.tokenIn,executor,-amount],[route.tokenOut,executor,output],[route.tokenIn,owner,0n],[route.tokenOut,owner,0n],[asset,TARGET,migration||mint?amount:-output],[outputToken,TARGET,migration?-output:0n]] as const;
            assert.equal(e.tokenDeltas?.length,expected.length);
            for(const[t,a,delta]of expected){const rows=e.tokenDeltas!.filter(x=>same(x.token,t)&&same(x.account,a));assert.equal(rows.length,1);assert.equal(rows[0].delta,delta);}
            assert.equal(e.nativeDeltas?.length,1);assert.equal(e.nativeDeltas![0].delta,0n);assert(same(e.nativeDeltas![0].account,executor));
            assert.equal(e.totalSupplyDeltas?.length,2);for(const token of [asset,outputToken]){const rows=e.totalSupplyDeltas!.filter(x=>same(x.token,token));assert.equal(rows.length,1);assert.equal(rows[0].delta,migration||same(token,asset)?0n:mint?amount:-amount);}
            const transfers=e.logs!.filter(x=>same(x.topics[0],TOKEN.getEvent("Transfer")!.topicHash)).map(x=>({token:x.address,args:TOKEN.parseLog(x)!.args}));
            for(const[token,from,to,value]of [[route.tokenIn,executor,migration||mint?TARGET:ethers.ZeroAddress,amount],[route.tokenOut,mint?ethers.ZeroAddress:TARGET,executor,output]] as const){assert.equal(transfers.filter(x=>same(x.token,token)&&same(x.args.from,from)&&same(x.args.to,to)&&x.args.value===value).length,1);}
            const eventName=migration?"TokensMigrated":mint?"Minted":"Redeemed",events=e.logs!.filter(x=>same(x.address,TARGET)&&same(x.topics[0],sample.abi.getEvent(eventName)!.topicHash));assert.equal(events.length,1);
            const ev=sample.abi.parseLog(events[0]!)!.args;assert(same(ev[0],executor));assert.equal(ev[1],amount);assert.equal(ev[2],output);
            if(migration||mint){const approval=new ethers.Interface(["event Approval(address indexed owner,address indexed spender,uint256 value)"]);const rows=e.logs!.filter(x=>same(x.address,route.tokenIn)&&same(x.topics[0],approval.getEvent("Approval")!.topicHash)).map(x=>approval.parseLog(x)!.args).filter(x=>same(x.owner,executor)&&same(x.spender,TARGET));assert(rows.length>=2);assert.equal(rows[0].value,0n);assert(rows.some(x=>x.value===amount));assert.equal(rows.at(-1)!.value,0n);}
          }
          Object.assign(record,{status:fault==="none"?"pass":"correctly-rejected",rollbackEvidence:fault==="none"?undefined:"Trusted production MainRevert; effects omitted, not independent storageDiff. Forced post-revert is a consumer atomicity control."});
        }
        trial.status="pass";console.log(json({direction:route.direction,amountIn:amount,amountOut:output,status:"pass"}));
      }
      const zero=await execute(runtimeProgramScript(ethers.getBytes(leg.program),0n),route,101n,103n);report.zeroInputs.push({direction:route.direction,...zero});reverted(zero.value);
    }
    assert.equal(report.samples.length,sample.routes*2);assert(report.samples.every((s:any)=>s.status==="pass"));assert.equal(report.zeroInputs.length,sample.routes);
    assert.equal(guard.counts.forbiddenDuringBuild,0);report.runtimeConstruction={rpc:0,exact:0,quotedFallback:false,scope:"current production issuer"};report.result="same-N-caller-only-dual-pass";
  }catch(e){report.error={stage,message:redact(e instanceof Error?e.stack:e)};process.exitCode=1;}
  finally{try{await finalPins?.();await simulation?.closeAndDrain();report.drained=true;}catch(e){report.finalError=redact(e);report.result="failed";process.exitCode=1;await simulation?.closeAndDrain().catch(()=>{});}
    clearTimeout(timer);report.directReads=reads;report.invocationCounts=guard.counts;writeFileSync(fd,redact(json(report))+"\n");closeSync(fd);console.log(json({result:report.result,error:report.error,samples:report.samples.length,out:args.get("--out")}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("invalid caller-only historical input; existing files preserved");process.exitCode=1;});
