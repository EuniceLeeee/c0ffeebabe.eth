import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Interface,toBeHex} from 'ethers';
import {normalizeSelectorNativeExecutionDefinition} from '../venues/selector-native-definition.js';
import {compileSqlTrialLegs} from '../venues/selector-native-sql-trial.js';
import {createSelectorSourceCallWitnessReader} from '../venues/selector-source-call-witness.js';
import {issueSelectorSourceRoutes} from '../venues/selector-source-issued-route.js';
import {issuedSqlTrialVariant} from '../venues/selector-native-sql-live-materializer.js';
import {sqlTrialVariantId} from '../sql-trial-variant.js';
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from '../venues/production-family-composition.js';
import {buildSqlEdgeLiveProducer} from '../sql-edge-live-producer.js';
import {sqlDirectionId} from '../sql-edge-price-index.js';
import {readBlockTouchedStateKeys} from '../blockscan-touched-state.js';
const a=(n:number)=>toBeHex(n,20),h=(n:number)=>toBeHex(n,32);
const [user,router,pool,coin0,coin1,executor]=[1,2,3,4,5,6].map(a);
const anchor=h(100),source={number:123,hash:anchor,generation:8};
const erc20=new Interface(['function transfer(address,uint256) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const v3=new Interface(['function swap(address,bool,int256,uint160,bytes) returns(int256,int256)',
 'function uniswapV3SwapCallback(int256,int256,bytes)',
 'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)']);
