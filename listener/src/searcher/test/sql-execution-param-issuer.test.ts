import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {AbiCoder,Interface,ZeroAddress,keccak256} from 'ethers';
import {sqlSelectorModules} from '../sql-edge-live-producer.js';
import {sqlDirectionId, type SqlPriceEdge} from '../sql-edge-price-index.js';
import {issueSqlFamilyAlternatives} from '../venues/selector-native-sql-live-materializer.js';
import {contradictedCommittedRoute} from '../venues/selector-native-sql-param-guard.js';
import {VerifiedGetterDecodes,withVerifiedGetterDecodes} from '../venues/declarative-verified-getter-decode.js';
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from '../venues/production-family-composition.js';
import type {SelectorNativeProgram} from '../venues/selector-native-definition.js';

const addr=(s:string)=>'0x'+s.repeat(40),manager='0x000000000004444c5dc75cb358380d2e3de08a90',selector='0x48c89491';
const types=['address','address','uint24','int24','address'],registry='0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e';
const getter=new Interface(['function poolKeys(bytes25) view returns(address,address,uint24,int24,address)']);
const swap=new Interface(['function swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)']);
const source={number:100,generation:100,hash:'0x'+'ab'.repeat(32)},actors={executor:addr('3'),transactionOrigin:addr('4')};
const module=sqlSelectorModules.get(selector)!;assert(module.definition.domain==='swap');const def=module.definition;
async function fixture(hook:string){
  const script=(name:string)=>import(new URL('../../../../scripts/selector-execution-param-'+name+'.mjs',import.meta.url).href);
  const {compileSqlExecutionParamPlan}=await script('plan'),{annotateExecutionParams}=await script('observation');
  const tuple=[addr('1'),addr('2'),3000,60,hook],poolId=keccak256(AbiCoder.defaultAbiCoder().encode(types,tuple));
  const edge:SqlPriceEdge={chainId:1,poolAddress:manager,poolId,poolNamespace:'contract-pool-id',selector,tokenIn:addr('1'),tokenOut:addr('2'),tokenInId:null,tokenOutId:null,candidateInstanceKey:''};
  const row={...edge,candidateInstanceKey:sqlDirectionId(edge)},inner=swap.encodeFunctionData('swap',[tuple,[true,-100,4295128740n],'0x']);
  const callPath='',innerSwapPath='0,0',plan={...compileSqlExecutionParamPlan(def),definitionSha256:createHash('sha256').update(JSON.stringify(def)).digest('hex')};
  const frames=[{path:'',target:manager,input:selector,paramInput:selector},{path:'0',target:addr('5'),input:'0x12345678'},{path:innerSwapPath,target:manager,input:inner,paramInput:inner}]
    .map(f=>({...f,ok:true,kind:'call'}));
  const [obs]=annotateExecutionParams([{...row,selectorTarget:manager,callPath,innerSwapPath}],frames,{[selector]:plan});
  const evidence={...JSON.parse(obs.paramPayload),consensus:'uniform',callPath,innerSwapPath,txHash:'0x'+'bc'.repeat(32)};
  return {row,tuple,evidence};
}
async function run(row:SqlPriceEdge,tuple:unknown[],denyCurrent=false){
  const trace:string[]=[];
  const answer=await issueSqlFamilyAlternatives({edge:row,catalog,definition:def,source,...actors,
    readCode:async at=>{trace.push('code:'+at);return '0x6000';},read:async(at,data)=>{
      trace.push(at+':'+data);
      if(!denyCurrent&&at===registry&&data===getter.encodeFunctionData('poolKeys',[row.poolId!.slice(0,52)]))return getter.encodeFunctionResult('poolKeys',tuple);
      throw Object.assign(new Error('execution reverted'),{code:3,data:'0x'});
    }});
  return {answer,trace};
}
const ids=(r:Awaited<ReturnType<typeof run>>)=>r.answer.alternatives.map(a=>[a.programKey,a.routeKey,a.program,a.instance.instanceKey]);
test('declared contradiction can remove only a provably impossible recipe; available recipes still follow the ordinary path',async t=>{
  const {row,tuple,evidence}=await fixture(addr('8'));
  const base=await run(row,tuple),used=await run({...row,executionParamEvidence:evidence},tuple);
  assert.equal(base.answer.usage.recipesPruned,0);assert.equal(used.answer.usage.recipesPruned,1);
  assert.deepEqual(ids(used),ids(base));assert(base.trace.includes('code:'+manager));assert(used.trace.length<base.trace.length);
  assert.equal(used.answer.alternatives.length+used.answer.issues.length,def.programs.length);
  t.diagnostic(JSON.stringify({fixture:'committed nonzero hook',sourceReads:[base.trace.length,used.trace.length],recipesPruned:used.answer.usage.recipesPruned}));
});
test('usable content-addressed binding and source-pinned execution alternatives are byte-identical; current getter revert cannot be bypassed',async t=>{
  const {row,tuple,evidence}=await fixture(ZeroAddress);
  const memo=new VerifiedGetterDecodes(),base=await run(row,tuple),used=await withVerifiedGetterDecodes(memo,()=>run({...row,executionParamEvidence:evidence},tuple));
  assert(base.answer.alternatives.length>0);assert.equal(used.answer.usage.recipesPruned,0);
  assert.deepEqual(ids(used),ids(base));assert.deepEqual(used.trace,base.trace);
  assert(used.answer.usage.matchedGetterResults>0);
  assert(memo.hits>0);t.diagnostic(JSON.stringify({fixture:'committed zero hook',sourceReads:[base.trace.length,used.trace.length],
    matchedGetterResults:used.answer.usage.matchedGetterResults,formalDecodeCacheHits:memo.hits,validEncodings:used.answer.alternatives.length}));
  const denied=await run({...row,executionParamEvidence:evidence},tuple,true);
  assert(denied.trace.length>0);assert.equal(denied.answer.alternatives.length,0);
  assert.equal(denied.answer.usage.matchedGetterResults,0);
});
test('historical mismatches and nonuniform evidence preserve the unannotated source-pinned behavior',async()=>{
  const {row,tuple,evidence}=await fixture(ZeroAddress),changed=[...tuple];changed[2]=500;
  const old=await run(row,changed),used=await run({...row,executionParamEvidence:evidence},changed);
  assert.equal(used.answer.usage.mismatchedGetterResults,1);assert.equal(used.answer.usage.matchedGetterResults,0);
  assert.deepEqual(ids(used),ids(old));assert.deepEqual(used.trace,old.trace);
  const plain=await run(row,tuple),unknown=await run({...row,executionParamEvidence:{consensus:'nonuniform'}},tuple);
  assert.deepEqual(plain.answer.usage,unknown.answer.usage);assert.deepEqual(unknown.trace,plain.trace);assert.deepEqual(ids(plain),ids(unknown));
});
test('legacy SQL id preserves its own route and no longer loses a usable tuple in the formal issuer',async()=>{
  for(const hook of [ZeroAddress,addr('7')]){
    const {row,tuple,evidence}=await fixture(hook);
    const coords={...row,poolNamespace:null};
    const legacy=Object.freeze({...coords,candidateInstanceKey:sqlDirectionId(coords),executionParamEvidence:evidence});
    assert.notEqual(legacy.candidateInstanceKey,row.candidateInstanceKey);
    const used=await run(legacy,tuple),qualified=await run({...row,executionParamEvidence:evidence},tuple);
    assert.deepEqual(used.answer.usage,qualified.answer.usage);
    assert.equal(used.answer.usage.ignoredEvidenceRows,0);
    if(hook===ZeroAddress){
      assert(used.answer.alternatives.length>0&&used.answer.usage.matchedGetterResults>0);
      assert.deepEqual(ids(used),ids(await run({...legacy,executionParamEvidence:undefined},tuple)));
      assert.equal((await run(legacy,tuple,true)).answer.alternatives.length,0);
    }else{assert(used.answer.usage.recipesPruned>0);assert.equal(used.trace.length,0);}
    assert.equal(sqlDirectionId(legacy),legacy.candidateInstanceKey);
  }
});
test('obsolete definition or mismatched pool preimage discards just the optional hint; real transport failures are never discarded',async()=>{
  const {row,tuple,evidence}=await fixture(ZeroAddress),plain=await run(row,tuple);
  const edited=structuredClone(evidence);
  const atom=edited.recipes[0].observed.find((v:{key:string})=>v.key==='descriptor.poolKey.hooks');assert(atom);atom.value=addr('7');
  for(const invalid of [{...evidence,definitionSha256:'1'.repeat(64)},edited]){
    const stale=await run({...row,executionParamEvidence:invalid},tuple);
    assert.deepEqual(ids(stale),ids(plain));assert.deepEqual(stale.trace,plain.trace);
    assert.deepEqual(stale.answer.usage,{recipesPruned:0,matchedGetterResults:0,mismatchedGetterResults:0,ignoredEvidenceRows:1});
  }
  const failure=Object.assign(Error('lost binding transport'),{code:'ECONNRESET'});
  await assert.rejects(issueSqlFamilyAlternatives({edge:{...row,executionParamEvidence:edited},catalog,source,definition:def,...actors,readCode:async()=>{throw failure;},read:async()=>{throw failure;}}),e=>e===failure);
});
test('conditional, mutable, shadowed or re-finalized fields never prune a recipe',()=>{
  const assertion={assert:{op:'sameAddress',args:['$descriptor.struct.value',ZeroAddress]},error:'invalid'};
  const p={binding:{stateBinding:{},descriptor:{struct:{value:'$binding.param'}}},routes:{checks:[assertion]}};
  const hints=new Map([['descriptor.struct.value',addr('7')]]);
  const prune=(n:unknown)=>contradictedCommittedRoute(n as SelectorNativeProgram,hints);
  assert(prune(p));assert(!prune({...p,routes:{checks:[{...assertion,when:false}]}}));
  assert(!prune({...p,routes:{checks:[{let:'descriptor',value:{}},assertion]}}));
  assert(!prune({...p,context:{descriptor:{}}}));
  assert(!prune({...p,binding:{...p.binding,descriptorReads:{finalize:{}}}}));
  assert(!prune({...p,binding:{...p.binding,descriptor:{struct:{op:'get',args:[]}}}}));
  for(const name of ['familyId','lineageId','instanceKey','provenance','runtimeRequirements','signedInstanceKey']){
    const ref='descriptor.'+name+'.value';
    const data={binding:{stateBinding:{},descriptor:{[name]:{value:'$binding.param'}}},
      routes:{checks:[{assert:{op:'sameAddress',args:['$'+ref,ZeroAddress]},error:'overwritten'}]}};
    assert(!contradictedCommittedRoute(data as unknown as SelectorNativeProgram,new Map([[ref,addr('7')]])));
  }
});
