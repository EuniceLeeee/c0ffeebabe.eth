import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { FunctionFragment, Interface, toBeHex, ZeroAddress } from "ethers";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { normalizeSelectorNativeExecutionDefinition } from "../venues/selector-native-definition.js";
import { selectorNativeCandidateFromCensus } from "../venues/selector-native-discovery.js";
import { createSelectorNativeRuntime } from "../venues/selector-native-runtime.js";
import { compileSelectorNativeExecutionFamily } from "../venues/selector-native-family.js";
import { defineSwapFamily, defineProtocolFamily } from "../venues/adapter-family-plugin.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import type { SelectorNativeBindingProof } from "../venues/selector-native-runtime.js";

const a=(n:number)=>toBeHex(n,20),source={number:50,hash:toBeHex(50,32),generation:1},target=a(100),executor=a(101),sender=a(102);
const coins=[a(200),a(201),a(202),a(203),a(204),a(205),a(206),a(207)],lp=a(300),baseLp=a(301),meta=a(400),base=a(401),amm=a(402),staker=a(403),permit=a(500),vault=a(501),factory=a(600),fee=a(601);
const report=JSON.parse(readFileSync(new URL("../generated/selector-typed-a-migration.generated.json",import.meta.url),"utf8"));
const root=new URL("../../../../",import.meta.url);
function load(row:any){const author=JSON.parse(readFileSync(new URL(row.file,root),"utf8")),program=author.programs.find((p:any)=>p.meta?.migrationKey===row.recipe);
  assert(program,row.recipe);return normalizeSelectorNativeExecutionDefinition({...author,programs:[program]});}
function sample(row:any,definition:any){const fn=FunctionFragment.from(definition.signature),mint=fn.name==="add_liquidity",index=mint?Number(row.recipe.split(":").at(-1)):1;
  return fn.inputs.map((p,i)=>{
    if(p.baseType==="array")return Array.from({length:p.arrayLength===-1?Math.max(2,index+1):p.arrayLength!},(_,j)=>j===index?7n:0n);
    if(p.type==="address")return fn.name==="swapSingleTokenExactIn"?(i===0?meta:i===1?coins[0]:coins[1]):sender;
    if(p.type==="bytes")return "0x";if(p.type==="bool")return false;
    if(fn.name==="remove_liquidity_one_coin")return i===0?7n:i===1?1n:1n;
    if(fn.name==="swapSingleTokenExactIn")return i===3?7n:1n;
    return i===0?7n:1n;
  });}
function prepared(row:any,options:{nativeCoin?:boolean}={}){
  const definition=load(row),raw=definition.programs[0]!,runtime=createSelectorNativeRuntime(definition,raw),args=sample(row,definition);
  const census=readySelectorCensusFromTransaction({chainId:1,transactionHash:toBeHex(51,32),blockNumber:50,blockHash:source.hash,status:1,from:sender,to:target,input:new Interface([definition.signature]).encodeFunctionData(definition.selector,args),logs:[],traces:[]});
  const candidate=selectorNativeCandidateFromCensus(definition,census,census.calls[0]!.id)!;assert(candidate,row.recipe);
  const zap=row.recipe.includes(":zap:"),yieldbasis=row.sourceFamily==="yieldbasis-lt";
  const answers:Record<string,unknown>={lp:zap?lp:target,token:zap?lp:ZeroAddress,basePool:zap?base:ZeroAddress,metaPool:zap?meta:ZeroAddress,
    meta,base,baseLp,metaCoin:coins[0],baseCoin0:coins[1],baseCoin1:coins[2],baseCoin2:coins[3],asset:coins[0],stable:coins[1],cryptopool:meta,amm,staker,permit,vault,coin0:coins[0],coin1:coins[1],factory,feeReceiver:fee};
  if(yieldbasis)answers.lp=target;
  let proof:SelectorNativeBindingProof|undefined,reads=0;
  for(let n=0;n<5;n++){
    const step=runtime.step({candidate,source,executor,executionRoundingRawUnits:1n,evidence:proof});
    const results=step.requests.map((request:any)=>{
      assert.equal(request.kind,"eth-call");assert(!/factory|code/i.test(request.id)||request.id==="factory","identity read leaked");reads++;
      const abi=new Interface(raw.values!.abi[request.id]),fn=abi.getFunction(request.data.slice(0,10))!,decoded=abi.decodeFunctionData(fn,request.data);
      const value=request.id==="coinU"||request.id==="coinI"?options.nativeCoin?"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee":coins[Number(decoded[0])]:answers[request.id];assert.notEqual(value,undefined,request.id);
      return {id:request.id,ok:true as const,completion:"returned" as const,source,data:abi.encodeFunctionResult(fn,[value]),provenance:{kind:"fixture",fingerprint:"canonical-read"}};
    });
    proof=step.decode(results);if(proof.stage==="complete")break;
  }
  assert.equal(proof!.stage,"complete",row.recipe);const bound=runtime.verify(candidate,proof!);
  return {definition,runtime,candidate,proof:proof!,bound,input:{candidate,descriptor:bound.descriptor,route:bound.innerRoutes[0],source,executor,amountIn:77n,runtimeEvidence:[]},reads};
}

