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
import { ABI, quoteRequest } from "../codec.js";
import { assertChainQuoteRevert, rpcResult, quoteBoundaryRequirements } from "./evidence.js";
import { decodeSwapLog } from "../discovery.js";
import type { Descriptor, Route } from "../types.js";
const fixtures=JSON.parse(readFileSync(new URL("./historical-fixtures.json",import.meta.url),"utf8"));
const ROOT=fileURLToPath(new URL("../../../../../../../",import.meta.url));
const ERC20=new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const effects=["return-data","revert-data","token-delta","total-supply-delta","native-delta","logs"] as const;
const requirements={transports:["effect-delta-simulation"] as const,caller:"executor" as const,effects};
function observed(e:ObservedEffects|undefined,d:Descriptor,route:Route,actor:string,value:bigint,expected:bigint,receiver=actor){
  assert.equal(e?.tokenDeltas?.length,same(receiver,actor)?4:6);assert.equal(e?.nativeDeltas?.length,1);assert.equal(e?.totalSupplyDeltas?.length,2);
  for(const [token,account,delta] of [[route.tokenIn,actor,-value],[route.tokenIn,d.order.maker,value],[route.tokenOut,receiver,expected],[route.tokenOut,d.order.maker,-expected],...(same(receiver,actor)?[]:[[route.tokenIn,receiver,0n],[route.tokenOut,actor,0n]])] as [string,string,bigint][]){
    const rows:NonNullable<ObservedEffects["tokenDeltas"]>=e!.tokenDeltas!.filter(r=>same(r.token,token)&&same(r.account,account));assert.equal(rows.length,1);assert.equal(rows[0].delta,delta);
  }
  assert(same(e!.nativeDeltas![0].account,actor));assert.equal(e!.nativeDeltas![0].delta,0n);
  for(const token of d.tokens){const rows:NonNullable<ObservedEffects["totalSupplyDeltas"]>=e!.totalSupplyDeltas!.filter(r=>same(r.token,token));assert.equal(rows.length,1);assert.equal(rows[0].delta,0n);}
  const logs=e!.logs!.filter(l=>same(l.address,d.router)).map(decodeSwapLog).filter(x=>x!==null);assert.equal(logs.length,1);
  assert.equal(logs[0].tokenIn,route.tokenIn);assert.equal(logs[0].tokenOut,route.tokenOut);assert.equal(logs[0].taker,actor.toLowerCase());assert.equal(logs[0].orderHash,d.strategyHash);assert.equal(logs[0].maker,d.order.maker);assert.equal(logs[0].amountIn,value);assert.equal(logs[0].amountOut,expected);
}
async function main(){
  const names=["--ready","--prices","--evidence-dir","--rpc-file","--revm-bin","--out","--sample"],args=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2){assert([...names,"--resume","--settlement-checks"].includes(process.argv[i]!)&&!args.has(process.argv[i]!)&&process.argv[i+1]);args.set(process.argv[i]!,process.argv[i+1]!);}
  assert(names.every(n=>args.has(n)));
  assert(!args.has("--settlement-checks")||["0","1"].includes(args.get("--settlement-checks")!));
  const settlementChecks=args.get("--settlement-checks")==="1";
  const sample=fixtures.samples.find((s:any)=>s.transactionHash.toLowerCase()===args.get("--sample")!.toLowerCase());assert(sample);
  const N=sample.blockNumber,HASH=sample.blockHash,TX=sample.transactionHash;
  const fd=openSync(args.get("--out")!,"wx",0o600),report:any={result:"failed",samples:[],roundTrips:[],settlementChecks:[],tx:TX,source:{number:N,hash:HASH},signing:false,broadcast:false,
    scope:"One reverse-registered Aqua strategy, both directions, same N-end quote and execution; production inputs unchanged. Small diagnostic inputs derive only from registered reserves and are not original swap amounts. No credential or maker overrides, no original opportunity or performance verdict."};
  const abort=new AbortController(),deadlineAtMs=Date.now()+600000,timer=setTimeout(()=>abort.abort(new Error("Aqua acceptance deadline")),600000);
  const guard=constructionGuard();let reads=0,rpcUrl="",stage="inputs",simulation:ReturnType<typeof createRevmStrictSourceSimulation>|undefined;
  let finalPins:(()=>Promise<void>)|undefined;
  const redact=(s:unknown)=>String(s).split(rpcUrl||"\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]");
  try{
    const readyPath=realpathSync(args.get("--ready")!),pricePath=realpathSync(args.get("--prices")!), evidenceDir=realpathSync(args.get("--evidence-dir")!);
    const paths=[readyPath,pricePath,resolve(dirname(pricePath),"input.json"),resolve(evidenceDir,"receipt.json"),fileURLToPath(new URL("./historical-fixtures.json",import.meta.url)),fileURLToPath(import.meta.url),fileURLToPath(new URL("./evidence.ts",import.meta.url)),...(args.has("--resume")?[realpathSync(args.get("--resume")!)]:[])];
    const pins=()=>paths.map(path=>({path,sha256:sha(readFileSync(path))}));report.inputs=pins();report.code=sourcePin();report.revmSha256=sha(readFileSync(args.get("--revm-bin")!));
    const prices=parseAtBlockJson(readFileSync(pricePath,"utf8")),provenance=parseAtBlockJson(readFileSync(paths[2]!,"utf8"));
    const envelope=await new UniverseRebuildCheckpointStore({path:readyPath}).load();assert(envelope&&!envelope.inProgressRun);
    const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source=ready.cutoff;assert.equal(source.number,N);assert.equal(source.hash,HASH);
    assertPriceInput(prices,provenance,ready,{readySha256:report.inputs[0].sha256,sourceTreeSha256:report.code.sourceTreeSha256,number:N});
    assert.equal(provenance.implementation.revmBinarySha256,report.revmSha256);
    const executor=ethers.getAddress(provenance.executor),owner=ethers.getAddress(provenance.owner);assert(!same(executor,owner));report.actors={executor,owner};
    const receipt=JSON.parse(readFileSync(paths[3]!,"utf8"));assertHistoricalDiscoveryReceipt(receipt,{transactionHash:TX,blockNumber:N,blockHash:HASH},source);
    rpcUrl=JSON.parse(readFileSync(args.get("--rpc-file")!,"utf8")).MAINNET_RPC_URL;assert(/^https?:\/\//.test(rpcUrl));
    const pin={blockHash:HASH,requireCanonical:true};
    const rpc=async(method:string,params:unknown[]):Promise<any>=>{
      guard.check();abort.signal.throwIfAborted();const id=++reads;assert(id<=600);
      assert(["eth_chainId","eth_getBlockByNumber","eth_getCode","eth_call","eth_getStorageAt","eth_getTransactionReceipt"].includes(method));
      const res=await fetch(rpcUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(25000)])});
      assert(res.ok,`HTTP ${res.status}`);return rpcResult(method,id,await res.json());
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
      createClient:({onFatal})=>new RevmSimClient({executablePath:args.get("--revm-bin")!,timeoutMs:90000,onFatal}),onFatal:()=>abort.abort(new Error("Aqua simulation fatal"))});
    const runtime=createStrictCentralAdapterRuntime({simulator:simulation.transport,executor,transactionOrigin:owner,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);abort.signal.throwIfAborted();}},
      provider:{call:async({blockTag,...tx}:any,n:number)=>{assert.equal(blockTag??n,N);return rpc("eth_call",[tx,pin]);},getCode:async(a:string,n:number)=>{assert.equal(n,N);return rpc("eth_getCode",[a,pin]);},getStorage:async(a:string,slot:string,n:number)=>{assert.equal(n,N);return rpc("eth_getStorageAt",[a,slot,pin]);}} as never});
    const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:1",familyIds:[FAMILY],executionIdentity:{executor,transactionOrigin:owner}}),family=asPricedFamily(catalog.forStrictFamily(FAMILY));
    const adapters=[...family.plugin.actionAdapters,...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile=(n:ResolvedPlanNode):Uint8Array=>{const a=adapters.find(a=>a.id===n.adapterId);assert(a);return a.encode(n,executor,concatBytes(...n.children.map(compile)));};
    const previous=args.has("--resume")?JSON.parse(readFileSync(args.get("--resume")!,"utf8")):null;
    if(previous){
      assert(previous.drained&&!previous.finalError,"prior simulation must be drained and final pins valid");
      for(const key of ["tx","source","code","revmSha256","actors","executorArtifactSha256","executorCodeHash"])
        assert.deepEqual(previous[key],report[key],`resume mismatch: ${key}`);
      assert.deepEqual(previous.inputs.slice(0,5),report.inputs.slice(0,5),"resume historical inputs changed");
      report.resume={path:paths.at(-1),sha256:report.inputs.at(-1).sha256,previousResult:previous.result,previousError:previous.error,
        previousInputs:previous.inputs,reused:[],note:"Prior failures retained in original report; only validated positive samples reused."};
    }
    report.registration={transactionHash:TX,strategyHash:sample.strategyHash,order:sample.order,tokens:sample.tokens,originalSwapAmount:false};
    const memos=activeReadyMemos(envelope).filter(m=>m.familyId===FAMILY&&m.instanceKey.includes(sample.strategyHash));assert.equal(memos.length,1);
    const memo=memos[0];assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
    const d=instance.descriptor as Descriptor;assert.equal(d.strategyHash,sample.strategyHash);assert(same(d.order.maker,sample.order.maker));assert.equal(instance.routes.length,2);
    report.admission={instanceKey:d.instanceKey,memoFingerprint:memo.memoFingerprint,familyDefinitionHash:memo.familyDefinitionHash,candidate:memo.candidateSnapshot};
    const routes=instance.routes as readonly Route[],handles=routes.map(r=>instance.routeHandles.find(h=>h.routeKey===r.routeKey)!);assert(handles.every(Boolean));
    const legs=handles.map(route=>{const leg=guard.build(()=>buildFamilyRuntimeAmountLeg({family,route,source,executor,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog}));assert(leg,"quoted fallback prohibited");return leg;});
    const execute=async(script:Uint8Array,route:Route,amount:bigint,missing=false,receiver=executor)=>{
      const caller={kind:"executor" as const};const request:AdapterRequest={id:"aqua-execution",required:false,kind:"effect-delta-simulation",call:{caller,executionMode:"executor-program",to:executor,data:buildSubscriptCalldata(script)},
        overrideIntent:{caller,nativeBalanceWei:17n,tokenBalances:[{token:route.tokenIn,amount:missing?(amount>101n?101n:0n):amount+101n},{token:route.tokenOut,amount:103n}]},
        observeTokenBalances:[route.tokenIn,route.tokenOut].flatMap(token=>[{token,account:caller},{token,account:d.order.maker},...(same(receiver,executor)?[]:[{token,account:receiver}])]),observeTotalSupplies:[...d.tokens],observe:effects};
      const outcome=await executeAdapterWork({runtime,control:{signal:abort.signal,deadlineAtMs},intent:{stage:"exact-refine",familyId:FAMILY,source,generation:source.generation,programInput:undefined,program:{requirements:()=>requirements,buildRequests:()=>[request],decode:({results}):readonly AdapterRequestResult[]=>results}}});
      assert.equal(outcome.status,"resolved");if(outcome.status!=="resolved")throw new Error("execution unresolved");const value=outcome.executed.evidence[0];assert(value.ok,"transport failure is not EVM rejection");assert.deepEqual(value.source,source);return {request,outcome,value};
    };
    const reverted=(value:AdapterRequestResult)=>{assert(value.ok);assert.equal(value.completion,"reverted-as-declared");assert.deepEqual(value.effects,{tokenDeltas:[],nativeDeltas:[],totalSupplyDeltas:[],logs:[]});};
    report.naturalRows=[];
    for(const [index,route] of routes.entries()){
      const edges=graph.filter(e=>e.instanceKey===d.instanceKey&&same(e.tokenIn,route.tokenIn)&&same(e.tokenOut,route.tokenOut));assert.equal(edges.length,1);
      const key=blockScanEdgeKey(edges[0]),row=prices.runtime.pricing.effectiveMids.rows.get(key),raw=prices.runtime.pricing.mids.get(key);assert(raw?.mid>0);assert(row);report.naturalRows.push({key,raw,effective:row});
      const stateIndex=sample.tokens.findIndex((t:string)=>same(t,route.tokenIn));assert(stateIndex>=0);
      const reserve=BigInt(sample.states[stateIndex].raw.values[0]),diagnostic=reserve/100n;assert(diagnostic>0n);
      const trials=[{label:"manual-registration-reserve-hundredth",amount:diagnostic,required:true},
        {label:"manual-double-registration-reserve-hundredth",amount:diagnostic*2n,required:true}];
      // A failed valuation is disclosed; it never changes the production table.
      if(typeof row.amountIn==="bigint")trials.push({label:"production-effective",amount:row.amountIn,required:row.status==="quoted"},
        {label:"double-production-effective",amount:row.amountIn*2n,required:false});
      trials.push({label:"one-raw-unit-boundary",amount:1n,required:false},{label:"zero-input-boundary",amount:0n,required:false});
      for(const {label,amount,required} of trials){
        const prior=previous?.samples.find((s:any)=>s.direction===index&&s.label===label&&s.amountIn===amount.toString()&&s.status==="same-N-dual-pass");
        if(prior){
          assert.equal(prior.quote.status,"resolved");assert(prior.executions.every((e:any)=>e.status==="pass"));
          for(const encoding of ["quoted","runtime"])assert(prior.executions.some((e:any)=>e.encoding===encoding&&e.negative==="none"&&e.value?.completion==="returned"));
          report.samples.push({...prior,reusedFrom:report.resume.path});report.resume.reused.push({direction:index,label,amountIn:amount});
          if(label==="manual-registration-reserve-hundredth"){
            const trip=previous.roundTrips.find((t:any)=>t.direction===index&&t.amountIn===amount.toString()&&t.status==="pass");assert(trip);
            report.roundTrips.push({...trip,reusedFrom:report.resume.path});
          }
          continue;
        }
        stage=`quote:${route.tokenIn}:${label}`;const trial:any={direction:index,tokenIn:route.tokenIn,tokenOut:route.tokenOut,label,amountIn:amount,expected:required?"positive-full-input":"same-N-quote-execution-agreement",status:"failed",executions:[]};report.samples.push(trial);
        const quote=await guard.exact(()=>executeFamilyExactQuote({family,route:handles[index],amountIn:amount,source,generation:source.generation,executor,runtimeEvidence:[],runtime,control:{signal:abort.signal,deadlineAtMs}}));trial.quote=quote;
        const runtimeScript=runtimeProgramScript(ethers.getBytes(legs[index].program),amount);
        if(quote.status!=="resolved"){
          assert.equal(required,false,"a required supported amount must quote");
          // Keep the issuer's failed/unresolved outcome intact. Only a separate
          // successful transport carrying a declared chain revert proves a state
          // rejection; timeouts/authority/decode failures cannot pass this gate.
          const raw=quoteRequest(d,route.i,amount,"independent-quote-boundary");assert(raw.kind==="eth-call");
          const request:AdapterRequest={...raw,required:false,completion:"return-or-revert-data"};
          const checked=await executeAdapterWork({runtime,control:{signal:abort.signal,deadlineAtMs},intent:{stage:"exact-refine",familyId:FAMILY,source,generation:source.generation,programInput:undefined,
            program:{requirements:()=>quoteBoundaryRequirements,buildRequests:()=>[request],decode:({results}):readonly AdapterRequestResult[]=>results}}});
          trial.independentQuoteBoundary={request,outcome:checked};assert.equal(checked.status,"resolved");if(checked.status!=="resolved")throw Error("unresolved independent quote boundary");
          assertChainQuoteRevert(checked.executed.evidence[0]);assert.deepEqual(checked.executed.evidence[0].source,source);
          const run=await execute(runtimeScript,route,amount);reverted(run.value);trial.executions.push({encoding:"runtime",negative:"independent-chain-quote-revert-same-input",...run,status:"pass"});
          trial.status="same-N-chain-quote-and-execution-rejected";
          console.log(json({label,tokenIn:route.tokenIn,amountIn:amount,status:trial.status}));continue;
        }
        if(amount===0n){assert.equal(quote.amountOut,0n);const run=await execute(runtimeScript,route,amount);reverted(run.value);trial.executions.push({encoding:"runtime",negative:"zero-input",...run,status:"pass"});trial.status="zero-input-no-execution";continue;}
        assert.equal(quote.amountIn,amount);assert(quote.amountOut>0n);assert.deepEqual(quote.source,source);
        if(label==="production-effective"){assert.equal(row.status,"quoted");assert.equal(quote.amountOut,row.amountOut);}
        const fragment=guard.quoted(()=>buildFamilyExecutionFragment({family,route:handles[index],exact:quote,minAmountOut:quote.amountOut,executor,runtimeEvidence:[],actionOwnership:catalog}));assert.equal(fragment.status,"resolved");if(fragment.status!=="resolved")throw new Error("fragment unresolved");
        const nodes=planFragmentNodes(fragment.fragment,route.tokenIn,amount),quoted=concatBytes(...nodes.map(compile));
        const scripts:[string,Uint8Array][]=[["quoted",quoted],["runtime",runtimeScript],["quoted-minimum-plus-one",concatBytes(...nodes.map(n=>compile({...n,params:{...n.params,minAmountOut:quote.amountOut+1n}})))]];
        for(const [encoding,script] of scripts.filter(([encoding])=>label==="manual-registration-reserve-hundredth"||encoding!=="quoted-minimum-plus-one"))for(const negative of encoding==="quoted-minimum-plus-one"?["minimum-output-plus-one"]:label==="manual-registration-reserve-hundredth"?["none","insufficient-total-input","post-execution-revert"]:["none"]){
          const executed=negative==="post-execution-revert"?concatBytes(script,runtimeProgramScript(new RuntimeAmountProgram().constant(1,0n).constant(2,1n).equal(1,2).bytes(),0n)):script;
          const run=await execute(executed,route,amount,negative==="insufficient-total-input");
          if(negative==="none"){assert.equal(run.value.completion,"returned");assert.equal(run.value.data,"0x");observed(run.value.effects,d,route,executor,amount,quote.amountOut);}
          else reverted(run.value);
          trial.executions.push({encoding,negative,...run,status:"pass"});
        }
        if(settlementChecks&&label==="manual-registration-reserve-hundredth"){
          for(const request of [{kind:"quote-output" as const},{kind:"direct-output" as const,recipient:owner}]){
            const leg=guard.build(()=>buildFamilyRuntimeAmountLeg({family,route:handles[index],source,executor,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog,settlement:request}));
            assert(leg);assert.deepEqual(leg.settlementRequest,request);
            const script=request.kind==="quote-output"?runtimeProgramScript(new RuntimeAmountProgram().run(leg.program,0,1,true).constant(2,quote.amountOut).equal(1,2).bytes(),amount):runtimeProgramScript(ethers.getBytes(leg.program),amount);
            const run=await execute(script,route,amount,false,request.kind==="direct-output"?owner:executor);
            assert.equal(run.value.completion,"returned");
            if(request.kind==="direct-output")observed(run.value.effects,d,route,executor,amount,quote.amountOut,owner);
            else {assert.equal(run.value.effects?.tokenDeltas?.length,4);for(const delta of run.value.effects!.tokenDeltas!)assert.equal(delta.delta,0n);for(const delta of run.value.effects!.nativeDeltas!)assert.equal(delta.delta,0n);for(const delta of run.value.effects!.totalSupplyDeltas!)assert.equal(delta.delta,0n);assert.equal(run.value.effects!.logs!.length,0);}
            report.settlementChecks.push({direction:index,kind:request.kind,amountIn:amount,expectedOutput:quote.amountOut,request,...run,status:"same-N-actual-pass"});
          }
        }
        // Keep the shared final repayment minimum at the entire starting
        // amount. A fee-paying Aqua round trip must not spend old inventory
        // to conceal its loss and must fail atomically.
        if(label==="manual-registration-reserve-hundredth"){
        const flow:ResolvedPlanNode={adapterId:"runtime-amount-flow",target:executor,tokenIn:route.tokenIn,tokenOut:route.tokenIn,amount,children:[],params:{minimumReturn:amount,quoteToleranceRawUnits:0n,
          legs:JSON.stringify([index,1-index].map(i=>({tokenIn:routes[i].tokenIn,tokenOut:routes[i].tokenOut,program:legs[i].program})))}};
        const flowRun=await execute(runtimeAmountFlowAdapter.encode(flow,executor,new Uint8Array()),route,amount);reverted(flowRun.value);
        report.roundTrips.push({label,direction:index,amountIn:amount,minimumReturn:amount,expected:"fee-or-rounding-loss-closed-loop-rejection",...flowRun,status:"pass"});
        }
        trial.status="same-N-dual-pass";console.log(json({label,tokenIn:route.tokenIn,amountIn:amount,amountOut:quote.amountOut,status:trial.status}));
      }
    }
    assert(report.samples.length>=8);assert(report.samples.every((s:any)=>s.status!=="failed"));
    assert(report.samples.some((s:any)=>s.label==="manual-registration-reserve-hundredth"&&s.status==="same-N-dual-pass"));
    assert.equal(guard.counts.forbiddenDuringBuild,0);report.runtimeConstruction={rpc:0,exact:0,quotedFallback:false,scope:"real production issuer; live selector throwing-stub regression remains in shared family-dual suite"};
    if(settlementChecks){assert.equal(report.settlementChecks.length,4);report.settlementScope="Both directions: on-EVM static quote equals same-state Exact; separate output recipient actual debit/receipt. Output-first callback is not exercised by these supplemental checks.";}
    report.result="same-N-dual-and-state-rejections-recorded";
  }catch(e){report.error={stage,message:redact(e instanceof Error?e.stack:e)};process.exitCode=1;}
  finally{try{await finalPins?.();await simulation?.closeAndDrain();report.drained=true;}catch(e){report.finalError=redact(e);report.result="failed";process.exitCode=1;await simulation?.closeAndDrain().catch(()=>{});}
    clearTimeout(timer);report.directReads=reads;report.invocationCounts=guard.counts;writeFileSync(fd,redact(json(report))+"\n");closeSync(fd);console.log(json({result:report.result,error:report.error,samples:report.samples.length,out:args.get("--out")}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("invalid Aqua historical dual input; existing files preserved");process.exitCode=1;});
