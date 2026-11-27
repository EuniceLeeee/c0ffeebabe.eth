import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Interface, id, toBeHex } from "ethers";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { normalizeSelectorNativeExecutionDefinition, selectorNativeProgramKey } from "../venues/selector-native-definition.js";
import { selectorNativeCandidateFromCensus } from "../venues/selector-native-discovery.js";
import { createSelectorNativeRuntime } from "../venues/selector-native-runtime.js";
import { normalizeSelectorNativeCreditDefinition } from "../venues/selector-native-credit-definition.js";
const address=(n:number)=>toBeHex(n,20),sender=address(7001),executor=address(7002),target=address(7003),asset=address(7004),output=address(7005);
const source={number:100,hash:toBeHex(100,32),generation:1};
const report=JSON.parse(readFileSync(new URL("../../../../scripts/selector-family-v2-migration.json",import.meta.url),"utf8"));
function load(selector:string){return normalizeSelectorNativeExecutionDefinition(JSON.parse(readFileSync(new URL(`../venues/selector-native/selector-${selector.slice(2)}-family/selector-${selector.slice(2)}.json`,import.meta.url),"utf8")));}
function census(signature:string,args:readonly unknown[],flows=true){return readySelectorCensusFromTransaction({chain_id:1,tx_hash:toBeHex(101,32),block_number:source.number,block_hash:source.hash,receipt_status:1,from:sender,to:target,
 input:new Interface([signature]).encodeFunctionData(signature,args),logs:flows?[{address:asset,topics:[id("Transfer(address,address,uint256)"),toBeHex(BigInt(sender),32),toBeHex(BigInt(target),32)],data:toBeHex(7,32),log_index:0},
 {address:output,topics:[id("Transfer(address,address,uint256)"),toBeHex(BigInt(target),32),toBeHex(BigInt(sender),32)],data:toBeHex(9,32),log_index:1}]:[],traces:[]});}
