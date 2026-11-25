import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {AbiCoder,Interface,keccak256} from 'ethers';
import {normalizeSelectorNativeExecutionDefinition,selectorNativeProgramKey} from '../venues/selector-native-definition.js';
import {validateSqlExecutionParamHints as validate} from '../venues/selector-native-sql-param-hints.js';
import {compileSqlExecutionParamPlan} from '../venues/selector-native-execution-param-plan.js';

const coin0='0x'+'11'.repeat(20),coin1='0x'+'22'.repeat(20),pool='0x'+'33'.repeat(20),zero='0x'+'00'.repeat(20);
function fixture(s:string,raw:(idx:number,req:{key:string;sources:{kind:string}[]})=>{kind:string;value:string|boolean}|undefined){
  const definition=normalizeSelectorNativeExecutionDefinition(JSON.parse(readFileSync(new URL(
    '../venues/selector-native/selector-'+s+'-family/selector-'+s+'.json',import.meta.url),'utf8')));
  const plans=compileSqlExecutionParamPlan(definition).recipes;
  const recipes=plans.map(({index,requirements})=>{
    const observed:{key:string;kind:string;value:string|boolean}[]=[],missing:string[]=[];
    for(const r of requirements){const v=raw(index,r);if(v)observed.push({key:r.key,...v});
      else if(!r.sources.some(s=>['runtime','edge','fixed'].includes(s.kind)))missing.push(r.key);}
    return {index,observed,missing};
  });
  return {definition,edge:{chainId:1,selector:'0x'+s,poolAddress:pool,tokenIn:coin0,tokenOut:coin1,poolId:null as null|string,poolNamespace:null as null|string},
    evidence:{consensus:'uniform',definitionSha256:createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
      txHash:'0x'+'ab'.repeat(32),callPath:'0',innerSwapPath:null as null|string,recipes}};
}
function v3(){
  return fixture('128acb08',(_i,r)=>r.sources.some(s=>s.kind==='direction-asset')
    ?{kind:'direction-asset',value:r.key==='descriptor.token0'?coin0:coin1}:undefined);
}
function v4(){
  const tuples:Record<string,string>={currency0:coin0,currency1:coin1,fee:'500',tickSpacing:'10',hooks:zero};
  const f=fixture('48c89491',(_i,r)=>r.sources.some(s=>s.kind==='pool-id-tuple')
    ?{kind:'pool-id-tuple',value:tuples[r.key.split('.').at(-1)!]!}:undefined);
  f.edge.poolId=keccak256(AbiCoder.defaultAbiCoder().encode(['address','address','uint24','int24','address'],Object.values(tuples)));
  f.edge.poolNamespace='contract-pool-id';f.evidence.innerSwapPath='0,0,1';return f;
}
test('same active recipe, already found direction; target, full calldata and complete expected returns come from the active program',()=>{
  const f=v3(),r=validate(f)!.recipes[0]!;
  assert.equal(r.programKey,selectorNativeProgramKey(f.definition.programs[0]!));assert.equal(r.verifiedTuple.size,0);
  assert.deepEqual(r.currentGetterChecks.map(x=>x.target),[pool,pool]);
  assert.deepEqual(new Set(r.currentGetterChecks.map(x=>x.calldata)),new Set(['0x0dfe1681','0xd21220a7']));
  assert.equal(r.currentGetterChecks.find(x=>x.calldata==='0x0dfe1681')!.expectedReturn,'0x'+'00'.repeat(12)+coin0.slice(2));
  assert(r.currentGetterChecks.every(x=>new Interface([x.abi]).fragments.length===1));
});
test('pool-id-bound tuple yields five fields but one complete, declaration-owned read expectation',()=>{
  const f=v4(),r=validate(f)!.recipes[0]!;
  assert.equal(r.verifiedTuple.get('descriptor.poolKey.hooks'),zero);assert.equal(r.verifiedTuple.size,5);assert.equal(r.currentGetterChecks.length,1);
  const read=r.currentGetterChecks[0]!,iface=new Interface([read.abi]),sig='poolKeys(bytes25)';
  assert.notEqual(read.target,f.edge.poolAddress);assert.equal(read.target,'0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e');
  assert.equal(read.calldata,iface.encodeFunctionData(sig,[f.edge.poolId!.slice(0,52)]));
  assert.equal(read.expectedReturn,iface.encodeFunctionResult(sig,[coin0,coin1,500,10,zero]));
  assert.throws(()=>validate({...f,edge:{...f.edge,tokenOut:pool}}),/direction assets/);
  const n=v4();n.evidence.recipes[0]!.observed.find(x=>x.key==='descriptor.poolKey.currency0')!.value=zero;
  n.edge.poolId=keccak256(AbiCoder.defaultAbiCoder().encode(['address','address','uint24','int24','address'],[zero,coin1,500,10,zero]));
  n.edge.tokenIn=zero;assert.equal(validate(n)!.recipes[0]!.verifiedTuple.size,5);
  n.edge.tokenIn='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';assert.throws(()=>validate(n),/direction assets/);
});
test('an altered fee, partial tuple, noncanonical numeric value or unrelated trace frame is never a pool-id witness',()=>{
  for(const mode of ['fee','missing','padding','path']){
    const f=v4(),rs=f.evidence.recipes[0]!.observed;
    if(mode==='fee')rs.find(x=>x.key==='descriptor.poolKey.fee')!.value='3000';
    if(mode==='missing')rs.pop();
    if(mode==='padding')rs.find(x=>x.key==='descriptor.poolKey.fee')!.value='0500';
    if(mode==='path')f.evidence.innerSwapPath='10,0';
    assert.throws(()=>validate(f),/SQL parameter evidence/);
  }
});
test('an unqualified public ID uses the uniquely declared manager namespace only for parameter checks',()=>{
  const f=v4(),manager=f.definition.managerCustody!.manager.toLowerCase();
  const edge=Object.freeze({...f.edge,poolAddress:manager,poolNamespace:null});
  const qualified=validate({...f,edge:{...edge,poolNamespace:f.edge.poolNamespace}})!;
  assert.deepEqual(validate({...f,edge}),qualified);
  assert.equal(edge.poolNamespace,null);
  assert.throws(()=>validate({...f,edge:{...edge,poolAddress:pool}}),/logical pool/);
  assert.throws(()=>validate({...f,edge:{...edge,poolNamespace:'another-scope'}}),/logical pool/);
  assert.throws(()=>validate({...f,edge:{...edge,poolId:'0x'+'12'.repeat(32)}}),/hash to this logical pool/);
  assert.throws(()=>validate({...f,edge:{...edge,tokenOut:pool}}),/direction assets/);
  for(const mode of ['no-manager','ambiguous','no-state-scope']){
    const d=JSON.parse(JSON.stringify(f.definition));
    if(mode==='no-manager')delete d.managerCustody;
    if(mode==='ambiguous')d.programs[0].binding.nomination.poolNamespace='another-scope';
    if(mode==='no-state-scope')delete d.programs[0].binding.stateBinding.poolNamespace;
    const evidence={...f.evidence,definitionSha256:createHash('sha256').update(JSON.stringify(d)).digest('hex')};
    assert.throws(()=>validate({definition:d,edge,evidence}),/logical pool/);
  }
});
test('undefined/nonuniform falls back; mixed traces, different definition, recipe reordering and supplied authority fail closed',()=>{
  const clean=v3();for(const evidence of [undefined,{consensus:'nonuniform'},{consensus:'not-declared'}])assert.equal(validate({...clean,evidence}),undefined);
  for(const mode of ['stale','shape','duplicate','token','direction','fixed','target','index','tx']){
    const f=v3(),r=f.evidence.recipes[0]!;
    if(mode==='stale')f.evidence.definitionSha256='0'.repeat(64);
    if(mode==='shape')Object.assign(f.evidence,{calldata:'0x1234'});
    if(mode==='duplicate')r.observed.push({...r.observed[0]!});
    if(mode==='token')r.observed[0]!.value=pool;
    if(mode==='direction')r.observed[1]!.value=r.observed[0]!.value;
    if(mode==='fixed')r.observed.push({key:'executor',kind:'argument',value:coin0});
    if(mode==='target')Object.assign(r.observed[0]!,{target:pool,calldata:'0xa9059cbb'});
    if(mode==='index')r.index=1;
    if(mode==='tx')f.evidence.txHash='0x12';
    assert.throws(()=>validate(f),/SQL parameter evidence/);
  }
});
