// Same-N current production unary recipient acceptance; preserved prior reports
// nominate only their successful input quantities. No default replay or pricing.
import assert from "node:assert/strict";
import { readFileSync, openSync, writeFileSync, closeSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, relative } from "node:path";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { AnvilStateBackend } from "../../../../../shared/state/state-backend.js";
import { loadBotVmRuntimeCode, buildExecuteCalldata } from "../../../../../shared/executor/botvm-executor.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { buildFamilyRuntimeAmountLeg, executeFamilyExactQuote, assertIssuedPreparedFamilyInstance, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import { asPricedFamily } from "../../../family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
import { json,sha,word,same,observeBalance,assertNativeInventory,constructionGuard } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { CORE, LEGACY_SET, VAULT } from "../legacy.js";
import { FAMILY } from "../manifest.js";
import type { Descriptor, Route } from "../types.js";
const ERC20=new ethers.Interface(["function balanceOf(address) view returns(uint256)","function totalSupply() view returns(uint256)","function allowance(address,address) view returns(uint256)","function transfer(address,uint256) returns(bool)","function transferFrom(address,address,uint256) returns(bool)","event Transfer(address indexed from,address indexed to,uint256 value)"]);
const ROOT=fileURLToPath(new URL("../../../../../../../",import.meta.url));
const OWNER="0x1000000000000000000000000000000000000001",EXECUTOR="0x1000000000000000000000000000000000000002",RECIPIENT="0x1000000000000000000000000000000000000085";
function rollback(diff:any){for(const a of new Set([...Object.keys(diff.pre??{}),...Object.keys(diff.post??{})])){const p=diff.pre?.[a]?.storage??{},q=diff.post?.[a]?.storage??{};for(const k of new Set([...Object.keys(p),...Object.keys(q)]))assert.equal(BigInt(p[k]??0),BigInt(q[k]??0));}}
function flatten(t:any):any[]{return[t,...(t.calls??[]).flatMap(flatten)];}
async function main(){
 const names=["--ready","--reference","--reference-sha256","--rpc-file","--out","--port"],args=new Map<string,string>();for(let i=2;i<process.argv.length;i+=2){assert(names.includes(process.argv[i]!)&&!args.has(process.argv[i]!));assert(process.argv[i+1]);args.set(process.argv[i]!,process.argv[i+1]!);}assert.equal(args.size,names.length);
 const fd=openSync(args.get("--out")!,"wx",0o600),report:any={result:"failed",samples:[],signing:false,broadcast:false,performance:"not run",scope:"current production direct unary recipient only; prior successful amounts only; original default/quoted, natural valuation and opportunities not rerun"};
 const guard=constructionGuard(),abort=new AbortController(),deadlineAtMs=Date.now()+600000,timer=setTimeout(()=>abort.abort(new Error("recipient deadline")),600000);
 let backend:AnvilStateBackend|undefined,secret="",stage="inputs",reads=0,checkFinal:(()=>Promise<void>)|undefined;
 const redact=(e:unknown)=>String(e).split(secret||"\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]");
 try{
  const readyPath=realpathSync(args.get("--ready")!),referencePath=realpathSync(args.get("--reference")!),referenceBytes=readFileSync(referencePath);assert.equal(sha(referenceBytes),args.get("--reference-sha256"));const prior=JSON.parse(referenceBytes.toString());assert.equal(prior.result,"pass");
  const headerPath=resolve(dirname(readyPath),"header.json"),receiptPath=resolve(dirname(readyPath),"receipt.json");
  const artifactPath=resolve(ROOT,"out/BotVM.sol/BotVM.json"),paths=[readyPath,referencePath,headerPath,receiptPath,new URL(import.meta.url),new URL("./recipient-contract.ts",import.meta.url),artifactPath];
  const verifyExecutorSources=()=>{const artifact=JSON.parse(readFileSync(artifactPath,"utf8")),m=typeof artifact.metadata==="string"?JSON.parse(artifact.metadata):artifact.metadata;assert.equal(m.settings.compilationTarget["src/BotVM.sol"],"BotVM");assert(Object.keys(m.sources).length>0);for(const [name,v]of Object.entries(m.sources) as [string,{keccak256:string}][]){const path=realpathSync(resolve(ROOT,name));assert(name.endsWith(".sol")&&!relative(realpathSync(ROOT),path).startsWith(".."));assert.equal(ethers.keccak256(readFileSync(path)),v.keccak256);}return sha(readFileSync(artifactPath));};report.executorArtifactSha256=verifyExecutorSources();
  const pins=()=>paths.map(p=>({path:String(p),sha256:sha(readFileSync(p))}));report.inputs=pins();report.code=sourcePin();
  const envelope=await new UniverseRebuildCheckpointStore({path:readyPath}).load();assert(envelope&&!envelope.inProgressRun);const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source=ready.cutoff;
  const header=JSON.parse(readFileSync(headerPath,"utf8")),receipt=JSON.parse(readFileSync(receiptPath,"utf8"));assert.equal(source.number,Number(BigInt(header.number)));assert.equal(source.hash,header.hash);assert.equal(receipt.blockHash,header.hash);assert.equal(receipt.transactionHash.toLowerCase(),prior.inputs.candidate.transactionHash.toLowerCase());
  assert.equal(prior.inputs.source.number,source.number);assert.equal(prior.inputs.source.hash,source.hash);report.source=source;report.tx=receipt.transactionHash;report.header=header;
  const target=prior.inputs.descriptor.set;const family=asPricedFamily(catalog.forStrictFamily(FAMILY));const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:1",familyIds:[FAMILY],executionIdentity:{executor:EXECUTOR,transactionOrigin:OWNER}});
  const candidates=activeReadyMemos(envelope).filter(m=>m.familyId===FAMILY).map(m=>{assert(wiring.isReadyMemoDefinitionCurrent?.(m));const instance=wiring.rehydrateVerifiedInstance({memo:m,cutoff:source}) as PreparedFamilyInstance;return{m,instance};}).filter(v=>same((v.instance.descriptor as Descriptor).set,target));assert.equal(candidates.length,1);
  const {m:memo,instance}=candidates[0]!;assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});const d=instance.descriptor as Descriptor;assert(d.legacy&&d.components.length===1);report.admission={memoFingerprint:memo.memoFingerprint,familyDefinitionHash:memo.familyDefinitionHash,candidate:memo.candidateSnapshot,descriptor:d};
  const referenceSamples=prior.samples.filter((s:any)=>s.status==="pass");assert.equal(referenceSamples.length,prior.samples.length);assert(referenceSamples.length>=2);
  const routes=instance.routeHandles.filter(h=>referenceSamples.some((s:any)=>s.routeKey===h.routeKey));assert.equal(routes.length,1);const route=routes[0]!,rawRoute=instance.routes.find(r=>r.routeKey===route.routeKey) as Route;assert(rawRoute);
  assert.equal(graph.filter(e=>e.instanceKey===d.instanceKey&&same(e.tokenIn,rawRoute.tokenIn)&&same(e.tokenOut,rawRoute.tokenOut)).length,1);
  report.amountDonor={path:referencePath,sha256:sha(referenceBytes),source:prior.inputs.source,sourceTreeSha256:prior.code.sourceTreeSha256,inputOnly:true,claim:"previous successful legal/raw-TX quantities only; no borrowed output, current identity or natural price"};
  const tokens=[rawRoute.tokenIn,rawRoute.tokenOut],runtimeCode=loadBotVmRuntimeCode(OWNER);report.runtimeCodeHash=runtimeCode.keccak256;report.actor={owner:OWNER,executor:EXECUTOR,recipient:RECIPIENT};
  secret=JSON.parse(readFileSync(args.get("--rpc-file")!,"utf8")).MAINNET_RPC_URL;assert(/^https?:\/\//.test(secret));const port=Number(args.get("--port"));assert(Number.isInteger(port)&&port>=1024&&port<=65535);const url=`http://127.0.0.1:${port}`,pin=ethers.toQuantity(source.number);
  const rpc=async(method:string,params:any[])=>{guard.check();abort.signal.throwIfAborted();assert(["eth_chainId","web3_clientVersion","eth_getBlockByNumber","eth_getCode","eth_getStorageAt","eth_call","eth_createAccessList","debug_traceCall","anvil_setCoinbase"].includes(method));if(method==="anvil_setCoinbase")assert.deepEqual(params,[header.miner]);const id=++reads;assert(id<=1800&&Date.now()<deadlineAtMs);const res=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])});assert(res.ok,`HTTP ${res.status}`);const b:any=await res.json();assert.equal(b.id,id);assert.equal(b.jsonrpc,"2.0");assert(!b.error,`${method}: ${b.error?.code} ${b.error?.message}`);return b.result;};
  const runtime=createStrictCentralAdapterRuntime({executor:EXECUTOR,transactionOrigin:OWNER,generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},provider:{call:async(tx:any,b:number)=>{assert.equal(b,source.number);return rpc("eth_call",[tx,pin]);},getCode:async(a:string,b:number)=>{assert.equal(b,source.number);return rpc("eth_getCode",[a,pin]);},getStorage:async(a:string,k:string,b:number)=>{assert.equal(b,source.number);return rpc("eth_getStorageAt",[a,k,pin]);}}});
  const build=(recipient:string)=>guard.build(()=>buildFamilyRuntimeAmountLeg({family,route,source,executor:EXECUTOR,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog,settlement:{kind:"direct-output",recipient}}));
  const legs=[EXECUTOR,RECIPIENT].map(recipient=>{const leg=build(recipient);assert(leg&&leg.settlement?.directOutput);return{recipient,leg};});assert.equal(reads,0);
  for(const kind of ["quote-output","deferred-input"] as const)assert.equal(guard.build(()=>buildFamilyRuntimeAmountLeg({family,route,source,executor:EXECUTOR,runtime:guard.runtime(runtime),runtimeEvidence:[],actionOwnership:catalog,settlement:kind==="quote-output"?{kind,recipient:RECIPIENT}:{kind,paymentAmount:1n,paymentProgram:ethers.hexlify(new RuntimeAmountProgram().constant(1,0n).bytes())}})),null);
  report.runtimeConstruction={exactCalls:0,quotedCalls:0,rpcCalls:0,quotedFallback:false};
  stage="fork";backend=new AnvilStateBackend(secret,url,port);await backend.forkAt(source.number,{signal:abort.signal,deadlineAtMs});assert(/anvil/i.test(await rpc("web3_clientVersion",[])));assert.equal(BigInt(await rpc("eth_chainId",[])),1n);
  const checkHeader=async()=>{const h=await rpc("eth_getBlockByNumber",["latest",false]);for(const f of ["number","hash","parentHash","stateRoot","timestamp","baseFeePerGas","gasLimit","miner","mixHash","excessBlobGas"])assert.equal(h[f],header[f]);};await checkHeader();
  const call=(token:string,data:string,o:any={})=>rpc("eth_call",[{from:OWNER,to:token,data},pin,o]);const balance=async(token:string,a:string,o:any={})=>BigInt(await call(token,ERC20.encodeFunctionData("balanceOf",[a]),o));
  const env=async()=>[...ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"),await call(EXECUTOR,"0x",{[EXECUTOR]:{code:"0x43600052426020524860405241606052456080524460a0524660c05260e06000f3"}}))];const expected=[BigInt(header.number),BigInt(header.timestamp),BigInt(header.baseFeePerGas),BigInt(header.miner),BigInt(header.gasLimit),BigInt(header.mixHash),1n];if((await env())[3]!==expected[3])await rpc("anvil_setCoinbase",[header.miner]);report.environment=await env();assert.deepEqual(report.environment,expected);
  for(const a of [OWNER,EXECUTOR,RECIPIENT])assert.equal(await rpc("eth_getCode",[a,pin]),"0x");
  report.actualCode=[];for(const a of new Set([d.set,d.module,d.legacy.vault,d.legacy.factory,d.legacy.issuance!.transferProxy])){const code=await rpc("eth_getCode",[a,pin]);assert(code!=="0x");report.actualCode.push({address:a,codeHash:ethers.keccak256(code),bytes:ethers.getBytes(code).length});}
  assert.equal(report.actualCode.find((x:any)=>same(x.address,d.set)).codeHash,d.legacy.setCodeHash);assert.equal(report.actualCode.find((x:any)=>same(x.address,d.module)).codeHash,d.controllerCodeHash);
  const natural=BigInt(LEGACY_SET.decodeFunctionResult("naturalUnit",await call(d.set,LEGACY_SET.encodeFunctionData("naturalUnit")))[0]);const unit=BigInt(LEGACY_SET.decodeFunctionResult("getUnits",await call(d.set,LEGACY_SET.encodeFunctionData("getUnits")))[0][0]);
  const feeRecipient=d.legacy.kind==="rebalancing-v3"?String(LEGACY_SET.decodeFunctionResult("feeRecipient",await call(d.set,LEGACY_SET.encodeFunctionData("feeRecipient")))[0]):OWNER;
  const fee=d.legacy.kind==="rebalancing-v3"?BigInt(LEGACY_SET.decodeFunctionResult("entryFee",await call(d.set,LEGACY_SET.encodeFunctionData("entryFee")))[0]):0n;report.currentUnitFee={naturalUnit:natural,componentUnit:unit,entryFee:fee,feeRecipient};
  const actors=[EXECUTOR,RECIPIENT,d.legacy.vault,...(rawRoute.issue&&fee>0n?[feeRecipient]:[])];assert.equal(new Set(actors.map(a=>a.toLowerCase())).size,actors.length);
  const keys=new Map<string,string>();report.balanceMappings=[];
  for(const token of tokens)for(const actor of actors){
   const access=await rpc("eth_createAccessList",[{from:OWNER,to:token,data:ERC20.encodeFunctionData("balanceOf",[actor]),gas:"0x100000"},pin]);assert(!access.error&&Array.isArray(access.accessList));const candidates:string[]=[...new Set<string>(access.accessList.filter((a:any)=>same(a.address,token)).flatMap((a:any)=>a.storageKeys))];assert(candidates.length>0&&candidates.length<=16);
   const protectedActor=same(actor,RECIPIENT)?EXECUTOR:RECIPIENT,protectedBalance=await balance(token,protectedActor),supply=await call(token,ERC20.encodeFunctionData("totalSupply"));let found="";
   for(const k of candidates){let valid=true;for(const v of [717171717171n,919191919193n]){const o={[token]:{stateDiff:{[k]:word(v)}}};const got=await balance(token,actor,o);if(got!==v||await balance(token,protectedActor,o)!==protectedBalance||await call(token,ERC20.encodeFunctionData("totalSupply"),o)!==supply)valid=false;}if(valid){assert.equal(found,"");found=k;}}
   assert(found,"actor balance slot unproven");keys.set(token.toLowerCase()+":"+actor.toLowerCase(),found);report.balanceMappings.push({token,actor,key:found,protectedActor,protectedBalance,probes:[717171717171n,919191919193n]});
  }
  const keyFor=(token:string,actor:string)=>keys.get(token.toLowerCase()+":"+actor.toLowerCase())!;
  const baseline=await Promise.all(actors.map(a=>Promise.all(tokens.map(t=>balance(t,a)))));const initialSupply=BigInt(await call(d.set,ERC20.encodeFunctionData("totalSupply")));
  const creditCall=VAULT.encodeFunctionData("getOwnerBalance",[d.components[0],EXECUTOR]);assert.equal(BigInt(await call(d.legacy.vault,creditCall)),0n);
  checkFinal=async()=>{assert.deepEqual(pins(),report.inputs);assert.deepEqual(sourcePin(),report.code);assert.equal(loadBotVmRuntimeCode(OWNER).keccak256,report.runtimeCodeHash);assert.equal(verifyExecutorSources(),report.executorArtifactSha256);await checkHeader();};
  for(const donor of referenceSamples){
   const A=BigInt(donor.amountIn);assert(A>0n);stage="current-exact";const quote=await guard.exact(()=>executeFamilyExactQuote({family,route,amountIn:A,source,generation:source.generation,executor:EXECUTOR,runtimeEvidence:[],runtime,control:{signal:abort.signal,deadlineAtMs}}));assert.equal(quote.status,"resolved");if(quote.status!=="resolved")throw Error("current quote unresolved");const O=quote.amountOut;assert(O>0n);
   const sample:any={label:donor.label,amountIn:A,tokenIn:tokens[0],tokenOut:tokens[1],quote,routeKey:route.routeKey,executions:[]};report.samples.push(sample);
   for(const {recipient,leg} of legs)for(const inventory of [false,true])for(const fault of ["none","zero-input","insufficient-input","minimum-plus-one","post-revert"]){
    const value=fault==="zero-input"?0n:A,oldOut=inventory?10n**24n:0n,oldInput=fault==="insufficient-input"?A-1n:A+101n;
    const overrides:any={[OWNER]:{balance:ethers.toQuantity(100n*10n**18n)},[EXECUTOR]:{code:runtimeCode.code,balance:"0x11"},[RECIPIENT]:{balance:"0x13"},
      [tokens[0]!]:{stateDiff:{[keyFor(tokens[0]!,EXECUTOR)]:word(oldInput),[keyFor(tokens[0]!,RECIPIENT)]:word(777n)}},
      [tokens[1]!]:{stateDiff:{[keyFor(tokens[1]!,EXECUTOR)]:word(oldOut),[keyFor(tokens[1]!,RECIPIENT)]:word(oldOut)}}};
    const check=new RuntimeAmountProgram().constant(1,0n);
    if(rawRoute.issue)check.call(tokens[0]!,ERC20.encodeFunctionData("allowance",[EXECUTOR,d.legacy.issuance!.transferProxy]),{static:true}).load(2,0).equal(2,1);
    if(fault==="minimum-plus-one")check.call(tokens[1]!,ERC20.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(2,0).constant(3,oldOut+O+1n).math("sub",2,2,3);
    if(fault==="post-revert")check.constant(2,1n).equal(2,1);
    const script=ethers.concat([runtimeProgramScript(ethers.getBytes(leg.program),value),runtimeProgramScript(check.bytes(),0n)]),tx={from:OWNER,to:EXECUTOR,data:buildExecuteCalldata(ethers.getBytes(script)),gas:"0x1000000",gasPrice:header.baseFeePerGas};
    const row:any={mode:same(recipient,EXECUTOR)?"direct-self":"direct-external",recipient,inventory,fault,amountIn:value,initialInput:oldInput,initialOutput:oldOut,status:"failed",scriptHash:ethers.keccak256(script),transaction:tx,overridesHash:sha(json(overrides))};sample.executions.push(row);
    assert.equal(await balance(tokens[0]!,EXECUTOR,overrides),oldInput);assert.equal(await balance(tokens[1]!,EXECUTOR,overrides),oldOut);assert.equal(await balance(tokens[0]!,RECIPIENT,overrides),777n);assert.equal(await balance(tokens[1]!,RECIPIENT,overrides),oldOut);
    stage=row.mode+":"+fault;row.trace=await rpc("debug_traceCall",[tx,pin,{tracer:"callTracer",timeout:"30s",stateOverrides:overrides}]);assert(same(row.trace.from,OWNER)&&same(row.trace.to,EXECUTOR)&&row.trace.input===tx.data);row.diff=await rpc("debug_traceCall",[tx,pin,{tracer:"prestateTracer",tracerConfig:{diffMode:true},timeout:"30s",stateOverrides:overrides}]);
    const calls=flatten(row.trace),selector=CORE.getFunction(rawRoute.issue?(same(recipient,EXECUTOR)?"issue":"issueTo"):"redeemAndWithdrawTo")!.selector,protocol=calls.filter(t=>t.type==="CALL"&&same(t.from??"",EXECUTOR)&&same(t.to??"",d.module)&&t.input?.startsWith(selector));
    if(fault!=="none"){assert(row.trace.error);rollback(row.diff);assertNativeInventory(row.diff,EXECUTOR,17n);assertNativeInventory(row.diff,RECIPIENT,19n);if(fault==="minimum-plus-one"||fault==="post-revert"){assert.equal(protocol.length,1);assert(!protocol[0].error);}row.status="correctly-rejected";continue;}
    assert(!row.trace.error);assert.equal(protocol.length,1);assert(!protocol[0].error);const decoded=CORE.parseTransaction({data:protocol[0].input})!;const gross=rawRoute.issue?A/unit*natural:A;
    if(decoded.name==="issue")assert.deepEqual(decoded.args.toArray().map((x:any)=>typeof x==="string"?x.toLowerCase():x),[d.set,gross]);
    else if(decoded.name==="issueTo")assert.deepEqual(decoded.args.toArray().map((x:any)=>typeof x==="string"?x.toLowerCase():x),[recipient.toLowerCase(),d.set,gross]);
    else assert.deepEqual(decoded.args.toArray().map((x:any)=>typeof x==="string"?x.toLowerCase():x),[d.set,recipient.toLowerCase(),A,0n]);
    row.balances=actors.map((a,j)=>({account:a,tokens:tokens.map((t,i)=>({token:t,...observeBalance(row.diff,t,keyFor(t,a),j===0?(i===0?oldInput:oldOut):j===1?(i===0?777n:oldOut):baseline[j]![i]!)}))}));
    const feeMint=rawRoute.issue?gross*fee/10n**18n:0n;
    const expectedBalances=[[-A,same(recipient,EXECUTOR)?O:0n],[0n,same(recipient,RECIPIENT)?O:0n],rawRoute.issue?[A,0n]:[0n,-O],...(rawRoute.issue&&fee>0n?[[0n,feeMint]]:[])];assert.deepEqual(row.balances.map((b:any)=>b.tokens.map((t:any)=>t.delta)),expectedBalances);
    const postState:any={};for(const a of new Set([...Object.keys(row.diff.pre??{}),...Object.keys(row.diff.post??{})])){const pre=row.diff.pre?.[a]?.storage??{},post=row.diff.post?.[a]?.storage??{};if(Object.keys(pre).length||Object.keys(post).length)postState[a]={stateDiff:Object.fromEntries([...new Set([...Object.keys(pre),...Object.keys(post)])].map(k=>[k,post[k]??word(0n)]))};}
    row.supply={before:initialSupply,after:BigInt(await call(d.set,ERC20.encodeFunctionData("totalSupply"),postState))};assert.equal(row.supply.after-initialSupply,rawRoute.issue?gross:-A);assert.equal(BigInt(await call(d.legacy.vault,creditCall,postState)),0n);
    const observedState:any=structuredClone(overrides);for(const [a,v]of Object.entries(postState) as [string,any][]){const existing=Object.keys(observedState).find(k=>same(k,a))??a;observedState[existing]={...observedState[existing],stateDiff:{...(observedState[existing]?.stateDiff??{}),...v.stateDiff}};}
    for(const b of row.balances)for(const t of b.tokens)assert.equal(await balance(t.token,b.account,observedState),t.after);
    row.native=assertNativeInventory(row.diff,EXECUTOR,17n);row.recipientNative=assertNativeInventory(row.diff,RECIPIENT,19n);row.feeMint=feeMint;row.grossCoreQuantity=gross;row.status="pass";
   }
   assert(sample.executions.every((r:any)=>["pass","correctly-rejected"].includes(r.status)));sample.status="pass";
  }
  report.result="pass-current-unary-direct-receivers";report.invocationCounts=guard.counts;
 }catch(e){report.error={stage,message:redact(e instanceof Error?e.stack:e)};process.exitCode=1;}finally{
  try{await checkFinal?.();report.sourceStable=!!checkFinal;}catch(e){report.finalError=redact(e);report.result="failed";process.exitCode=1;}
  try{await backend?.stopAndWait();report.forkDrained=!!backend;}catch(e){report.closeError=redact(e);report.result="failed";process.exitCode=1;}finally{backend?.provider.destroy();}
  clearTimeout(timer);report.reads=reads;writeFileSync(fd,redact(json(report))+"\n");closeSync(fd);console.log(json({result:report.result,error:report.error,out:args.get("--out")}));
 }
}
main().catch(e=>{console.error(String(e).replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]"));process.exitCode=1;});