async function v3Input(reverse:boolean){
 const definition=normalizeSelectorNativeExecutionDefinition(JSON.parse(readFileSync(new URL('../venues/selector-native/selector-128acb08-family/selector-128acb08.json',import.meta.url),'utf8')));
 const tokenIn=reverse?coin1:coin0,tokenOut=reverse?coin0:coin1,txHash=h(reverse?201:200);
 const edge={chainId:1,selector:'0x128acb08',poolAddress:pool,poolId:null,tokenIn,tokenOut};
 const tx={hash:txHash,from:user,to:router,blockNumber:'0x7b',blockHash:anchor,transactionIndex:'0x0',chainId:'0x1',value:'0x0',input:'0x12345678'};
 const amount0=reverse?-99n:21n,amount1=reverse?21n:-99n;
 const events=[{address:tokenOut,...erc20.encodeEventLog('Transfer',[pool,router,99n])},
  {address:tokenIn,...erc20.encodeEventLog('Transfer',[router,pool,21n])},
  {address:pool,...v3.encodeEventLog('Swap',[router,router,amount0,amount1,123n,456n,7])}];
 const logs=events.map((l,i)=>({...l,index:toBeHex(i),position:i===2?'0x2':'0x0'}));
 const action={type:'CALL',from:router,to:pool,input:v3.encodeFunctionData('swap',[router,!reverse,21n,reverse?1000n:100n,'0x']),
  output:v3.encodeFunctionResult('swap',[amount0,amount1]),logs:[logs[2]],calls:[
   {type:'CALL',from:pool,to:tokenOut,input:erc20.encodeFunctionData('transfer',[router,99n]),output:toBeHex(1,32),logs:[logs[0]]},
   {type:'CALL',from:pool,to:router,input:v3.encodeFunctionData('uniswapV3SwapCallback',[amount0,amount1,'0x']),calls:[
    {type:'CALL',from:router,to:tokenIn,input:erc20.encodeFunctionData('transfer',[pool,21n]),output:toBeHex(1,32),logs:[logs[1]]}]}]};
 const receipt={transactionHash:txHash,from:user,to:router,status:'0x1',blockNumber:tx.blockNumber,blockHash:anchor,transactionIndex:'0x0',
  logs:events.map((l,i)=>({...l,logIndex:toBeHex(i+100),blockHash:anchor,blockNumber:tx.blockNumber,transactionHash:txHash,transactionIndex:'0x0',removed:false}))};
 const reader=createSelectorSourceCallWitnessReader({async send(method){
  if(method==='debug_traceTransaction')return {type:'CALL',from:user,to:router,input:tx.input,calls:[action]};
  return method==='eth_getBlockByNumber'?{number:tx.blockNumber,hash:anchor,transactions:[txHash]}:method==='eth_getTransactionByHash'?tx:receipt;
 }});
 const sourceWitness=await reader({txHash,callPath:'0',edge,source});
 let getterReads=0,codeReads=0;
 const input={catalog,definition,edge:{...edge,executionParamEvidence:sourceWitness.executionParamEvidence},source,executor,transactionOrigin:user,sourceWitness,
  read:async()=>{getterReads++;throw Error('old binding getter forbidden');},readCode:async(at:string)=>{assert.equal(at,pool);codeReads++;return '0x6001600055';}};
 return {input,counts:()=>({getterReads,codeReads})};
}
for(const reverse of [false,true])test(`V3 independent withLog witness issues startup-identical formal programs, reverse=${reverse}`,async()=>{
 const {input:x,counts}=await v3Input(reverse),trial=compileSqlTrialLegs(x),issued=await issueSelectorSourceRoutes(x);
 assert.equal(trial.legs.length,1,trial.issues.join('; '));assert.equal(issued.alternatives.length,1,issued.issues.join('; '));
 assert.equal(counts().getterReads,0);assert(counts().codeReads>0);
 for(const i of issued.alternatives){
  assert.equal(i.program,trial.legs.find(t=>t.programKey===i.programKey)!.leg.program);
  assert.equal(issuedSqlTrialVariant(i.instance,i.routeKey,i.programKey),sqlTrialVariantId(i.programKey,i.program));
  const family=catalog.forFamily(i.instance.familyId),r=i.instance.routes.find(r=>r.routeKey===i.routeKey)!;
  assert.equal(family.plugin.routes.pricingPools!({descriptor:i.instance.descriptor,route:r})[0]!.poolAddress,pool);
  assert.equal(family.plugin.pricing.refreshPolicyForInstance!({descriptor:{instance:i.instance.descriptor}} as never),'on-touch');
  assert.equal((i.instance.descriptor as any).proof.rounds.length,0);
 }
 await assert.rejects(issueSelectorSourceRoutes({...x,sourceWitness:structuredClone(x.sourceWitness)}));
 await assert.rejects(issueSelectorSourceRoutes({...x,edge:{...x.edge,tokenIn:x.edge.tokenOut,tokenOut:x.edge.tokenIn}}));
});
test('V3 two source-issued directions share the production pool touch key, not unrelated token activity',async()=>{
 const inputs=await Promise.all([v3Input(false),v3Input(true)]),issued=await Promise.all(inputs.map(x=>issueSelectorSourceRoutes(x.input)));
 const edges=inputs.map(({input:x})=>{const edge={...x.edge,poolNamespace:null,tokenInId:null,tokenOutId:null,candidateInstanceKey:''};
  edge.candidateInstanceKey=sqlDirectionId(edge);return edge;});
 const fund=catalog.listAll().find(f=>f.plugin.manifest.domain==='funding')!.plugin.manifest;
 const {runtimeRoot:root,graph}=buildSqlEdgeLiveProducer({edges,source,currentHead:source.number,
  swapTableSha256:'a'.repeat(64),fundingTableSha256:'b'.repeat(64),unavailable:[],
  fundingAssets:[{familyId:fund.familyId,asset:coin0,binding:{chainId:1,provider:a(9),asset:coin0,selector:'0x12345678',signature:'fixture()'}}],
  materialized:issued.map((r,i)=>({...r.alternatives[0]!,sqlEdgeKey:edges[i]!.candidateInstanceKey}))});
 assert.equal(graph.length,2);const ids=edges.map(e=>e.candidateInstanceKey).sort(),target={number:124,hash:h(101),generation:9};
 const refresh=async(logs:{address:string;topics:readonly string[];data:string}[])=>{
  const touched=await readBlockTouchedStateKeys({getLogs:async()=>logs.map(l=>({...l,blockHash:target.hash})),send:async()=>{throw Error('offline only');}},
   target.number,pool,{hash:target.hash,parentHash:source.hash,transactionHashes:[],passiveTouchedAddresses:[]},
   {previousSource:source,readHeader:async()=>{throw Error('unexpected header');}},root.resolveBlockTouchedStateKeys,{mode:'logs'});
  const plan=root.sqlPoolPriceRefreshPlan(touched,source,target)!;return graph.filter(e=>plan.shouldRefresh(e)).map(e=>e.canonicalEdgeId).sort();
 };
 assert.deepEqual(await refresh([]),[]);
 assert.deepEqual(await refresh([{address:coin0,...erc20.encodeEventLog('Transfer',[user,router,7n])}]),[]);
 assert.deepEqual(await refresh([{address:coin0,...erc20.encodeEventLog('Transfer',[user,pool,7n])}]),ids);
 assert.deepEqual(await refresh([{address:coin1,...erc20.encodeEventLog('Transfer',[pool,user,7n])}]),ids);
 assert.deepEqual(await refresh([{address:a(12),...erc20.encodeEventLog('Transfer',[user,pool,7n])}]),[]);
 assert.deepEqual(root.sqlPoolTouches({kind:'call',target:pool,data:'0x128acb08'}).legIds.slice().sort(),ids);
 assert.deepEqual(root.sqlPoolTouches({kind:'call',target:coin0,data:'0x12345678'}).legIds,[]);
});
