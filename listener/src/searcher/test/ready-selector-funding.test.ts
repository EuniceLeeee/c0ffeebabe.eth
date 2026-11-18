import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, Network, toBeHex } from "ethers";
import { RebuildReadProvider } from "../rebuild-read-provider.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { createRebuildWiring } from "../universe-rebuild-production.js";
import { activeReadyMemos, UniverseRebuildCheckpointStore } from "../universe-rebuild-checkpoint.js";
import { rebuildUniverse } from "../universe-rebuild-runner.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { resolveStrictReadyRuntime } from "../strict-ready-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { resolveFundingTransactionCase } from "./family-funding-acceptance-context.js";
import { normalizeSelectorNativeFundingDefinition, selectorFundingParameterProjection } from "../venues/selector-native-funding-definition.js";
import { historicalReadyFundingAssets } from "../blockscan-at-block-cli.js";
const a=(n:number)=>toBeHex(n,20),h=(n:number)=>toBeHex(n,32);
const ASSET=a(7001),SECOND=a(7002),ACTOR=a(7003),EXECUTOR=a(7004),UNKNOWN=a(7005);
const source=(number:number)=>({number,hash:h(number),generation:number});
const declarations=["e0232b42","5c38449e"].map(selector=>JSON.parse(readFileSync(new URL(`../venues/selector-native/selector-${selector}-family/selector-${selector}.json`,import.meta.url),"utf8")));
const resources=[{definition:declarations[0],provider:a(8001),assets:[ASSET]},{definition:declarations[0],provider:a(8002),assets:[ASSET]},
 {definition:declarations[1],provider:a(8003),assets:[ASSET,SECOND]}];
