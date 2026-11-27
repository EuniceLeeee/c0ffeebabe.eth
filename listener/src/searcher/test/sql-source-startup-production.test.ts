import test from 'node:test';
import assert from 'node:assert/strict';
import {AbiCoder,Interface,ZeroAddress,keccak256,toBeHex} from 'ethers';
import {prepareSqlSourceStartupInputs} from '../sql-startup-price-input.js';
import {buildSqlEdgeLiveProducer} from '../sql-edge-live-producer.js';
import {sqlDirectionId,type SqlPriceEdge} from '../sql-edge-price-index.js';
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from '../venues/production-family-composition.js';
import {readBlockTouchedStateKeys} from '../blockscan-touched-state.js';
import {createStrictCentralAdapterRuntime} from '../strict-central-adapter-runtime.js';

const a=(n:number)=>toBeHex(n,20),h=(n:number)=>toBeHex(n,32),source={number:123,generation:1,hash:h(123)};
const pool=a(9),other=a(10),token0=a(1),token1=a(2),executor=a(50),origin=a(51);
const factory='0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',router='0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
const abi=new Interface(['function token0() view returns(address)','function token1() view returns(address)',
 'function factory() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)',
 'function getPair(address,address) view returns(address)','function getAmountsOut(uint256,address[]) view returns(uint256[])','function getAmountOut(address,uint256) view returns(uint256)',
 'function poolKeys(bytes25) view returns(address,address,uint24,int24,address)',
 'function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)']);
const manager='0x000000000004444c5dc75cb358380d2e3de08a90',positionManager='0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',stateView='0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
const tuples=[[token0,token1,500,10,ZeroAddress],[token0,token1,3000,60,ZeroAddress]];
const ids=tuples.map(t=>keccak256(AbiCoder.defaultAbiCoder().encode(['address','address','uint24','int24','address'],t)));
function edge(selector:string,target:string,input:string,output:string,poolId:string|null=null):SqlPriceEdge{
 const row={chainId:1 as const,selector,poolAddress:target,tokenIn:input,tokenOut:output,poolId,
  poolNamespace:poolId?'contract-pool-id':null,tokenInId:null,tokenOutId:null,candidateInstanceKey:''};
 row.candidateInstanceKey=sqlDirectionId(row);return row;
}
const revert=()=>{throw Object.assign(Error('execution reverted'),{code:'CALL_EXCEPTION',data:'0x'});};
function fixture(ambiguous=false){const reads=new Map<string,number>();return {reads,
 readCode:async(_target:string)=>'0x6000',
 async read(to:string,data:string){const key=to+data;reads.set(key,(reads.get(key)??0)+1);const parsed=abi.parseTransaction({data});
  if(!parsed)return revert();const {name,args,fragment}=parsed;
  let value:unknown[];
  if(to===positionManager&&name==='poolKeys'){const i=ids.findIndex(id=>id.slice(0,52)===args[0]);if(i<0)return revert();value=tuples[i]!;}
  else if(to===stateView&&name==='getSlot0'){assert(ids.includes(args[0]));value=[1n<<96n,0,0,500];}
  else if((to===pool||to===other)&&name==='token0')value=[token0];
  else if((to===pool||to===other)&&name==='token1')value=[token1];
  else if((to===pool||to===other||to===router)&&name==='factory')value=[factory];
  else if((to===pool||to===other)&&name==='getReserves')value=[1000000n,2000000n,0];
  else if(to===factory&&name==='getPair')value=[pool];
  else if(to===router&&name==='getAmountsOut'){const amount=BigInt(args[0]);value=[[amount,amount*997n*2000000n/(1000000n*1000n+amount*997n)]];}
  else if(ambiguous&&to===pool&&name==='getAmountOut')value=[1000n];
  else return revert();return abi.encodeFunctionResult(fragment,value);
 }};}
