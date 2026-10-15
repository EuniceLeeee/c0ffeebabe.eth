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
import { assertRecipientEvent, savedExecutionReplay } from "./standard-recipient-observations.js";
import { createInsufficientFork, restoreSavedEffects } from "./standard-insufficient-evidence.js";
import { ERC4626_FAMILY_ID as FAMILY } from "../manifest.js";
const ABI=new ethers.Interface(["function previewDeposit(uint256) view returns(uint256)","function previewRedeem(uint256) view returns(uint256)"]);
const IMPLEMENTATION_SLOT="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT="0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
import { ERC4626_INTERFACE as EVENTS } from "../abi.js";
import type { Erc4626Descriptor as Descriptor, Erc4626Route as Route } from "../types.js";
const ROOT=fileURLToPath(new URL("../../../../../../../",import.meta.url));
const TOKEN=new ethers.Interface(["function balanceOf(address) view returns(uint256)","event Transfer(address indexed from,address indexed to,uint256 value)"]);
const effects=["return-data","revert-data","token-delta","total-supply-delta","native-delta","logs"] as const;
const requirements={transports:["effect-delta-simulation"] as const,caller:"executor" as const,effects};
export function recipientContinuation(){return new RuntimeAmountProgram().constant(1,0n);}
async function main(){
  const names=["--ready","--plan","--rpc-file","--revm-bin","--out"],args=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2){assert([...names,"--port","--resume-evidence"].includes(process.argv[i]!)&&!args.has(process.argv[i]!)&&process.argv[i+1]);args.set(process.argv[i]!,process.argv[i+1]!);}
  assert(names.every(n=>args.has(n)));
  const planPath=realpathSync(args.get("--plan")!),plan=JSON.parse(readFileSync(planPath,"utf8"));
  const TARGET=ethers.getAddress(plan.target),N=plan.candidate.blockNumber,HASH=plan.candidate.blockHash,TX=plan.candidate.transactionHash;
  assert(Number.isSafeInteger(N)&&N>0&&ethers.isHexString(HASH,32)&&ethers.isHexString(TX,32));
  const port=Number(args.get("--port")??"18965");assert(Number.isInteger(port)&&port>=1024&&port<=65535);
  const fd=openSync(args.get("--out")!,"wx",0o600),report:any={result:"failed",samples:[],roundTrips:[],tx:TX,source:{number:N,hash:HASH},signing:false,broadcast:false,
    scope:"Current standard ERC4626 quoted/default runtime and direct self/external receiver execution. Original real candidate event supplies assets/shares as input only; current production identity and output are independently obtained at this candidate block. Old Ready cutoff may differ. No natural valuation, opportunity or performance claim."};
  const abort=new AbortController(),deadlineAtMs=Date.now()+600000,timer=setTimeout(()=>abort.abort(new Error("standard ERC4626 recipient deadline")),600000);
  const guard=constructionGuard();let reads=0,rpcUrl="",stage="inputs",simulation:ReturnType<typeof createRevmStrictSourceSimulation>|undefined;
  let fork:Awaited<ReturnType<typeof createInsufficientFork>>|undefined;
  let finalPins:(()=>Promise<void>)|undefined;
  const redact=(s:unknown)=>String(s).split(rpcUrl||"\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]");
  try{
    const readyPath=realpathSync(args.get("--ready")!);
    const paths=[readyPath,planPath,fileURLToPath(import.meta.url),realpathSync(args.get("--revm-bin")!),fileURLToPath(new URL("./standard-recipient-observations.ts",import.meta.url)),fileURLToPath(new URL("./standard-insufficient-evidence.ts",import.meta.url)),...(args.has("--resume-evidence")?[realpathSync(args.get("--resume-evidence")!)]:[])];
    const pins=()=>paths.map(path=>({path,sha256:sha(readFileSync(path))}));report.inputs=pins();report.code=sourcePin();report.revmSha256=sha(readFileSync(args.get("--revm-bin")!));
    const prior=args.has("--resume-evidence")?JSON.parse(readFileSync(args.get("--resume-evidence")!,"utf8")):undefined;
    if(prior){assert(prior.drained&&prior.code.sourceTreeSha256===report.code.sourceTreeSha256);assert.equal(prior.result,"failed");const legacy=prior.inputs.some((x:any)=>x.path.endsWith("/standard-recipient-historical.ts")&&x.sha256==="325b8658c9a01107688665eefdfe38be443f3255dd8c6af8058087679b786cbd");if(legacy){assert.equal(prior.samples.length,1);assert.equal(prior.samples[0].executions.length,1);assert.equal(prior.samples[0].executions[0].status,"pass");}else assert(prior.inputs.some((x:any)=>x.path.endsWith("/standard-recipient-historical.ts")&&x.sha256==="f38c967b783c412de6c3136c483ff5eaf1bd02fe97c802f6a7796b2e83ed018a"));assert.equal(prior.source.number,N);assert.equal(prior.source.hash,HASH);assert.equal(prior.tx,TX);report.resume={file:args.get("--resume-evidence"),sha256:sha(readFileSync(args.get("--resume-evidence")!)),scope:"current construction must match old request byte-for-byte; no old positive or resource-limited strict call repeated"};}
    const saved=prior?.inputs.some((x:any)=>x.path.endsWith("/standard-recipient-historical.ts")&&x.sha256==="f38c967b783c412de6c3136c483ff5eaf1bd02fe97c802f6a7796b2e83ed018a")?savedExecutionReplay(prior):undefined;
    if(saved){
      assert.equal(prior.code.harnessSha256,report.code.harnessSha256);assert.deepEqual(prior.code.observationHelpers,report.code.observationHelpers);
      if(prior.code.evidenceSha256!==report.code.evidenceSha256){assert.equal(prior.code.evidenceSha256,"21667eebf6b97b6e18ad9ec4230d615a1d8e46478fcd8fc19339f01ec9c800f4");assert.equal(report.code.evidenceSha256,"beb18634cce1c9c46bc9590a9d8038e5256caa5a5d9d91e2bd10512c8ffbea34");report.resume.observerCompatibility="Only xWin explicit input-only flag labels added; ERC4626 request, quote and execution observers unchanged. Prior hashes retained.";}
    }
    const envelope=await new UniverseRebuildCheckpointStore({path:readyPath}).load();assert(envelope&&!envelope.inProgressRun);
    const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source=ready.cutoff;assert.equal(source.number,N);assert.equal(source.hash,HASH);
    report.amountDonor={path:planPath,sha256:sha(readFileSync(planPath)),originalReady:plan.priorReady,originalReadySha256:plan.priorReadySha256,originalCutoff:plan.source,scope:"real candidate event assets/shares input only; not target natural valuation"};
    const executor="0x1000000000000000000000000000000000000002",owner="0x1000000000000000000000000000000000000001";report.actors={executor,owner,scope:"isolated current executor/origin; not historical transaction sender"};if(prior){assert.equal(prior.actors.executor,executor);assert.equal(prior.actors.owner,owner);}
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
    report.executorArtifactSha256=sha(artifactBytes);report.executorCodeHash=executorRuntimeCode.keccak256;if(prior){assert.equal(prior.executorArtifactSha256,report.executorArtifactSha256);assert.equal(prior.executorCodeHash,report.executorCodeHash);}
    report.executorProvisioning=assertExecutorCode(await rpc("eth_getCode",[executor,pin]),executorRuntimeCode.code);assertOriginAccountCode(await rpc("eth_getCode",[owner,pin]));
    finalPins=async()=>{assert.deepEqual(pins(),report.inputs);assert.deepEqual(sourcePin(),report.code);assert.equal(sha(readFileSync(artifactPath)),report.executorArtifactSha256);assert.equal((await rpc("eth_getBlockByNumber",[ethers.toQuantity(N),false])).hash,HASH);};
    simulation=createRevmStrictSourceSimulation({identity:{source,rpcUrl,chainId:1,stateRoot:header.stateRoot},executorRuntimeCode,control:{signal:abort.signal,deadlineAtMs},executionGasLimit:0x1000000,
      createClient:({onFatal})=>{const c=new RevmSimClient({executablePath:args.get("--revm-bin")!,timeoutMs:90000,onFatal});const invoke=c.strictSimulate.bind(c);c.strictSimulate=async(...args)=>{const result=await invoke(...args);(report.rawStrict??=[]).push({stage,result});return result;};return c;},onFatal:()=>abort.abort(new Error("standard ERC4626 recipient simulation fatal"))});
    const runtime=createStrictCentralAdapterRuntime({simulator:simulation.transport,executor,transactionOrigin:owner,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);abort.signal.throwIfAborted();}},
      provider:{call:async({blockTag,...tx}:any,n:number)=>{assert.equal(blockTag??n,N);return rpc("eth_call",[tx,pin]);},getCode:async(a:string,n:number)=>{assert.equal(n,N);return rpc("eth_getCode",[a,pin]);},getStorage:async(a:string,slot:string,n:number)=>{assert.equal(n,N);return rpc("eth_getStorageAt",[a,slot,pin]);}} as never});
    const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:1",familyIds:[FAMILY],executionIdentity:{executor,transactionOrigin:owner}}),family=asPricedFamily(catalog.forStrictFamily(FAMILY));
    const memos=activeReadyMemos(envelope).filter(m=>m.familyId===FAMILY&&same(m.instanceKey,TARGET));assert.equal(memos.length,1);const memo=memos[0]!;assert(wiring.isReadyMemoDefinitionCurrent?.(memo));
    const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
    const d=instance.descriptor as Descriptor;assert(same(d.vault,TARGET)&&!d.custodian&&!d.infinifi);assert(same(d.share,TARGET));assert(instance.routes.length>0);
    assert(new Set([executor,owner,TARGET,d.asset].map(x=>x.toLowerCase())).size===4);
    const bindings=[];const bind=async(role:string,address:string)=>{const code=await rpc("eth_getCode",[address,pin]);assert(code!=="0x");bindings.push({role,address,codeHash:ethers.keccak256(code),code});};
    for(const [role,address]of [["vault",TARGET],["asset",d.asset]]as const)await bind(role,address);
    const proxySlots=[];for(const [role,slot]of [["implementation",IMPLEMENTATION_SLOT],["beacon",BEACON_SLOT]]as const){const word=await rpc("eth_getStorageAt",[TARGET,slot,pin]);proxySlots.push({role,slot,word});if(BigInt(word)!==0n){assert(BigInt(word)<(1n<<160n));await bind(role,ethers.getAddress("0x"+word.slice(-40)));}}
    const beacon=proxySlots.find(x=>x.role==="beacon");
    if(beacon&&BigInt(beacon.word)!==0n){const beaconAddress=ethers.getAddress("0x"+beacon.word.slice(-40));const data=await rpc("eth_call",[{to:beaconAddress,data:"0x5c60da1b"},pin]);assert(ethers.dataLength(data)===32&&BigInt(data)>0n&&BigInt(data)<(1n<<160n));await bind("beacon-implementation",ethers.getAddress("0x"+data.slice(-40)));}
    report.admission={memoFingerprint:memo.memoFingerprint,familyDefinitionHash:memo.familyDefinitionHash,candidate:memo.candidateSnapshot,descriptor:d,proxySlots,bindings};
    const receipt=await rpc("eth_getTransactionReceipt",[TX]);assertHistoricalDiscoveryReceipt(receipt,{transactionHash:TX,blockNumber:N,blockHash:HASH},source);
    const nominated=receipt.logs.filter((x:any)=>Number(BigInt(x.logIndex))===plan.candidate.logIndex&&same(x.address,TARGET));assert.equal(nominated.length,1);
    const nominatedEvent=EVENTS.parseLog(nominated[0]);assert(nominatedEvent&&["Deposit","Withdraw"].includes(nominatedEvent.name));
    assert(nominatedEvent.args.assets>0n&&nominatedEvent.args.shares>0n);
    report.originalEvent={transactionHash:TX,blockNumber:N,blockHash:HASH,log:nominated[0],event:nominatedEvent.name,assets:nominatedEvent.args.assets,shares:nominatedEvent.args.shares,claim:"input denomination only; original output is never borrowed as current quote or receipt"};
    const candidate:any=memo.candidateSnapshot;assertHistoricalDiscoveryReceipt(same(candidate.transactionHash,TX)?receipt:await rpc("eth_getTransactionReceipt",[candidate.transactionHash]),candidate,source);
    const routes=instance.routes as readonly Route[],handles=routes.map(r=>instance.routeHandles.find(h=>h.routeKey===r.routeKey)!);assert(handles.every(Boolean));
    const build=(index:number,settlement:any)=>guard.build(()=>buildFamilyRuntimeAmountLeg({family,route:handles[index],source,executor,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog,settlement}));
    const adapters=[...family.plugin.actionAdapters,...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const compile=(node:ResolvedPlanNode):Uint8Array=>{const adapter=adapters.find(a=>a.id===node.adapterId);assert(adapter);return adapter.encode(node,executor,concatBytes(...node.children.map(compile)));};
    const execute=async(script:Uint8Array,route:Route,inputBalance:bigint,oldOutput:bigint,context?:{mode:string;fault:string;amount:bigint}):Promise<any>=>{
      const caller={kind:"executor" as const};const request:AdapterRequest={id:"standard-erc4626-execution",required:false,kind:"effect-delta-simulation",call:{caller,executionMode:"executor-program",to:executor,data:buildSubscriptCalldata(script)},
        overrideIntent:{caller,nativeBalanceWei:17n,tokenBalances:[{token:route.tokenIn,amount:inputBalance},{token:route.tokenOut,amount:oldOutput}]},
        observeTokenBalances:[route.tokenIn,route.tokenOut].flatMap(token=>[{token,account:caller},{token,account:owner}]),observeTotalSupplies:[d.asset,d.share],observe:effects};
      if(saved){const reused=saved.take(JSON.parse(json(request)),stage,source,executorRuntimeCode.keccak256);if(reused){const value={...structuredClone(reused.row.value),effects:restoreSavedEffects(reused.row.value.effects)};return {request,outcome:reused.row.outcome,value,executionOrigin:"reobserved-saved-current-request",priorRaw:reused.raw,priorRawIndex:reused.index};}}
      if(prior&&!saved&&context){
        const oldSample=prior.samples.find((x:any)=>x.direction===route.direction&&x.amountIn===context.amount.toString());
        const oldRow=oldSample?.executions.find((x:any)=>x.mode===context.mode&&x.fault===context.fault&&x.oldOutput===oldOutput.toString()&&x.status==="pass");
        if(oldRow){
          assert.deepEqual(JSON.parse(json(request)),oldRow.request);assert.deepEqual(oldRow.value.source,source);
          const raw=prior.rawStrict.find((x:any)=>x.stage===stage&&x.result.success===true)?.result;assert(raw&&raw.strict.counterfactualExecutorCode.keccak256===executorRuntimeCode.keccak256);
          const value={...structuredClone(oldRow.value),effects:restoreSavedEffects(oldRow.value.effects)};
          return {request,outcome:oldRow.outcome,value,executionOrigin:"reused-prior-positive",priorRaw:raw};
        }
        // The first run stopped on this exact first insufficient-input call,
        // after persisting its real raw Strict result but before adding a row.
        if(context.fault==="insufficient-cost"&&oldOutput===0n&&oldSample?.executions.length===1&&oldSample.executions[0].mode===context.mode&&prior.error?.stage===stage){
          const raw=prior.rawStrict.at(-1)?.result;assert(raw?.strict?.outcome?.nestedHalt==="InvalidFEOpcode");assert.equal(raw.strict.outcome.kind,"Revert");assert.equal(raw.strict.outcome.phase,"main");assert.equal(raw.strict.counterfactualExecutorCode.keccak256,executorRuntimeCode.keccak256);
          const positive=oldSample.executions[0].request;assert.equal(request.call.data,positive.call.data);assert.equal(inputBalance,context.amount-1n);
          return {request,resourceLimited:true,priorRaw:raw,executionOrigin:"reused-prior-strict-resource-classification"};
        }
      }
      const outcome=await executeAdapterWork({runtime,control:{signal:abort.signal,deadlineAtMs},intent:{stage:"exact-refine",familyId:FAMILY,source,generation:source.generation,programInput:undefined,program:{requirements:()=>requirements,buildRequests:()=>[request],decode:({results}):readonly AdapterRequestResult[]=>results}}});
      assert.equal(outcome.status,"resolved");if(outcome.status!=="resolved")throw new Error("execution unresolved");const value=outcome.executed.evidence[0]!;if(!value.ok){
        const last=report.rawStrict?.at(-1);assert(context?.fault==="insufficient-cost"&&last?.stage===stage&&last.result?.ok===true&&last.result?.strict?.outcome?.kind==="Revert"&&last.result.strict.outcome.phase==="main"&&last.result.strict.outcome.nestedHalt==="InvalidFEOpcode","unclassified transport/resource failure");
        return {request,outcome,value,resourceLimited:true,executionOrigin:"new-strict-resource-classification"};
      }
      assert.deepEqual(value.source,source);return {request,outcome,value,executionOrigin:"new-strict-execution"};
    };
    const reverted=(value:AdapterRequestResult)=>{assert(value.ok);assert.equal(value.completion,"reverted-as-declared");assert.deepEqual(value.effects,{tokenDeltas:[],nativeDeltas:[],totalSupplyDeltas:[],logs:[]});};
    for(const [index,route] of routes.entries()){
      const edges=graph.filter(e=>e.instanceKey!==undefined&&same(e.instanceKey,TARGET)&&same(e.tokenIn,route.tokenIn)&&same(e.tokenOut,route.tokenOut));assert.equal(edges.length,1);
      const deposit=route.direction==="deposit";
      const originalInput=deposit?nominatedEvent.args.assets:nominatedEvent.args.shares;
      const trials=[1n,2n].map(multiplier=>({label:multiplier===1n?"original-event-input":"twice-original-event-input",amount:originalInput*multiplier,donorRow:{transactionHash:TX,logIndex:plan.candidate.logIndex,tokenIn:route.tokenIn,multiplier}}));
      for(const mode of ["default","direct-self","direct-external"]){
        const recipient=mode==="direct-external"?owner:executor;
        const request=mode==="default"?undefined:{kind:"direct-output",recipient},leg=build(index,request);assert(leg);assert.deepEqual(leg.settlementRequest,request);if(request)assert.equal(leg.settlement?.directOutput,true);assert.equal(leg.inputMode,undefined);
        for(const unsupported of [{kind:"quote-output",recipient},{kind:"deferred-input",paymentAmount:1n,paymentProgram:ethers.hexlify(recipientContinuation().bytes())}])assert.equal(build(index,unsupported),null);
        const external=!same(recipient,executor);
        for(const {label,amount,donorRow} of trials){
          stage=`quote:${route.direction}:${label}`;const trial:any={mode,direction:route.direction,recipient,tokenIn:route.tokenIn,tokenOut:route.tokenOut,label,amountIn:amount,donorRow,status:"failed",executions:[]};report.samples.push(trial);
          const quote=await guard.exact(()=>executeFamilyExactQuote({family,route:handles[index]!,amountIn:amount,source,generation:source.generation,executor,runtimeEvidence:[],runtime,control:{signal:abort.signal,deadlineAtMs}}));trial.quote=quote;
          assert.equal(quote.status,"resolved");if(quote.status!=="resolved")throw new Error("Exact unresolved");assert.equal(quote.amountIn,amount);assert.deepEqual(quote.source,source);
          const output=quote.amountOut,cost=amount;assert(output>0n&&amount>0n);
          const preview=BigInt(ABI.decodeFunctionResult(deposit?"previewDeposit":"previewRedeem",await rpc("eth_call",[{to:TARGET,data:ABI.encodeFunctionData(deposit?"previewDeposit":"previewRedeem",[amount])},pin]))[0]);assert.equal(output,preview);
          trial.inputBudget={requested:amount,cost,unspent:0n,inputMode:"exact",roundingToleranceRawUnits:0n};
          const scripts:[string,Uint8Array][]=[[mode==="default"?"runtime":mode,runtimeProgramScript(ethers.getBytes(leg.program),amount)]];
          if(mode==="default"){
            const fragment=guard.quoted(()=>buildFamilyExecutionFragment({family,route:handles[index]!,exact:quote,minAmountOut:output,executor,runtimeEvidence:[],actionOwnership:catalog}));
            assert.equal(fragment.status,"resolved");if(fragment.status!=="resolved")throw new Error("quoted fragment unresolved");
            scripts.unshift(["quoted",concatBytes(...planFragmentNodes(fragment.fragment,route.tokenIn,amount).map(compile))]);
          }
          for(const [encoding,runtimeScript]of scripts)for(const oldOutput of [0n,103n])for(const fault of mode==="default"?["none","insufficient-cost"]:["none","insufficient-cost","minimum-plus-one","wrong-receiver-postcondition","post-revert"]){
            stage=`${encoding}:${route.direction}:${label}:${fault}`;const post=recipientContinuation();
            if(fault==="minimum-plus-one"||fault==="wrong-receiver-postcondition"){
              const account=fault==="wrong-receiver-postcondition"?(external?executor:owner):recipient;
              const opening=same(account,executor)?oldOutput:BigInt(TOKEN.decodeFunctionResult("balanceOf",await rpc("eth_call",[{to:route.tokenOut,data:TOKEN.encodeFunctionData("balanceOf",[account])},pin]))[0]);
              post.call(route.tokenOut,TOKEN.encodeFunctionData("balanceOf",[account]),{static:true}).load(1,0).constant(2,opening).math("sub",1,1,2).constant(2,output+(fault==="minimum-plus-one"?1n:0n)).math("sub",1,1,2);
            }
            if(fault==="post-revert")post.constant(1,1n).constant(2,0n).equal(1,2);
            const run=await execute(concatBytes(runtimeScript,runtimeProgramScript(post.bytes(),0n)),route,fault==="insufficient-cost"?cost-1n:amount+101n,oldOutput,{mode:encoding,fault,amount});
            const record:any={mode:encoding,fault,oldOutput,...run,status:"failed"};trial.executions.push(record);
            if(run.resourceLimited){
              assert.equal(fault,"insufficient-cost");
              fork??=await createInsufficientFork({rpcUrl,port,source,header,owner,executor,signal:abort.signal,deadlineAtMs,report});
              record.independentRejection=await fork.check({script:concatBytes(runtimeScript,runtimeProgramScript(post.bytes(),0n)),request:run.request,executorRuntimeCode,tokenIn:route.tokenIn,tokenOut:route.tokenOut,amountIn:amount,inputBalance:cost-1n,outputInventory:oldOutput,pool:TARGET,liquidity:TARGET,recipient});
              record.strictClassification="resource-limited-invalid-opcode; unchanged";
            }else if(fault!=="none")reverted(run.value);else{
              assert.equal(run.value.completion,"returned");assert.equal(run.value.data,"0x");const e=run.value.effects!;
              assert.equal(e.tokenDeltas?.length,4);assert.equal(e.nativeDeltas?.length,1);assert.equal(e.nativeDeltas![0].delta,0n);assert(same(e.nativeDeltas![0].account,executor));
              const expected=[[route.tokenIn,executor,-amount],[route.tokenOut,executor,external?0n:output],[route.tokenIn,owner,0n],[route.tokenOut,owner,external?output:0n]] as const;
              for(const [t,a,delta] of expected){const rows=e.tokenDeltas!.filter(x=>same(x.token,t)&&same(x.account,a));assert.equal(rows.length,1);assert.equal(rows[0].delta,delta);}
              assert.equal(e.totalSupplyDeltas?.length,2); // Recorded independently; accrual/fee minting need not equal user shares.
              const transfers=e.logs!.filter(x=>same(x.topics[0],TOKEN.getEvent("Transfer")!.topicHash)).map(x=>({token:x.address,args:TOKEN.parseLog(x)!.args}));
              const inputFlow=transfers.filter(x=>same(x.token,route.tokenIn)).reduce((n,x)=>n+(same(x.args.from,executor)?x.args.value:0n)-(same(x.args.to,executor)?x.args.value:0n),0n);
              const outputFlow=transfers.filter(x=>same(x.token,route.tokenOut)).reduce((n,x)=>n+(same(x.args.to,recipient)?x.args.value:0n)-(same(x.args.from,recipient)?x.args.value:0n),0n);
              assert.equal(inputFlow,amount);assert.equal(outputFlow,output);
              const supplies=e.totalSupplyDeltas!.filter(x=>same(x.token,d.asset));assert.equal(supplies.length,1);
              record.recipientEvent=assertRecipientEvent(e.logs!,{deposit,vault:TARGET,asset:d.asset,executor,recipient,amount,output,assetSupplyDelta:supplies[0]!.delta});

            }
            Object.assign(record,{status:fault==="none"?"pass":run.resourceLimited?"independent-insufficient-input-rejection-strict-resource-limited":"correctly-rejected",rollbackEvidence:fault==="none"?undefined:run.resourceLimited?"Independent same-N Anvil actual full-A transferFrom INVALID and contract storage/native rollback; strict resource classification retained":"Trusted production MainRevert; effects omitted on rollback, no independent storageDiff claim"});
          }
          trial.status="pass";console.log(json({direction:route.direction,label,recipient,amountIn:amount,cost,refund:amount-cost,amountOut:output,status:trial.status}));
        }
        if(mode!=="default")for(const amount of [0n]){const run=await execute(runtimeProgramScript(ethers.getBytes(leg.program),amount),route,101n,103n);const record={kind:amount===0n?"zero-input":"no-whole-asset-output",direction:route.direction,recipient,amount,...run};report.roundTrips.push(record);reverted(run.value);}
      }
    }
    if(saved)report.reusedRawCount=saved.done();
    assert.equal(report.samples.length,routes.length*6);assert(report.samples.every((s:any)=>s.status==="pass"));assert.equal(report.roundTrips.length,routes.length*2);
    assert.equal(guard.counts.forbiddenDuringBuild,0);report.runtimeConstruction={rpc:0,exact:0,quotedFallback:false,scope:"real production issuer; selector throwing-stub coverage in shared dual suite"};report.result="same-N-standard-erc4626-dual-and-direct-pass";
  }catch(e){report.error={stage,message:redact(e instanceof Error?e.stack:e)};process.exitCode=1;}
  finally{try{await finalPins?.();await simulation?.closeAndDrain();await fork?.close();report.drained=true;report.forkDrained=fork!==undefined;}catch(e){report.finalError=redact(e);report.result="failed";process.exitCode=1;await simulation?.closeAndDrain().catch(()=>{});await fork?.close().catch(()=>{});}
    clearTimeout(timer);report.directReads=reads;report.invocationCounts=guard.counts;writeFileSync(fd,redact(json(report))+"\n");closeSync(fd);console.log(json({result:report.result,error:report.error,samples:report.samples.length,out:args.get("--out")}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("invalid standard ERC4626 recipient historical input; existing files preserved");process.exitCode=1;});