const families=catalog.listAll().filter(f=>f.plugin.manifest.domain==="funding"),fundingIds=families.map(f=>f.plugin.manifest.familyId);
const options={rpcUrl:"https://offline.invalid",tracePolicy:"forbid" as const,executionIdentity:{executor:EXECUTOR,transactionOrigin:ACTOR}};
const ERC20=new Interface(["function balanceOf(address) view returns(uint256)"]);
const fees=new Interface(["function getProtocolFeesCollector() view returns(address)","function getFlashLoanFeePercentage() view returns(uint256)"]);
function census(number:number,withFunding=true){
 const root={from:ACTOR,to:UNKNOWN,input:"0xdeadbabe",status:1,call_type:"call",trace_address:[]};
 const traces=withFunding?[root,...resources.map(({definition,provider,assets},i)=>({from:ACTOR,to:provider,status:1,call_type:"call",trace_address:[i],
  input:new Interface([definition.signature]).encodeFunctionData("flashLoan",selectorFundingParameterProjection(normalizeSelectorNativeFundingDefinition(definition)).multiple?[EXECUTOR,assets,assets.map(()=>10n),"0x"]:[assets[0],10n,"0x"])}))]:[];
 return readySelectorCensusFromTransaction({chain_id:1,tx_hash:h(number+1000),block_number:number,block_hash:h(number),receipt_status:1,from:ACTOR,to:UNKNOWN,input:"0xdeadbabe",logs:[],traces});
}
function transport(t:TestContext){
 const reads:{to:string;block:number}[]=[],capacities=new Map(resources.map((r,i)=>[r.provider,BigInt(1000+i)]));
 const call=(tx:{to:string;data:string},block:number)=>{reads.push({to:tx.to.toLowerCase(),block});
  if(tx.data.startsWith(ERC20.getFunction("balanceOf")!.selector)){const [holder]=ERC20.decodeFunctionData("balanceOf",tx.data);return ERC20.encodeFunctionResult("balanceOf",[capacities.get(String(holder).toLowerCase())??0n]);}
  const decoded=fees.parseTransaction(tx);assert(decoded);return fees.encodeFunctionResult(decoded.name,[decoded.name==="getProtocolFeesCollector"?tx.to:0n]);};
 t.mock.method(RebuildReadProvider.prototype,"getNetwork",async()=>Network.from(1));
 t.mock.method(RebuildReadProvider.prototype,"getBlock",async(number:number)=>source(Number(number)));
 t.mock.method(RebuildReadProvider.prototype,"send",async(method:string,params:any[])=>{assert.equal(method,"eth_call");return call(params[0],Number(params[1]));});
 t.mock.method(RebuildReadProvider.prototype,"getCode",async(address:string)=>{assert.equal(address.toLowerCase(),EXECUTOR,"only executor runtime authentication may read code");return "0x60006000";});
 for(const method of ["getStorage","getLogs","getTransaction","getTransactionReceipt","_send"] as const)t.mock.method(RebuildReadProvider.prototype,method,async()=>assert.fail("unexpected identity/history/trace RPC "+method));
 return {reads,capacities,call};
}
test("native Funding source coverage and supplied census nominate selectors plus all provider assets without RPC",async t=>{
 const host=transport(t),tx=census(100),wiring=createRebuildWiring({...options,selectorCensus:[tx]});
 const scan=await wiring.scanSwapWindow({fromBlock:100,cutoff:source(100)}),candidates=wiring.dedupeFamilyCandidates(scan.observations) as readonly any[];
 const selected=candidates.filter(c=>fundingIds.includes(c.familyId));assert.equal(selected.length,3);assert.equal(new Set(selected.map(wiring.familyCandidateKey)).size,3);
 assert.equal(selected.flatMap(c=>c.fundingBindings).length,4);assert.deepEqual(host.reads,[]);
 for(const id of fundingIds){assert(wiring.isFamilyEnabled!(id));assert(wiring.requiredSourceCoverageKeys().some(key=>key.startsWith(id+"|call:")));}
 const coverage=wiring.buildSelectorCoverage!({candidatesByKey:Object.fromEntries(selected.map(c=>[wiring.familyCandidateKey(c),wiring.encodeCandidateSnapshot!(c)])),outcomesByCandidateKey:{}});
 assert(coverage.entries.every(e=>e.status==="unverified"));assert(coverage.entries.some(e=>e.selector==="0xdeadbabe"));
});
test("Ready and historical CLI retain every selector provider/asset binding through current-session refresh and explicit choice",async t=>{
 const host=transport(t),directory=await mkdtemp(join(tmpdir(),"selector-funding-ready-"));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new UniverseRebuildCheckpointStore({path:join(directory,"checkpoint.json")});
 const first=createRebuildWiring({...options,selectorCensus:[census(100)]});
 const ready=await rebuildUniverse({...first,store,runId:"selector-funding-seed",observationRange:{fromBlock:100,toBlock:100}});
 assert.equal(ready.candidateAccounting.verified,3);const initial=(await store.load())!;assert.equal(activeReadyMemos(initial).length,3);
 const reference={id:"old-reference",familyId:"old-protocol-label",domain:"funding" as const,source:source(100),instanceKey:"old-asset-only-key",lineageId:"old-label",tokenIn:ASSET,tokenOut:ASSET,amountIn:"10",amountScope:"test",execution:{target:resources[0]!.provider}};
 const tx={version:1 as const,chainId:1 as const,transactionHash:h(1100),legs:[reference]};
 const sample=await resolveFundingTransactionCase(initial,tx,reference);assert(sample.familyId.startsWith("execution:0xe0232b42:"));assert(sample.fundingId.startsWith("execution-offer:"));
 await assert.rejects(resolveFundingTransactionCase(initial,tx,{...reference,execution:undefined}),/ambiguous/);
 host.reads.length=0;for(const [holder]of host.capacities)host.capacities.set(holder,777n);
 const next=createRebuildWiring({...options,selectorCensus:[census(101,false)]}),updated=await rebuildUniverse({...next,store,runId:"retained-selector-funding",observationRange:{fromBlock:101,toBlock:101}});
 const memos=activeReadyMemos((await store.load())!);assert.equal(memos.length,3);assert(host.reads.length>0&&host.reads.every(r=>r.block===101));
 const entries=memos.map(memo=>next.rehydrateVerifiedInstance({memo,cutoff:updated.cutoff})) as any[];assert.equal(entries.flatMap(e=>e.bindings).length,4);
 const graph=resolveStrictReadyRuntime(updated).graph;assert.deepEqual(graph,[]);
 const cliFunding=entries.flatMap((entry,index)=>historicalReadyFundingAssets(memos[index]!,entry));
 assert.equal(cliFunding.length,4);assert.equal(new Set(cliFunding.map(entry=>entry.binding!.provider.toLowerCase())).size,3);
 assert.deepEqual([...new Set(cliFunding.map(entry=>entry.asset.toLowerCase()))].sort(),[ASSET,SECOND].sort());
 assert.throws(()=>historicalReadyFundingAssets(memos[0]!,{...entries[0],bindings:undefined}),/requires native/);
 assert.throws(()=>historicalReadyFundingAssets(memos[0]!,{...entries[0],familyId:"old-protocol-label"}),/identity differs/);
 const root=new StrictProductionRuntimeRoot({catalog,readySource:updated.cutoff,readyGraph:graph,readyInstances:[],readyFundingAssets:cliFunding});
 const current=source(102),runtime=createStrictCentralAdapterRuntime({executor:EXECUTOR,transactionOrigin:ACTOR,generationFence:{assertCurrent(g,s){assert.equal(g,102);assert.deepEqual(s,current);}},provider:{call:async(tx,b)=>host.call(tx,Number(b)),getCode:async()=>{assert.fail("no identity RPC");},getStorage:async()=>{assert.fail("no storage RPC");}}});
 const session=await root.createSession({source:current,runtime,fundingAssets:[ASSET,SECOND]});assert.equal(session.fundingChoices(ASSET).length,3);assert.equal(session.fundingChoices(SECOND).length,1);assert.equal(session.fundingProjection().sources.get(ASSET)!.amount,777n);
 for(const choice of session.fundingChoices(ASSET)){const root=session.buildFundingRoot({...choice,asset:ASSET,amount:1n,minProfit:0n,children:[]});assert.equal(root.params.fundingId,choice.fundingId);}
});
