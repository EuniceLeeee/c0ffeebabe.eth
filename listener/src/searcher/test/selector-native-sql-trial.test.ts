import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {AbiCoder,ZeroAddress,keccak256} from 'ethers';
import {normalizeSelectorNativeExecutionDefinition,selectorNativeProgramKey} from '../venues/selector-native-definition.js';
import {compileSqlExecutionParamPlan} from '../venues/selector-native-execution-param-plan.js';
import {compileSqlTrialLegs} from '../venues/selector-native-sql-trial.js';
import {selectorExecutionPrograms,selectSingleExecution} from '../venues/selector-program-role.js';
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
    const observed:{key:string;kind:'argument'|'direction-asset'|'pool-id-tuple';value:string}[]=[],missing:string[]=[];
    for(const {key,sources} of requirements){
      const t=sources.find(s=>s.kind==='pool-id-tuple');
      if(t&&tuple)observed.push({key,kind:'pool-id-tuple',value:tuple[t.member]!});
      else if(sources.some(s=>s.kind==='direction-asset'))observed.push({key,kind:'direction-asset',value:/\.(token0|tokenX)$/.test(key)?coin0:coin1});
      else if(!sources.some(s=>['runtime','edge','fixed'].includes(s.kind)))missing.push(key);
    }
    return {index,observed,missing};
  });
  const executionParamEvidence={consensus:'uniform' as const,definitionSha256:createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    txHash:'0x'+'ab'.repeat(32),callPath:'',innerSwapPath:tuple?'0,1':null,recipes};
  return {definition,source,...actors,edge:{...edge,executionParamEvidence}};
}
const pair=(selector:string)=>({chainId:1,selector,poolAddress:pool,tokenIn:coin0,tokenOut:coin1});

for(const s of ['0x95991276','0x8d7ef9bb'])test(`PSM ${s} uses the observed SQL leg assets without gem/dai reads for startup encoding`,()=>{
  const x=fixture(s,pair(s));
  const requirements=compileSqlExecutionParamPlan(x.definition).recipes[0]!.requirements;
  for(const [name,field] of [['tokenIn','tokenIn'],['tokenOut','tokenOut']]){
    const req=requirements.find(r=>r.key==='descriptor.'+name);
    assert.deepEqual(req?.sources,[{kind:'edge',field}]);
  }
  const r=compileSqlTrialLegs(x);
  assert.deepEqual(r.legs.map(l=>[l.programKey,l.tokenIn,l.tokenOut,l.kind]),
    [[selectSingleExecution(x.definition).programKey,coin0,coin1,'sql-quote-trial']],r.issues.join('; '));
});

