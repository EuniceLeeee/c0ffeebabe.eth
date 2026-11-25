import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {Interface} from '../listener/node_modules/ethers/lib.esm/abi/interface.js';
import {buildSqlExecutionFrameIndex,resolveSqlExecutionTraceParams} from './selector-execution-param-trace.mjs';

// Mainnet 26,205,129, tx 0x4595614bf4e4e5c484da9c9e094a50f4ab3a5232370c9347d8620c90bfdb4c1f.
// Only frames needed by this example. Entry/parent need just their selector.
const manager='0x000000000004444c5dc75cb358380d2e3de08a90',actor='0x0000000aa232009084bd71a5797d089aa4edfad4';
const poolId='0xe500210c7ea6bfd9f69dce044b09ef384ec2b34832f132baec3b418208e3a657';
const edge={selector:'0x48c89491',poolAddress:manager,selectorTarget:manager,poolId,callPath:'0',innerSwapPath:'0,0,4'};
const frame=(path,target,input,ok=true)=>({path,target,input,kind:'call',ok});
const inner='0xf3cd914c' + [
  '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0000000000000000000000000000000000000000000000000000000000800000','000000000000000000000000000000000000000000000000000000000000000a',
  '0000000000000000000000000000000aa232009084bd71a5797d089aa4edfad4','0000000000000000000000000000000000000000000000000000000000000000',
  'fffffffffffffffffffffffffffffffffffffffffffffffffdc9f0c1c33d8000','000000000000000000000000fffd8963efd1fc6a506488495d951d5263988d25',
  '0000000000000000000000000000000000000000000000000000000000000120','0000000000000000000000000000000000000000000000000000000000000000'].join('');
