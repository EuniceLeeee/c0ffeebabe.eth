import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FunctionFragment,Interface} from '../listener/node_modules/ethers/lib.esm/index.js';
import {authenticateTraceSource,splitSqlFundingRows} from './selector-live-funding-export.mjs';
import {renderSqlFundingSources} from './selector-funding-sql.mjs';
import {readSqlFundingRows} from '../listener/src/searcher/sql-live-tables.ts';
import {renderSelectorTraceSourceSql} from './selector-trace-source-sql.mjs';
import {renderTraceCoverageSql} from './selector-trace-window-sql.mjs';
import {sha} from './selector-query-client.mjs';
const project='test-project',t={projectId:project,datasetId:'_cache',tableId:'anon_test'},table=[project,t.datasetId,t.tableId].join('.');
const w={fromBlock:11,toBlock:522,firstTime:'2026-11-09T14:17:23.000000Z',lastTime:'2026-11-09T15:59:59.000000Z',headHash:'0x'+'ab'.repeat(32),transactions:'1000'};
const sourceSql=renderSelectorTraceSourceSql({window:w}),coverageSql=renderTraceCoverageSql(table);
const m={chainId:1,window:w,sourceCoverage:{firstBlock:'11',lastBlock:'522',head:w.headHash,transactions:'1000',distinctTx:'1000',activeHashes:'512',missingTraces:'0'},
  jobs:{source:{jobId:'seltrace_source_'+'a'.repeat(24),table,sqlSha256:sha(sourceSql)},
  coverage:{jobId:'seltrace_coverage_'+'b'.repeat(24),sqlSha256:sha(coverageSql)}}};