test('actual V3 direction compiles to a single leg without fee/tickSpacing, transport or trade admission',()=>{
  const s='0x128acb08',x=fixture(s,pair(s)),a=compileSqlTrialLegs(x);
  assert.equal(a.complete,true);assert.equal(a.legs.length,1);assert.deepEqual(a.issues,[]);
  for(const leg of a.legs){assert.equal(leg.kind,'sql-quote-trial');assert.equal(leg.tokenIn,coin0);assert.equal(leg.tokenOut,coin1);
    assert.match(leg.leg.program,/^0x01/);assert(!('instance' in leg)&&!('routeKey' in leg));}
  const rev=compileSqlTrialLegs({...x,edge:{...x.edge,tokenIn:coin1,tokenOut:coin0}});
  assert.equal(rev.legs.length,1);assert.notEqual(rev.legs[0]!.leg.program,a.legs[0]!.leg.program);
  for(const params of [{source:{...source,hash:'bad'}},{executor:ZeroAddress},{executionRoundingRawUnits:2n},
    {edge:{...x.edge,tokenInId:'7'}},{edge:{...x.edge,poolId:'0x'+'88'.repeat(32)}},
    {edge:{...x.edge,executionParamEvidence:{consensus:'nonuniform' as const}}},{edge:{...x.edge,tokenOut:pool}},
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
      observed:[...r.observed,{key:'descriptor.index',kind:'argument' as const,value}],missing:r.missing.filter(k=>k!=='descriptor.index')}:r)}}});
  const actual=compileSqlTrialLegs(withIndex('1'));
  assert.deepEqual(actual.legs.map(l=>l.programKey),keys,actual.issues.join('; '));
  assert(actual.legs.every(l=>l.tokenIn===lp&&l.tokenOut===usdc));
  const other=compileSqlTrialLegs(withIndex('0'));assert.deepEqual(other.legs.map(l=>l.programKey),keys);
  for(const [i,a] of actual.legs.entries())assert.notEqual(a.leg.program,other.legs[i]!.leg.program);
  assert.equal(compileSqlTrialLegs(x).legs.length,0);
  assert.equal(compileSqlTrialLegs(withIndex((1n<<127n).toString())).legs.length,0);
  const native=withIndex('1');assert.equal(compileSqlTrialLegs({...native,edge:{...native.edge,tokenOut:ZeroAddress}}).legs.length,0);
  const raw=JSON.parse(readFileSync(new URL('../venues/selector-native/selector-1a4d01d2-family/selector-1a4d01d2.json',import.meta.url),'utf8'));
  for(const i of [1,3])raw.programs[i].binding.flow.steps[0].result.coin={op:'coalesce',args:[coin1,'$scope.tokenOut']};
  const d=normalizeSelectorNativeExecutionDefinition(raw),old=withIndex('1');
  const changed={...old,definition:d,edge:{...old.edge,executionParamEvidence:{...old.edge.executionParamEvidence,
    definitionSha256:createHash('sha256').update(JSON.stringify(d)).digest('hex')}}};
  const denied=compileSqlTrialLegs(changed);assert.equal(denied.legs.length,0);
  for(const i of [1,3])assert(denied.issues.some(s=>s.startsWith(selectorNativeProgramKey(d.programs[i]!))&&s.includes('binding.coin')),denied.issues.join('; '));
});

test('source-funded V2 single 25bps template compiles cleanly without binding token bytecode RPC',async()=>{
  const s='0x022c0d9f',x=fixture(s,pair(s)),result=compileSqlTrialLegs(x);
  assert.equal(result.complete,true,result.issues.join('; '));
  assert.equal(result.issues.length,0);
  assert.deepEqual(result.legs.map(r=>r.programKey),[selectSingleExecution(x.definition).programKey]);
  let reads=0;const old=await issueSqlFamilyAlternatives({...x,catalog,readCode:async()=>{reads++;throw Error('unexpected old read');},
    read:async()=>{reads++;throw Error('unexpected old getter');}});
  assert.equal(old.alternatives.length,0,'SQL trial output alone is not source-call authority');assert.equal(reads,0);
});

test('source V4 native legs retain single runtime encoding without poolKeys reads',async()=>{
  const selector='0x48c89491',tuple=[ZeroAddress,coin1,'3000','60',ZeroAddress],types=['address','address','uint24','int24','address'];
  const poolId=keccak256(AbiCoder.defaultAbiCoder().encode(types,tuple));
  const prior=['981611ed30c2f802bb7b5bb3b71e06d7bc1bf81423aa4566db5ffe1fb3b6c53e','163384d3112283e69d0b8949a4445a87af1a0a5addf2916cc8ca586814a27784'];
  for(const reverse of [false,true]){
    const x=fixture(selector,{chainId:1,selector,poolAddress:manager,poolId,poolNamespace:null,
      tokenIn:reverse?coin1:ZeroAddress,tokenOut:reverse?ZeroAddress:coin1},tuple);
    const a=compileSqlTrialLegs(x);assert.equal(a.legs.length,1,JSON.stringify(a.issues));
    assert.equal(a.legs[0]!.tokenIn,reverse?coin1:weth);assert.equal(a.legs[0]!.tokenOut,reverse?weth:coin1);assert.equal(a.legs[0]!.poolNamespace,'contract-pool-id');
    assert.equal(createHash('sha256').update(Buffer.from(a.legs[0]!.leg.program.slice(2),'hex')).digest('hex'),prior[Number(reverse)]);
    let reads=0;const deny=async()=>{reads++;throw Error('source unexpectedly requested an old binding');};
    const legacy=await issueSqlFamilyAlternatives({...x,catalog,readCode:async()=>'0x6000',read:deny});
    assert.equal(legacy.alternatives.length,0,'trial output must not confer selected authority');assert.equal(reads,0);
    assert.equal(compileSqlTrialLegs({...x,edge:{...x.edge,poolId:'0x'+'ab'.repeat(32)}}).legs.length,0);
    assert.equal(compileSqlTrialLegs({...x,edge:{...x.edge,poolAddress:pool}}).legs.length,0);
    assert.equal(compileSqlTrialLegs({...x,edge:{...x.edge,tokenIn:coin0}}).legs.length,0);
  }
});

