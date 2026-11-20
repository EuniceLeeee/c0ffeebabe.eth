// Materialize only the funding summary. Never rebuild an expired raw trace
// source, or replace an authenticated destination with a caller-supplied table.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {googleApi,sha} from './selector-query-client.mjs';
import {openReadyDiscoveryJob} from './ready-bigquery-sql.mjs';
import {decodeRow} from './bigquery-table.mjs';
import {renderSelectorTraceSourceSql} from './selector-trace-source-sql.mjs';
import {renderTraceCoverageSql} from './selector-trace-window-sql.mjs';
import {renderSqlFundingSources} from './selector-funding-sql.mjs';
import {FunctionFragment} from '../listener/node_modules/ethers/lib.esm/index.js';
import {GENERATED_PRODUCTION_FAMILY_ENTRIES as entries} from '../listener/src/searcher/generated/production-family-entries.generated.ts';
import {fundingBindingsFromCall,selectorFundingInstanceKey} from '../listener/src/searcher/venues/selector-native-funding-definition.ts';
import {selectorAssetOfferKey} from '../listener/src/searcher/venues/selector-execution-keys.ts';

const root=fileURLToPath(new URL('../',import.meta.url)), cap=3*2**30, location='US';
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const validPath=s=>typeof s==='string'&&(s===''||/^(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*$/.test(s));
export function splitSqlFundingRows(items,w){
  const rows=[],failures=[],keys=new Set(),defs=new Map(entries.map(e=>e.module.selectorFamilyModule)
    .filter(m=>m.activation.enabled&&m.definition.domain==='funding').map(m=>[m.definition.selector,m.definition]));
  for(const r of items){
    const def=defs.get(r.selector);assert(def&&FunctionFragment.from(def.execution.callback.signature).selector===r.callback);
    assert(/^0x[a-f0-9]{40}$/.test(r.provider)&&/^0x[a-f0-9]{64}$/.test(r.block_hash)&&/^0x[a-f0-9]{64}$/.test(r.tx_hash));
    assert(Number.isSafeInteger(r.block_number)&&r.block_number>=w.fromBlock&&r.block_number<=w.toBlock);if(r.block_number===w.toBlock)assert.equal(r.block_hash,w.headHash);
    assert(Number.isSafeInteger(r.observations)&&r.observations>0&&Number.isSafeInteger(r.transaction_index)&&r.transaction_index>=0&&validPath(r.trace_address));
    if(r.callback_path==null)assert.equal(r.failure,'no-committed-provider-callback');
    else assert(validPath(r.callback_path)&&r.callback_path!==r.trace_address&&(r.trace_address===''||r.callback_path.startsWith(r.trace_address+',')));
    if(Object.hasOwn(r,'failure')){
      assert(typeof r.failure==='string'&&r.failure.length>0&&!r.offerKey&&!r.asset&&!r.input);failures.push(r);continue;
    }
    assert(r.callback_path!=null&&r.input.startsWith(r.selector));
    const bound=fundingBindingsFromCall(def,1,{target:r.provider,calldata:r.input});
    assert(bound.some(b=>b.asset===r.asset&&selectorAssetOfferKey(selectorFundingInstanceKey(b),{address:b.asset})===r.offerKey),'funding key not bound by Family');
    assert(!keys.has(r.offerKey));keys.add(r.offerKey);rows.push(r);
  }
  return {rows,failures};
}
export function assertTraceFundingCoverage(w,c){
  assert.equal(w.toBlock-w.fromBlock+1,512,'expected 512-block input');
  assert.equal(c.transactions,w.transactions);assert.equal(c.distinctTx,w.transactions);assert.equal(c.missingTraces,'0');
  assert.equal(Number(c.activeHashes),512);assert.equal(Number(c.firstBlock),w.fromBlock);assert.equal(Number(c.lastBlock),w.toBlock);assert.equal(c.head,w.headHash);
}
const optional={allowStatus:404},config={method:'POST',headers:{'Content-Type':'application/json'},timeoutMs:120000,maxAttempts:1};
function complete(job,id,sql,projectId){
  assert(job,'certified source job expired or unavailable');assert.equal(job.jobReference.jobId,id);
  assert.equal(job.jobReference.projectId,projectId);assert.equal(job.jobReference.location,location);
  assert(job.status.state==='DONE'&&!job.status.errorResult,'source job is incomplete or failed');
  assert(job.configuration.query.query===sql&&job.configuration.query.useLegacySql===false,'source job SQL differs');
}
export async function authenticateTraceSource(api,projectId,manifest){
  const {window:w,jobs,sourceCoverage:c}=manifest;
  assert(/^[a-z][a-z0-9-]+$/.test(projectId));assert.equal(manifest.chainId,1);
  assertTraceFundingCoverage(w,c);
  const source=jobs.source,coverage=jobs.coverage,sql=renderSelectorTraceSourceSql({window:w});
  assert.equal(sha(sql),source.sqlSha256);assert(/^seltrace_source_[0-9a-f]{24}$/.test(source.jobId));
  const base='https://bigquery.googleapis.com/bigquery/v2/projects/'+projectId;
  const a=await api(base+'/jobs/'+source.jobId+'?location='+location,optional);complete(a,source.jobId,sql,projectId);
  const t=a.configuration.query.destinationTable;assert.equal(t.projectId,projectId);
  assert([t.datasetId,t.tableId].every(s=>/^[a-zA-Z_]\w*$/.test(s)));const table=[projectId,t.datasetId,t.tableId].join('.');
  assert.equal(table,source.table);
  const meta=await api(base+'/datasets/'+t.datasetId+'/tables/'+t.tableId,optional);
  assert(meta,'trace result table expired or unavailable; not rebuilding');
  assert.deepEqual(meta.tableReference,t);assert.equal(meta.type,'TABLE');assert.equal(meta.numRows,w.transactions);
  assert(meta.expirationTime&&Number(meta.expirationTime)>Date.now(),'trace result table expired; not rebuilding');
  assert.equal(meta.lastModifiedTime,meta.creationTime,'trace result table was modified after materialization');
  assert(Number(meta.creationTime)>=Number(a.statistics.startTime)&&Number(meta.creationTime)<=Number(a.statistics.endTime),'trace table outside source job lifetime');
  const covSql=renderTraceCoverageSql(table);assert.equal(sha(covSql),coverage.sqlSha256);assert(/^seltrace_coverage_[0-9a-f]{24}$/.test(coverage.jobId));
  const b=await api(base+'/jobs/'+coverage.jobId+'?location='+location,optional);complete(b,coverage.jobId,covSql,projectId);
  const page=await api(base+'/queries/'+coverage.jobId+'?location='+location+'&maxResults=2',optional);
  assert(page&&page.jobComplete&&page.totalRows==='1'&&page.rows.length===1&&!page.pageToken,'aggregate coverage no longer available');
  assert.deepEqual(decodeRow(page.schema.fields,page.rows[0]),c);
  return {table,jobId:source.jobId,sqlSha256:source.sqlSha256,creationTime:meta.creationTime,coverageJobId:coverage.jobId,
    coverageSqlSha256:coverage.sqlSha256,rowCount:meta.numRows,coverage:c};
}
export async function exportCachedFunding({api,projectId,manifest,record=()=>{}}){
  const trace=await authenticateTraceSource(api,projectId,manifest),w=manifest.window;
  const sql=await renderSqlFundingSources(trace.table,join(root,'listener')),sqlSha256=sha(sql);
  const jobId='sel512_funding_'+sha(trace.jobId+sqlSha256).slice(0,24),base='https://bigquery.googleapis.com/bigquery/v2/projects/'+projectId;
  const query={query:sql,useLegacySql:false,useQueryCache:true,maximumBytesBilled:String(cap)};
  const dry=await api(base+'/jobs',{...config,body:JSON.stringify({jobReference:{projectId,location},configuration:{dryRun:true,query}})});
  const estimate=Number(dry.statistics?.query?.totalBytesProcessed);assert(Number.isSafeInteger(estimate)&&estimate>=0&&estimate<=cap,'funding query exceeds 3 GiB; not submitted');
  record('funding-request.json',{jobId,sqlSha256,estimate,cap,sourceJobId:trace.jobId});
  const read=await openReadyDiscoveryJob(api,{projectId},{jobId,location,query},[],{waitForCompletion:true});
  const rows=[];let token,count;const tokens=new Set();
  do{const p=await read(512,token);assert.deepEqual(p.schema.fields.map(f=>[f.name,f.type]),[['body','STRING']]);
    count??=Number(p.totalRows);assert(Number.isSafeInteger(count)&&count>=0&&count<=50000&&count===Number(p.totalRows));
    for(const row of p.rows??[])rows.push(JSON.parse(decodeRow(p.schema.fields,row).body));
    token=p.pageToken;if(token){assert(!tokens.has(token),'repeated results page');tokens.add(token);}
  }while(token);
  assert.equal(rows.length,count);const split=splitSqlFundingRows(rows,w);
  const j=await api(base+'/jobs/'+jobId+'?location='+location);complete(j,jobId,sql,projectId);
  const t=j.configuration.query.destinationTable;assert(t.projectId===projectId);const job={jobId,sqlSha256,estimate,cap,
    table:[projectId,t.datasetId,t.tableId].join('.'),bytesBilled:j.statistics.query.totalBytesBilled,cacheHit:j.statistics.query.cacheHit};
  assert(BigInt(job.bytesBilled)<=BigInt(cap));
  const result={format:'sql-live-funding/v1',chainId:1,window:{fromBlock:w.fromBlock,toBlock:w.toBlock,headHash:w.headHash},...split,
    provenance:{trace,funding:job}};
  record('funding-job.json',job);record('funding.json',result);return result;
}
async function main(){
  const {values:v}=parseArgs({options:{'trace-manifest':{type:'string'},out:{type:'string'},'expect-head':{type:'string'}}});
  assert(v['trace-manifest']&&v.out&&/^0x[0-9a-f]{64}$/.test(v['expect-head']??''),'requires --trace-manifest FILE --expect-head HASH --out PARENT');
  const manifest=load(resolve(v['trace-manifest']));assert.equal(manifest.window.headHash,v['expect-head']);
  mkdirSync(v.out,{recursive:true});const dir=mkdtempSync(join(resolve(v.out),'live-funding-'));
  const write=(f,o)=>writeFileSync(join(dir,f),JSON.stringify(o,null,2)+'\n',{flag:'wx',mode:0o600});console.error('Funding artifacts: '+dir);
  const result=await exportCachedFunding({api:googleApi(),projectId:process.env.SELECTOR_BQ_PROJECT??'eth-token-480803',manifest,record:write});
  console.log(JSON.stringify({out:join(dir,'funding.json'),sha256:sha(readFileSync(join(dir,'funding.json'))),rows:result.rows.length,
    job:result.provenance.funding}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(String(e.message).slice(0,700));process.exitCode=1;});