function makeApi(change){
  let calls=0;
  return async url=>{
    assert(!url.endsWith('/jobs'),'authentication must never submit a query');
    const key=url.includes('/datasets/')?'meta':url.includes('/queries/')?'counts':url.includes('seltrace_source')?'source':'coverage';
    let o;if(key==='meta')o={tableReference:t,type:'TABLE',numRows:'1000',creationTime:'15',lastModifiedTime:'15',expirationTime:String(Date.now()+1e6)};
    else if(key==='counts'){const fields=Object.keys(m.sourceCoverage).map(name=>({name,type:'STRING'}));o={jobComplete:true,totalRows:'1',schema:{fields},
      rows:[{f:fields.map(({name})=>({v:m.sourceCoverage[name]}))}]};}
    else o={jobReference:{jobId:m.jobs[key].jobId,projectId:project,location:'US'},status:{state:'DONE'},statistics:{startTime:'14',endTime:'16'},
      configuration:{query:{query:key==='source'?sourceSql:coverageSql,destinationTable:t,useLegacySql:false}}};
    calls++;assert(calls<=4);return change?change(key,structuredClone(o)):o;
  };
}
test('authenticates producing job, immutable destination and independent aggregate covering exact pinned window',async()=>{
  const r=await authenticateTraceSource(makeApi(),project,m);assert.equal(r.table,table);assert.equal(r.coverageJobId,m.jobs.coverage.jobId);
});
test('expired/replaced source or mismatched coverage never triggers a raw trace query',async()=>{
  await assert.rejects(authenticateTraceSource(makeApi((k,o)=>k==='meta'?null:o),project,m),/expired/);
  await assert.rejects(authenticateTraceSource(makeApi((k,o)=>k==='meta'?{...o,lastModifiedTime:'99'}:o),project,m),/modified/);
  await assert.rejects(authenticateTraceSource(makeApi((k,o)=>k==='meta'?{...o,creationTime:'20',lastModifiedTime:'20'}:o),project,m),/lifetime/);
  await assert.rejects(authenticateTraceSource(makeApi((k,o)=>{if(k==='source')o.configuration.query.query='SELECT 1';return o;}),project,m),/SQL differs/);
  await assert.rejects(authenticateTraceSource(makeApi((k,o)=>{if(k==='counts')o.rows[0].f[0].v='999';return o;}),project,m));
});
test('shipped funding UDF, export split and production intake agree; failed ancestors and failed or forged offers are not admitted',async()=>{
  const sql=await renderSqlFundingSources(table);
  const functions=[...sql.matchAll(/LANGUAGE js AS r'''([\s\S]*?)'''/g)].map(m=>m[1]);
  assert.equal(functions.length,2);
  const committed=new Function('path','failed',functions[0]),offers=new Function('target','input',functions[1]);
  for(const path of ['','1','1,9'])assert(!committed(path,['']));
  assert(!committed('1,0',['1']));assert(!committed('1',['1']));assert(committed('10,0',['1']));assert(committed('',['1']));
  const provider='0x'+'ac'.repeat(20),asset='0x'+'dc'.repeat(20),abi=new Interface(['function flashLoan(address,uint256,bytes)']);
  const call=abi.encodeFunctionData('flashLoan',[asset,1,'0x']);
  const witness={provider,selector:call.slice(0,10),callback:FunctionFragment.from('function onMorphoFlashLoan(uint256,bytes)').selector,
    block_number:w.toBlock,block_hash:w.headHash,tx_hash:'0x'+'bc'.repeat(32),transaction_index:0,trace_address:'',callback_path:'0',observations:1};
  const [decoded]=offers(provider,call).map(JSON.parse);
  const [bad]=offers(provider,abi.encodeFunctionData('flashLoan',[asset,0,'0x'])).map(JSON.parse);
  assert.equal(bad.failure,'invalid funded assets or amounts');
  const good={...witness,...decoded,input:call},failure={...witness,...bad};
  const split=splitSqlFundingRows([good,failure],w);assert.deepEqual(split,{rows:[good],failures:[failure]});
  assert.throws(()=>splitSqlFundingRows([good,good],w));
  assert.throws(()=>splitSqlFundingRows([{...good,trace_address:'1',callback_path:'10'}],w));
  assert.throws(()=>splitSqlFundingRows([{...good,provider:'0x'+'ef'.repeat(20)}],w));
  const doc={format:'sql-live-funding/v1',chainId:1,window:w,sourceCoverage:m.sourceCoverage,...split};
  const source={...w,cutoffHash:w.headHash};const projected=readSqlFundingRows(doc,source);
  assert.equal(projected.length,1);assert.equal(projected[0].binding.provider,provider);
  assert.throws(()=>readSqlFundingRows({...doc,rows:[{...good,failure:'bad'}]},source),/mixed/);
  assert.throws(()=>readSqlFundingRows({...doc,failures:[good]},source),/failure carries an offer/);
  assert.throws(()=>readSqlFundingRows({...doc,rows:[{...good,provider:'0x'+'ef'.repeat(20)}]},source),/identity differs/);
  assert.throws(()=>readSqlFundingRows({...doc,sourceCoverage:{...m.sourceCoverage,missingTraces:'1'}},source),/coverage incomplete/);
});
const actual=process.env.SELECTOR_SQL_FUNDING_ARTIFACT;
test('authenticated real-window artifact round-trips all offers via production intake, without capacity lookup', {skip:!actual},()=>{
  const buf=readFileSync(actual);assert.equal(sha(buf),process.env.SELECTOR_SQL_FUNDING_SHA256);
  const doc=JSON.parse(buf),window=doc.window,split=splitSqlFundingRows([...doc.rows,...doc.failures],window);
  assert.deepEqual(split.rows,doc.rows);assert.deepEqual(split.failures,doc.failures);
  const assets=readSqlFundingRows(doc,{...window,cutoffHash:window.headHash});
  assert.equal(assets.length,13);assert.equal(assets.length,doc.rows.length);
  assert.equal(new Set(assets.filter(a=>a.asset==='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2').map(a=>a.binding.provider)).size,2);
});
