import test from 'node:test';
import assert from 'node:assert/strict';
import {AbiCoder,Interface} from 'ethers';
import {createHash} from 'node:crypto';
import {createSqlRootCallWitnessReader,sqlHistoricalCallObservation} from '../venues/selector-sql-call-witness.js';
import {issueSqlFamilyAlternatives} from '../venues/selector-native-sql-live-materializer.js';
import {selectorNativeProgramKey} from '../venues/selector-native-definition.js';
import {sqlSelectorModules} from '../sql-edge-live-producer.js';
import {sqlDirectionId} from '../sql-edge-price-index.js';
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from '../venues/production-family-composition.js';
const target='0x'+'1'.repeat(40),asset='0x'+'2'.repeat(40),sender='0x'+'3'.repeat(40),owner='0x'+'4'.repeat(40),
  txHash='0x'+'a'.repeat(64),oldHash='0x'+'b'.repeat(64),source={generation:21,number:21,hash:'0x'+'c'.repeat(64)};
const selector='0x1a4d01d2',def=sqlSelectorModules.get(selector)!.definition,abi=new Interface([def.signature]),call=abi.encodeFunctionData(selector,[89,1,1]);
const edge={chainId:1 as const,selector,poolAddress:target,poolId:null,poolNamespace:null,tokenInId:null,tokenOutId:null,tokenIn:target,tokenOut:asset};
const ref={txHash,callPath:''};
function mock(){
  const accounts={from:sender,to:target},anchor={blockNumber:'0x10',blockHash:oldHash,transactionIndex:'0x0'},logs:any[]=[];
  const tx={...accounts,...anchor,chainId:'0x1',value:'0x0',hash:txHash,input:call};
  const rc={...accounts,...anchor,status:'0x1',transactionHash:txHash,logs};
  const block={number:anchor.blockNumber,hash:oldHash,transactions:[txHash]},history:string[]=[];
  const reader=createSqlRootCallWitnessReader({async send(method,params){history.push(method);
    if(method==='eth_getBlockByNumber'){assert.deepEqual(params,[anchor.blockNumber,false]);return block;}
    assert.deepEqual(params,[txHash]);return method==='eth_getTransactionByHash'?tx:rc;}});
  return {tx,rc,block,history,reader};
}
test('actual mined root, receipt and canonical membership anchor historical nomination; never coerce an internal call to the root',async()=>{
  const m=mock(),c=await m.reader(ref),r=sqlHistoricalCallObservation(c,ref,edge,source);
  assert(r.kind==='call');assert.equal(r.evidenceSource!.hash,oldHash);assert.equal(r.source.hash,source.hash);assert.equal(r.data,call);
  for(const bad of [()=>sqlHistoricalCallObservation(structuredClone(c),ref,edge,source),
    ()=>sqlHistoricalCallObservation(c,ref,{...edge,poolAddress:asset},source),()=>sqlHistoricalCallObservation(c,ref,{...edge,selector:'0xa9059cbb'},source),
    ()=>sqlHistoricalCallObservation(c,ref,edge,{...source,number:15}),()=>sqlHistoricalCallObservation(c,ref,edge,{...source,number:16})])assert.throws(bad);
  const denied=mock();await assert.rejects(denied.reader({...ref,callPath:'0'}));assert.equal(denied.history.length,0);
  for(const corrupt of [(m:ReturnType<typeof mock>)=>{m.tx.hash=oldHash;},(m:ReturnType<typeof mock>)=>{m.rc.status='0x0';},
    (m:ReturnType<typeof mock>)=>{m.block.transactions[0]=oldHash;},(m:ReturnType<typeof mock>)=>{m.rc.logs.push({transactionHash:oldHash});}]){
    const x=mock();corrupt(x);await assert.rejects(x.reader(ref));
  }
});
test('a call-bound recipe uses original arguments to verify the current pinned pool and directed issued program; never echoes the SQL side',async()=>{
  const script=(n:string)=>import(new URL('../../../../scripts/selector-execution-param-'+n+'.mjs',import.meta.url).href);
  const {compileSqlExecutionParamPlan}=await script('plan'),{annotateExecutionParams}=await script('observation');
  const row={...edge,candidateInstanceKey:sqlDirectionId(edge)};
  const plan={...compileSqlExecutionParamPlan(def),definitionSha256:createHash('sha256').update(JSON.stringify(def)).digest('hex')};
  const [obs]=annotateExecutionParams([{...row,selectorTarget:target,callPath:''}],[{path:'',target,input:call,paramInput:call,ok:true,kind:'call'}],{[selector]:plan});
  const e={...row,executionParamEvidence:{...JSON.parse(obs.paramPayload),consensus:'uniform',...ref,innerSwapPath:null}};
  const m=mock(),gets=new Interface(['function coins(uint256) view returns(address)','function lp_token() view returns(address)']),
    code:string[]=[],queries:string[]=[];
  let returnedAsset=asset;
  const args={edge:e,source,catalog,definition:def,executor:owner,transactionOrigin:sender,
    historicalProgramKeys:[selectorNativeProgramKey(def.programs[1]!),selectorNativeProgramKey(def.programs[3]!)],
    readCallWitness:m.reader,readCode:async(a:string)=>{code.push(a);return '0x6000';},read:async(a:string,data:string)=>{
      assert.equal(a,target);queries.push(data);
      if(data===gets.encodeFunctionData('coins',[1]))return AbiCoder.defaultAbiCoder().encode(['address'],[returnedAsset]);
      if(data===gets.encodeFunctionData('lp_token'))return AbiCoder.defaultAbiCoder().encode(['address'],[target]);
      throw Object.assign(Error('execution reverted'),{code:3,data:'0x'});
    }};
  const first=await issueSqlFamilyAlternatives(args);
  assert.equal(first.alternatives.length,0,'neither real call evidence nor an issued program grants undeclared pricing ownership');
  assert.deepEqual(first.ownershipRejected.map(v=>v.programKey),args.historicalProgramKeys,first.issues.join('; '));
  assert(first.ownershipRejected.every(v=>/^0x[a-f0-9]{64}$/.test(v.programHash)));
  assert.deepEqual(m.history,['eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockByNumber']);
  assert(code.includes(target)&&queries.includes(gets.encodeFunctionData('coins',[1])));
  returnedAsset=owner;const wrong=await issueSqlFamilyAlternatives(args);assert.equal(wrong.alternatives.length,0,'wrong independently read output');
  assert.equal(wrong.ownershipRejected.length,0,'do not label an asset mismatch as an ownership-only mismatch');
  const noSource=await issueSqlFamilyAlternatives({...args,readCallWitness:undefined});assert.equal(noSource.alternatives.length,0);
});
