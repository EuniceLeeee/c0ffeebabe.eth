import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {Interface,toBeHex} from "ethers";
import {compileSelectorExecutionSource} from "../build-selector-execution-source.js";
import {readSelectorDiscoveryRuleHash} from "../venues/selector-discovery-rule-hash.js";
import {normalizeSelectorNativeExecutionDefinition as normalize} from "../venues/selector-native-definition.js";
import {selectorExecutionPrograms} from "../venues/selector-program-role.js";
import {compileSqlTrialLegs} from "../venues/selector-native-sql-trial.js";
import {compileSqlExecutionParamPlan} from "../venues/selector-native-execution-param-plan.js";
import {readSelectorSourceIdentity} from "../venues/selector-source-identity.js";
import {inspectRuntime} from "./runtime-program-testkit.js";
import src from "../venues/selector-native/selector-95991276-family/execution.source.json";
import identity from "../venues/selector-native/selector-95991276-family/identity.source.json";
const H=(x:unknown)=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const ruleHash=await readSelectorDiscoveryRuleHash(new URL("../venues/selector-native/selector-95991276-family/",import.meta.url),new URL("../../../../scripts/",import.meta.url));
const compile=(s:unknown=src,i:unknown=identity)=>compileSelectorExecutionSource(s,ruleHash,i);
const def=normalize(compile()),exec=selectorExecutionPrograms(def)[0]!,id=def.programs.find(p=>p.type==="independentIdentity")!;
const a=(n:number)=>toBeHex(n,20),gem=a(1),dai=a(2),pool=a(3),executor=a(4),origin=a(5);
const source={number:100,generation:1,hash:toBeHex(100,32)};
const opt=identity.options[0]!;
const abi=new Interface([src.signature,opt.tokenIn,opt.tokenOut,
 "function approve(address,uint256) returns(bool)","function allowance(address,address) view returns(uint256)","function balanceOf(address) view returns(uint256)"]);
const recipes=compileSqlExecutionParamPlan(def).recipes.map(({index,requirements})=>({index,observed:[],missing:requirements
 .filter(r=>!r.sources.some(s=>["runtime","edge","fixed"].includes(s.kind))).map(r=>r.key)}));
const evidence={consensus:"uniform" as const,definitionSha256:H(def),txHash:toBeHex(200,32),callPath:"0,1",innerSwapPath:null,recipes};
const input={source,definition:def,executor,transactionOrigin:origin,edge:{chainId:1,selector:src.selector,poolAddress:pool,tokenIn:gem,tokenOut:dai,executionParamEvidence:evidence}};
function leg(){const r=compileSqlTrialLegs(input);assert.equal(r.legs.length,1,r.issues.join("; "));return r.legs[0]!;}
test("execution is one edge-driven simulation; identity is a separate read-only capability",()=>{
 assert.equal(selectorExecutionPrograms(def).length,1);assert.equal(id.execution,undefined);assert.equal(exec.binding,undefined);
 assert.equal(exec.projection?.descriptor!==undefined,true);
 assert.deepEqual(def.directState,{...src.state,discoveryRuleHash:ruleHash});
 assert.doesNotMatch(JSON.stringify(exec),/previewSellGem|quoteOutput|runtimeMath|expectedOut|expectedReturn|to18ConversionFactor/);
 assert.deepEqual(leg().leg.settlement,{directOutput:true});
 assert.equal(compileSqlTrialLegs({...input,edge:{...input.edge,executionParamEvidence:{...evidence,definitionSha256:"0".repeat(64)}}}).legs.length,0);
});
test("identity independently reads gem/dai and rejects zero assets, identical tokens and stale source",async()=>{
 const run=(wrong?:string)=>readSelectorSourceIdentity({definition:def,edge:{chainId:1,selector:src.selector,poolAddress:pool,tokenIn:gem,tokenOut:dai},source,
  readRequests:async requests=>{
   assert.equal(requests.length,2);
   return requests.map(q=>{
    assert.equal(q.kind,"eth-call");if(q.kind!=="eth-call")throw Error("unexpected request");
    assert.equal(q.to,pool);const f=abi.getFunction(q.data.slice(0,10))!;
    const value=f.name==="gem"?(wrong==="zero"?a(0):gem):(wrong==="same"?gem:dai);
    return {id:q.id,ok:true as const,source:wrong==="stale"?{...source,generation:2}:source,completion:"returned" as const,
     data:abi.encodeFunctionResult(f,[value]),provenance:{kind:"local-fixture" as const,fingerprint:toBeHex(101,32)}};
   });
  }});
 const got=await run();assert.equal(got.matches.length,1);
 assert.equal(got.matches[0]!.binding.gem.toLowerCase(),gem);assert.equal(got.matches[0]!.binding.dai.toLowerCase(),dai);
 for(const fault of ["zero","same","stale"])assert.equal((await run(fault)).matches.length,0);
});
function execute(fault?:string){
 const inAmt=173n,received=348n;let inputBal=200n,outBal=30n,allowance=1n,native=2n,swaps=0;
 const grants:bigint[]=[];
 inspectRuntime(leg().leg.program,inAmt,{nativeBalance:()=>native,call(c){
  const t=abi.parseTransaction({data:c.data})!;
  switch(t.name){
   case "approve":assert.equal(c.target,gem);assert.equal(t.args[0],pool);grants.push(t.args[1]);allowance=t.args[1];return toBeHex(fault==="false approve"?0:1,32);
   case "allowance":assert.equal(c.target,gem);assert.deepEqual([...t.args],[executor,pool]);return toBeHex(fault==="uncleared"&&swaps?1n:allowance,32);
   case "balanceOf":assert.equal(t.args[0],executor);assert([gem,dai].includes(c.target));return toBeHex(c.target===gem?inputBal:outBal,32);
   case "sellGem":assert.equal(c.target,pool);assert.deepEqual([...t.args],[executor,inAmt]);assert.equal(allowance,inAmt);
    swaps++;inputBal-=fault==="wrong debit"?inAmt-1n:inAmt;outBal+=fault==="no receipt"?0n:received;
    if(fault==="native spend")native--;return toBeHex(999999999n,32);
   default:assert.fail("unexpected helper/preview: "+t.name);
  }
 }});
 assert.equal(swaps,1);assert.deepEqual(grants,[0n,inAmt,0n]);assert.equal(allowance,0n);assert.equal(outBal-30n,received);
}
test("execute once: full debit, actual recipient credit and no standing allowance; ignore arbitrary swap return",()=>execute());
for(const fault of ["no receipt","wrong debit","uncleared","false approve","native spend"])
 test("simulated bytecode rejects "+fault,()=>assert.throws(()=>execute(fault)));
test("malformed ABI, source watches and supplied discovery fingerprints cannot compile",()=>{
 for(const change of [{approval:"ensure"},{selector:"0x12345678"},{args:["recipient","recipient"]},{exact:"1"}])assert.throws(()=>compile({...src,...change}));
 for(const state of [{...src.state,pool:"edge.tokenIn"},{...src.state,assets:["edge.tokenOut","edge.tokenIn"]},
  {...src.state,on:["all-transfers"]},{...src.state,on:["call-target","log-emitter","log-emitter"]},
  {...src.state,watch:"any-token"},{...src.state,unclassifiedWatch:"pool-touch"},{...src.state,getter:"rogue"},
  {...src.state,discoveryRuleHash:ruleHash}])assert.throws(()=>compile({...src,state}));
 for(const bad of [undefined,"",ruleHash.toUpperCase()])assert.throws(()=>compileSelectorExecutionSource(src,bad as string,identity));
});