test('V4 source: hooked PoolKey compiles to the single v4-unlock template and embeds edge hookData',()=>{
  const tuple=[ZeroAddress,'0x8f66337a0c2a02202fd91dd596c411cf977c6060','3000','60','0x2a0a30dd78af7698e6f40212b8b8324fce2ee888'];
  const selector='0x48c89491',poolId=keccak256(AbiCoder.defaultAbiCoder().encode(['address','address','uint24','int24','address'],tuple));
  assert.equal(poolId,'0xc87e90621ca16da09311f57cd7ea8262a6f803f422699103e902593f31bd140f');
  const hookBytes='275b003635cd83131a90325a34cbf697172117e8ce82261452b4b4beafa88e31';
  const x=fixture(selector,{chainId:1,selector,poolAddress:manager,poolId,poolNamespace:'contract-pool-id',tokenIn:tuple[0]!,tokenOut:tuple[1]!,hookData:'0x'+hookBytes},tuple);
  const actual=compileSqlTrialLegs(x);
  assert.equal(actual.legs.length,1,actual.issues.join('; '));
  const exec=selectorExecutionPrograms(x.definition);
  assert.equal(exec.length,1);
  assert.deepEqual(actual.legs.map(l=>l.programKey),[selectSingleExecution(x.definition).programKey]);
  assert(actual.legs[0]!.leg.program.toLowerCase().includes(hookBytes));
  const empty=compileSqlTrialLegs({...x,edge:{...x.edge,hookData:'0x'}});
  assert.equal(empty.legs.length,1);
  assert.notEqual(actual.legs[0]!.leg.program,empty.legs[0]!.leg.program);
  assert.deepEqual(x.definition.directState?.on,['pool-id-event']);assert.equal(x.definition.directState?.poolId,'edge.poolId');
  assert.deepEqual(exec.map(p=>p.refreshPolicy),['on-touch']);
  assert.equal(compileSqlTrialLegs({...x,edge:{...x.edge,poolId:poolId.slice(0,-2)+'00'}}).legs.length,0);
  for(const p of exec){assert.equal(p.type,'execution');assert.equal(p.binding,undefined);
    assert.equal(p.projection?.stateBinding?.poolIdTuple?.fields.length,5);}
});

test('sellGem independent identity cannot be used as an execution runtime or SQL trial alternative',async()=>{
  const {createSelectorNativeRuntime}=await import('../venues/selector-native-runtime.js');
  const selector='0x95991276',x=fixture(selector,pair(selector));
  const identity=x.definition.programs.find(p=>p.type==='independentIdentity')!;
  assert(identity.binding?.flow);assert.equal(identity.execution,undefined);
  assert.throws(()=>createSelectorNativeRuntime(x.definition,identity),/identity program cannot/);
  assert(compileSqlTrialLegs(x).legs.every(l=>l.programKey!==selectorNativeProgramKey(identity)));
});
