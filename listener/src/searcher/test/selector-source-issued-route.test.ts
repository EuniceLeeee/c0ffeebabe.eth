import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Interface} from 'ethers';
import {normalizeSelectorNativeExecutionDefinition,selectorNativeProgramKey} from '../venues/selector-native-definition.js';
import {compileSqlExecutionParamPlan} from '../venues/selector-native-execution-param-plan.js';
import {compileSqlTrialLegs} from '../venues/selector-native-sql-trial.js';
import {createSelectorSourceCallWitnessReader} from '../venues/selector-source-call-witness.js';
import {issueSelectorSourceRoutes,SelectorSourceRouteUnavailable} from '../venues/selector-source-issued-route.js';
import {issuedSqlTrialVariant,issueSqlFamilyAlternatives} from '../venues/selector-native-sql-live-materializer.js';
import {sqlTrialVariantId} from '../sql-trial-variant.js';
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from '../venues/production-family-composition.js';
import {buildSqlEdgeLiveProducer} from '../sql-edge-live-producer.js';
import {sqlDirectionId} from '../sql-edge-price-index.js';
import {readBlockTouchedStateKeys} from '../blockscan-touched-state.js';

const a=(x:string)=>'0x'+x.repeat(40),h=(x:string)=>'0x'+x.repeat(64);
const [user,router,pool,tokenIn,tokenOut,pocket,recipient,executor]=['1','2','3','4','5','6','7','8'].map(a);
const txHash=h('a'),anchor=h('b'),source={number:123,hash:anchor,generation:8};
const abi=new Interface(['function sellGem(address,uint256)','event SellGem(address indexed usr,uint256 gemAmt,uint256 fee)']);
const erc20=new Interface(['function transferFrom(address,address,uint256)','function transfer(address,uint256)','event Transfer(address indexed from,address indexed to,uint256 amount)']);
async function input(otherEvent=false){
 const definition=normalizeSelectorNativeExecutionDefinition(JSON.parse(readFileSync(new URL('../venues/selector-native/selector-95991276-family/selector-95991276.json',import.meta.url),'utf8')));
 const base={chainId:1,selector:abi.getFunction('sellGem')!.selector,poolAddress:pool,poolId:null,tokenIn,tokenOut};
 const tx={hash:txHash,from:user,to:router,blockNumber:'0x7b',blockHash:anchor,transactionIndex:'0x0',chainId:'0x1',value:'0x0',input:'0x12345678'};
 const events=[{address:tokenIn,...erc20.encodeEventLog('Transfer',[router,pocket,21n])},
  {address:tokenOut,...erc20.encodeEventLog('Transfer',[pool,recipient,99n])},{address:pool,...(otherEvent
   ?new Interface(['event Swap(address indexed sender,address indexed recipient,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 fee)'])
     .encodeEventLog('Swap',[router,recipient,tokenIn,tokenOut,21n,99n,0n])
   :abi.encodeEventLog('SellGem',[recipient,21n,0n]))}];
 const logs=events.map((l,i)=>({...l,index:'0x'+i.toString(16),position:i===2?'0x2':'0x0'}));
 const action={type:'CALL',from:router,to:pool,input:abi.encodeFunctionData('sellGem',[recipient,21n]),logs:[logs[2]],calls:[
  {type:'CALL',from:pool,to:tokenIn,input:erc20.encodeFunctionData('transferFrom',[router,pocket,21n]),logs:[logs[0]]},
  {type:'CALL',from:pool,to:tokenOut,input:erc20.encodeFunctionData('transfer',[recipient,99n]),logs:[logs[1]]}]};
 const receipt={transactionHash:txHash,from:user,to:router,status:'0x1',blockNumber:tx.blockNumber,blockHash:anchor,transactionIndex:'0x0',
  logs:events.map((l,i)=>({...l,logIndex:'0x'+(100+i).toString(16),blockHash:anchor,blockNumber:tx.blockNumber,transactionHash:txHash,transactionIndex:'0x0',removed:false}))};
 const reader=createSelectorSourceCallWitnessReader({async send(method){
  if(method==='debug_traceTransaction')return {type:'CALL',from:user,to:router,input:tx.input,calls:[action]};
  return method==='eth_getBlockByNumber'?{number:tx.blockNumber,hash:anchor,transactions:[txHash]}:method==='eth_getTransactionByHash'?tx:receipt;
 }});
 const sourceWitness=await reader({txHash,callPath:'0',edge:base,source});
 const executionParamEvidence={consensus:'uniform' as const,definitionSha256:createHash('sha256').update(JSON.stringify(definition)).digest('hex'),txHash,callPath:'0',innerSwapPath:null,
  recipes:compileSqlExecutionParamPlan(definition).recipes.map(({index,requirements})=>({index,observed:[],missing:requirements.filter(r=>!r.sources.some(s=>['runtime','edge','fixed'].includes(s.kind))).map(r=>r.key)}))};
 return {catalog,definition,edge:{...base,executionParamEvidence},source,executor,transactionOrigin:user,sourceWitness,
  read:async()=>{throw Error('OLD BINDING GETTER MUST NOT RUN');},readCode:async()=> '0x6001600055'};
}
test('independently verified nested conversion becomes a real source-bound route without legacy getters',async()=>{
 const x=await input(),trial=compileSqlTrialLegs(x),r=await issueSelectorSourceRoutes(x);
 assert.equal(r.alternatives.length,1,r.issues.join('; '));const issued=r.alternatives[0]!;
 assert.equal(issued.program,trial.legs[0]!.leg.program);
 assert.equal(issuedSqlTrialVariant(issued.instance,issued.routeKey,issued.programKey),sqlTrialVariantId(issued.programKey,issued.program));
 const family=catalog.forFamily(issued.instance.familyId),route=issued.instance.routes[0]!;
 assert.equal(family.plugin.routes.pricingPools!({descriptor:issued.instance.descriptor,route})[0]!.poolAddress,pool);
 assert.equal(family.plugin.pricing.refreshPolicyForInstance!({descriptor:{instance:issued.instance.descriptor}} as never),'on-touch');
 assert.equal(x.definition.programs.find(p=>selectorNativeProgramKey(p)===trial.legs[0]!.programKey)!.refreshPolicy,'on-touch');
 assert.equal(x.definition.programs.filter(p=>p.type==='execution').length,1);
 assert.equal(x.definition.programs.filter(p=>p.type==='independentIdentity').length,1);
 assert(x.definition.programs.filter(p=>p.type==='independentIdentity').every(p=>p.execution===undefined));
 assert.equal((issued.instance.descriptor as any).proof.rounds.length,0);
 await assert.rejects(issueSelectorSourceRoutes({...x,source:{...source,generation:9}}));
 await assert.rejects(issueSelectorSourceRoutes({...x,edge:{...x.edge,tokenIn:tokenOut,tokenOut:tokenIn}}));
 await assert.rejects(issueSelectorSourceRoutes({...x,sourceWitness:structuredClone(x.sourceWitness)}));
 assert.equal(x.sourceWitness.discoveryRuleHash,x.definition.directState!.discoveryRuleHash);
 await assert.rejects(issueSelectorSourceRoutes({...x,definition:{...x.definition,
  directState:{...x.definition.directState!,discoveryRuleHash:'0'.repeat(64)}}}),/another Family discovery rule/);
 for(const loc of [{txHash:h('c')},{callPath:'3,3'},{callPath:'00'},{txHash:h('c'),callPath:'3,3'}]){
  const mismatched={...x,edge:{...x.edge,executionParamEvidence:{...x.edge.executionParamEvidence,...loc}}};
  await assert.rejects(issueSelectorSourceRoutes(mismatched),/locator differs/);
  // The lower-level exported issuer is also fail-closed; wrappers are not authority.
  await assert.rejects(issueSqlFamilyAlternatives(mismatched),/locator differs/);
 }
 await assert.rejects(issueSelectorSourceRoutes({...x,edge:{...x.edge,executionParamEvidence:{...x.edge.executionParamEvidence,
  definitionSha256:'0'.repeat(64)}}}),SelectorSourceRouteUnavailable);
 const empty=await issueSelectorSourceRoutes({...x,readCode:async()=> '0x'});
 assert.equal(empty.alternatives.length,0);
});
test('same entry selector and both successful transfers without the declared event cannot borrow this source profile',async()=>{
 await assert.rejects(input(true),/absent or ambiguous independently discovered action/);
});

