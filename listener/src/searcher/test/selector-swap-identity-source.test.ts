import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {AbiCoder,Interface,keccak256,toBeHex,ZeroAddress} from 'ethers';
import {normalizeSelectorNativeExecutionDefinition as normalize} from '../venues/selector-native-definition.js';
import {selectorExecutionPrograms,selectSingleExecution} from '../venues/selector-program-role.js';
import {readSelectorSourceIdentity,assertSelectorSourceIdentity} from '../venues/selector-source-identity.js';
import type {AdapterRequest} from '../venues/adapter-request-program.js';

const address=(v:number)=>toBeHex(v,20),source={number:27000000,hash:toBeHex(101,32),generation:1},
 t0=address(1),t1=address(2),manager='0x000000000004444c5dc75cb358380d2e3de08a90',
 positionManager='0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',weth='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
 abi=AbiCoder.defaultAbiCoder();

const iface=new Interface([
 'function token0() view returns(address)',
 'function token1() view returns(address)',
 'function gem() view returns(address)',
 'function dai() view returns(address)',
 'function poolKeys(bytes25) view returns(address,address,uint24,int24,address)',
]);

type Answer=(r:AdapterRequest,name:string,args:readonly any[])=>readonly any[]|string|undefined;
const load=(tag:string,file:string)=>JSON.parse(readFileSync(new URL('../venues/selector-native/selector-'+tag+'-family/'+file,import.meta.url),'utf8'));

async function run(tag:string,pool:string,answer:Answer,tokenIn=t0,tokenOut=t1,poolId?:string,hookData?:string){
 const def=normalize(load(tag,'selector-'+tag+'.json')),idSource=load(tag,'identity.source.json');
 assert.equal(idSource.format,'identity-options/v1');
 const legs=selectorExecutionPrograms(def);
 assert.equal(legs.length,1);
 const single=selectSingleExecution(def);
 assert.equal(single.program.type,'execution');
 assert.equal(single.program.binding,undefined);
 const identities=def.programs.filter(p=>p.type==='independentIdentity');
 assert.equal(identities.length,idSource.options.length);
 assert(identities.every(p=>!p.routes&&!p.execution&&!p.projection&&!('executionProgramKeys' in p)));
 const edge={chainId:1 as const,selector:'0x'+tag,poolAddress:pool,tokenIn,tokenOut,
  ...(poolId?{poolId,poolNamespace:'contract-pool-id'}:{}),...(hookData!==undefined?{hookData}:{})};
 const result=await readSelectorSourceIdentity({definition:def,edge,source,readRequests:async requests=>requests.map(r=>{
  const tx=r.kind==='eth-call'?iface.parseTransaction({data:r.data}):null;
  const name=r.kind==='eth-call'?tx?.signature??'unsupported':r.kind,
   val=answer(r,name,tx?.args??[]),data=typeof val==='string'?val:val&&tx?iface.encodeFunctionResult(tx.fragment,val):'0x';
  return {id:r.id,ok:true,source,completion:val===undefined?'reverted-as-declared':'returned',data,provenance:{kind:'local-fixture',fingerprint:toBeHex(1,32)}};
 })});
 for(const m of result.matches)assertSelectorSourceIdentity(m,{definition:def,edge,source,programKey:single.programKey});
 return {directions:result.matches.map(m=>m.direction),matches:result.matches,issues:result.issues};
}

for(const tag of ['022c0d9f','128acb08'])test(`pair identity (${tag}) resolves token0/token1 order and rejects invalid pools`,async()=>{
 const pairAns=(a=t0,b=t1):Answer=>(_r,n)=>n==='token0()'?[a]:n==='token1()'?[b]:undefined;
 assert.deepEqual((await run(tag,address(9),pairAns(),t0,t1)).directions,['token0-in-token1-out']);
 assert.deepEqual((await run(tag,address(9),pairAns(),t1,t0)).directions,['token1-in-token0-out']);
 assert.deepEqual((await run(tag,address(9),pairAns(),address(99),t1)).directions,[]);
 assert.deepEqual((await run(tag,address(9),pairAns(t0,t0),t0,t1)).directions,[]);
 assert.deepEqual((await run(tag,address(9),pairAns(ZeroAddress,t1),ZeroAddress,t1)).directions,[]);
});

test('PSM sellGem (95991276) and buyGem (8d7ef9bb) confirm fixed gem/dai directions',async()=>{
 const psmAns:Answer=(_r,n)=>n==='gem()'?[t0]:n==='dai()'?[t1]:undefined;
 assert.deepEqual((await run('95991276',address(10),psmAns,t0,t1)).directions,['sell-gem']);
 assert.deepEqual((await run('95991276',address(10),psmAns,t1,t0)).directions,[]);
 assert.deepEqual((await run('8d7ef9bb',address(10),psmAns,t1,t0)).directions,['buy-gem']);
 assert.deepEqual((await run('8d7ef9bb',address(10),psmAns,t0,t1)).directions,[]);
});

const kt=['address','address','uint24','int24','address'];
function v4(tuple:any[],actual:string):Answer{
 return (r,n,args)=>{
  if(r.kind!=='eth-call')return;
  if(n==='poolKeys(bytes25)'&&r.to.toLowerCase()===positionManager&&args[0]===actual.slice(0,52))return tuple;
  return undefined;
 };
}

test('V4 identity confirms full poolId keccak commitment, native currency direction, and hooked pools with hookData',async()=>{
 const nativeTuple=[ZeroAddress,t1,68,1,ZeroAddress],nativeId=keccak256(abi.encode(kt,nativeTuple)),nativeAns=v4(nativeTuple,nativeId);
 assert.deepEqual((await run('48c89491',manager,nativeAns,ZeroAddress,t1,nativeId)).directions,['currency0-in-currency1-out']);
 assert.deepEqual((await run('48c89491',manager,nativeAns,t1,ZeroAddress,nativeId)).directions,['currency1-in-currency0-out']);
 assert.deepEqual((await run('48c89491',manager,nativeAns,weth,t1,nativeId)).directions,[]);
 const tampered=nativeId.slice(0,-2)+(nativeId.endsWith('00')?'01':'00');
 assert.deepEqual((await run('48c89491',manager,nativeAns,ZeroAddress,t1,tampered)).directions,[]);

 const hook=address(0x888),hookTuple=[t0,t1,3000,60,hook],hookId=keccak256(abi.encode(kt,hookTuple)),hookAns=v4(hookTuple,hookId);
 const r=await run('48c89491',manager,hookAns,t0,t1,hookId,'0xbeadedbeadeadbeadedbeadeddeabeadbeadbeadbeadadedbeadeddeabeadaed');
 assert.deepEqual(r.directions,['currency0-in-currency1-out']);
 assert.equal(r.matches[0]!.binding.poolKey.hooks,hook);
});
