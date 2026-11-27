import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AbiCoder,solidityPackedKeccak256,dataSlice,getAddress,toBeHex} from 'ethers';
import {bindSelectorNativeMath} from '../venues/selector-native-math.js';
import {normalizeSelectorFamilyDefinition} from '../venues/selector-family-definition.js';
const root=fileURLToPath(new URL('../venues/selector-native/',import.meta.url));
const definitions=readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>normalizeSelectorFamilyDefinition(JSON.parse(readFileSync(resolve(root,d.name,d.name.replace(/-family$/,'')+'.json'),'utf8'))));
const programs=definitions.flatMap(doc=>doc.domain==='funding'?[]:doc.programs);
const models=new Map<string,any>();
for(const p of programs)for(const m of p.math?.models??[]){
 const previous=models.get(m.id);if(previous)assert.deepEqual(m,previous,'inline model identity must preserve semantics');models.set(m.id,m);
}
const get=(id:string)=>{const model=models.get(id);assert(model,'missing migrated inline value calculation');return bindSelectorNativeMath({version:1,entries:{value:{model:id,version:1}},models:[model]}).value!;};
const address=(n:string)=>'0x'+n.repeat(40);
test('all installed native parameter model bindings are self-contained data',()=>{
 for(const id of ['balancer-v1:sum-weights','ekubo:core-swap-log','fluid-credit:config-state','fluid-credit:max-borrow-request'])assert(models.has(id),id);
 for(const p of programs)if(p.math)assert.doesNotThrow(()=>bindSelectorNativeMath(p.math));
});
test('inline models reject I/O, functions, missing handlers and imported models',()=>{
 const model={id:'sample',version:1,program:[{return:{op:'sumUint',args:['$input']}}]},data:any={version:1,entries:{value:{model:'sample',version:1}},models:[model]};
 assert.equal(bindSelectorNativeMath(data).value!([1n,2n]),3n);
 for(const op of ['result','returned','programReceipt','simulationActor','model','decodeCanonical'])assert.throws(()=>bindSelectorNativeMath({...data,models:[{...model,program:[{return:{op,args:['input']}}]}]}),/pure/);
 assert.throws(()=>bindSelectorNativeMath({...data,models:[{...model,handler:()=>1n}]}));assert.throws(()=>bindSelectorNativeMath({...data,models:[]}));assert.throws(()=>bindSelectorNativeMath({...data,models:[model,model]}),/duplicate/);
});
test('checked uint sum keeps eight-weight bound and overflow behavior',()=>{
 const sum=get('balancer-v1:sum-weights');assert.equal(sum([1n,3n,5n]),9n);assert.equal(sum([]),0n);
 assert.throws(()=>sum(Array(9).fill(1n)));assert.throws(()=>sum([-1n]));assert.throws(()=>sum([1]));assert.throws(()=>sum([(1n<<256n)-1n,1n]));
});
test('signed packed flow binds payment to the opposite receipt',()=>{
 const fn=get('ekubo:core-swap-log'),pack=(a:bigint,b:bigint)=>({balanceUpdate:toBeHex((BigInt.asUintN(128,a)<<128n)|BigInt.asUintN(128,b),32)});
 assert.deepEqual(fn(pack(15n,-27n)),{delta0:15n,delta1:-27n,isToken1:false,directed:true,amountIn:15n,amountOut:27n});
 assert.deepEqual(fn(pack(-18n,33n)),{delta0:-18n,delta1:33n,isToken1:true,directed:true,amountIn:33n,amountOut:18n});
 assert.equal((fn(pack(0n,0n)) as any).directed,false);assert.throws(()=>fn(pack(1n,1n)));assert.throws(()=>fn(pack(-1n,-1n)));assert.throws(()=>fn({balanceUpdate:'0x01'}));
});
test('unused proxy identity models stay outside the production selector declaration',()=>{
 assert.equal(models.has('oneswap:proxy'),false);
 const d=definitions.find(doc=>doc.selector==='0xa6e81533')!;assert(d.domain!=='funding');
 const program=d.programs[0]!;assert.equal(program.math,undefined);
 const binding=JSON.stringify(program.binding);assert(!binding.includes('get-code'));assert(!binding.includes('"model"'));
 assert(binding.includes(':stock')&&binding.includes(':money'),'actual token getters remain bound');
});