const frames=[frame('',actor,'0x09c5eabe'),frame('0',manager,'0x48c89491'),frame('0,0',actor,'0x91dd7346'),frame('0,0,4',manager,inner)];
const definition=JSON.parse(readFileSync(new URL('../listener/src/searcher/venues/selector-native/selector-48c89491-family/selector-48c89491.json',import.meta.url)));
const call=definition.programs[0].execution.steps[0].frame.callback.steps.find(s=>s.call?.signature?.includes('currency0')).call;
const sig=call.signature,types=['address','address','uint24','int24','address'];
const src={kind:'pool-id-tuple',signature:sig,path:[0],types,member:2};
function run(requirements,fs=frames,e=edge){return resolveSqlExecutionTraceParams({edge:e,index:buildSqlExecutionFrameIndex(fs),recipe:{requirements}});}
const req=(key,...sources)=>({key,sources});
test('JSON fixed parameters win; variable amount/actor stays with the runtime',()=>{
  const result=run([req('maxBorrow',{kind:'fixed',value:10000},src),req('amount',{kind:'runtime',field:'amountIn'},src),req('owner',{kind:'runtime',field:'executor'}),req('other',{kind:'getter',signature:'balanceOf(address)'})]);
  assert.deepEqual(result.values,[{key:'maxBorrow',value:10000,kind:'fixed'}]);
  assert.deepEqual(result.runtime,[{key:'amount',fields:['amountIn']},{key:'owner',fields:['executor']}]);
  assert.deepEqual(result.unresolved,[{key:'other',reason:'source-block-read-not-proven-immutable'}]);
});
test('ABI declaration and keccak of exact original frame link the entire tuple, not an adjacent swap',()=>{
  const fields=['currency0','currency1','fee','tickSpacing','hooks'];
  const requirements=fields.map((f,member)=>req(f,{...src,member}));
  const out=run(requirements);
  assert.deepEqual(out.values.map(v=>v.value),['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2','8388608','10',actor]);
  assert.deepEqual(out.unresolved,[]);
  for(const [fs,e] of [
    [frames,{...edge,poolId:'0x'+'11'.repeat(32)}],[frames,{...edge,innerSwapPath:'0,0,7'}],[frames,{...edge,selectorTarget:actor}],
    [frames,{...edge,conflictingFlow:{tokenIn:'wrong'}}],[[...frames,frames[1]],edge],[frames.filter(f=>f.path!=='0,0'),edge],
    [frames.map(f=>f.path==='0,0'?{...f,ok:false}:f),edge],[frames.map(f=>f.path==='0,0'?{...f,target:manager,input:edge.selector}:f),edge],
    [frames.map(f=>f.path==='0,0,4'?{...f,kind:'delegatecall'}:f),edge],
    [frames.map(f=>f.path==='0,0,4'?{...f,input:f.input.slice(0,10+64*5-2)}:f),edge],
    [frames,{...edge,poolAddress:actor}],
  ]) assert.equal(run(requirements,fs,e).values.length,0);
  assert.equal(run([req('untyped',{...src,types:['address','address','int24','int24','address']})]).values.length,0);
});
test('only explicitly nominated bound scalar on the named frame; no fuzzy selector or bytes scan',()=>{
  const signature='function bind(uint256 classId,bytes proof,address who)',abi=new Interface([signature]);
  const input=abi.encodeFunctionData('bind',[42,'0x0021',actor]);
  const f=[frame('',manager,input)],e={selector:input.slice(0,10),selectorTarget:manager,poolAddress:manager,callPath:'',innerSwapPath:null};
  const arg={kind:'argument',role:'bound',signature,frame:'entry',path:[0]};
  assert.deepEqual(run([req('id',arg),req('proof',{...arg,path:[1]}),req('receiver',{...arg,path:[2],role:'recipient'})],f,e).values,[{key:'id',value:'42',kind:'argument'}]);
  assert.equal(run([req('id',arg)],f,{...e,callPath:'1'}).values.length,0);
  // A full ABI selected by the query may be carried alongside the old projected prefix.
  assert.equal(run([req('id',arg)],[{...f[0],input:e.selector,fullInput:input}],e).values[0].value,'42');
  assert.equal(run([req('id',arg)],[{...f[0],input:input.slice(0,-8)}],e).values[0].value,'42');
});
test('do not convert malformed bool, padded address or too-wide integer into parameter evidence',()=>{
  const sig='function nominate(bool,address,int24,uint8)',abi=new Interface([sig]);
  const selector=abi.getFunction('nominate').selector,e={selector,selectorTarget:manager,poolAddress:manager,callPath:''};
  const words=['2'.padStart(64,'0'),'1'.padEnd(64,'0'),'ffffff'.padStart(64,'0'),'100'.padStart(64,'0')];
  const r=run(words.map((_,i)=>req(String(i),{kind:'argument',role:'bound',frame:'entry',signature:sig,path:[i]})),[frame('',manager,selector+words.join(''))],e);
  assert.equal(r.values.length,0);assert.equal(r.unresolved.length,4);
});
test('different candidate observations cannot be reconciled by overwriting a value',()=>{
  const alt={...src,member:3};
  assert.deepEqual(run([req('field',src,alt)]).unresolved,[{key:'field',reason:'conflicting-static-evidence'}]);
  assert.deepEqual(run([req('fixed',{kind:'fixed',value:0},{kind:'fixed',value:1})]).unresolved,[{key:'fixed',reason:'conflicting-fixed-declarations'}]);
});
test('use only the endorsed direction predicate, not a past amount or address from calldata',()=>{
  const tokenIn='0x'+'11'.repeat(20),tokenOut='0x'+'22'.repeat(20),signature='function path(address destination,bool dir,uint256 amount,bytes rest)';
  const abi=new Interface([signature]),sel=abi.getFunction('path').selector;
  const e={selector:sel,selectorTarget:manager,poolAddress:manager,callPath:'',tokenIn,tokenOut};
  const d={kind:'direction-asset',signature,frame:'entry',when:[{path:[1],test:'eq',value:true}],otherwise:[{path:[1],test:'eq',value:false}],yes:'tokenIn',no:'tokenOut'};
  const input=(dir)=>abi.encodeFunctionData('path',[actor,dir,99999,'0x1a']);
  const side=(v,r=d,e1=e)=>run([req('asset',r)],[frame('',manager,v)],e1).values[0]?.value;
  assert.equal(side(input(true)),tokenIn);assert.equal(side(input(false)),tokenOut);
  assert.equal(side(input(true),{...d,otherwise:d.when}),undefined);
  assert.equal(side(input(true),d,{...e,tokenIn:'0x'+'00'.repeat(20)}),undefined);
  assert.equal(side(input(true),d,{...e,poolAddress:actor}),undefined);
  assert.equal(side(input(true),d,{...e,conflictingFlow:{}}),undefined);
  const head=input(true).slice(0,10+64*2);assert.equal(side(head),tokenIn);
  assert.equal(side(head.slice(0,-1)+'2'),undefined);
  const amountGuard={...d,when:[{path:[2],test:'eq',value:99999}],otherwise:[{path:[2],test:'eq',value:0}]};
  assert.equal(side(input(true),amountGuard),undefined);
  assert.equal(run([req('asset',{kind:'fixed',value:actor},d)],[frame('',manager,input(true))],e).values[0]?.value,actor);
});
test('two complementary uint branches must agree on exactly one supported side; both-positive or neither are unresolved',()=>{
  const tokenIn='0x'+'11'.repeat(20),tokenOut='0x'+'22'.repeat(20),signature='function exchange(uint256 first,uint256 second)',abi=new Interface([signature]);
  const e={selector:abi.getFunction('exchange').selector,selectorTarget:manager,poolAddress:manager,callPath:'',tokenIn,tokenOut};
  const d={kind:'direction-asset',signature,frame:'entry',when:[{path:[0],test:'zero'},{path:[1],test:'positive'}],
    otherwise:[{path:[0],test:'positive'},{path:[1],test:'zero'}],yes:'tokenIn',no:'tokenOut'};
  const side=(a,b,def=d)=>run([req('asset',def)],[frame('',manager,abi.encodeFunctionData('exchange',[a,b]))],e).values[0]?.value;
  assert.equal(side(0,10000),tokenIn);assert.equal(side(1,0),tokenOut);
  assert.equal(side(0,0),undefined);assert.equal(side(40,888),undefined);
  assert.equal(side(0,10,{...d,otherwise:[d.otherwise[1],d.otherwise[1]]}),undefined);
  assert.equal(side(0,10,{...d,otherwise:[d.when[0],d.otherwise[1]]}),undefined);
});