function rootFor(edges:SqlPriceEdge[],ready:Awaited<ReturnType<typeof prepareSqlSourceStartupInputs>>,pin=source){
 const funding=catalog.listAll().find(f=>f.plugin.manifest.domain==='funding')!.plugin.manifest;
 return buildSqlEdgeLiveProducer({edges,source:pin,currentHead:pin.number,swapTableSha256:'a'.repeat(64),fundingTableSha256:'b'.repeat(64),
  fundingAssets:[{familyId:funding.familyId,asset:token0,binding:{chainId:1,provider:a(80),asset:token0,selector:'0x12345678',signature:'fixture()'}}],
  materialized:ready.materialized,unavailable:ready.unavailable});
}
async function selectedVariants(root:ReturnType<typeof rootFor>['runtimeRoot'],graph:ReturnType<typeof rootFor>['graph']){
 const no=async()=>{throw Error('prepared session must not repeat identity reads');};
 const session=await root.createSession({source,kind:'exact',requiredEdgeIds:new Set(graph.map(e=>e.canonicalEdgeId!)),fundingAssets:[],
  runtime:createStrictCentralAdapterRuntime({executor,transactionOrigin:origin,generationFence:{assertCurrent(){}},provider:{getCode:no,getStorage:no,call:no}})});
 return graph.map(e=>session.executionVariantIds(e));
}
test('source-only startup issues two directions of one V2 pool without conflicting instances, shares reads and refreshes both',async()=>{
 const edges=[edge('0x022c0d9f',pool,token0,token1),edge('0x022c0d9f',pool,token1,token0)],io=fixture();
 const ready=await prepareSqlSourceStartupInputs({edges,source,executor,transactionOrigin:origin,concurrency:2,...io});
 assert.deepEqual(ready.unavailable,[]);assert.equal(ready.materialized.length,2);assert.equal(ready.trials.ids.size,0);
 assert.notEqual(ready.materialized[0]!.instance.instanceKey,ready.materialized[1]!.instance.instanceKey);
 assert([...io.reads.values()].every(n=>n===1),'same pinned getter is cached across directions');
 const {runtimeRoot:root,graph}=rootFor(edges,ready);assert.equal(graph.length,2);
 const variants=await selectedVariants(root,graph);assert(variants.every(v=>v.length===1));
 graph.forEach((g,i)=>assert.deepEqual(new Set(ready.markets.get(g.canonicalEdgeId!)!.variants.keys()),new Set(variants[i])));
 assert.deepEqual(new Set(root.sqlPoolTouches({kind:'call',target:pool,data:'0x022c0d9f'}).legIds),new Set(edges.map(e=>e.candidateInstanceKey)));
 assert.deepEqual(root.sqlPoolTouches({kind:'call',target:token0,data:'0x'}).legIds,[]);
 const next={number:124,generation:2,hash:h(124)};
 assert.throws(()=>rootFor(edges,ready,next),/source|generation/i,'startup proof cannot stand in for the next block');
 const fresh=await prepareSqlSourceStartupInputs({edges,source:next,executor,transactionOrigin:origin,concurrency:2,...fixture()});
 assert.equal(rootFor(edges,fresh,next).graph.length,2);
});
test('actual startup rejects a pool whose identity tokens are identical or reversed instead of issuing execution',async()=>{
 const edges=[edge('0x022c0d9f',pool,token0,token1),edge('0x022c0d9f',pool,token1,token0)];
 const broken={
  readCode:async()=> '0x6000',
  read:async(_to:string,data:string)=>{
   const parsed=abi.parseTransaction({data})!;
   return abi.encodeFunctionResult(parsed.fragment,[token0]);
  },
 };
 for(const ordered of [edges,[...edges].reverse()]){
  const ready=await prepareSqlSourceStartupInputs({edges:ordered,source,executor,transactionOrigin:origin,concurrency:2,...broken});
  assert.equal(ready.materialized.length,0);assert.equal(ready.markets.size,0);assert.equal(ready.unavailable.length,2);
  assert(ready.unavailable.every(x=>/identity tokens must be distinct|identity token direction differs/.test(x.reason)));
 }
 const lazy=await prepareSqlSourceStartupInputs({edges:[edge('0x48c89491',manager,ZeroAddress,'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',ids[0]!),...edges],source,executor,transactionOrigin:origin,concurrency:2});
 assert.equal(lazy.materialized.length,0);
 assert.equal(lazy.markets.size,2);
 assert.equal(lazy.unavailable.length,1);
 assert.match(lazy.unavailable[0]!.reason,/collapses the direction/);
});
test('source-only V4 startup preserves full manager/poolId namespaces and touches only both directions of that pool',async()=>{
 const edges=[edge('0x48c89491',manager,token0,token1,ids[0]!),edge('0x48c89491',manager,token1,token0,ids[0]!),edge('0x48c89491',manager,token0,token1,ids[1]!)];
 const ready=await prepareSqlSourceStartupInputs({edges,source,executor,transactionOrigin:origin,concurrency:3,...fixture()});
 assert.deepEqual(ready.unavailable,[]);assert.equal(ready.materialized.length,3);
 const {runtimeRoot:root,graph}=rootFor(edges,ready);assert.equal(graph.length,3);assert((await selectedVariants(root,graph)).every(x=>x.length===1));
 const event=new Interface(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']);
 const log={address:manager,...event.encodeEventLog('Swap',[ids[0],a(60),-1,2,1n<<96n,5,0,500])};
 assert.deepEqual(new Set(root.sqlPoolTouches({kind:'log',...log}).legIds),new Set(edges.slice(0,2).map(e=>e.candidateInstanceKey)));
 assert.deepEqual(root.sqlPoolTouches({kind:'call',target:manager,data:'0x48c89491'}).legIds,[]);
 const next={number:124,generation:2,hash:h(124)};
 const touched=await readBlockTouchedStateKeys({getLogs:async()=>[{...log,blockHash:next.hash}],send:async()=>{throw Error('offline');}},next.number,manager,
  {hash:next.hash,parentHash:source.hash,transactionHashes:[],passiveTouchedAddresses:[]},{previousSource:source,readHeader:async()=>{throw Error('extra header');}},root.resolveBlockTouchedStateKeys,{mode:'logs'});
 const plan=root.sqlPoolPriceRefreshPlan(touched,source,next)!;assert(plan);
 assert.deepEqual(graph.map(g=>plan.shouldRefresh(g)),[true,true,false]);
 const bad={...edge('0x48c89491',manager,token0,token1,ids[0]!),poolNamespace:'wrong-namespace'};
 const rejected=await prepareSqlSourceStartupInputs({edges:[bad],source,executor,transactionOrigin:origin,concurrency:1,...fixture()});
 assert.equal(rejected.materialized.length,0);assert.equal(rejected.unavailable.length,1);
});
