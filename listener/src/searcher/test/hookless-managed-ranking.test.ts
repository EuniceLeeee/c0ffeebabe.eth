import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {AbiCoder,ZeroAddress,keccak256} from "ethers";
import {hookFreeManagedRank} from "../venues/selector-native/selector-48c89491-family/historical-ranking.js";
import {selectorPaidRankRole} from "../venues/selector-native/paid-ranking-registry.js";
import {normalizeSelectorNativeExecutionDefinition,selectorNativeProgramKey} from "../venues/selector-native-definition.js";

// Physical tuple independently decoded from the production binding getter at 26,378,389.
const c0="0x1abaea1f7c830bd89acc67ec4af516284b1bc33c",c1="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const manager="0x000000000004444c5dc75cb358380d2e3de08a90",registry="0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e";
const id="0xb2b92b56988a4edbe255989792c6ea239b25eaf66b42093145cbf8f630db3a17";
const file=new URL("../venues/selector-native/selector-48c89491-family/selector-48c89491.json",import.meta.url);
const [p,sibling]=normalizeSelectorNativeExecutionDefinition(JSON.parse(readFileSync(file,"utf8"))).programs;
function subject(changes:any={}){
  const k={currency0:c0,currency1:c1,fee:300,tickSpacing:6,hooks:ZeroAddress,...changes};
  const poolId=keccak256(AbiCoder.defaultAbiCoder().encode(["address","address","uint24","int24","address"],
    [k.currency0,k.currency1,k.fee,k.tickSpacing,k.hooks]));
  const instance={programKey:selectorNativeProgramKey(p!),target:manager,candidate:{scope:{poolId}},
    bound:{dependencies:[manager,registry],descriptor:{poolId,poolKey:k,hookPolicy:"no-hook",managerBinding:{manager},graphToken0:k.currency0,graphToken1:k.currency1}}};
  const route={programKey:instance.programKey,observationTarget:manager,observationPoolId:poolId,tokenIn:k.currency1,tokenOut:k.currency0,executionAssets:{input:"erc20",output:"erc20"}};
  return {instance,route,poolId};
}
test("physical role agrees with source-bound ERC20/ERC20 tuple, pool ID, assets, enabled recipe and manager",()=>{
  const {instance,route,poolId}=subject();
  assert.equal(poolId,id);assert.deepEqual(hookFreeManagedRank(p!,instance,[route],manager,poolId),[c0,c1]);
  const h=(i:any,r:any,m=manager,k=poolId,program=p!)=>hookFreeManagedRank(program,i,[r],m,k);
  assert.equal(h({...instance,programKey:"unknown"},route),undefined);
  assert.equal(h(instance,route,registry),undefined);
  assert.equal(h(instance,{...route,observationPoolId:"0x"+"a".repeat(64)}),undefined);
  assert.equal(h(instance,{...route,executionAssets:undefined}),undefined);
  assert.equal(h(instance,{...route,programKey:"wrong"},manager,poolId),undefined);
  assert.equal(h(instance,{...route,tokenIn:c0}),undefined);
  assert.equal(h(instance,route,manager,poolId,sibling!),undefined);
  assert.equal(h(instance,route,manager,poolId,{...p!,refreshPolicy:"each-block"}),undefined);
  assert.equal(h(instance,route,manager,poolId,{...p!,dependencies:[registry]}),undefined);
  assert.equal(h({...instance,bound:{...instance.bound,dependencies:[manager,c0,registry]}},route),undefined);
  const changed={...instance.bound.descriptor,poolKey:{...instance.bound.descriptor.poolKey,fee:302}};
  assert.equal(h({...instance,bound:{...instance.bound,descriptor:changed}},route),undefined);
  for(const bad of [{hooks:registry},{fee:0x800000},{currency0:ZeroAddress}]){
    const {instance:i,route:r,poolId:k}=subject(bad);
    assert.equal(h(i,r,manager,k),undefined);
    if(bad.currency0===ZeroAddress){i.bound.descriptor.graphToken0="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
      assert.equal(h(i,{...r,tokenOut:i.bound.descriptor.graphToken0},manager,k),undefined);}
  }
});
test("Family registration is keyed by the paid program and partitions independent economic addresses",()=>{
  const {instance,route,poolId}=subject(),owned=selectorPaidRankRole(instance.programKey);
  assert(owned);assert.equal(selectorPaidRankRole(selectorNativeProgramKey(sibling!)),undefined);
  const scopes=Object.assign(()=>[poolId],{settlementBalanceOnly:(address:string)=>address===manager});
  const physical={logical:{manager,poolId,scopes},holders:new Set([manager]),currencyOnly:new Set<string>()};
  const s={program:p!,instance,routes:[route],dependencies:[ZeroAddress,manager,c0,c1,registry],physical};
  assert.deepEqual(owned(s),{managedPool:{manager,poolId},assets:[c0,c1],economic:[registry],constantIdentifiers:[ZeroAddress]});
  assert.equal(owned({...s,dependencies:[ZeroAddress,manager,c0,registry]}),undefined);
  assert.equal(owned({...s,physical:{...physical,logical:undefined}}),undefined);
});
