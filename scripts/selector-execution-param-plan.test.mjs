import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileSqlExecutionParamPlan as compile} from './selector-execution-param-plan.mjs';
const definition=(p,extra={})=>({selector:'0x12345678',signature:'function convert(address,uint256)',domain:'swap',activation:{enabled:true},programs:[p],...extra});
const actual=s=>JSON.parse(readFileSync(new URL('../listener/src/searcher/venues/selector-native/selector-'+s+'-family/selector-'+s+'.json',import.meta.url)));
const map=r=>new Map(r.requirements.map(x=>[x.key,x.sources]));
test('fixed execution limit is 10000 regardless of historic call amount, exact-only declarations or similarly named getters',()=>{
  const p={values:{constants:{cap:10000},expressions:{useLimit:'$value'}},binding:{descriptor:{cap:'$constants.cap',exactFee:34},
    flow:{steps:[{id:'cap',requests:[{id:'maxBorrow',kind:'eth-call'}]}]}},
    routes:{directions:[{fields:{exactFee:'$descriptor.exactFee'}}]},
    execution:{steps:[{frame:{callback:{steps:[{call:{args:[{op:'expression',args:['useLimit',{value:'$descriptor.cap',unused:'$descriptor.exactFee'}]},{runtime:'amountIn'}]}}]}}}]},
    quoteOutput:{steps:[{call:{args:['$descriptor.exactFee']}}]}};
  const m=map(compile(definition(p)).recipes[0]);assert.deepEqual(m.get('descriptor.cap'),[{kind:'fixed',value:10000}]);
  assert.deepEqual(m.get('vm.amountIn'),[{kind:'runtime',field:'amountIn'}]);assert(!m.has('descriptor.exactFee'));assert.equal(m.size,2);
});
test('reachable quote export and named programs count; unreferenced definitions do not',()=>{
  const p={binding:{descriptor:{a:25,b:7,c:1}},values:{programs:{read:[{let:'k',value:'$val'},{return:'$k'}]}},
    execution:{steps:[{call:{args:[{quoteOutput:'exported'}]}}]},
    quoteOutput:{steps:[{call:{args:[{op:'program',args:['read',{val:'$descriptor.a'}]}]}}]},ethCall:{args:['$descriptor.b']},checks:[{assert:'$descriptor.c'}]};
  const m=map(compile(definition(p)).recipes[0]);assert.deepEqual([...m.keys()],['descriptor.a']);assert.equal(m.get('descriptor.a')[0].value,25);
});
test('unresolved and typed parameters remain explicit, never silently regarded as fixed',()=>{
  const [a]=compile(definition({parameters:[{role:'bound',path:[0]}]})).recipes;
  const m=map(a);assert.equal(m.get('args.0')[0].kind,'argument');assert.equal(m.get('args.1')[0].kind,'unresolved');
  const u=compile(definition({binding:{descriptor:{}},execution:{steps:['$descriptor.absent']}}));assert.equal(map(u.recipes[0]).get('descriptor.absent')[0].kind,'unresolved');
  assert.deepEqual(compile(definition({}, {activation:{enabled:false}})).recipes,[]);
});
test('pool-id tuple requires same complete digest declaration, ordered member, and target; changing order or omitting check removes that proof',()=>{
  const raw=actual('48c89491'),first=raw.programs[0],set=p=>map(compile({...raw,programs:[p]}).recipes[0]);
  const m=set(first);assert.equal(m.get('descriptor.poolKey.fee')[0].kind,'pool-id-tuple');assert.equal(m.get('descriptor.poolKey.fee')[0].member,2);
  const g=m.get('descriptor.poolKey.tickSpacing')[1];assert.deepEqual([g.kind,g.outputIndex,g.arguments[0]],['getter',3,{kind:'edge',field:'poolId',bytesPrefix:25}]);
  assert.deepEqual(m.get('descriptor.managerBinding.manager'),[{kind:'edge',field:'poolAddress'}]);
  const changed=structuredClone(first);changed.binding.flow.steps[0].decode.splice(1,1);
  assert(set(changed).get('descriptor.poolKey.fee').every(v=>v.kind!=='pool-id-tuple'));
  const reordered=structuredClone(first),tuple=reordered.execution.steps[0].frame.callback.steps.find(r=>r.call?.signature.includes('currency0')).call.args[0];
  [tuple.currency0,tuple.currency1]=[tuple.currency1,tuple.currency0];
  assert(set(reordered).get('descriptor.poolKey.fee').every(v=>v.kind!=='pool-id-tuple'));
});
test('actual direct pool programs use ordered tokens, not the fee/tick-spacing getters used elsewhere in the same JSON',()=>{
  const p=compile(actual('128acb08'));assert.equal(p.recipes.length,2);
  for(const r of p.recipes){const m=map(r);assert.equal(m.get('descriptor.token0')[1].signature,'token0()');assert.equal(m.get('descriptor.token1')[1].signature,'token1()');
    assert.deepEqual(m.get('descriptor.token0')[0].when,[{path:[1],test:'eq',value:true}]);
    assert.equal(m.get('descriptor.token0')[0].yes,'tokenIn');
    assert(!JSON.stringify(r).match(/tickSpacing|fee\(\)/));}
});
test('direction evidence must come from the declared ABI and agree across all active encodings',()=>{
  const d=actual('022c0d9f'),p=d.programs[1],s=map(compile({...d,programs:[p]}).recipes[0]).get('descriptor.token0')[0];
  assert.deepEqual([s.kind,s.when,s.otherwise],['direction-asset',[{path:[0],test:'zero'},{path:[1],test:'positive'}],[{path:[0],test:'positive'},{path:[1],test:'zero'}]]);
  const v=actual('128acb08'),broken=structuredClone(v.programs[0]);broken.execution.steps[0].frame.call.args[1]=false;
  assert(map(compile({...v,programs:[broken]}).recipes[0]).get('descriptor.token0').every(x=>x.kind!=='direction-asset'));
});
