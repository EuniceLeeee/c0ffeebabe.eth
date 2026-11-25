import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {AbiCoder,ZeroAddress,keccak256,Interface} from 'ethers';
import {normalizeSelectorNativeExecutionDefinition,selectorNativeProgramKey} from '../venues/selector-native-definition.js';
import {compileSqlExecutionParamPlan} from '../venues/selector-native-execution-param-plan.js';
import {compileSqlTrialLegs} from '../venues/selector-native-sql-trial.js';
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from '../venues/production-family-composition.js';
import {issueSqlFamilyAlternatives} from '../venues/selector-native-sql-live-materializer.js';
import type {SqlLiveEdgeCoordinates} from '../venues/selector-native-sql-live-binding.js';
const coin0='0x'+'11'.repeat(20),coin1='0x'+'22'.repeat(20),pool='0x'+'55'.repeat(20);
const manager='0x000000000004444c5dc75cb358380d2e3de08a90',weth='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const source={number:100,generation:1,hash:'0x'+'11'.repeat(32)},actors={executor:'0x'+'33'.repeat(20),transactionOrigin:'0x'+'44'.repeat(20)};
function fixture(selector:string,edge:SqlLiveEdgeCoordinates,tuple?:readonly string[]){
  const id=selector.slice(2),definition=normalizeSelectorNativeExecutionDefinition(JSON.parse(readFileSync(new URL(
    '../venues/selector-native/selector-'+id+'-family/selector-'+id+'.json',import.meta.url),'utf8')));
  const recipes=compileSqlExecutionParamPlan(definition).recipes.map(({index,requirements})=>{
    const observed:{key:string;kind:string;value:string}[]=[],missing:string[]=[];
    for(const {key,sources} of requirements){
      const t=sources.find(s=>s.kind==='pool-id-tuple');
      if(t&&tuple)observed.push({key,kind:t.kind,value:tuple[t.member]!});
      else if(sources.some(s=>s.kind==='direction-asset'))observed.push({key,kind:'direction-asset',value:key==='descriptor.token0'?coin0:coin1});
      else if(!sources.some(s=>['runtime','edge','fixed'].includes(s.kind)))missing.push(key);
    }return {index,observed,missing};
  });
  const executionParamEvidence={consensus:'uniform',definitionSha256:createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    txHash:'0x'+'ab'.repeat(32),callPath:'',innerSwapPath:tuple?'0,1':null,recipes};
  return {definition,source,...actors,edge:{...edge,executionParamEvidence}};
}
const pair=(selector:string)=>({chainId:1,selector,poolAddress:pool,tokenIn:coin0,tokenOut:coin1});
test('actual V3 directions compile without fee/tickSpacing, no transport or trade admission',()=>{
  const s='0x128acb08',x=fixture(s,pair(s)),a=compileSqlTrialLegs(x);
  assert.equal(a.complete,true);assert.equal(a.legs.length,2);assert.deepEqual(a.issues,[]);
  for(const leg of a.legs){assert.equal(leg.kind,'sql-quote-trial');assert.equal(leg.tokenIn,coin0);assert.equal(leg.tokenOut,coin1);
    assert.match(leg.leg.program,/^0x01/);assert(!('instance' in leg)&&!('routeKey' in leg));}
  const rev=compileSqlTrialLegs({...x,edge:{...x.edge,tokenIn:coin1,tokenOut:coin0}});
  assert.equal(rev.legs.length,2);for(const r of rev.legs)assert.notEqual(r.leg.program,a.legs.find(v=>v.programKey===r.programKey)?.leg.program);
  for(const params of [{source:{...source,hash:'bad'}},{executor:ZeroAddress},{executionRoundingRawUnits:2n},
    {edge:{...x.edge,tokenInId:'7'}},{edge:{...x.edge,poolId:'0x'+'88'.repeat(32)}},
    {edge:{...x.edge,executionParamEvidence:{consensus:'nonuniform'}}},{edge:{...x.edge,tokenOut:pool}},
    {edge:{...x.edge,executionParamEvidence:{...x.edge.executionParamEvidence,definitionSha256:'0'.repeat(64)}}}]){
    const r=compileSqlTrialLegs({...x,...params});assert.equal(r.legs.length,0);assert.equal(r.complete,false);assert(r.issues.length>0);
  }
});
test('direct redemption consumes the SQL call target, direction and only the observed bound index',()=>{
  const s='0x1a4d01d2',lp='0x02950460e2b9529d0e00284a5fa2d7bdf3fa4d72',usdc='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const x=fixture(s,{chainId:1,selector:s,poolAddress:lp,tokenIn:lp,tokenOut:usdc});
  const keys=[1,3].map(i=>selectorNativeProgramKey(x.definition.programs[i]!));
  const withIndex=(value:string)=>({...x,edge:{...x.edge,executionParamEvidence:{...x.edge.executionParamEvidence,
    recipes:x.edge.executionParamEvidence.recipes.map(r=>r.missing.includes('descriptor.index')?{...r,
      observed:[...r.observed,{key:'descriptor.index',kind:'argument',value}],missing:r.missing.filter(k=>k!=='descriptor.index')}:r)}}});
  const actual=compileSqlTrialLegs(withIndex('1'));
  assert.deepEqual(actual.legs.map(l=>l.programKey),keys,actual.issues.join('; '));
  assert(actual.legs.every(l=>l.tokenIn===lp&&l.tokenOut===usdc));
  const other=compileSqlTrialLegs(withIndex('0'));assert.deepEqual(other.legs.map(l=>l.programKey),keys);
  for(const [i,a] of actual.legs.entries())assert.notEqual(a.leg.program,other.legs[i]!.leg.program);
  // Missing must not become index zero. Out-of-range values must not be
  // truncated or reinterpreted. Native assets cannot be invented from ERC20.
  assert.equal(compileSqlTrialLegs(x).legs.length,0);
  assert.equal(compileSqlTrialLegs(withIndex((1n<<127n).toString())).legs.length,0);
  const native=withIndex('1');assert.equal(compileSqlTrialLegs({...native,edge:{...native.edge,tokenOut:ZeroAddress}}).legs.length,0);
  // A fixed higher-priority binding expression is not evidence for using a
  // later edge fallback. No branch based on the selector / pool can override it.
  const raw=JSON.parse(readFileSync(new URL('../venues/selector-native/selector-1a4d01d2-family/selector-1a4d01d2.json',import.meta.url),'utf8'));
  for(const i of [1,3])raw.programs[i].binding.flow.steps[0].result.coin={op:'coalesce',args:[coin1,'$scope.tokenOut']};
  const d=normalizeSelectorNativeExecutionDefinition(raw),old=withIndex('1');
  const changed={...old,definition:d,edge:{...old.edge,executionParamEvidence:{...old.edge.executionParamEvidence,
    definitionSha256:createHash('sha256').update(JSON.stringify(d)).digest('hex')}}};
  const denied=compileSqlTrialLegs(changed);assert.equal(denied.legs.length,0);
  for(const i of [1,3])assert(denied.issues.some(s=>s.startsWith(selectorNativeProgramKey(d.programs[i]!))&&s.includes('binding.coin')),denied.issues.join('; '));
});
test('ordinary transfer + pair credit/getAmountOut needs no tax model; siblings which actually read it remain unresolved',async()=>{
  const s='0x022c0d9f',x=fixture(s,pair(s)),result=compileSqlTrialLegs(x);assert(!result.complete);
  const k=selectorNativeProgramKey(x.definition.programs[4]!);assert.deepEqual(result.legs.map(r=>r.programKey),[k]);
  for(const i of [1,2,3])assert(result.issues.some(msg=>msg.startsWith(selectorNativeProgramKey(x.definition.programs[i]!))&&msg.includes('binding.tokens')));
  const getters=new Interface(['function token0() view returns(address)','function token1() view returns(address)']);
  for(const bytecode of ['0x6000','0x6001600101']){
    const reads=new Set<string>();
    const old=await issueSqlFamilyAlternatives({...x,catalog,readCode:async a=>{reads.add(a);return bytecode;},
      read:async(at,data)=>{assert.equal(at,pool);for(const [i,v] of [coin0,coin1].entries()){
        const fn='token'+i;if(data===getters.encodeFunctionData(fn,[]))return getters.encodeFunctionResult(fn,[v]);}
        throw Object.assign(Error('execution reverted'),{code:3,data:'0x'});}});
    assert(reads.has(coin0)&&reads.has(coin1),'comparison issuer really consumed token bytecode');
    assert.equal(old.alternatives.find(v=>v.programKey===k)?.program,result.legs[0]!.leg.program);
  }
});
test('verified logical-pool tuple and native wrapper produce the same VM bytes as an independently issued route in both directions',async()=>{
  const selector='0x48c89491',tuple=[ZeroAddress,coin1,'3000','60',ZeroAddress],types=['address','address','uint24','int24','address'];
  const poolId=keccak256(AbiCoder.defaultAbiCoder().encode(types,tuple)),get=new Interface(['function poolKeys(bytes25) view returns(address,address,uint24,int24,address)']);
  for(const reverse of [false,true]){
    const x=fixture(selector,{chainId:1,selector,poolAddress:manager,poolId,poolNamespace:null,
      tokenIn:reverse?coin1:ZeroAddress,tokenOut:reverse?ZeroAddress:coin1},tuple);
    const a=compileSqlTrialLegs(x);assert.equal(a.legs.length,1,JSON.stringify(a.issues));
    assert.equal(a.legs[0]!.tokenIn,reverse?coin1:weth);assert.equal(a.legs[0]!.tokenOut,reverse?weth:coin1);assert.equal(a.legs[0]!.poolNamespace,'contract-pool-id');
    let getterReads=0;
    const issued=await issueSqlFamilyAlternatives({...x,catalog,readCode:async()=>'0x6000',read:async(at,calldata)=>{
      assert.equal(at,'0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e');assert.equal(calldata,get.encodeFunctionData('poolKeys',[poolId.slice(0,52)]));
      getterReads++;return get.encodeFunctionResult('poolKeys',tuple);
    }});
    assert(getterReads>0);const counterpart=issued.alternatives.find(r=>r.programKey===a.legs[0]!.programKey);assert(counterpart,JSON.stringify(issued.issues));
    assert.equal(a.legs[0]!.leg.program,counterpart.program);
    assert.equal(compileSqlTrialLegs({...x,edge:{...x.edge,poolId:'0x'+'ab'.repeat(32)}}).legs.length,0);
    assert.equal(compileSqlTrialLegs({...x,edge:{...x.edge,poolAddress:pool}}).legs.length,0);
  }
});