test("all typed A recipes bind executable parameters, seal and compile the current guarded VM",()=>{
  assert.equal(report.entries.length,68);assert.equal(new Set(report.entries.map((r:any)=>r.selector)).size,22);
  for(const row of report.entries){try{
    const p=prepared(row),plugin=compileSelectorNativeExecutionFamily(p.definition);
    (p.definition.domain==="swap"?defineSwapFamily:defineProtocolFamily)(plugin as any);
    const leg=p.runtime.buildRuntimeLeg(p.input);assert(leg,row.recipe);assert(leg.program.length>20,row.recipe);
    const sim=p.runtime.simulation(p.input,"typed-test");assert.equal(sim.kind,"effect-delta-simulation");assert.equal((sim as any).call.executionMode,"executor-program");
    assert.equal((sim as any).overrideIntent.tokenBalances.length,1);assert.equal((sim as any).overrideIntent.tokenBalances[0].amount,77n);
    assert(!JSON.stringify(p.definition).includes("codeHash"));assert(!JSON.stringify(p.definition).includes("get_registry"));
  }catch(error){throw new Error(row.recipe+": "+(error instanceof Error?error.stack:String(error)));}}
});
test("each declared external recipient path compiles without borrowing executor inventory",()=>{
  for(const row of report.entries){const p=prepared(row);if(p.definition.programs[0]!.execution!.settlement.directOutput!==true)continue;
    try{const leg=p.runtime.buildRuntimeLeg({...p.input,settlement:{kind:"direct-output",recipient:a(999)}});
    assert(leg,row.recipe);assert.equal(leg.settlement?.directOutput,true,row.recipe);}catch(error){throw new Error(row.recipe+": "+(error instanceof Error?error.stack:String(error)));}
  }
});
test("native coin shapes keep WETH graph assets, EVM value payment and executor-only settlement",()=>{
  for(const recipe of ["curve-lp:fixed2:none:mint:0","curve-lp:int128:none:redeem","curve-lp:fixed2:receiver:mint:0"]){
    const row=report.entries.find((r:any)=>r.recipe===recipe),p=prepared(row,{nativeCoin:true}),route=p.input.route;
    assert([route.tokenIn,route.tokenOut].some(t=>t.toLowerCase()==="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"));
    const leg=p.runtime.buildRuntimeLeg(p.input);assert(leg,recipe);const sim=p.runtime.simulation(p.input,"native-test");
    assert((sim as any).executionAssetBoundary);assert.equal(p.runtime.buildRuntimeLeg({...p.input,settlement:{kind:"direct-output",recipient:a(999)}}),null);
  }
});
test("rounding is centrally bound and a JSON override or changed replay policy cannot enlarge it",()=>{
  const row=report.entries.find((r:any)=>r.recipe==="curve-lp:ng-fixed2:mint:0"),p=prepared(row);
  assert.equal(p.bound.descriptor.executionPolicy.executionRoundingRawUnits,1n);
  assert.throws(()=>p.runtime.step({candidate:p.candidate,source,executor,evidence:p.proof,executionRoundingRawUnits:0n}),/policy changed/);
  assert.throws(()=>p.runtime.step({candidate:p.candidate,source,executor,executionRoundingRawUnits:2n}),/tolerance/);
  const proof=structuredClone(p.proof);proof.bound!.descriptor.executionPolicy.executionRoundingRawUnits=2n;
  assert.throws(()=>p.runtime.verify(p.candidate,proof),/transcript changed/);
});
test("canonical event decoding rejects appended or malformed ABI bytes before per-account conservation",()=>{
  const signature="event Claim(address indexed receiver,uint256[2] tokens)",abi=new Interface([signature]);
  const codec=compileDeclarativeValues({abi:{events:[signature]},constants:{},expressions:{},programs:{}});
  const log=abi.encodeEventLog(abi.getEvent("Claim")!,[fee,[3n,5n]]),expr={op:"decodeEventCanonical",args:["events","Claim","$log"]};
  const parsed=codec.evaluate(expr,{log});assert.equal(parsed.receiver,fee);assert.deepEqual(Array.from(parsed.tokens),[3n,5n]);
  assert.throws(()=>codec.evaluate(expr,{log:{...log,data:log.data+"00".repeat(32)}}),/canonical/);
  assert.throws(()=>codec.evaluate(expr,{log:{...log,topics:log.topics.slice(0,1)}}));
});
test("fee-claim receipt authenticates all balance/supply scopes and rejects false event or account conservation",()=>{
  const row=report.entries.find((r:any)=>r.recipe==="curve-lp:fee-claim:none:redeem"),p=prepared(row),request=p.runtime.simulation(p.input,"claim-receipt") as any;
  const abi=new Interface(p.definition.programs[0]!.values!.abi.claims),logs:any[]=[];
  const event=(address:string,name:string,args:unknown[])=>{const log=abi.encodeEventLog(abi.getEvent(name)!,args);logs.push({address,...log});};
  event(target,"ClaimAdminFee",[fee,[3n,5n]]);event(target,"Transfer",[executor,ZeroAddress,77n]);
  event(coins[0],"Transfer",[target,fee,3n]);event(coins[1],"Transfer",[target,fee,5n]);event(coins[1],"Transfer",[target,executor,154n]);
  const tokenDeltas=request.observeTokenBalances.map((observation:any)=>{
    const account=typeof observation.account==="string"?observation.account:executor,token=observation.token.toLowerCase();let delta=0n;
    if(token===target&&account.toLowerCase()===executor)delta=-77n;
    if(token===coins[0])delta=account.toLowerCase()===fee?3n:account.toLowerCase()===target?-3n:0n;
    if(token===coins[1])delta=account.toLowerCase()===fee?5n:account.toLowerCase()===target?-159n:account.toLowerCase()===executor?154n:0n;
    return {token,account,delta};});
  const result:any={id:request.id,ok:true,completion:"returned",source,data:"0x",provenance:{kind:"fixture",fingerprint:"same-source-receipt"},
    effects:{tokenDeltas,nativeDeltas:[{account:executor,delta:0n}],totalSupplyDeltas:[{token:target,delta:-77n}],logs}};
  assert.equal(p.runtime.decodeSimulation(p.input,request,result),154n);
  for(const change of [
    (r:any)=>r.effects.tokenDeltas.pop(),
    (r:any)=>r.effects.tokenDeltas.push({...r.effects.tokenDeltas[0]}),
    (r:any)=>{r.effects.tokenDeltas.find((d:any)=>d.token===coins[0]&&d.account.toLowerCase()===fee).delta=4n;},
    (r:any)=>{r.effects.totalSupplyDeltas[0].delta=-76n;},
    (r:any)=>{r.effects.logs.push({...r.effects.logs[0]});},
    (r:any)=>{r.effects.logs[1].data+="00".repeat(32);},
    (r:any)=>{r.source={...source,hash:toBeHex(999,32)};},
  ]){const bad=structuredClone(result);change(bad);assert.throws(()=>p.runtime.decodeSimulation(p.input,request,bad));}
});