test("original migration inventory maps all 94 programs and preserves or upgrades all 36 observation entries",()=>{
 assert.equal(report.executablePrograms,94);assert.equal(report.automaticParameterPrograms,10);assert.equal(report.explicitExtensionPrograms,84);
 assert.equal(report.observationOnlyOrdinaryFamilies,36);
 for(const row of report.migrations){const definition=load(row.selector);if(definition.directState)continue;const program=definition.programs.find(p=>selectorNativeProgramKey(p)===row.newProgramKey);assert(program,`${row.selector} ${row.legacyLabel}`);
  assert.equal(Boolean(program.execution),row.mode==="execution-extension");assert(row.oldExecutionSha256&&row.oldSummary.calls.length);assert(row.mode!=="execution-extension"||row.requiredExtensions.length);
 }
 for(const row of report.declarations.filter((r:any)=>r.status==="migrated-observation-only")){
  const selector=row.selector.slice(2),raw=JSON.parse(readFileSync(new URL(`../venues/selector-native/selector-${selector}-family/selector-${selector}.json`,import.meta.url),"utf8"));
  if(raw.domain==="credit"){assert(normalizeSelectorNativeCreditDefinition(raw).programs.length);continue;}
  const definition=normalizeSelectorNativeExecutionDefinition(raw);
  if(!definition.programs.length)assert.equal(definition.unsupportedReason,row.reason);
  else assert(definition.programs.every(program=>program.execution||program.parameters?.length),"an observed entry may only be replaced by a complete executable declaration");
 }
});
test("all ten migrated automatic programs build from census assets with zero binding RPC",()=>{
 for(const row of report.migrations.filter((r:any)=>r.mode==="parameters-and-payment")){
  const definition=load(row.selector);if(definition.directState)continue;const program=definition.programs.find(p=>selectorNativeProgramKey(p)===row.newProgramKey)!;
  const args=program.parameters!.map(p=>({amountIn:7n,minimumOut:1n,tokenIn:asset,tokenOut:output,executor:sender,recipient:sender})[p.role as "amountIn"]);
  const tx=census(definition.signature,args),candidate=selectorNativeCandidateFromCensus(definition,tx,tx.calls[0]!.id,row.newProgramKey);assert(candidate,row.legacyLabel);
  const runtime=createSelectorNativeRuntime(definition,program),request=runtime.step({candidate,source,executor,transactionOrigin:sender});assert.deepEqual(request.requests,[],row.legacyLabel);
  const proof=request.decode([]);assert.equal(proof.stage,"complete",row.legacyLabel);const bound=runtime.verify(candidate,proof);assert.equal(bound.innerRoutes.length,1);
  const leg=runtime.buildRuntimeLeg({candidate,source,executor,transactionOrigin:sender,descriptor:bound.descriptor,route:bound.innerRoutes[0],runtimeEvidence:[]});assert(leg,row.legacyLabel);
  assert(String(leg.program).toLowerCase().includes(row.selector.slice(2)),row.legacyLabel);
 }
});
test("four wrapper entries preserve their own selector, recipient ability and 1:1 return/balance guards",()=>{
 const getter=new Interface(["function token() view returns(address)"]);
 for(const [selector,to] of [["0x26599850",true],["0x5dbd6059",true],["0xea598cb0",false],["0xde0e9a3e",false]] as const){
  const definition=load(selector);if(definition.directState)continue;const row=report.migrations.find((r:any)=>r.selector===selector&&r.legacyLabel==="protocol:few-wrapped/factory-wrapper-effects"),program=definition.programs.find(p=>selectorNativeProgramKey(p)===row.newProgramKey)!;
  const tx=census(definition.signature,to?[7n,sender]:[7n],false),candidate=selectorNativeCandidateFromCensus(definition,tx,tx.calls[0]!.id,row.newProgramKey);assert(candidate);
  const runtime=createSelectorNativeRuntime(definition,program),step=runtime.step({candidate,source,executor,transactionOrigin:sender});assert.equal(step.requests.length,1);
  const proof=step.decode([{id:step.requests[0]!.id,source,ok:true,completion:"returned",data:getter.encodeFunctionResult("token",[asset]),
   provenance:{kind:"local-fixture",fingerprint:toBeHex(102,32)}}]);
  assert.equal(proof.stage,"complete");const bound=runtime.verify(candidate,proof),route=bound.innerRoutes[0];
  const input={candidate,source,executor,transactionOrigin:sender,descriptor:bound.descriptor,route,runtimeEvidence:[]};
  const leg=runtime.buildRuntimeLeg(input);assert(leg);assert(String(leg.program).toLowerCase().includes(selector.slice(2)));
  assert.equal(program.execution!.settlement.directOutput,to);assert(program.execution!.effects.some((e:any)=>e.kind==="credit"&&e.equals?.runtime==="amountIn"));
  assert(program.execution!.steps[0].call.checks.some((check:any)=>check.left.runtime==="converted"&&check.right.runtime==="amountIn"));
  if(to){const direct=runtime.buildRuntimeLeg({...input,request:{kind:"direct-output",recipient:sender}});assert(direct);assert(String(direct.program).toLowerCase().includes(selector.slice(2)));}
 }
});
test("pruned legacy provenance needs no identity RPC and preserves the exact execution programs",()=>{
 const removed=report.migrations.filter((row:any)=>row.prunedLegacyProvenance);assert.equal(removed.length,10);
 for(const row of removed){
  const definition=load(row.selector);if(definition.directState)continue;const program=definition.programs.find(p=>selectorNativeProgramKey(p)===row.newProgramKey)!;
  assert.equal(createHash("sha256").update(JSON.stringify(program.execution)).digest("hex"),row.oldExecutionSha256,row.legacyLabel);
 }
 for(const [selector,label,expected] of [
  ...["0x6e553f65","0xba087652","0x94bf804d","0xb460af94"].map(selector=>[selector,"protocol:erc4626/morpho-vault-v2",1] as const),
  ["0x6e553f65","protocol:staked-usdat/source-bound-staked-usdat-deposit",3],
  ["0xa6e81533","custom-swap:oneswap/proxy-and-bidirectional-factory-registration",2],
  ["0x86b01724","ella-exchange/verified-native-base-runtime",1],
  ["0xd0137d8d","ella-exchange/verified-native-base-runtime",1],
 ] as readonly (readonly [string,string,number])[]){
  const definition=load(selector);if(definition.directState)continue;const row=removed.find((row:any)=>row.selector===selector&&row.legacyLabel===label),program=definition.programs.find(p=>selectorNativeProgramKey(p)===row.newProgramKey)!;
  if(selector==="0xa6e81533")assert.equal(program.math,undefined,"the retired proxy identity model is not an execution dependency");
  const iface=new Interface([definition.signature]),fragment=iface.getFunction(selector)!;
  const args=fragment.inputs.map(input=>input.type==="address"?sender:7n),tx=census(definition.signature,args,false);
  const candidate=selectorNativeCandidateFromCensus(definition,tx,tx.calls[0]!.id,row.newProgramKey);assert(candidate,label);
  const runtime=createSelectorNativeRuntime(definition,program),first=runtime.step({candidate,source,executor,transactionOrigin:sender});assert.equal(first.requests.length,expected,label);
  assert(first.requests.every(request=>request.kind==="eth-call"||request.kind==="get-storage"),label);
  const values=first.requests.map((request,index)=>{
   const read=request.id.split(":").at(-1)!;
   const addressValue=read==="stock"?output:read==="oracle"?address(7101):read==="withdrawalQueue"?address(7102):asset;
   return {id:request.id,source,ok:true as const,completion:"returned" as const,data:toBeHex(BigInt(addressValue),32),provenance:{kind:"local-fixture" as const,fingerprint:toBeHex(8000+index,32)}};
  });
  const proof=first.decode(values);assert.equal(proof.stage,"complete",label);
  const bound=runtime.verify(candidate,proof);assert(bound.innerRoutes.length>0,label);
  assert(!JSON.stringify(bound.descriptor,(_key,value)=>typeof value==="bigint"?value.toString():value).includes("CodeHash"),label);
 }
 for(const selector of ["0x6e553f65","0xba087652"]){
  const definition=load(selector);if(definition.directState)continue;const row=report.migrations.find((row:any)=>row.selector===selector&&row.legacyLabel==="protocol:erc4626/frax-custodian-sync-conversion"),program=definition.programs.find(p=>selectorNativeProgramKey(p)===row.newProgramKey)!;
  assert(JSON.stringify(program.binding).includes('"get-code"'));assert(JSON.stringify(program.execution!.protectedAddresses).includes("$descriptor.custodian.proxyAdmin"));
 }
});
