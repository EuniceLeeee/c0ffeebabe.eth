import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Interface, ZeroAddress, toBeHex } from "ethers";
import { defineSwapFamily } from "../venues/adapter-family-plugin.js";
import { normalizeSelectorNativeExecutionDefinition, selectorNativeProgramKey } from "../venues/selector-native-definition.js";
import { paidRankRoles as reservePaidRoles } from "../venues/selector-native/selector-022c0d9f-family/historical-ranking.js";
import { compileSelectorNativeExecutionFamily } from "../venues/selector-native-family.js";
import { createObservedExecutionMutation } from "../venues/observed-execution-mutation.js";
import { selectorExecutionResourceKey } from "../venues/selector-execution-keys.js";
import { selectorNativeMutationRole, selectorNativePricingPools, scopeSelectorNativeMutation } from "../venues/selector-native-pricing-activity.js";
import { createSqlEdgePriceLogScopes } from "../venues/sql-edge-price-log-scopes.js";

type D=Record<string,any>;
const raw=(s:string)=>JSON.parse(readFileSync(new URL(`../venues/selector-native/selector-${s}-family/selector-${s}.json`,import.meta.url),"utf8"));
const pair=normalizeSelectorNativeExecutionDefinition(raw("128acb08")).programs[0]!;
const managed=normalizeSelectorNativeExecutionDefinition(raw("48c89491")),mp=managed.programs[0]!,scopes=createSqlEdgePriceLogScopes([managed]);
const addr=(n:number)=>toBeHex(n,20),word=(n:number)=>toBeHex(n,32);
const manager="0x000000000004444c5dc75cb358380d2e3de08a90",tok=addr(1),other=addr(2),a=addr(3),b=addr(4);
const pool=(target:string,id?:string)=>({chainId:1,target,...(id===undefined?{}:{poolNamespace:"contract-pool-id",poolId:id})});
const resource=(target:string,id?:string)=>({resource:pool(target,id),resourceKey:selectorExecutionResourceKey(pool(target,id))});

test("a paid reserve recipe declares historical-only roles; no admission by selector, address, partial program or nominal identity alone",()=>{
  const defs=normalizeSelectorNativeExecutionDefinition(raw("022c0d9f"));
  for(const [index,p] of defs.programs.entries()){
    const k=selectorNativeProgramKey(p),role=reservePaidRoles.find(([id])=>id===k)?.[1];
    if(index!==1&&index!==2){assert(!role);continue;}assert(role);
    const m=(token:string)=>({token,kind:"nominal-unverified",codeHash:word(4),taxNumerator:"0",taxDenominator:"10000"});
    const descriptor={pool:a,token0:tok,token1:other,feeRule:{kind:"constant-bps",feeBps:index===1?"25":"30"},
      quoteModel:{kind:"constant-product"},tokenTransfers:[m(tok),m(other)]};
    const route={programKey:k,target:a,observationTarget:a,...resource(a),tokenIn:tok,tokenOut:other};
    const input={program:p,instance:{programKey:k,target:a,bound:{descriptor,dependencies:[a,tok,other]}},routes:[route],dependencies:[a,tok,other],
      physical:{currencyOnly:new Set<string>(),holders:new Set([a])}};
    assert.deepEqual(role(input),{economic:[a],assets:[tok,other]});assert.equal(input.physical.currencyOnly.size,0);
    assert(!role({...input,dependencies:[a,tok,other,b]}));assert(!role({...input,routes:[{...route,observationTarget:b}]}));
    const d=(patch:object)=>({...input,instance:{...input.instance,bound:{...input.instance.bound,descriptor:{...descriptor,...patch}}}});
    assert(!role(d({independentFeeAddress:tok})));assert(!role(d({tokenTransfers:[m(tok),{...m(other),kind:"verified-transfer-tax"}]})));
    for(const change of [(x:D)=>{x.quoteOutput.steps[0].call.target="$route.tokenIn";},(x:D)=>{x.binding.flow.steps[1].requests[0].kind="eth-call";},
      (x:D)=>{x.quoteOutput.steps[1].math.inputs.amountIn="$block.timestamp";},(x:D)=>{x.execution.steps[1].call.args=["$recipient"];},
      (x:D)=>{x.refreshPolicy="each-block";}]){
      const q=structuredClone(p);change(q);assert(!role({...input,program:q}),"same claimed key must not bless a changed recipe");
    }
  }
});