test('source-issued PSM uses its declared pool for production refresh and reuses untouched prices',async()=>{
 const x=await input(),issued=await issueSelectorSourceRoutes(x);
 const edge={...x.edge,poolNamespace:null,tokenInId:null,tokenOutId:null,candidateInstanceKey:''};
 edge.candidateInstanceKey=sqlDirectionId(edge);
 const fund=catalog.listAll().find(f=>f.plugin.manifest.domain==='funding')!.plugin.manifest;
 const {runtimeRoot:root,graph}=buildSqlEdgeLiveProducer({edges:[edge],source,currentHead:source.number,
  swapTableSha256:'a'.repeat(64),fundingTableSha256:'b'.repeat(64),unavailable:[],
  fundingAssets:[{familyId:fund.familyId,asset:tokenIn,binding:{chainId:1,provider:a('9'),asset:tokenIn,selector:'0x12345678',signature:'fixture()'}}],
  materialized:issued.alternatives.map(v=>({...v,sqlEdgeKey:edge.candidateInstanceKey}))});
 assert.equal(graph.length,1);assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys,[]);
 const target={number:124,hash:h('d'),generation:9};
 const refresh=async(logs:{address:string;topics:readonly string[];data:string}[])=>{
  const touched=await readBlockTouchedStateKeys({getLogs:async()=>logs.map(l=>({...l,blockHash:target.hash})),
   send:async()=>{throw Error('offline only');}},124,pool,{hash:target.hash,parentHash:source.hash,
   transactionHashes:[],passiveTouchedAddresses:[]},{previousSource:source,readHeader:async()=>{throw Error('unexpected header');}},
   root.resolveBlockTouchedStateKeys,{mode:'logs'});
  const plan=root.sqlPoolPriceRefreshPlan(touched,source,target)!;
  return graph.filter(e=>plan.shouldRefresh(e)).map(e=>e.canonicalEdgeId);
 };
 assert.deepEqual(await refresh([]),[]);
 assert.deepEqual(await refresh([{address:tokenIn,...erc20.encodeEventLog('Transfer',[user,recipient,7n])}]),[]);
 assert.deepEqual(await refresh([{address:tokenIn,...erc20.encodeEventLog('Transfer',[user,pool,7n])}]),[edge.candidateInstanceKey]);
 assert.deepEqual(await refresh([{address:tokenOut,...erc20.encodeEventLog('Transfer',[pool,user,7n])}]),[edge.candidateInstanceKey]);
 assert.deepEqual(await refresh([{address:a('e'),...erc20.encodeEventLog('Transfer',[user,pool,7n])}]),[]);
 assert.deepEqual(await refresh([{address:pool,...abi.encodeEventLog('SellGem',[user,7n,0n])}]),[edge.candidateInstanceKey]);
 assert.deepEqual(root.sqlPoolTouches({kind:'call',target:pool,data:'0x95991276'}).legIds,[edge.candidateInstanceKey]);
 assert.deepEqual(root.sqlPoolTouches({kind:'call',target:tokenIn,data:'0x12345678'}).legIds,[]);
});