test("bound plural bypasses synthetic summary; execution defaults are not physical pools",()=>{
  const summary=resource(a),one=resource(b),two=resource(manager,word(5));
  const r={...summary,resources:[one.resource,two.resource],resourceKeys:[one.resourceKey,two.resourceKey]};
  assert.deepEqual(selectorNativePricingPools({...pair,routes:{target:a,resources:[{},{}]}},r,{}),[
    {poolAddress:b,resourceKey:one.resourceKey},{poolAddress:manager,poolId:word(5),poolNamespace:"contract-pool-id",resourceKey:two.resourceKey}]);
  assert.throws(()=>selectorNativePricingPools({...pair,routes:{target:a,resources:[{},{}]}},{...r,resourceKeys:[summary.resourceKey,two.resourceKey]},{}),/key changed/);
  assert.deepEqual(selectorNativePricingPools(pair,summary,{venue:{}}),[]);
  assert.deepEqual(selectorNativePricingPools(pair,summary,{venue:{kind:"address-pool",pool:a}}),[{poolAddress:a,resourceKey:summary.resourceKey}]);
});
const abiT=new Interface(["event Transfer(address indexed from,address indexed to,uint256 amount)"]);
const abiM=new Interface(mp.observations!.events.map((e:D)=>e.signature));
const transfer=(from:string,to:string)=>({kind:"log",address:tok,...abiT.encodeEventLog("Transfer",[from,to,19n])});
const swap=(id:string)=>({kind:"log",address:manager,...abiM.encodeEventLog("Swap",[id,a,-12n,15n,10,25,-1,5])});
function entry(key:string,target:string,id?:string,extra:D={},overrides:D={}){
  const rr=resource(target,id),program={...(id?mp:pair),...overrides};
  const route={...rr,target,tokenIn:tok,tokenOut:other,pricingStateKey:key};
  const desc={target,instanceKey:target,tokenIn:tok,tokenOut:other,
    ...(id?{poolKey:{currency0:tok,currency1:other,hooks:ZeroAddress},managerBinding:{manager}}:{pool:target,token0:tok,token1:other}),...extra};
  const instance={target,candidate:{scope:{tokenIn:tok,tokenOut:other}},bound:{descriptor:desc,dependencies:[target]}};
  return {stateKey:key,routes:[route],descriptor:{program,instance},dependencies:[target,tok,other]};
}
function reader(entries:ReturnType<typeof entry>[]){
  const deps=({descriptor}:D)=>[descriptor.instance.target,tok,other];
  const base=createObservedExecutionMutation<D,D>({isLearned:()=>true,stateKey:r=>r.pricingStateKey,dependencies:deps});
  const m=scopeSelectorNativeMutation(base,e=>{
    const {program,instance}=e.descriptor;
    return selectorNativeMutationRole({program,instance,routes:e.routes,scopes,pools:e.routes.map(r=>selectorNativePricingPools(program,r,
      {venue:r.resource.poolId?{kind:"manager-pool-id",manager:r.target,poolId:r.resource.poolId}:{kind:"address-pool",pool:r.target}}))});
  },deps);
  const index=m.compile!({entries});
  return (o:any)=>{
    const compiled=[...index.affectedStateKeys({observation:o})].sort();
    assert.deepEqual(compiled,entries.flatMap(e=>m.affectedStateKeys({...e,observation:o})).sort(),"direct and indexed lookup agree");
    return compiled;
  };
}
test("ordinary Transfer: token in route is not itself a physical pool touch; actual holder, oracle, unknown and nonordinary remain",()=>{
  const get=reader([entry("a",a),entry("b",b),entry("oracle",b,undefined,{feed:tok}),entry("explicit",b,undefined,{},{dependencies:[tok]})]);
  assert.deepEqual(get(transfer(addr(10),a)),["a","explicit","oracle"]);
  assert.deepEqual(get(transfer(a,b)),["a","b","explicit","oracle"]);
  assert.deepEqual(get(transfer(addr(10),addr(11))),["explicit","oracle"]);
  for(const log of [transfer(ZeroAddress,a),transfer(a,a),{...transfer(addr(9),a),data:"0x"},{...transfer(addr(9),a),topics:[word(7)]},
    {...transfer(addr(9),a),topics:[...transfer(addr(9),a).topics,word(7)]},{kind:"call",target:tok}])
    assert.deepEqual(get(log),["a","b","explicit","oracle"]);
});
test("decoded manager event touches only matching logical pool; unknown, hook and independent manager subscribers stay broad",()=>{
  const get=reader([entry("id1",manager,word(1)),entry("id2",manager,word(2)),entry("independent",manager,word(2),{},{dependencies:[manager]}),
    entry("double-role",manager,word(2),{oracle:manager}),entry("hook",manager,word(2),{poolKey:{currency0:tok,currency1:other,hooks:b}})]);
  assert.deepEqual(get(swap(word(1))),["double-role","hook","id1","independent"]);
  const claim=new Interface(managed.managerCustody!.ledgerEvents).encodeEventLog("Transfer",[a,b,manager,5,3]);
  for(const log of [transfer(a,manager),{kind:"log",address:manager,...claim}])
    assert.deepEqual(get(log),["double-role","hook","independent"]);
  for(const log of [{...swap(word(1)),data:"0x"},{kind:"call",target:manager},{kind:"log",address:manager,...claim,data:"0x"}])
    assert.deepEqual(get(log),["double-role","hook","id1","id2","independent"]);
});
test("a state-bound recipe does not narrow a subscribed manager event",()=>{
  const get=reader([entry("ordinary",manager,word(2)),entry("state-bound",manager,word(2),{},{binding:{...mp.binding,stateBinding:{}}}),
    entry("with-authority",manager,word(2),{},{binding:{...mp.binding,stateBinding:{...mp.binding?.stateBinding,authority:{}}}}),
    entry("extra-role",manager,word(2),{},{binding:{...mp.binding,stateBinding:{...mp.binding?.stateBinding,candidate:{manager:"$target",poolId:"$scope.poolId",oracle:"$target"}}}})]);
  assert.deepEqual(get(swap(word(1))),["extra-role","state-bound","with-authority"]);
});
test("Family registration admits no async physical hook, failed shape, accessor, or duplicate physical identity",()=>{
  const base=resource(a),value={poolAddress:a,resourceKey:base.resourceKey};
  const register=(hook:any)=>{const f=compileSelectorNativeExecutionFamily<"swap">(raw("128acb08"));
    return defineSwapFamily({...f,routes:{...f.routes,pricingPools:hook}});};
  assert.throws(()=>register(async()=>[value]),/synchronous/i);
  for(const item of [Promise.resolve([]),[value,value],[{...value,poolNamespace:"ambiguous"}],[{...value,poolAddress:ZeroAddress}],[{...value,extra:true}],Array(1),[Object.defineProperty({...value},"poolId",{get:()=>word(9),enumerable:true})]]){
    const registered=register(()=>item);assert.throws(()=>registered.routes.pricingPools!({descriptor:{} as any,route:{} as any}));
  }
});
